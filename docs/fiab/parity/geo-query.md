# geo-query — parity with Azure geospatial query (KQL geo + Synapse H3/ST) + map render

Source UI: ADX KQL geo functions + Synapse spatial T-SQL ·
https://learn.microsoft.com/azure/data-explorer/kusto/query/geo-point-to-h3cell-function ·
https://learn.microsoft.com/azure/data-explorer/kusto/query/geospatial-grid-systems

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Geo query editor (KQL / T-SQL) | query bar |
| 2 | Engine toggle | engine switch |
| 3 | Run query | execute |
| 4 | H3 / spatial functions | built-in geo fns |
| 5 | Install H3 helper functions | n/a (ADX setup) |
| 6 | Map render of spatial results | result map |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | Monaco; KQL + T-SQL samples with `geo_*` / `H3_*` / `ST_*` |
| 2 | ✅ built | KQL ↔ T-SQL ribbon + TabList |
| 3 | ✅ built | Run → kql-database or synapse-serverless route |
| 4 | ✅ built | left-panel function reference + seeded samples |
| 5 | ✅ built | Install H3 to KQL DB → real idempotent `.create-or-alter` of `h3_*` UDFs |
| 6 | ✅ built | results with lat/lon columns auto-projected to GeoJSON → `GeoJsonMap` render |

## Backend per control
- Run (KQL) → `POST /api/items/kql-database/[id]/query` (ADX).
- Run (T-SQL) → `POST /api/items/synapse-serverless-sql-pool/[id]/query` (Synapse Serverless).
- Install H3 → kql-database route with the `H3_ADX_INSTALL` bundle (5 idempotent function commands).
- Result map: client-side `geoFromResult()` detects lat/lon (or longitude/latitude) columns across KQL `{columns,rows}` and object-row shapes, builds a FeatureCollection, renders via `GeoJsonMap`.
- Honest-gate: both query routes return their respective not-configured reasons (ADX cluster / `LOOM_SYNAPSE_WORKSPACE`).
