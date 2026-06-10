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
| 2 | ✅ built | H3 / reverse-geocode checkboxes + buffer meters; each labeled with its ADF parameter type (`enrichH3: Bool`, `reverseGeocode: Bool`, `bufferMeters: Int`) |
| 3 | ✅ built | **Trigger run** → real ADF `createRun` with the geo flags materialized as pipeline parameters. (Was the v3.x "deferred" gate.) The run route inspects the target pipeline's declared parameters and passes only the ones it declares, returning a used/skipped receipt. |
| 4 | ✅ built | GeoSaveBar + Ctrl+S → Cosmos item state; flags auto-persist before a Trigger so the server reads fresh state |

## Backend per control
- Pipelines → `GET /api/items/adf-pipeline` (real factory list; honest-gate when factory not reachable / role missing).
- Trigger → `POST /api/items/geo-pipeline/[id]/run` (new). The route loads the geo-pipeline Cosmos item, reads `state.adfPipelineName` + the flags, calls `getPipelineParameters()` to see which of `enrichH3` / `reverseGeocode` / `bufferMeters` the target pipeline declares, then calls `runPipeline(name, paramMap)` — a real ADF `createRun` ARM REST (flat parameter map, per the ADF contract). Returns `{ runId, pipelineName, parametersUsed, parametersSkipped }`. Honest gates: 503 when ADF env vars unset (`LOOM_ADF_NAME` / `LOOM_DLZ_RG` / `LOOM_SUBSCRIPTION_ID`), 412 when no target pipeline is set, 404 when the named pipeline doesn't exist.
  - *Why a dedicated route?* The previous wiring posted the raw ADF pipeline NAME to `/api/items/adf-pipeline/{id}/run`, which expects a Loom item GUID (resolved via `resolveBinding`) — so it 404'd. The new route reads the binding from the geo-pipeline item itself.
- Starter pipeline → `adf.bicep` deploys `loom-geo-enrich` (parameters `enrichH3: Bool`, `reverseGeocode: Bool`, `bufferMeters: Int` pre-declared) when `deployGeoEnrichPipeline=true` (default), so the editor has a ready 1:1 target. Activities are an empty shell built out in ADF Studio / the Loom pipeline editor.
- Save → PATCH `/api/cosmos-items/geo-pipeline/[id]`.
- Reverse-geocode requires an Azure Maps account — the checkbox is disabled with an honest `MessageBar` naming `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` when unset (Azure Maps is unavailable in GCC-High / IL5). H3 + buffer work in every cloud.
