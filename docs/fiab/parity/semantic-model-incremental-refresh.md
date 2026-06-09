# semantic-model-incremental-refresh — parity with Power BI / AAS incremental refresh + hybrid tables

Source UI: Power BI Desktop "Incremental refresh and real-time data" dialog
(https://learn.microsoft.com/power-bi/connect-data/incremental-refresh-overview)
and the XMLA programmatic surface
(https://learn.microsoft.com/power-bi/connect-data/incremental-refresh-xmla).
Backed Azure-native by **Azure Analysis Services** (opt-in; the semantic-model
default backend stays `loom-native` — no Microsoft Fabric / Power BI workspace
required per `no-fabric-dependency.md`).

Loom surface: SemanticModelEditor → **Incremental refresh** tab
(`apps/fiab-console/lib/editors/phase3-editors.tsx`).

## Azure / Power BI feature inventory

| # | Capability (real UI)                                                   | Grounded in |
|---|------------------------------------------------------------------------|-------------|
| 1 | Select the table to define the policy on                               | Desktop dialog table picker |
| 2 | "Archive data starting N <granularity> before refresh date" (rolling window) | rollingWindowPeriods / rollingWindowGranularity |
| 3 | "Incrementally refresh data in the last N <granularity>"               | incrementalPeriods / incrementalGranularity |
| 4 | RangeStart / RangeEnd date-parameter driven source filter             | sourceExpression (M) |
| 5 | "Get the latest data in real time with DirectQuery" (hybrid table)    | refreshPolicy.mode = Hybrid |
| 6 | "Detect data changes" column (polling expression)                     | pollingExpression (M) |
| 7 | Apply the policy → create historical Import + live DirectQuery partitions | TMSL Refresh applyRefreshPolicy:true |
| 8 | Enhanced/async refresh with commitMode / applyRefreshPolicy / effectiveDate | POST /refreshes (async refresh REST) |
| 9 | Inspect the resulting partitions (Import vs DirectQuery)               | TMSCHEMA_PARTITIONS DMV |
| 10| Schedule the refresh on a timer                                       | Synapse/ADF ScheduleTrigger + Web Activity |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | ✅ built | `Select` populated from the model's tables |
| 2 | ✅ built | SpinButton (periods) + Select (granularity) |
| 3 | ✅ built | SpinButton (periods) + Select (granularity) |
| 4 | ⚠️ honest-gate | sourceExpression accepted by the client/route; the M RangeStart/RangeEnd filter is authored on the table's source query (Desktop/Tabular). The policy + DQ partition apply without it. |
| 5 | ✅ built | "real-time DirectQuery partition" Switch → mode=Hybrid |
| 6 | ✅ built | detect-changes column `Input` → pollingExpression |
| 7 | ✅ built | "Apply refresh policy" → PUT /refresh-policy (TMSL Alter + Refresh) |
| 8 | ✅ built | "Run enhanced refresh" → POST /refreshes (commitMode/applyRefreshPolicy/effectiveDate; partialBatch+applyPolicy rejected 400) |
| 9 | ✅ built | "Partition receipt" table; DirectQuery partition highlighted (brand badge) |
| 10| ⚠️ honest-gate | MessageBar points at the Data-pipeline editor + `synapse-dev-client.upsertTrigger()` (LOOM_SYNAPSE_WORKSPACE) — Azure-side infra requirement, not a Fabric one |

Zero ❌. The only non-functional states are honest infra-gates (AAS not
configured → 503 naming `LOOM_AAS_XMLA_ENDPOINT`; Synapse workspace for the
timer), per `no-vaporware.md`.

## Backend per control

| Control | Backend |
|---------|---------|
| Apply refresh policy | `aas-client.setIncrementalRefreshPolicy` (TMSL Alter over XMLA) + `applyRefreshPolicy` (TMSL Refresh) |
| Load partitions / receipt | `aas-client.listPartitions` (TMSCHEMA_PARTITIONS Discover) |
| Run enhanced refresh | `powerbi-client.enhancedRefreshDataset` (POST /groups/{ws}/datasets/{id}/refreshes) |
| Backend / config gate | `LOOM_SEMANTIC_BACKEND=analysis-services` + `aas-client.aasConfigGate()` (`LOOM_AAS_XMLA_ENDPOINT`) |

## Acceptance receipt

Set keep=3 years / refresh=10 days + Hybrid toggle on `FactSales` → PUT
`/api/items/semantic-model/{id}/refresh-policy` runs Alter + Refresh; the
partition receipt lists historical Import partitions (e.g. `FactSales_2022..2024`)
plus a live `FactSales_DirectQuery` partition. New source rows in the current
period are served by the DirectQuery partition with no full refresh. Per-cloud:
Commercial/GCC use `analysis.windows.net`; GCC-High/IL5/DoD use
`analysis.usgovcloudapi.net` (`aasXmlaScope()` / `aasSuffix()`).

## Sovereign cloud

`LOOM_AAS_XMLA_ENDPOINT` carries the full per-boundary URL (deployment tooling
picks `asazure.windows.net` vs `asazure.usgovcloudapi.net`); the token audience
is resolved at runtime by `aasXmlaScope()`.
