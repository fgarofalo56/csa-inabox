# geo-dataset — parity with Synapse geospatial dataset over ADLS

Source UI: Synapse Serverless OPENROWSET over ADLS + Fabric lakehouse data preview ·
https://learn.microsoft.com/azure/synapse-analytics/sql/query-data-storage

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | ADLS container/path selection | storage browser |
| 2 | Format selection (Parquet/GeoJSON/CSV) | dataset config |
| 3 | Geometry column config | schema |
| 4 | Inspect / preview first rows | data preview (OPENROWSET) |
| 5 | Geometry-column inspector (schema + encoding) | schema view |
| 6 | Spatial reference (SRID / CRS) | dataset config |
| 7 | Save | save |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | container dropdown (real `/api/lakehouse/containers`) + path suffix |
| 2 | ✅ built | Parquet / GeoJSON / CSV select (GeoJSON honestly noted as non-columnar) |
| 3 | ✅ built | geometry column input |
| 4 | ✅ built | **Inspect** runs a real `SELECT TOP 1 … OPENROWSET` probe; first row + probe SQL shown |
| 5 | ✅ built | **Geometry inspector** — left panel + main pane render the inferred schema (column names) with the geometry column badged by its detected encoding (WKB / WKT / GeoJSON) from the row-0 value. (Was the v3.x "deferred" gate.) |
| 6 | ✅ built | SRID / EPSG `<select>` — 4326 (WGS84) / 3857 (Web Mercator) / 2263 (NY State Plane) / custom |
| 7 | ✅ built | GeoSaveBar + Ctrl+S → Cosmos item state |

## Backend per control
- Containers → `GET /api/lakehouse/containers` (real ADLS list; honest-gate with `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL` + Storage Blob Data Reader).
- Inspect / schema → `POST /api/items/synapse-serverless-sql-pool/[id]/query` with a generated `OPENROWSET` (FORMAT per chosen format: PARQUET → typed schema with WKB→varbinary hex; CSV → header columns; GeoJSON → raw lines, with an honest "not columnar" MessageBar). Real Synapse Serverless execution; returns the honest-gate (`LOOM_SYNAPSE_WORKSPACE`) when not provisioned. The schema panel is driven entirely by the route's real `{ columns, rows }`.
- SRID → persisted in Cosmos `state.srid`; surfaced for downstream tooling.
- Save → PATCH `/api/cosmos-items/geo-dataset/[id]`.
