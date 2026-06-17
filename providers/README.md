# Vehicle-registry providers

This directory holds the JSON configs that tell `frigate-anpr-logger` how to look up
vehicle data per country. Adding a new country (DE, UK, …) is a matter of
dropping a JSON file here and listing it in `index.json` — **no Python
changes**.

## Layout

```
providers/
├── index.json     ← registry; ordered list of providers to try
├── nl.json        ← built-in example, talks to the Dutch RDW open data API
└── <yours>.json   ← drop a file like this to add a country
```

When the image starts and `/app/providers/` is empty (typical on first run
after mounting `./providers:/app/providers`), the defaults from
`/app/providers_default/` are copied over so you have something to edit.

## `index.json`

```json
{ "providers": ["nl"] }
```

Ordered. The lookup walks providers in array order; for each plate the **first
one whose `plate_match` regex matches** wins. Providers without `plate_match`
are tried last (in array order) as a fallback. A plate that matches nothing
is cached as a negative result (no HTTP call).

## Provider schema

```json
{
  "name": "nl",
  "description": "human-readable label, optional",
  "plate_match": "^[A-Z0-9]{6}$",
  "request": {
    "method": "GET",
    "url": "https://opendata.rdw.nl/resource/m9d7-ebf2.json",
    "query": { "kenteken": "{plate}" },
    "headers": {},
    "body": null,
    "timeout_seconds": 10
  },
  "response": {
    "root": "[0]",
    "fields": {
      "make":           { "path": "merk" },
      "model":          { "path": "handelsbenaming" },
      "colour":         { "path": "eerste_kleur" },
      "body_type":      { "path": "voertuigsoort" },
      "year":           { "path": "datum_eerste_toelating", "slice": [0, 4] },
      "fuel":           { "path": null },
      "inspection_due": { "path": "vervaldatum_apk" }
    }
  }
}
```

### Placeholder

`{plate}` is interpolated (normalised: uppercase, no separators) into:

- `request.url`
- every value in `request.query`
- every value in `request.headers`
- every string anywhere inside `request.body`

### `plate_format` — country-specific hyphenation

**Optional.** Omit the whole block when you don't know (or don't care
about) the country's plate format — plates then render as the cleaned
uppercase form, no hyphens. Set it when you do want pretty rendering
(`GVF57G` → `GVF-57-G`).

The backend doesn't touch the value; it just exposes it via `GET /providers`
and the frontend pre-compiles the patterns on page load.

```jsonc
"plate_format": {
  "sidecodes": [
    { "pattern": "^\\d{2}[A-Z]{3}\\d$", "parts": [2, 5] },   // 99-XXX-9
    { "pattern": "^[A-Z]{3}\\d{2}[A-Z]$", "parts": [3, 5] }, // XXX-99-X
    // …
  ]
}
```

Each entry: a regex against the **cleaned** plate (uppercase, no separators)
plus a `[first_dash, second_dash]` index pair. First matching entry wins.
No match → plate renders unformatted.

### `display` — boolean strings + currency

**Optional.** Tells the dashboard how to render values that vary per country:

```jsonc
"display": {
  "yes_values":  ["Ja"],           // strings the registry uses for "true"
  "no_values":   ["Nee"],          // strings for "false"
  "currency":    "EUR"             // ISO-4217 code for catalog_price
}
```

The frontend unions `yes_values` / `no_values` from all loaded providers into
two sets. Any field value that matches a "yes" string gets a green pill; "no"
gets red. Other strings pass through as plain text. The first provider that
declares a `currency` wins for the whole dashboard. Omit the block to fall
back to plain text rendering and EUR formatting.

### Path syntax

Dotted keys plus bracket-indexed arrays. Examples:

- `"merk"` — top-level key
- `"data.vehicle.make"` — nested
- `"data.registrations[0].vehicle.make"` — array index
- `"[0]"` — root array index (use as `response.root` when the API returns
  `[{…}]`)
- `null` — leave the column NULL on purpose

A path that doesn't resolve returns NULL — never an error.

### Per-field transforms

Applied in this order: `path` → `slice` → case → `default`.

| Key       | Type            | Example                            |
| --------- | --------------- | ---------------------------------- |
| `slice`   | `[start, end]`  | `"slice": [0, 4]` (Python-style)   |
| `upper`   | bool            | `"upper": true`                    |
| `lower`   | bool            | `"lower": true`                    |
| `title`   | bool            | `"title": true`                    |
| `default` | string          | `"default": "unknown"`             |

### Standard fields

The runtime only stores these seven keys (anything else in `response.fields`
is ignored — at least for now):

`make · model · colour · body_type · year · fuel · inspection_due`

The raw response is also stored verbatim in the `raw_json` column, so a future
upgrade can surface extra fields without re-fetching.

## Skeleton for a second country

```jsonc
// providers/uk.json — placeholder; UK DVLA requires registration + API key.
{
  "name": "uk",
  "description": "DVLA Vehicle Enquiry Service (requires API key)",
  "plate_match": "^[A-Z]{2}[0-9]{2}[A-Z]{3}$",
  "request": {
    "method": "POST",
    "url": "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles",
    "query": {},
    "headers": {
      "x-api-key": "your-api-key-here",
      "content-type": "application/json"
    },
    "body": { "registrationNumber": "{plate}" },
    "timeout_seconds": 10
  },
  "response": {
    "root": "",
    "fields": {
      "make":           { "path": "make" },
      "model":          { "path": "model" },
      "colour":         { "path": "colour", "title": true },
      "year":           { "path": "yearOfManufacture" },
      "fuel":           { "path": "fuelType" }
    }
  }
}
```

Then add `"uk"` to `index.json`'s `providers` array (order matters).

## Restart needed

Provider configs are loaded once at startup. Edit a file, restart the
container, and the new config is live.
