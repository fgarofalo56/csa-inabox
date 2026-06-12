# Parity Gap — Geoanalytics editors (v2 validator, 2026-05-26)

> **Update 2026-06-10 (audit-t10):** The two deferred gates called out below
> for `geo-dataset` and `geo-pipeline` are now wired to real Azure backends:
> - **geo-dataset geometry inspector** — the left panel renders the inferred
>   schema (column names + a geometry-encoding badge: WKB / WKT / GeoJSON) from
>   a real Synapse Serverless `OPENROWSET` probe via
>   `/api/items/synapse-serverless-sql-pool/[id]/query`. A bounded SRID / EPSG
>   picker (4326 / 3857 / 2263 / custom) was added.
> - **geo-pipeline enrichment flags → ADF parameters** — `Trigger run` now POSTs
>   to the new `/api/items/geo-pipeline/[id]/run` route, which reads the flags
>   from Cosmos state and maps them onto a real ADF `createRun`
>   (`enrichH3: Bool`, `reverseGeocode: Bool`, `bufferMeters: Int`), passing only
>   the parameters the target pipeline declares. A `loom-geo-enrich` starter
>   pipeline (with those parameters pre-declared) is deployed by `adf.bicep`
>   (`deployGeoEnrichPipeline`, default true). The `reverseGeocode` flag is
>   honestly gated on Azure Maps (`NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY`), which is
>   unavailable in GCC-High / IL5.
>
> Both editors move **D → C**. Remaining gaps (Monaco query overlay, result grid,
> bbox display) are unchanged.
>
> **Update 2026-06-11 (audit-t10, follow-up):** Two of those remaining MAJOR gaps
> are now closed, moving both editors **C → B**:
> - **geo-dataset — geometry now RENDERS on a map.** The Inspect probe rows are
>   parsed into a GeoJSON FeatureCollection (`geoFeaturesFromInspectRows`: WKT
>   `POINT`/`LINESTRING`/`POLYGON` + Multi\* via `parseWktGeometry`, GeoJSON literal
>   cells, or `lon`/`lat` column fallback) and drawn on the shared `GeoJsonMap`
>   SVG renderer. WKB hex blobs are honestly skipped (still badged "WKB" in the
>   schema panel) with a MessageBar explaining how to render them. The
>   **bounding-box side-rail** (`bboxLabel` + `computeGeoBbox`, with the SRID) was
>   added — closing the "Bounding box display" MAJOR row.
> - **geo-pipeline — enrichment run-status grid.** After Trigger run, a grid shows
>   each flag (`enrichH3`/`reverseGeocode`/`bufferMeters`), its value, and whether
>   it `passed to ADF` or was `not declared` by the target pipeline, plus the
>   `createRun` runId — closing the "Enrichment result preview" MAJOR row (was
>   runId-receipt-only).
>
> All three new helpers are pure + unit-tested in `__tests__/family-utils.test.ts`.

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
| **Inspector** ("probe first row via OPENROWSET") | Run preview | ✅ Inspect button + real OPENROWSET probe → schema panel (column names + geometry-encoding badge) | **resolved** (was BLOCKER) |
| Save | Top button | ✅ wired (GeoSaveBar + ribbon Save + Ctrl+S → PATCH cosmos-items) | **resolved** |
| Geometry CRS picker | Combo (4326 / 3857 / others) | ✅ SRID/EPSG `<select>` (4326 / 3857 / 2263 / custom) | **resolved** (was MAJOR) |
| Bounding box display | Side rail | ✅ side-rail bbox (`bboxLabel` + `computeGeoBbox`, with SRID) | **resolved 2026-06-11** (was MAJOR) |
| Geometry map render | Map preview | ✅ inspected rows → GeoJSON (WKT/GeoJSON/lon-lat) on shared `GeoJsonMap` SVG | **resolved 2026-06-11** |
| Sample row preview | Grid | ✅ first-row `<pre>` + schema panel + geometry map | present |

**Grade**: **B** — inspector wired to real Synapse Serverless OPENROWSET with a
geometry-encoding schema panel; SRID picker; Save round-trips to Cosmos; the
inspected geometry now renders on the shared SVG map with a bbox side-rail
(WKB blobs honestly skipped). Remaining for A: typed result grid + WKB decode.

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
| Save / Trigger run buttons | Top | ✅ both wired (ribbon Save → PATCH; Trigger run → run route) | **resolved** (was BROKEN) |
| Pipeline-run trigger | Wired to ADF | ✅ POST `/api/items/geo-pipeline/[id]/run` → real ADF `createRun` with enrichH3/reverseGeocode/bufferMeters as pipeline parameters | **resolved** (was D-present) |
| Reverse-geocode (Azure Maps) gate | n/a | ✅ checkbox disabled + honest MessageBar when `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` unset (GCC-High / IL5) | present |
| Enrichment result preview | Grid | ✅ run-status grid: per-flag value + `passed to ADF` / `not declared` + runId | **resolved 2026-06-11** (was MAJOR) |
| Cost estimator (Azure Maps reverse-geocode rate) | Tile | absent | MINOR |

**Grade**: **B** — flags map to real ADF pipeline parameters on a real
createRun; Save + Trigger both wired; honest Azure-Maps gate; a run-status grid
shows which flags actually mapped to the pipeline's declared parameters plus the
runId. Remaining for A: live run-status polling (Succeeded/Failed) via the ADF
monitoring REST.

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
| geo-map | **D** | 3 inputs, no map canvas, dead Save/Preview ribbon buttons, MessageBar-only honesty *(note: later waves added GeoJsonMap render + SaveBar — re-audit)* |
| geo-dataset | **B** | Inspector renders geometry on the shared SVG map (WKT/GeoJSON/lon-lat) + bbox side-rail; real OPENROWSET schema panel; SRID picker; Cosmos round-trip *(updated 2026-06-11)* |
| geo-query | **D** | `<textarea>` not Monaco (BLOCKER), JSON dump output, no map overlay *(note: later waves added Monaco + result map — re-audit)* |
| geo-pipeline | **B** | Enrichment flags map to real ADF createRun pipeline parameters; run-status grid (passed/not-declared + runId); Save + Trigger wired; honest Azure-Maps gate *(updated 2026-06-11)* |
| map | **C** | Static tile preview wired (real REST), Cosmos persist works, but `<textarea>` for GeoJSON, no vector overlay |
