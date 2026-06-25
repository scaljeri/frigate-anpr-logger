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

/** Apply the country-specific hyphenation a provider declared for this plate.
 *
 * If `display` is given (the source's own formatting, e.g. Frigate's
 * "GVF-57-G"), prefer it verbatim — but only when it represents the same plate,
 * so a stale value can never mislabel a row. Otherwise fall back to the
 * sidecode rules, then to the bare uppercased plate. */
function formatPlate(plate, display) {
  if (!plate) return "";
  const clean = String(plate).replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (!clean) return plate;
  if (display) {
    const d = String(display).trim().toUpperCase();
    if (d.replace(/[^A-Z0-9]/g, "") === clean) return d;
  }
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

function plateBadge(plate, { large = false, small = false, display = null } = {}) {
  const cls = ["plate"];
  if (large) cls.push("plate-lg");
  if (small) cls.push("plate-sm");
  return h(`span.${cls.join(".")}`, {}, formatPlate(plate, display));
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

// ---- full-screen busy overlay -------------------------------------------
//
// A scrim that blurs the whole page and centres a spinner while a plate edit
// does its server-side work: merging the plate into an existing one, or looking
// a fresh plate up against the vehicle registry. Both round-trip through a
// provider HTTP lookup, so we freeze the page rather than leave the header in a
// half-edited state. One element, reused across calls; hideOverlay() fades it.
let overlayEl = null;

function showOverlay(message) {
  if (!overlayEl) {
    overlayEl = h(
      "div.app-overlay",
      { role: "status", "aria-live": "polite" },
      h(
        "div.app-overlay-card",
        {},
        h("div.spinner", { "aria-hidden": "true" }),
        h("div.app-overlay-label"),
      ),
    );
    document.body.appendChild(overlayEl);
  }
  overlayEl.querySelector(".app-overlay-label").textContent = message || "Working…";
  // Reflow so the fade-in runs even when we add the class in the same tick.
  void overlayEl.offsetWidth;
  overlayEl.classList.add("is-visible");
}

function hideOverlay() {
  if (overlayEl) overlayEl.classList.remove("is-visible");
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
    render: r => plateBadge(r.plate, { display: r.display_plate }) },
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

    // Does the target plate already exist? The answer drives two things: a
    // merge confirmation (so a typo doesn't silently fold two cars together),
    // and the busy-overlay wording — "Merging…" vs "Looking up…".
    let willMerge = false;
    try {
      const existing = await apiGet(`/counts?plate=${encodeURIComponent(newPlate)}`);
      const target = existing.items && existing.items[0];
      if (target && target.count > 0) {
        willMerge = true;
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

    // Freeze the page behind a blurred overlay while the server does the magic
    // in one atomic call: move every passage onto the new plate, drop the
    // orphaned source row, carry the snapshot, and (re)fetch the destination's
    // vehicle data. renderDetail() lifts the overlay once the redirected-to
    // plate has painted.
    editing = false;
    showOverlay(
      willMerge
        ? `Merging into ${formatPlate(newPlate)}…`
        : `Looking up ${formatPlate(newPlate)}…`,
    );
    try {
      await apiPost(`/plates/${encodeURIComponent(plate)}/rename`, { to: newPlate });
      // Navigate to the new plate's detail (re-renders against fresh server state).
      location.hash = `#/plate/${encodeURIComponent(newPlate)}`;
    } catch (e) {
      hideOverlay();
      alert(`Failed to update plate: ${e.message}`);
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
        // Seed with the displayed (dashed) form so the dashes don't vanish on
        // edit; normalizePlateForBackend strips them again on save.
        value: formatPlate(plate, meta.display_plate),
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
      plateNode = plateBadge(plate, { large: true, display: meta.display_plate });
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

  // The detail view has fully painted. If we got here via a plate-edit redirect
  // (merge or fresh lookup), lift the busy overlay now — not before, so the
  // blur stays up until the new plate is actually on screen. No-op otherwise.
  hideOverlay();
}

// Quick-range presets for the Passages page. Each maps "now" to a [from, to]
// window in epoch-ms using local-time calendar boundaries.
function _startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
const SIGHTINGS_PRESETS = [
  { key: "today", label: "Today", range: (now) => [_startOfDay(now), now] },
  {
    key: "yesterday",
    label: "Yesterday",
    range: (now) => {
      const today = _startOfDay(now);
      return [_startOfDay(today - 1), today];
    },
  },
  {
    key: "week",
    // Rolling 7-day window ending now — always a full week of time, regardless
    // of the weekday (unlike a Monday→now calendar week, which is short early
    // in the week).
    label: "Last 7 days",
    range: (now) => [now - 7 * 24 * 60 * 60_000, now],
  },
  {
    key: "month",
    label: "This month",
    range: (now) => {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
      return [d.getTime(), now];
    },
  },
];

// Preset that's active by default when no explicit range is chosen.
const DEFAULT_SIGHTINGS_PRESET = "week";

// The page's base window: the chosen preset, or — by default — "this week".
// Returns [from, to, label].
function sightingsBaseRange() {
  if (sightingsBase) {
    return [sightingsBase.from, sightingsBase.to, sightingsBase.label];
  }
  const p = SIGHTINGS_PRESETS.find((x) => x.key === DEFAULT_SIGHTINGS_PRESET);
  const [from, to] = p.range(Date.now());
  return [from, to, p.label];
}

// Active preset/base range for the Passages page ({key, label, from, to}), or
// null for the default rolling last-7-days window. Set by the preset buttons.
let sightingsBase = null;

// Shared time filter for the Passages views. null = viewing the full base
// window (a preset, or "last 7 days" by default). When the user narrows the
// timeline to a sub-window, this holds {from, to} in epoch-ms and BOTH sub-views
// honor it — switching to the List tab then shows exactly the events that were
// visible in the filtered timeline. Lives at module scope so it survives the
// hash-driven re-render when the user flips sub-tabs.
let sightingsFilter = null;

// Zoom-history (shift-click "step back" stack) for the Passages timeline. Kept
// at module scope and passed into mountTimeline by reference, so the steps
// survive a List/Timeline sub-tab switch while the user stays on the page. Tied
// to the filter session: reset whenever the filter is cleared / absent.
let sightingsTimelineHistory = [];

// Render the zoom-range chip next to the sub-tabs: the zoomed "start → end"
// window, when the user has narrowed inside the base. An active preset shows
// its own ✕ (in its pill), so the chip is only for the zoom sub-range; its ✕
// drops just the zoom and returns to the full base window.
function renderSightingsFilterChip() {
  const el = document.getElementById("sightings-filter");
  if (!el) return;
  clear(el);
  if (!sightingsFilter) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.appendChild(
    h(
      "span.filter-chip-range",
      {},
      `${fmtDateTime.format(new Date(sightingsFilter.from))}  →  ${fmtDateTime.format(new Date(sightingsFilter.to))}`,
    ),
  );
  el.appendChild(
    h(
      "button.filter-chip-x",
      {
        type: "button",
        title: "Clear zoom",
        "aria-label": "Clear zoom",
        onClick: clearSightingsZoom,
      },
      "✕",
    ),
  );
}

// Render the quick-range preset buttons. The active one is highlighted and
// carries an inline ✕ (inside the same highlighted pill) that clears it.
function renderSightingsPresets() {
  const el = document.getElementById("sightings-presets");
  if (!el) return;
  clear(el);
  // A custom zoom range (sightingsFilter) matches no preset, so nothing is
  // highlighted. Otherwise "week" is active by default when no preset is set.
  const activeKey = sightingsFilter
    ? null
    : sightingsBase
      ? sightingsBase.key
      : DEFAULT_SIGHTINGS_PRESET;
  for (const p of SIGHTINGS_PRESETS) {
    const active = activeKey === p.key;
    const pill = h("span.preset" + (active ? ".active" : ""), {});
    pill.appendChild(
      h(
        "button.preset-label",
        { type: "button", title: p.label, onClick: () => applySightingsPreset(p) },
        p.label,
      ),
    );
    // The clear ✕ only on a non-default chosen preset — the default "week" is
    // the home state, so there's nothing to clear it back to.
    if (active && p.key !== DEFAULT_SIGHTINGS_PRESET) {
      pill.appendChild(
        h(
          "button.preset-x",
          {
            type: "button",
            title: "Clear range",
            "aria-label": "Clear range",
            onClick: clearSightingsFilter,
          },
          "✕",
        ),
      );
    }
    el.appendChild(pill);
  }
}

function applySightingsPreset(p) {
  if (p.key === DEFAULT_SIGHTINGS_PRESET) {
    sightingsBase = null; // the default; no explicit base needed
  } else {
    const [from, to] = p.range(Date.now());
    sightingsBase = { key: p.key, label: p.label, from, to };
  }
  sightingsFilter = null; // open on the full preset range
  sightingsTimelineHistory = [];
  route();
}

// Drop just the zoom sub-window, keeping the active preset/base (the chip ✕).
function clearSightingsZoom() {
  sightingsFilter = null;
  sightingsTimelineHistory = [];
  route();
}

// Clear everything back to the default last-7-days window (the preset pill ✕).
function clearSightingsFilter() {
  sightingsFilter = null;
  sightingsBase = null;
  sightingsTimelineHistory = [];
  route();
}

async function renderSightings(subview = "list") {
  renderTemplate("tpl-sightings");

  // Wire the List | Timeline sub-tabs and reflect the active one. Each toggle
  // just sets the hash; route() re-renders with the chosen sub-view.
  for (const btn of document.querySelectorAll("#main [data-subview]")) {
    const view = btn.dataset.subview;
    btn.classList.toggle("active", view === subview);
    btn.addEventListener("click", () => {
      location.hash =
        view === "timeline" ? "#/sightings?view=timeline" : "#/sightings";
    });
  }

  // Preset buttons + the active-range chip are shared by both sub-views (they
  // carry the range across a sub-tab switch).
  renderSightingsPresets();
  renderSightingsFilterChip();

  const listEl = document.getElementById("sightings-list");
  const tlEl = document.getElementById("sightings-timeline");
  listEl.hidden = subview === "timeline";
  tlEl.hidden = subview !== "timeline";

  if (subview === "timeline") return renderSightingsTimeline();
  return renderSightingsList();
}

async function renderSightingsList() {
  const listEl = document.getElementById("sightings-list");
  const metaEl = document.getElementById("sightings-meta");

  listEl.appendChild(h("div.status", {}, "Loading…"));

  // Honor the active window: a zoom filter takes precedence, else the base
  // window (a chosen preset, or "last 7 days" by default — both bound the list).
  const [bFrom, bTo] = sightingsBaseRange();
  const win = sightingsFilter || { from: bFrom, to: bTo };
  const query =
    `/sightings?limit=500` +
    `&from=${encodeURIComponent(new Date(win.from).toISOString())}` +
    `&to=${encodeURIComponent(new Date(win.to).toISOString())}`;

  let sightings;
  try {
    sightings = await apiGet(query);
  } catch (e) {
    clear(listEl);
    listEl.appendChild(h("div.status.error", {}, `Failed to fetch /sightings: ${e.message}`));
    return;
  }

  clear(listEl);

  if (!sightings.length) {
    listEl.appendChild(
      h("div.status", {}, "No passages in the selected period."),
    );
    return;
  }

  const n = sightings.length;
  metaEl.textContent = `${n} passage${n === 1 ? "" : "s"}`;

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
      // Mirror the fields shown on the home (Plates) list: photo, plate,
      // vehicle, colour, year — plus the passage-specific time and camera.
      const row = h(
        "a.sighting-row",
        { href: `#/plate/${encodeURIComponent(s.plate)}` },
        h("span.sighting-time", {}, fmtTime.format(new Date(s.seen_at))),
        h(
          "span.sighting-photo",
          {},
          s.has_snapshot ? snapshotThumb(s.plate) : null,
        ),
        plateBadge(s.plate, { small: true, display: s.raw_plate }),
        h("span.sighting-vehicle", {}, vehicleLabel(s) || muted()),
        h("span.sighting-colour", {}, s.colour ? titleCase(s.colour) : muted()),
        h("span.sighting-year", {}, s.year || muted()),
        h("span.sighting-camera", {}, s.camera || ""),
      );
      section.appendChild(row);
    }
    listEl.appendChild(section);
  }
}

// All-vehicles timeline: every passage in the last 7 days on one combined
// axis. Reuses mountTimeline with a 7-day window, pan enabled, a plate-aware
// tooltip, and click-to-navigate to the plate detail page.
async function renderSightingsTimeline() {
  const wrap = document.getElementById("sightings-timeline");
  const metaEl = document.getElementById("sightings-meta");

  wrap.appendChild(h("div.status", {}, "Loading…"));

  // The base window (active preset, or "last 7 days" by default) sets where the
  // timeline opens; the data itself is loaded in full so panning/zooming always
  // has points, not just the base window.
  const [start, end] = sightingsBaseRange();

  // Load all sightings (newest LIMIT). At a home camera's volume this is a few
  // dozen rows now and stays well under the cap for years; if it ever
  // approaches LIMIT, switch the timeline to windowed lazy-loading (the
  // /sightings from/to range query is already indexed for it).
  const LIMIT = 5000;
  let sightings;
  try {
    sightings = await apiGet(`/sightings?limit=${LIMIT}`);
  } catch (e) {
    clear(wrap);
    wrap.appendChild(
      h("div.status.error", {}, `Failed to fetch /sightings: ${e.message}`),
    );
    return;
  }

  clear(wrap);

  // Pre-parse timestamps once so the live count (recomputed as the user
  // pans/zooms) stays cheap.
  const tsList = sightings
    .map((s) => Date.parse(s.seen_at))
    .filter(Number.isFinite);
  const countInWindow = (a, b) =>
    tsList.reduce((n, t) => n + (t >= a && t <= b ? 1 : 0), 0);
  const baseCount = countInWindow(start, end);
  const plural = (n) => (n === 1 ? "" : "s");

  // Fired on every view change (pan/zoom/brush/reset). When the view spans the
  // full base window we treat it as "no zoom filter": clear the sub-filter so
  // the List shows the whole base. The label reads "last 7 days" for the default
  // base; for a preset the pill already names it, so we just count.
  let presetsReflectFilter = sightingsFilter != null;
  function onTimelineView(viewStart, viewEnd) {
    const isFull =
      Math.abs(viewStart - start) < 1000 && Math.abs(viewEnd - end) < 1000;
    if (isFull) {
      sightingsFilter = null;
      metaEl.textContent = sightingsBase
        ? `${baseCount} passage${plural(baseCount)}`
        : `${baseCount} passage${plural(baseCount)} in the last 7 days`;
    } else {
      sightingsFilter = { from: viewStart, to: viewEnd };
      const n = countInWindow(viewStart, viewEnd);
      metaEl.textContent = `${n} passage${plural(n)}`;
    }
    renderSightingsFilterChip();
    // Re-highlight presets only when the custom-range state flips: a custom
    // zoom de-selects every preset; returning to the full base re-selects it.
    const hasFilter = sightingsFilter != null;
    if (hasFilter !== presetsReflectFilter) {
      presetsReflectFilter = hasFilter;
      renderSightingsPresets();
    }
  }

  // Viewing the full base window → start the step stack empty too (don't carry
  // stale steps from a prior session).
  if (!sightingsFilter) sightingsTimelineHistory = [];

  mountTimeline(wrap, sightings, {
    // The base window is the reset target + bounds anchor; open on the active
    // zoom filter (if any) via initialView, so Reset and shift-click still
    // zoom back out to the full base window.
    initialStart: start,
    initialEnd: end,
    initialView: sightingsFilter ? [sightingsFilter.from, sightingsFilter.to] : null,
    // Persist the shift-click step stack across sub-tab switches (by reference).
    history: sightingsTimelineHistory,
    enablePan: true,
    onViewChange: onTimelineView,
    // The timeline's Reset button returns the whole page to the default window
    // (clears any zoom and any chosen preset → back to "last 7 days").
    onReset: clearSightingsFilter,
    formatTooltip: (pt) => {
      const r = pt.row;
      const parts = [
        formatPlate(r.plate, r.raw_plate),
        fmtDateTime.format(new Date(pt.ts)),
      ];
      if (r.camera) parts.push(r.camera);
      const desc = [vehicleLabel(r), r.colour ? titleCase(r.colour) : null]
        .filter(Boolean)
        .join(" · ");
      if (desc) parts.push(desc);
      return parts.join("  ·  ");
    },
    onClick: (r) => {
      location.hash = "#/plate/" + encodeURIComponent(r.plate);
    },
  });
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

function mountTimeline(container, passages, opts = {}) {
  clear(container);

  const data = (passages || [])
    .map((p) => ({
      ts: Date.parse(p.seen_at),
      score: typeof p.score === "number" ? p.score : null,
      camera: p.camera || null,
      row: p, // source row, for richer tooltip / click navigation
    }))
    .filter((d) => Number.isFinite(d.ts))
    .sort((a, b) => a.ts - b.ts);

  // A caller-supplied window (e.g. the all-vehicles week view) lets us render an
  // axis even with no points; without one, an empty dataset has nothing to show.
  const hasWindow = opts.initialStart != null && opts.initialEnd != null;
  if (!data.length && !hasWindow) {
    container.appendChild(h("div.status", {}, "No timestamps to show."));
    return;
  }

  // Data extent (falls back to the requested window when there are no points).
  const firstTs = data.length ? data[0].ts : opts.initialStart;
  const lastTs = data.length ? data[data.length - 1].ts : opts.initialEnd;
  // Minimum data span for sensible default view (e.g. one sighting only).
  const dataSpan = Math.max(lastTs - firstTs, 10 * TIMELINE_MIN_SPAN_MS);
  const initialPad = Math.max(dataSpan * 0.05, 5 * TIMELINE_MIN_SPAN_MS);
  const initialStart = opts.initialStart ?? firstTs - initialPad;
  const initialEnd = opts.initialEnd ?? lastTs + initialPad;

  // Absolute bounds: don't let the user pan/zoom infinitely off-data. Widen to
  // also cover the requested window, so the clamp can't snap a sparse week view
  // back onto a tight data cluster.
  const lo = Math.min(firstTs, initialStart);
  const hi = Math.max(lastTs, initialEnd);
  const boundSpan = Math.max(hi - lo, dataSpan);
  const absoluteMin = lo - boundSpan * 4;
  const absoluteMax = hi + boundSpan * 4;
  const maxViewSpan = Math.max(boundSpan * 8, 365 * 24 * 60 * 60_000);

  let viewStart = initialStart;
  let viewEnd = initialEnd;
  // Optionally open on a narrower sub-window (e.g. a restored time filter) while
  // keeping initialStart/End as the reset target + bounds anchor, so Reset and
  // shift-click still zoom back out to the full window.
  if (Array.isArray(opts.initialView)) {
    viewStart = opts.initialView[0];
    viewEnd = opts.initialView[1];
  }

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
    opts.enablePan &&
      h("span", {}, h("kbd", {}, "Shift+scroll / swipe / drag"), " pan"),
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
  // Every deliberate zoom records the prior view so shift-click / undo steps
  // back through them one at a time. Discrete actions (brush, +/− button,
  // Reset) push directly; continuous gestures (wheel, pinch) push once at the
  // start of each gesture (coalesced) so a burst of wheel ticks is one step.
  // Capped at MAX_HISTORY; when the stack is exhausted, undo() resets to the
  // initial view. The caller may pass `opts.history` (an array used by
  // reference) to persist the stack across re-mounts.

  const MAX_HISTORY = 10;
  const history = Array.isArray(opts.history) ? opts.history : [];

  function pushHistory() {
    const top = history[history.length - 1];
    if (top && top[0] === viewStart && top[1] === viewEnd) return;
    history.push([viewStart, viewEnd]);
    if (history.length > MAX_HISTORY) history.shift();
    updateUndoBtn();
  }

  function undo() {
    if (history.length) {
      const [s, e] = history.pop();
      viewStart = s;
      viewEnd = e;
      render();
      updateUndoBtn();
      return;
    }
    // Nothing recorded (e.g. zoomed in via wheel, or the view opened on a
    // restored filter window): treat shift-click / undo as "zoom back out" to
    // the initial full window instead of a no-op.
    if (viewStart !== initialStart || viewEnd !== initialEnd) {
      setView(initialStart, initialEnd);
    }
  }

  function updateUndoBtn() {
    // Enabled whenever undo() would do something: a recorded step exists, or
    // we're zoomed in past the full window (the zoom-out fallback). Keeps the
    // button in sync with shift-click. Refreshed from render() on every view.
    undoBtn.disabled =
      history.length === 0 &&
      viewStart === initialStart &&
      viewEnd === initialEnd;
  }

  function zoomButton(factor) {
    pushHistory();
    zoom(factor);
  }

  function reset() {
    // Callers can take over Reset (e.g. clear the page filter back to default);
    // otherwise just zoom out to the full window.
    if (opts.onReset) {
      opts.onReset();
      return;
    }
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

    // Let callers react to the visible window (e.g. update a passage count).
    if (opts.onViewChange) opts.onViewChange(viewStart, viewEnd);

    // Keep the undo/zoom-out button in sync with the current view.
    updateUndoBtn();
  }

  // ---- interaction ----
  //
  // Drag (mouse or single touch) in the spike area paints a brush rectangle;
  // on release we zoom to that range. Vertical wheel + buttons zoom centered.
  // Pinch (2 fingers) zooms continuously. When opts.enablePan is set, panning
  // is available via middle-mouse, Space+drag, a drag on the bottom axis strip,
  // or horizontal scroll (trackpad swipe / Shift+wheel) — it shifts the view
  // window without zooming. A clean click (no drag) calls opts.onClick with the
  // nearest point's source row, for click-to-navigate.

  const BRUSH_MIN_PX = 6;

  let brushing = false;
  let brushStartPx = 0;
  let brushCurPx = 0;
  let brushRect = null;

  let panning = false;
  let panStartPx = 0;
  let panStartView = null;
  let spaceHeld = false;

  let pinchActive = false;
  let pinchStartDist = 0;
  let pinchStartView = null;
  let pinchAnchorTs = 0;

  function localX(clientX) {
    const rect = svgWrap.getBoundingClientRect();
    return Math.max(0, Math.min(width, clientX - rect.left));
  }

  // Y (in wrap coords) below which the axis strip lives; dragging there pans.
  function axisBaseY() {
    return (svgWrap.clientHeight || 140) - 32;
  }

  function startPan(clientX) {
    panning = true;
    panStartPx = localX(clientX);
    panStartView = { start: viewStart, end: viewEnd };
    tooltip.style.display = "none";
    svgWrap.classList.add("is-panning");
  }

  function findNearestPx(x) {
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
    return nearest;
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

  // Coalesce a burst of wheel ticks into a single undo step: record the view
  // once per gesture (after a pause), not on every tick.
  let lastWheelMs = -Infinity;
  const WHEEL_STEP_GAP_MS = 300;
  svgWrap.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      // Horizontal intent → scroll (pan) the window left/right; vertical →
      // zoom. Trackpads emit deltaX for a two-finger horizontal swipe; Shift+
      // wheel is the mouse equivalent. Panning shifts the view without zooming
      // and doesn't record an undo step (matching drag-pan).
      if (opts.enablePan) {
        let panDelta = 0;
        if (ev.shiftKey) panDelta = ev.deltaY || ev.deltaX;
        else if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) panDelta = ev.deltaX;
        if (panDelta !== 0) {
          const span = viewEnd - viewStart;
          const dts = (panDelta / Math.max(1, width)) * span;
          setView(viewStart + dts, viewEnd + dts);
          return;
        }
      }
      const anchorTs = pxToTs(localX(ev.clientX));
      // Trackpad pinch shows up as ctrlKey + wheel — same handler covers it.
      const factor = Math.exp(ev.deltaY * 0.0015);
      if (ev.timeStamp - lastWheelMs > WHEEL_STEP_GAP_MS) pushHistory();
      lastWheelMs = ev.timeStamp;
      zoom(factor, anchorTs);
    },
    { passive: false },
  );

  svgWrap.addEventListener("mousedown", (ev) => {
    if (opts.enablePan) {
      const onAxis =
        ev.clientY - svgWrap.getBoundingClientRect().top > axisBaseY();
      if (ev.button === 1 || (ev.button === 0 && (spaceHeld || onAxis))) {
        ev.preventDefault();
        startPan(ev.clientX);
        return;
      }
    }
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
    if (panning) {
      const dxPx = localX(ev.clientX) - panStartPx;
      const span = panStartView.end - panStartView.start;
      const dts = -(dxPx / Math.max(1, width)) * span;
      setView(panStartView.start + dts, panStartView.end + dts);
      return;
    }
    if (brushing) {
      brushCurPx = localX(ev.clientX);
      updateBrushRect();
      return;
    }
    showTooltipAt(ev.clientX);
  }

  function onMouseUp() {
    if (panning) {
      panning = false;
      svgWrap.classList.remove("is-panning");
      return;
    }
    if (brushing) {
      // A press that never moved past the brush threshold is a click: navigate
      // to the nearest point instead of zooming.
      const dx = Math.abs(brushCurPx - brushStartPx);
      if (dx < BRUSH_MIN_PX && opts.onClick) {
        const nearest = findNearestPx(brushStartPx);
        clearBrush();
        if (nearest) opts.onClick(nearest.row);
        return;
      }
      commitBrush();
    }
  }

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  svgWrap.addEventListener("mouseleave", () => {
    if (!brushing) tooltip.style.display = "none";
  });

  // Escape cancels an in-progress brush/pan; Space (when hovering) arms pan mode.
  function onKeyDown(ev) {
    if (ev.key === "Escape") {
      if (brushing) clearBrush();
      if (panning) {
        panning = false;
        svgWrap.classList.remove("is-panning");
      }
    }
    if (opts.enablePan && ev.code === "Space" && !ev.repeat) {
      spaceHeld = true;
      // Don't let Space scroll the page while panning the timeline.
      if (svgWrap.matches(":hover")) ev.preventDefault();
    }
  }
  function onKeyUp(ev) {
    if (ev.code === "Space") spaceHeld = false;
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

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
    if (opts.formatTooltip) {
      const content = opts.formatTooltip(nearest);
      if (content instanceof Node) {
        clear(tooltip);
        tooltip.appendChild(content);
      } else {
        tooltip.textContent = String(content);
      }
    } else {
      const parts = [fmtDateTime.format(new Date(nearest.ts))];
      if (nearest.score != null) parts.push(`score ${nearest.score.toFixed(2)}`);
      if (nearest.camera) parts.push(nearest.camera);
      tooltip.textContent = parts.join("  ·  ");
    }
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
        // One undo step per pinch gesture (recorded as the second finger lands).
        pushHistory();
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
      window.removeEventListener("keyup", onKeyUp);
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
  } else if (hash === "#/sightings" || hash.startsWith("#/sightings?")) {
    setActiveTab("sightings");
    const q = new URLSearchParams(hash.split("?")[1] || "");
    renderSightings(q.get("view") === "timeline" ? "timeline" : "list");
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
