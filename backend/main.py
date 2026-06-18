#!/usr/bin/env python3
"""ANPR logger + dashboard, in one Python process.

A background thread consumes Frigate LPR events over MQTT and writes sightings
to SQLite. The same process serves a FastAPI JSON API plus a small
frontend dashboard on the same origin. Vehicle data is enriched on first sighting of a
plate via a config-driven provider (Dutch RDW out of the box — see
``providers/README.md`` to add a country).

State lives in the SQLite file at ``DB_PATH`` (``/data/anpr.db`` in the
container). Schema migrations run automatically at startup; see
``scripts/migrate.py``.
"""
import json
import logging
import os
import re
import shutil
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

import paho.mqtt.client as mqtt
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# The migration runner lives in ./scripts/ at the repo root. In dev this is
# `<repo>/scripts/`; in the Docker image it's copied to `/app/scripts/` (next
# to main.py). Both layouts are handled by walking up looking for a sibling
# scripts/ directory.
_HERE = Path(__file__).resolve().parent
for _candidate in (_HERE / "scripts", _HERE.parent / "scripts"):
    if (_candidate / "migrate.py").is_file():
        sys.path.insert(0, str(_candidate))
        break
from migrate import migrate as run_migrations  # noqa: E402

# ---- Config via environment ----
MQTT_HOST = os.getenv("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USER", "")
MQTT_PASS = os.getenv("MQTT_PASS", "")
# Stable client id + clean_session=False keeps the broker queueing events
# for us while we're offline; on reconnect we receive whatever piled up
# during downtime (broker memory; no broker disk-persistence required).
MQTT_CLIENT_ID = os.getenv("MQTT_CLIENT_ID", "frigate-anpr-logger")
TOPIC = os.getenv("FRIGATE_TOPIC", "frigate/events")
DB_PATH = os.getenv("DB_PATH", "/data/anpr.db")
MIN_SCORE = float(os.getenv("MIN_SCORE", "0.8"))
API_PORT = int(os.getenv("API_PORT", "8080"))
# Page size for the dashboard's paginated /counts endpoint. Also surfaced
# to the frontend via /config so a single source of truth drives both.
PAGE_SIZE = int(os.getenv("PAGE_SIZE", "50"))

# Frigate URLs:
#   FRIGATE_URL         — used by the backend to pull snapshots from Frigate's
#                          HTTP API. Container-internal addressing is fine
#                          (e.g. http://frigate:5000 inside a compose stack).
#   FRIGATE_PUBLIC_URL  — used by the dashboard for the "View in Frigate" link.
#                          Must be reachable from the operator's *browser*.
#                          Falls back to FRIGATE_URL when unset, which works
#                          for single-host setups where both addressing modes
#                          land on the same host:port.
# Either empty/unset disables the respective half of the feature.
FRIGATE_URL = os.getenv("FRIGATE_URL", "").rstrip("/")
FRIGATE_PUBLIC_URL = os.getenv("FRIGATE_PUBLIC_URL", FRIGATE_URL).rstrip("/")
SNAPSHOTS_DIR = Path(DB_PATH).parent / "snapshots"
SNAPSHOT_TIMEOUT = float(os.getenv("SNAPSHOT_TIMEOUT", "5"))

# Vehicle-registry providers (see backend/providers/README.md).
PROVIDERS_DIR = Path(os.getenv("PROVIDERS_DIR", "/app/providers"))
PROVIDERS_DEFAULT_DIR = Path(
    os.getenv("PROVIDERS_DEFAULT_DIR", "/app/providers_default")
)
VEHICLE_FIELDS = (
    # Core identification.
    "make", "model", "colour", "body_type", "year", "fuel", "inspection_due",
    # Tier 1: financial / compliance signals.
    "catalog_price", "insured", "recall_open", "is_taxi",
    # Tier 2: display extras.
    "body_style", "owner_since", "efficiency_label", "colour_secondary",
    # Tier 3: technical specs + dimensions.
    "engine_cc", "seats", "doors", "mass_kg", "power_to_weight",
    "length_cm", "width_cm",
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("anpr")


# ---------------------------------------------------------------------------
# Database helpers (every caller opens its own short-lived connection)
# ---------------------------------------------------------------------------
@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    """Bring the SQLite file at DB_PATH to the latest schema version.

    Delegates entirely to ``backend/migrate.py`` so the migration history is
    declared in one place. Safe to call repeatedly — already-current DBs are
    a no-op.
    """
    run_migrations(DB_PATH)


def normalize_plate(raw: str) -> str:
    return raw.upper().replace("-", "").replace(" ", "").strip()


# OCR routinely confuses these character pairs on real-world plates.
# Kept deliberately small: only swaps we actually see in the wild, and only
# the ones where one direction is a letter and the other a digit so a single
# swap never breaks a letter-vs-digit position.
_PLATE_CONFUSABLES = {
    "I": "1", "1": "I",
    "G": "5", "5": "G",
    "O": "0", "0": "O",
}


def heal_plate(plate: str) -> str | None:
    """Swap a single OCR-confusable character; ``None`` if 0 or 2+ are present.

    Two-or-more confusables would create an ambiguous fan-out, so we refuse
    rather than guess. Returning ``None`` also means "no second lookup needed".
    """
    positions = [i for i, c in enumerate(plate) if c in _PLATE_CONFUSABLES]
    if len(positions) != 1:
        return None
    i = positions[0]
    return plate[:i] + _PLATE_CONFUSABLES[plate[i]] + plate[i + 1:]


# ---------------------------------------------------------------------------
# Vehicle-registry providers (config-driven, see backend/providers/)
# ---------------------------------------------------------------------------


def seed_providers_if_empty() -> None:
    """If the providers dir is empty/missing, copy in the shipped defaults.

    Lets users bind-mount ``./providers:/app/providers`` from an empty host
    directory and find the example configs already in place after first start.
    """
    if (PROVIDERS_DIR / "index.json").is_file():
        return
    if not PROVIDERS_DEFAULT_DIR.is_dir():
        log.warning(
            "No providers in %s and no defaults at %s — vehicle lookup disabled.",
            PROVIDERS_DIR,
            PROVIDERS_DEFAULT_DIR,
        )
        return
    PROVIDERS_DIR.mkdir(parents=True, exist_ok=True)
    for src in PROVIDERS_DEFAULT_DIR.iterdir():
        dest = PROVIDERS_DIR / src.name
        if dest.exists():
            continue
        if src.is_file():
            shutil.copy2(src, dest)
    log.info("Seeded provider defaults into %s", PROVIDERS_DIR)


def load_providers() -> list[dict]:
    """Read index.json + the referenced per-provider JSON files.

    Returns a list of validated provider dicts in registry order. Compiles
    each ``plate_match`` regex once. Invalid entries are skipped with a
    warning so a single broken config can't take the whole app down.
    """
    registry_path = PROVIDERS_DIR / "index.json"
    if not registry_path.is_file():
        log.warning("No providers/index.json at %s — vehicle lookup disabled.", registry_path)
        return []

    try:
        registry = json.loads(registry_path.read_text())
    except (OSError, ValueError) as e:
        log.error("Could not read %s: %s", registry_path, e)
        return []

    names = registry.get("providers") if isinstance(registry, dict) else None
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        log.error("index.json must contain {\"providers\": [\"name\", ...]}")
        return []

    providers: list[dict] = []
    for name in names:
        config_path = PROVIDERS_DIR / f"{name}.json"
        if not config_path.is_file():
            log.warning("Provider %r listed in index.json but %s is missing.", name, config_path)
            continue
        try:
            cfg = json.loads(config_path.read_text())
        except (OSError, ValueError) as e:
            log.warning("Could not read %s: %s", config_path, e)
            continue
        cfg.setdefault("name", name)
        # Compile plate_match once; treat invalid regex as 'no match constraint'.
        pattern = cfg.get("plate_match")
        if pattern:
            try:
                cfg["_plate_re"] = re.compile(pattern)
            except re.error as e:
                log.warning(
                    "Provider %r has invalid plate_match %r: %s",
                    name, pattern, e,
                )
                cfg["_plate_re"] = None
        else:
            cfg["_plate_re"] = None
        # Sanity-check the request block; bad configs are dropped, not crashing.
        request = cfg.get("request")
        if not isinstance(request, dict) or not request.get("url"):
            log.warning("Provider %r has no request.url; skipping.", name)
            continue
        providers.append(cfg)
        log.info("Loaded provider %r (%s)", name, cfg.get("description", ""))
    return providers


_PROVIDERS: list[dict] = []


def select_provider(plate: str) -> dict | None:
    """Pick the first provider whose plate_match accepts the plate.

    Providers without a plate_match regex are tried after the explicit
    matchers, in registry order, as a fallback. Returns None if nothing
    matches.
    """
    fallbacks: list[dict] = []
    for provider in _PROVIDERS:
        regex = provider.get("_plate_re")
        if regex is None:
            fallbacks.append(provider)
            continue
        if regex.search(plate):
            return provider
    return fallbacks[0] if fallbacks else None


_PLATE_PLACEHOLDER = "{plate}"


def _interpolate(value, plate: str):
    """Recursively substitute ``{plate}`` in any string within value."""
    if isinstance(value, str):
        return value.replace(_PLATE_PLACEHOLDER, plate)
    if isinstance(value, list):
        return [_interpolate(item, plate) for item in value]
    if isinstance(value, dict):
        return {k: _interpolate(v, plate) for k, v in value.items()}
    return value


def format_plate_hyphenated(plate: str, provider: dict) -> str:
    """Re-insert separators into a clean plate using the provider's sidecodes.

    Our canonical plate is always separator-free (it's the DB key, used for
    dedup and ``plate_match``), but some registries expect the hyphenated form
    on the wire. We walk the provider's ``plate_format.sidecodes`` and apply the
    first matching rule's two dash positions — the same logic the frontend uses
    for display. No sidecodes or no match → the plate is returned unchanged.

    Patterns are compiled inline; this runs once per plate (lookups are cached)
    and ``re`` caches compiled patterns, so there's no need to pre-compile into
    the provider dict — which would also break ``GET /providers`` serialization.
    """
    sidecodes = (provider.get("plate_format") or {}).get("sidecodes") or []
    for sc in sidecodes:
        if not isinstance(sc, dict):
            continue
        pattern = sc.get("pattern")
        parts = sc.get("parts")
        if not pattern or not isinstance(parts, list) or len(parts) != 2:
            continue
        try:
            matched = re.search(pattern, plate)
        except re.error:
            continue
        if matched:
            p0, p1 = parts
            return f"{plate[:p0]}-{plate[p0:p1]}-{plate[p1:]}"
    return plate


def fetch_vehicle(plate: str, provider: dict) -> object | None:
    """Run the provider's HTTP request and return the (root-resolved) payload.

    Returns the JSON object (after ``response.root`` is applied) or None on
    any failure — network, non-2xx, JSON decode error. Errors are logged but
    never raised to callers.
    """
    request = provider.get("request", {})
    method = (request.get("method") or "GET").upper()
    # Some registries expect the hyphenated plate on the wire. Our canonical
    # plate is always separator-free, so when a provider opts out of dropping
    # hyphens we re-insert them via its sidecodes before interpolation.
    outbound = plate if request.get("drop_hyphens", True) else format_plate_hyphenated(plate, provider)
    url = _interpolate(request.get("url", ""), outbound)
    query = _interpolate(request.get("query") or {}, outbound)
    headers = _interpolate(request.get("headers") or {}, outbound)
    body = request.get("body")
    timeout = float(request.get("timeout_seconds") or 10)

    if query:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{urllib.parse.urlencode(query)}"

    data: bytes | None = None
    if body is not None and method != "GET":
        body = _interpolate(body, outbound)
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
            headers.setdefault("Content-Type", "application/json")
        elif isinstance(body, str):
            data = body.encode()
        else:
            data = str(body).encode()

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
        parsed = json.loads(raw)
    except Exception as e:  # noqa: BLE001 — network/decoder errors all fall to negative cache
        log.warning(
            "Provider %r lookup failed for %s: %s",
            provider.get("name"), plate, e,
        )
        return None

    root = (provider.get("response") or {}).get("root")
    if root:
        rooted = _dig(parsed, root)
        if rooted is None:
            log.info(
                "Provider %r returned no data for %s (root path %r missed).",
                provider.get("name"), plate, root,
            )
            return None
        return rooted
    return parsed


def _dig(obj, path: str):
    """Walk ``obj`` along a dotted path with optional ``[N]`` array indices."""
    if path == "" or path is None:
        return obj
    cur = obj
    # Each segment is either "key", "key[0]", or "[0]" (root array index).
    for segment in path.split("."):
        # Pull off an optional key before the first bracket.
        head, _, rest = segment.partition("[")
        if head:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(head)
        # Now walk any chain of [N] indexes.
        while rest:
            idx_str, _, rest = rest.partition("]")
            try:
                idx = int(idx_str)
            except ValueError:
                return None
            if not isinstance(cur, list) or not (-len(cur) <= idx < len(cur)):
                return None
            cur = cur[idx]
            # rest is "" or "[N]..."; the leading "[" needs trimming.
            if rest.startswith("["):
                rest = rest[1:]
            elif rest:
                # malformed (something after ] that's not another [); bail.
                return None
        if cur is None:
            return None
    return cur


def extract_fields(raw, provider: dict) -> dict[str, str | None]:
    """Pull standard fields out of the provider response using its field map."""
    out = {field: None for field in VEHICLE_FIELDS}
    fields_map = (provider.get("response") or {}).get("fields") or {}
    for field in VEHICLE_FIELDS:
        spec = fields_map.get(field)
        if not spec:
            continue
        if isinstance(spec, str):
            spec = {"path": spec}
        path = spec.get("path")
        value = _dig(raw, path) if path else None
        # Coerce to string for storage; the SQLite columns are TEXT.
        if value is not None and not isinstance(value, str):
            value = str(value)
        # Per-field transforms, applied in the documented order.
        if value is not None and "slice" in spec:
            try:
                start, end = spec["slice"]
                value = value[start:end]
            except (TypeError, ValueError):
                pass
        if value:
            if spec.get("upper"):
                value = value.upper()
            elif spec.get("lower"):
                value = value.lower()
            elif spec.get("title"):
                value = value.title()
        if not value:
            value = spec.get("default") or None
        out[field] = value or None
    return out


def ensure_vehicle(conn, plate: str, force: bool = False, provider: dict | None = None):
    """Idempotent: fetch + cache vehicle info on first sighting of a plate.

    With ``force=True`` any cached row for ``plate`` is dropped first so the
    provider is queried again — used when an operator edits a sighting's
    plate and we want fresh authoritative data even if the new value happens
    to already have an (empty or stale) cache entry.

    With an explicit ``provider`` dict the regex-based ``select_provider`` is
    bypassed — useful when the operator picks a non-default provider from the
    sync dropdown in the UI.
    """
    if force:
        conn.execute("DELETE FROM vehicles WHERE plate = ?", (plate,))
    elif conn.execute("SELECT 1 FROM vehicles WHERE plate = ?", (plate,)).fetchone():
        return
    if provider is None:
        provider = select_provider(plate)
    if provider is None:
        log.info("No provider matches %s; caching empty.", plate)
        conn.execute(
            "INSERT OR IGNORE INTO vehicles(plate, fetched_at) VALUES(?, ?)",
            (plate, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        return
    raw = fetch_vehicle(plate, provider)
    if raw is None:
        healed = heal_plate(plate)
        if healed:
            log.info("Healing %s → %s, retrying %r", plate, healed, provider["name"])
            raw = fetch_vehicle(healed, provider)
    now = datetime.now(timezone.utc).isoformat()
    if raw is None:
        log.info("No data from provider %r for %s; caching empty.", provider["name"], plate)
        conn.execute(
            "INSERT OR IGNORE INTO vehicles(plate, provider, fetched_at) VALUES(?, ?, ?)",
            (plate, provider["name"], now),
        )
        conn.commit()
        return
    fields = extract_fields(raw, provider)
    # Build the column list from VEHICLE_FIELDS so adding a new field is a
    # one-line tuple edit — schema, provider config, and write path stay in
    # sync without further code changes here.
    columns = ("plate", *VEHICLE_FIELDS, "provider", "raw_json", "fetched_at")
    placeholders = ", ".join("?" * len(columns))
    values = (
        plate,
        *(fields[f] for f in VEHICLE_FIELDS),
        provider["name"],
        json.dumps(raw),
        now,
    )
    conn.execute(
        f"INSERT OR REPLACE INTO vehicles ({', '.join(columns)}) VALUES ({placeholders})",
        values,
    )
    conn.commit()
    log.info(
        "%s: stored %s via %r",
        plate,
        " ".join(filter(None, [fields["make"], fields["model"]])) or "<no data>",
        provider["name"],
    )


# ---------------------------------------------------------------------------
# Frigate snapshot capture (one image per plate, fetched on first sighting)
# ---------------------------------------------------------------------------


def _snapshot_path(plate: str) -> Path:
    """Filesystem path for the cached snapshot of ``plate`` (may not exist)."""
    return SNAPSHOTS_DIR / f"{plate}.jpg"


def maybe_fetch_snapshot(plate: str, event_id: str) -> None:
    """Pull Frigate's snapshot for ``event_id`` if we don't have one for ``plate`` yet.

    Side-effect: writes ``SNAPSHOTS_DIR/<plate>.jpg``. Errors are logged but
    never raised — a missing snapshot is fine, the sighting itself still landed.
    """
    if not FRIGATE_URL or not event_id:
        return
    dest = _snapshot_path(plate)
    if dest.exists():
        return
    url = f"{FRIGATE_URL}/api/events/{event_id}/snapshot.jpg"
    try:
        with urllib.request.urlopen(url, timeout=SNAPSHOT_TIMEOUT) as resp:
            body = resp.read()
        SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
        log.info("Snapshot cached for %s (%d bytes)", plate, len(body))
    except Exception as e:  # noqa: BLE001 — best-effort; failure is non-fatal
        log.warning("Snapshot fetch failed for %s via %s: %s", plate, url, e)


def migrate_snapshot(src_plate: str, dst_plate: str) -> None:
    """Move the cached snapshot from ``src_plate`` to ``dst_plate`` on a rename.

    So a corrected plate keeps its photo. If the destination already has a
    snapshot (renaming *into* an existing plate — i.e. a merge), the
    destination's image wins and the source file is discarded as an orphan.
    Best-effort: filesystem errors are logged, never raised.
    """
    src = _snapshot_path(src_plate)
    dst = _snapshot_path(dst_plate)
    if not src.exists():
        return
    try:
        if dst.exists():
            src.unlink()
        else:
            src.replace(dst)  # atomic rename within the same directory
    except OSError as e:
        log.warning("Snapshot move %s -> %s failed: %s", src, dst, e)


# ---------------------------------------------------------------------------
# MQTT listener (runs in a background thread)
# ---------------------------------------------------------------------------
def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        log.info("Connected to MQTT %s:%s, subscribing to %s",
                 MQTT_HOST, MQTT_PORT, TOPIC)
        # Defensive: an earlier version of this app listened on
        # `tracked_object_update`. With a persistent session the broker may
        # still hold that subscription — drop it explicitly so we don't get
        # the old per-frame events alongside the new end-event stream.
        client.unsubscribe("frigate/tracked_object_update")
        # QoS 1: broker queues events for us during downtime and redelivers
        # on reconnect (works with our persistent session).
        client.subscribe(TOPIC, qos=1)
    else:
        log.error("MQTT connection failed, rc=%s", rc)


def on_message(client, userdata, msg):
    """Handle a Frigate `frigate/events` message.

    We act only on ``type=end`` events that carry a recognised plate. End
    events fire once per object-track when Frigate has consolidated the
    best LPR readings across all frames — same data that shows up under
    "Recognized License Plate" in the Frigate UI.
    """
    try:
        payload = json.loads(msg.payload.decode())
    except json.JSONDecodeError:
        return

    if payload.get("type") != "end":
        return

    after = payload.get("after") or {}
    lpr = after.get("recognized_license_plate")
    # `recognized_license_plate` is a `[plate_string, confidence]` tuple,
    # or null on tracks where Frigate never read a plate (false positives,
    # secondary detections without LPR, etc.). Skip those.
    if not isinstance(lpr, list) or len(lpr) < 2 or not lpr[0]:
        return

    raw_plate, lpr_score = lpr[0], float(lpr[1] or 0)
    if lpr_score < MIN_SCORE:
        return

    plate = normalize_plate(raw_plate)
    # Keep Frigate's own formatting (it already emits the canonical dashed
    # plate, e.g. "GVF-57-G") so the dashboard can display that grouping
    # verbatim. `plate` stays the separator-stripped key for everything else.
    display_plate = raw_plate.strip().upper()
    event_id = after.get("id")
    camera = after.get("camera")
    # `sub_label` is Frigate's known-plate label, e.g. "Mieke Erwin" from
    # the `lpr.known_plates` block in Frigate config.
    name = after.get("sub_label")
    # Use Frigate's own start_time so the timeline reflects when the car
    # actually passed, not when this delayed end-event happened to arrive.
    start_time = after.get("start_time")
    seen_at = (
        datetime.fromtimestamp(float(start_time), tz=timezone.utc).isoformat()
        if start_time is not None
        else datetime.now(timezone.utc).isoformat()
    )

    with db() as conn:
        conn.execute(
            "INSERT INTO sightings"
            "(plate, seen_at, score, camera, name, frigate_event_id, raw_plate)"
            " VALUES(?,?,?,?,?,?,?)",
            (plate, seen_at, lpr_score, camera, name, event_id, display_plate),
        )
        conn.commit()
        log.info("Sighting: %s (LPR score %.2f, cam %s, name %r)",
                 plate, lpr_score, camera, name)
        ensure_vehicle(conn, plate)

    # Snapshot fetch outside the DB context — Frigate's HTTP API is its own
    # service; we don't want to hold the SQLite connection open during the call.
    if FRIGATE_URL and event_id:
        maybe_fetch_snapshot(plate, event_id)


def start_mqtt():
    client = mqtt.Client(
        client_id=MQTT_CLIENT_ID,
        clean_session=False,
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    )
    if MQTT_USER:
        client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.on_connect = on_connect
    client.on_message = on_message
    while True:
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
            break
        except Exception as e:
            log.warning("Waiting for MQTT broker (%s), retry in 5s", e)
            time.sleep(5)
    client.loop_start()  # non-blocking; runs on its own thread


# ---------------------------------------------------------------------------
# Bootstrap (shared by `python main.py` and uvicorn-imported runs)
# ---------------------------------------------------------------------------
#
# Two ways the app is launched:
#   1. ``python main.py``                       → main() takes over below
#   2. ``uvicorn main:app --reload``            → uvicorn imports `app` only
#
# Path #2 skips main() entirely, so the DB-migration and provider-load steps
# would never run in dev mode without this lifespan hook. Keeping the work
# idempotent (guarded by ``_bootstrapped``) lets main() call it inline too
# without a wasteful double-migration.

_bootstrapped = False


def _bootstrap() -> None:
    """Apply migrations, seed providers, load registry config. Idempotent."""
    global _bootstrapped, _PROVIDERS
    if _bootstrapped:
        return
    init_db()
    log.info("SQLite ready at %s", DB_PATH)
    seed_providers_if_empty()
    _PROVIDERS = load_providers()
    log.info("Vehicle-registry providers loaded: %s",
             [p["name"] for p in _PROVIDERS] or "<none>")
    _bootstrapped = True


@asynccontextmanager
async def _lifespan(_app):
    _bootstrap()
    yield


# ---------------------------------------------------------------------------
# HTTP-API
# ---------------------------------------------------------------------------
app = FastAPI(title="Frigate ANPR Logger", lifespan=_lifespan)


# ----- meta ---------------------------------------------------------------

@app.get("/health")
@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.get("/config")
def config():
    """Public runtime config the dashboard needs to render properly."""
    return {
        "frigate_public_url": FRIGATE_PUBLIC_URL,
        "page_size": PAGE_SIZE,
    }


# ----- existing read endpoints (stable contract) -------------------------

# Vehicle columns selected by /counts. Generated from VEHICLE_FIELDS so adding
# a column to that tuple automatically surfaces it in the API response without
# touching any SQL. Provider is appended explicitly because it's stored on the
# vehicles row but isn't part of the per-provider field map.
_COUNTS_VEHICLE_COLS = ", ".join(f"v.{c}" for c in (*VEHICLE_FIELDS, "provider"))

# Whitelist of columns the dashboard may sort by. Includes aggregate columns
# from the GROUP BY (plate, count, first_seen, last_seen) plus every vehicle
# field surfaced by the JOIN. Used to gate the dynamic ORDER BY against
# arbitrary user input.
_COUNTS_SORTABLE = {
    "plate", "count", "first_seen", "last_seen",
    *VEHICLE_FIELDS,
    "provider",
}


@app.get("/counts")
def counts(
    limit: int = Query(default=PAGE_SIZE, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    sort_by: str = Query(default="last_seen"),
    sort_dir: str = Query(default="desc"),
    q: str | None = Query(default=None),
    plate: str | None = Query(default=None),
):
    """Per-plate aggregate, paginated. Sort + search server-side.

    Response shape: ``{"total": <int>, "items": [<row>, ...]}``. ``total`` is
    the count of plates matching the filter — independent of ``limit``/``offset``
    — so the client can render page indicators.
    """
    if sort_by not in _COUNTS_SORTABLE:
        raise HTTPException(
            status_code=400,
            detail=f"sort_by must be one of: {sorted(_COUNTS_SORTABLE)}",
        )
    if sort_dir not in ("asc", "desc"):
        raise HTTPException(
            status_code=400,
            detail="sort_dir must be 'asc' or 'desc'",
        )

    # WHERE clauses. ``plate`` matches the normalised form (the canonical key);
    # ``q`` does a case-insensitive partial match against plate / make / model.
    where_clauses: list[str] = []
    args: list = []
    if plate:
        where_clauses.append("s.plate = ?")
        args.append(normalize_plate(plate))
    if q:
        # Plate is stored uppercased without separators — strip the same shape
        # off the query before LIKE'ing it, otherwise "AB-12-CD" never matches.
        plate_like = f"%{normalize_plate(q)}%"
        text_like = f"%{q}%"
        where_clauses.append(
            "(s.plate LIKE ? OR v.make LIKE ? COLLATE NOCASE OR v.model LIKE ? COLLATE NOCASE)"
        )
        args.extend([plate_like, text_like, text_like])
    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    # Aggregate columns (plate, count, first_seen, last_seen) are unqualified
    # in the SELECT; vehicle columns must be prefixed with `v.`.
    if sort_by in ("plate", "count", "first_seen", "last_seen"):
        order_col = sort_by
    else:
        order_col = f"v.{sort_by}"
    order_sql = f"ORDER BY {order_col} {sort_dir.upper()}"

    with db() as conn:
        # Total count of matching plates (groups) — needed for pagination UI.
        total = conn.execute(
            f"""
            SELECT COUNT(*) FROM (
                SELECT s.plate
                FROM sightings s
                LEFT JOIN vehicles v ON v.plate = s.plate
                {where_sql}
                GROUP BY s.plate
            )
            """,
            args,
        ).fetchone()[0]

        rows = conn.execute(
            f"""
            SELECT s.plate,
                   COUNT(*)        AS count,
                   MIN(s.seen_at)  AS first_seen,
                   MAX(s.seen_at)  AS last_seen,
                   {_COUNTS_VEHICLE_COLS},
                   (SELECT s2.frigate_event_id
                      FROM sightings s2
                     WHERE s2.plate = s.plate
                       AND s2.frigate_event_id IS NOT NULL
                     ORDER BY s2.seen_at DESC
                     LIMIT 1)      AS frigate_event_id,
                   (SELECT s3.raw_plate
                      FROM sightings s3
                     WHERE s3.plate = s.plate
                       AND s3.raw_plate IS NOT NULL
                     ORDER BY s3.seen_at DESC
                     LIMIT 1)      AS display_plate
            FROM sightings s
            LEFT JOIN vehicles v ON v.plate = s.plate
            {where_sql}
            GROUP BY s.plate
            {order_sql}
            LIMIT ? OFFSET ?
            """,
            args + [limit, offset],
        ).fetchall()

    items = [dict(r) for r in rows]
    # Annotate each row with whether we have a cached Frigate snapshot — lets
    # the dashboard show a thumbnail without firing a request per plate just
    # to discover a 404.
    for row in items:
        row["has_snapshot"] = _snapshot_path(row["plate"]).is_file()
    return {"total": total, "items": items}


@app.get("/timeline/{plate}")
def timeline(plate: str):
    """Every passage of a single plate, oldest first."""
    plate = normalize_plate(plate)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, seen_at, score, camera FROM sightings WHERE plate = ? ORDER BY seen_at ASC",
            (plate,),
        ).fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail="No sightings for this plate")
    return [dict(r) for r in rows]


# ----- providers (debug / introspection) ---------------------------------

@app.get("/providers")
def list_providers() -> list[dict]:
    """Loaded vehicle-registry providers in resolution order. Read-only.

    ``plate_format`` is the country-specific hyphenation hint the dashboard
    uses to render a plate prettily (e.g. NL sidecodes). Optional — providers
    without it just show plates as the cleaned uppercase form.
    """
    return [
        {
            "name": p["name"],
            "description": p.get("description"),
            "plate_match": p.get("plate_match"),
            "plate_format": p.get("plate_format"),
            "display": p.get("display"),
            "url": (p.get("request") or {}).get("url"),
        }
        for p in _PROVIDERS
    ]


# ----- sightings CRUD -----------------------------------------------------

# Whitelisted PATCH columns. New columns added to the model must be added
# here too — protects the dynamic SQL further down.
_PATCH_COLUMNS = {"plate", "seen_at", "score", "camera", "name"}

# Joined SELECT used by every endpoint that returns a sighting + its vehicle
# enrichment. Kept as a single SQL string so the response shape stays in
# sync across list/get/create/update.
_SIGHTING_SELECT = """
    SELECT s.id, s.plate, s.raw_plate, s.seen_at, s.score, s.camera, s.name,
           v.make, v.model, v.colour, v.year, v.provider
    FROM sightings s
    LEFT JOIN vehicles v ON v.plate = s.plate
"""


class SightingCreate(BaseModel):
    plate: str
    seen_at: datetime | None = None
    score: float | None = None
    camera: str | None = None
    name: str | None = None


class SightingUpdate(BaseModel):
    plate: str | None = None
    seen_at: datetime | None = None
    score: float | None = None
    camera: str | None = None
    name: str | None = None


def _iso_utc(dt: datetime | None) -> str:
    """Render a datetime as an ISO-8601 string in UTC (matches existing rows)."""
    if dt is None:
        return datetime.now(timezone.utc).isoformat()
    if dt.tzinfo is None:
        # Treat naive datetimes as UTC — safer than assuming local time.
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _fetch_sighting(conn, sighting_id: int) -> dict | None:
    row = conn.execute(
        _SIGHTING_SELECT + " WHERE s.id = ?", (sighting_id,)
    ).fetchone()
    return dict(row) if row else None


def _parse_range_bound(raw: str, field: str) -> str:
    """Parse a client ISO timestamp into the stored UTC-ISO comparison format.

    Round-tripping through ``_iso_utc`` guarantees the comparison string uses the
    same offset representation as the rows (``+00:00``), so SQLite's lexical
    string comparison stays chronologically correct. A trailing ``Z`` (what
    ``Date.toISOString()`` emits) is normalised since ``fromisoformat`` rejects
    it on older Pythons. Bad input is a client error, not a 500.
    """
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=422, detail=f"invalid {field} timestamp")
    return _iso_utc(dt)


@app.get("/sightings")
def list_sightings(
    limit: int = Query(default=200, ge=1, le=5000),
    plate: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
):
    """Flat list joined with vehicle info, newest first.

    Optional ``from``/``to`` ISO timestamps bound the result to a time window
    (used by the all-vehicles timeline view); omit both for the original
    newest-first behavior. The ``idx_sightings_seen`` index backs the range.
    """
    conditions: list[str] = []
    args: list = []
    if plate:
        conditions.append("s.plate = ?")
        args.append(normalize_plate(plate))
    if from_:
        conditions.append("s.seen_at >= ?")
        args.append(_parse_range_bound(from_, "from"))
    if to:
        conditions.append("s.seen_at <= ?")
        args.append(_parse_range_bound(to, "to"))
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    args.append(limit)
    sql = f"{_SIGHTING_SELECT} {where} ORDER BY s.seen_at DESC LIMIT ?"
    with db() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


@app.get("/sightings/{sighting_id}")
def get_sighting(sighting_id: int):
    with db() as conn:
        row = _fetch_sighting(conn, sighting_id)
    if row is None:
        raise HTTPException(status_code=404, detail="sighting not found")
    return row


@app.post("/sightings", status_code=201)
def create_sighting(body: SightingCreate):
    plate = normalize_plate(body.plate)
    if not plate:
        raise HTTPException(status_code=400, detail="plate is required")
    seen_at = _iso_utc(body.seen_at)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO sightings(plate, seen_at, score, camera, name) VALUES(?,?,?,?,?)",
            (plate, seen_at, body.score, body.camera, body.name),
        )
        conn.commit()
        ensure_vehicle(conn, plate)
        return _fetch_sighting(conn, cur.lastrowid)


@app.patch("/sightings/{sighting_id}")
def update_sighting(sighting_id: int, body: SightingUpdate):
    updates = body.model_dump(exclude_unset=True)

    if "plate" in updates and updates["plate"] is not None:
        normalized = normalize_plate(updates["plate"])
        if not normalized:
            raise HTTPException(status_code=400, detail="plate may not be empty")
        updates["plate"] = normalized

    if "seen_at" in updates and updates["seen_at"] is not None:
        updates["seen_at"] = _iso_utc(updates["seen_at"])

    # Whitelist guard: even though Pydantic constrains the keys, do not feed
    # arbitrary names into the dynamic SQL below.
    unknown = set(updates) - _PATCH_COLUMNS
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown fields: {sorted(unknown)}")

    with db() as conn:
        existing = conn.execute(
            "SELECT plate FROM sightings WHERE id = ?", (sighting_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="sighting not found")

        if updates:
            cols = ", ".join(f"{k} = ?" for k in updates)
            args = list(updates.values()) + [sighting_id]
            conn.execute(f"UPDATE sightings SET {cols} WHERE id = ?", args)
            conn.commit()

            # If the plate changed, refetch vehicle data for the new plate. Do NOT
            # delete the old vehicle row: other sightings might still point
            # at it, so it's left as a (potentially orphaned) record that can
            # be cleaned up manually via DELETE /vehicles/{plate}.
            new_plate = updates.get("plate")
            if new_plate and new_plate != existing["plate"]:
                ensure_vehicle(conn, new_plate, force=True)

        return _fetch_sighting(conn, sighting_id)


@app.delete("/sightings/{sighting_id}", status_code=204, response_class=Response)
def delete_sighting(sighting_id: int):
    with db() as conn:
        existing = conn.execute(
            "SELECT 1 FROM sightings WHERE id = ?", (sighting_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="sighting not found")
        conn.execute("DELETE FROM sightings WHERE id = ?", (sighting_id,))
        conn.commit()
    return Response(status_code=204)


# ----- plates (bulk rename / merge) --------------------------------------

class PlateRename(BaseModel):
    to: str


@app.post("/plates/{plate}/rename")
def rename_plate(plate: str, body: PlateRename):
    """Rename a plate across *all* its sightings, merging into the target if it
    already exists.

    The bulk counterpart to ``PATCH /sightings/{id}`` (which retargets a single
    sighting). The dashboard's "Edit plate" action calls this so a correction
    is one atomic request instead of N per-sighting PATCHes. In one shot it:

    - moves every sighting from ``plate`` to ``to`` (a single UPDATE; if ``to``
      already has sightings they now share a timeline — that's the merge),
    - drops the source's now-orphaned ``vehicles`` row,
    - lets the cached Frigate snapshot follow the plate,
    - re-fetches the destination's vehicle data once from the registry
      (``force=True``) — the "sync with providers" step.

    The sighting move + orphan cleanup run in one transaction so a crash can't
    leave a half-renamed plate. Response: ``{plate, moved, merged}`` where
    ``merged`` reports whether the destination already existed.
    """
    src = normalize_plate(plate)
    dst = normalize_plate(body.to)
    if not dst:
        raise HTTPException(status_code=400, detail="target plate may not be empty")

    with db() as conn:
        moved = conn.execute(
            "SELECT COUNT(*) FROM sightings WHERE plate = ?", (src,)
        ).fetchone()[0]
        if moved == 0:
            raise HTTPException(status_code=404, detail="no sightings for this plate")

        if src == dst:
            # Normalises to the same plate (e.g. only hyphenation changed) —
            # nothing to move. Report a consistent, no-op shape.
            return {"plate": dst, "moved": 0, "merged": False}

        merged = conn.execute(
            "SELECT 1 FROM sightings WHERE plate = ? LIMIT 1", (dst,)
        ).fetchone() is not None

        conn.execute("UPDATE sightings SET plate = ? WHERE plate = ?", (dst, src))
        conn.execute("DELETE FROM vehicles WHERE plate = ?", (src,))
        conn.commit()

        # Snapshot follows the plate (no-op when the target already had one).
        migrate_snapshot(src, dst)

        # One authoritative registry lookup for the destination, replacing any
        # stale/empty cached row.
        ensure_vehicle(conn, dst, force=True)

    log.info("Renamed plate %s -> %s (%d sightings, merged=%s)", src, dst, moved, merged)
    return {"plate": dst, "moved": moved, "merged": merged}


# ----- vehicles -----------------------------------------------------------

@app.get("/vehicles/{plate}")
def get_vehicle(plate: str):
    plate = normalize_plate(plate)
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM vehicles WHERE plate = ?", (plate,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="vehicle not found")
    return dict(row)


@app.get("/vehicles/{plate}/snapshot")
def get_vehicle_snapshot(plate: str):
    """Serve the cached Frigate snapshot for this plate, or 404."""
    plate = normalize_plate(plate)
    path = _snapshot_path(plate)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no snapshot for this plate")
    return FileResponse(path, media_type="image/jpeg")


@app.post("/vehicles/{plate}/refresh")
def refresh_vehicle(plate: str, provider: str | None = Query(default=None)):
    """Force a fresh provider lookup, overwriting any cached row for this plate.

    Without ``?provider=`` the regex-based provider selection runs as normal.
    With an explicit provider name the lookup is forced to that provider
    regardless of its ``plate_match`` regex — useful when the operator picks
    a non-default registry from the UI to re-pull data after a schema change.
    """
    plate = normalize_plate(plate)
    if not plate:
        raise HTTPException(status_code=400, detail="plate is required")

    provider_dict: dict | None = None
    if provider is not None:
        provider_dict = next((p for p in _PROVIDERS if p["name"] == provider), None)
        if provider_dict is None:
            raise HTTPException(status_code=404, detail=f"Unknown provider: {provider}")

    with db() as conn:
        ensure_vehicle(conn, plate, force=True, provider=provider_dict)
        row = conn.execute(
            "SELECT * FROM vehicles WHERE plate = ?", (plate,)
        ).fetchone()
    # ensure_vehicle always inserts at least a (plate, fetched_at) row, so
    # `row` is never None here. A NULL `make` means the provider had no data.
    if row is None or row["make"] is None:
        raise HTTPException(
            status_code=404,
            detail=f"No vehicle data available for plate {plate}",
        )
    return dict(row)


@app.delete("/vehicles/{plate}", status_code=204, response_class=Response)
def delete_vehicle(plate: str):
    plate = normalize_plate(plate)
    with db() as conn:
        existing = conn.execute(
            "SELECT 1 FROM vehicles WHERE plate = ?", (plate,)
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="vehicle not found")
        conn.execute("DELETE FROM vehicles WHERE plate = ?", (plate,))
        conn.commit()
    return Response(status_code=204)


# ----- frontend dashboard ------------------------------------------------

# Locate the frontend dashboard:
#   - Docker image: main.py and frontend/ are siblings under /app/.
#   - Repo dev:     main.py lives in backend/, frontend/ at the repo root.
# Pick the first candidate that exists; if neither does, skip the mount and
# the API still works for headless use.
_FRONTEND_DIR = next(
    (
        p
        for p in (
            Path(__file__).parent / "frontend",         # Docker image layout
            Path(__file__).parent.parent / "frontend",  # repo dev layout
        )
        if p.is_dir()
    ),
    None,
)
if _FRONTEND_DIR is not None:
    @app.get("/", include_in_schema=False)
    def _root():
        return RedirectResponse(url="/ui/", status_code=307)

    app.mount("/ui", StaticFiles(directory=_FRONTEND_DIR, html=True), name="ui")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    # Bootstrap synchronously so MQTT callbacks (which hit the DB) never see
    # an unmigrated schema. uvicorn.run() below will fire the lifespan event
    # too, but _bootstrap() is idempotent — the second call is a no-op.
    _bootstrap()
    start_mqtt()
    log.info("API starting on port %s", API_PORT)
    uvicorn.run(app, host="0.0.0.0", port=API_PORT, log_level="warning")


if __name__ == "__main__":
    main()
