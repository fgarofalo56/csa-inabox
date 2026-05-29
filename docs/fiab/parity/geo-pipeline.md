# geo-pipeline — parity with ADF pipeline + geo-enrichment trigger

Source UI: Azure Data Factory pipeline trigger + geo-enrichment parameters ·
https://learn.microsoft.com/azure/data-factory/concepts-pipelines-activities

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Target ADF pipeline selection | pipeline picker |
| 2 | Geo-enrichment flags (H3, reverse-geocode, buffer) | parameters |
| 3 | Trigger run with parameters | Trigger now |
| 4 | Save | save |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | pipeline dropdown (real `/api/items/adf-pipeline`) |
| 2 | ✅ built | H3 / reverse-geocode checkboxes + buffer meters |
| 3 | ✅ built | Trigger run → real ADF createRun with the geo flags as parameters |
| 4 | ✅ built | GeoSaveBar + Ctrl+S → Cosmos item state |

## Backend per control
- Pipelines → `GET /api/items/adf-pipeline` (real factory list; honest-gate when factory not reachable / role missing).
- Trigger → `POST /api/items/adf-pipeline/{name}/run` with `{ parameters: { enrichH3, reverseGeocode, bufferMeters } }` — real ADF run; runId surfaced.
- Save → PATCH `/api/cosmos-items/geo-pipeline/[id]`.
- Reverse-geocode requires an Azure Maps account — disclosed inline next to the checkbox (honest disclosure).
