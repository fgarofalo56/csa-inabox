# dataflow-gen2 — parity with Power Query Online (Dataflow Gen2)

Source UI: Microsoft Fabric / ADF "Power Query" editor
(https://learn.microsoft.com/azure/data-factory/wrangling-overview,
https://learn.microsoft.com/power-query/power-query-ui)

Azure-native backend (DEFAULT, no Fabric): the authored Power Query (M) is
compiled to an ADF **WranglingDataFlow** resource and executed on ADF Spark via
an **ExecuteWranglingDataflow** activity. The output query is written to the
chosen destination (ADLS Gen2 Parquet/CSV or an Azure SQL table). The Fabric
`RefreshDataflow` activity does not exist in ADF's ARM schema, so it is not used
on the default path. Fabric is opt-in only (`LOOM_DATAFLOW_BACKEND=fabric` + a
bound `LOOM_DEFAULT_FABRIC_WORKSPACE`).

## Power Query Online feature inventory → Loom coverage

| Power Query Online capability | Loom coverage | Backend per control |
|---|---|---|
| Queries pane — list / add / select | ✅ built | `parseSharedQueries` over the M; add appends `shared <name> = let…in…;` |
| Queries pane — rename (cascades references) | ✅ built | `renameIdentifier` rewrites declaration + cross-query refs |
| Queries pane — delete | ✅ built | regenerate section from remaining queries |
| Applied Steps pane — list / select | ✅ built | `parseLetBody` over the active query |
| Applied Steps — rename (cascades in query) | ✅ built | `renameIdentifier` within the query body |
| Applied Steps — delete | ✅ built | rebuild `let…in` without the step |
| Formula bar — edit step M expression | ✅ built | `buildLetBody`, persisted into the M |
| Ribbon — Home (choose/remove cols, keep rows, distinct, promote headers, group by) | ✅ built | `appendStep` → real `Table.*` M |
| Ribbon — Transform (filter, sort, rename, reorder, change type, merge, append) | ✅ built | `appendStep` → real `Table.*` M |
| Ribbon — Add column (custom, index, duplicate) | ✅ built | `appendStep` → real `Table.AddColumn/…` M |
| Data preview (inline rows) | ⚠️ honest-gate | ADF has no inline M-eval endpoint; preview rows come from a real ADF run (Save & Run). Fabric opt-in enables inline preview. MessageBar `intent="warning"`. |
| Output destination — ADLS Gen2 (Parquet/CSV) | ✅ built | `DestinationPicker` → `upsertLinkedService` (AzureBlobFS, factory MI) + `upsertDataset` (Parquet/DelimitedText) wired as the WranglingDataFlow sink |
| Output destination — Azure SQL table | ✅ built | `DestinationPicker` → `AzureSqlTable` dataset over a real linked service (`/api/adf/linked-services`) |
| Refresh / Run | ✅ built | `POST /api/items/dataflow/[id]/refresh` → `upsertWranglingDataFlow` + `runWranglingDataFlow` (ExecuteWranglingDataflow), returns ADF runId |
| Raw M script (advanced) | ✅ built | Script (M) tab — Monaco |
| Save | ✅ built | `PUT /api/items/dataflow/[id]` persists M + sink to Cosmos |
| Create / delete dataflow item | ✅ built | `/api/items/dataflow` POST / DELETE |

Zero ❌. The only non-functional state is the honest infra-gate inline-preview
MessageBar, allowed by `no-vaporware.md` / `ui-parity.md`.

## Run wiring (no-Fabric receipt path)

1. Author a 2-step query (e.g. `Source = #table(...)`, `Filtered = Table.SelectRows(...)`).
2. Output tab → ADLS Gen2 (Parquet), container `silver`.
3. Save & Run → `refresh` route → `runDataflowAdf`:
   - `upsertWranglingDataFlow('loom-pq-<id>', <M>)`
   - `upsertLinkedService('loom-adls-mi', AzureBlobFS)` + `upsertDataset('loom-pqsink-<id>', Parquet)`
   - `runWranglingDataFlow(...)` → wrapper pipeline `loom-pq-run-loom-pq-<id>` with one
     `ExecuteWranglingDataflow` activity → `runPipeline` → `{ runId }`.
4. Receipt is an ADF Mapping-flow run (`backend: 'adf'`), never a Fabric call,
   with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Infra / bicep sync

- `LOOM_DATAFLOW_BACKEND` env (default `adf`) — `platform/fiab/bicep/modules/admin-plane/main.bicep`.
- ADF system-assigned MI → **Storage Blob Data Contributor** on the DLZ ADLS
  account — `platform/fiab/bicep/modules/landing-zone/adf.bicep` (wired from
  `landing-zone/main.bicep` `storage.outputs.storageAccountName`).
- Gov clouds: ADF ARM host is now cloud-aware (`management.usgovcloudapi.net`
  under `AZURE_CLOUD=AzureUSGovernment`). Fabric is unavailable in GCC-High/IL5,
  so `loomDataflowBackend` stays `adf` there.
