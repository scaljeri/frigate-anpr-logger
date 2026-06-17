# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — Initial public release

First public release. Self-hosted ANPR logger + dashboard targeting a Frigate
camera setup on a private LAN.

### Added

- **MQTT ingest** of Frigate LPR events into a SQLite store, with
  configurable score floor and dedup window.
- **Config-driven vehicle-registry providers** (`providers/*.json` +
  `providers/index.json`). Dutch RDW ships out of the box; adding a country
  is JSON-only, no Python changes.
- **22 vehicle fields** extracted from the registry per plate — core
  identification (make/model/colour/year/…), financial / compliance signals
  (catalog price, insured, recall, taxi), display extras (body style, owner
  since, efficiency label, secondary colour), and full specs / dimensions.
- **HTTP JSON API** (FastAPI, OpenAPI at `/docs`) covering sightings CRUD,
  per-plate timeline, vehicle cache management, and provider introspection.
- **Browser dashboard** at `/ui` — plates list with sortable columns and a
  column-visibility dropdown (persisted in localStorage), detail view with
  a zoomable spike timeline, vehicle-details grid, and edit/delete actions.
- **Sync against a specific provider** via `POST /vehicles/{plate}/refresh?provider=NAME`
  and a dropdown on the detail page — handy after a schema expansion or to
  retry a previously failed lookup.
- **OCR plate healing**: when the first registry lookup misses and the plate
  contains exactly one OCR-confusable character (I↔1, G↔5, O↔0), retry with
  the swapped variant. Bounded to one extra request per miss.
- **Schema migrations** via a tiny in-process runner (`scripts/migrate.py`),
  versioned with SQLite `PRAGMA user_version`. Pre-versioning databases
  (legacy Dutch-column schema) auto-bootstrap to v1 on first start.
- **Docker image** with multi-stage build and HEALTHCHECK; sample
  `compose.yaml` mounts `./data` and `./providers` for state and config.
- **CLI companion** (`scripts/anpr-cli.py`): stdlib-only terminal client
  against the JSON API, useful for ad-hoc checks over SSH.
- **Dev workflow with hot-reload** — `uvicorn main:app --reload` serves
  both the API and the frontend, with backend Python changes triggering
  an auto-restart and frontend changes picked up on a browser refresh.

[Unreleased]: https://github.com/scaljeri/frigate-anpr-logger/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/scaljeri/frigate-anpr-logger/releases/tag/v0.1.0
