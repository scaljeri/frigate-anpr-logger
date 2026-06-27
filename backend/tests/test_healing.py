"""Tests for OCR-confusable healing: variant generation, DB matching, and the
automatic merge-on-unfound path in ``ensure_vehicle`` (plus a regression for the
``rename_plate`` refactor that now shares ``merge_plate_into``).

Run from the backend dir:  uv run python -m pytest
"""
import sqlite3
import sys
from pathlib import Path

import pytest

# ``python -m pytest`` puts the backend dir (cwd) on sys.path, so this imports
# the app module. The migration runner is added to sys.path by main.py itself.
import main
from migrate import migrate


@pytest.fixture
def conn(tmp_path):
    """A migrated, empty SQLite DB with a Row factory, like the app uses."""
    db_path = tmp_path / "anpr.db"
    migrate(db_path)
    c = sqlite3.connect(db_path)
    c.row_factory = sqlite3.Row
    yield c
    c.close()


def _seed_vehicle(conn, plate, *, confirmed):
    """Insert a vehicles row. ``confirmed`` rows carry raw_json (real registry
    data); otherwise it's a negative-cache row (plate/provider/fetched_at only)."""
    if confirmed:
        conn.execute(
            "INSERT INTO vehicles(plate, make, raw_json, provider, fetched_at) "
            "VALUES(?, 'Volvo', '{\"merk\": \"Volvo\"}', 'nl', '2026-01-01T00:00:00Z')",
            (plate,),
        )
    else:
        conn.execute(
            "INSERT INTO vehicles(plate, provider, fetched_at) "
            "VALUES(?, 'nl', '2026-01-01T00:00:00Z')",
            (plate,),
        )
    conn.commit()


def _seed_sighting(conn, plate):
    conn.execute(
        "INSERT INTO sightings(plate, seen_at) VALUES(?, '2026-06-27T08:00:00Z')",
        (plate,),
    )
    conn.commit()


# --------------------------------------------------------------------------- #
# _confusable_variants
# --------------------------------------------------------------------------- #

def test_variants_cover_each_confusable_position():
    # GN3757: confusables are G, 5, and two 7s -> four single-swap variants.
    variants = set(main._confusable_variants("GN3757"))
    assert "GN375Z" in variants          # swap the trailing 7 (idx 5) -> Z (real plate)
    assert "GN3Z57" in variants          # swap the middle 7 (idx 3) -> Z
    assert "5N3757" in variants          # swap G (idx 0) -> 5
    assert "GN37G7" in variants          # swap 5 (idx 4) -> G
    assert "GN3757" not in variants      # never the input itself


def test_variants_deduplicated_and_empty_when_no_confusables():
    assert main._confusable_variants("XY1234"[:0] + "XYABCD") == []  # no confusables
    # "77" -> swapping either 7 yields "Z7" or "7Z" (distinct), no dupes.
    assert sorted(main._confusable_variants("77")) == ["7Z", "Z7"]


# --------------------------------------------------------------------------- #
# find_confusable_match
# --------------------------------------------------------------------------- #

def test_match_single_confirmed(conn):
    _seed_vehicle(conn, "GN375Z", confirmed=True)
    assert main.find_confusable_match(conn, "GN3757") == "GN375Z"


def test_no_match_when_only_negative_cache(conn):
    # The variant exists in the cache but has no registry data -> not a match.
    _seed_vehicle(conn, "GN375Z", confirmed=False)
    assert main.find_confusable_match(conn, "GN3757") is None


def test_no_match_when_variant_absent(conn):
    assert main.find_confusable_match(conn, "GN3757") is None


def test_ambiguous_match_refused(conn):
    # Two distinct confirmed plates each one confusable away -> refuse.
    _seed_vehicle(conn, "GN375Z", confirmed=True)   # swap trailing 7
    _seed_vehicle(conn, "5N3757", confirmed=True)   # swap G
    assert main.find_confusable_match(conn, "GN3757") is None


# --------------------------------------------------------------------------- #
# ensure_vehicle: automatic merge when the registry doesn't know the plate
# --------------------------------------------------------------------------- #

def test_ensure_vehicle_merges_misread_into_known_plate(conn, monkeypatch):
    # Registry never resolves the misread.
    monkeypatch.setattr(main, "fetch_vehicle", lambda plate, provider: None)
    monkeypatch.setattr(main, "migrate_snapshot", lambda src, dst: None)

    _seed_vehicle(conn, "GN375Z", confirmed=True)   # the real, known plate
    _seed_sighting(conn, "GN3757")                  # a misread sighting

    main.ensure_vehicle(conn, "GN3757", provider={"name": "nl"})

    # Sighting moved onto the real plate; none left under the misread.
    assert conn.execute(
        "SELECT COUNT(*) FROM sightings WHERE plate = 'GN375Z'"
    ).fetchone()[0] == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM sightings WHERE plate = 'GN3757'"
    ).fetchone()[0] == 0
    # No negative-cache row was written for the misread (so a future sighting
    # re-attempts and re-merges rather than being suppressed by the cache gate).
    assert conn.execute(
        "SELECT COUNT(*) FROM vehicles WHERE plate = 'GN3757'"
    ).fetchone()[0] == 0


def test_ensure_vehicle_negative_caches_when_no_match(conn, monkeypatch):
    monkeypatch.setattr(main, "fetch_vehicle", lambda plate, provider: None)
    _seed_sighting(conn, "GN3757")

    main.ensure_vehicle(conn, "GN3757", provider={"name": "nl"})

    # No known plate to merge into -> falls through to the negative cache.
    row = conn.execute(
        "SELECT raw_json FROM vehicles WHERE plate = 'GN3757'"
    ).fetchone()
    assert row is not None
    assert row["raw_json"] is None


# --------------------------------------------------------------------------- #
# rename_plate regression (shares merge_plate_into after the refactor)
# --------------------------------------------------------------------------- #

def test_rename_plate_merges_via_shared_helper(tmp_path, monkeypatch):
    db_path = tmp_path / "anpr.db"
    migrate(db_path)
    monkeypatch.setattr(main, "DB_PATH", str(db_path))
    monkeypatch.setattr(main, "fetch_vehicle", lambda plate, provider: None)
    monkeypatch.setattr(main, "migrate_snapshot", lambda src, dst: None)
    monkeypatch.setattr(main, "select_provider", lambda plate: {"name": "nl"})

    c = sqlite3.connect(db_path)
    c.execute("INSERT INTO sightings(plate, seen_at) VALUES('AB123C', '2026-06-27T08:00:00Z')")
    c.execute("INSERT INTO sightings(plate, seen_at) VALUES('AB123C', '2026-06-27T09:00:00Z')")
    c.execute("INSERT INTO sightings(plate, seen_at) VALUES('XY999Z', '2026-06-27T07:00:00Z')")
    c.execute("INSERT INTO vehicles(plate, provider, fetched_at) VALUES('AB123C', 'nl', '2026-01-01T00:00:00Z')")
    c.commit()
    c.close()

    result = main.rename_plate("AB123C", main.PlateRename(to="XY999Z"))

    assert result == {"plate": "XY999Z", "moved": 2, "merged": True}

    c = sqlite3.connect(db_path)
    # All three sightings now share the destination plate.
    assert c.execute("SELECT COUNT(*) FROM sightings WHERE plate = 'XY999Z'").fetchone()[0] == 3
    assert c.execute("SELECT COUNT(*) FROM sightings WHERE plate = 'AB123C'").fetchone()[0] == 0
    # Source vehicle row dropped.
    assert c.execute("SELECT COUNT(*) FROM vehicles WHERE plate = 'AB123C'").fetchone()[0] == 0
    c.close()
