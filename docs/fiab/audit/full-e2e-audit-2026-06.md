# CSA Loom — Full End-to-End Audit (June 2026)

**Scope:** every CSA Loom item-type editor, its BFF (`/api/...`) routes, and the
underlying Azure / Dataverse / Databricks / ML / Power Platform clients, graded
against the four die-hard rules: `no-vaporware.md`, `no-fabric-dependency.md`,
`ui-parity.md`, and `loom_no_freeform_config`.

**Audit date:** 2026-06-15
**Method:** code read of `apps/fiab-console/lib/editors/**`, `app/api/**`,
`lib/azure/**`, plus bicep cross-checks. Grading per the `no-vaporware.md`
rubric (F vaporware → A+ tested+documented+bicep-synced).

> Note on counts: the tables below tally the analyzed finding records. The
> dominant signal across the estate is **real backends with honest gates** — the
> failures are concentrated in a small number of surfaces (Copilot Studio family,
> paginated-report export, a few geo/map/mirror items) and are individually
> high-impact.

---

## 1. Executive summary

### Health by category

| Category | Meaning | Count (approx.) |
|---|---|---|
| ✅ works | Real backend, wired E2E, honest gate | ~115 |
| ⚠️ honest-gate / poor-config | Real, but gate styling/config inconsistent | ~22 |
| 🔌 missing-wiring | Backend exists, UI path broken or unreachable | ~16 |
| 🕳️ dead-control | Button/tab present, does nothing real | ~15 |
| 🧩 missing-feature | Real but short of Azure/Fabric parity | ~30 |
| 🐢 perf | Unbounded fetch / no pagination / no timeout | ~10 |
| 🐞 error | Wrong schema/params; will fail on real tenant | ~5 |
| 🚫 vaporware | Looks real, does nothing | 4 |
| 📓 tutorial | Stale/contradictory catalog or info copy | ~3 |

### Health by severity

| Severity | Count | Headline |
|---|---|---|
| 🔴 critical | 1 | paginated-report Export downloads JSON renamed `.pdf`/`.xlsx` |
| 🟠 high | 15 | Copilot Studio family schema/wiring failures; geo-pipeline fake receipt; map shell; operations-agent dead tools |
| 🟡 medium | ~40 | Parity gaps, free-text-where-pickers-required, dead tabs |
| 🟢 low | ~170 | Mostly `works`; minor UX/perf/copy nits |

### Overall grade

**Estate average: B− (Production-grade, with isolated F/D pockets).**

The Azure-native data/analytics/AI items (ADF, APIM, AI Search, AI Foundry,
Cosmos, SQL, Databricks, Synapse, Eventhouse, Eventstream, KQL, Lakehouse,
MLflow, prompt-flow, copy-job, DAB, materialized-lake-view) are genuinely
**A/B-grade**: real REST, honest env/role gates, no mock arrays, `no-fabric`
default paths respected. The **Copilot Studio / Power Platform agent family** is
the single biggest liability — multiple surfaces target Dataverse
entities/columns that almost certainly don't exist, and analytics fabricates
zeros. A few standout individual failures (paginated-report export,
geo-pipeline, map, mirrored-databricks, operations-agent tools) are listed in §2.

---

## 2. CRITICAL + HIGH must-fix (deduped, grouped by root cause)

### 🔴 C1 — paginated-report Export emits corrupt documents *(critical)*
`doExport()` POSTs to `/render`, which returns a **JSON page-model**
(`RdlRenderResult`) and downloads it as `report.pdf/.xlsx/.docx`. The real binary
exporter `renderReport()` (POSTs to the `LOOM_PAGINATED_RENDER_URL` Function,
returns bytes + correct mime) exists at `paginated-report-client.ts:210` but
**no route calls it**. Compounded by **H-gate mismatch**: the Export honest-gate
guards `LOOM_PAGINATED_RENDER_URL`, but `/render` actually depends on Synapse
Serverless (`LOOM_SYNAPSE_WORKSPACE`) — gate and backend are decoupled.
- Fix: route Export through `renderReport()`; align the gate to the real dep.
- Evidence: `phase3-editors.tsx:15296-15319`; `render/route.ts:61-72`;
  `paginated-report-client.ts:210-245`; `capabilities/route.ts`.

### 🟠 H1 — Copilot Studio family: invented Dataverse schema *(high, root-cause cluster)*
Several surfaces query Dataverse entity sets / columns that are very likely not
real, so they will 404 / 400 on any live tenant — and the friendly-404 handler
(covers only `msdyn_copilots|msdyn_knowledgesources|msdyn_botcomponents`)
**mis-classifies** the failure as a benign "enable Copilot Studio" 503, hiding
the bug. Fold these into one known item:
- **Channels** target `msdyn_botchannels` (channel state lives in Azure Bot
  Service, not a Dataverse table) — `listChannels/publishToChannel` 404.
- **Actions** target `msdyn_bot_actions` (superseded by `msdyn_plugin` /
  `msdyn_pluginaction`; spec admits this) — `listActions/bindAction` 404.
- **Agent** writes `msdyn_instructions` / `msdyn_modeldeployment` scalar columns
  on `msdyn_copilots` that appear invented — `create/updateAgent` 400.
- Fix: live-tenant verify every `msdyn_*` entity/column; widen the 404 handler so
  schema errors surface instead of masquerading as the enablement gate.
- Evidence: `copilot-studio-client.ts:120-129, 228-310, 526-590, 608-644`.

### 🟠 H2 — Copilot Studio "publish to channel" doesn't publish *(high)*
`publishToChannel()` for all 6 channels just inserts an `msdyn_botchannels` row.
Real channel enablement needs app-manifest packaging + Azure Bot Service channel
registration (Teams), OAuth/signing secrets (Slack), Page tokens (Facebook),
Direct Line site/secret, etc. The UI reports success while nothing is wired to
the destination. Evidence: `copilot-studio-client.ts:646-667`;
`copilot-studio-channel/[id]/publish/route.ts:21-28`.

### 🟠 H3 — Copilot Studio Analytics fabricates zeros *(high, vaporware)*
`getAnalytics()` swallows **404 AND 204** into an all-zeros object, so KPI tiles
render plausible "0 sessions / — CSAT" telemetry from a backend that may not
exist. The BAP path it calls is undocumented; real analytics live in Dataverse
`msdyn_botsession*`/transcripts + App Insights. Plus the surface is 4 tiles vs
the real 8-tab Analytics experience (20 enumerated missing capabilities).
- Fix: stop coercing 404→zeros; build the Dataverse/App-Insights backend or
  honest-gate. Evidence: `copilot-studio-client.ts:838-872`;
  `copilot-studio-editors.tsx:1295-1376`.

### 🟠 H4 — Copilot Studio topic authoring = raw YAML textarea *(high)*
The product's centerpiece visual topic canvas (Trigger→Message→Question→
Condition→Actions) is replaced by a Monaco **plaintext** AdaptiveDialog-YAML
blob — both a `ui-parity` miss and a brush against `loom_no_freeform_config`.
Evidence: `copilot-studio-editors.tsx:836-846`.

### 🟠 H5 — geo-pipeline "Trigger run" green receipt over an empty pipeline *(high, vaporware)*
The deployed `loom-geo-enrich` ADF pipeline has `activities: []`. The editor
fires a real `createRun`, gets a runId, and renders a GREEN "enrichment ran —
H3/reverse-geocode/buffer params passed" receipt. The ARM call is real; its
effect is null. Fix: ship a real activity graph **or** change the receipt to
state no enrichment activities exist. Evidence: `adf.bicep:125`;
`geo-editors.tsx:895-927,1034-1069`; `geo-pipeline/[id]/run/route.ts:70-95`.

### 🟠 H6 — operations-agent tools are dead at runtime *(high)*
Default tools `"eventhouse-query, activator-trigger"` become `{type:'<token>'}`
and pass straight to Foundry as `definition.tools`. Those are **not** valid AI
Foundry Agent tool types (`code_interpreter|function|file_search|
azure_ai_search|bing_grounding`), so a "successful" deploy yields an agent whose
advertised tools don't function. Evidence:
`operations-agent/[id]/deploy/route.ts:47-54,105`; `foundry-agent-client.ts:210`.

### 🟠 H7 — map (Fabric IQ) is a GeoJSON textarea shell *(high)*
`MapState = { geojson: string }`. The catalog promises dataset binding,
heatmap/choropleth/point-cluster layers over Lakehouse/KQL/Ontology, and
embeddability — **none exist**. Persistence is now real (route fixed a prior
F-grade), but the surface is a thin shell vs the described Fabric Map. Evidence:
`phase4-editors.tsx:3411-3415`; `fabric-item-types.ts:893-905`.

### 🟠 H8 — mirrored-databricks is a UC browser, not a mirror *(high)*
Create only writes a Cosmos config doc; nothing pairs a SQL analytics endpoint
or creates a OneLake/ADLS shortcut, so a mounted catalog is queryable **nowhere**
in Loom — the entire point of the item. (cf. `mirrored-database` which does pair
an endpoint.) Evidence: `mirrored-databricks/route.ts:57-86`; `catalog/route.ts:53-56`.

### 🟠 H9 — apim-policy deep-link wiring broken *(high)*
"API policy" and per-operation policy buttons navigate to `apim-policy` with
`?scope&apiId&operationId`, but `ApimPolicyEditor` never reads `useSearchParams`
— it hard-defaults to Global/empty. The user lands on the wrong scope with the
ids silently discarded. Evidence: `apim-editors.tsx:620-621,677,1721-1730`.

### 🟠 H10 — airflow-job Runs tab is a "PR #404" placeholder *(high)*
Viewing DAG runs (core Airflow capability) renders only a static MessageBar
pointing at an unmerged PR — a "coming soon" tab, not a tracked-and-built
feature. Evidence: `airflow-job-editor.tsx:306-313`.

### 🟠 H11 — compute foundryBase() hard-codes eastus2, defeats the gate *(high, poor-config)*
`foundryBase()` falls back to literal `rg-csa-loom-admin-eastus2` /
`aifoundry-csa-loom-eastus2`, so `listComputes()` never throws
`NotDeployedError` — when Foundry is absent (or the live deployment is
**centralus**), the editor shows a raw ARM 404/403 instead of an honest "set
`LOOM_FOUNDRY_RG`/`LOOM_FOUNDRY_NAME`" gate, and can point at the wrong region.
Evidence: `foundry-client.ts:50-55`; `compute/route.ts:12-16`.

---

## 3. By area

### 3a. Items (data / analytics / AI) — mostly ✅

**✅ Production-grade (A/B):** adf-pipeline, adf-dataset, adf-trigger, activator,
ai-foundry-hub (20 panels), ai-search-index, ai-builder-model, ai-foundry-project,
aip-logic, apim-api, apim-product, automl, azure-cosmos-account, azure-sql-database,
azure-sql-server, azure-sql-managed-instance, content-safety (moderation core),
compute (CRUD), copy-job, cross-item-copilot, cosmos-gremlin-graph, cypher-graph
(translator+exec), dashboard, data-marketplace, data-api-builder, data-pipeline,
data-agent (grounded RAG), data-product (+template/instance), databricks-cluster/
job/notebook/sql-warehouse, dataflow, dbt-job, dataverse-table (read+create),
dataset, datamart (deprecation-correct), environment, evaluation, event-schema-set,
eventhouse, eventstream, graph-model, graphql-api, gql-graph, health-check,
kql-database/queryset/dashboard, lakehouse, logic-app (view/run), materialized-
lake-view, mirrored-database, ml-experiment, ml-model, mounted-adf, notebook,
ontology, ontology-sdk, plan, postgres-flexible-server (query/firewall), power-app,
power-automate-flow, prompt-flow, rayfin-app.

These share the right pattern: real REST, `fetchWithTimeout`, honest 503 gates
naming the exact env var + role + bicep module, Azure-native default with Fabric
strictly opt-in, no mock arrays (vaporware scan over the four-type sets returned
zero `return []`/`MOCK_`/"coming soon" hits).

**❌ Broken / 🚫 vaporware items:** paginated-report (export), geo-pipeline (fake
receipt), map (shell), mirrored-databricks (no mirror), operations-agent (dead
tools), copilot-studio-topic (raw YAML).

**🧩 Notable parity-thin items:** logic-app (no authoring/designer; PUT exists but
unwired), azure-sql-server / -managed-instance (firewall+AAD only; no auditing/
Defender/TDE/failover/replicas), postgres-flexible-server (no compute/HA/backup/
replica/params), dataverse-table (read-mostly; 5 of 6 tabs GET-only).

### 3b. Apps & cross-item surfaces — ✅
cross-item-copilot (orchestrate SSE + Cosmos sessions + tools rail), copilot-
template-library (real Cosmos + real Dataverse instantiate), data-marketplace
(AI Search index + Cosmos + Purview), data-product-template/instance — all real
and wired. Gaps are narrow (template-library has no author-custom UI; marketplace
hard-caps `top:50`).

### 3c. Admin / Power Platform pages — ⚠️ mixed
powerplatform-environment lifecycle bar honestly gates 5 of 8 actions (Copy/
Backup/Reset/Convert/History) behind admin-role MessageBars; detail panel is thin
(capacity/securityGroup mapped but unrendered, DLP hard-null). power-page is a
read-only registry with an honest delegated-auth disclosure but a missing
`dataverseConfigGate` on the read it performs (raw 403 instead of honest 503).

### 3d. Tutorials / catalog copy — 📓
Small but real drift: geo-pipeline catalog still says "ADF integration deferred to
v3.x" though it now does real `createRun`; notebook editor's header docstring
still claims a hard Fabric-tenant dependency that no longer exists; cosmos-gremlin
info bars cite "returns 501" while the code returns 503.

---

## 4. Vaporware register (looks real, does nothing)

| Surface | What's faked | Evidence |
|---|---|---|
| 🚫 copilot-studio-analytics | 404/204 coerced to all-zeros KPIs | `copilot-studio-client.ts:838-872` |
| 🚫 geo-pipeline Trigger run | GREEN "enrichment ran" over `activities:[]` | `adf.bicep:125`; `geo-editors.tsx:895-927` |
| ✅ content-safety policies | FIXED (#1410): fabricated `default` thresholds removed; `ContentSafetyEditor` now renders REAL RAI content-filter policies (Microsoft.CognitiveServices/accounts/raiPolicies) with per-category severity threshold create/edit/delete, and REAL custom blocklist CRUD (Content Safety data-plane). Honest 503 gate when the endpoint env var is unset. | `foundry-cs-client.ts` (listRaiPolicies/upsertRaiPolicy/deleteRaiPolicy); `foundry-client.ts` (list/upsert/deleteBlocklist + items); `foundry-sub-editors.tsx` ContentSafetyEditor |
| 🚫 operations-agent | "Phase 1 stub"; absent capabilities deferred to a *doc*, not a tracked TODO (no-vaporware violation) | `phase4-editors.tsx:3556-3561` |

Borderline (real call, null effect): copilot-studio-channel publish (H2),
mirrored-databricks create (H8), map (H7), release-environment promote
(metadata-only ledger, never deploys to the target stage).

---

## 5. Missing wiring + dead controls

**Missing wiring (backend exists / UI path broken):**
- apim-policy deep-link discards scope/apiId/operationId (H9).
- copilot-template-library: POST/DELETE custom templates + `j.custom` exist but
  the editor reads only `j.curated` — no author/save/delete UI.
- cypher-graph / gql-graph / geo-query: query text never persisted (ephemeral
  `useState(SAMPLE_*)`, no load-on-mount); their `/api/items/.../route.ts`
  GET/POST are orphaned. geo-query also has no `id==='new'` create gate.
- cypher-graph / geo-query pass their **own** item id into the
  `kql-database/[id]/query` route → `loadKustoItem` returns null →
  `resolveDatabase(null)` silently uses the env default DB; no cluster/db picker.
- ontology-sdk "Publish to APIM" imports OpenAPI but provisions no DAB runtime →
  APIM operations have no backend → callers 404.
- dataset list rows have no `onClick` → detail/versions surface unreachable.
- power-page read path lacks `dataverseConfigGate` → raw 403 not honest 503.
- powerplatform tree: tables-specific 403 swallowed → silent "No tables".
- azure-sql-server firewall/AAD dialogs POST through the
  `azure-sql-database/[id]` path with id `'new'` (works only by query-param luck).

**Dead controls (present, no real action):**
- airflow-job Runs + Connections tabs (static MessageBars).
- dashboard "drag to arrange" (no drag handlers; only `w` of `{col,row,w,h}` is
  applied — manual positioning impossible).
- kql-dashboard data-source DB dropdown fetches `/api/items/eventhouse/cluster`
  which **does not exist** (404 swallowed → silent free-text degrade).
- mirrored-databricks `mirrorMode` stored but no UI sets it / nothing reads it.
- mounted-adf Triggers tab read-only (start/stop/upsert/delete exist, unwired).
- ml-model "Open run" lineage link → `/workspace/...` 404 (route doesn't exist).
- power-automate-flow "Run flow" always POSTs `triggers/manual/run` → 404 for
  scheduled/automated/event flows (not gated by triggerType).
- geo-map "Tile layer URL" field persisted but never rendered.
- dataset "Scope" dropdown only ever shows hard-coded "Hub (all)".
- health-check rules table / activator rules table / mounted-adf triggers are
  create-only (delete/disable/edit backends exist, no row actions).
- compute list-view `power()` calls a no-op `reloadDetail` (harmless).
- Several ribbon Add/Save/Delete/Publish buttons across Copilot Studio editors
  are permanently disabled-with-tooltip (the explicitly-forbidden `ui-parity`
  shortcut) while the real action lives on an inline button.

---

## 6. Missing features vs Azure/Fabric parity

- **Copilot Studio Analytics:** 4 tiles vs 8 tabs (20 gaps: KPIs, compare-period,
  channel/lang/auth filters, CSAT histogram, transcript drill-down, Topics/Themes,
  generative-answer quality, cost-savings, exports).
- **Copilot Studio knowledge:** single free-text URI for all source types — no
  file upload, SharePoint/Dataverse picker, crawl depth, or reindex.
- **Copilot Studio action:** 4-field form (name/type/flowId/connectorId) with
  hand-typed GUIDs vs connector gallery + flow picker + schema mapping.
- **Azure SQL server / MI / Postgres flex:** management surfaces (Networking/PE,
  Entra-only auth, Auditing, Defender, TDE/CMK, Backups/PITR/LTR, Failover groups,
  Read replicas, Server parameters, HA) largely absent.
- **Logic App:** no designer / editable code view (PUT exists, unwired).
- **APIM policy:** no guided "+Add policy", no "Calculate effective policy", no
  policy fragments; scope targets are free-text Inputs not pickers.
- **data-product lineage:** real Purview subgraph rendered as a flat HTML table +
  8-char GUID edge stubs instead of a node-link canvas.
- **mounted-adf:** no data-flow live preview (honest gate); triggers read-only.
- **databricks-cluster:** no access-mode/Photon/pools/tags/env-vars/editable
  spark_conf/libraries/init-scripts in the create form.
- **dataverse-table:** no edit/delete columns, keys, relationships, views,
  business rules; Data tab read-only.
- **ai-foundry-project, dataset, evaluation, event-schema-set, health-check,
  ml-model, environment:** thin lifecycle (no delete/disable/edit/re-run/version
  management despite client functions existing).
- **data-agent:** semantic-model (DAX/XMLA) execution honest-gated but not wired.
- **map vs geo-map:** two divergent map editors; consolidate.
- **release-environment:** promote records an audit row but never deploys.

---

## 7. Performance / poor-config

- **adf-client `listPipelines/listDatasets/listTriggers`** never follow
  `nextLink` → editors silently truncate to the first ~50 (pickers miss items).
  Same pagination gap: `foundry-client.listDataAssets`, `powerplatform-client.
  listTables` (pulls all 1000+ then client-slices 500), `databricks-job listJobs`
  (limit 50, no token), all Copilot Studio list queries (no `$top`/nextLink),
  `materialized-lake-view/runs` (pool-wide top 100 then client-filter — can
  under-report).
- **No timeout / unbounded fan-out:** airflow DAG proxy (bare `fetch`, no limit),
  dashboard runs every tile concurrently with no cap, graph/copilot editors use
  raw `fetch` without `AbortController`.
- **No row cap:** postgres-flex query buffers all rows (time-bounded, size not);
  gql-graph `make-graph` unions every `Node_*`/`Edge_*` with no `take`.
- **Honest-gate styling inconsistency (poor-config):** databricks-sql-warehouse
  data-plane routes, adf-dataset/-trigger list routes, geo-dataset Inspect, and
  apim-product per-item routes throw a generic 502 raw-env-var error instead of
  the structured 503 `not_configured` gate their siblings use (`databricksConfig
  Gate`/`adfConfigGate`/`apimConfigGate` already exist but aren't threaded in).
- **gql-graph** returns HTTP 200 on ADX 401/403 (status lies; body carries `ok:false`).
- **copilot-studio Direct Line** hardcodes the commercial host (no
  `cloud-endpoints.ts` entry) → Test chat broken on GCC-High/DoD.
- **Free-text where pickers required (`loom_no_freeform_config`):** evaluation
  create form (comma-split evaluators, raw `azureml://` dataset path, freeform
  deployment), operations-agent bindings, ontology DSL in a Monaco tagged
  `language="json"`.

---

## 8. Tutorial / catalog breakages

- geo-pipeline catalog: "ADF integration deferred to v3.x" — stale; it now does
  real `createRun`. Update overview (real trigger; enrichment activities
  operator-built).
- notebook editor header docstring claims a hard Fabric-tenant SP requirement
  that no longer applies (listing/compute are Cosmos/Synapse/Databricks/AML).
- cosmos-gremlin info bars + file header say "returns 501"; code returns 503.
- copilot-studio-analytics header/spec call the daily chart a "sparkline
  placeholder" though real bars are rendered — fix the comment.
- copilot-template-library "Lakehouse Q&A" seed references "Fabric Lakehouse
  semantic model" in shipped default content — reword to Azure-native per
  `no-fabric-dependency`.

---

## 9. Recommended next waves (ordered by impact)

**Wave 1 — Stop shipping wrong/fake output (correctness):**
1. Fix paginated-report Export to call `renderReport()`; realign the gate (C1).
2. Copilot Studio family: live-tenant verify every `msdyn_*` entity/column; fix
   the 404 handler so schema errors aren't masked (H1); then either build real
   channel publish (Bot Service) or honest-gate it (H2).
3. Remove the analytics zeros-coercion; build Dataverse/App-Insights backend or
   gate (H3). Same for content-safety policy stub.
4. geo-pipeline: ship a real enrichment activity graph or tell the truth in the
   receipt (H5).
5. operations-agent: map binding ids to valid Foundry tool types or remove the
   tool claim (H6).

**Wave 2 — Make wired-but-broken paths work:**
6. apim-policy: read `useSearchParams` for scope/apiId/operationId; add pickers (H9).
7. Persist query text + add create gates for cypher-graph/gql-graph/geo-query;
   add a real cluster/db picker and stop reusing the item's own id as a kql id.
8. compute: remove hard-coded eastus2 fallback; raise `NotDeployedError` (H11).
9. Fix dead links/dropdowns: ml-model "Open run", kql-dashboard
   `/eventhouse/cluster`, power-automate "Run flow" trigger-type gating,
   dashboard drag-to-arrange (or drop the copy).

**Wave 3 — Parity build-out (ui-parity):**
10. Copilot Studio topic visual canvas (H4); map dataset-binding + layer model
    (H7); mirrored-databricks SQL-endpoint/shortcut pairing (H8).
11. Logic App designer + editable code view (PUT already exists).
12. SQL/MI/Postgres management surfaces; dataverse-table full CRUD; APIM guided
    policy/fragments; data-product lineage canvas.

**Wave 4 — Hygiene / refactor:**
13. Thread `nextLink` pagination into all `list*` helpers; add `fetchWithTimeout`
    + concurrency caps to airflow/dashboard/graph/copilot fetches; cap query rows.
14. Standardize honest-gate routing (`*ConfigGate` 503) across the inconsistent
    routes; add `cloud-endpoints.ts` Direct Line for sovereign clouds.
15. Replace remaining free-text config with pickers (evaluation, operations-agent,
    ontology); fix stale catalog/info copy in §8.
16. Wire surfaced-but-unreachable backends (template-library author UI, dataset
    detail nav, ontology-sdk DAB provisioning, create-only rule/trigger tables).

---

*Generated from the E2E audit finding set; surface/line references are included
inline so each item is independently verifiable.*
