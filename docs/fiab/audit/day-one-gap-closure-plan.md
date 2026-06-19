# Day-One Gap-Closure Plan — Zero Setup Gates

**Status:** AUDIT + PLAN (no product/bicep code changed by this doc)
**Date:** 2026-06-17
**Author:** automated gate audit (Claude Opus 4.8)
**Scope:** every place CSA Loom surfaces a "you must set up / configure / provision X"
gate, mapped to the exact deploy-side fix so a clean deploy has **zero setup gates**.

---

## Operator mandate + architecture rule

> "Everything works day one; nothing unconfigured; no gates telling someone to go
> set something up."

Per `.claude/rules/no-fabric-dependency.md` + `no-vaporware.md`:

- The **Azure-native path is the DEFAULT** and **must be deployed + env-wired by the
  clean deploy**. Every Azure-native env-var gate is therefore a **bug to close** — the
  service the default path needs must be provisioned by `main.bicep` and its
  `LOOM_*` env var wired onto the `loom-console` Container App from the module output.
- Only **genuinely-optional Fabric / Power BI / premium-XMLA alternatives** stay
  opt-in. Those gates are **OK to keep** — they are reached only when the operator
  explicitly opts in (`LOOM_<ITEM>_BACKEND=fabric`, `LOOM_SEMANTIC_BACKEND=fabric`,
  `LOOM_POWERBI_XMLA_ENDPOINT`, `LOOM_FABRIC_SECURITY_ENABLED`, etc.).

## The pattern (the single most important finding)

The env-wiring already exists for almost every service. In `admin-plane/main.bicep`
the Console env var is wired conditionally from the module output, e.g.:

```bicep
{ name: 'LOOM_AI_SEARCH_SERVICE', value: !empty(existingAiSearchService)
    ? existingAiSearchService
    : (aiSearchEnabled ? aiSearch!.outputs.searchName : '') }
```

So a gate fires **only because the `*Enabled` deploy param defaults to `false`** (or is
left `false` even in `commercial-full.bicepparam`, the "everything enabled" file), which
makes the module not deploy, which makes the env var resolve to `''`, which makes the
provisioner/editor honest-gate. **In nearly every Azure-native case the fix is to flip
the `*Enabled` default ON** (and, for the handful that aren't passed through, add the
param passthrough so the wiring fires). Almost no code changes are required.

### Confirmed live exemplars (already validated)

| Service | Live symptom | Root cause | Status |
|---|---|---|---|
| AI Search | "Set LOOM_AI_SEARCH_SERVICE" | `aiSearchEnabled=false` even in `commercial-full.bicepparam`; `ai-search.bicep` exists + env-wiring exists | **OPEN — flip ON** |
| AI Foundry project | "no project configured" | project deploy/env wiring | mostly addressed via `aiFoundryEnabled=true` + `agentFoundryEnabled=true` in commercial-full |
| Event Hubs env-wiring | eventstream gate | env not wired to DLZ EH | **FIXED #1441** |
| Synapse SQL Admin | CREATE DATABASE 403 | UAMI not Synapse SQL admin | **FIXED #1444** |

---

## Classification summary

- **Azure-native gates to CLOSE (deploy must provision + wire):** ~46 distinct
  service gates (across provisioners, BFF routes, clients, editors).
- **Opt-in Fabric / Power BI / premium gates to KEEP:** ~12 distinct gates — all
  confined to explicit opt-in branches with an Azure-native default in the same code
  path. None gates the default path on `fabricWorkspaceId`. (Audit found **zero**
  default-path Fabric violations — consistent with `no-fabric-dependency.md`.)
- **Transient / content-validation gates (keep, not setup gates):** Synapse-pool
  resume, ADX async-create "Retry in a minute", "add a table to the model", "list
  source tables on the mirror item" — these are runtime/UX states, not deploy gates.

---

## SECTION A — Azure-native gates to CLOSE

Grouped by service. **Fix** column = the deploy-side change. Unless noted, the
`LOOM_*` env var is **already wired** from the module output in
`admin-plane/main.bicep`, so the only fix is the **deploy param to default ON**
(+ passthrough where missing).

### A1. Azure AI Search  — `aiSearchEnabled`

| Gate (message) | File:line | Env var | Bicep module | Deploy param | Fix |
|---|---|---|---|---|---|
| AI Search service not configured. Set LOOM_AI_SEARCH_SERVICE | provisioners/ai-search.ts:245 | LOOM_AI_SEARCH_SERVICE | admin-plane/ai-search.bicep | `aiSearchEnabled` (main.bicep:313, admin-plane:181) | **Flip `aiSearchEnabled=true` in commercial-full + main.bicep default.** Env wiring exists (main.bicep:2476). Grant Search Service Contributor to UAMI in ai-search.bicep RBAC. |
| Set LOOM_AI_SEARCH_SERVICE … to enable AI Search | app/api/admin/reindex-items/route.ts:32 | LOOM_AI_SEARCH_SERVICE | ai-search.bicep | `aiSearchEnabled` | same |
| Azure AI Search is not provisioned … | app/api/data-products/search/route.ts:50 | LOOM_AI_SEARCH_SERVICE | ai-search.bicep | `aiSearchEnabled` | same |
| AI Search not provisioned … | lib/azure/loom-search.ts:38; search-index-client.ts:55,59 | LOOM_AI_SEARCH_SERVICE | ai-search.bicep | `aiSearchEnabled` | same |
| Azure AI Search not provisioned (editor) | lib/editors/foundry-sub-editors.tsx:939; graph-editors.tsx:851,953 | LOOM_AI_SEARCH_SERVICE | ai-search.bicep | `aiSearchEnabled` | same |
| Azure AI Search not configured: set LOOM_AI_SEARCH_SERVICE | app/api/ai-search/synonymmaps/route.ts:23 | LOOM_AI_SEARCH_SERVICE | ai-search.bicep | `aiSearchEnabled` | same |
| AI Search not configured; Cosmos fallback | app/api/help-copilot/reindex/route.ts:26 | LOOM_AI_SEARCH_SERVICE | ai-search.bicep | `aiSearchEnabled` | same (non-blocking fallback, but closes the warning) |

> **#1 day-one fix.** One param flip clears 7+ surfaces. Module + RBAC + env-wiring all
> already exist.

### A2. Azure Analysis Services (semantic-model / BI backend) — `aasEnabled` / `deployAas`

AAS is the Azure-native default tabular engine (Loom-native is the no-infra default;
AAS is the Azure-native upgrade; Power BI/Fabric XMLA is the opt-in alternative).
**Critical wiring gap:** `aasEnabled` is **NOT passed from top-level `main.bicep` to
`admin-plane/main.bicep`** (admin-plane default stays `false`), so AAS never deploys
on the admin plane even if intended.

| Gate (message) | File:line | Env var | Bicep module | Deploy param | Fix |
|---|---|---|---|---|---|
| No Analysis-Services tabular engine configured. Set LOOM_AAS_SERVER … | lib/azure/aas-roles.ts:204 | LOOM_AAS_SERVER/LOOM_AAS_SERVER_NAME | admin-plane/analysis-services.bicep, aas.bicep, aas-server.bicep | `aasEnabled` (admin-plane:190) + `deployAas` (DLZ) | **Add `aasEnabled` passthrough in main.bicep → admin-plane and set `aasEnabled=true` in commercial-full.** Env wiring exists (admin-plane:2444/2591/2673/3059). |
| LOOM_AAS_XMLA_ENDPOINT not set — XMLA write not configured | lib/azure/aas-client.ts:113; aas-incremental-refresh.ts:96 | LOOM_AAS_XMLA_ENDPOINT | analysis-services.bicep | `aasEnabled` | same (wired admin-plane:2639/3004) |
| Set LOOM_AAS_SERVER … data-plane address | lib/azure/aas-xmla.ts:49 | LOOM_AAS_SERVER, LOOM_AAS_MODEL | aas.bicep | `aasEnabled` | same |
| Set LOOM_AAS_SERVER, LOOM_AAS_REGION, LOOM_AAS_MODEL (DirectQuery) | lib/azure/aas-client.ts:2408 | LOOM_AAS_* | aas-server.bicep | `aasEnabled` | same |
| env-pinned AAS server name required | lib/azure/aas-server-client.ts:107 | LOOM_AAS_SERVER_NAME, LOOM_AAS_REGION | aas-server.bicep | `aasEnabled` | same |
| Set LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_SERVER/DATABASE | app/api/items/semantic-model/[id]/model/route.ts:953,963 | LOOM_SEMANTIC_BACKEND, LOOM_AAS_SERVER, LOOM_AAS_DATABASE | analysis-services.bicep | `aasEnabled` + set `loomSemanticBackend=analysis-services` | flip backend + deploy AAS |
| Set LOOM_AAS_XMLA_ENDPOINT (Azure-native default) | semantic-model/workspace-pane/route.ts:75,256 | LOOM_AAS_XMLA_ENDPOINT | analysis-services.bicep | `aasEnabled` | same |
| Bind an Azure Analysis Services model | lib/editors/phase3-editors.tsx:15115; rayfin-app-editor.tsx:791 | LOOM_AAS_SERVER/DATABASE | analysis-services.bicep | `aasEnabled` | same |

> Note: AAS is unavailable in GCC-High/DoD (aas-client.ts:457, aas-roles.ts:193). In
> those clouds the documented honest fallback is Synapse Serverless / Loom-native —
> **keep** that boundary gate; close it for Commercial/GCC by enabling AAS.

### A3. Azure Managed Grafana (governance + usage embeds) — `managedGrafanaEnabled`

`managedGrafanaEnabled` passes through main.bicep → admin-plane but defaults `false`
and is **not set in commercial-full**. Endpoint env (`LOOM_GRAFANA_ENDPOINT`) is wired
from `grafana.properties.endpoint` (admin-plane:2850/2874) but dashboard UIDs
(`LOOM_GRAFANA_*_DASHBOARD_UID`) default empty.

| Gate | File:line | Env var | Bicep module | Deploy param | Fix |
|---|---|---|---|---|---|
| Set LOOM_GRAFANA_ENDPOINT + LOOM_GRAFANA_USAGE_DASHBOARD_UID | app/api/admin/usage/embed/route.ts:99 | LOOM_GRAFANA_ENDPOINT, LOOM_GRAFANA_USAGE_DASHBOARD_UID | admin-plane/monitoring.bicep (grafana) + grafana-rbac.bicep | `managedGrafanaEnabled` (main:175) + `loomGrafanaUsageDashboardUid` (main:184) | **Set `managedGrafanaEnabled=true` in commercial-full; provision + wire the usage dashboard UID** (or default the embed to the bundled dashboard). |
| Set LOOM_GRAFANA_ENDPOINT + LOOM_GRAFANA_DASHBOARD_UID | app/api/governance/govern/embed/route.ts:93 | LOOM_GRAFANA_ENDPOINT, LOOM_GRAFANA_DASHBOARD_UID | monitoring.bicep | `managedGrafanaEnabled` + `loomGrafanaDashboardUid` (main:193) | same |

### A4. Azure AI Content Safety — `contentSafetyEnabled`

Already `true` in commercial-full and passed through (main.bicep:842). Env wired
(admin-plane:3100). **Closed for commercial-full; flip main.bicep default ON** so
non-full param files also provision it (close at the default level).

| Gate | File:line | Env var | Bicep module | Deploy param | Fix |
|---|---|---|---|---|---|
| Set LOOM_CONTENT_SAFETY_ENDPOINT … | lib/azure/foundry-client.ts:985 | LOOM_CONTENT_SAFETY_ENDPOINT | admin-plane/ai-defense.bicep (ContentSafety) | `contentSafetyEnabled` (main:497) | already ON in commercial-full; **default ON in main.bicep** (keep DoD-region opt-out). |

### A5. Azure Maps (geo editors) — `azureMapsEnabled` (already ON)

`azureMapsEnabled=true` default (main:685, admin-plane:1897). Maps account +
`NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` secretRef wired (admin-plane:2549/2655). **Likely
already closed** — verify the secret is materialized on a clean deploy.

| Gate | File:line | Env var | Bicep module | Deploy param | Fix |
|---|---|---|---|---|---|
| Reverse-geocode requires Azure Maps | lib/editors/geo-editors.tsx:1003 | NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY | admin-plane/azure-maps.bicep | `azureMapsEnabled` (ON) | **Verify key secretRef populated**; no change expected. |

### A6. Cosmos Gremlin (graph editor) — `cosmosGraphVectorEnabled` (already ON)

`cosmosGraphVectorEnabled=true` (main:342) passes through; Gremlin endpoint wired from
the single-DLZ Cosmos (main:969, admin-plane:2542). **Likely already closed for
single-sub full deploy** — verify the Gremlin account capability is created.

| Gate | File:line | Env var | Bicep module | Deploy param | Fix |
|---|---|---|---|---|---|
| Cosmos Gremlin runtime not provisioned … | lib/azure/gremlin-client.ts:43 | LOOM_COSMOS_GREMLIN_ENDPOINT | landing-zone cosmos-graph-vector | `cosmosGraphVectorEnabled` (ON) | **Verify** endpoint non-empty on clean deploy; ensure UAMI Cosmos Data Contributor. |

### A7. Synapse (warehouse / serverless / spark / notebooks) — `loomSynapseEnabled` (ON)

`loomSynapseEnabled=true` (DLZ). The recurring `LOOM_SYNAPSE_WORKSPACE` /
`LOOM_SYNAPSE_DEDICATED_POOL` / `LOOM_SYNAPSE_SPARK_POOL` gates close when the DLZ
Synapse deploys AND the env is wired to the **DLZ** workspace AND the UAMI is Synapse
SQL admin (the #1444 fix family). **Cross-sub flag (see Section C):** these vars must
point at the **DLZ** Synapse, not the admin plane.

| Representative gates | File:line | Env var | Fix |
|---|---|---|---|
| Synapse dedicated pool not configured | provisioners/warehouse.ts:390 | LOOM_SYNAPSE_WORKSPACE, LOOM_SYNAPSE_DEDICATED_POOL | DLZ Synapse + dedicated pool deploy; wire DLZ env; UAMI SQL admin |
| No Synapse Serverless workspace configured | provisioners/synapse-serverless-sql-pool.ts:132 | LOOM_SYNAPSE_WORKSPACE | DLZ Synapse; UAMI Synapse SQL Administrator (RBAC) — see #1444 |
| Synapse Serverless rejected CREATE DATABASE | synapse-serverless-sql-pool.ts:211,455 | LOOM_UAMI_CLIENT_ID | **Grant UAMI Synapse SQL Administrator at deploy (#1444 durable fix)** |
| Set LOOM_SYNAPSE_WORKSPACE + DEDICATED_POOL (query/security/stats/DAB) | api/warehouse/query:38; items/[type]/[id]/sql-security:87,99; statistics:54; dab/sources:67,82 | LOOM_SYNAPSE_* | wire DLZ Synapse env + db_owner/SQL admin |
| Set LOOM_SYNAPSE_WORKSPACE + SPARK_POOL | items/materialized-lake-view/[id]/runs:32; notebook/[id]/execute-spark:122; lakehouse/load-to-table:123; lakehouse/schemas:52 | LOOM_SYNAPSE_WORKSPACE, LOOM_SYNAPSE_SPARK_POOL | deploy Synapse Spark pool (`deploySparkPool=true`); wire env; UAMI Synapse Compute Operator |
| Synapse pipeline not configured | provisioners/synapse-pipeline.ts:73 | LOOM_SYNAPSE_WORKSPACE | wire DLZ Synapse; UAMI Synapse Artifact Publisher + Compute Operator |
| Notebook: no Synapse/Databricks engine | provisioners/notebook.ts:339 | LOOM_SYNAPSE_WORKSPACE / LOOM_DATABRICKS_HOSTNAME | one of the two engines wired (both ON by default) |

### A8. Azure Databricks — `loomDatabricksEnabled` (ON) + SCIM bootstrap

`loomDatabricksEnabled=true`. `LOOM_DATABRICKS_HOSTNAME` must be wired from the DLZ
Databricks workspace output, AND the Console UAMI must be SCIM-bootstrapped into the
workspace (workspace-user/admin) — the recurring Databricks remediation.

| Representative gates | File:line | Env var | Fix |
|---|---|---|---|
| Databricks workspace not configured | provisioners/databricks-job.ts:230; databricks-notebook.ts:40; ml-model.ts:191; mirrored-databricks.ts:49 | LOOM_DATABRICKS_HOSTNAME | wire DLZ Databricks hostname env |
| Databricks SCIM/import/run not authorized | databricks-job.ts:274,311,339; ml-model.ts:240,269; notebook.ts:301 | LOOM_UAMI_CLIENT_ID | **Add a deploy-time SCIM bootstrap** that adds the Console UAMI as workspace admin (deploymentScript), so import/run work day one |
| Set LOOM_DATABRICKS_HOSTNAME (editors/scaling/workspace) | api/databricks/workspace:27; scaling/databricks-warehouse:28; editors/databricks-editors.tsx:4665; spark-config-client.ts:85 | LOOM_DATABRICKS_HOSTNAME | wire env |
| Set LOOM_DATABRICKS_ACCOUNT_ID (UC metastore attach) | api/catalog/metastores:166 | LOOM_DATABRICKS_ACCOUNT_ID | wire from `LOOM_DATABRICKS_ACCOUNT_ID` deploy env (commercial-full sources it) |

> Boundary keep: Databricks unavailable in GCC-High/DoD (spark-config-client.ts:75) —
> Synapse Spark is the documented fallback. Keep that boundary gate.

### A9. Azure Data Factory (pipelines / mirroring / ingest) — `loomDataFactoryEnabled` (ON)

`loomDataFactoryEnabled=true`. `LOOM_ADF_NAME`+`LOOM_DLZ_RG`+`LOOM_SUBSCRIPTION_ID` must
be wired to the DLZ ADF, and UAMI granted Data Factory Contributor.

| Representative gates | File:line | Env var | Fix |
|---|---|---|---|
| ADF not configured | provisioners/adf-pipeline.ts:69; mirrored-database.ts:62 | LOOM_ADF_NAME, LOOM_DLZ_RG, LOOM_SUBSCRIPTION_ID | wire DLZ ADF env; UAMI Data Factory Contributor |
| Set LOOM_ADF_NAME … (publish/import/triggers/MLV/ingest) | items/data-pipeline/[id]/publish:63; data-pipeline/import:156; adf/triggers:32; materialized-lake-view/[id]/adf-pipeline:50; semantic-model/[id]/ingest:172 | LOOM_ADF_NAME, LOOM_DLZ_RG, LOOM_SUBSCRIPTION_ID | same |

### A10. Azure OpenAI / AI Foundry (copilot personas, prompt-flow, eval) — `aiFoundryEnabled`/`agentFoundryEnabled` (ON in commercial-full)

`aiFoundryEnabled=true` + `agentFoundryEnabled=true` in commercial-full wire
`LOOM_AOAI_*` / `LOOM_FOUNDRY_PROJECT_*`. **Mostly closed**; flip defaults ON in
main.bicep so non-full files also close.

| Representative gates | File:line | Env var | Fix |
|---|---|---|---|
| Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT | governance/govern/copilot:65; dashboard tile-query:154; ai-function:98; describe-bulk:384; copilot-structure:304; ai-functions:70; editors ai-functions-helper.tsx:291 + phase3-editors many | LOOM_AOAI_ENDPOINT, LOOM_AOAI_DEPLOYMENT | already wired when `aiFoundryEnabled=true`; **default ON in main.bicep** |
| No AI Foundry project configured | provisioners/prompt-flow.ts:79; evaluation.ts:66 | LOOM_FOUNDRY_PROJECT (+ EVAL_DATASET/DEPLOYMENT) | `agentFoundryEnabled` deploys + wires project; grant UAMI AzureML Data Scientist; for eval, register/wire an eval dataset+deployment or keep read-only honest state |
| Set LOOM_AZURE_OPENAI_ENDPOINT (SQL copilot) | items/azure-sql-database/[id]/copilot:86 | LOOM_AZURE_OPENAI_ENDPOINT | alias-wire to AOAI endpoint |
| Set LOOM_FOUNDRY_PROJECT_ENDPOINT + ID (aip-logic) | items/aip-logic/[id]/run-agent:69; deploy:158 | LOOM_FOUNDRY_PROJECT_ENDPOINT, LOOM_FOUNDRY_PROJECT_ID | wire from foundry project output |
| Foundry Hub infra not provisioned | lib/editors/foundry-hub-editor.tsx:117 | (foundry) | `aiFoundryEnabled` |
| Azure ML compute-instance Jupyter not configured | lib/clients/jupyter-server-client.ts:76 | LOOM_AML_*/LOOM_FOUNDRY_* | `mlWorkspaceEnabled=true` (commercial-full) wires AML; verify compute instance |
| Set LOOM_AML_INSTANCE + LOOM_AML_WORKSPACE_ID (VS Code deep link) | api/notebook/[id]/lsp:41 | LOOM_AML_INSTANCE, LOOM_AML_WORKSPACE_ID | wire from AML workspace output |
| MLflow tracking not configured | lib/editors/ml-experiment-editor.tsx:267 | LOOM_MLFLOW_TRACKING_URI | wire AML MLflow tracking URI |
| Set LOOM_FOUNDRY_NAME (scaling) | api/admin/scaling/foundry-compute:26 | LOOM_FOUNDRY_NAME | wire from foundry output |

### A11. Microsoft Purview — `purviewEnabled` (ON by default, opt-out)

`purviewEnabled=true` (commercial-full sources `LOOM_PURVIEW_ENABLED` default true).
Provisions classic Data Map; wire `LOOM_PURVIEW_ACCOUNT`. **Mostly closed** — verify
`LOOM_PURVIEW_ACCOUNT` is wired from the catalog.bicep output and UC endpoint vars are
set for the data-product path.

| Representative gates | File:line | Env var | Fix |
|---|---|---|---|
| Purview not provisioned (LOOM_PURVIEW_ACCOUNT unset) | api/items/data-product/[id]/register-purview:16; data-products/[id]/glossary-terms:87; health-actions:65; lib/azure/purview-client.ts:109; many editors (apim-editors.tsx:2608+, data-product-detail.tsx) | LOOM_PURVIEW_ACCOUNT | verify wired from admin-plane/catalog.bicep when `purviewEnabled=true` |
| Purview Unified Catalog endpoint not configured | provisioners/data-product.ts:135,149 | LOOM_PURVIEW_UC_ENDPOINT/ACCOUNT, LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID | wire UC endpoint; **bootstrap a published governance domain at deploy** (deploymentScript) + grant UAMI Data Product Owner + Data Steward |
| Set LOOM_PURVIEW_ACCOUNT (CDEs/sensitivity/onelake governance) | data-products/[id]/cdes:54; items/[type]/[id]/sensitivity:102; onelake/governance:249 | LOOM_PURVIEW_ACCOUNT | same as above |

### A12. Azure Event Hubs / Stream Analytics / Event Grid — `loomEventHubEnabled` (ON), `eventGridEnabled` (off)

| Gate | File:line | Env var | Bicep | Deploy param | Fix |
|---|---|---|---|---|---|
| Event Hubs namespace not configured | provisioners/eventstream.ts:62 | LOOM_EVENTHUBS_NAMESPACE | landing-zone event hubs | `loomEventHubEnabled` (ON) | env-wiring **FIXED #1441**; verify; UAMI EH Data Owner |
| Event Grid topics not configured | api/business-events/topics:33 | LOOM_EVENTGRID_SUB, LOOM_EVENTGRID_RG | (event grid) | `eventGridEnabled` (main:479=false) | **Flip `eventGridEnabled=true`** (business-events default path) + wire sub/rg |
| Business-event registry not configured | api/business-events/types:35 | LOOM_COSMOS_ENDPOINT | console cosmos | `loomConsoleCosmosEnabled` (ON) | verify Cosmos endpoint wired |

### A13. APIM (marketplace / policy) — `apimEnabled` (ON)

`apimEnabled=true`. Wire `LOOM_APIM_NAME`+`LOOM_APIM_RG`+`LOOM_SUBSCRIPTION_ID`; UAMI
API Management Service Contributor.

| Gate | File:line | Env var | Fix |
|---|---|---|---|
| APIM not provisioned (marketplace gate) | api/marketplace/_gate.ts:40 | LOOM_APIM_NAME, LOOM_SUBSCRIPTION_ID | wire from apim.bicep output |
| Set LOOM_APIM_NAME + RG + SUB (policy) | api/items/apim-policy:28; scaling/apim:32; editors apim-editors.tsx:2169,1041 | LOOM_APIM_NAME, LOOM_APIM_RG, LOOM_SUBSCRIPTION_ID | same |

### A14. Data API Builder (DAB) — `dabRuntimeEnabled` (ON)

`dabRuntimeEnabled=true`. Wire `LOOM_DAB_PREVIEW_URL` from `dab-runtime.bicep` output.

| Gate | File:line | Env var | Fix |
|---|---|---|---|
| DAB runtime not provisioned (set LOOM_DAB_PREVIEW_URL) | api/dab/[id]/publish:38; preview/schema:20; editors/data-api-builder-editor.tsx:1340 | LOOM_DAB_PREVIEW_URL | verify wired from dab-runtime.bicep |

### A15. Setup Orchestrator / built-in MCP / MCP bridge — `setupOrchestratorEnabled` (ON), `loomApimEnabled`/builtin-mcp

| Gate | File:line | Env var | Fix |
|---|---|---|---|
| Setup Orchestrator not deployed | api/setup/deploy-status:38; deploy:686,694 | LOOM_SETUP_ORCHESTRATOR_URL | `setupOrchestratorEnabled=true` (commercial-full); verify URL wired from setup-orchestrator.bicep |
| Loom built-in MCP server / bridge not provisioned | api/admin/mcp-servers/builtin:28; bridge:42 | (mcp env) | verify builtin-mcp.bicep + mcp-catalog-app.bicep deploy + wire on full deploy |
| Console not wired to ACA managed env / no MCP UAMI | api/admin/mcp-servers/deploy:177,187 | LOOM_ACA_ENV_ID, LOOM_MCP_CATALOG_UAMI_ID | wire from container-platform.bicep + mcp-catalog-rbac.bicep |

### A16. Logic Apps (report subscriptions + approval activity) — `reportSubscriptionsEnabled` (off)

| Gate | File:line | Env var | Bicep | Deploy param | Fix |
|---|---|---|---|---|---|
| Report subscriptions delivery gate | (report-subscriptions UI; integration module) | LOOM_SUBSCRIPTION_LOGIC_APP_NAME | integration/report-subscription-logicapp.bicep | `reportSubscriptionsEnabled` (admin-plane:163=false) | **Flip `reportSubscriptionsEnabled=true`** + wire name |
| Approval Logic App 503 | api/items/data-pipeline/[id]/approval-logicapp:116,122 | LOOM_APPROVAL_LOGIC_APP_RG/NAME, LOOM_DLZ_RG | integration/approval-logicapp.bicep | (deployed by convention) | deploy approval-logicapp + wire RG/name |
| Azure Logic Apps target not configured | provisioners/logic-app.ts:170 | LOOM_LOGIC_SUB/RG/LOCATION | (DLZ Logic Apps) | `logicAppsEnabled` (main:525=false) | wire DLZ sub/rg/location; UAMI Logic App Contributor |

### A17. Azure Deployment Environments / DevCenter (release-environment) — `devCenter` (no module wired)

| Gate | File:line | Env var | Bicep | Fix |
|---|---|---|---|---|
| Set LOOM_DEVCENTER_PROJECT … | lib/editors/palantir-editors.tsx:859 | LOOM_DEVCENTER_PROJECT | admin-plane/devcenter.bicep (exists, **not wired into orchestrator**) | **Add a `devCenterEnabled` toggle + wire devcenter.bicep into admin-plane/main.bicep**, default ON, env `LOOM_DEVCENTER_PROJECT` from output |

### A18. ADX (kql-db / dashboard / eventhouse export / workspace-monitor) — `adxEnabled` (ON)

`adxEnabled=true`. Wire `LOOM_KUSTO_CLUSTER_URI`+`LOOM_KUSTO_CLUSTER_NAME`; grant UAMI
Contributor (ARM) + AllDatabasesAdmin (data-plane principal assignment) at deploy.

| Representative gates | File:line | Env var | Fix |
|---|---|---|---|
| ADX cluster not configured | provisioners/kql-db.ts:323; kql-dashboard.ts:224; workspace-monitor.ts:387 | LOOM_KUSTO_CLUSTER_URI, LOOM_KUSTO_CLUSTER_NAME | wire shared ADX env; **grant UAMI AllDatabasesAdmin via cluster-principal-assignment at deploy** (adx-cluster.bicep) |
| ADX not configured (dashboard tile-query) | api/items/dashboard/[id]/tile-query:219 | LOOM_KUSTO_CLUSTER_URI | same |
| Set LOOM_RTI_EXPORT_ADLS (continuous export) | items/eventhouse/[id]/continuous-export:220; editors phase3:2911 | LOOM_RTI_EXPORT_ADLS | wire DLZ ADLS account name |

### A19. ADLS Gen2 / lakehouse (DLZ storage) — `loomSynapseEnabled` family (ON)

The DLZ storage URLs must be wired and the UAMI granted Storage Blob Data Contributor.

| Representative gates | File:line | Env var | Fix |
|---|---|---|---|
| No internal DLZ ADLS container configured | provisioners/lakehouse.ts:609 | LOOM_LANDING_URL/BRONZE/SILVER/GOLD_URL | wire DLZ storage container URLs from landing-zone storage.bicep output |
| Set LOOM_BRONZE/SILVER/GOLD/LANDING_URL (maintenance/onelake/semantic ingest) | api/lakehouse/maintenance:90; onelake/storage:136; onelake/lifecycle:85; onelake/security:209; semantic-model/[id]/ingest:182 | LOOM_*_URL, LOOM_SUBSCRIPTION_ID, LOOM_DLZ_RG | wire DLZ storage env; UAMI Storage Blob Data Contributor (+ RBAC Admin constrained for access matrix) |
| Set LOOM_ADLS_ACCOUNT (shortcuts/mirror Bronze) | api/lakehouse/shortcuts:92; provisioners/mirrored-database.ts:92 | LOOM_ADLS_ACCOUNT | wire DLZ storage account name |
| Set LOOM_SAMPLE_ADLS / LOOM_CSV_IMPORTS_URL | items/data-pipeline/practice-seed:125; data-products/import:120 | LOOM_SAMPLE_ADLS, LOOM_CSV_IMPORTS_URL | wire DLZ sample/imports containers |

### A20. Cross-cutting Console env (subscription / RGs / identity / tenant-admin)

These are wired by `admin-plane/main.bicep` from deploy params; gate fires only if the
deploy param is empty. **Ensure all are populated at deploy.**

| Gate | File:line | Env var | Fix |
|---|---|---|---|
| Set LOOM_SUBSCRIPTION_ID (+ RGs) | api/admin/overview:76; azure-resources:49; azure/function-apps:67; rti-hub:109; release-environment/[id]/arm:24; clients/azure-connections-client.ts:261; networking-client.ts:77 | LOOM_SUBSCRIPTION_ID, LOOM_*_RG | wire from deployment context (always available) |
| Container Apps / AKS write path not configured | api/admin/env-config:248,254 | LOOM_ACA_RG/LOOM_AKS_*; LOOM_ADMIN_RG | wire admin RG + ACA env |
| Set LOOM_TENANT_ADMIN_OID / GROUP_ID | api/admin/dspm-ai:39; governance/posture:44; self-audit:46 | LOOM_TENANT_ADMIN_OID, LOOM_TENANT_ADMIN_GROUP_ID | deploy param already exists — **pass the deployer OID / admin group at deploy** |
| Could not resolve Console UAMI principal id | clients/azure-connections-client.ts:303 | LOOM_UAMI_PRINCIPAL_ID | wire from identity.bicep output (admin-plane/main.bicep) |
| Set LOOM_IDENTITY_PICKER_ENABLED / LOOM_MIP_ENABLED / LOOM_WORKSPACE_M365_LINK | api/admin/overview:74,78; workspaces/[id]/m365:90; export-check:80 | LOOM_IDENTITY_PICKER_ENABLED, LOOM_MIP_ENABLED, LOOM_WORKSPACE_M365_LINK | these require **Graph admin-consent** (one-time tenant action) — **honest tenant-gate, keep** but document in bootstrap; flip env defaults where Graph grant is deploy-scripted |
| Log Analytics workspace id not set | api/admin/refresh-summary:365; monitor/activities:72 | LOOM_LOG_ANALYTICS_WORKSPACE_ID | wire from monitoring.bicep output |

### A21. Other Azure-native services (verify wired or flip ON)

| Gate | File:line | Env var | Deploy param / module | Fix |
|---|---|---|---|---|
| Cosmos account not configured (scaling/metrics) | api/admin/scaling/cosmos:25; items/cosmos-db/[id]/metrics:39 | LOOM_COSMOS_ENDPOINT, LOOM_COSMOS_ACCOUNT(_RG) | `loomConsoleCosmosEnabled` (ON) | wire endpoint/account env |
| Key Vault not configured (CMK / connect-source) | clients/cmk-client.ts:163,172,181,312; realtime-hub/connect-source:107 | LOOM_KEY_VAULT_URI/NAME, LOOM_UAMI_RESOURCE_ID | keyvault.bicep (deployed) | wire KV URI + UAMI resource id; grant KV roles |
| Paginated report renderer not deployed | lib/azure/paginated-report-client.ts:183; editors phase3:15419 | LOOM_PAGINATED_RENDER_URL | azure-functions/paginated-report-renderer | deploy the function + wire URL (or keep as documented optional export feature) |
| Posture-refresh function not provisioned | api/governance/govern/refresh:45 | LOOM_POSTURE_FUNCTION_URL | azure-functions/posture-refresh | deploy + wire |
| Org-visuals embed not configured | clients/embed-codes-client.ts:31 | LOOM_ORG_VISUALS_URL | `loomOrgVisualsEnabled` (ON) | wire org-visuals storage URL |
| Custom domain images not wired | api/admin/domains/images:52 | LOOM_DOMAIN_IMAGE_STORAGE | (storage container) | wire a domain-images container URL (or keep optional branding feature) |
| Atlas lineage endpoint not set | api/items/[type]/[id]/lineage:70 | LOOM_ATLAS_ENDPOINT, LOOM_DATABRICKS_HOSTNAMES | admin-plane/catalog.bicep (atlasEndpoint) | wire atlasEndpoint output |
| Dataverse / Copilot Studio creds not set | api/powerplatform/tables:103; items/dataverse-table/[id]/columns:46; power-automate-flow/[id]/definition:49; data-agent/[id]/m365-copilot:93 | LOOM_DATAVERSE_*, LOOM_COPILOT_STUDIO_ENVIRONMENT_ID | (external Power Platform) | **honest external-tenant gate** — requires an operator-provided Dataverse SP + environment; document in bootstrap, keep gate (no Azure resource Loom can self-provision) |

---

## SECTION B — Opt-in Fabric / Power BI / premium gates to KEEP

All confined to explicit opt-in branches; each has an Azure-native default in the same
code path. **Do NOT close these** — closing would force a Fabric/Power BI dependency,
violating `no-fabric-dependency.md`.

| Gate | File:line | Opt-in toggle | Azure-native default in same path |
|---|---|---|---|
| Fabric Activator | provisioners/activator.ts:201 | LOOM_ACTIVATOR_BACKEND=fabric | Azure Monitor scheduled-query alert |
| Fabric Data pipeline | data-pipeline.ts:132,151 | LOOM_PIPELINE_BACKEND=fabric | Synapse pipeline |
| Fabric Eventstream | eventstream.ts:169,205; rti-hub:340; realtime-hub/connect-source:67 | LOOM_EVENTSTREAM_BACKEND=fabric | Azure Event Hubs |
| Fabric Real-Time Dashboard | kql-dashboard.ts:308,339,372 | bound fabricWorkspaceId | Loom-native dashboard over ADX |
| OneLake lakehouse | lakehouse.ts:875,903,961 | LOOM_LAKEHOUSE_BACKEND=fabric | ADLS Gen2 + Delta |
| Fabric Mirroring | mirrored-database.ts:306,353 | LOOM_MIRROR_BACKEND=fabric | ADF CDC → ADLS Bronze (default `adf-cdc`) |
| Fabric notebook | notebook.ts:380 | LOOM_NOTEBOOK_BACKEND=fabric | Synapse / Databricks |
| Power BI report | report.ts:291,302,326,361 | semanticBackend=powerbi | Loom-native report renderer |
| Power BI / Fabric semantic model | semantic-model.ts:404,417,449,604; api semantic-model/[id]/model:569; workspace-pane:239 | LOOM_SEMANTIC_BACKEND=fabric / LOOM_DEFAULT_POWERBI_WORKSPACE | Loom-native tabular / AAS |
| Fabric Warehouse (preview) | warehouse.ts:533,543 | LOOM_WAREHOUSE_BACKEND=fabric-warehouse | Synapse dedicated SQL pool |
| Power BI Premium XMLA / Direct Lake shim | aas-client.ts:1334,1496,890,1921,1931; aas-roles.ts:204; editors phase3:11731,13522 | LOOM_POWERBI_XMLA_ENDPOINT / LOOM_DIRECT_LAKE_SHIM_ENABLED | Azure Analysis Services (Section A2) |
| Fabric security sync / OneLake ACL | items/[type]/[id]/security-roles:81,283; onelake/storage:136 | LOOM_FABRIC_SECURITY_ENABLED | ADLS POSIX ACL path is default |

---

## SECTION C — Cross-sub (dlz-attach) env-wiring flags

Per the live findings (EH #1441 / Synapse SQL #1444): in `dlz-attach` topology the
Console runs in the admin plane but the data services live in the **DLZ subscription**.
Every DLZ-resource env var must point at the **DLZ**, not the admin plane, or it
resolves empty/wrong and the editor honest-gates. Audit these explicitly:

| Env var | Must point at | Source (DLZ output) | Risk |
|---|---|---|---|
| LOOM_SYNAPSE_WORKSPACE / DEDICATED_POOL / SPARK_POOL | DLZ Synapse | landing-zone/synapse.bicep | empty-or-admin when should-be-DLZ |
| LOOM_DATABRICKS_HOSTNAME / ACCOUNT_ID | DLZ Databricks | landing-zone databricks | empty-or-admin |
| LOOM_ADF_NAME + LOOM_DLZ_RG + LOOM_SUBSCRIPTION_ID | DLZ ADF + DLZ sub | landing-zone ADF | **LOOM_SUBSCRIPTION_ID must be DLZ sub for data ops, admin sub for admin ops** — verify per-route |
| LOOM_ADLS_ACCOUNT / LOOM_*_URL | DLZ storage | landing-zone/storage.bicep | empty-or-admin |
| LOOM_EVENTHUBS_NAMESPACE | DLZ Event Hubs | landing-zone EH | **FIXED #1441** |
| LOOM_KUSTO_CLUSTER_URI / NAME | shared admin-plane ADX (by design) | admin-plane/adx-cluster.bicep | OK at admin plane; verify principal-assignment cross-sub |
| LOOM_COSMOS_ENDPOINT (data registries) | DLZ or console Cosmos | per-feature | verify which Cosmos each feature targets |
| LOOM_DLZ_RG | DLZ resource group | dlz-attach deploy | must be DLZ RG, not admin RG |
| Console UAMI grants (SQL admin, Storage Blob Data Contributor, EH Data Owner, ADX AllDatabasesAdmin, Synapse roles) | DLZ resources | dlz-attach-itemcreate-rbac.bicep / per-service rbac | cross-sub role assignment must target DLZ scope (#1444 family) |

---

## SECTION D — Prioritized default-deploy change checklist

For the follow-up bicep PR. Ordered by blast radius.

### D1. Flip these `*Enabled` param defaults ON (commercial-full + main.bicep default)

1. **`aiSearchEnabled = true`** — clears 7+ AI Search surfaces (A1). Highest ROI.
2. **`aasEnabled = true`** + **add `aasEnabled` passthrough main.bicep → admin-plane**
   — clears 8 semantic-model/BI surfaces (A2). (Keep `false` for GCC-High/DoD.)
3. **`managedGrafanaEnabled = true`** + provision/wire the 2 dashboard UIDs (A3).
4. **`contentSafetyEnabled = true`** as main.bicep default (already ON in
   commercial-full) (A4). Keep DoD-region opt-out.
5. **`aiFoundryEnabled = true` + `agentFoundryEnabled = true`** as main.bicep defaults
   (already ON in commercial-full) — closes Copilot/Foundry surfaces in non-full files
   (A10).
6. **`eventGridEnabled = true`** + wire LOOM_EVENTGRID_SUB/RG (A12).
7. **`reportSubscriptionsEnabled = true`** + wire delivery Logic App name (A16).
8. **Add `devCenterEnabled` toggle**, wire `devcenter.bicep` into admin-plane, default
   ON, env `LOOM_DEVCENTER_PROJECT` from output (A17).
9. **`logicAppsEnabled = true`** (DLZ) + wire approval Logic App (A16).

### D2. Wire these env vars from existing module outputs (verify on clean deploy)

- LOOM_GRAFANA_*_DASHBOARD_UID (from monitoring/grafana dashboards)
- LOOM_DEVCENTER_PROJECT (from devcenter.bicep)
- LOOM_PURVIEW_UC_ENDPOINT + LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID (bootstrap a domain)
- LOOM_ATLAS_ENDPOINT (catalog.bicep atlasEndpoint)
- LOOM_DAB_PREVIEW_URL, LOOM_SETUP_ORCHESTRATOR_URL, LOOM_ACA_ENV_ID,
  LOOM_MCP_CATALOG_UAMI_ID (verify on full deploy)
- LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID (pass deployer OID / admin group)
- LOOM_UAMI_PRINCIPAL_ID / LOOM_UAMI_RESOURCE_ID (from identity.bicep)
- LOOM_KEY_VAULT_URI (from keyvault.bicep) + KV role grants
- LOOM_AML_INSTANCE / LOOM_AML_WORKSPACE_ID / LOOM_MLFLOW_TRACKING_URI,
  LOOM_FOUNDRY_NAME (from AML/Foundry outputs)
- LOOM_SAMPLE_ADLS / LOOM_CSV_IMPORTS_URL / LOOM_RTI_EXPORT_ADLS / LOOM_*_URL /
  LOOM_ADLS_ACCOUNT (from DLZ storage outputs)

### D3. Add deploy-time RBAC + bootstrap grants for the Console UAMI

So provisioners run day one without a "grant X role" remediation:

- Search Service Contributor (AI Search) — ai-search.bicep
- Synapse SQL Administrator + Artifact Publisher + Compute Operator (Synapse) —
  #1444 durable fix; pass UAMI appId at deploy
- Storage Blob Data Contributor (+ constrained RBAC Admin) on DLZ storage
- Event Hubs Data Owner (#1441 family)
- ADX AllDatabasesAdmin via cluster-principal-assignment + Contributor (ARM)
- Data Factory Contributor (ADF)
- AzureML Data Scientist (Foundry/AML projects)
- Monitoring Contributor (Activator alerts)
- Logic App Contributor + Operator
- **Databricks SCIM bootstrap** — add the Console UAMI as workspace admin via
  deploymentScript so notebook/job import + run work day one
- AAS server admin (AAS) — for Commercial/GCC
- KV Crypto Service Encryption User / Secrets Officer (CMK / connect-source)
- API Management Service Contributor (APIM)
- **Purview** Governance Domain bootstrap + Data Product Owner + Data Steward

### D4. Keep these honest gates (document in bootstrap, do not "close")

- Graph admin-consent features: LOOM_IDENTITY_PICKER_ENABLED, LOOM_MIP_ENABLED,
  LOOM_DLP_*, LOOM_WORKSPACE_M365_LINK — one-time tenant admin consent.
- External Power Platform / Dataverse / Copilot Studio creds — operator-provided SP.
- GCC-High/DoD boundary fallbacks (AAS, Databricks, GitHub, Content Safety regions).
- All Section B Fabric/Power BI opt-in gates.
- Transient runtime gates (pool resume, ADX async-create retry, "add a table/source").

---

## Verification (per `no-vaporware.md`)

A follow-up bicep PR is "done" only when a clean
`az deployment sub create -f platform/fiab/bicep/main.bicep -p commercial-full.bicepparam`
(with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**) lands a Console where **every editor in
the catalog renders + executes its primary action against real Azure backends**, with
zero "set up / configure / provision X" gates — except the Section D4 documented honest
tenant/boundary/opt-in gates.
