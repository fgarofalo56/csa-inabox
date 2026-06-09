# semantic-model-get-data — parity with Power BI / Fabric "Get data" (Dataflow Gen2 ingest)

Source UI: Power BI Desktop / Fabric **Get data** → Power Query editor; Fabric
**Dataflow Gen2** (Power Query Online) → destination → Delta in OneLake.
Learn: https://learn.microsoft.com/power-query/power-query-what-is-power-query ·
https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview

CSA Loom surface: `SemanticModelEditor` → ribbon **Home ▸ Data ▸ Get data**
(and the toolbar **Get data** button) → 3-step wizard dialog.
BFF: `POST /api/items/semantic-model/[id]/ingest`.

Azure-native backend (no Microsoft Fabric / Power BI capacity required — see
`no-fabric-dependency.md`):

- **M authoring** — `PowerQueryHost` (Power Query Online-parity ribbon + queries
  pane + applied-steps pane + formula bar). The M section text is the single
  source of truth.
- **M → Parquet** — ADF `WranglingDataFlow` run via `ExecuteWranglingDataflow`
  on ADF Spark (`adf-client.ts`; WranglingDataFlow is ADF-only — Synapse does
  not expose it).
- **Parquet → Delta** — `MappingDataFlow` with an inline Parquet source + inline
  **Delta** sink over ADLS Gen2, run via a wrapper pipeline's `ExecuteDataFlow`.
  Backend = **Synapse** when `LOOM_SYNAPSE_WORKSPACE` is set (opt-in), else
  **ADF** (default). Delta is not a WranglingDataFlow sink, so this second
  structured flow is required.
- **Semantic layer refresh** — Azure Analysis Services async-refresh REST
  (`aas-client.ts`) refreshes the tabular model whose partition source points at
  the Delta path, making the table queryable.

## Power BI / Fabric feature inventory

| # | Capability (source UI) | Notes |
|---|------------------------|-------|
| 1 | Source picker ("Get data" connector gallery) | Choose a connector to start a query |
| 2 | Power Query editor — ribbon transforms, queries pane, applied steps, formula bar | Author the mashup |
| 3 | Set destination (Lakehouse/Warehouse/ADLS; Fabric → Delta in OneLake) | Where the result lands |
| 4 | Publish/Run — materialise the query output | Executes on Spark |
| 5 | Land result as Delta | Fabric Dataflow Gen2 writes Delta to OneLake |
| 6 | Refresh the semantic model over the result | Model becomes queryable |
| 7 | Query the refreshed table | Power BI / DAX / Excel |

## Loom coverage

| # | Capability | Status | Backend per control |
|---|------------|--------|---------------------|
| 1 | Source picker — Sample/inline, ADLS CSV, ADLS Parquet, Azure SQL, OData tiles; each inserts a real M `Source =` step | ✅ built | client-side M insertion (`insertSource` → `setQueryBody`) |
| 2 | Power Query (M) editor (ribbon, queries, applied steps, formula bar) | ✅ built | `PowerQueryHost` (`m-script.ts` transforms) |
| 3 | Destination — ADLS zone (bronze/silver/gold) dropdown + optional AAS table name | ✅ built | wizard Run tab → POST body |
| 4 | Run — M → Parquet on ADF Spark | ✅ built | `upsertWranglingDataFlow` + `runWranglingDataFlow` (ExecuteWranglingDataflow) |
| 5 | Land as Delta in ADLS Gen2 | ✅ built | MappingDataFlow inline Delta sink + ExecuteDataFlow pipeline (Synapse opt-in / ADF default) |
| 6 | Refresh the semantic model | ✅ built (⚠️ honest-gate when AAS unconfigured / Government cloud) | `postAasRefresh` (AAS async-refresh REST) |
| 7 | Query the refreshed table | ✅ via AAS (Commercial) / ⚠️ Synapse Serverless `OPENROWSET(... FORMAT='DELTA')` over the Delta path (Government) | AAS / Synapse Serverless |

Zero ❌. The only non-functional states are honest infra-gates surfaced as Fluent
`MessageBar`s + `warnings[]` (no AAS configured → name `LOOM_AAS_SERVER` /
`LOOM_AAS_MODEL`; Government cloud → no AAS, query Delta via Serverless;
missing ADF env → 503 naming `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` /
`LOOM_ADF_NAME`; missing ADLS URL → 503 naming `LOOM_BRONZE_URL` /
`LOOM_ADLS_ACCOUNT`).

## Cloud matrix

| Capability | Commercial | GCC | GCC-High / IL5 | DoD |
|---|---|---|---|---|
| M authoring (PowerQueryHost) | ✅ | ✅ | ✅ | ✅ |
| ADF WranglingDataFlow (M → Parquet) | ✅ | ✅ | ✅ (ARM via `management.usgovcloudapi.net`) | ✅ |
| MappingDataFlow Parquet → Delta (ADF default) | ✅ | ✅ | ✅ | ✅ |
| Synapse MappingDataFlow (opt-in) | ✅ | ✅ | ✅ (dev-plane `dev.azuresynapse.usgovcloudapi.net` — fixed in `synapse-artifacts-client.ts`) | ✅ |
| ADLS Gen2 Delta write | ✅ | ✅ | ✅ (`dfs.core.usgovcloudapi.net`) | ✅ |
| AAS refresh | ✅ | ✅ | ❌ not offered — honest gate `AAS_NOT_IN_GOV` | ❌ same |
| Gov alternative | n/a | n/a | Synapse Serverless `OPENROWSET(... FORMAT='DELTA')` | same |

## Verification

- Unit: `lib/azure/__tests__/aas-ingest-gates.test.ts` — `aasConfigGate()` gov
  vs commercial precision + `devBase()` sovereign host (9 tests, green).
- tsc: `npx tsc --noEmit -p tsconfig.json` clean on all touched files.
- Live receipt (operator): Run ingest with `LOOM_DEFAULT_FABRIC_WORKSPACE`
  UNSET → ADF runId + Delta runId returned; Delta lands at the reported
  `abfss://…/ingest/<id>/<query>/delta`; AAS refreshId queued (Commercial) or a
  `warnings[]` entry directing to Serverless OPENROWSET (Government).
