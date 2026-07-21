# object-explorer — parity with Palantir Foundry Object Explorer (WS-4.7)

Source UI: Palantir Foundry **Object Explorer** — the cross-type instance browser
with a facet/histogram sidebar, property-type-aware filters, a results grid, and a
full-page browsing mode. Loom builds the equivalent on **Azure-native** primitives
— object instances in the Weave **Apache AGE** graph on **PostgreSQL** — with **no
Fabric / Power BI dependency** (Gov-safe).

WS-4.7 polishes the row-2.6 Object Explorer (`ObjectExplorerPanel`, embedded in the
ontology editor **Explore** tab) and depends on WS-4.1 object views (merged), which
shipped the per-type instance read path. It reuses the same AGE query path
(`/api/items/ontology/[id]/explore` → `weave-explore.searchObjects`).

## Why facets/filters are computed in JS (grounded, not a shortcut)

Foundry runs facet aggregates in its object storage. Apache-AGE openCypher cannot
express the "aggregate/filter over ANY property" query Loom needs — a server-side
predicate on `keys(properties(n))` / dynamic `properties(n)[k]` silently matches
nothing (caught live 2026-07-19; the same reason `searchObjects` filters in JS).
So WS-4.7 computes facet counts, histogram buckets, time buckets and boolean splits
in JS over the REAL instance rows the search already returned — no mock data, no
Fabric. The route ships the object type's declared property schema so the chart kind
per property is chosen from the model, not guessed.

## Foundry feature inventory (grounded in Foundry Object Explorer)

| Capability | Foundry behavior |
|---|---|
| Cross-type object browse | Browse instances across every object type, with per-type counts. |
| Facet sidebar (categorical) | String properties show a distinct-value facet with counts; click a value to filter. |
| Histograms (numeric) | Numeric properties show a distribution histogram; click a bucket to filter to a range. |
| Time facets (date) | Date/timestamp properties bucket over time; click a bucket to filter to that window. |
| Boolean facets | Boolean properties show a true/false split; click to filter. |
| Property-type-aware filters | Filters respect the property type (category set / numeric range / time range / boolean). |
| Combine filters | Multiple facet selections AND together to narrow the result set. |
| Results grid | The filtered instances render as a table with their properties. |
| Link traversal | From an instance, traverse its links to neighbouring objects. |
| Saved explorations | Persist a type + query as a named exploration. |
| Full-page mode | Expand the explorer to a full-page browsing surface. |

## Loom coverage

| Row | Status | Loom implementation |
|---|---|---|
| Cross-type browse + per-type counts | ✅ built | `mode=facets` → `objectFacets` (`MATCH (n) RETURN label(n), count(n)` over AGE); left rail lists declared types with instance counts. |
| Categorical facet counts | ✅ built | `computeCategoryFacet` — top-N distinct stringified values, sorted desc, array-aware, over the fetched instances. |
| Numeric histograms | ✅ built | `computeHistogram` — equal-width buckets between observed min/max (single-bin when all equal); real per-bucket counts. |
| Date time-buckets | ✅ built | `computeTimeBuckets` — auto day/month/year granularity via `parseTimeMs`, non-empty buckets sorted chronologically. |
| Boolean facet | ✅ built | `computeBooleanFacet` — 2-way true/false split. |
| Property-type-aware filters | ✅ built | `FacetFilter` union (`category` / `range` / `timerange` / `boolean`); `objectMatchesFilter` applies the right predicate per kind; the chart kind is chosen from the object-type model's declared `baseType` (shipped by `mode=search`), inferred from values when unknown. |
| Click-to-filter + combine | ✅ built | `filterFromBin` derives a filter from a clicked bar; `applyFacetFilters` ANDs all active filters over the fetched rows; active filters render as removable chips; results header shows `N of M`. |
| Facet charts UI | ✅ built | `ObjectFacetCharts` — elevated `TileGrid` cards, horizontal mini bars matching the DataProfiling distribution chrome, kind icon + distinct/kind badges, clickable bars with `aria-pressed`. |
| Results grid | ✅ built | Filtered instances table (unchanged read path); columns derived from the visible rows. |
| Link traversal | ✅ built | `mode=traverse` → `traverseObject` (real AGE `MATCH (a)-[r]-(b)`); neighbours grouped by link type + direction. |
| Saved explorations | ✅ built | `POST` / `DELETE /explore` persist named `{type,q}` to `item.state.explorations`. |
| Full-page mode | ✅ built | `Full screen` toggle → fixed viewport overlay (`role=dialog`, Esc/Close to exit); rail↔main and facets↔results use the shared `SplitPane` (G3) with persisted `sizingKey`s. |

Zero ❌.

## Backend per control

| Control | Backend |
|---|---|
| Type rail / counts | `GET /api/items/ontology/[id]/explore?mode=facets` → `objectFacets` (AGE). |
| Search + property schema | `GET …?mode=search&type=&q=&top=` → `searchObjects` (AGE, JS CONTAINS) + the type's declared `properties` from `objectTypeByName`. |
| Facets / histograms / filters | Pure JS over the fetched instances — `lib/foundry/object-facets.ts` (`buildFacetCharts`, `applyFacetFilters`). No extra network call, no mock. |
| Traverse | `GET …?mode=traverse&type=&from=` → `traverseObject` (AGE). |
| Saved explorations | `POST` / `DELETE …/explore` → `item.state.explorations` (Cosmos). |

## Rules compliance

- **no-vaporware / G1:** every facet, histogram and time bucket is computed from
  the real AGE instances the search returned; filters actually narrow the instance
  list. No mock arrays. *Owed: browser-E2E receipt — facet + histogram over real AGE
  instances (Track-0).*
- **no-fabric-dependency / sovereign:** Apache AGE on PostgreSQL only; no Fabric /
  Power BI / OneLake host on any path. Gov-safe.
- **web3-ui / ux-baseline:** Fluent v9 + Loom tokens; `TileGrid` + `EmptyState`
  + elevated cards + kind badges; `SplitPane` (G3) resizable panels with persisted
  sizes; badge rows use `flexWrap` + `minWidth:0`; clean first-open (no error
  banners); charts match the sibling DataProfiling distribution viz.

## Verification

- `npx tsc -p tsconfig.build.json --noEmit` → clean.
- `npx vitest run lib/foundry/__tests__/object-facets.test.ts` → 22 green (facet /
  histogram / time-bucket / boolean compute + property-type-aware filter predicates
  + click-to-filter derivation).
- `check-env-sync` / `check-route-guards` / `check-file-size` / `check-bff-errors`
  → OK (no new env var).
- **Owed (Track-0):** in-browser E2E — pick a type, confirm facet counts + a numeric
  histogram + a date time-bucket render over seeded AGE instances, click a bar to
  filter the grid, and open full-page mode. Screenshot in the PR.
