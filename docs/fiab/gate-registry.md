# CSA Loom gate registry (G2) — complete inventory of every configuration gate

> Deliverable for platform requirement **G2: zero day-one gates** — where a gate is
> unavoidable it has (a) an inline **Fix it** wizard, (b) Copilot discoverability +
> resolution, (c) a complete admin registry of 100 % of gates / required settings /
> runtime options.

## How gates work (one contract)

- **Producers** — ~46 per-client `*ConfigGate()` helpers in `lib/azure/*` +
  `lib/clients/*` return `{ missing: 'LOOM_X' }` (or `null` when configured).
- **BFF** — routes translate a non-null gate into
  `503 { ok:false, code:'<x>_not_configured', missing, error }`.
- **UI** — surfaces render an honest `intent="warning"` MessageBar naming the
  exact env var / role / bicep module (per `no-vaporware.md`).
- **Declarative source of truth** — `lib/admin/self-audit.ts:ENV_CHECKS`
  (title, category, severity, required/anyOf keys, remediation, `provisionedBy`
  bicep module, RBAC `role`, `derived`, `optionalDefault`).

## What G2 adds (this change)

| Piece | Where |
|---|---|
| Central typed registry (id, surfaces, required settings, fix-it kind, ARM options-loader, canAutoResolve) | `lib/gates/registry.ts` — **derived from ENV_CHECKS**, enriched via `GATE_META`; a unit test forbids drift |
| Registry + live status API (ONE call evaluates every gate) | `GET /api/admin/gates` |
| Real ARM discovery for Fix-it pickers (Synapse workspaces, AOAI accounts **and deployments**, EH namespaces, AI Search services, Purview accounts, …) | `GET /api/admin/gates/[id]/options` |
| Fix-it apply — **the same audited env-config write path** (ACA revision roll / AKS rolling update + Cosmos desired-state + audit + SIEM), never a side channel | `POST /api/admin/gates/[id]/resolve` → `lib/admin/env-apply.ts` (shared with `PUT /api/admin/env-config`) |
| Shared gate component + Fix-it wizard dialog (generalizes `purview-gate.tsx`) | `lib/components/shared/honest-gate.tsx` |
| Complete admin registry page (live status, filters, one-click Fix-it) | `/admin/gates` (`app/admin/gates/page.tsx`) |
| Copilot tools: `loom_list_gates` / `loom_explain_gate` / `loom_resolve_gate` (write-gated by the `admin.env-config` Admin capability) | `lib/azure/copilot-orchestrator.ts` |
| Wave-3 ENV_CHECKS expansion: **40 formerly-bespoke gates promoted** into the declarative registry (making their env vars editable on `/admin/env-config` too) | `lib/admin/self-audit.ts` |

**Honesty note on apply latency:** `process.env` is the live config; applying a
value rolls a **new container revision (~1–2 min)**. The wizard says so and
re-probes the gate until the revision lands — it never fakes an instant flip.
A few backend-selector settings (`LOOM_BI_BACKEND`, `LOOM_SEMANTIC_BACKEND`,
Azure Maps account) already have instant per-tenant runtime overrides via the
platform-settings store — good candidates to migrate more high-traffic keys to
later (tracked below).

## The registry — every gate

Legend: **auto** = auto-resolved by a push-button deploy (bicep `derived`) or
the unset state is the fully-functional default (`optionalDefault`) — **zero
day-one operator input**. **fix-it** = `env-picker` (typed value w/ hint),
`resource-picker` (live ARM discovery), `role-grant` (one-time RBAC/Graph
grant), `wizard` (multi-setting flow).

### Identity / data-plane (deploy wires these; critical)

| gate id | required settings | surfaces | fix-it | auto |
|---|---|---|---|---|
| `session-secret` | `SESSION_SECRET` | sign-in (session minting) | env-picker | deploy default (per-RG GUID) |
| `entra-app` | `LOOM_MSAL_CLIENT_ID` + `_SECRET`, tenant id | sign-in (MSAL) | wizard (bootstrap re-run) | deploy (loomMsalAppRegEnabled) |
| `uami` | `LOOM_UAMI_CLIENT_ID` | every Azure data-plane call | env-picker | deploy (auto-derived) |
| `cosmos-config` | `LOOM_COSMOS_ENDPOINT` | the Loom store (everything) | resource-picker | deploy |
| `svc-cosmos-control` | `LOOM_COSMOS_ACCOUNT` (+RG) | scaling, CMK, version restore | resource-picker | — |
| `subscription` | `LOOM_SUBSCRIPTION_ID`, RG | ARM discovery, scaling, navigators | env-picker | deploy (auto-derived) |
| `bootstrap-admin` | `LOOM_TENANT_ADMIN_OID` \| `_GROUP_ID` | admin portal first-admin | env-picker | deploy param |
| `domain-routing` | multi-sub DLZ RBAC | domain-scoped item creates | role-grant | single-sub: yes |

### Azure services (each editor's backend)

| gate id | required settings | surfaces | fix-it | auto |
|---|---|---|---|---|
| `svc-synapse` | `LOOM_SYNAPSE_WORKSPACE` (+dedicated pool) | warehouse, notebooks, pipelines, serverless SQL (~20 routes) | resource-picker | deploy |
| `svc-synapse-spark-pool` | `LOOM_SYNAPSE_SPARK_POOL` | ML predict, scheduled runs | env-picker | deploy |
| `svc-adx` | `LOOM_KUSTO_CLUSTER_URI` (+default DB) | KQL DB, eventhouse, RT dashboards, graph (~8) | resource-picker | deploy (adxEnabled) |
| `svc-eventhubs` | `LOOM_EVENTHUB_NAMESPACE` | eventstream, EH navigator (~4) | resource-picker | deploy |
| `svc-eh-schema-registry` | `LOOM_EH_SCHEMA_GROUP` | event-schema-set | env-picker | — |
| `svc-adls` | `LOOM_ADLS_ACCOUNT` \| landing/bronze URLs | lakehouse, OneLake, mirror Bronze (~3+) | resource-picker | deploy |
| `svc-medallion-layers` | `LOOM_SILVER_URL` / `LOOM_GOLD_URL` | direct-lake, dataflow runs, onelake paths | env-picker | deploy (derived from account) |
| `svc-aisearch` | `LOOM_AI_SEARCH_SERVICE` | AI Search navigator, RAG, index-my-data (~15) | resource-picker | deploy (aiSearchEnabled) |
| `svc-aoai` | `LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT` | Copilot, help agent, AI functions, notebook assist (~8+) | resource-picker (accounts **and** deployments) | deploy (agentFoundryEnabled) |
| `svc-aoai-embeddings` | `LOOM_AOAI_EMBED_DEPLOYMENT` | index-my-data, vector search | resource-picker (deployments) | deploy |
| `svc-ai-enrich` | per-service cognitive endpoints | pipeline AI activities | env-picker | **yes** (shared Foundry account fallback) |
| `svc-databricks` | `LOOM_DATABRICKS_HOSTNAME` | Databricks navigator, notebooks, UC (~6) | resource-picker | deploy |
| `svc-databricks-sql` | `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` | DQ monitor, MDM, DLP schemas (~5) | env-picker | — |
| `svc-adf` | `LOOM_ADF_FACTORY` / `LOOM_ADF_NAME` | mirror CDC, triggers, dataflows (~10) | resource-picker | deploy |
| `svc-monitor-alerts` | `LOOM_LOG_ANALYTICS_RESOURCE_ID` + alert RG | Activator, Monitor hub | resource-picker | deploy (auto-derived) |
| `svc-aas` | `LOOM_AAS_SERVER` \| XMLA endpoint | semantic-model fast path, DAX (~8) | resource-picker | — (not in Gov) |
| `svc-aml` | `LOOM_AML_WORKSPACE` (+region) | AutoML, ML models (~3) | resource-picker | deploy (mlWorkspace module) |
| `svc-apim` | `LOOM_APIM_NAME` (+RG) | API marketplace, admin APIM (~6) | resource-picker | deploy (apimEnabled) |
| `svc-batch` | `LOOM_BATCH_ACCOUNT` | batch-pool editor | resource-picker | — |
| `svc-airflow` | `LOOM_AIRFLOW_ENDPOINT` | airflow-job editor | env-picker | deploy (airflow.bicep) |
| `svc-servicebus` | `LOOM_SERVICEBUS_NAMESPACE` | Service Bus editor | resource-picker | — |
| `svc-iothub` | `LOOM_IOTHUB_SUB` (fallback sub) | IoT Hub editor | env-picker | **yes** (falls back) |
| `svc-eventgrid-topics` | `LOOM_EVENTGRID_SUB` (fallback sub) | Event Grid topic editor | env-picker | **yes** (falls back) |
| `svc-digital-twins` | `LOOM_KUSTO_CLUSTER_URI` (ADX graph-twin default) or `LOOM_ADT_ENDPOINT` (Commercial opt-in) | Digital Twin Builder + twin graph query | resource-picker | **yes** (ADX-backed; no Azure Digital Twins needed) |
| `svc-azure-maps` | maps backend + client-id/key | report Map visual, geo canvases | resource-picker | deploy (azureMapsEnabled) |
| `svc-postgres-flex` | `LOOM_POSTGRES_AAD_USER` | Postgres editor | env-picker | — |
| `svc-pgvector` | `LOOM_PGVECTOR_HOST` | pgvector backend | resource-picker | — |
| `svc-lakebase` | `LOOM_LAKEBASE_BACKEND` (+Databricks) | lakebase-postgres editor | resource-picker | — |
| `svc-rti-export` | `LOOM_RTI_EXPORT_ADLS` (fallback account) | eventhouse continuous export | resource-picker | **yes** (falls back) |
| `svc-shir` | `LOOM_SHIR_VMSS_NAME` \| Purview SHIR | SHIR scale-to-0 controls | env-picker | deploy |
| `purview` | `LOOM_PURVIEW_ACCOUNT` | ~14 governance surfaces (PurviewGate) | resource-picker | deploy (purviewEnabled) |
| `svc-purview-uc` | `LOOM_PURVIEW_UC_ENDPOINT` | unified catalog | resource-picker | — |
| `usage-embed` / `govern-embed` | report kind + PBI/Grafana ids | /admin/usage, /governance embeds | wizard | deploy params |
| `org-visuals` / `audit-la-workspace` | derived URLs/ids | org visuals, audit logs | env-picker | **yes** (bicep-derived) |
| `svc-posture-refresh` | `LOOM_POSTURE_FUNCTION_URL` | Govern tab pre-warm | env-picker | bootstrap |

### Security / permissions / enrichment

| gate id | required settings | surfaces | fix-it | auto |
|---|---|---|---|---|
| `svc-mip` | `LOOM_MIP_ENABLED` + Graph grant | sensitivity labels, batch labeling (~4) | role-grant | — |
| `svc-dlp` | `LOOM_DLP_ENABLED` / `_ADMIN_ENABLED` + Graph | DLP panes (~4) | role-grant | — |
| `svc-keyvault` | `LOOM_KEY_VAULT_URI` \| shortcut vault | shortcut creds, TLS certs, CMK (~5 codes) | resource-picker | deploy |
| `svc-onelake-acl` | `LOOM_ONELAKE_SECURITY_ACL` + Blob Owner | OneLake security roles | role-grant | deploy param |
| `svc-audit-siem-stream` | audit DCR endpoint + id | SIEM mirror | env-picker | **yes** (Cosmos trail regardless) |
| `svc-pe-subnet` | `LOOM_PE_SUBNET_ID` | managed private endpoints | env-picker | **yes** (bicep-derived) |
| `svc-workspace-identity` | `LOOM_WS_IDENTITY_SUB` (fallback) | workspace identity | env-picker | **yes** (falls back) |
| `graph-users` | `LOOM_GRAPH_USERS_ENABLED` + Graph grant | Users page enrichment | role-grant | — |
| `svc-m365-link` | `LOOM_WORKSPACE_M365_LINK` + Graph grant | workspace ↔ M365 group | role-grant | — |
| `svc-sharepoint-shortcuts` | `LOOM_SHAREPOINT_SHORTCUTS_ENABLED` + Graph | OneDrive/SP shortcuts | role-grant | — |

### Builders / AI-Copilot / platform substrates

| gate id | required settings | surfaces | fix-it | auto |
|---|---|---|---|---|
| `svc-warp-engine` | Synapse \| Databricks | Warp Run | resource-picker | deploy |
| `svc-mcp-deploy` / `svc-mcp-catalog` / `svc-iq-mcp` | ACA env id/domain, builtin MCP URL, IQ flag | MCP servers | resource-picker / env-picker | deploy |
| `svc-swa-publish` | SWA sub/RG/location | Workshop/Slate publish | env-picker | deploy + fallbacks |
| `svc-plan-writeback` | plan SQL server + db | Plan mirror | resource-picker | **yes** (Cosmos-native regardless) |
| `svc-dab-runtime` | `LOOM_DAB_PREVIEW_URL` | DAB testers, ontology Try-it | env-picker | **yes** (bicep-derived, default on) |
| `svc-udf-function` | `LOOM_UDF_FUNCTION_BASE` | UDF Invoke | env-picker | deploy (default on) |
| `svc-dbt` | `LOOM_DBT_RUNNER_URL` | dbt runs | env-picker | — |
| `svc-approval-logicapp` | `LOOM_APPROVAL_LOGIC_APP_NAME` | pipeline approvals | env-picker | — |
| `svc-copyjob-control` | copy-job control SQL | copy-job watermarks | resource-picker | — |
| `svc-param-sources` | `LOOM_PARAM_KEYVAULT` \| `_APPCONFIG` | pipeline params, trigger wizard | resource-picker | — |
| `svc-data-wrangler` | `LOOM_WRANGLER_ENDPOINT` | Data Wrangler | env-picker | — |
| `svc-csv-imports` | `LOOM_CSV_IMPORTS_URL` | data-product CSV import | env-picker | — |
| `svc-sample-data` | `LOOM_SAMPLE_ADLS` (fallback) | Learning Hub seeds | resource-picker | **yes** (falls back) |
| `svc-weave-ontology` | `LOOM_WEAVE_PG_FQDN` | Weave ontology store | resource-picker | — |
| `svc-dataverse` | Dataverse S2S app id+secret | Power Platform tables | wizard (operator SP grant) | — |
| `svc-feedback-forwarding` | GitHub PAT | feedback → GitHub | env-picker | — (in-store inbox regardless) |
| `svc-learning-hub` | AOAI/Foundry endpoint | /learn help agent | resource-picker | deploy |
| `svc-webhooks-eventgrid` | EG topic endpoint+key | webhook EG transport | env-picker | **yes** (direct HTTPS default) |
| `svc-cosmos-vcore` | vCore connection string | Mongo vector search | env-picker | — |
| `svc-deploy-planner` / `svc-org-visuals` | Cosmos / visuals URL | planner, custom visuals | resource-picker / env-picker | deploy |
| `svc-loom-onelake` / `svc-loom-directlake` / `svc-loom-capacity-broker` / `perf-spark-warm-pool-store` | H-band substrate URLs/Redis | scale-out substrates | env-picker | **yes** (built-in fallbacks) |
| `svc-activator-adx-scope` | `LOOM_ADX_ALERT_SCOPE` | Activator ADX continuous eval | env-picker | deploy |

**Totals: 83 registered gates.** 14 auto-resolve outright (derived /
optional-default), ~20 more are filled by a push-button deploy with zero
operator input; the rest have a Fix-it wizard (30 with live ARM
resource-pickers, the remainder typed env-pickers or one-time role grants).

## Legacy error-code → gate mapping

Every bespoke `code:'…_not_configured'` a route returns today maps to a
registry id via `gateForLegacyCode()` (`legacyCodes` in `GATE_META`), e.g.
`adls_not_configured → svc-adls`, `no_aoai → svc-aoai`,
`kusto_not_configured → svc-adx`, `aas_not_configured → svc-aas`,
`kv_not_configured / cmk_not_configured → svc-keyvault`. The full ~70-code
server-side inventory that seeded this registry follows the shared contract
described above (one `*ConfigGate()` producer per backend client).

## Findings & follow-ups

1. **`LOOM_FABRIC_SECURITY_ENABLED` is NOT a no-fabric-dependency violation** —
   it gates only the explicit `sync-to-fabric` action in
   `app/api/items/[type]/[id]/security-roles/route.ts`; the Azure-native ADLS
   ACL path is the default and fully functional (and the flag is additionally
   blocked in Gov clouds with an honest message). Compliant opt-in.
2. **Cosmos is two gates, not one**: `cosmos-config` (data-plane endpoint) vs
   `svc-cosmos-control` (control-plane account+RG) — previously collapsed under
   one `cosmos_not_configured` code with two different fixes.
3. **Bespoke gates not yet promoted** (no stable env contract yet — follow-up):
   `dspm_ai_not_configured`, `posture_not_configured`, `dq_run_not_configured`,
   `git_not_configured` (per-item Git config, not env),
   `graph_drive_not_configured` (covered by `svc-sharepoint-shortcuts` flag),
   `sql_default_server_not_configured` (**build-time** `NEXT_PUBLIC_*` — cannot
   be runtime-resolved; needs a code change to a runtime var),
   `pbi_service_not_configured` (Fabric/PBI opt-in), `spark_not_configured`
   cloud-availability variant (`not_available_in_cloud` is honesty, not config).
4. **Remaining bespoke MessageBars to migrate to `<HonestGate>`** (top-5 done:
   AI enrichment/AOAI, Synapse serverless SQL, Databricks navigator, Event Hubs
   navigator, AI Search navigator; PurviewGate now embeds the Fix-it wizard):
   warp-transform-canvas, adx-database-tree, adf-cdc-editor,
   factory-resources-tree, index-my-data-wizard, semantic-model pane,
   automl-editor, apim-tree, batch-pool-editor, airflow-job-editor,
   cosmos-tree, powerplatform-tree, spark-observability, monitor-pane,
   webhooks-panel, mcp panels, shortcut-wizard, storage-view, and the remaining
   ~25 single-surface bars — mechanical swaps now that the component exists.
5. **Instant runtime-override candidates** (today: revision roll): the
   backend-selector keys `LOOM_SEMANTIC_BACKEND`, `LOOM_MAPS_BACKEND`,
   `LOOM_LAKEBASE_BACKEND`, `LOOM_USAGE_REPORT_KIND`, `LOOM_REPORT_KIND` could
   move to the platform-settings store (per-tenant, effective immediately) like
   `LOOM_BI_BACKEND` already did.
