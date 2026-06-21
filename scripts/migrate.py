#!/usr/bin/env python3
"""
SQLite schema migrations for frigate-anpr-logger.

Each migration is a ``(version, description, fn)`` tuple in ``MIGRATIONS``.
The runner reads ``PRAGMA user_version`` from the target DB and applies any
migration whose version is higher than the stored one, in order, bumping the
stored version after each step. Wrapped in transactions so a failure leaves
the DB at the last-good version.

Run standalone (DB path is required)::

    python scripts/migrate.py /path/to/anpr.db
    python scripts/migrate.py --status /path/to/anpr.db    # read-only

Adding a new migration
----------------------

1. Write a function ``def _m<N>_<slug>(conn): ...`` that mutates the DB
   without committing (the runner commits per migration).
2. Append ``(N, "short description", _m<N>_<slug>)`` to ``MIGRATIONS``.
3. Never edit a past migration — they're history. If you got it wrong,
   write a new one that fixes it.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Migrations
# ---------------------------------------------------------------------------


def _m1_initial_schema(conn: sqlite3.Connection) -> None:
    """Create the modern schema (English column names) from scratch."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sightings (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            plate   TEXT NOT NULL,
            seen_at TEXT NOT NULL,
            score   REAL,
            camera  TEXT,
            name    TEXT
        );
        CREATE TABLE IF NOT EXISTS vehicles (
            plate           TEXT PRIMARY KEY,
            make            TEXT,
            model           TEXT,
            colour          TEXT,
            body_type       TEXT,
            year            TEXT,
            fuel            TEXT,
            inspection_due  TEXT,
            provider        TEXT,
            raw_json        TEXT,
            fetched_at      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sightings_plate ON sightings(plate);
        CREATE INDEX IF NOT EXISTS idx_sightings_seen  ON sightings(seen_at);
    """)


def _m2_extra_vehicle_fields(conn: sqlite3.Connection) -> None:
    """Materialise the long-tail RDW fields we now extract.

    All-nullable TEXT — existing rows stay valid and are refreshed lazily on
    the next provider lookup. Idempotent against partial application because
    each ALTER is gated on the column not already existing (handles a DB that
    was hand-patched between releases).
    """
    new_columns = (
        "catalog_price",
        "insured",
        "recall_open",
        "is_taxi",
        "body_style",
        "owner_since",
        "efficiency_label",
        "colour_secondary",
        "engine_cc",
        "seats",
        "doors",
        "mass_kg",
        "power_to_weight",
        "length_cm",
        "width_cm",
    )
    existing = {row[1] for row in conn.execute("PRAGMA table_info(vehicles)")}
    for col in new_columns:
        if col in existing:
            continue
        conn.execute(f"ALTER TABLE vehicles ADD COLUMN {col} TEXT")


def _m3_sighting_frigate_event_id(conn: sqlite3.Connection) -> None:
    """Persist Frigate's event id per sighting so the dashboard can deep-link
    into Frigate's tracked-object detail view. Nullable — existing rows and
    sightings from sources without an event id (manual POST, healing) stay NULL.
    """
    existing = {row[1] for row in conn.execute("PRAGMA table_info(sightings)")}
    if "frigate_event_id" not in existing:
        conn.execute("ALTER TABLE sightings ADD COLUMN frigate_event_id TEXT")


def _m4_sighting_raw_plate(conn: sqlite3.Connection) -> None:
    """Persist the plate string exactly as the source delivered it.

    Frigate's LPR already emits the canonical dashed form (e.g. ``"GVF-57-G"``),
    which we otherwise throw away in ``normalize_plate``. Keeping it lets the
    dashboard show that grouping verbatim instead of re-deriving dashes from the
    sidecode rules — which matters for foreign plates and OCR mis-groupings the
    sidecodes don't match. Nullable: existing rows and sources without a raw
    form (manual POST, healing) stay NULL and fall back to sidecode formatting.
    """
    existing = {row[1] for row in conn.execute("PRAGMA table_info(sightings)")}
    if "raw_plate" not in existing:
        conn.execute("ALTER TABLE sightings ADD COLUMN raw_plate TEXT")


def _m5_unique_frigate_event_id(conn: sqlite3.Connection) -> None:
    """Make ``frigate_event_id`` unique so ingestion can be idempotent.

    Two writers now insert sightings — the MQTT listener and the HTTP
    reconciler that backfills events MQTT missed (Frigate publishes
    ``frigate/events`` at QoS 0, so nothing is redelivered after a
    disconnect). Both must converge on one row per Frigate event, which an
    ``INSERT … ON CONFLICT(frigate_event_id) DO NOTHING`` gives us — but only
    once a UNIQUE index exists as the conflict target.

    Pre-existing duplicate event ids (from MQTT redelivery of the same end
    event before this guard existed) would block the index, so collapse them
    first, keeping the earliest row. NULL event ids (manual POST, OCR healing)
    stay exempt: SQLite treats NULLs as distinct, so any number coexist.
    """
    conn.execute(
        """
        DELETE FROM sightings
        WHERE frigate_event_id IS NOT NULL
          AND id NOT IN (
              SELECT MIN(id) FROM sightings
              WHERE frigate_event_id IS NOT NULL
              GROUP BY frigate_event_id
          )
        """
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sightings_event_id "
        "ON sightings(frigate_event_id)"
    )


MIGRATIONS: list[tuple[int, str, callable]] = [
    (1, "initial schema (sightings + vehicles + indexes)", _m1_initial_schema),
    (2, "extra RDW vehicle fields (price, recall, dimensions, …)", _m2_extra_vehicle_fields),
    (3, "sighting frigate event id", _m3_sighting_frigate_event_id),
    (4, "sighting raw (source-formatted) plate for display", _m4_sighting_raw_plate),
    (5, "unique frigate_event_id (idempotent ingestion + reconciler)", _m5_unique_frigate_event_id),
]

LATEST_VERSION = MIGRATIONS[-1][0] if MIGRATIONS else 0


# ---------------------------------------------------------------------------
# Legacy bootstrap (pre-versioning DBs)
# ---------------------------------------------------------------------------
#
# Two kinds of DB exist in the wild that don't yet have a user_version stamp:
#
#   1. Genuinely legacy: Dutch column names (merk, handelsbenaming, …),
#      created before the provider refactor.
#   2. Post-rename English schema created by an intermediate version of the
#      code that did the rename inline but never wrote user_version.
#
# Both look "fresh" to a naive runner (user_version == 0). This bootstrap
# detects them from the schema and fast-forwards user_version to 1 (renaming
# Dutch columns if needed) so the regular migration loop above can take it
# from there cleanly.

_LEGACY_RENAMES: tuple[tuple[str, str], ...] = (
    ("merk", "make"),
    ("handelsbenaming", "model"),
    ("kleur", "colour"),
    ("voertuigsoort", "body_type"),
    ("bouwjaar", "year"),
    ("brandstof", "fuel"),
    ("apk_vervaldatum", "inspection_due"),
)


def _bootstrap_legacy(conn: sqlite3.Connection) -> bool:
    """Fast-forward an unstamped pre-existing DB to version 1.

    Returns True if a bootstrap was applied (caller should then bump
    user_version), False if there was nothing to do.
    """
    has_vehicles = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vehicles'"
    ).fetchone() is not None
    if not has_vehicles:
        return False

    cols = {row[1] for row in conn.execute("PRAGMA table_info(vehicles)")}

    if "merk" in cols:
        print("[migrate] legacy Dutch schema detected; renaming columns")
        for old, new in _LEGACY_RENAMES:
            if old in cols and new not in cols:
                conn.execute(f"ALTER TABLE vehicles RENAME COLUMN {old} TO {new}")
                cols.discard(old)
                cols.add(new)
                print(f"[migrate]   renamed vehicles.{old} -> vehicles.{new}")
        if "provider" not in cols:
            conn.execute("ALTER TABLE vehicles ADD COLUMN provider TEXT")
            print("[migrate]   added vehicles.provider")
        return True

    if "make" in cols:
        # Already on the English schema but never stamped.
        print("[migrate] existing English schema detected; stamping as v1")
        if "provider" not in cols:
            conn.execute("ALTER TABLE vehicles ADD COLUMN provider TEXT")
            print("[migrate]   added vehicles.provider")
        return True

    return False


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def _current_version(conn: sqlite3.Connection) -> int:
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def _set_version(conn: sqlite3.Connection, version: int) -> None:
    # PRAGMA can't be parameterised; cast to int makes this safe.
    conn.execute(f"PRAGMA user_version = {int(version)}")


def migrate(db_path: str | Path) -> int:
    """Apply pending migrations to the SQLite file at ``db_path``.

    Returns the resulting schema version. Idempotent: running it twice on a
    DB that's already up-to-date is a no-op.
    """
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    try:
        starting = _current_version(conn)

        if starting == 0 and _bootstrap_legacy(conn):
            _set_version(conn, 1)
            conn.commit()

        for version, description, fn in MIGRATIONS:
            if version <= _current_version(conn):
                continue
            print(f"[migrate] applying #{version}: {description}")
            fn(conn)
            _set_version(conn, version)
            conn.commit()

        final = _current_version(conn)
        if final == starting:
            print(f"[migrate] {db_path} already at version {final}")
        else:
            print(f"[migrate] {db_path}: {starting} -> {final}")
        return final
    finally:
        conn.close()


def status(db_path: str | Path) -> tuple[int, int]:
    """Return (current_version, latest_version) without modifying the DB."""
    db_path = Path(db_path)
    if not db_path.exists():
        return (0, LATEST_VERSION)
    conn = sqlite3.connect(db_path, timeout=10)
    try:
        return (_current_version(conn), LATEST_VERSION)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


_USAGE = (
    "usage: migrate.py [--status] DB_PATH\n"
    "  DB_PATH    path to the SQLite file to migrate (required)\n"
    "  --status   read-only: print current vs latest version, no migration\n"
)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    if argv and argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    show_status = False
    if argv and argv[0] in ("-s", "--status"):
        show_status = True
        argv.pop(0)

    if not argv:
        sys.stderr.write(_USAGE)
        return 2

    db_path = argv[0]

    if show_status:
        current, latest = status(db_path)
        print(f"{db_path}: current=v{current} latest=v{latest}")
        return 0

    migrate(db_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
