#!/usr/bin/env python3
"""check-sync — diagnose ingestion drift between Frigate and our database.

Frigate publishes ``frigate/events`` at QoS 0, so any recognised-plate event
that arrives while the backend is disconnected (deploy, crash, broker blip) is
dropped from the MQTT stream — but it still sits in Frigate's own DB. The HTTP
reconciler (``reconcile_once`` in ``backend/main.py``) heals that by backfilling
from Frigate's API. This script runs the *same* comparison read-only: it tells
you whether the two stores agree, and exactly which events we're missing, so you
can confirm the reconciler is keeping up (or catch a gap it can't reach because
it's older than the lookback window).

It writes nothing. To actually backfill, let the running backend's reconciler
sweep, or POST the events in — this tool only reports.

Config (env, same names the backend uses)::

    FRIGATE_URL             Frigate HTTP API base, e.g. http://frigate:5000 (required)
    DB_PATH                 SQLite file (default ./data/anpr.db, the host bind-mount)
    MIN_SCORE               LPR score below which the backend drops events (default 0.8)
    RECONCILE_LOOKBACK_HOURS  How far back to compare (default 48)

Example — local DB against a remote Frigate::

    FRIGATE_URL=http://192.168.2.250:5000 python3 scripts/check-sync.py

Stdlib only — no external deps, no installation step.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

FRIGATE_URL = os.getenv("FRIGATE_URL", "").rstrip("/")
# Default to the host bind-mount (./data/anpr.db). Inside the container the DB
# is at /data/anpr.db — set DB_PATH explicitly there. This script is normally
# run locally against a remote Frigate, so the host path is the friendlier default.
DB_PATH = os.getenv("DB_PATH", "./data/anpr.db")
MIN_SCORE = float(os.getenv("MIN_SCORE", "0.8"))
LOOKBACK = float(os.getenv("RECONCILE_LOOKBACK_HOURS", "48")) * 3600
# Mirror reconcile_once()'s API page size so we compare over the same window
# the reconciler actually sees — a smaller cap here would invent false "gaps".
API_LIMIT = 200
TIMEOUT = float(os.getenv("SNAPSHOT_TIMEOUT", "5"))


def fmt_epoch(ts: float | None) -> str:
    """Frigate epoch seconds → readable local time (host tz, DST-correct)."""
    if ts is None:
        return "-"
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).astimezone().strftime(
        "%d-%m-%Y %H:%M:%S"
    )


def fetch_frigate_events() -> list[dict]:
    """Pull recent ``car`` events from Frigate — the exact query the reconciler uses."""
    after = time.time() - LOOKBACK
    url = (
        f"{FRIGATE_URL}/api/events"
        f"?label=car&include_thumbnails=0&limit={API_LIMIT}&after={after:.0f}"
    )
    with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())


def load_stored_event_ids() -> set[str]:
    """Frigate event ids we already have, within the lookback window.

    Sightings store ``seen_at`` as ISO-UTC (Frigate's own start_time), so we
    bound on that to compare like-for-like with the API window. Rows without a
    ``frigate_event_id`` (manual POST, pre-migration data) can't be matched and
    are excluded — they're surfaced separately as an untraceable count.
    """
    cutoff = datetime.fromtimestamp(
        time.time() - LOOKBACK, tz=timezone.utc
    ).isoformat()
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        rows = conn.execute(
            "SELECT frigate_event_id FROM sightings"
            " WHERE seen_at >= ? AND frigate_event_id IS NOT NULL",
            (cutoff,),
        ).fetchall()
        untraceable = conn.execute(
            "SELECT COUNT(*) FROM sightings"
            " WHERE seen_at >= ? AND frigate_event_id IS NULL",
            (cutoff,),
        ).fetchone()[0]
    finally:
        conn.close()
    return {r[0] for r in rows}, untraceable


def classify(events: list[dict], stored: set[str]) -> dict:
    """Split Frigate's recognised-plate events into stored / missing / below-threshold.

    Mirrors ``record_sighting``'s accept rule: an event only *should* be in our
    DB if it has a recognised plate AND its score clears MIN_SCORE. Events below
    the threshold that we lack aren't gaps — the backend would drop them too — so
    they're reported separately from genuine misses.
    """
    recognised = []
    for e in events:
        data = e.get("data") or {}
        plate = data.get("recognized_license_plate")
        if not plate:
            continue  # no plate → never a sighting; ignore (e.g. car w/o readable plate)
        recognised.append(
            {
                "id": e.get("id"),
                "plate": plate,
                "score": float(data.get("recognized_license_plate_score") or 0),
                "camera": e.get("camera"),
                "start_time": e.get("start_time"),
            }
        )

    matched, missing, below = [], [], []
    for ev in recognised:
        if ev["id"] in stored:
            matched.append(ev)
        elif ev["score"] < MIN_SCORE:
            below.append(ev)
        else:
            missing.append(ev)
    return {
        "recognised": recognised,
        "matched": matched,
        "missing": missing,
        "below": below,
    }


def print_event_table(title: str, events: list[dict]) -> None:
    if not events:
        return
    print(f"\n{title} ({len(events)}):")
    print(f"  {'When':<20}  {'Score':>6}  {'Camera':<14}  {'Plate':<10}  Event")
    for ev in sorted(events, key=lambda e: e["start_time"] or 0):
        print(
            f"  {fmt_epoch(ev['start_time']):<20}  "
            f"{ev['score'] * 100:>5.0f}%  "
            f"{(ev['camera'] or '-'):<14}  "
            f"{ev['plate']:<10}  {ev['id']}"
        )


def main() -> int:
    if not FRIGATE_URL:
        print("FRIGATE_URL is unset — nothing to compare against. Set it to your "
              "Frigate HTTP API base, e.g. FRIGATE_URL=http://frigate:5000", file=sys.stderr)
        return 2
    if not os.path.exists(DB_PATH):
        print(f"DB not found at {DB_PATH!r}. Set DB_PATH to your SQLite file "
              "(default ./data/anpr.db).", file=sys.stderr)
        return 2

    print(f"Comparing Frigate {FRIGATE_URL} ↔ {DB_PATH}")
    print(f"Window: last {LOOKBACK / 3600:.0f}h   MIN_SCORE: {MIN_SCORE:.2f}")

    try:
        events = fetch_frigate_events()
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"\nCould not reach Frigate API: {e}", file=sys.stderr)
        return 1

    stored, untraceable = load_stored_event_ids()
    c = classify(events, stored)

    expected = len(c["matched"]) + len(c["missing"])  # plates we *should* have
    coverage = (len(c["matched"]) / expected * 100) if expected else 100.0

    print("\n" + "=" * 60)
    print("SYNC REPORT")
    print("=" * 60)
    print(f"  Frigate car events in window     {len(events)}")
    print(f"  …with a recognised plate         {len(c['recognised'])}")
    print(f"  …above MIN_SCORE (should store)  {expected}")
    print(f"  Stored (matched by event id)     {len(c['matched'])}")
    print(f"  MISSING (real gap)               {len(c['missing'])}")
    print(f"  Below threshold, correctly absent {len(c['below'])}")
    print(f"  Local rows without event id       {untraceable}")
    print(f"\n  Coverage: {coverage:.1f}%  ({len(c['matched'])}/{expected})")

    if c["missing"]:
        print("\n⚠  Gaps found — events Frigate recognised that we never stored.")
        if len(events) >= API_LIMIT:
            print(f"   (Frigate returned the full {API_LIMIT}-event page; older "
                  "events may exist beyond this window.)")
        print_event_table("MISSING sightings", c["missing"])
        print("\n  The running backend's reconciler should backfill these within one "
              f"sweep, as long as they're inside its {LOOKBACK / 3600:.0f}h lookback. "
              "If they persist, check the reconciler is enabled (FRIGATE_URL set) and "
              "the gap isn't older than RECONCILE_LOOKBACK_HOURS.")
    else:
        print("\n✓  In sync — every recognised plate above MIN_SCORE is stored.")

    # Detail on correctly-skipped low-score events only when asked, to keep the
    # default output focused on actionable drift.
    if "-v" in sys.argv[1:] or "--verbose" in sys.argv[1:]:
        print_event_table("Below MIN_SCORE (correctly not stored)", c["below"])

    return 1 if c["missing"] else 0


if __name__ == "__main__":
    sys.exit(main())
