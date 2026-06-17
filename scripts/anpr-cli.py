#!/usr/bin/env python3
"""anpr-cli — minimal terminal companion to the anpr HTTP API.

Two modes:

    # Overview of all unique plates with counts and vehicle info.
    anpr-cli.py

    # Per-plate timeline (every passage, oldest first).
    anpr-cli.py 12ABC3

The API base URL is taken from ``$API_URL`` (default ``http://localhost:8080``)
so the same script works against a local container and a remote install::

    API_URL=http://anpr.example.com:8090 anpr-cli.py

Stdlib only — no external deps, no installation step. Drop the file on PATH
or call it directly with ``python3 scripts/anpr-cli.py``.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime

API_URL = os.getenv("API_URL", "http://localhost:8080").rstrip("/")


def get(path: str):
    """GET ``$API_URL{path}`` and return the parsed JSON body."""
    with urllib.request.urlopen(f"{API_URL}{path}", timeout=10) as resp:
        return json.loads(resp.read().decode())


def fmt_time(iso: str) -> str:
    """ISO-UTC timestamp → readable local time (host timezone, DST-correct)."""
    return datetime.fromisoformat(iso).astimezone().strftime("%d-%m-%Y %H:%M:%S")


def print_table(rows: list[dict], columns: list[tuple[str, str]]) -> None:
    """Render ``rows`` as a padded text table.

    ``columns`` is a list of ``(row_key, header_label)`` pairs in display order.
    Missing/None values render as ``-``.
    """
    headers = [label for _, label in columns]
    keys = [key for key, _ in columns]
    widths = [len(h) for h in headers]

    cells: list[list[str]] = []
    for row in rows:
        line = [str(row[k]) if row.get(k) not in (None, "") else "-" for k in keys]
        cells.append(line)
        for i, val in enumerate(line):
            widths[i] = max(widths[i], len(val))

    sep = "  "
    print(sep.join(h.ljust(widths[i]) for i, h in enumerate(headers)))
    print(sep.join("-" * widths[i] for i in range(len(headers))))
    for line in cells:
        print(sep.join(val.ljust(widths[i]) for i, val in enumerate(line)))


def show_counts() -> None:
    """Print the overview table (one row per unique plate)."""
    # /counts is paginated; bump limit so the CLI's "show all" view still
    # shows everything in one shot. 1000 is the server's hard ceiling.
    resp = get("/counts?limit=1000")
    data = resp.get("items", []) if isinstance(resp, dict) else resp
    if not data:
        print("No sightings yet.")
        return

    for row in data:
        row["first_seen"] = fmt_time(row["first_seen"])
        row["last_seen"] = fmt_time(row["last_seen"])
        make = row.get("make") or "?"
        model = row.get("model") or ""
        row["vehicle"] = f"{make} {model}".strip()

    columns = [
        ("plate",       "Plate"),
        ("count",       "Count"),
        ("vehicle",     "Vehicle"),
        ("colour",      "Colour"),
        ("year",        "Year"),
        ("first_seen",  "First seen"),
        ("last_seen",   "Last seen"),
    ]
    print(f"\nANPR overview ({len(data)} plates)\n")
    print_table(data, columns)
    print()


def show_timeline(plate: str) -> None:
    """Print the per-plate timeline (every passage, oldest first)."""
    try:
        data = get(f"/timeline/{plate}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"No sightings for {plate.upper()}.")
            return
        raise

    for row in data:
        row["seen_at"] = fmt_time(row["seen_at"])
        if row.get("score") is not None:
            row["score"] = f"{float(row['score']) * 100:.0f}%"

    columns = [
        ("seen_at",  "When"),
        ("score",    "Score"),
        ("camera",   "Camera"),
    ]
    print(f"\nTimeline {plate.upper()} ({len(data)} passages)\n")
    print_table(data, columns)
    print()


def main() -> int:
    if len(sys.argv) > 1:
        show_timeline(sys.argv[1])
    else:
        show_counts()
    return 0


if __name__ == "__main__":
    sys.exit(main())
