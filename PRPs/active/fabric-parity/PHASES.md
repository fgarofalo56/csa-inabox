# CSA Loom ⇄ Microsoft Fabric Parity — Phased Roadmap (Kickoff-Ready)

> Companion to [`README.md`](./README.md) (the master PRP). Each phase is
> **independently kick-offable**: it lists scope, the appendices/audits it draws
> from, exact Loom files to create/edit, Azure + bicep/deploy work, Commercial
> AND Gov variants, day-one-ON config, the Web-5.0 wizard/Copilot UI work,
> real-data E2E acceptance, and a one-line "kick off with" note.
>
> **All phases inherit the cross-cutting requirements** from README §2:
> no hard Fabric dependency · dual-cloud Commercial+Gov · day-one ON · Web-5.0
> wizard/Copilot UI (no freeform config) · real backend per control. They are
> not repeated per phase — they are acceptance gates for every phase.
>
> 8 phases: **P0 make-it-real** → P1 integration → P2 real-time → P3
> engineering+warehouse → P4 governance/sovereignty → P5 data-science/AI/Copilot
> → P6 platform/ALM → P7 developer/APIs.

---

## Phase 0 — Make-it-real (fix the audited broken; RTI + Activator first)

**Why first:** the operator's core complaint ("activators deploy but do
nothing") and the broken Copilot/pipeline/UDF/DAB surfaces undermine trust in
everything else. Nothing in Track B should ship on top of a broken base.

**Scope (Track A — README §4):** A1 Activator `state.rules` persistence · A2
ADX-backed Activator runtime · A3 Activator+RTI Hub day-one enablement · A4
RTI/Eventstream live preview fallback · A5 editor rules table Enable/Disable/
Delete/Edit · A6 config-ignoring Copilot 503s · A7 pipeline Debug async-params ·
A8 UDF execution host · A9 DAB runtime day-one · A10 wave2-a provisioner
registration · A11 mapping-data-flow debug · A12 dock Pipeline Copilot · A13
delete dead stub editors.

**Draws from:** `audit-rti-activator.md`, `audit-data-integration.md`,
`audit-ai-copilot.md`, `audit-platform-items.md`, `appendix-real-time-intelligence.md`
(G1/G2), `appendix-developer-platform.md` (B1/B2/G1/G2).

**Files to edit/create:**
- `apps/fiab-console/lib/install/provisioners/activator.ts` (persist `state.rules`)
- `apps/fiab-console/lib/install/provisioners/types.ts` (state channel on `ProvisionResult`)
- `apps/fiab-console/lib/azure/activator-monitor.ts` (ADX Run-KQL path)
- `apps/fiab-console/app/api/items/activator/[id]/{start,stop,rules,trigger}/route.ts`
- `apps/fiab-console/lib/editors/phase3-editors.tsx` (editor rules table: Enable/Disable/Delete/Edit ~:9466)
- `apps/fiab-console/app/api/items/_lib/ai-content-fallback.ts` (rule projection: query + azureRuleName)
- `apps/fiab-console/app/api/governance/govern/copilot/route.ts:44`,
  `apps/fiab-console/app/api/notebook/[id]/assist/route.ts:168`,
  `apps/fiab-console/lib/azure/ai-functions-client.ts:140` (pass `loadTenantCopilotConfig(oid)`)
- `apps/fiab-console/app/api/items/data-pipeline/[id]/{debug,evaluate,output,triggers}/route.ts` (await params)
- `apps/fiab-console/lib/azure/adf-client.ts` (+`createDataFlowDebugSession`/`executeDataFlowDebugCommand`),
  `apps/fiab-console/app/api/adf/dataflows/[name]/debug/route.ts` (new),
  `apps/fiab-console/lib/editors/mapping-dataflow-editor.tsx:249` (flip `debugClusterAvailable`)
- `apps/fiab-console/lib/editors/data-pipeline-editor.tsx` (dock `PipelineCopilotPane`)
- `apps/fiab-console/app/api/items/user-data-function/[id]/{invoke,publish}/route.ts`
- `apps/fiab-console/lib/install/provisioning-engine.ts` (register wave2-a verify provisioners ~:58)
- `apps/fiab-console/lib/editors/azure-services-editors.tsx` (delete dead stubs)

**Azure + bicep/deploy:**
- `platform/fiab/bicep/modules/admin-plane/` — **Logic App Standard** host for the
  Activator runtime; **Eventhouse alert path**; **UDF runtime** (`udf-runtime.bicep`:
  Functions Flex Consumption + storage + App Insights + KV; ACA variant via
  `udfHostKind`); wire `dab-runtime.bicep` into default orchestration.
- Bundle `@azure/event-hubs`; enable EH receive; ensure EH Capture → ADLS Delta +
  ADX ingestion sink deployed for preview fallback.
- **RBAC (day-one):** Console UAMI → ADX DB Admin + Reader(subscriptions) +
  Monitoring Contributor + Logic App Contributor + (UDF) Website/ACA Contributor + KV Secrets User.
- Env added to every param file: `LOOM_KUSTO_*`, `LOOM_SUBSCRIPTION_ID`,
  `LOOM_LOG_ANALYTICS_*`, `LOOM_UDF_FUNCTION_BASE`/`_HOST_KIND`, `LOOM_DAB_PREVIEW_URL`.

**Commercial vs Gov:** Logic Apps Standard, ADX, ACA, Functions, Event Hubs all
in Gov (`.us`). Teams connector limited in GCC → action-group email/SMS/webhook
fallback. IL4/5 → ACA activator-runner cron + SMTP relay + `udfHostKind=aca`,
private-only. Gov AOAI for Copilot fixes; where a Gov AOAI model is absent the
Copilot Suggest honest-gates while deterministic paths still work.

**Day-one ON:** Activator runtime, RTI Hub discovery, UDF host, DAB runtime,
workspace monitoring all provisioned + enabled at deploy; user can disable.

**Web-5.0 UI:** Activator rule wizard (Eventhouse/KQL source pickers, stateful
condition builder, 8 action kinds) with real history + test-fire; per-row
Enable/Disable/Delete/Edit; docked Pipeline Copilot pane; UDF Test/Run + Publish
wizard; DAB Get-data wizard. No freeform config introduced.

**Acceptance (real-data E2E):** with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset on a
clean deploy — (1) install an Activator from a use-case bundle → Start →
Enable → Trigger fires a real KQL query against the Eventhouse and delivers an
action; `state.rules` populated. (2) RTI Hub renders the cross-sub catalog;
Eventstream preview shows real last-N events. (3) Pipeline Debug returns a real
run. (4) Governance/notebook Copilot answers (no 503) in a tenant-config-only
deploy. (5) UDF `hello(name)` Test → real 200. (6) DAB endpoint answers live.

**Kick off with:** `loom-unleash` scoped to Track A (Activator+RTI first), or
`/prp:prp-implement PRPs/active/fabric-parity/PHASES.md#phase-0`.

---

## Phase 1 — Data integration & connectors

**Scope:** Apache Airflow day-one (P0) · connector breadth 72→200+ · Dataflow
Gen2 Fast Copy + staging + incremental refresh · Copy job CDC breadth (Oracle/
PG/MySQL/Snowflake) + SCD Type 2 · pipeline template gallery · VNet/managed-PE +
SHIR autoscale day-one · Open Mirroring landing + source breadth · **HTAP
auto-mirror** from Azure SQL DB + Cosmos DB · MySQL/SAP/Dremio mirroring sources ·
mirroring observability + Delta maintenance · SQL vector/RAG tab.

**Draws from:** `appendix-data-factory.md`, `appendix-databases.md`,
`appendix-onelake.md` (shortcut caching/gateway), `audit-data-integration.md`.

**Files:** `apps/fiab-console/lib/editors/{airflow-job-editor,dataflow-gen2-editor,copy-job-editor,mirrored-database-editor,unified-sql-database-editor,cosmos-account-editor}.tsx`;
`apps/fiab-console/lib/editors/components/mirror-source-wizard.tsx`;
`apps/fiab-console/lib/azure/mirror-engine.ts`; `lib/pipeline/connector-catalog.ts`;
`lib/components/pipeline/{integration-runtime-manager,templates/,dataflow/}.tsx`;
`lib/install/provisioners/mirrored-database.ts`;
`app/api/items/{sql-database,cosmos-db,mirrored-database}/[id]/analytics|maintenance/route.ts` (new).

**Azure + bicep:** OSS Airflow — `platform/fiab/bicep/modules/admin-plane/airflow.bicep`
(new: ACA webserver+scheduler LocalExecutor, AKS+Helm KubernetesExecutor opt-in)
+ Azure Database for PostgreSQL Flex (metadata) + Azure Files DAG share + git-sync
+ KV secrets backend; `scripts/csa-loom/build-airflow-runtime.sh`. ADF managed VNet
+ managed PE **default-on** in `adf.bicep`. Cosmos change-feed + ADF CDC engines;
Synapse Serverless pairing for HTAP endpoints.

**Commercial vs Gov:** all OSS/ADF/Synapse/Cosmos/MySQL-Flex GA in Gov (`.us`,
private ingress, CMK, IL4/5). Airflow is pure OSS (identical both clouds; also
closes Fabric's no-private-network gap). Debezium-on-ACA = Gov CDC substitute.
HTAP mirroring is the **Gov differentiator** (Fabric SQL DB absent; Cosmos
mirroring sovereign-blocked). Cross-cloud SaaS connectors tagged
`clouds:['commercial']`; reach via managed-VNet where Gov-available.

**Day-one ON:** Airflow host, managed-VNet IR + managed PE, connector catalog,
HTAP pairing all provisioned/enabled; disable toggles surfaced.

**Web-5.0 UI:** Airflow DAG tree + Copilot DAG builder + operator gallery; Fast
Copy/staging query context toggles + incremental-refresh wizard; Copy-job
SCD-Type-2 dropdowns; HTAP Analytics tab; mirror Maintenance tab; connector
gallery "show all 200" expander. No raw config.

**Acceptance:** Airflow DAG runs a real task on a clean Gov-style deploy; a 847-row
Copy-job-style E2E for an added CDC source; SQL DB Analytics tab auto-provisions
a working mirror → queryable Synapse Serverless endpoint, all with Fabric unset.

**Kick off with:** `loom-fabric-parity-prp args.experiences=data-factory,databases`
or `/prp:prp-implement …#phase-1`.

---

## Phase 2 — Real-Time Intelligence depth

**Depends on:** Phase 0 (the ADX Activator runtime + RTI Hub day-one land in P0).
P2 completes RTI breadth on that fixed base.

**Scope:** Eventhouse/KQL management UI (update policies, MVs, functions, RLS,
continuous export, profiling) · OneLake availability = ADX→ADLS Delta continuous
export · Eventstream no-code canvas (7 operators + derived-stream pause/resume +
Spark sink; demote JSON to read-only) · Real-Time Dashboard depth (parameters,
live-refresh, cross-filter, drillthrough, alerts-from-tile) · anomaly detection /
forecasting · KQL queryset cross-service + SQL endpoint over ADX · business
events in RTH · OneLake events → Activator · maps / operations-agent / data-agent.

**Draws from:** `appendix-real-time-intelligence.md` (G3–G10), `appendix-onelake.md`
(OneLake events), `audit-rti-activator.md`.

**Files:** `apps/fiab-console/lib/editors/phase3-editors.tsx` (eventhouse/eventstream/
dashboard); `lib/azure/{kusto-client,stream-analytics-client,kql-dashboard-model,monitor-client}.ts`;
`lib/editors/{geo-editors,data-agent-config-copilot}.tsx`;
`platform/fiab/bicep/modules/landing-zone/{eventgrid,eventgrid-business}.bicep`.

**Azure + bicep:** ADX (executeMgmtCommand, continuous export), Stream Analytics,
Event Grid namespace + system topics, Azure Maps (Gov: MapLibre+PMTiles). All
day-one in landing-zone bicep.

**Commercial vs Gov:** ADX/ASA/Event Grid GA in Gov (`.us`). Loom-native dashboard
renderer over ADX (no Power BI). Anomaly detection is native KQL (no service dep).
Gov maps via MapLibre+PMTiles; Gov AOAI / OSS LLM via MCP for agents.

**Web-5.0 UI:** Create-MV / update-policy / function wizards; retention+caching
sliders; canvas-node-kit operator panels (no JSON authoring); param manager +
live-refresh dropdown + drillthrough; Detect/Forecast wizard. KQL editor is the
allowed 1:1 freeform code surface.

**Acceptance:** create an Eventhouse + MV + continuous-export → Delta visible in
Synapse; build an Eventstream on the canvas → ASA query runs; a dashboard tile
alert routes through the ADX Activator runtime and fires.

**Kick off with:** `loom-fabric-parity-prp args.experiences=real-time-intelligence`.

---

## Phase 3 — Data engineering & warehouse

**Scope (engineering):** Data Wrangler (interactive EDA + PySpark/pandas codegen
to a cell) · API for GraphQL visual auto-schema builder (DAB) · Native Execution
Engine acceleration (Photon/Gluten) · high-concurrency sessions + notebook
orchestration DAG (runMultiple) · notebook resources (nbResPath) · workspace
Spark settings admin · Livy endpoint surface · scheduled/health-driven table
maintenance · Spark monitoring hub · collapse duplicate Environment editors.
**Scope (warehouse):** zero-copy CLONE TABLE (+ point-in-time) · FOR TIMESTAMP AS
OF time travel · restore points + restore-in-place · COPY INTO wizard ·
configurable retention · warehouse snapshot · RLS/CLS/DDM builders · share +
new-semantic-model + data-preview + query-insights · serverless zero-idle
warehouse option.

**Draws from:** `appendix-data-engineering.md`, `appendix-data-warehouse.md`,
`audit-analytics-bi.md` (warehouse cost gate, multi-table).

**Files:** `lib/editors/{notebook-editor,spark-environment-editor,lakehouse-editor,
phase3-editors,data-api-builder-editor}.tsx`;
`lib/editors/components/{delta-preview-grid,delta-maintenance-dialog}.tsx`;
`lib/components/notebook/session-config-dialog.tsx`;
`app/api/items/warehouse/[id]/{clone,query,history,restore-points,restore,copy-into,retention,snapshot,security,share,query-insights}/route.ts` (new);
`app/api/{wrangler,notebook/orchestrate,admin/spark-settings}/*` (new);
`lib/azure/synapse-pool-arm.ts`; `lib/editors/registry.ts`.

**Azure + bicep:** Synapse Spark/Serverless/Dedicated, Databricks (Photon),
ADLS Delta (SHALLOW CLONE / RESTORE / time travel), ACA `loom-wrangler` +
`loom-dab`, AML/Synapse schedules. Serverless-warehouse (CETAS over ADLS) as the
zero-idle default option.

**Commercial vs Gov:** Synapse + Databricks + Photon all in Gov. OSS substitutes:
OSS Spark on AKS (Delta OSS SHALLOW CLONE), DAB on ACA, pandas/ACA Wrangler. Gov
Livy hosts `.usgovcloudapi.net` / Gov Databricks; Gov token authority.

**Day-one ON:** Wrangler + DAB ACA hosts, Spark settings defaults, serverless
warehouse option all provisioned.

**Web-5.0 UI:** DataWranglerPanel (op gallery + live preview + Export-to-cell);
DAB visual schema builder (source → object tree → relationships canvas);
Acceleration tab Switch; Notebook Orchestration canvas (canvas-node-kit DAG);
Clone-table dialog with zero-copy/full-copy badge + generated-SQL preview;
As-of datetime picker; Restore-points panel; COPY INTO 5-step wizard; Security
tab RLS/CLS/DDM builders.

**Acceptance:** Wrangler recipe exports runnable PySpark; clone a table zero-copy
+ at a past timestamp; COPY INTO loads real rows; time-travel query returns a
prior version — all on the ADLS+Delta default with Fabric unset.

**Kick off with:** `loom-fabric-parity-prp args.experiences=data-engineering,data-warehouse`.

---

## Phase 4 — Governance & sovereignty

**Why high-value:** this is the **primary Gov story** — Fabric protection
policies and several Purview features do not exist in GCC-High/DoD, so Loom's
Azure-native engine is *the* sovereign substitute.

**Scope (all P0/P1):** Protection policies (label → access enforcement engine) ·
OneLake security data-access roles (folder/table OLS + RLS/CLS/DDM) · item
sharing / granular permission dialog (`<ShareItemDialog>` on every editor) ·
managed private endpoint self-service create + approval · trusted workspace
access / resource-instance rules · endorsement & certification · SQL granular
security designer (OLS GRANT/DENY + DDM) · label inheritance / default /
mandatory · Govern tab Admin/Owner sub-tabs · **workspace identity** (per-ws UAMI
+ trusted access — shared with P6).

**Draws from:** `appendix-governance-security.md` (G1–G13), `appendix-platform-alm.md`
(workspace identity), `audit-governance-admin.md` (the 14 A-grade surfaces are the
regression baseline — do not rebuild).

**Files:** `lib/azure/{label-protection,access-policy-client,onelake-security-client,
onelake-security-rules,item-permissions-client,network-discovery,synapse-permissions-client}.ts`;
`app/governance/policies/page.tsx`; `app/admin/network/page.tsx`;
`app/api/governance/protection-policies/*`, `app/api/network/{managed-private-endpoints,trusted-access}/*`,
`app/api/items/[type]/[id]/{security-roles,share,endorsement}/route.ts`;
`apps/fiab-console/lib/components/workspace-settings-drawer.tsx`;
`platform/fiab/bicep/modules/**/network.bicep`.

**Azure + bicep:** ADLS RBAC/ACL, Synapse SQL (RLS/CLS/DDM/GRANT/DENY), ADX RLS,
MIP Graph, ARM `Microsoft.Network/privateEndpoints` on a **day-one managed-VNet
subnet**, storage `networkAcls.resourceInstances`, per-workspace UAMI + RBAC.

**Commercial vs Gov:** ADLS/Synapse/ADX/UAMI/ARM-PE all first-class in Gov.
Protection policies + OneLake roles need **no Purview dependency** (pure RBAC/
DENY reconciler) → fully sovereign. Where Purview classification API is limited
in GCC-High, fall back to the Loom catalog flag (disclosed).

**Day-one ON:** managed-VNet subnet + DLZ lake pre-authorized as trusted; per-ws
UAMI created at workspace provision; reconciler running.

**Web-5.0 UI:** Protection-policy wizard + Copilot builder; New-OneLake-role
wizard (folder tree + RLS/CLS sub-tab + preview-as); reusable Share dialog
(people-picker + permission checkboxes); MPE Create wizard (Resource-Graph picker
+ subresource dropdown + justification); endorsement radio + certifier; Identity
settings tab. No freeform.

**Acceptance:** apply a protection policy → reconciler revokes real ADLS RBAC +
Synapse DENY for non-allowed principals; create an OneLake role → preview-as
shows masked rows; create a managed PE → connection-state polls to Approved;
per-ws UAMI granted Blob Data role and added to storage trusted rules.

**Kick off with:** `loom-fabric-parity-prp args.experiences=governance-security`.

---

## Phase 5 — Data science / AI / Copilot

**Note:** the config-ignoring Copilot 503s (A6) are fixed in P0; P5 is the deeper
AI/ML parity.

**Scope:** Data Wrangler (DS immersive grid + AOAI NL ops) · PREDICT guided
batch-scoring wizard (ML model) · real-time endpoint test/query console +
lifecycle (activate/deactivate/auto-sleep) · AI Functions full 9 + Text Analytics
/ Translator surface · MLflow 3 LoggedModels + GenAI Traces · HPO low-code +
Data Science home enrichment · Power BI: day-one tabular engine (un-gate AAS /
DAX→Synapse) · linguistic schema / synonyms / Q&A grounding · multi-table
star-schema visuals on the loom-native default · connected metrics + alerts ·
paginated report export Function · aggregations / storage-mode designer ·
Analyze-in-Excel / XMLA / endorsement + sensitivity · Foundry On-Your-Data
grounding + tool toggles.

**Draws from:** `appendix-data-science.md`, `appendix-power-bi.md`,
`appendix-data-engineering.md` (Wrangler), `audit-ai-copilot.md`,
`audit-analytics-bi.md` (multi-table, paginated export, script-visual UAMI).

**Files:** `lib/editors/{data-wrangler-editor,ml-model-editor,predict-wizard,
ml-experiment-editor,ai-models-editor,data-science-home-editor,hpo-wizard,phase3-editors}.tsx`;
`lib/editors/report/ai-visuals/qa.tsx`; `lib/azure/{ai-functions-client,
copilot-orchestrator,aas-client,aas-xmla,synapse-sql-client,report-model-resolver}.ts`;
`app/api/{items/ml-model/[id]/predict,ai-models,items/semantic-model/[id]/linguistics,
items/report/[id]/query}/*`;
`platform/fiab/bicep/modules/admin-plane/{analysis-services,ai-language,ai-translator,paginated-render}.bicep` (new).

**Azure + bicep:** AML managed endpoints, Synapse/Databricks Spark, AOAI
(embeddings+chat), Azure AI Language + Translator, AAS (XMLA) day-one, paginated-
render Function, report-model-resolver JOIN graph.

**Commercial vs Gov:** AML/AOAI/AI-Language/Translator/AAS in Commercial; Gov uses
Gov AOAI + Gov Cognitive Services `.us`. **Gov substitutes:** OSS MLflow ≥3,
ACA scale-to-zero endpoint (= auto-sleep), sentence-transformers (embed/
similarity), Presidio/spaCy (PII/NER), Loom-native DAX→Synapse engine where AAS
is absent (the Gov tabular default).

**Day-one ON:** tabular engine (AAS or Loom-native), AI Language/Translator,
paginated renderer, Wrangler host all provisioned.

**Web-5.0 UI:** DataWranglerPanel; PREDICT stepper (column-mapping grid);
Endpoints table + signature-driven Test panel; 9 typed AI-function forms;
linguistics WYSIWYG grid (synonym TagPicker + phrasing builder); semantic-engine
status chip; aggregations designer.

**Acceptance:** PREDICT writes a real Delta scored table; an endpoint Test returns
real predictions; a multi-table report visual renders via JOINs on the loom-native
default (no AAS required); paginated export produces a real PDF.

**Kick off with:** `loom-fabric-parity-prp args.experiences=data-science,power-bi`.

---

## Phase 6 — Platform, workspaces & ALM

**Scope:** workspace identity (per-ws UAMI + trusted access — coordinate with P4) ·
Capacity Metrics app parity (Health/Compute/Storage/Timepoint + throttling,
autoscale, surge protection, pause/resume/scale) · task-flow richness (10 task
types + recommended items + predesigned templates + import/export + multi-canvas) ·
Git branch-out to new workspace · workspace contact list + real capacity-
assignment dropdown (replace free-text) · monitor-hub per-run drilldown.

**Draws from:** `appendix-platform-alm.md`, `appendix-governance-security.md`
(workspace identity), `audit-platform-items.md`.

**Files:** `lib/components/workspace-settings-drawer.tsx`; `lib/panes/{task-flows,
monitor-hub}.tsx`; `lib/clients/taskflow-client.ts`; `lib/catalog/task-flow-templates.ts`;
`app/admin/capacity/page.tsx`; `app/api/admin/capacity/{metrics,autoscale,surge}/route.ts`;
`app/api/workspaces/[id]/{identity,git/branch-out,route}.ts`;
`lib/components/admin/scale-manage-panel.tsx`;
`platform/fiab/bicep/modules/{landing-zone/main,admin-plane/monitoring}.bicep`.

**Azure + bicep:** per-ws UAMI + RBAC + storage resource-instance rules; Azure
Monitor + Log Analytics + Cost Management + ACA/Synapse/ADX scale ARM; ADO/GitHub
Git Data API; Cosmos.

**Commercial vs Gov:** UAMI/RBAC/Monitor/LA/Cost all in Gov (`.us`). Fabric
`cu_percentage` is Commercial/GCC-only → Gov uses a **normalized-vCPU CU model**
(route already gates the Fabric metric type). No OSS substitute needed.

**Day-one ON:** per-ws identity at workspace create; capacity metrics wired to the
deployment's own estate.

**Web-5.0 UI:** Identity tab (clientId/principalId + Grant-access dialog);
Capacity TabList (Health/Compute/Storage/Timepoint) with MetricChart + matrix +
controls strip; per-node task-type Dropdown + template gallery + canvas selector;
Branch-out dialog; General-tab capacity **Dropdown** (replaces free-text) +
people-picker; monitor-hub run-detail drawer.

**Acceptance:** create a workspace → UAMI exists, granted a Blob Data role,
authorizes firewalled storage; capacity metrics render from real Azure Monitor;
branch-out creates a new workspace bound to a new Git branch with applied items.

**Kick off with:** `loom-fabric-parity-prp args.experiences=platform-alm`.

---

## Phase 7 — Developer platform & APIs

**Note:** UDF execution host + DAB day-one land in P0 (they are broken-base
fixes); P7 completes the developer surface around them.

**Scope:** Unified Job Scheduler + schedule store (CRON/interval/daily, exit
values, auto-disable) · Monitoring Hub (cross-item run history) · workspace
monitoring day-one ON (Eventhouse) · Fabric events → Event Grid webhooks (real
system topic + subs) · UDF editor depth (Publish wizard, generate-invocation-code,
run history, schedule) · GraphQL RBAC/aggregations/saved-creds-vs-SSO · Loom SDK
(Python/TS) · Terraform provider for Loom items.

**Draws from:** `appendix-developer-platform.md` (G3–G8), `audit-platform-items.md`.

**Files:** `lib/editors/phase4-editors.tsx` (UserDataFunctionEditor, raw-px → tokens);
`lib/editors/data-api-builder-editor.tsx`; `app/api/{items/user-data-function/[id]/{publish,runs,schedule},
deployment-pipelines/loom,git-integration,business-events,dab/[id]/{import-schema,roles}}/*`;
`lib/install/provisioners/workspace-monitor.ts`; `apps/loom-cli/*` (CLI parity);
new `packages/loom-sdk-*` + Terraform provider repo;
`platform/fiab/bicep/modules/admin-plane/{udf-runtime,dab-runtime}.bicep`;
`platform/fiab/bicep/modules/landing-zone/eventgrid.bicep`.

**Azure + bicep:** Azure Functions Flex / ACA (UDF host), DAB ACA, ADX (workspace
monitoring), Event Grid system topic + subscriptions, Cosmos (schedule store),
App Insights / Log Analytics (run history).

**Commercial vs Gov:** Functions Flex Python GA Commercial + most Gov regions;
where absent in Gov → `udfHostKind=aca` (broadly available GCC-High/IL5). DAB +
ACA + Synapse serverless + Cosmos + Event Grid all in Gov (`.us`,
`*.azurewebsites.us`, `vault.usgovcloudapi.net`). Private-only for IL5. No Fabric
on default.

**Day-one ON:** UDF host, DAB runtime, workspace monitoring ADX DB + diagnostic
settings, Event Grid topics all provisioned at deploy; disable toggles.

**Web-5.0 UI:** UDF Publish wizard (runtime/host/auth/connections dropdowns) +
Generate-invocation-code (Notebook/Python/OpenAPI/cURL) + real Test/Run; DAB
Get-data wizard + Roles panel + GraphiQL playground; Schedule wizard (CRON
builder, no cron string typing); cross-item Monitoring Hub grid + run drawer. The
Monaco Python cell and raw `dabConfigJson` are the allowed 1:1 advanced code views.

**Acceptance:** publish a UDF → invoke returns `backend:"azure-functions"` real
200; a schedule fires the item job; the Monitoring Hub lists real cross-item runs;
a Fabric-style event → Event Grid → Activator round-trips; `loom` CLI + SDK call
the live BFF.

**Kick off with:** `loom-fabric-parity-prp args.experiences=developer-platform`.

---

## Cross-phase notes

- **Shared dependencies:** the Activator ADX runtime (P0) underpins P2 dashboard
  alerts, P1 mirroring alerts, and P6/P7 event routing. The DAB runtime (P0)
  underpins P3 GraphQL auto-schema and P7 RBAC/aggregations. Workspace identity
  is built once (P4) and surfaced in P6.
- **Regression baseline:** the A-grade surfaces in `audit-governance-admin.md`,
  `audit-analytics-bi.md`, and `audit-ai-copilot.md` (global Copilot pane,
  per-editor build Copilots, Foundry hub, Copilot Studio, lakehouse/KQL/notebook/
  semantic-model) must keep passing — add Playwright UAT to lock them.
- **Per-surface parity doc:** every phase updates `docs/fiab/parity/<slug>.md`
  (Fabric inventory → Loom coverage built✅/gate⚠️/missing❌ → backend per control)
  to zero ❌ before claiming the phase complete.
- **Validation harness:** run `pnpm uat` (in-VNet Playwright) per phase; attach
  the real-data E2E receipt to each PR per `no-vaporware.md`.
