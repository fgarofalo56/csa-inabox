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
| 5 | Save | save |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | container dropdown (real `/api/lakehouse/containers`) + path suffix |
| 2 | ✅ built | Parquet / GeoJSON / CSV select |
| 3 | ✅ built | geometry column input |
| 4 | ✅ built | **Inspect** now runs a real `SELECT TOP 1 … OPENROWSET` probe; first row + probe SQL shown |
| 5 | ✅ built | GeoSaveBar + Ctrl+S → Cosmos item state |

## Backend per control
- Containers → `GET /api/lakehouse/containers` (real ADLS list; honest-gate with `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL` + Storage Blob Data Reader).
- Inspect → `POST /api/items/synapse-serverless-sql-pool/[id]/query` with a generated `OPENROWSET` (FORMAT per chosen format). Real Synapse Serverless execution; returns the honest-gate (`LOOM_SYNAPSE_WORKSPACE`) when not provisioned. The previously-disabled "Inspect" button is now wired.
- Save → PATCH `/api/cosmos-items/geo-dataset/[id]`.
