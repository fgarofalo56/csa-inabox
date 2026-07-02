# Functional Audit — Analytics & BI (analytics-bi)

**Auditor pass:** skeptical UI→BFF→backend trace of every Analytics/BI surface.
**Date:** 2026-06-26
**App:** `apps/fiab-console`
**Scope:** warehouse, lakehouse, SQL analytics endpoint, notebook/Spark, spark-job-definition,
semantic-model, report (designer), paginated-report, dashboard, KQL database, KQL dashboard.

## Headline

The Analytics & BI area is **healthy and largely real** — no F (pure vaporware) surfaces were
found. Every primary action traces to a real Azure backend (Synapse dedicated/serverless TDS,
ADLS Gen2, ADX/Kusto, Synapse Livy/AML Spark, AAS XMLA, Power BI REST as opt-in only), and the
no-Fabric-dependency rule is honored: every item defaults to an Azure-native backend with Fabric/
Power BI strictly opt-in behind `LOOM_*_BACKEND=*` env. Vaporware/onClick/`return []`/MOCK_ greps
came back clean across the editors and routes. The remaining gaps are **functional-parity gaps and
honest infra/cost gates**, not fake UI.

## Surface grades

| Surface | Primary action | UI → BFF → backend | Grade |
|---|---|---|---|
| Lakehouse | Create + SQL query | LakehouseEditor → `/api/items/lakehouse/[id]/query` → `synapse-sql-client.executeQuery` (serverless OPENROWSET over ADLS Delta) | **A** |
| SQL analytics endpoint | T-SQL query | `SqlAnalyticsEndpointEditor` → `/api/items/sql-analytics-endpoint/[id]/query` (re-export of serverless pool route) → real TDS | **A** |
| KQL database | KQL query / `.mgmt` | `phase3:KqlDatabaseEditor` → `/api/items/kql-database/[id]/query` → `kusto-client.executeQuery/executeMgmtCommand` (ADX) | **A** |
| KQL dashboard | Run tiles | `phase3:KqlDashboardEditor` → `/api/items/kql-dashboard/[id]/run` → `runTiles` → ADX `executeQuery` | **A** |
| Notebook / Spark | Run notebook / `%%pyspark` cell | `notebook-editor` → `/notebook/[id]/run` + `/execute-spark` → Synapse Livy (default) or AML Serverless Spark, async poll | **A** |
| Spark job definition | Submit batch | `spark-job-definition-editor` → `/spark-job-definition/[id]/submit` → `synapse-dev-client.submitSparkBatchJob` (Livy batch) | **A−** |
| Dashboard (PBI-style) | Tile query | `phase3:DashboardEditor` → `/dashboard/[id]/tile-query` → ADX (default) / AAS XMLA / Power BI (opt-in); overlay persists to Cosmos | **B** |
| Warehouse | Create + SQL query | `phase3:WarehouseEditor` → `/warehouse/[id]/query` → Synapse **dedicated** pool `executeQuery` | **B** |
| Semantic model | Build + refresh | `phase3:SemanticModelEditor` → `/semantic-model/scaffold` (loom-native default) + `/[id]/refresh` (AAS default / PBI opt-in) | **B** |
| Report (designer) | Visual query / render | `phase3:ReportEditor`→`ReportDesigner` → `/report/[id]/query` Path-3 loom-native SQL over Synapse | **B / C (multi-table)** |
| Paginated report | Render + export | `PaginatedReportDesigner` → `/paginated-report/[id]/render` (real) + `/export` (gated Function) | **B / C (export)** |

## Findings (gaps only — A-grade surfaces omitted)

### 1. Report designer: multi-table (star-schema) visuals fail on the Azure-native default — P1
The loom-native default report backend (Path-3) compiles field wells to a **single-table**
`SELECT … GROUP BY`. Any visual that references fields from two model tables (the normal star-schema
case in real Power BI reports) returns an honest `400 code:'multi-table'` and tells the user to use
the AAS (Path-2) backend instead. So on a base, no-AAS deployment the most common real report shape
does not render.
- **Trace:** field wells → `/api/items/report/[id]/query` (and `/script-visual`) → `buildSqlFromVisual` (single-table) / `resolveReportModel` → 400 `multi-table`. Documented at `app/api/items/report/[id]/query/route.ts:40-50,76-96,167-175`; resolver has no JOIN graph (`lib/azure/report-model-resolver.ts:22,125,675`).
- **Fix:** teach `report-model-resolver` to carry model relationships (FK metadata from the semantic model) and have `buildSqlFromVisual` emit `JOIN`s across the star schema so the loom-native default answers cross-table visuals without requiring AAS. Until then, scaffold semantic models AAS-backed when >1 table is bound.

### 2. Paginated report export (PDF/Excel/Word) needs a separately-deployed render Function — P2
In-browser **render/preview** works server-side (`paginated-report-renderer` over Synapse serverless /
AAS / PBI). **File export** honest-gates with `503` on `LOOM_PAGINATED_RENDER_URL`, and bicep only
*references* the URL/host-key — it does not deploy the renderer Function in the default stack
(`admin-plane/main.bicep:656` "Only emitted when loomPaginatedRenderUrl is set").
- **Trace:** export button → `/api/items/paginated-report/[id]/export` → 503 (`route.ts:58-73`, `bicepStatus:"deploy the renderer Function, then set LOOM_PAGINATED_RENDER_URL"`).
- **Fix:** add a paginated-render Azure Function module to `platform/fiab/bicep` and wire `LOOM_PAGINATED_RENDER_URL`/`_KEY` automatically, OR document it as a required post-deploy step in `docs/fiab/v3-tenant-bootstrap.md`. (No-vaporware bicep-sync: the gate is honest but not satisfied by the default deploy.)

### 3. Warehouse create requires a Synapse **dedicated** SQL pool (cost/infra gate) — P2
Provisioner default `LOOM_WAREHOUSE_BACKEND=synapse-dedicated`; with `LOOM_SYNAPSE_DEDICATED_POOL`
unset, create returns `status:'remediation'` ("Synapse dedicated pool not configured"), and the query
route `409`s when the pool is paused. Dedicated pools are costly and not part of a cost-conscious base
deploy, so "create a warehouse" is effectively gated in a default deployment.
- **Trace:** install → `lib/install/provisioners/warehouse.ts:25,384-411`; query 409 → `app/api/items/warehouse/[id]/query/route.ts:33-39`.
- **Fix:** offer a zero-idle-cost serverless warehouse option (CETAS/external tables over ADLS via Synapse serverless) as an alternative default, or auto-resume the pool on query; surface the cost trade-off in the create wizard.

### 4. R/Python script visual: honest-gated + least-privilege UAMI must be verified — P2
The script-visual executor `503`s without `LOOM_SCRIPT_RUNNER_URL`. The runner **is** in bicep
(`admin-plane/script-runner-app.bicep`), but the route doc itself flags a real sandbox hole: an ACA
app exposes its UAMI to in-container user code via IMDS, so the runner MUST use a dedicated
least-privilege `uami-loom-script-runner` (AcrPull only) — reusing the broadly-scoped Console UAMI is
an RCE-to-data-plane escalation.
- **Trace:** `app/api/items/report/[id]/script-visual/route.ts:49-55,296-307`; bicep `script-runner-app.bicep`.
- **Fix:** confirm `script-runner-app.bicep` assigns the dedicated least-privilege UAMI (not the Console UAMI) and grants it ONLY AcrPull; add a test/assert. Task #27 (in-progress) owns this surface.

### 5. Warehouse "Fabric Warehouse" opt-in branch is an unbuilt stub — P2 (low impact)
`LOOM_WAREHOUSE_BACKEND=fabric-warehouse` always returns `status:'remediation'` ("Fabric Warehouse
provisioning is preview … on the v3.4 roadmap"). This is an **opt-in, non-default** branch and is
compliant with no-fabric-dependency (the Azure-native dedicated path is the default), but it is an
incomplete code path that advertises a backend it cannot deliver.
- **Trace:** `lib/install/provisioners/warehouse.ts:532-558`.
- **Fix:** either build the Fabric Warehouse TDS-proxy path or remove the `fabric-warehouse` enum value so the env can't select an unbuilt backend.

## Verification notes
- Greps clean: no `return []`/`return {}`/`MOCK_`/`SAMPLE_`/`TODO` stubs in analytics editors or
  routes (the `return []` hits in clients are 404/empty-parse guards, not stubs); no empty/`noop`
  `onClick` handlers in the analytics editors.
- No-Fabric default verified per item: warehouse→Synapse dedicated; lakehouse/sql-endpoint→Synapse
  serverless; semantic-model→loom-native (`semantic-model.ts:525 backend||'loom-native'`);
  report→loom-native Path-3; dashboard→Cosmos overlay + ADX/AAS; KQL→ADX. Power BI/Fabric hosts are
  reached only inside explicit opt-in branches.
- All gated executors (script-runner, paginated-render Function) are bicep-referenced; finding #2 is
  the one that is referenced-but-not-deployed by the default stack.
