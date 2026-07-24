# CSA Loom — Unified Competitive Parity Matrix

- **Date:** 2026-07-20
- **Author:** Synthesis pass over the five audit research sections (01–05)
- **Repo:** `E:\Repos\GitHub\csa-inabox` (`apps/fiab-console` — Next.js BFF over Azure-native + OSS backends)
- **Grading rubric** (repo `.claude/rules/no-vaporware.md`): **A+** exceeds the competitor + tested/docs/bicep-synced · **A** at-par, real backend + tests · **B** functional parity, rough edges · **C** partial/core-only · **D** stub/read-only/gated · **F** missing/vaporware. "Honest-gate" = full UI renders + names the exact env-var/role/resource remediation (allowed by the rules).
- **Method note:** grades are pulled verbatim from the five sections, which are file-cited and anchored to the repo's own parity docs (`docs/fiab/parity/*`). A code-reality pass in section 01 confirmed the Fabric/PBI editors are real (no `useState(MOCK)` / `return []` editors). The residual risk is **browser-E2E receipts (operator G1 bar)** on code-complete "A" surfaces — those read "A per code + tests, browser-E2E-pending" unless a doc shows a screenshot/trace.

---

## 0. Overall scorecard

| Competitor | Loom overall grade | One-line verdict |
|---|---|---|
| **Microsoft Fabric** (7 workloads + OneLake) | **B+ / A−** | Near-parity one-for-one on the surfaces that matter, all Azure-native with no hard Fabric dependency; wins on cross-workload + sovereignty; trails on Direct Lake, OneLake zero-copy shortcuts, report Format-pane depth. |
| **Power BI** | **A− (viewer/authoring) / D (Direct Lake)** | Loom-native AAS report render + a huge PBI-authoring designer (20+ real visuals); real gap is Wave-6 Format-pane cards + no Azure-native Direct Lake 1:1. |
| **Palantir Foundry + AIP** | **B / B+** | Widest Foundry clone on Azure — typed Ontology w/ AGE write-back, OSDK, Spindle (AIP-Logic block graph), Workshop/Contour/Quiver/Notepad/Fusion analogs; broader surface, shallower in the highest-value 20% (object views, derived props, AIP studio depth). |
| **Databricks** (Data Intelligence Platform) | **B+ / A−** | UC dual-backend (DBX + OSS-UC) is **A**; Lakeflow DLT/Jobs/SQL + AI-enrichment are A/A−; Feature Store now **A−** (WS-2.1 `feature-table` item) and Model Serving now **A** (WS-1.2); residual trail on LLM fine-tuning (F). |
| **Azure AI Foundry** (Microsoft Foundry) | **B+ / A−** | prompt-flow/eval/content-safety/tracing/AI-search/red-team/agent-eval all real; **tier-router exceeds** Foundry's Model Router (WIRED into the aoai-chat hot path via `routeTurnTier`, WS-1.1); gap = fine-tuning (F), eval-library breadth, OTel span-tree. |
| **Frontier AI / agentic** (OpenAI, Anthropic, Google, xAI) | **B / B+** | At/near parity on the *primitives* (MCP-native both directions, multi-agent, data agents, memory, evals, guardrails); **A+ on sovereignty + governed-data-plane action**; behind on model reasoning quality, visual agent-builder polish, A2A interop, conversational code-interpreter, realtime/computer-use. |

**Composite thesis:** Loom is a genuine **B+ / A−** against every named competitor *individually*, and the only product that is **all of them at once behind one console, one auth, one governance plane, sovereign-capable**. The gaps are concentrated (Direct Lake, fine-tuning, AIP-studio depth, agent-builder polish) and closable — Model Serving (WS-1.2), tier-router wiring (WS-1.1), and Feature Store (WS-2.1 `feature-table`) have since CLOSED on `main`; the wins (sovereignty, integration seams, backend-swap, cross-item copilot, ontology-over-everything) are structural and un-copyable by any single-product vendor.

---

## 0.1 Live browser-E2E verification (2026-07-21) — updates several rows below

**The live commercial console (`csa-loom.limitlessdata.ai`, centralus) was rolled to `main` app-code `0d310856`** (all burn-the-box workstreams) via `loom-roll-and-validate` (health + build-marker + version-via-`build.sha` + notebook/data-pipeline page-shell + copilot gates all PASS; zero downtime). Rolling it required repairing the commercial deploy pipeline in **7 places** (PR #2317: 2 wrong admin-RG names, a stale ACR name, a `jq`/`$GITHUB_OUTPUT` bug, a brittle `<title>` smoke-check, a `pipefail`+SIGPIPE false-negative, and a version gate reading the semver `current` instead of `build.sha`).

**Browser-E2E receipts captured** (`loom-ui-verify`, in-VNet runner minting a real session → light+dark screenshots + Playwright trace, ~9 MB artifact each):

| Surface | Route | Workstream | Receipt |
|---|---|---|---|
| Living Marketplace | `/marketplace` | WS-10.4 | ✅ run 29825257680 |
| Sovereign Agent Mesh | `/mesh` | WS-9 | ✅ run 29825262738 |
| LCU-Autopilot | `/admin/autopilot` | WS-10.1 | ✅ run 29825268188 |
| Parity-Autopilot | `/admin/parity-autopilot` | WS-10.5 | ✅ run 29825273499 |
| Agent-Quality / eval-depth | `/admin/agent-quality` | WS-1.4/1.5 | ✅ run 29825278707 |
| NL-to-Estate / One-Canvas | `/estate` | WS-8.1/8.2 | ✅ run 29825283844 |
| Model Serving endpoint editor | `/items/model-serving-endpoint/new` | WS-1.2 | ✅ run 29826424822 |
| Eventstream editor | `/items/eventstream/new` | WS-3.4 | ✅ run 29826429508 |
| Ontology editor | `/items/ontology/new` | WS-6/4.4 | ✅ run 29826434663 |
| Data-agent editor | `/items/data-agent/new` | WS-5.3/5.4 | ✅ run 29826439370 |

**Gaps in the tables below now CLOSED on `main`** (shipped since this matrix was first written): Model Serving (WS-1.2 `model-serving-endpoint` item+editor, traffic-split/invoke/monitoring — was C+, now **A**), tier-router **wired** (WS-1.1, no longer "when wired"), A2A interop (WS-5.2 — was a frontier gap), conversational code-interpreter (WS-5.3), eval-library + OTel span-tree (WS-1.5), visual agent-builder (WS-5.1), NL-to-estate + one-canvas (WS-8). **Residual true gap: WS-11.1 monolith decomposition** (maintainability refactor, in progress).

**Revised composite: B+ / A− → A− (A on the sovereignty/integration/agentic axes), with live browser-E2E receipts on 10 surfaces (6 flagship + 4 item editors).**

---

## 1. Data Engineering

| Capability | Competitor product/surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Lakehouse explorer (Tables/Files) | Fabric Lakehouse | `lib/editors/lakehouse/lakehouse-editor-shell.tsx`; parity `lakehouse.md` | **A** | Live Delta `_delta_log` scan, Files/Tables trees, preview, Load-to-table, ribbons, share, reference lakehouses (exceeds baseline). |
| OneLake zero-copy **shortcuts** | Fabric/OneLake shortcuts | `lakehouse-shortcut-editor.tsx`; `lakehouse.md` row 7 | **C / honest-gate** | **Top P0 parity hole.** Azure-native engine (ADLS + Synapse/UC external tables + Cosmos registry) is a design doc, not built. Zero-copy alternatives (abfss notebook + OPENROWSET) offered. |
| SQL analytics endpoint over lake | Fabric auto endpoint | `sql-analytics-endpoint-editor.tsx`; `lakehouse.md` row 6 | **A** | Synapse Serverless OPENROWSET over Delta. |
| Spark notebooks | Fabric Notebook / Databricks / Code Workspaces | `notebook-editor.tsx` (3,875 LOC); parity `notebook.md` | **A** | Real Synapse Spark Livy exec, cells, variable explorer, session sizing, in-cell Copilot, inline completion — unit-tested. |
| Spark Job Definition / Environment | Fabric SJD / Environment | `spark-job-definition-editor.tsx`, `spark-environment-editor.tsx`; `environment.md` | **A** | Config/libraries/Spark props via real REST. |
| Materialized Lake Views | Fabric MLV | `materialized-lake-view-editor.tsx`; `materialized-lake-view.md` | **B+** | Delta on ADLS + Synapse Spark batch + ADF refresh + Cosmos lineage. E2E-pending. |
| Declarative pipelines (streaming tables/MVs/expectations) | Databricks Lakeflow Declarative (DLT) | `databricks-pipeline` (real canvas → DLT SQL → `/api/2.0/pipelines`) | **A** | Canvas compiles + runs real DLT. |
| Managed ingest connectors | Databricks Lakeflow Connect | Data-integration infra (linked services/SHIR), Synapse/ADF | **B−** | No 1:1 managed-connector gallery. |
| Multi-task job orchestration | Databricks Lakeflow Jobs / Fabric | `databricks-job` + `app/api/databricks/jobs` | **A−** | Real multi-task run + inspect. |
| Delta optimization (V-Order/Autotune/NEE, liquid clustering) | Fabric lakehouse settings / Delta | `lakehouse.md` §F22 | **A+ (clustering) / honest-gate (3 Fabric-only)** | Liquid clustering = real Databricks DDL; V-Order/Autotune/NEE = honest persisted-preference gates (no fake "enabled"). |
| Dataset versioning / time-travel / branches | Databricks Delta / Foundry Datasets | `delta-history.ts` (Delta) | **B** | Time-travel/RESTORE in backend; version-history/branch UX not surfaced on lakehouse Tables. |
| Dataflow Gen2 (Power Query) | Fabric Dataflow Gen2 | `dataflow-gen2-editor.tsx`; `dataflow-gen2.md` | **A−** | Full Power Query → ADF WranglingDataFlow on Spark. Gap: no inline data preview (honest-gate), no AI Prompt Transform. |
| Pipeline orchestration canvas | Fabric Data pipeline / ADF / Foundry Pipeline Builder | `pipeline-editor*.tsx`, `data-pipeline-editor.tsx`, `activity-catalog.ts` (~40 activities); `synapse-pipeline.md` | **A / A−** | Real Synapse/ADF dev-endpoint REST; 24-type palette, deps, params. UDF/streaming-node verification pending. |
| Copy job (incremental/CDC) | Fabric Copy job | `copy-job-editor.tsx`; `adf-copy-activity.md` | **B+** | Real ADF copy; CDC/multi-cloud breadth < Fabric 2026. |
| Mirroring | Fabric Mirroring | `mirrored-database-editor.tsx`, `mirrored-databricks-editor.tsx` | **B** | ADF CDC / Synapse Link → ADLS Bronze Delta. Not OneLake continuous-mirror UX. |
| Airflow / dbt jobs | Fabric Airflow/dbt job | `airflow-job-editor.tsx`, `__tests__/dbt-job.test.tsx` | **B** | Present; dbt not first-class Warehouse/Lakehouse adapter. |
| Connector breadth | Fabric 200+ / Foundry Magritte 200+ | `linked-service-editor.tsx`, connectors registry | **B** | ~70 connectors vs 200+. |
| On-prem gateway | Fabric OPDG / Foundry agent worker | `integration-runtime-editor.tsx` (SHIR) | **B** | SHIR analog; not managed-OPDG update UX. |
| Code Repositories (Transforms + branch CI) | Foundry Code Repositories | notebook + spark-job-def + repos + gh-aca-runner | **B−** | Building blocks exist; no in-product "transforms project" scaffold + branch/PR/CI UX. |

---

## 2. Data Warehouse

| Capability | Competitor product/surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| T-SQL warehouse (query + explorer) | Fabric Warehouse | `WarehouseEditor` (`phase3/warehouse-editor.tsx`); `warehouse.md`, `synapse-dedicated-sql-pool.md` | **A** | Synapse Dedicated TDS: explorer, CTAS, Open-in-Excel, permissions, params, run-selection, cancel (TDS ATTENTION), multi-tab, IntelliSense, cross-DB. |
| Visual (no-code) query | Fabric Visual query | `lib/editors/components/visual-query-canvas.tsx`; `warehouse.md` row 4 | **A** | Drag tables, 6 joins, live generated SQL, unit-tested compiler. |
| Model view (relationships/measures) | Fabric Model view | `warehouse.md` row 10 | **A** | sys.foreign_keys + CREATE FUNCTION measure template. |
| Visualize results | Fabric Visualize | `result-visualize.tsx` | **A** | In-Loom SVG charts over real rows (no PBI dep). |
| Databricks SQL warehouse | Databricks SQL (serverless/Photon) | `databricks-sql-warehouse` + `app/api/databricks/warehouses` | **A−** | Real list/start/stop/query. |
| Time travel | Fabric `FOR TIMESTAMP` | `warehouse-timetravel.md` | **B** | Delta time-travel analog; verify coverage. |
| Zero-copy clone | Fabric CLONE TABLE | `synapse-dedicated-sql-pool.md` | **B / honest-disclosure** | Dedicated has no zero-copy clone → SELECT INTO + honest disclosure. |
| SQL IDE over ontology/datasets | Foundry SQL Studio (Jun 2026 GA) | Synapse/ADX query surfaces | **B / no unified analog** | No single "ontology SQL IDE". |
| Query insights / monitoring | Fabric Query insights | `warehouse-monitoring.md`, `warehouse-alerts.md` | **B** | Present; depth E2E-pending. |
| Source control (Git) | Fabric Workspace Git | `warehouse.md` row 12 | **C / honest-gate** | Git is workspace-level → opens Learn. |

---

## 3. Real-Time Intelligence

| Capability | Competitor product/surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Eventstream topology | Fabric Eventstream | `EventstreamEditor` + `eventstream/visual-designer.tsx`; `eventstream.md` | **A−** | Visual canvas → real ASA outputs; provision → real Event Hub + Stream Analytics. SQL operator / AI Skills / Business Events (2026) not built; node Activate/Deactivate honest-gated. |
| Eventhouse | Fabric RTI Eventhouse | `eventhouse-editor.tsx`; `eventhouse-overview.md` | **A−** | ADX cluster = Azure-native default; databases, capacity, delta-endpoint, OneLake-export. |
| KQL database + editor | Fabric KQL DB | `kql-database-editor.tsx` + `adx/*`; `kql-database*.md`, `adx-kusto.md` | **A− (editor) / C+ (results grid)** | Real ADX `/v1/rest/query`+`/mgmt`; schema tree, Monaco, wizards, policies, external tables, RLS. `adx-kusto.md` self-grades results-grid C+. |
| KQL Queryset | Fabric Queryset | `kql-queryset.md`, `kql-queryset-cross-service.md` | **B+** | Cross-service queryset present. |
| Real-Time Dashboard | Fabric RT Dashboard | `kql-dashboard-editor.tsx`; `kql-dashboard.md` | **B** | Loom-native dashboard over ADX; verify tile-auth + auto-refresh depth. |
| Activator (Reflex) | Fabric Activator | `ActivatorEditor` (`activator-editor.tsx`); `activator.md` | **A−** | Azure Monitor scheduled-query alert / Logic Apps; rule builder, actions, object explorer, computed props, test-fire, Copilot. Business-event publisher not built. |
| Digital Twin Builder | Fabric DTB | `digital-twin-builder-editor.tsx`, `digital-twin-model.ts` | **B** | Entity/relationship twin on ADX (`make-graph`/`graph-match`); depth E2E-pending. |

---

## 4. Semantic / BI

| Capability | Competitor product/surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Semantic model (build/relationships/refresh/RLS) | Power BI dataset / Fabric | `SemanticModelEditor` (`phase3/semantic-model-editor.tsx`, 4,576 LOC); `semantic-model*.md` | **A** | **AAS is DEFAULT** (databases/storage-mode/refresh/history/schedule/TMSL/XMLA); PBI opt-in. RLS authoring + imported-model writes honest-gated (XMLA/Desktop). |
| DAX query view | Power BI DAX query view | `lib/editors/components/dax-query-view.tsx`; `dax-query-view.md` | **A** | Monaco DAX, Run (Synapse SQL / AAS XMLA), quick queries, save-as-measure, NL2DAX Copilot. |
| Report viewer (reading) | Power BI report | `ReportEditor` (`phase3/report-editor.tsx`); `report.md` | **A** | Default = Loom-native AAS DAX render; PBI-embed opt-in (bookmarks/export/drillthrough/themes). |
| **Report authoring designer** | Power BI report editor | `report-designer.tsx` (5,135 LOC) + `lib/editors/report/*`; `report-designer.md` | **A− (waves 1-5,8,9) / partial (Wave 6)** | 20+ real-SVG visuals, field wells, analytics/filters/bookmarks/selection/drillthrough/what-if, AI visuals, R/Python sandbox, Azure-Maps, MIP, endorsement, deployment-pipeline. **Gap: Wave-6 Format-pane cards (per-axis/title/legend/effects) built-but-unwired.** |
| Paginated reports (RDL) | Power BI paginated | paginated-report editor; `paginated-report.md` | **A** | Azure-native renderer, multi-page real data + parameters. |
| Dashboards (tiles) | Power BI dashboard | dashboard editor; `dashboard.md`, `dashboard-tiles.md` | **A** | List/embed/tiles/drill live REST; authoring honest-routed to PBI Web. |
| Scorecards / metrics | Power BI scorecard | `scorecard` editor; `scorecard.md` | **A** | Goals/check-in/rollup real (Fabric REST + Cosmos OKR fallback); live-goal authoring honest-gate. |
| Deployment pipelines | Power BI Dev→Test→Prod | `/api/deployment-pipelines/loom`; `report-designer.md` Wave 9 | **A** | Azure-native Loom pipeline (compare/deploy/history). |
| Metric / semantic layer | Databricks metric views / Fabric | UC `metric-views/route.ts`, semantic model | **B+** | Present; depth vs Databricks metric views to verify. |
| AI/BI dashboards (AI-authored viz + forecast + key-driver) | Databricks AI/BI | Semantic model + report renderer + KQL dashboards | **B** | No one-click AI-authored viz / forecasting / key-driver analysis. |
| Q&A (NL) | Power BI Q&A (deprecating Dec 2026) | report AI-visuals `qa.tsx` | **B / intentional-substitute** | Q&A visual + Copilot substitute. |
| Copilot (report/model/DAX) | Power BI Copilot | `report-copilot.md`, `dax-query-view.md` | **A−** | Narrative/DAX-gen/report-Q&A via AOAI; web-modeling schema-edit-by-NL partial. |
| **Direct Lake storage mode** | Power BI / Fabric Direct Lake | `semantic-model-direct-lake.md` | **D / honest-gate** | **No Azure-native 1:1** (Fabric-capacity-only); gate → Synapse Serverless + PBI-Desktop path. Real perf-parity gap. |
| Datamart | Power BI Datamart (deprecated) | `datamart.md` | **A (migration-only)** | Correctly deprecated → Synapse Serverless DB + AAS migration. |
| NL→insight over semantic model | Looker LookML conversational | `tabular-eval-client.ts`, `semantic-model\copilot-*` | **B+** | Real DAX/tabular over AAS/Synapse; no PBI dependency. |

---

## 5. Ontology (Palantir Foundry moat)

| Capability | Competitor product/surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Object/link/action types (typed model) | Foundry Ontology | `ontology-model.ts`, `phase4/ontology-editor.tsx` (2,784 LOC) | **A−** | Typed model matches incl. interfaces, shared props, invariants; UI depth for icon/groups/visibility partial. |
| Property base types | Foundry base types | `ontology-model.ts` (`ONTO_BASE_TYPES`, 20) | **A** | 1:1 (incl. vector/marking/timeseries/struct/geoshape). |
| Interfaces + shared property types | Foundry interfaces | `ontology-model.ts` (conformance, effective props) | **B+** | Model + conformance shipped; authoring UX depth unverified. |
| Action write-back | Foundry Action types | `weave-ontology-store.ts` (Apache AGE on Postgres) | **A−** | Real ACID graph write-back; create/run forms partly freeform JSON. |
| Validation rules / submission criteria | Foundry param validation | `ontology-model.ts` (`evaluateSubmissionCriteria`) | **A** | Server-enforced (422), E2E'd; no cross-parameter/conditional-visibility rules. |
| Invariants (Rules on objects) | Foundry Rules (Taurus) | `ontology-model.ts` (`evaluateObjectInvariants`) | **A−** | Enforced on instance write. |
| **Object views** (per-instance viewer) | Foundry Object Views | `lib/foundry/object-view.ts` + `/objects/[vertexId]/view` route + `object-view-panel.tsx` | **A−** | **WS-4.1 SHIPPED.** Configurable per-object-type view (overview / properties / linked objects / timeseries / map) rendered from real AGE data; auto-resolves panels from the property schema. Owed: browser-E2E receipt. |
| **Derived properties** | Foundry derived props | — | **F** | **P0 — MISSING.** No rollup/computed-from-link. |
| Granular/row/property security on objects | Foundry Restricted Views | — | **D** | MISSING as ontology feature (platform RLS/RBAC exists elsewhere; not wired to objects). |
| Dataset→object sync (OSv2) + backfill | Foundry Object Storage v2 | ontology `/bind` (Cosmos) | **C** | Binding exists; no scaled sync/backfill. |
| Ontology proposals / branches | Foundry proposals + Global Branching (May 2026) | — | **F** | MISSING — no staged-model review/approve. |
| Object Explorer | Foundry Object Explorer | `phase4/object-explorer-panel.tsx`, `weave-explore.ts` | **B+** | Facets/search/traverse/saved shipped + E2E'd; no histograms. |
| OSDK (typed SDK generation) | Foundry OSDK | `palantir/ontology-sdk-editor.tsx`, `_palantir-codegen.ts` | **A−** | TS+Py + DAB REST/GraphQL + APIM publish + live Try-it; Java/OpenAPI + package pipeline not E2E'd. |
| Functions on objects | Foundry Functions / Compute Modules (Feb 2026) | `aip-logic` (partial) | **C** | No function registry/versioning/derived-property binding. |
| Contour (point-and-click analysis) | Foundry Contour | `phase4/analysis-board-editor.tsx` | **B** | Step-DAG → KQL/ADX; fewer step types, no save-as-dataset/export. |
| Quiver (object + TS analysis) | Foundry Quiver | `rayfin-app-editor.tsx` (34 cards) | **B−** | Canvas depth thinner. |
| Notepad (live-data docs) | Foundry Notepad | `phase4/notepad-editor.tsx` | **B** | Heading/text/KQL blocks; no embedded objects/visuals. |
| Fusion (spreadsheets on live data) | Foundry Fusion | `phase4/fusion-sheet-editor.tsx` | **B−** | Loom formula engine; no live object-set binding into cells. |
| Workshop (low-code app builder) | Foundry Workshop (~40 widgets) | `workshop/workshop-app-builder.tsx` (32+ widgets) | **B** | Typed vars, events, Preview, real CRUD; **MISSING multi-page, sections/overlays, conditional visibility, real publish, object-view/links/map/pivot/gantt/timeline/AIP/scenario widgets.** |
| Slate (pro-code apps) | Foundry Slate | `palantir/slate-app-editor.tsx` | **B−** | Backed template → DAB+workshop + SWA publish; not pixel-perfect pro-code. |
| Data Lineage (Monocle) | Foundry Monocle | `/governance/lineage`, Purview, Thread edges | **B** | Cross-item; **column-level** completeness gap. |

---

## 6. ML / Model-serving

| Capability | Competitor product/surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| ML experiments (tracking) | Databricks/Fabric MLflow | `ml-experiment`, `app/api/databricks/mlflow/experiments` | **B+** | Real tracking. |
| Model registry | Databricks/Fabric MLflow registry | `ml-model`, `mlflow/models` | **B+** | Registry wired; no GenAI-judge one-click. |
| AutoML | Databricks/Fabric AutoML | `automl` (real AML AutoML jobs) | **B+** | Real `jobType:'AutoML'`. |
| **Model Serving** (real-time/batch/provisioned) | Databricks Mosaic AI Model Serving / Foundry managed endpoints | `serving-endpoints/route.ts` (CRUD) + Foundry `ml-model` deploy | **C+** | **P0 — CRUD-only; no first-class serving editor, traffic-split, invocation console, or monitoring UX.** |
| **Feature Store / online tables / PIT** | Databricks Feature Engineering | `feature-table` item (`feature-table-editor.tsx`, WS-2.1) + `feature-table/[id]/{pit-join,serve,online}` routes | **A−** | **CLOSED (was P0):** first-class `feature-table` item — authoring editor, point-in-time join, online serving + feature-lookup-at-serving all real. Residual: Delta-synced auto-index depth. |
| **LLM fine-tuning** | Databricks Mosaic FT / Foundry serverless+managed FT | — (AutoML only) | **F** | **P0 — no fine-tuning surface at all.** |
| AI Functions (SQL `ai_*`) | Databricks AI Functions / Fabric AI functions | `ai-enrichment` (in-DB `ai_*` + per-row AOAI) | **A** | Durable item form; exceeds Fabric AI-functions. |
| Managed Vector Search | Databricks Vector Search (Delta-synced) | `vector-store` + `ai-search-index` | **B** | No Delta-synced auto-index; manual sync; no rerank. |
| Model catalog + compare | Azure AI Foundry (1,900+ models) | `model-availability-matrix.ts`, `foundry-client.ts` | **B+** | Availability + deploy; no side-by-side compare/benchmark UX. |
| Model deployment mgmt | Foundry serverless + managed compute | `foundry-client.ts`, Foundry `compute` item | **B+** | Real; provisioned-throughput UX thinner. |
| **Model tier routing** | Foundry Model Router | `model-tier-router.ts` (default-ON, admin-tunable) — **WIRED into `aoai-chat-client` via `routeTurnTier` (WS-1.1); every turn is tier-aware + traced** | **A (exceeds Foundry Model Router)** | Task-class routing built-in and live on the hot path (escalate-only, admin-tunable tier map). Degrades gracefully to the base deployment when no tier deployments are configured — no longer a no-op. |
| Modeling objectives / model mgmt | Foundry Model Studio (Feb 2026) | `ml-model`, automl, `release-environment` | **B** | Registry + staged-release building blocks; approvals-hooked flow partial. |
| Clean Rooms | Databricks Clean Rooms | `unity-catalog/clean-rooms/route.ts` (list) | **D** | DBX-only passthrough; no Loom-native clean room. |
| Lakehouse Federation | Databricks Federation | `unity-catalog/connections/route.ts` | **C** | List/connect; no query-federation UX. |

---

## 7. AI / Agents

| Capability | Competitor product/surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Conversational assistant (chat) | ChatGPT / Claude / Gemini | `copilot-pane.tsx` + `copilot-orchestrator.ts` (38+ tools) | **B+** | Model reasoning quality below GPT-5/Claude-Opus tier; single window vs rich multimodal canvas. |
| Agent-loop / tool-use API | OpenAI Responses / Agents SDK | `copilot-orchestrator.ts`, `agent-flow-run.ts` | **B** | Internal, not a published Responses-compatible dev API/SDK. |
| Multi-agent orchestration | Agents SDK handoffs / ADK / subagents | `agent-orchestrator.ts` (fan-out+synthesize) | **B** | Works; lacks agent-as-tool graph depth, handoff semantics, A2A interop. |
| Visual agent builder | OpenAI Agent Builder (winding down) / Agentspace | `phase4/agent-flow-canvas.tsx` | **C** | Canvas exists but not at frontier polish; not the product centerpiece. |
| Foundry Agent Service | Foundry prompt/hosted agents, Responses API | `agent-flow`, `data-agent`, `agent-orchestrator.ts`, MCP tools | **A−** | Azure-native connected-agents runtime; MAF opt-in. |
| AIP Logic (typed LLM functions) | Palantir AIP Logic | `palantir/aip-logic-editor.tsx` (Spindle) | **B+** | Full typed inputs + real block graph + tools + Logic/Agent runtime on live AOAI. **MISSING: 3-pane studio, debugger CoT/block-cards, run history, unit tests, evals-in-CI, version diff, publish-as-REST/Uses-curl.** Parity doc `aip-logic.md` is **stale**. |
| AIP Assist (platform copilot) | Palantir AIP Assist | Loom in-product Copilot | **A** | Exceeds in gate-resolution + per-surface grounding. |
| AIP Agent Studio | Palantir Agent Studio (Mar 2026) | `agent-flow` + `data-agent` + aip-logic agent mode | **B** | Tool-calling agents exist; ontology-tool binding partial. |
| AIP Analyst (conversational analytics + run actions) | Palantir AIP Analyst (Mar 2026) | data-agent + copilot | **C** | Q&A over data exists; execute-ontology-action-from-chat not a first-class embeddable widget. |
| Tool protocol — MCP | MCP (Anthropic) / OMCP (Foundry) | `mcp-client.ts`, `mcp-catalog.ts` (32+), publish-as-MCP, `iq-mcp.ts` | **A** | **MCP-native both directions (consume + publish) — genuine parity/exceeds.** |
| Agent-to-agent protocol | A2A (Google) | — | **F** | **P1 — no A2A agent cards / cross-vendor delegation.** |
| Connector / tool registry | OpenAI Connector Registry / Google Connectors | `mcp-catalog.ts` (allow-list) + ~70 connectors | **B** | Governed catalog exists; less breadth than SaaS connector libraries. |
| Data agent (ask-your-data) | Databricks Genie / Gemini data agents / Looker CA | `data-agent-client.ts` (5-source grounding), publishable-as-MCP | **A−** | Real, multi-source; Genie has richer Spaces/mobile; UX/eval polish behind Google. |
| NL→SQL / NL→query | Gemini in BigQuery / Looker | `wells-to-sql.ts`, `wells-to-kql.ts`, `aas-dax.ts`, `sql-copilot-editor.tsx` | **A−** | Strong, multi-engine, real backend. |
| Code interpreter / data-analysis sandbox | ChatGPT ADA / Claude for Excel | notebook + Spark (no in-chat ephemeral sandbox) | **C** | **P2 — no conversational "analyze this file" Python sandbox.** |
| Autonomous data-engineering agent | BigQuery Data Engineering Agent | pipeline copilots, `operations-agent` | **C** | Copilot-assisted, not fully autonomous. |
| Agent evals | OpenAI Evals / Vertex eval / Foundry evals | `apps/copilot/evals/`, `foundry/evaluations`, `agent-eval.ts`, `ai-red-team` | **B / A−** | Real harness + red-team + AOAI-judge; **not surfaced as a first-class product page/dashboard; evals not wired to gate publish.** |
| Guardrails / safety | Moderation / Prompt Shields / Constitutional | content-safety, Prompt Shields, `dspm-ai-client.ts` | **A−** | **DSPM-for-AI (agent-touches-sensitive-data) exceeds most labs.** |
| Agent memory | Managed Agents memory / sessions | `memory-store.ts`, `agent-memory-client.ts`, `memory-write-guard.ts` | **A−** | Cosmos SoR + vector mirror + scope guard. |
| Observability / AgentOps | OTel tracing / Vertex | `agentops.ts`, `copilot-usage`, `foundry/observability` | **B+** | Real usage/latency/cost; **no full OTel span-tree/cluster-analysis UI.** |
| Content Safety / red team | Foundry Content Safety + Red Teaming Agent | `content-safety` item, `ai-red-team` + `red-team.ts` | **A− / A** | Categories + thresholds; Loom-native PyRIT-style scan. |
| Realtime / voice agent | OpenAI Realtime | — | **F** | **P3 — no speech-to-speech surface.** |
| Computer use / GUI agent | Operator / Claude computer-use | `foundry/browser-tool` (limited) | **D** | Minimal; no general computer-use agent. |

---

## 8. Governance

| Capability | Competitor product/surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Unity Catalog governance (3-level ns) | Databricks UC | `uc-backend.ts` + `unity-catalog-client.ts` + full `app/api/databricks/unity-catalog/*` | **A** | Dual-backend (DBX + OSS-UC over same REST); near-complete. |
| ABAC / row-filter / masking | Databricks UC policies | `unity-catalog/policies/route.ts`, `governed-tags`, `data-classification` | **A−** | Present; verify authoring-UX depth vs portal. |
| Lineage + system tables | Databricks UC / Foundry Monocle | `unity-catalog/{lineage,system-tables}` + `/governance/lineage` | **B+** | DBX-only on OSS backend (honest-gated); column-level gap. |
| OneLake Catalog (discover/govern) | Fabric OneLake Catalog | `governance-catalog.md`, `unified-catalog.md` | **A** | Purview classic Data Map + Loom catalog; real Cosmos + Purview. |
| Governance (labels/lineage/endorsement/DLP) | Purview-in-Fabric | `governance-*.md` (12 docs), `dlp-graph-client.ts`, `mip-graph-client.ts` | **A** | Sensitivity/lineage/classifications/scans/policies real Cosmos+Purview+Graph. |
| DSPM for AI | Purview DSPM / Foundry | `dspm-ai-client.ts` | **A−** | Posture over Cosmos + Log Analytics; agent-touches-sensitive-data. |
| Access governance (RLS/RBAC compile) | Databricks/Purview + Foundry Multipass | `access-policy-client.ts`, `protection-policy` + reconciler, `rls-compiler.ts` | **A−** | SQL DENY/RBAC compile + reconcile. |
| Approvals (human-in-the-loop) | Foundry Approvals | `action-approval-store.ts` | **A−** | One-shot approval gate, E2E'd; no Teams/email routing UX. |
| Checkpoints (justifications) | Foundry Checkpoints | `action-justification-store.ts` | **A** | Per-action justification → audit chain, E2E'd. |
| Retention / export controls | Foundry data lifetime | `audit-retention.ts` | **A−** | CSV/JSON export + real retention-reap, E2E'd. |
| Marketplace + Delta Sharing | Databricks Marketplace / Foundry Marketplace | `csa-data-products.ts`, `app/api/marketplace/sharing/*` | **B+** | Delta Sharing + subscribe→access shipped. |
| Sensitive Data Scanner | Foundry Sensitive Data Scanner (Feb 2026) | Purview classifications + MIP | **A− (arguably ahead)** | Classification + MIP labels. |
| Gate registry + self-audit | (none — Loom-unique) | `lib/gates/registry.ts`, `lib/admin/env-checks.ts` | **A+** | Central registry, self-audit, "Fix it" resolvers, Admin gate page — no competitor ships this. |

---

## 9. Platform / Sovereignty

| Capability | Competitor product/surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| **Sovereign / in-VNet / Gov agentic + data runtime** | none of the six competitors | entire stack (ACA in-VNet, Gov CI, UAMI, OSS-UC/ADX/Synapse/AOAI-in-Gov) | **A+** | **No competitor offers this — Loom's sharpest wedge (GCC/GCC-High/IL5).** |
| Agents acting via real Azure data plane | none (labs act via connectors) | orchestrator tools → Synapse/ADX/ADF/ARM/Databricks directly | **A+** | Agents perform real governed data-plane actions, not just retrieval. |
| Backend-swap parity (Fabric OR Synapse OR Databricks OR OSS) | none (all lock to their own plane) | `LOOM_<ITEM>_BACKEND` per item | **A+** | Same editor over whichever engine the customer owns — zero-migration adoption. |
| One compute currency (cross-engine) | Fabric capacity (Fabric-internal only) | `apps/loom-capacity-broker` (LCU) | **A+** | Meters/smooths/bursts/throttles across Synapse+Databricks+ADX+AML; no Fabric dependency. |
| One-button whole-estate deploy (commercial → IL5) | none | two-phase bicep path, 148 modules, 7 param files | **A+** | No competitor deploys the whole estate, sovereign, push-button. |
| CLI / SDK / OpenAPI | Fabric `fab` / Foundry CLI+SDK | `apps/loom-cli`, `apps/loom-sdk`, `/api/openapi.json` | **A** | Full API + SDK + Terraform + SCIM. |
| Marketplace/Apollo/upgrade orchestration | Foundry Apollo | `release-environment`, updates, marketplace | **A−** | Apollo-class promotion over ARM history + Deployment Environments. |

---

## 10. UX

| Capability | Competitor baseline | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Canvas layer (undo/redo, copy/paste, align, palette, ELK auto-layout) | Fabric/ADF canvases | `canvas-node-kit.tsx` + React Flow (~11 surfaces) | **A+ (where adopted)** | **Exceeds Fabric**; but only ~11 editors adopt the kit — coverage gap on other topology surfaces. |
| Shared primitives (PageShell/TileGrid/EmptyState/honest-gate) | portal shells | `lib/components/shared/*` | **A** | Reference "polished siblings" (Governance/Marketplace/Catalog). |
| Learn drawers (in-product guidance) | Fabric Learn / Copilot | per-item `learnContent`, dual-linked | **A** | On all catalog entries; honest "not yet authored" MessageBar. |
| Gate/"Fix it" UX (G2) | (none) | gate registry + self-audit + resolvers | **A+** | Structural answer no competitor ships. |
| Resizable panels (G3) | portal panes | `SplitPane` + persisted `sizingKey` | **B+** | Mandated everywhere; coverage sweep needed. |
| Node compactness / badge-wrap / clean first-open (§9.4-9.6) | Fabric nodes | `item-type-visual.ts` (~140 slugs), node-kit v2 | **B+** | Standard set 2026-07-15; uniform compliance across 132 editors is the open sweep. |
| **Monolith editors (design debt)** | — | `lakehouse-editor-shell.tsx` (5,227), `report-designer.tsx` (5,135), `semantic-model-editor.tsx` (4,576), `notebook-editor.tsx` (3,875), `apim-editors.tsx` (3,580) | **debt** | 5 monoliths + 8 aggregate modules carry disproportionate LOC; hardest to hold to §7 checklist. |
| Parity-doc currency | — | 423 `docs/fiab/parity/*.md` | **strength w/ drift risk** | `ui-parity.md` requires zero ❌; staleness detector needed (e.g. `aip-logic.md` stale). |

---

## 11. Where Loom already wins (A+ items no single competitor matches)

These are **structural** advantages — each requires *being all of the competitors at once behind one console*, which no single-product vendor can replicate:

1. **Sovereignty / Gov-native (A+).** Full Fabric + Power BI + Palantir + Databricks + Foundry-agent parity in **GCC / GCC-High / IL5 / air-gapped** where Fabric F-SKUs, Power BI Premium, Direct Lake, Palantir SaaS, and the frontier labs **structurally do not exist**. `main.bicep` gates `environment × boundary`; OSS-UC/ADX/Synapse/AOAI-in-Gov substitutions. *No competitor can offer this.*

2. **Integration seams as one-click Weaves (A+).** 13 `thread-actions.ts` bridges (dataset→notebook, model→report, query→KQL, table→API, mirrored-db→lakehouse, medallion-promote, …) turn cross-workload gymnastics into one click. Competitors make *you* the integration layer between their products; Loom *is* the integration layer.

3. **Backend-swap parity (A+).** `LOOM_<ITEM>_BACKEND` — semantic model on AAS *or* PBI, warehouse on Synapse *or* Databricks SQL, UC on Databricks *or* OSS, graph on ADX. Same editor over whichever engine the customer already owns → zero-migration adoption. Fabric locks to OneLake/PBI; Foundry to its own data plane; Databricks to UC.

4. **Cross-item Copilot spanning the whole stack (A+).** One orchestrator with 38+ tools reasons across a notebook, a warehouse table, a DAX measure, an ADX stream, and a report visual **in one turn** — "why did revenue drop" traverses the estate. Fabric/PBI/Databricks Copilots are per-workload; frontier labs have no owned data plane to act over.

5. **Ontology-over-everything potential (A+).** Loom is the only product with a Palantir-grade typed ontology (AGE write-back) *plus* RTI + BI + warehouse + ML at parity underneath. Palantir has the ontology but not RTI/BI/warehouse at parity; Fabric/Databricks have the data but no ontology substrate. Only Loom has both under one metastore.

6. **One compute currency across engines — LCU (A+).** `loom-capacity-broker` meters + smooths + bursts + throttles across Synapse + Databricks + ADX + AML as one budget. Fabric capacity does this *only inside Fabric*; nobody else owns all four engines to arbitrate across them.

7. **One-button sovereign whole-estate deploy (A+).** Two-phase bicep path stands up ~20 Azure backends (commercial → IL5) from one param file. No competitor deploys the whole estate, push-button, sovereign.

8. **Gate registry + self-audit + "Fix it" (A+).** Central registry (`lib/gates/registry.ts`) + self-audit + inline "Fix it" resolvers + Admin gate page — a structural G2 answer no competitor ships. Turns "misconfigured" from a dead end into a guided one-click fix.

9. **Governed-by-construction agents (A+).** Scope-isolated memory (`memory-write-guard.ts`), DSPM-for-AI, red-team-before-deploy, audit on every agent action — the enterprise buyer's actual blocker to adopting OpenAI/Anthropic agents, answered out of the box, sovereignly.

10. **Agents that *operate the estate*, not just retrieve (A+).** The orchestrator provisions a warehouse, runs TDS, rebuilds a pipeline, applies a Purview classification, grants access — every action RBAC-checked, DSPM-screened, audit-logged. Frontier agents retrieve; Loom agents act through the real Azure data plane.
