// Frigate ANPR Logger dashboard.
//
// Three views, swapped via hash-routing:
//   #/                – list of unique plates (counts)
//   #/plate/<plate>   – per-plate timeline + vehicle-registry info
//   #/sightings       – flat chronological feed of all sightings
//
// Pure vanilla JS, no build step, no external deps. All HTML composition goes
// through the small `h()` helper so we never inject untrusted strings into
// innerHTML.

"use strict";

// ---------- DOM refs ----------------------------------------------------

const MAIN = document.getElementById("main");
const TABS = document.querySelectorAll(".tab");
const FOOTER_STATUS = document.getElementById("footer-status");

// ---------- formatting --------------------------------------------------
//
// All locale + timezone choices come from the operator's browser; no
// hardcoded "Europe/Amsterdam" or "nl-NL" anymore. Internal day-key formatter
// still pins to "en-CA" because it needs the canonical YYYY-MM-DD shape for
// sort keys, not a localised pretty form.

const fmtDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "medium",
});

const fmtTime = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const fmtDayLong = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const fmtDayKey = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Provider-driven display config — fetched once at startup from /providers.
// Each provider may declare:
//   - `plate_format.sidecodes`: regex + dash positions for hyphenation
//   - `display.yes_values` / `display.no_values`: country-specific boolean
//     strings (e.g. NL "Ja"/"Nee", UK "Yes"/"No")
//   - `display.currency`: ISO-4217 code (e.g. "EUR") for price rendering
// All optional. Until populated, plates render unformatted, yes/no values
// pass through as plain text, currency defaults to EUR.
let _PLATE_FORMATTERS = [];

async function fetchProviderConfig() {
  try {
    const providers = await apiGet("/providers");
    const rules = [];
    for (const p of providers || []) {
      const fmt = p.plate_format;
      if (fmt && Array.isArray(fmt.sidecodes)) {
        for (const sc of fmt.sidecodes) {
          try {
            rules.push({ re: new RegExp(sc.pattern), parts: sc.parts });
          } catch {
            // Bad regex from a provider config — skip rather than break the UI.
          }
        }
      }
      const display = p.display;
      if (display) {
        if (Array.isArray(display.yes_values)) {
          for (const v of display.yes_values) _YES_VALUES.add(String(v));
        }
        if (Array.isArray(display.no_values)) {
          for (const v of display.no_values) _NO_VALUES.add(String(v));
        }
        // First provider that declares a currency wins. Rebuild the formatter
        // by clearing the cache; _moneyFormatter() will lazy-recreate it.
        if (display.currency && _CURRENCY === "EUR") {
          _CURRENCY = String(display.currency);
          _fmtMoney = null;
        }
      }
    }
    _PLATE_FORMATTERS = rules;
  } catch {
    // /providers unreachable; UI falls back to plain text + EUR defaults.
  }
}

/** Apply the country-specific hyphenation a provider declared for this plate. */
function formatPlate(plate) {
  if (!plate) return "";
  const clean = String(plate).replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (!clean) return plate;
  for (const { re, parts } of _PLATE_FORMATTERS) {
    if (re.test(clean)) {
      return (
        clean.slice(0, parts[0]) +
        "-" +
        clean.slice(parts[0], parts[1]) +
        "-" +
        clean.slice(parts[1])
      );
    }
  }
  return clean;
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const diff = (Date.now() - then) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.round(diff / 86400)} d ago`;
  return fmtDateTime.format(new Date(then));
}

function titleCase(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function vehicleLabel(row) {
  return [row.make, row.model]
    .filter(Boolean)
    .map(titleCase)
    .join(" ");
}

// ---------- field formatting -------------------------------------------
//
// Currency + yes/no string detection are driven by the provider's `display`
// block, fetched at startup. Number formatting uses the browser locale.

let _CURRENCY = "EUR";                   // first provider that declares one wins
const _YES_VALUES = new Set();           // union of all providers' "positive" strings
const _NO_VALUES  = new Set();           // union of all providers' "negative" strings
let _fmtMoney = null;                    // rebuilt when _CURRENCY changes

function _moneyFormatter() {
  if (!_fmtMoney) {
    _fmtMoney = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: _CURRENCY,
      maximumFractionDigits: 0,
    });
  }
  return _fmtMoney;
}

const _fmtInt = new Intl.NumberFormat(undefined);
const _fmtMetre = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function muted() {
  return h("span.muted", {}, "—");
}

function formatMoney(s) {
  if (s == null || s === "") return muted();
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return _moneyFormatter().format(n);
}

function formatInt(s, unit) {
  if (s == null || s === "") return muted();
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return unit ? `${_fmtInt.format(n)} ${unit}` : _fmtInt.format(n);
}

/** Registry dates often come as `YYYYMMDD` (or `YYYYMMDD000000` etc.).
 *  Rendered in the operator's locale via Intl, so dd-mm-yy / mm/dd/yy /
 *  YYYY-MM-DD all come out natural to their browser. */
const _fmtDate = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
function formatRegistryDate(s) {
  if (s == null || s === "") return muted();
  const digits = String(s).replace(/\D/g, "").slice(0, 8);
  if (digits.length !== 8) return s;
  const y = parseInt(digits.slice(0, 4), 10);
  const m = parseInt(digits.slice(4, 6), 10);
  const d = parseInt(digits.slice(6, 8), 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return s;
  return _fmtDate.format(new Date(Date.UTC(y, m - 1, d)));
}

/** Length/width fields are stored in centimetres; render as metres. */
function formatCmAsM(s) {
  if (s == null || s === "") return muted();
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return `${_fmtMetre.format(n / 100)} m`;
}

/** Wrap a known yes/no value (declared by provider) in a coloured pill. */
function formatYesNo(s, { yesIsPositive = true } = {}) {
  if (s == null || s === "") return muted();
  const v = String(s).trim();
  const isYes = _YES_VALUES.has(v);
  const isNo  = _NO_VALUES.has(v);
  if (!isYes && !isNo) return v;
  const positive = isYes === yesIsPositive;
  return h(`span.pill.${positive ? "pill-yes" : "pill-no"}`, {}, v);
}

// ---------- safe DOM builder -------------------------------------------

/** Tiny hyperscript: h("tag.cls#id", { attrs }, ...children). */
function h(tag, attrs, ...children) {
  // Parse "tag.class.class#id".
  const match = tag.match(/^([a-z][a-z0-9-]*)((?:[.#][^.#]+)*)$/i);
  if (!match) throw new Error(`bad tag: ${tag}`);
  const el = document.createElement(match[1]);
  const mods = match[2].match(/[.#][^.#]+/g) || [];
  for (const m of mods) {
    if (m[0] === "#") el.id = m.slice(1);
    else el.classList.add(m.slice(1));
  }
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs) && !(attrs instanceof Node)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className += (el.className ? " " : "") + v;
      else if (k === "data") {
        for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k in el && k !== "list") {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  } else if (attrs != null) {
    children.unshift(attrs);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

function plateBadge(plate, { large = false, small = false } = {}) {
  const cls = ["plate"];
  if (large) cls.push("plate-lg");
  if (small) cls.push("plate-sm");
  return h(`span.${cls.join(".")}`, {}, formatPlate(plate));
}

function snapshotThumb(plate, { large = false } = {}) {
  const cls = large ? "snapshot-thumb.snapshot-thumb-lg" : "snapshot-thumb";
  return h(`img.${cls}`, {
    src: `/vehicles/${encodeURIComponent(plate)}/snapshot`,
    loading: "lazy",
    alt: "",
  });
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderTemplate(id) {
  const tpl = document.getElementById(id);
  const node = tpl.content.cloneNode(true);
  clear(MAIN);
  MAIN.appendChild(node);
}

// ---------- API ---------------------------------------------------------

async function apiGet(path) {
  const resp = await fetch(path, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

async function apiDelete(path, { ignore404 = false } = {}) {
  const resp = await fetch(path, { method: "DELETE" });
  if (!resp.ok && !(ignore404 && resp.status === 404)) {
    throw new Error(`${resp.status} ${resp.statusText}`);
  }
}

async function apiPost(path, body) {
  const init = { method: "POST", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(path, init);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  // Some endpoints (POST .../refresh) return JSON; others return 204.
  return resp.status === 204 ? null : resp.json();
}

function normalizePlateForBackend(raw) {
  return (raw || "").trim().toUpperCase().replace(/[\s-]/g, "");
}

async function setFooterStatus() {
  try {
    await apiGet("/healthz");
    FOOTER_STATUS.textContent = "connected";
    FOOTER_STATUS.style.color = "var(--text-muted)";
  } catch {
    FOOTER_STATUS.textContent = "no API connection";
    FOOTER_STATUS.style.color = "var(--warn)";
  }
}

// Runtime config fetched from /config once on page load. Empty/default
// values so the UI gracefully degrades when the endpoint is unreachable.
let APP_CONFIG = { frigate_public_url: "", page_size: 50 };

async function fetchAppConfig() {
  try {
    const cfg = await apiGet("/config");
    if (cfg && typeof cfg === "object") APP_CONFIG = { ...APP_CONFIG, ...cfg };
  } catch {
    // keep defaults; views that depend on this just skip the optional bits
  }
}

// ---------- views -------------------------------------------------------

// All columns the plates table can display, in canonical order.
//
// - ``required: true``  → cannot be hidden by the user (Plate)
// - ``defaultVisible``  → shown on first visit, before the user toggles anything
// - ``num``             → right-aligned (table styling)
// - ``numeric``         → values compared as numbers when sorting; string fallback otherwise
// - ``defaultAsc``      → first click on header sorts ascending instead of descending
// - ``render(row)``     → returns the cell child (string or Node)
// - ``rawValue(row)``   → optional: returns the value used for sorting; falls back to ``row[key]``
const PLATE_COLUMNS = [
  { key: "snapshot", label: "Photo", defaultVisible: true, sortable: false,
    render: r => r.has_snapshot ? snapshotThumb(r.plate) : muted() },
  { key: "plate", label: "Plate", required: true, defaultVisible: true, defaultAsc: true,
    render: r => plateBadge(r.plate) },
  { key: "make", label: "Vehicle", defaultVisible: true, defaultAsc: true,
    render: r => vehicleLabel(r) || muted() },
  { key: "colour", label: "Colour", defaultVisible: true, defaultAsc: true,
    render: r => r.colour ? titleCase(r.colour) : muted() },
  { key: "year", label: "Year", numeric: true, defaultVisible: true, defaultAsc: true,
    render: r => r.year || muted() },
  { key: "count", label: "Count", num: true, numeric: true, defaultVisible: true,
    render: r => String(r.count) },
  { key: "last_seen", label: "Last seen", defaultVisible: true,
    render: r => h("span", { title: fmtDateTime.format(new Date(r.last_seen)) },
                   relativeTime(r.last_seen)) },

  // Tier 1 — financial / compliance signals
  { key: "catalog_price", label: "Price", num: true, numeric: true,
    render: r => formatMoney(r.catalog_price) },
  { key: "insured", label: "Insured", defaultAsc: true,
    render: r => formatYesNo(r.insured, { yesIsPositive: true }) },
  { key: "recall_open", label: "Recall", defaultAsc: true,
    render: r => formatYesNo(r.recall_open, { yesIsPositive: false }) },
  { key: "is_taxi", label: "Taxi", defaultAsc: true,
    render: r => formatYesNo(r.is_taxi, { yesIsPositive: false }) },

  // Tier 2 — display extras
  { key: "body_style", label: "Body style", defaultAsc: true,
    render: r => r.body_style ? titleCase(r.body_style) : muted() },
  { key: "owner_since", label: "Owner since", defaultAsc: true,
    render: r => formatRegistryDate(r.owner_since) },
  { key: "efficiency_label", label: "Eff.", defaultAsc: true,
    render: r => r.efficiency_label || muted() },
  { key: "colour_secondary", label: "2nd colour", defaultAsc: true,
    render: r => r.colour_secondary ? titleCase(r.colour_secondary) : muted() },

  // Tier 3 — specs + dimensions
  { key: "engine_cc", label: "Engine (cc)", num: true, numeric: true,
    render: r => formatInt(r.engine_cc) },
  { key: "seats", label: "Seats", num: true, numeric: true,
    render: r => formatInt(r.seats) },
  { key: "doors", label: "Doors", num: true, numeric: true,
    render: r => formatInt(r.doors) },
  { key: "mass_kg", label: "Mass", num: true, numeric: true,
    render: r => formatInt(r.mass_kg, "kg") },
  { key: "power_to_weight", label: "Pwr/mass", num: true, numeric: true,
    render: r => r.power_to_weight || muted() },
  { key: "length_cm", label: "Length", num: true, numeric: true,
    render: r => formatCmAsM(r.length_cm) },
  { key: "width_cm", label: "Width", num: true, numeric: true,
    render: r => formatCmAsM(r.width_cm) },
];

const _PLATE_COLS_BY_KEY = new Map(PLATE_COLUMNS.map(c => [c.key, c]));
const _PLATE_COLS_LS_KEY = "anpr.plateColumns";

function loadVisibleColumns() {
  try {
    const raw = localStorage.getItem(_PLATE_COLS_LS_KEY);
    if (!raw) throw 0;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw 0;
    const valid = new Set(arr.filter(k => _PLATE_COLS_BY_KEY.has(k)));
    for (const col of PLATE_COLUMNS) if (col.required) valid.add(col.key);
    return valid;
  } catch {
    return new Set(PLATE_COLUMNS.filter(c => c.defaultVisible).map(c => c.key));
  }
}

function saveVisibleColumns(set) {
  try {
    localStorage.setItem(_PLATE_COLS_LS_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage may be disabled (private mode); silently fall through.
  }
}

const SEARCH_DEBOUNCE_MS = 300;

async function renderPlates() {
  renderTemplate("tpl-plates");
  const listEl = document.getElementById("plates-list");
  const metaEl = document.getElementById("plates-meta");
  const searchEl = document.getElementById("search");
  const toolbarEl = listEl.parentElement.querySelector(".toolbar");

  const visible = loadVisibleColumns();
  mountColumnPicker(toolbarEl, visible, () => render());

  // View state — every mutation triggers a backend fetch.
  const state = {
    offset: 0,
    sortKey: "last_seen",
    sortDir: "desc",
    q: "",
    total: 0,
    items: [],
    loading: false,
    error: null,
  };

  async function fetchPage() {
    state.loading = true;
    state.error = null;
    render();
    const params = new URLSearchParams({
      limit: String(APP_CONFIG.page_size),
      offset: String(state.offset),
      sort_by: state.sortKey,
      sort_dir: state.sortDir,
    });
    if (state.q) params.set("q", state.q);
    try {
      const resp = await apiGet(`/counts?${params}`);
      state.total = resp.total || 0;
      state.items = resp.items || [];
    } catch (e) {
      state.error = e.message;
      state.items = [];
      state.total = 0;
    } finally {
      state.loading = false;
      render();
    }
  }

  function setSort(key, defaultAsc) {
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = defaultAsc ? "asc" : "desc";
    }
    state.offset = 0;  // sort change resets to first page
    fetchPage();
  }

  function setPage(newOffset) {
    state.offset = Math.max(0, Math.min(newOffset, Math.max(0, state.total - 1)));
    fetchPage();
  }

  // Debounced search — every keystroke schedules a refetch; rapid typing
  // collapses to a single call once the user pauses.
  let searchTimer = null;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = searchEl.value.trim();
      state.offset = 0;  // search change resets to first page
      fetchPage();
    }, SEARCH_DEBOUNCE_MS);
  });

  function render() {
    clear(listEl);

    // Toolbar meta: total + page indicator.
    if (state.loading && !state.items.length) {
      metaEl.textContent = "Loading…";
    } else if (state.error) {
      metaEl.textContent = "";
    } else if (state.total === 0) {
      metaEl.textContent = state.q ? "no matches" : "";
    } else {
      const from = state.offset + 1;
      const to = Math.min(state.offset + state.items.length, state.total);
      metaEl.textContent =
        state.total <= APP_CONFIG.page_size
          ? `${state.total} unique plate${state.total === 1 ? "" : "s"}`
          : `${from}–${to} of ${state.total}`;
    }

    if (state.error) {
      listEl.appendChild(
        h("div.status.error", {}, `Failed to fetch /counts: ${state.error}`),
      );
      return;
    }

    if (state.total === 0 && !state.loading) {
      listEl.appendChild(
        h(
          "div.status",
          {},
          state.q
            ? `No plates match “${state.q}”.`
            : "No plates seen yet. Waiting for the first sighting…",
        ),
      );
      return;
    }

    const cols = PLATE_COLUMNS.filter(c => visible.has(c.key));

    const table = h("table.data-table");
    const thead = h("thead");
    const headerRow = h("tr");
    for (const col of cols) {
      const th = h(`th${col.num ? ".num" : ""}`, {}, col.label);
      if (col.sortable === false) {
        th.style.cursor = "default";
      } else {
        th.dataset.sort = col.key;
        if (col.key === state.sortKey) {
          th.classList.add(state.sortDir === "asc" ? "sort-asc" : "sort-desc");
        }
        th.addEventListener("click", () => setSort(col.key, col.defaultAsc));
      }
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = h("tbody");
    for (const row of state.items) {
      const tr = h("tr", { data: { plate: row.plate } });
      tr.addEventListener("click", () => {
        location.hash = `#/plate/${encodeURIComponent(row.plate)}`;
      });
      for (const col of cols) {
        const cell = h(`td${col.num ? ".num" : ""}`, { data: { label: col.label } });
        const content = col.render(row);
        if (content instanceof Node) cell.appendChild(content);
        else cell.textContent = content == null ? "" : String(content);
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    listEl.appendChild(table);

    // Pagination bar — only when there are multiple pages.
    if (state.total > APP_CONFIG.page_size) {
      const currentPage = Math.floor(state.offset / APP_CONFIG.page_size) + 1;
      const totalPages = Math.ceil(state.total / APP_CONFIG.page_size);
      const prev = h(
        "button.page-btn",
        {
          type: "button",
          disabled: state.offset === 0 || state.loading,
          onClick: () => setPage(state.offset - APP_CONFIG.page_size),
        },
        "← Prev",
      );
      const next = h(
        "button.page-btn",
        {
          type: "button",
          disabled: state.offset + APP_CONFIG.page_size >= state.total || state.loading,
          onClick: () => setPage(state.offset + APP_CONFIG.page_size),
        },
        "Next →",
      );
      listEl.appendChild(
        h(
          "div.pagination",
          {},
          prev,
          h("span.page-indicator", {}, `Page ${currentPage} of ${totalPages}`),
          next,
        ),
      );
    }
  }

  fetchPage();
}

function mountColumnPicker(toolbarEl, visible, onChange) {
  if (!toolbarEl) return;
  // Clean up any picker left from a previous render of the same view.
  const existing = toolbarEl.querySelector(".cols-wrap");
  if (existing) existing.remove();

  const button = h(
    "button.cols-btn",
    { type: "button", "aria-haspopup": "true", "aria-expanded": "false" },
    "Columns ▾",
  );
  const panel = h("div.cols-panel", { role: "menu", hidden: true });

  for (const col of PLATE_COLUMNS) {
    if (col.required) continue;
    const checkbox = h("input", {
      type: "checkbox",
      checked: visible.has(col.key),
    });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) visible.add(col.key);
      else visible.delete(col.key);
      saveVisibleColumns(visible);
      onChange();
    });
    panel.appendChild(h("label.cols-row", {}, checkbox, h("span", {}, col.label)));
  }

  const wrap = h("div.cols-wrap", {}, button, panel);

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    wrap.classList.toggle("is-open", open);
  }
  button.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOpen(panel.hidden);
  });
  document.addEventListener("click", (ev) => {
    if (!wrap.contains(ev.target)) setOpen(false);
  });

  // Insert just before the toolbar-meta so layout reads: search | picker | meta.
  const meta = toolbarEl.querySelector(".toolbar-meta");
  if (meta) toolbarEl.insertBefore(wrap, meta);
  else toolbarEl.appendChild(wrap);
}

// Build the "Sync ▾" dropdown shown in the detail-page actions row. Each
// provider entry, when clicked, calls ``onSelect(name)`` and closes the panel.
// The dismiss-on-outside-click listener is attached only while the panel is
// open and removed on close, so subsequent renderHeader() calls don't leave
// stale listeners behind.
function buildSyncDropdown(providers, onSelect) {
  const button = h(
    "button.detail-btn.sync-btn",
    { type: "button", title: "Re-fetch vehicle data from a provider", "aria-haspopup": "true", "aria-expanded": "false" },
    "Sync ▾",
  );
  const panel = h("div.sync-panel", { role: "menu", hidden: true });

  for (const p of providers) {
    const item = h(
      "button.sync-item",
      { type: "button", role: "menuitem" },
      h("span.sync-item-name", {}, p.name),
      p.description ? h("span.sync-item-desc", {}, p.description) : null,
    );
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setOpen(false);
      onSelect(p.name);
    });
    panel.appendChild(item);
  }

  const wrap = h("div.sync-wrap", {}, button, panel);
  let dismissListener = null;

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    wrap.classList.toggle("is-open", open);
    if (open) {
      dismissListener = (ev) => {
        if (!wrap.contains(ev.target)) setOpen(false);
      };
      document.addEventListener("click", dismissListener);
    } else if (dismissListener) {
      document.removeEventListener("click", dismissListener);
      dismissListener = null;
    }
  }

  button.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOpen(panel.hidden);
  });

  return wrap;
}

// Keys that belong to the sighting aggregation, not the vehicle record.
const _SIGHTING_META_KEYS = new Set(["plate", "count", "last_seen"]);

function renderVehicleDetails(meta) {
  if (!meta || typeof meta !== "object") {
    return h("div.detail-vehicle-empty", {}, "No vehicle data available for this plate.");
  }
  const cards = [];
  for (const col of PLATE_COLUMNS) {
    if (_SIGHTING_META_KEYS.has(col.key)) continue;
    const value = meta[col.key];
    if (value == null || value === "") continue;
    const cell = h("div.detail-field-value", {});
    const rendered = col.render(meta);
    if (rendered instanceof Node) cell.appendChild(rendered);
    else cell.textContent = rendered == null ? "" : String(rendered);
    cards.push(
      h(
        "div.detail-field",
        {},
        h("div.detail-field-label", {}, col.label),
        cell,
      ),
    );
  }
  if (!cards.length) {
    return h("div.detail-vehicle-empty", {}, "No vehicle data available for this plate.");
  }
  return h("div.detail-grid", {}, ...cards);
}

async function renderDetail(plate) {
  renderTemplate("tpl-detail");
  const headerEl = document.getElementById("detail-header");
  const timelineEl = document.getElementById("detail-timeline");

  timelineEl.appendChild(h("div.status", {}, "Loading…"));

  const [counts, timeline, providersResult] = await Promise.allSettled([
    apiGet(`/counts?plate=${encodeURIComponent(plate)}`),
    apiGet(`/timeline/${encodeURIComponent(plate)}`),
    apiGet("/providers"),
  ]);

  if (timeline.status === "rejected") {
    clear(timelineEl);
    const isMissing = /\b404\b/.test(timeline.reason.message);
    timelineEl.appendChild(
      h(
        "div.status",
        { class: isMissing ? "" : "error" },
        isMissing
          ? `No passages for ${formatPlate(plate)}.`
          : `Failed to fetch timeline: ${timeline.reason.message}`,
      ),
    );
    return;
  }

  // /counts now returns {total, items}; the items list either has the one
  // matching row (when ?plate filter hit) or is empty.
  const meta =
    counts.status === "fulfilled" && counts.value.items && counts.value.items.length
      ? counts.value.items[0]
      : {};
  const passages = timeline.value;
  const providers =
    providersResult.status === "fulfilled" && Array.isArray(providersResult.value)
      ? providersResult.value
      : [];

  // ---- editable header state ----
  //
  // Edit renames the whole plate in one atomic call to POST
  // /plates/<plate>/rename (moves every sighting, refreshes vehicle data,
  // carries the snapshot, merges into the target if it already exists).
  // Delete has no bulk endpoint, so it still fans out a DELETE per sighting —
  // fine for the typical 1-50 sightings per plate.

  let editing = false;
  let busy = null;
  let editInputRef = null;

  function startEdit() {
    editing = true;
    renderHeader();
  }

  function cancelEdit() {
    editing = false;
    renderHeader();
  }

  async function saveEdit() {
    const newPlate = normalizePlateForBackend(editInputRef && editInputRef.value);
    if (!newPlate) {
      alert("Plate cannot be empty.");
      return;
    }
    if (newPlate === plate) {
      cancelEdit();
      return;
    }

    // If the target plate already exists, this rename merges into it. Confirm
    // first so an accidental typo doesn't silently fold two cars together.
    try {
      const existing = await apiGet(`/counts?plate=${encodeURIComponent(newPlate)}`);
      const target = existing.items && existing.items[0];
      if (target && target.count > 0) {
        const n = passages.length;
        const ok = window.confirm(
          `${formatPlate(newPlate)} already exists with ${target.count} ` +
            `passage${target.count === 1 ? "" : "s"}.\n\n` +
            `Merge this plate's ${n} passage${n === 1 ? "" : "s"} into it?`,
        );
        if (!ok) return;
      }
    } catch {
      // Existence check failed (network/parse) — fall through and let the
      // rename call itself surface any real error.
    }

    busy = "Saving…";
    renderHeader();
    try {
      await apiPost(`/plates/${encodeURIComponent(plate)}/rename`, { to: newPlate });
      // Navigate to the new plate's detail (re-renders against fresh server state).
      location.hash = `#/plate/${encodeURIComponent(newPlate)}`;
    } catch (e) {
      alert(`Failed to update plate: ${e.message}`);
      busy = null;
      editing = false;
      renderHeader();
    }
  }

  async function confirmDelete() {
    const n = passages.length;
    const msg =
      `Delete plate ${formatPlate(plate)} and ${n} sighting${n === 1 ? "" : "s"}?\n\n` +
      `This cannot be undone.`;
    if (!window.confirm(msg)) return;
    busy = "Deleting…";
    renderHeader();
    try {
      await Promise.all(
        passages.map((p) => apiDelete(`/sightings/${p.id}`)),
      );
      // Tidy the (now orphaned) vehicle row. May 404 if it never existed.
      await apiDelete(`/vehicles/${encodeURIComponent(plate)}`, {
        ignore404: true,
      });
      location.hash = "#/";
    } catch (e) {
      alert(`Failed to delete plate: ${e.message}`);
      busy = null;
      renderHeader();
    }
  }

  async function syncWith(providerName) {
    busy = `Syncing via ${providerName}…`;
    renderHeader();
    try {
      const url = `/vehicles/${encodeURIComponent(plate)}/refresh?provider=${encodeURIComponent(providerName)}`;
      await apiPost(url);
      // Full re-render to pick up the freshly cached fields everywhere.
      renderDetail(plate);
    } catch (e) {
      // 404 from refresh = provider matched but no data for this plate.
      const friendly = /\b404\b/.test(e.message)
        ? `${providerName} has no data for this plate.`
        : `Sync failed: ${e.message}`;
      alert(friendly);
      busy = null;
      renderHeader();
    }
  }

  function renderHeader() {
    clear(headerEl);

    let plateNode;
    if (editing) {
      const input = h("input.plate-edit", {
        type: "text",
        value: plate,
        spellcheck: false,
        autocomplete: "off",
        autocapitalize: "characters",
        maxlength: 12,
        "aria-label": "Plate",
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          saveEdit();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          cancelEdit();
        }
      });
      editInputRef = input;
      plateNode = input;
    } else {
      editInputRef = null;
      plateNode = plateBadge(plate, { large: true });
    }

    if (meta.has_snapshot) {
      const thumb = snapshotThumb(plate, { large: true });
      if (meta.frigate_event_id && APP_CONFIG.frigate_public_url) {
        headerEl.appendChild(
          h(
            "a.snapshot-link",
            {
              href: `${APP_CONFIG.frigate_public_url}/explore?event_id=${encodeURIComponent(meta.frigate_event_id)}`,
              target: "_blank",
              rel: "noopener",
              title: "Open this event in Frigate ↗",
            },
            thumb,
          ),
        );
      } else {
        headerEl.appendChild(thumb);
      }
    }

    // The plate is the only editable thing, so the edit affordance lives right
    // next to it: a pencil when idle, Save/Cancel while editing. The plate
    // badge swaps to a text input in the same spot (see plateNode above).
    const plateRow = h("div.plate-row", {}, plateNode);
    if (busy) {
      // Frozen mid-save; the busy text shows in the actions column.
    } else if (editing) {
      plateRow.appendChild(
        h("button.detail-btn.primary", { type: "button", onClick: saveEdit }, "Save"),
      );
      plateRow.appendChild(
        h("button.detail-btn", { type: "button", onClick: cancelEdit }, "Cancel"),
      );
    } else {
      // The plate badge itself is the click target: it highlights on
      // hover/focus and shows a pointer cursor, so it reads as click-to-edit.
      plateNode.classList.add("plate-editable");
      plateNode.setAttribute("role", "button");
      plateNode.setAttribute("tabindex", "0");
      plateNode.setAttribute("title", "Edit plate");
      plateNode.setAttribute("aria-label", `Edit plate ${formatPlate(plate)}`);
      plateNode.addEventListener("click", startEdit);
      plateNode.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          startEdit();
        }
      });
    }

    const metaCol = h(
      "div.meta",
      {},
      plateRow,
      h("div.meta-title", {}, vehicleLabel(meta) || "Unknown vehicle"),
      h(
        "div.meta-line",
        {},
        [meta.colour ? titleCase(meta.colour) : null, meta.year || null]
          .filter(Boolean)
          .join(" · ") || "No vehicle data",
      ),
    );
    headerEl.appendChild(metaCol);

    const statCol = h(
      "div.stat",
      {},
      h("div.stat-num", {}, String(passages.length)),
      h("div.stat-label", {}, passages.length === 1 ? "passage" : "passages"),
    );
    headerEl.appendChild(statCol);

    // Plate-level actions (not editing — that affordance sits by the plate).
    // Hidden while editing so the header stays focused on the plate input.
    const actionsCol = h("div.detail-actions");
    if (busy) {
      actionsCol.appendChild(h("span.detail-busy", {}, busy));
    } else if (!editing) {
      if (meta.frigate_event_id && APP_CONFIG.frigate_public_url) {
        actionsCol.appendChild(
          h(
            "a.detail-btn",
            {
              href: `${APP_CONFIG.frigate_public_url}/explore?event_id=${encodeURIComponent(meta.frigate_event_id)}`,
              target: "_blank",
              rel: "noopener",
              title: "Open this event in Frigate",
            },
            "↗ Frigate",
          ),
        );
      }
      if (providers.length) {
        actionsCol.appendChild(buildSyncDropdown(providers, syncWith));
      }
      actionsCol.appendChild(
        h(
          "button.detail-btn.danger",
          { type: "button", title: "Delete plate", onClick: confirmDelete },
          "Delete",
        ),
      );
    }
    headerEl.appendChild(actionsCol);

    if (editing && editInputRef) {
      editInputRef.focus();
      editInputRef.select();
    }
  }

  renderHeader();

  const vehicleEl = document.getElementById("detail-vehicle");
  if (vehicleEl) {
    clear(vehicleEl);
    vehicleEl.appendChild(renderVehicleDetails(meta));
  }

  const spikesEl = document.getElementById("detail-spikes");
  mountTimeline(spikesEl, passages);

  clear(timelineEl);
  const table = h(
    "table.data-table",
    {},
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, "Time"),
        h("th", {}, "Camera"),
        h("th.num", {}, "Score"),
      ),
    ),
  );
  const tbody = h("tbody");
  // Show newest first inside the detail view.
  const ordered = [...passages].sort((a, b) => (a.seen_at < b.seen_at ? 1 : -1));
  for (const p of ordered) {
    const tr = h("tr");
    tr.style.cursor = "default";
    tr.appendChild(
      h(
        "td",
        { data: { label: "Time" }, title: p.seen_at },
        fmtDateTime.format(new Date(p.seen_at)),
      ),
    );
    tr.appendChild(
      h("td", { data: { label: "Camera" } }, p.camera || h("span.muted", {}, "—")),
    );
    tr.appendChild(
      h(
        "td.num",
        { data: { label: "Score" } },
        p.score != null ? p.score.toFixed(2) : h("span.muted", {}, "—"),
      ),
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  timelineEl.appendChild(table);
}

async function renderSightings() {
  renderTemplate("tpl-sightings");
  const listEl = document.getElementById("sightings-list");
  const metaEl = document.getElementById("sightings-meta");

  listEl.appendChild(h("div.status", {}, "Loading…"));

  let sightings;
  try {
    sightings = await apiGet("/sightings?limit=500");
  } catch (e) {
    clear(listEl);
    listEl.appendChild(h("div.status.error", {}, `Failed to fetch /sightings: ${e.message}`));
    return;
  }

  clear(listEl);

  if (!sightings.length) {
    listEl.appendChild(h("div.status", {}, "No passages logged yet."));
    return;
  }

  metaEl.textContent = `${sightings.length} recent passage${sightings.length === 1 ? "" : "s"}`;

  // Group by local-timezone day (browser-derived).
  const groups = new Map();
  for (const s of sightings) {
    const d = new Date(s.seen_at);
    const key = fmtDayKey.format(d);
    if (!groups.has(key)) groups.set(key, { first: d, items: [] });
    groups.get(key).items.push(s);
  }

  for (const { first, items } of groups.values()) {
    listEl.appendChild(h("h3.day-header", {}, fmtDayLong.format(first)));

    const section = h("div.sightings-section");
    for (const s of items) {
      const row = h(
        "a.sighting-row",
        { href: `#/plate/${encodeURIComponent(s.plate)}` },
        h("span.sighting-time", {}, fmtTime.format(new Date(s.seen_at))),
        plateBadge(s.plate, { small: true }),
        h(
          "span.sighting-meta",
          {},
          vehicleLabel(s) ||
            (s.colour ? titleCase(s.colour) : null) ||
            h("span.muted", {}, "—"),
        ),
        h("span.sighting-camera", {}, s.camera || ""),
      );
      section.appendChild(row);
    }
    listEl.appendChild(section);
  }
}

// ---------- horizontal spike timeline ----------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      el.setAttribute(k, String(v));
    }
  }
  return el;
}

// Tick intervals, ordered ascending. We pick the first one whose ms span
// exceeds the desired px-per-tick spacing.
const TICK_STEPS = [
  { ms: 60_000, kind: "minute", step: 1 },
  { ms: 5 * 60_000, kind: "minute", step: 5 },
  { ms: 15 * 60_000, kind: "minute", step: 15 },
  { ms: 30 * 60_000, kind: "minute", step: 30 },
  { ms: 60 * 60_000, kind: "hour", step: 1 },
  { ms: 3 * 60 * 60_000, kind: "hour", step: 3 },
  { ms: 6 * 60 * 60_000, kind: "hour", step: 6 },
  { ms: 12 * 60 * 60_000, kind: "hour", step: 12 },
  { ms: 24 * 60 * 60_000, kind: "day", step: 1 },
  { ms: 7 * 24 * 60 * 60_000, kind: "week", step: 1 },
  { ms: 30 * 24 * 60 * 60_000, kind: "month", step: 1 },
  { ms: 365 * 24 * 60 * 60_000, kind: "year", step: 1 },
];

const TIMELINE_MIN_SPAN_MS = 60_000; // 1 minute
const TIMELINE_TARGET_PX_PER_TICK = 90;

// Tick boundaries below use the operator's local timezone. We render YYYY-MM-DD
// via Intl with "en-CA" (forces ISO ordering) and let the browser apply its
// own TZ for the day boundary, then convert back to ms via Date.parse + the
// local UTC offset.
const _localHourFmt = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hour12: false,
});
function _localHour(ts) {
  const v = parseInt(_localHourFmt.format(ts), 10);
  return Number.isFinite(v) ? v % 24 : 0;
}

const _localYmdFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const _localYmFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
});
const _localYFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
});

function _localMidnight(ts) {
  // ms for the operator-local midnight of the day containing ts.
  const ymd = _localYmdFmt.format(ts);
  const naive = Date.parse(ymd + "T00:00:00Z");
  return naive - _localHour(naive) * 3_600_000;
}

function _localMonthStart(ts) {
  const ym = _localYmFmt.format(ts);
  const naive = Date.parse(ym + "-01T00:00:00Z");
  return naive - _localHour(naive) * 3_600_000;
}

function _localYearStart(ts) {
  const y = _localYFmt.format(ts);
  const naive = Date.parse(y + "-01-01T00:00:00Z");
  return naive - _localHour(naive) * 3_600_000;
}

function snapTick(ts, interval) {
  switch (interval.kind) {
    case "minute":
    case "hour": {
      // Sub-day: UTC-snap is fine; common local offsets are whole minutes
      // so labels still land on round local times.
      return Math.floor(ts / interval.ms) * interval.ms;
    }
    case "day":
    case "week":
      return _localMidnight(ts);
    case "month":
      return _localMonthStart(ts);
    case "year":
      return _localYearStart(ts);
    default:
      return ts;
  }
}

function nextTick(ts, interval) {
  switch (interval.kind) {
    case "minute":
    case "hour":
      return ts + interval.ms;
    case "day":
      return _localMidnight(ts + 25 * 3_600_000);
    case "week":
      return _localMidnight(ts + 7 * 24 * 3_600_000 + 3_600_000);
    case "month":
      return _localMonthStart(ts + 32 * 24 * 3_600_000);
    case "year":
      return _localYearStart(ts + 366 * 24 * 3_600_000);
    default:
      return ts + interval.ms;
  }
}

function pickInterval(spanMs, width) {
  const target = spanMs / Math.max(2, Math.floor(width / TIMELINE_TARGET_PX_PER_TICK));
  for (const iv of TICK_STEPS) if (iv.ms >= target) return iv;
  return TICK_STEPS[TICK_STEPS.length - 1];
}

const _fmtTickMinute = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const _fmtTickHour = _fmtTickMinute;
const _fmtTickDay = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
});
const _fmtTickMonth = new Intl.DateTimeFormat(undefined, {
  month: "short",
  year: "numeric",
});
const _fmtTickYear = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
});

function formatTick(ts, interval) {
  const d = new Date(ts);
  switch (interval.kind) {
    case "minute":
      return _fmtTickMinute.format(d);
    case "hour":
      return _fmtTickHour.format(d);
    case "day":
    case "week":
      return _fmtTickDay.format(d);
    case "month":
      return _fmtTickMonth.format(d);
    case "year":
      return _fmtTickYear.format(d);
    default:
      return d.toISOString();
  }
}

function generateTicks(viewStart, viewEnd, interval) {
  const out = [];
  let t = snapTick(viewStart, interval);
  while (t < viewStart) t = nextTick(t, interval);
  while (t <= viewEnd && out.length < 200) {
    out.push(t);
    t = nextTick(t, interval);
  }
  return out;
}

function mountTimeline(container, passages) {
  clear(container);

  const data = (passages || [])
    .map((p) => ({
      ts: Date.parse(p.seen_at),
      score: typeof p.score === "number" ? p.score : null,
      camera: p.camera || null,
    }))
    .filter((d) => Number.isFinite(d.ts))
    .sort((a, b) => a.ts - b.ts);

  if (!data.length) {
    container.appendChild(h("div.status", {}, "No timestamps to show."));
    return;
  }

  const firstTs = data[0].ts;
  const lastTs = data[data.length - 1].ts;
  // Minimum data span for sensible default view (e.g. one sighting only).
  const dataSpan = Math.max(lastTs - firstTs, 10 * TIMELINE_MIN_SPAN_MS);
  const initialPad = Math.max(dataSpan * 0.05, 5 * TIMELINE_MIN_SPAN_MS);
  const initialStart = firstTs - initialPad;
  const initialEnd = lastTs + initialPad;

  // Absolute bounds: don't let the user pan/zoom infinitely off-data.
  const absoluteMin = firstTs - dataSpan * 4;
  const absoluteMax = lastTs + dataSpan * 4;
  const maxViewSpan = Math.max(dataSpan * 8, 365 * 24 * 60 * 60_000);

  let viewStart = initialStart;
  let viewEnd = initialEnd;

  // DOM scaffold.
  const toolbar = h("div.timeline-toolbar");
  const rangeLabel = h("span.timeline-range");

  const undoBtn = h(
    "button.timeline-btn.icon",
    {
      type: "button",
      title: "Previous zoom (Shift+click on timeline)",
      onClick: () => undo(),
      disabled: true,
    },
    "↶",
  );
  const resetBtn = h(
    "button.timeline-btn",
    {
      type: "button",
      title: "Zoom out fully",
      onClick: () => reset(),
    },
    "Reset",
  );
  const controls = h(
    "div.timeline-controls",
    {},
    h(
      "button.timeline-btn.icon",
      { type: "button", title: "Zoom out", onClick: () => zoomButton(1.7) },
      "−",
    ),
    h(
      "button.timeline-btn.icon",
      { type: "button", title: "Zoom in", onClick: () => zoomButton(1 / 1.7) },
      "+",
    ),
    h("span.timeline-sep"),
    undoBtn,
    resetBtn,
  );
  toolbar.appendChild(rangeLabel);
  toolbar.appendChild(controls);
  container.appendChild(toolbar);

  const svgWrap = h("div.timeline-svg-wrap");
  container.appendChild(svgWrap);

  const tooltip = h("div.timeline-tooltip");
  svgWrap.appendChild(tooltip);

  const hint = h(
    "div.timeline-hint",
    {},
    h("span", {}, h("kbd", {}, "drag"), " select range"),
    h("span", {}, h("kbd", {}, "scroll"), " zoom at cursor"),
    h("span", {}, h("kbd", {}, "Shift+click"), " previous zoom"),
    h("span", {}, h("kbd", {}, "Reset"), " full view"),
  );
  container.appendChild(hint);

  let width = 0;

  function pxToTs(px) {
    return viewStart + (px / Math.max(1, width)) * (viewEnd - viewStart);
  }
  function tsToPx(ts) {
    return ((ts - viewStart) / (viewEnd - viewStart)) * width;
  }

  function clampView(start, end) {
    let span = end - start;
    if (span < TIMELINE_MIN_SPAN_MS) span = TIMELINE_MIN_SPAN_MS;
    if (span > maxViewSpan) span = maxViewSpan;
    // Keep the center within the absolute range.
    const center = (start + end) / 2;
    let clampedCenter = center;
    if (clampedCenter < absoluteMin) clampedCenter = absoluteMin;
    if (clampedCenter > absoluteMax) clampedCenter = absoluteMax;
    return [clampedCenter - span / 2, clampedCenter + span / 2];
  }

  function setView(start, end) {
    [viewStart, viewEnd] = clampView(start, end);
    render();
  }

  function zoom(factor, anchorTs) {
    if (anchorTs == null) anchorTs = (viewStart + viewEnd) / 2;
    const span = viewEnd - viewStart;
    const newSpan = Math.max(
      TIMELINE_MIN_SPAN_MS,
      Math.min(maxViewSpan, span * factor),
    );
    const ratio = (anchorTs - viewStart) / span;
    const newStart = anchorTs - newSpan * ratio;
    setView(newStart, newStart + newSpan);
  }

  // ---- zoom history ----
  //
  // Discrete actions (brush, +/− button, Reset) push the current view to the
  // stack before changing. Continuous actions (wheel, pinch) do NOT push, so
  // undo brings you back to the last deliberate zoom step.

  const MAX_HISTORY = 50;
  const history = [];

  function pushHistory() {
    const top = history[history.length - 1];
    if (top && top[0] === viewStart && top[1] === viewEnd) return;
    history.push([viewStart, viewEnd]);
    if (history.length > MAX_HISTORY) history.shift();
    updateUndoBtn();
  }

  function undo() {
    if (!history.length) return;
    const [s, e] = history.pop();
    viewStart = s;
    viewEnd = e;
    render();
    updateUndoBtn();
  }

  function updateUndoBtn() {
    undoBtn.disabled = history.length === 0;
  }

  function zoomButton(factor) {
    pushHistory();
    zoom(factor);
  }

  function reset() {
    pushHistory();
    setView(initialStart, initialEnd);
  }

  function render() {
    width = svgWrap.clientWidth || 600;
    // Detach tooltip so we can wipe the SVG without losing it.
    if (tooltip.parentNode === svgWrap) svgWrap.removeChild(tooltip);
    clear(svgWrap);

    const height = svgWrap.clientHeight || 140;
    const axisHeight = 32;
    const baseY = height - axisHeight;
    const topY = 14;
    const spikeArea = baseY - topY;

    const svg = svgEl("svg", {
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "none",
    });

    // Background hit-rect so wheel/drag works on empty space too.
    svg.appendChild(
      svgEl("rect", {
        x: 0,
        y: 0,
        width: width,
        height: height,
        fill: "transparent",
      }),
    );

    // Ticks (drawn under the baseline, behind spikes).
    const interval = pickInterval(viewEnd - viewStart, width);
    const ticks = generateTicks(viewStart, viewEnd, interval);
    for (const t of ticks) {
      const x = tsToPx(t);
      if (x < -60 || x > width + 60) continue;

      // Vertical guide line, very subtle.
      svg.appendChild(
        svgEl("line", {
          class: "tl-guide",
          x1: x,
          y1: 0,
          x2: x,
          y2: baseY,
        }),
      );

      // Tick mark on the axis.
      svg.appendChild(
        svgEl("line", {
          class: "tl-tick",
          x1: x,
          y1: baseY,
          x2: x,
          y2: baseY + 5,
        }),
      );

      const label = svgEl("text", {
        class: "tl-label",
        x: x,
        y: baseY + 18,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
      });
      label.textContent = formatTick(t, interval);
      svg.appendChild(label);
    }

    // Baseline.
    svg.appendChild(
      svgEl("line", {
        class: "tl-baseline",
        x1: 0,
        y1: baseY,
        x2: width,
        y2: baseY,
      }),
    );

    // Spikes.
    for (const d of data) {
      if (d.ts < viewStart || d.ts > viewEnd) continue;
      const x = tsToPx(d.ts);
      const norm =
        d.score != null && d.score >= 0 && d.score <= 1
          ? 0.55 + 0.45 * d.score
          : 0.75;
      const h = Math.max(20, spikeArea * norm);
      svg.appendChild(
        svgEl("line", {
          class: "tl-spike",
          x1: x,
          y1: baseY,
          x2: x,
          y2: baseY - h,
        }),
      );
    }

    svgWrap.appendChild(svg);
    svgWrap.appendChild(tooltip);

    // Range label
    rangeLabel.textContent = `${fmtDateTime.format(new Date(viewStart))}  →  ${fmtDateTime.format(new Date(viewEnd))}`;
  }

  // ---- interaction ----
  //
  // Drag (mouse or single touch) paints a brush rectangle; on release we
  // zoom to that range. Wheel + buttons zoom centered. Pinch (2 fingers)
  // zooms continuously. There is no pan — every interaction either zooms
  // in (brush, wheel down, +) or out (wheel up, −, reset).

  const BRUSH_MIN_PX = 6;

  let brushing = false;
  let brushStartPx = 0;
  let brushCurPx = 0;
  let brushRect = null;

  let pinchActive = false;
  let pinchStartDist = 0;
  let pinchStartView = null;
  let pinchAnchorTs = 0;

  function localX(clientX) {
    const rect = svgWrap.getBoundingClientRect();
    return Math.max(0, Math.min(width, clientX - rect.left));
  }

  function startBrush(clientX) {
    brushing = true;
    brushStartPx = localX(clientX);
    brushCurPx = brushStartPx;
    tooltip.style.display = "none";
    svgWrap.classList.add("is-brushing");
    ensureBrushRect();
    updateBrushRect();
  }

  function ensureBrushRect() {
    const svg = svgWrap.querySelector("svg");
    if (!svg) return;
    if (brushRect && brushRect.parentNode === svg) return;
    brushRect = svgEl("rect", {
      class: "tl-brush",
      x: brushStartPx,
      y: 0,
      width: 0,
      height: svgWrap.clientHeight || 140,
    });
    svg.appendChild(brushRect);
  }

  function updateBrushRect() {
    if (!brushRect) return;
    const x = Math.min(brushStartPx, brushCurPx);
    const w = Math.abs(brushCurPx - brushStartPx);
    brushRect.setAttribute("x", x);
    brushRect.setAttribute("width", w);
  }

  function clearBrush() {
    if (brushRect && brushRect.parentNode) {
      brushRect.parentNode.removeChild(brushRect);
    }
    brushRect = null;
    brushing = false;
    svgWrap.classList.remove("is-brushing");
  }

  function commitBrush() {
    const dx = Math.abs(brushCurPx - brushStartPx);
    if (dx >= BRUSH_MIN_PX) {
      const startTs = pxToTs(Math.min(brushStartPx, brushCurPx));
      const endTs = pxToTs(Math.max(brushStartPx, brushCurPx));
      pushHistory();
      setView(startTs, endTs);
    }
    clearBrush();
  }

  svgWrap.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const anchorTs = pxToTs(localX(ev.clientX));
      // Trackpad pinch shows up as ctrlKey + wheel — same handler covers it.
      const factor = Math.exp(ev.deltaY * 0.0015);
      zoom(factor, anchorTs);
    },
    { passive: false },
  );

  svgWrap.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    if (ev.shiftKey) {
      ev.preventDefault();
      undo();
      return;
    }
    ev.preventDefault();
    startBrush(ev.clientX);
  });

  function onMouseMove(ev) {
    if (brushing) {
      brushCurPx = localX(ev.clientX);
      updateBrushRect();
      return;
    }
    showTooltipAt(ev.clientX);
  }

  function onMouseUp() {
    if (brushing) commitBrush();
  }

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  svgWrap.addEventListener("mouseleave", () => {
    if (!brushing) tooltip.style.display = "none";
  });

  // Cancel an in-progress brush with Escape.
  function onKeyDown(ev) {
    if (ev.key === "Escape" && brushing) clearBrush();
  }
  window.addEventListener("keydown", onKeyDown);

  function showTooltipAt(clientX) {
    const rect = svgWrap.getBoundingClientRect();
    const x = clientX - rect.left;
    if (x < 0 || x > width) {
      tooltip.style.display = "none";
      return;
    }
    const tolerancePx = 14;
    let nearest = null;
    let nearestDistPx = Infinity;
    for (const d of data) {
      if (d.ts < viewStart || d.ts > viewEnd) continue;
      const dPx = Math.abs(tsToPx(d.ts) - x);
      if (dPx < tolerancePx && dPx < nearestDistPx) {
        nearest = d;
        nearestDistPx = dPx;
      }
    }
    if (!nearest) {
      tooltip.style.display = "none";
      return;
    }
    const parts = [fmtDateTime.format(new Date(nearest.ts))];
    if (nearest.score != null) parts.push(`score ${nearest.score.toFixed(2)}`);
    if (nearest.camera) parts.push(nearest.camera);
    tooltip.textContent = parts.join("  ·  ");
    tooltip.style.left = `${tsToPx(nearest.ts)}px`;
    tooltip.style.top = `${(svgWrap.clientHeight || 140) - 32 - 6}px`;
    tooltip.style.display = "block";
  }

  // Touch: single-finger paints a brush (same as mouse drag), two-finger pinch zooms.
  svgWrap.addEventListener(
    "touchstart",
    (ev) => {
      if (ev.touches.length === 1) {
        ev.preventDefault();
        startBrush(ev.touches[0].clientX);
      } else if (ev.touches.length === 2) {
        ev.preventDefault();
        clearBrush();
        pinchActive = true;
        const t1 = ev.touches[0];
        const t2 = ev.touches[1];
        pinchStartDist = Math.max(
          1,
          Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
        );
        pinchStartView = { start: viewStart, end: viewEnd };
        const rect = svgWrap.getBoundingClientRect();
        const cx = (t1.clientX + t2.clientX) / 2 - rect.left;
        pinchAnchorTs = pxToTs(cx);
      }
    },
    { passive: false },
  );

  svgWrap.addEventListener(
    "touchmove",
    (ev) => {
      if (pinchActive && ev.touches.length === 2) {
        ev.preventDefault();
        const t1 = ev.touches[0];
        const t2 = ev.touches[1];
        const dist = Math.max(
          1,
          Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY),
        );
        const factor = pinchStartDist / dist;
        const startSpan = pinchStartView.end - pinchStartView.start;
        const newSpan = Math.max(
          TIMELINE_MIN_SPAN_MS,
          Math.min(maxViewSpan, startSpan * factor),
        );
        const ratio = (pinchAnchorTs - pinchStartView.start) / startSpan;
        const newStart = pinchAnchorTs - newSpan * ratio;
        setView(newStart, newStart + newSpan);
      } else if (brushing && ev.touches.length === 1) {
        ev.preventDefault();
        brushCurPx = localX(ev.touches[0].clientX);
        updateBrushRect();
      }
    },
    { passive: false },
  );

  svgWrap.addEventListener("touchend", (ev) => {
    if (pinchActive && ev.touches.length < 2) {
      pinchActive = false;
    }
    if (brushing && ev.touches.length === 0) {
      commitBrush();
    }
  });

  svgWrap.addEventListener("touchcancel", () => {
    pinchActive = false;
    clearBrush();
  });

  // Resize: re-render when the container width changes (orientation change,
  // window resize, etc.).
  const ro = new ResizeObserver(() => {
    if (svgWrap.isConnected) render();
  });
  ro.observe(svgWrap);

  // Cleanup global listeners when the timeline is removed from the DOM.
  const mo = new MutationObserver(() => {
    if (!container.isConnected) {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
      ro.disconnect();
      mo.disconnect();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  render();
}

// ---------- routing -----------------------------------------------------

function setActiveTab(view) {
  for (const tab of TABS) {
    if (tab.dataset.view === view) tab.classList.add("active");
    else tab.classList.remove("active");
  }
}

function route() {
  const hash = location.hash || "#/";

  if (hash === "#/" || hash === "#" || hash === "") {
    setActiveTab("plates");
    renderPlates();
  } else if (hash === "#/sightings") {
    setActiveTab("sightings");
    renderSightings();
  } else if (hash.startsWith("#/plate/")) {
    setActiveTab("plates");
    const plate = decodeURIComponent(hash.slice("#/plate/".length));
    renderDetail(plate);
  } else {
    location.hash = "#/";
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", async () => {
  // Pull runtime config first so the first render already knows whether to
  // show the Frigate deep-link. setFooterStatus runs in parallel.
  await Promise.allSettled([
    fetchAppConfig(),
    fetchProviderConfig(),
    setFooterStatus(),
  ]);
  route();
});

// ESC = back to the plate list (same as the "← Back to list" link in the
// detail view). Defer to a timeline brush in progress, which has its own
// Escape handler that cancels the brush.
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (document.querySelector(".timeline-svg-wrap.is-brushing")) return;
  if (location.hash.startsWith("#/plate/")) {
    location.hash = "#/";
  }
});
