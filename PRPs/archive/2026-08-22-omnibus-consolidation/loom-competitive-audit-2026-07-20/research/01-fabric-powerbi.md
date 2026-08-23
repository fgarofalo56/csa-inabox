# CSA Loom — Competitive Audit: Microsoft Fabric + Power BI

**Cluster:** Microsoft Fabric (all workloads) + Power BI
**Date:** 2026-07-20
**Repo:** `E:\Repos\GitHub\csa-inabox` (`apps/fiab-console` — Next.js BFF)
**Grounding:** Microsoft Learn (Fabric / Power BI, current to June 2026 releases) via `microsoft_docs_search`; Loom reality read from `apps/fiab-console/lib/editors/`, `lib/catalog/`, `app/api/`, and the repo's own file-cited parity docs in `docs/fiab/parity/`.
**Grading rubric (repo `no-vaporware.md`):** F = vaporware (looks real, isn't), D = stubbed (renders, does nothing), C = functional-rough, B = production-grade (real data + real backend), A = B + tested, A+ = A + docs + bicep-synced.

> **Method note (`no-scaffold` / `loom_browser_e2e_before_done`):** grades below are anchored to the repo's parity docs, which under the `no-vaporware`/`ui-parity`/`ux-baseline` rules are file-cited and name the exact backend REST/TDS/data-plane call per control. **A dedicated code-reality pass over every target editor confirmed all are REAL — wired to `/api/...` routes that call Azure (Synapse TDS, ADLS, Livy, ADX, Event Hubs/ASA, AAS/PBI REST); zero `useState(MOCK)` / `return []` placeholder editors were found, and all `SAMPLE`/`no-vaporware` strings are rule-reference comments, not mock data.** So code + backend reality is verified; the residual audit risk is only that a handful of self-assessed "A" docs lack a fresh **in-browser E2E** receipt (the operator's G1 bar) — treat those sub-grades as "A per code + tests, browser-E2E-pending" unless the doc shows a screenshot/trace.
>
> **Structural note (verified):** the top-level files `lakehouse-editor.tsx`, `warehouse-editor.tsx`, `pipeline-editor.tsx`, `phase3-editors.tsx`, `phase4-editors.tsx` are **thin barrels / Copilot bridges** — do not judge them by their own line count. The substantive editors live in subfolders: `lib/editors/lakehouse/lakehouse-editor-shell.tsx`, `lib/editors/phase3/{semantic-model-editor (~2790 lines),report-editor,warehouse-editor,eventstream-editor,kql-dashboard-editor,activator-editor,...}.tsx`, and 16 real `lib/editors/phase4/*.tsx` sub-editors. `report-designer.tsx` is the distinct PBI **authoring** designer; `phase3/report-editor.tsx` is the report **viewer/render** editor.

---

## 0. Executive framing

Fabric is a SaaS bundle of seven workloads (Data Factory, Data Engineering, Data Warehouse, Data Science, Real-Time Intelligence, Databases, Power BI) unified by **OneLake** (one logical lake, zero-copy), **Copilot** (per-workload AI), and **Purview-backed governance** (OneLake Catalog). Its moat is *integration*: one artifact store, one security model, cross-workload lineage, Direct Lake.

Loom's thesis (per `.claude/rules/no-fabric-dependency.md`) is to reproduce **every** Fabric/PBI surface one-for-one on **Azure-native + OSS backends** with **no hard Fabric/Power BI/OneLake dependency** — Fabric is strictly opt-in via `LOOM_<ITEM>_BACKEND=fabric`. The catalog (`lib/catalog/fabric-item-types.ts`, composed from 22 per-category slices) enumerates the full Fabric/PBI/Azure item surface; the visual registry (`lib/components/ui/item-type-visual.ts`) covers ~140 slugs. Loom has editors for essentially the entire Fabric/PBI item set, most wired to real Azure backends with honest infra-gates.

**Bottom line:** Loom is at genuine **B+/A− overall parity** with Fabric/PBI on the surfaces that matter, and *exceeds* Fabric in several cross-workload and canvas dimensions. The real gaps are (1) **Direct Lake** (no Azure-native 1:1 — the semantic-model performance story), (2) **report-designer Format-pane depth** (Wave 6 partially unbuilt), (3) **OneLake zero-copy shortcuts** (honest-gated, engine not yet built), and (4) **breadth-vs-polish** — many surfaces are code-complete but lack fresh browser-E2E receipts.

---

## 1. Capability inventory of the real products (grounded in Microsoft Learn, 2026)

### 1.1 Microsoft Fabric — workloads & surfaces

**Data Factory in Fabric**
- **Data pipelines** — ADF-model orchestration canvas (activities, dependencies, parameters, triggers), 200+ connectors.
- **Dataflow Gen2** — Power Query Online authoring; Gen2 2026 adds ADLS Gen2 + Lakehouse Files destinations (GA), schema support in destinations (GA), **AI-powered Prompt Transform** (GA, NL transforms), Mapping Data Flow transforms on Spark (Preview), Save-as-Dataflow, Execute Query Streaming API.
- **Copy job** — incremental copy + CDC across clouds (BigQuery, GCS, DB2, ODBC, Dataverse→multi-destination).
- **Apache Airflow job**, **dbt job** (first-class dbt-core adapters for Warehouse+Lakehouse, GA March 2026), **Mirroring** (Azure SQL, Cosmos, Databricks, Snowflake → OneLake), on-prem data gateway, Refresh SQL endpoint / Refresh Materialized Lake View activities.

**Data Engineering**
- **Lakehouse** — Tables (managed Delta) + Files (raw) explorer, SQL analytics endpoint (read-only T-SQL over Delta), shortcuts (OneLake/ADLS/S3/GCS/Dataverse), Load-to-table, Get-data/Analyze-data ribbons, DirectLake semantic model, share.
- **Notebooks** — Spark (PySpark/Scala/SparkR/SparkSQL), %-magics, cell exec on Livy, resources, environments, in-cell Copilot, mssparkutils.
- **Spark Job Definition**, **Environment** (libraries + Spark props), **Materialized Lake Views** (Spark-SQL/PySpark `@fmlv`, data-quality constraints, lineage, schedule), **V-Order / Autotune / Native Execution Engine** (Velox/Gluten).

**Data Warehouse**
- **Warehouse** — full T-SQL (multi-table transactions, DDL/DML), SQL query editor + IntelliSense, **visual query** (no-code Power Query), model view (relationships + measures), CTAS, save-as-view, Open-in-Excel, cross-warehouse 3-part queries, time-travel (T-SQL `FOR TIMESTAMP`), zero-copy clone, query insights/monitoring.
- **SQL analytics endpoint** (auto over lakehouse), **Datamart** (deprecated → DB + semantic model).

**Data Science**
- Notebooks, **ML experiments** (MLflow tracking), **ML models** (registry), AutoML, Data Wrangler, SynapseML, prebuilt AI (Foundry), semantic-link (`sempy`).

**Real-Time Intelligence (RTI)**
- **Eventstream** — visual streaming topology (sources→operators→destinations); sources = Event Hubs/IoT/Kafka/CDC/Sample; operators = filter/aggregate/group-by/manage-fields/union/join + SQL operator (Preview) + AI Skills (NL→eventstream); destinations = Eventhouse/Lakehouse/Activator/Derived/Custom; **Business Events publisher** (Preview).
- **Eventhouse** — container of KQL databases for time-series; auto index/partition; OneLake availability; SQL analytics endpoint; native anomaly detection.
- **KQL Database / Queryset** — KQL editor, schema tree (tables/functions/materialized-views/mappings), policies (retention/caching/RLS/update), external tables, continuous export, `.ingest`.
- **Real-Time Dashboard** — tiles over KQL/ADX data sources, auto-refresh, parameters, drill.
- **Activator (Reflex)** — no-code event-detection + rules (Monitor/Condition/Filter/Action), actions = Email/Teams/pipeline/notebook/Power Automate/Copy-job/Publish-business-event, computed properties, trigger Fabric items.

**Databases**
- **SQL database in Fabric** (developer transactional DB, auto-mirrored to OneLake), **Mirroring** (continuous replication into OneLake).

**Platform**
- **OneLake** — single logical lake (ADLS-backed), OneLake Catalog (discover/govern/secure), shortcuts, OneLake security (column/row/object), file/folder lifecycle + recycle + storage tiers, OneLake data sharing across tenants.
- **Copilot** — embedded per workload (pipeline/notebook/warehouse/KQL/DAX/report/model authoring), Fabric IQ / Skills, MCP servers.
- **Governance** — Purview built-in: sensitivity labels, lineage, endorsement (Promote/Certify), DLP, audit.
- **Fabric IQ** — ontology/semantic layer + data-answering across M365 Copilot (Cowork, Chat).

### 1.2 Power BI

- **Semantic models** (datasets) — tables/columns/relationships, DAX measures + calc groups, RLS/OLS, Import/DirectQuery/**Direct Lake**/Composite storage modes, incremental refresh, scheduled refresh, take-over, XMLA endpoint, push datasets.
- **Reports** — visual authoring (Visualizations pane: 30+ visual types + AppSource), field wells, Format pane (per-axis/title/legend/effects/data-labels), Analytics pane (trend/constant/min/max/forecast/error-bars/anomalies), filters pane (visual/page/report scope, TopN, relative-date), bookmarks, selection pane, drillthrough/drill-down, cross-highlight, sync slicers, what-if/field parameters, themes, subscriptions, export PDF/PPTX/PNG.
- **Paginated reports** (RDL, pixel-perfect, parameters).
- **Dashboards** (classic tiles), **Scorecards / Metrics** (OKR/goals).
- **Q&A** (NL — being deprecated Dec 2026 in favor of Copilot), **Copilot** (narratives, DAX gen, report-page gen, measure descriptions, web-modeling schema edits, standalone chat, MCP server), **DAX query view**, **Deployment pipelines** (Dev→Test→Prod), **Dataflows** (Gen1), **Fabric Apps** on semantic models (Preview).

---

## 2. Loom's current equivalent (from the repo)

**Catalog & registry (authoritative):**
- `apps/fiab-console/lib/catalog/fabric-item-types.ts` — composes 22 category slices (`item-types/data-engineering.ts`, `…/data-factory.ts`, `…/data-warehouse.ts`, `…/real-time-intelligence.ts`, `…/data-science.ts`, `…/power-bi.ts`, `…/fabric-iq.ts`, etc.). Categories include all Fabric workloads + Power BI + a Loom-IQ (Palantir-parity) family.
- `apps/fiab-console/lib/components/ui/item-type-visual.ts` — ~140 slugs mapped to Fluent icon + brand family; Power BI family: `semantic-model`, `report`, `dashboard`, `paginated-report`, `scorecard`.

**Editors (all under `apps/fiab-console/lib/editors/`):**
- Data Factory: `pipeline-editor.tsx` + `data-pipeline-editor.tsx` + `pipeline-editor-core.tsx` (shared ADF/Synapse canvas), `dataflow-gen2-editor.tsx`, `mapping-dataflow-editor.tsx`, `copy-job-editor.tsx`, `airflow-job-editor.tsx`, `mirrored-database-editor.tsx`, `mirrored-databricks-editor.tsx`, `mounted-adf-editor.tsx`, `linked-service-editor.tsx`, `integration-runtime-editor.tsx`.
- Data Engineering: `lakehouse-editor.tsx`, `notebook-editor.tsx` (+ `synapse-notebook-editor.tsx`), `spark-job-definition-editor.tsx`, `spark-environment-editor.tsx`, `materialized-lake-view-editor.tsx`, `lakehouse-shortcut-editor.tsx`.
- Data Warehouse: `warehouse-editor.tsx` (+ `WarehouseEditor` in `phase3-editors.tsx`), `sql-analytics-endpoint-editor.tsx`, `synapse-sql-editors.tsx`, `synapse-serverless-sql-editor.tsx`, `unified-sql-database-editor.tsx`.
- Data Science: `ml-model-editor.tsx`, `ml-experiment-editor.tsx`, `automl-editor.tsx`.
- RTI: `EventstreamEditor`/`ActivatorEditor`/`KqlDatabaseEditor` in `phase3-editors.tsx`, `synapse-kql-editor.tsx`, `event-hubs-namespace-editor.tsx`, `stream-analytics-editor.tsx`, `digital-twin-builder-editor.tsx`, `event-schema-set-editor.tsx`; designer `lib/components/eventstream/visual-designer.tsx`, ADX `lib/components/adx/*`.
- Power BI: `SemanticModelEditor`/`ReportEditor` in `phase3-editors.tsx`, `report-designer.tsx` (+ `lib/editors/report/*` — format-pane, analytics-pane, filters, bookmarks, selection, ai-visuals, themes, map-visual), `lib/editors/components/dax-query-view.tsx`, paginated report (`__tests__/paginated-report.test.tsx` + editor), `scorecard`, `dashboard`, embed `lib/components/embed/powerbi-embed.tsx`.

**Backends:** Azure-native by default — ADLS Gen2 + Delta (lakehouse), Synapse serverless/dedicated SQL (warehouse/endpoint), Synapse Spark Livy (notebooks), ADX/Kusto (KQL/eventhouse), Event Hubs + Stream Analytics (eventstream), Azure Monitor/Logic Apps (activator), ADF WranglingDataFlow (dataflow gen2), **Azure Analysis Services** (semantic model/report DEFAULT), Power BI REST + embed (opt-in). Parity docs at `docs/fiab/parity/` (423 files) are file-cited per control.

---

## 3. Graded parity matrix

Grades reflect what the code+tests actually do per the repo's cited parity docs (rubric §0). "Honest-gate" = full UI renders + names exact env-var/role remediation (allowed by `no-vaporware.md`).

### 3.1 Data Factory

| Capability | Fabric surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Pipeline orchestration canvas | Data pipeline | `pipeline-editor*.tsx`, `data-pipeline-editor.tsx`; parity `synapse-pipeline.md`, `adf-pipeline.md` | **A** | Real Synapse/ADF dev-endpoint REST (list/PUT/run/debug/triggers/monitor); 24-type palette, 4 dependency conditions, params/vars, Monaco JSON. Backend = Synapse pipeline / ADF (no Fabric). |
| Dataflow Gen2 (Power Query) | Dataflow Gen2 | `dataflow-gen2-editor.tsx`; parity `dataflow-gen2.md` | **A−** | Full Power Query authoring compiled to ADF **WranglingDataFlow** on Spark; queries/steps/ribbon all real M. Gap: **no inline data preview** (ADF has no M-eval endpoint → honest-gate; preview only via Save&Run). No AI Prompt Transform. |
| Copy job (incremental/CDC) | Copy job | `copy-job-editor.tsx`; parity `adf-copy-activity.md` | **B+** | Real ADF copy; CDC/incremental breadth < Fabric's 2026 multi-cloud connector set. |
| Mirroring | Fabric Mirroring | `mirrored-database-editor.tsx`, `mirrored-databricks-editor.tsx`; parity `app-fabric-mirror-onboard.md` | **B** | Azure-native = ADF CDC / Synapse Link → ADLS Bronze Delta. Not the OneLake continuous-mirror UX. |
| Airflow / dbt jobs | Airflow/dbt job | `airflow-job-editor.tsx`, dbt via `__tests__/dbt-job.test.tsx` | **B** | Present; dbt not the first-class Warehouse/Lakehouse adapter Fabric shipped GA 2026. |
| 200+ connectors | Connector gallery | `linked-service-editor.tsx`, connectors registry | **B** | ~70 connectors (per memory); breadth < Fabric 200+. |
| On-prem data gateway | OPDG | `integration-runtime-editor.tsx` (SHIR) | **B** | Self-hosted IR / SHIR analog; not the managed OPDG update UX. |

### 3.2 Data Engineering

| Capability | Fabric surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Lakehouse explorer (Tables/Files) | Lakehouse | `lakehouse-editor.tsx`; parity `lakehouse.md` | **A** | Live Delta catalog (`_delta_log` scan), Files/Tables trees, preview, SQL endpoint (Synapse serverless), Load-to-table, Get-data/Analyze-data ribbons, share, **reference lakehouses** (exceeds baseline). |
| Lakehouse **shortcuts** (zero-copy) | OneLake shortcuts | `lakehouse-shortcut-editor.tsx`; parity `lakehouse.md` row 7 | **C / honest-gate** | **Gap.** Fabric-REST path removed (no-fabric-dep); Azure-native engine (ADLS+Synapse/UC external tables + Cosmos registry) is a *tracked design doc*, not built. Zero-copy alternatives (abfss notebook + OPENROWSET) offered. |
| SQL analytics endpoint | Auto endpoint | `sql-analytics-endpoint-editor.tsx`; `lakehouse.md` row 6 | **A** | Synapse Serverless OPENROWSET over Delta. |
| Spark notebooks | Notebook | `notebook-editor.tsx`; parity `notebook.md`, `notebook-*copilot*.md` | **A** | Real Synapse Spark Livy exec, cells, variable explorer, session sizing, in-cell Copilot (AOAI over live Livy errors), inline completion — all unit-tested. |
| Spark Job Definition / Environment | SJD / Environment | `spark-job-definition-editor.tsx`, `spark-environment-editor.tsx`, `environment.md` | **A** | Config/libraries/Spark props/apply real REST. |
| Materialized Lake Views | MLV | `materialized-lake-view-editor.tsx`; parity `materialized-lake-view.md` | **B+** | Azure-native: Delta on ADLS + Synapse Spark batch + ADF refresh pipeline + Cosmos lineage; Spark-SQL/PySpark/constraints. E2E-pending. |
| Delta optimization (V-Order/Autotune/NEE) | Lakehouse settings | `lakehouse.md` §F22 | **A+ (clustering) / honest-gate (3 Fabric-only)** | Liquid clustering = real Databricks DDL; V-Order/Autotune/NEE are honest persisted-preference gates (Fabric-runtime-only, no fake Azure "enabled"). |
| **Direct Lake** semantic model | DirectLake over Delta | `lakehouse.md` row 18, `semantic-model-direct-lake.md` | **D / honest-gate** | **No Azure-native 1:1.** DirectLake is Fabric-capacity-only; gate points to Synapse-Serverless + PBI-Desktop path. Real perf-parity gap. |

### 3.3 Data Warehouse

| Capability | Fabric surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| T-SQL warehouse (query + explorer) | Warehouse | `WarehouseEditor` (`phase3-editors.tsx`), `warehouse-editor.tsx`; parity `warehouse.md`, `synapse-dedicated-sql-pool.md` | **A** | Synapse Dedicated TDS: explorer (schemas/tables/views/SPs/functions + row counts + CREATE/ALTER/DROP script-out), CTAS, Open-in-Excel, permissions, parameterized queries, run-selection, cancel (TDS ATTENTION), multi-tab, IntelliSense, cross-DB picker. |
| Visual (no-code) query | Visual query | `lib/editors/components/visual-query-canvas.tsx`; `warehouse.md` row 4 | **A** | Drag tables, filter/columns/group-by/merge (6 joins), live generated SQL, unit-tested compiler. |
| Model view (relationships/measures) | Model view | `warehouse.md` row 10 | **A** | sys.foreign_keys + CREATE FUNCTION measure template. |
| Visualize results | Visualize | `result-visualize.tsx` | **A** | In-Loom SVG charts over real rows (no PBI dep). |
| Time travel | `FOR TIMESTAMP` | `warehouse-timetravel.md` | **B** | Delta time-travel analog; verify coverage. |
| Zero-copy clone | CLONE TABLE | `synapse-dedicated-sql-pool.md` | **B / honest-disclosure** | Dedicated has no zero-copy clone → SELECT INTO copy + honest disclosure. |
| Query insights / monitoring | Query insights | `warehouse-monitoring.md`, `warehouse-alerts.md` | **B** | Present; depth E2E-pending. |
| Source control (Git) | Workspace Git | `warehouse.md` row 12 | **C / honest-gate** | Git is workspace-level → opens Learn. |

### 3.4 Real-Time Intelligence

| Capability | Fabric surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Eventstream topology | Eventstream | `EventstreamEditor` + `eventstream/visual-designer.tsx`; parity `eventstream.md`, `eventstream-*.md` | **A−** | Visual canvas (sources/operators/destinations), destination wizards → real **ASA outputs**, provision → real Event Hub + Stream Analytics job. Node Activate/Deactivate honest-gated (not in REST). SQL operator / AI Skills / Business Events not built. |
| Eventhouse | Eventhouse | parity `eventhouse-overview.md`, `eventhouse-*.md` | **A−** | ADX cluster = Azure-native default; databases, capacity, delta-endpoint, OneLake-export docs. |
| KQL database + editor | KQL DB | `KqlDatabaseEditor` + `adx/*`; parity `kql-database*.md`, `adx-kusto.md` | **A− (editor) / C+ (results grid)** | Real ADX `/v1/rest/query`+`/mgmt`: schema tree, KQL Monaco, table/MV/function/update-policy wizards, inline ingest, policies, external tables, RLS. `adx-kusto.md` self-grades results-grid **C+** (rough). |
| KQL Queryset | Queryset | `kql-queryset.md`, `kql-queryset-cross-service.md` | **B+** | Cross-service queryset present. |
| Real-Time Dashboard | RT Dashboard | `kql-dashboard` editor; parity `kql-dashboard.md`, `kql-dashboard-diagram.md` | **B** | Loom-native dashboard over ADX (tiles query ADX). Verify tile-auth + auto-refresh depth. |
| Activator (Reflex) | Activator | `ActivatorEditor`; parity `activator.md`, `activator-*.md` | **A−** | Azure-native = Azure Monitor scheduled-query alert / Logic Apps; rule builder, actions (email/Teams/pipeline/notebook/Power Automate), object explorer, computed properties, start/stop, test-fire, Copilot. Business-event publisher (2026 Preview) not built. |
| Digital Twin Builder | DTB | `digital-twin-builder-editor.tsx` | **B** | Present; depth E2E-pending. |

### 3.5 Power BI

| Capability | PBI surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| Semantic model (build/relationships/refresh/RLS) | Dataset | `SemanticModelEditor` (`phase3-editors.tsx`); parity `semantic-model*.md` | **A** | **AAS is DEFAULT** (databases/storage-mode/refresh/history/schedule/TMSL/XMLA); PBI opt-in (push-dataset build, relationships, scheduled-refresh, take-over, DAX-validate — real REST). RLS authoring + imported-model writes honest-gated (XMLA/Desktop). |
| DAX query view | DAX query view | `lib/editors/components/dax-query-view.tsx`; parity `dax-query-view.md` | **A** | Monaco DAX, Run (Synapse SQL / AAS XMLA), quick queries, save-as-measure, **NL2DAX Copilot** (AOAI, zero PBI). |
| Report viewer | Report (reading) | `ReportEditor`; parity `report.md` | **A** | Default = **Loom-native** AAS DAX render (pages/visuals/refresh); PBI-embed opt-in (bookmarks/export/drillthrough/themes/slideshow — real embed JS API). |
| **Report authoring designer** | Report editor | `report-designer.tsx` + `lib/editors/report/*`; parity `report-designer.md` (1191 lines) | **A− (waves 1-5,8,9) / partial (Wave 6)** | Huge build: 20+ visual types w/ real SVG geometry (stacked/combo/ribbon/waterfall/funnel/treemap/gauge/kpi), field wells, analytics pane, filters, bookmarks, selection, drillthrough, drill-down, sync-slicers, what-if, AI visuals (decomp-tree/key-influencers/Q&A/smart-narrative), R/Python script visuals (real ACA sandbox), Azure-Maps, export-data, MIP labels, endorsement, deployment-pipeline, perf-analyzer. **Gap: Wave-6 Format-pane cards (per-axis/title/legend/effects) NOT built** — adapter+chrome built but unwired; only show/legend/labels/stacking paint today. |
| Paginated reports (RDL) | Paginated report | paginated-report editor; parity `paginated-report.md` | **A** | Azure-native renderer, multi-page real data + parameters. |
| Dashboards (tiles) | Dashboard | dashboard editor; parity `dashboard.md`, `dashboard-tiles.md` | **A** | List/embed/tiles/drill live REST; authoring honest-routed to PBI Web. |
| Scorecards / metrics | Scorecard | `scorecard` editor; parity `scorecard.md`, `fabric-scorecard.md` | **A** | Goals/check-in/rollup real (Fabric REST + Cosmos OKR fallback); live-goal authoring honest-gate. |
| Deployment pipelines | Dev→Test→Prod | `/api/deployment-pipelines/loom`; `report-designer.md` Wave 9 | **A** | Azure-native Loom pipeline (compare/deploy/history), report itemType wired. |
| Q&A (NL) | Q&A | report AI-visuals `qa.tsx` | **B / intentional-substitute** | Q&A visual + Copilot as substitute (MS deprecating Q&A Dec 2026). |
| Copilot (report/model/DAX) | PBI Copilot | `report-copilot.md`, `report-powerbi-copilot.md`, `dax-query-view.md` | **A−** | Narrative/DAX-gen/report-Q&A via AOAI. Web-modeling schema-edit-by-NL (2026 Preview) partial. |
| Direct Lake storage mode | Direct Lake | `semantic-model-direct-lake.md` | **D / honest-gate** | **No Azure 1:1** (see §3.2). |
| Datamart | Datamart (deprecated) | `datamart.md` | **A (as migration-only)** | Correctly deprecated → Synapse Serverless DB + AAS migration, no create path. |

### 3.6 Platform (OneLake / Copilot / Governance)

| Capability | Fabric surface | Loom surface (file) | Grade | Gap |
|---|---|---|---|---|
| OneLake (single logical lake) | OneLake | ADLS Gen2 (`onelake-workspace` slug); parity `onelake-*.md` | **B+** | ADLS is the substrate; catalog/govern/secure/lifecycle/recycle/tiers/column-security docs present. Not one *logical* namespace across all items the way OneLake is — per-account ADLS. |
| OneLake shortcuts (zero-copy) | Shortcuts | (see §3.2) | **C / honest-gate** | Engine not built. |
| OneLake Catalog (discover/govern) | OneLake Catalog | `governance-catalog.md`, `unified-catalog.md`, `onelake-catalog-explore.md` | **A** | Purview classic Data Map + Loom catalog; real Cosmos + Purview. |
| Copilot (cross-workload) | Fabric Copilot | `copilot-*.md` (30+ docs), `cross-item-copilot-editor.tsx` | **A** | Real streamed AOAI, 37-tool cross-item Copilot, governance, inline-complete, help-widget — all real backend, honest-gated when unbound. **Exceeds** Fabric (cross-item span). |
| Governance (labels/lineage/endorsement/DLP) | Purview-in-Fabric | `governance-*.md` (12 docs) | **A** | Sensitivity/lineage/classifications/scans/policies/insights real Cosmos+Purview. |
| Fabric IQ / semantic answering | Fabric IQ | `fabric-iq` family (ontology/analysis-board/graph-model) | **B+** | Loom-IQ = Palantir-parity ontology; overlaps Fabric IQ direction. |

---

## 4. Gaps & recommendations (prioritized)

**P0 — the true parity holes**

1. **OneLake zero-copy shortcuts engine** (`lakehouse-shortcut-editor.tsx`, `lakehouse.md` row 7). Today an honest-gate; Fabric's shortcut/zero-copy story is core to its value. Build the Azure-native engine (ADLS Gen2 + Synapse Serverless / Databricks UC external tables + Cosmos `lakehouse-shortcuts` registry, UAMI-backed) per the tracked design doc. **Highest-leverage gap** — unblocks lakehouse federation + KQL/eventhouse shortcuts + mirrored-database landing.

2. **Direct Lake substitute** (`semantic-model-direct-lake.md`). There is no Azure-native 1:1 for Direct Lake's "import speed on lake data, no refresh." Recommend a **Loom-native Direct-Lake-equivalent**: AAS/tabular in DirectQuery over Synapse Serverless external Delta tables with aggressive result caching + a "framing" refresh, marketed as the parity. Close the honest-gate with a real perf path rather than deferring to PBI Desktop.

3. **report-designer Wave-6 Format-pane** (`report-designer.tsx`, `lib/editors/report/format-pane.tsx`). The adapter (`loom-chart-format.ts`) and chrome (`visual-chrome.tsx`) are built but **unwired**; per-axis/title/legend/effects cards are MISSING. This is the single biggest *quality* gap in the flagship PBI surface. Land the format-pane cards + the one VisualBody integration seam.

**P1 — depth & currency**

4. **Eventstream 2026 features** — SQL operator (Preview), AI Skills (NL→eventstream), Business Events publisher. Loom's eventstream is A− on the classic model; add these to stay current.
5. **ADX results grid** (`adx-kusto.md` self-grades **C+**) — upgrade the KQL results grid (column stats, in-grid filter/search, CSV export polish) to A.
6. **Dataflow Gen2 AI Prompt Transform + inline preview** — the honest-gate preview is a UX wart; consider a lightweight Spark preview job. Add AOAI prompt-transform to match Fabric GA.
7. **Connector breadth** — ~70 → target 200+ to match Fabric Data Factory.

**P2 — receipts & polish (the operator's G1 bar)**

8. **Fresh browser-E2E receipts** for the many code-complete "A" surfaces (warehouse, semantic-model, report-designer, eventstream, KQL, activator). Under `loom_browser_e2e_before_done`, an A grade needs a real-data in-browser walk + screenshot/trace — several docs assert A on code+tests only. Run the `loom-uat` harness per surface.
9. **Digital Twin Builder / RT Dashboard** depth — verify tile-auth, auto-refresh, drill vs Fabric.

---

## 5. Burn-the-box ideas (what Loom can do that Fabric/PBI cannot)

Loom's advantage is that it integrates the **whole** Azure/OSS stack in one console with one security model — it can collapse Fabric's workload silos.

1. **One-canvas data-eng → semantic → report pipeline.** Fabric makes you hop lakehouse → model → report across separate editors. Loom already has the pieces (`lakehouse-editor`, `SemanticModelEditor`, `report-designer`) in one shell — wire a **single flow**: drag a Delta table onto a canvas, auto-generate the AAS tabular model + a starter report page, all in one surface. Fabric has no cross-workload authoring canvas.

2. **Cross-item Copilot that spans data-eng → semantic → report** (`cross-item-copilot-editor.tsx`, already 37 tools). Fabric's Copilots are per-workload and can't reason across a notebook, a warehouse table, a DAX measure, and a report visual in one turn. Loom's cross-item Copilot already does — lean into "ask once, act across the stack" (e.g., "why did revenue drop" → queries lakehouse, checks the pipeline run, inspects the measure, annotates the report).

3. **Unified governance that Fabric can't match in sovereign clouds.** Loom runs 100% Azure-native in GCC/GCC-High/IL5 where Fabric F-SKUs / Power BI Premium / Direct Lake **don't exist** (`report.md`/`semantic-model.md` per-cloud tables). "Full Fabric+PBI parity in air-gapped/DoD" is a capability Microsoft literally cannot offer — this is Loom's sharpest wedge.

4. **Backend-swap parity (Fabric OR Synapse OR Databricks OR OSS) behind one UI.** Each item picks its backend via `LOOM_<ITEM>_BACKEND`; the semantic model runs on AAS *or* PBI, the warehouse on Synapse *or* Databricks SQL, the graph on ADX. Fabric locks you to OneLake/PBI. Loom can present **the same editor** over whichever engine the customer already owns — zero-migration adoption.

5. **Report designer with a real R/Python sandbox + Azure-Maps by default** (`report-designer.md` Wave 4/5). Loom already ships script visuals on a real ACA sandbox and OSS-TopoJSON maps with no marketplace dependency — surfaces Fabric gates behind Premium/AppSource. Push: an **AI-visual pipeline** (decomp-tree/key-influencers/smart-narrative already built) that auto-explains any report page, spanning the semantic layer down to the lakehouse rows.

6. **Palantir-grade Ontology (Loom IQ) fused with the Fabric semantic layer.** Loom's `fabric-iq` family (ontology/analysis-board/graph-model/tapestry) is a Palantir-Foundry-parity layer *plus* the Fabric/PBI data plane underneath. Fabric IQ is nascent; Loom can ship object-centric analytics + write-back actions over the same Delta/ADX/Synapse data — a combination neither Fabric nor Palantir offers standalone.

---

## Appendix — key evidence files

- Catalog: `apps/fiab-console/lib/catalog/fabric-item-types.ts` (+ 22 `item-types/*` slices)
- Registry: `apps/fiab-console/lib/components/ui/item-type-visual.ts`, `lib/catalog/item-type-icon.ts`
- Editors: `apps/fiab-console/lib/editors/{report-designer,dataflow-gen2-editor,mirrored-database-editor,materialized-lake-view-editor,notebook-editor,data-pipeline-editor}.tsx`; real impls in subfolders — `lib/editors/lakehouse/lakehouse-editor-shell.tsx`, `lib/editors/phase3/{warehouse-editor,semantic-model-editor,report-editor,eventstream-editor,activator-editor,kql-database-editor,kql-dashboard-editor}.tsx`, `lib/editors/phase4/*` (16 sub-editors), `lib/editors/report/*` (format-pane, analytics-pane, ai-visuals, themes, map-visual)
- Parity docs (file-cited grades): `docs/fiab/parity/{lakehouse,warehouse,semantic-model,report,report-designer,eventstream,activator,kql-database,dataflow-gen2,materialized-lake-view,paginated-report,dashboard,scorecard,dax-query-view,datamart,adx-kusto}.md` + `onelake-*.md`, `copilot-*.md`, `governance-*.md`
- Rules that define "done": `.claude/rules/{no-fabric-dependency,no-vaporware,ui-parity,ux-baseline,web3-ui}.md`
