# Parity Gap — Geoanalytics editors (v2 validator, 2026-05-26)

> Editors: `geo-map` / `geo-dataset` / `geo-query` / `geo-pipeline` / `map` (separate)
> Sources:
> - `apps/fiab-console/lib/editors/geo-editors.tsx` (249 lines — handles geo-map, geo-dataset, geo-query, geo-pipeline)
> - `apps/fiab-console/lib/editors/phase4-editors.tsx` (`MapEditor` ~ line 971 — handles `map`)
> Validator state: source-grade audit. Phase 4 live click blocked by MFA expiration.

## Critical request checks

- **"Map / geo-map: Azure Maps tile rendering when key set, or just MessageBar?"** —
  - `geo-map`: MessageBar only ("Runtime deferred"). The form has Azure Maps account name, style, and tile layer URL inputs, but **no `<img>` tile preview at all**. The MessageBar tells the user how to provision, but the editor cannot render any tiles even when configured.
  - `map` (phase4-editors): **DOES render tile preview when `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` env var is set** — emits `<img src="https://atlas.microsoft.com/map/static?...">`. Falls back to a `MessageBar intent="warning"` when key is absent. Computes bbox + naive zoom heuristic from GeoJSON parsing. **B-present feature.** But the docs honestly admit: "features above are NOT rendered as overlays in this snapshot" — vector layer overlay is deferred.

So the two editors with similar names diverge: `geo-map` is config-only, `map` actually renders a tile when configured.

## 1. `geo-map`

| Element | Azure Maps Studio | Loom | Severity |
|---|---|---|---|
| Map canvas | Live interactive map | **ABSENT** — no canvas | **BLOCKER** |
| Layer panel | Side rail with toggle | absent | **BLOCKER** |
| Style picker | Combo (Road/Satellite/Hybrid/Grayscale) | `<Input>` text field | **MAJOR** — not a picker |
| Account/key config | Settings dialog | Two text inputs (account, style, tile URL) | present |
| Save | Top button | absent | **BLOCKER** ("Save" ribbon button has no `onClick`) |
| Preview | Top button | absent | **BLOCKER** ("Preview" ribbon button has no `onClick`) |
| Markers / Polygons / Annotations layer | Pickable | absent | **BLOCKER** |
| Search by address (geocoding) | Top searchbox | absent | MAJOR |

**Grade**: **D** — three text inputs, no map, no save. Honest MessageBar gate but the editor is empty.

## 2. `geo-dataset`

| Element | "Geo dataset" equivalent (Synapse OPENROWSET + custom) | Loom | Severity |
|---|---|---|---|
| ADLS path | Path input | `<Input>` | present |
| Geometry column | Field selector | `<Input>` | present (no picker — manual text) |
| Format picker (Parquet / GeoJSON / CSV) | Combo | native `<select>` (not Fluent Dropdown) | MINOR |
| **Inspector** ("probe first row via OPENROWSET") | Run preview | MessageBar "deferred to v3.x" + no button | **BLOCKER** for advertised feature |
| Save | Top button | absent in source | **BLOCKER** — "Save" ribbon has no onClick |
| Geometry CRS picker | Combo (4326 / 3857 / others) | absent | MAJOR |
| Bounding box display | Side rail | absent | MAJOR |
| Sample row preview | Grid | absent | MAJOR |

**Grade**: **D** — 3 inputs + a `<select>`, no inspect, no save, no preview. Pure form-stub.

## 3. `geo-query`

| Element | KQL / Synapse Serverless query editor | Loom | Severity |
|---|---|---|---|
| Engine toggle (KQL / T-SQL) | n/a (separate editors) | TabList 2 tabs | present (nice integration) |
| **Query editor** | Monaco with kusto / sql IntelliSense + ST_ function completion | **`<textarea>`** (line 199) | **BLOCKER** ❌ |
| Sample queries | Side rail snippet picker | hardcoded swap on tab change | C-present |
| Function reference panel | Side rail | leftPanel has 4 `<code>` references (geo_distance_2points, geo_point_to_h3cell, geo_point_to_s2cell, ST_DISTANCE/ST_WITHIN) | present |
| Run | Top button | `Play` icon button | present |
| Results | Grid + map overlay | `<pre>` JSON dump | **MAJOR** — no table render |
| Map overlay of results | Live points/polygons | absent | **BLOCKER** advertised in docs |
| Save query | Toolbar | absent | MAJOR |
| Query history | Side panel | absent | MAJOR |

**Grade**: **D** — `<textarea>` + JSON dump output. No Monaco, no map overlay. The function reference panel is the best feature.

## 4. `geo-pipeline`

| Element | ADF Pipeline + custom enrichment | Loom | Severity |
|---|---|---|---|
| ADF pipeline name target | Input | `<Input>` | present |
| Enrichment flags (H3, Reverse geocode) | Checkboxes | native `<input type="checkbox">` (not Fluent Switch) | MINOR (visual inconsistency) |
| Buffer meters | Number input | `<Input type="number">` | present |
| Save / Trigger run buttons | Top | **Ribbon labels only — no onClick** | **BROKEN** ❌ |
| Pipeline-run trigger | Wired to ADF | "Wiring deferred to v3.x; today the flags persist" | **D-present** — config-only |
| Enrichment result preview | Grid | absent | MAJOR |
| Cost estimator (Azure Maps reverse-geocode rate) | Tile | absent | MINOR |

**Grade**: **D** — config form, dead ribbon buttons.

## 5. `map` (phase4-editors)

This is the one that actually renders.

| Element | Azure Maps Web Control | Loom | Severity |
|---|---|---|---|
| GeoJSON editor | Monaco with JSON schema validation for RFC 7946 | **`<textarea>`** | **BLOCKER** ❌ |
| Feature count | Status bar | Subtitle2 "GeoJSON (N feature(s))" | present (real parsing) |
| Bbox / Center / Zoom auto-compute | Auto | Implemented client-side (lines 980-1007) | **A-present** ✓ |
| **Tile preview** | Interactive | Static map `<img>` via atlas.microsoft.com/map/static REST | **B-present** when key set, MessageBar gate when not |
| Vector overlay of features | Yes | "NOT rendered as overlays in this snapshot" (honest) | MAJOR — advertised in catalog but absent |
| Pan / Zoom / Rotate | Built-in | absent (static image) | MAJOR |
| Save | SaveBar | SaveBar wired | present |
| Validate | "Validate" ribbon button | **no onClick** — `parseErr` happens inline on every keystroke | partial |

**Grade**: **C** — best in the family because Cosmos persistence + bbox + static tile preview actually work. `<textarea>` blocks A/B; dead "Validate" ribbon button is BROKEN.

## Summary

| Editor | Grade | Reason |
|---|---|---|
| geo-map | **D** | 3 inputs, no map canvas, dead Save/Preview ribbon buttons, MessageBar-only honesty |
| geo-dataset | **D** | 3 inputs + select, no inspect, dead Save ribbon |
| geo-query | **D** | `<textarea>` not Monaco (BLOCKER), JSON dump output, no map overlay |
| geo-pipeline | **D** | Config form only, dead Save / Trigger run ribbon buttons |
| map | **C** | Static tile preview wired (real REST), Cosmos persist works, but `<textarea>` for GeoJSON, no vector overlay |
