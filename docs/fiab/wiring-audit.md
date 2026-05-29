# Loom editor wiring audit — Fabric vs. Loom truth table

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


> Created 2026-05-26 after a Playwright side-by-side against `casino-fabric-poc` (F64 capacity, limitlessdata tenant). Auto-extracted backend calls from `lib/editors/*.tsx` via `grep -oE "fetch\(...)"`.

## Why this exists

The v3.x UAT harness (`apps/fiab-console/e2e/editors.uat.ts`) gave 87 A · 26 B · 0 F — but it only tested **"page renders without crash"** + **"backend call returns a documented status"**. It did *not* test that:

- Workspace dropdowns are populated from **Loom's** workspace catalog (Cosmos) or from real Azure-native compute Loom deployed.
- The "Run" button hits the **right** Azure backend (Synapse Spark Livy / Databricks Jobs / ADX command / etc.) instead of Fabric's tenant API (which doesn't apply when Fabric isn't enabled — the whole reason Loom exists).
- The data shown in pickers represents resources that **actually exist in the tenant's Azure footprint**.

This doc is the honest gap between **"render passes UAT"** and **"functional UAT works end-to-end with real Azure backing"**.

## Reference workspace

`casino-fabric-poc` (F64 SKU, limitlessdata tenant) — a real medallion-architecture POC:

```
casino-fabric-poc/
├── data_pipelines/        Folder — data ingestion pipelines
├── lh_bronze/             Folder — raw landing zone
│   ├── notebooks/         Folder of 5 numbered ingestion notebooks
│   ├── lh_bronze          Lakehouse
│   └── lh_bronze          SQL Analytics Endpoint (auto-paired with Lakehouse)
├── lh_silver/             Folder — cleansed/conformed
├── lh_gold/               Folder — business-ready
├── reports/               Folder — Power BI reports
├── semantic_models/       Folder — Direct Lake / Import models
└── CopyJob_1              Copy job item
```

**Key parity insight**: in Fabric, a **Lakehouse comes paired with a SQL Analytics Endpoint** that exposes the lake's Delta tables for T-SQL. Loom's `lakehouse` editor + `synapse-serverless-sql-pool` editor are split — we should auto-pair them so creating a Loom Lakehouse spins up a paired Serverless SQL view set against the same ADLS path.

## Fabric's master item taxonomy (the IA Loom should mirror)

From `+ New item → All categories → Expand all` in Fabric:

| Category | Purpose |
|---|---|
| **Visualize data** | Dashboard, Report, Semantic Model, Real-Time Dashboard, Paginated Report, Graph queryset, Graph model, Event Schema Set, Exploration, Map |
| **Get data** | Connectors / shortcuts to external sources |
| **Mirror data** | Mirrored Database (Azure SQL, Snowflake, Cosmos, etc.) |
| **Store data** | Lakehouse, Warehouse, KQL Database, SQL database |
| **Prepare data** | Dataflow Gen2, Copy job, Pipeline |
| **Analyze and train data** | Notebook, Spark job definition, ML Model, ML Experiment |
| **Develop data** | API for GraphQL, User data functions, Variable library |
| **Track data** | Activator (Reflex) |
| **Distribute data** | Eventstream, Eventhouse, KQL Queryset |
| **Legacy** | Older Power BI items |
| **Others** | Misc |

## Top-level UX patterns Fabric exposes (and Loom should match)

| Pattern | Fabric | Loom today | Action |
|---|---|---|---|
| Workspace header | `[Experience badge] · [Workspace breadcrumb] · [Capacity icons]` | ✅ matches | none |
| Workspace command bar | `+ New item · New folder · Import · Migrate · [right-side: Recycle bin · Create deployment pipeline · Create app · Manage access · Workspace settings]` | partial — has +New, missing Migrate, Deployment pipelines, App publish | gap |
| Workspace grid cols | Name · Status · Type · Task · Owner · Refreshed · Next refresh · Endorsement · Sensitivity · **Included in app** | partial | gap |
| `+ New item` dialog | Favorites tab + All items with 11 categories + filter + per-tenant favorites | partial — Loom has 80+ types in a flat list | gap |
| Folder support inside workspaces | Yes — drag/drop, subfolders | ✅ matches | none |
| Lakehouse ↔ SQL endpoint pairing | Auto-paired | not wired | gap |
| Per-experience switcher | Power BI / Data Engineering / Data Science / Data Warehouse / Data Factory / Real-Time / Industry Solutions | Loom shows all in left rail | parity-deferred — Loom's flat list is arguably better, but losing the experience filter |

## Per-editor wiring truth (grep-extracted)

Verdict legend:

- **🟢 LOCAL-AZURE** — calls a Loom BFF route that proxies to a real Azure service Loom deployed (Synapse, Databricks, ADF, Cosmos, ADLS, AI Search, ADX/Kusto, Foundry, APIM, Dataverse). End-to-end works.
- **🟡 LOOM-COSMOS-ONLY** — calls a Loom BFF that only writes/reads Cosmos metadata; no real Azure execution wired yet. Item creation works, "Run" is a stub.
- **🔴 FABRIC-API** — calls `/api/fabric/...` or per-type Fabric REST proxy (`/api/items/notebook/...`, etc.). Will succeed only in a tenant where Fabric is enabled — *defeats Loom's whole purpose*. **MUST REWIRE**.
- **⚪ MIXED** — some calls to Azure backends, some to Fabric.

| Editor | Backend call(s) | Verdict | What "Run / Create / Save" should actually do in Loom |
|---|---|:---:|---|
| `notebook` | `/api/fabric/workspaces`, `/api/items/notebook/{id}/run?workspaceId=...` (proxies Fabric Notebook v1 API) | **🔴 FABRIC-API** | Workspace dropdown → `/api/workspaces` (Cosmos). Compute dropdown → Synapse Spark pool list ∪ Databricks cluster list (both from ARM). Run → POST to Synapse Livy `/livyApi/versions/2019-11-01-preview/spark/sessions` OR Databricks Jobs `/api/2.1/jobs/runs/submit`. |
| `data-pipeline` | `/api/fabric/workspaces`, `/api/items/data-pipeline/{id}/run?workspaceId=...` (Fabric DI pipeline) | **🔴 FABRIC-API** | Use Loom workspace. Backend → Azure Data Factory pipeline runs. Already wired separately for `adf-pipeline` — `data-pipeline` should merge into that or be a higher-level wrapper. |
| `dataflow` | `/api/fabric/workspaces`, `/api/items/dataflow/{id}/refresh` | **🔴 FABRIC-API** | Dataflow Gen2 is a Fabric-native concept. Loom equivalent = Synapse pipeline with mapping data flow OR ADF mapping data flow. Re-target the Run button. |
| `mirrored-database` | `/api/fabric/workspaces`, `/api/items/mirrored-database/{id}` (Fabric Mirroring v1) | **🔴 FABRIC-API** | Loom has its own `loom-mirroring-engine` container app. Wire to that. |
| `eventhouse` | `/api/items/eventhouse/{id}` → returns Loom ADX cluster URI + databases | **🟢 LOCAL-AZURE** | Works — verified UAT |
| `kql-database` | `/api/items/kql-database/{id}/query`, `/api/items/kql-database/{id}/tables` | **🟢 LOCAL-AZURE** | Works — verified UAT (Sample geo + graph datasets loadable via `/api/admin/load-sample-data`) |
| `kql-queryset` | (via phase3-editors shared workspace picker → `/api/fabric/workspaces`) | **⚪ MIXED** | KQL backend is correct (ADX), but workspace picker calls Fabric. Re-target picker. |
| `kql-dashboard` | (same as above) | **⚪ MIXED** | Same fix |
| `eventstream` | `/api/items/eventstream/{id}` → Cosmos state only | **🟡 LOOM-COSMOS-ONLY** | Save/load works. **Actually pushing events** is not wired — needs Event Hubs + Kusto ingestion pipeline. v3 deferred this. |
| `activator` | (via phase3 picker) `/api/items/activator?workspaceId=...` | **⚪ MIXED** | Workspace picker calls Fabric. Backend is the Loom `loom-activator-engine` container which works. Re-target picker. |
| `warehouse` | (via phase3 picker) Fabric Warehouse REST | **🔴 FABRIC-API** | Loom equivalent = Synapse Dedicated SQL Pool. Already wired separately for `synapse-dedicated-sql-pool`. Merge or wrap. |
| `semantic-model` | (via phase3 picker) Fabric Semantic Model REST | **🔴 FABRIC-API** | Loom should use Power BI tenant API + the user's Power BI workspace, not Fabric. |
| `report`, `dashboard`, `paginated-report`, `scorecard` | (via phase3 picker) Fabric REST | **🔴 FABRIC-API** | All four are Power BI items. Re-target to Power BI tenant API. |
| `synapse-serverless-sql-pool` | `/api/items/synapse-serverless-sql-pool/{id}/query` | **🟢 LOCAL-AZURE** | Works — real T-SQL against `syn-loom-default-eastus2` |
| `synapse-dedicated-sql-pool` | `/api/items/synapse-dedicated-sql-pool/{id}/query` + resume/state | **🟢 LOCAL-AZURE** | Works — real T-SQL + auto-pause Logic App |
| `synapse-spark-pool` | `/api/items/synapse-spark-pool/list`, `/api/items/synapse-spark-pool/{name}` | **🟢 LOCAL-AZURE** | Works — real Spark pool ops |
| `synapse-pipeline` | `/api/items/synapse-pipeline/{name}/runs` + shared DAG view (v3.27) | **🟢 LOCAL-AZURE** (v3.27) | Works. v3.27: Graph tab added — `PipelineDagView` renders the activities array as a topologically-ranked DAG with success/failure/completion/skip edge legend. Shared component reused across synapse-pipeline / adf-pipeline / data-pipeline editors. |
| `databricks-cluster` | `/api/items/databricks-cluster/{id}` + events + state | **🟢 LOCAL-AZURE** | Works — real cluster ops |
| `databricks-job`, `databricks-notebook` | `/api/items/databricks-job/{id}/run`, `/api/items/databricks-notebook/{id}/run` | **🟢 LOCAL-AZURE** | Works — real Jobs API |
| `databricks-sql-warehouse` | (covered by databricks-editors) | **🟢 LOCAL-AZURE** | Works |
| `adf-pipeline`, `adf-dataset`, `adf-trigger` | `/api/items/adf-pipeline/{name}/run`, etc. + shared DAG view (v3.27) | **🟢 LOCAL-AZURE** (v3.27) | Works — real ADF REST. v3.27: Graph tab added (same component as synapse-pipeline). |
| `usql-job` | (no live backend — ADLA retired 2024-02-29) | **🟡 DEPRECATION-SURFACE** (v3.27) | Editor rewired as a deprecation page: error-intent MessageBar explaining ADLA retirement, U-SQL → PySpark heuristic translator (covers EXTRACT/SELECT/GROUP BY/OUTPUT). No more fake AU/cost estimates. See `usql-job-parity-spec.md`. |
| `apim-api`, `apim-product`, `apim-policy` | `/api/items/apim-*` | **🟢 LOCAL-AZURE** (v3.27) | Works — real APIM REST. v3.27: APIM Policy Operation-scope route added (`apis/{aid}/operations/{oid}` shape). All four scopes now wired: Global / API / Product / Operation. |
| `data-product` | `/api/cosmos-items/data-product/{id}` (state) + `/api/items/apim-product` (publish mirror) | **🟡 LOOM-COSMOS-ONLY** (v3.27 — was F) | Cleared F-vaporware: hardcoded sample state removed; editor is now Cosmos-state-backed with `displayName/domain/owner/sla/bundle[]` fields. **Purview UC publish still pending** — MessageBar gate explains this and the "Publish to APIM" action is now correctly labeled as the API consumer surface, not the Purview Data Product registration. |
| `lakehouse` | `/api/lakehouse/containers`, `/paths`, `/preview`, `/upload`; `/api/items/synapse-serverless-sql-pool/{id}/query` | **🟢 LOCAL-AZURE** | Works — real ADLS Gen2 browse + Synapse Serverless query |
| `azure-sql-server`, `azure-sql-database`, `azure-sql-managed-instance`, `sql-server-2025-vector-index` | `/api/items/azure-sql-*/query` etc. | **🟢 LOCAL-AZURE** | Works — real TDS + ARM |
| `cosmos-gremlin-graph` | `/api/items/cosmos-gremlin-graph/{id}/query` | **🟢 LOCAL-AZURE** (v3.27) | Real Gremlin query works. v3.27: ribbon **Edges** / **Vertices** buttons now wired — load quick `g.V()` / `g.E()` queries with label + name projection and dispatch immediately. Graph viz still deferred. |
| `cypher-graph` | `/api/items/kql-database/{id}/query` (Cypher routed to ADX `make-graph`) | **🟢 LOCAL-AZURE** | Works — verified UAT. No Azure-native Cypher backend exists; KQL substitution is the honest path. |
| `gql-graph` | `/api/items/gql-graph/{id}/query` (501 deferred until LOOM_FABRIC_GRAPH_WORKSPACE bound) | **🟡 LOOM-COSMOS-ONLY** (v3.27 — was F) | Cleared F-vaporware: Run button now dispatches to a real route. Three backends in picker: **persist-only** (saves to item state), **fabric-graph** (returns 501 with documented gate), **cosmos-gremlin-translate** (best-effort GQL→Gremlin). See `gql-graph-parity-spec.md`. |
| `vector-store` | `/api/items/vector-store` (Cosmos state) | **🟡 LOOM-COSMOS-ONLY** (v3.27) | Spec is saved, similarity test not wired. v3.27: **cosmos-nosql** backend added to picker (DiskANN + VectorEmbeddingPolicy — Microsoft-recommended). Live creation REST still deferred. |
| `ai-foundry-hub`, `ai-foundry-project`, `prompt-flow`, `evaluation`, `content-safety`, `tracing`, `ai-search-index`, `compute`, `dataset` | `/api/items/{type}/{id}` → Foundry REST | **🟢 LOCAL-AZURE** | Works — real Azure ML / Foundry / Content Safety / AI Search |
| `copilot-studio-agent`, `-knowledge`, `-topic`, `-action`, `-channel`, `-analytics`, `copilot-template-library` | `/api/items/copilot-studio-*?envId=...` → Dataverse `msdyn_copilots` etc. | **🟢 LOCAL-AZURE** *(after v3.19 + AppUser + Copilot Studio per-env enable)* | Works when env has Dataverse + Copilot Studio enabled |
| `powerplatform-environment`, `dataverse-table`, `power-app`, `power-page`, `power-automate-flow`, `ai-builder-model` | `/api/items/{type}?envId=...` | **🟢 LOCAL-AZURE** *(after Dataverse setup)* | Works post-AppUser registration |
| `geo-map`, `geo-dataset`, `geo-query`, `geo-pipeline` | (via Synapse Serverless / ADX route + Loom Cosmos state) | **⚪ MIXED** | Backends correct; map tile rendering is iframe to bing-maps which **requires Azure Maps key** — not configured (B-grade) |
| `cross-item-copilot` | `/api/copilot/orchestrate`, `/api/copilot/sessions`, `/api/copilot/tools` | **🟢 LOCAL-AZURE** (v3.27) | Works — Loom's own orchestrator + Azure OpenAI. 32 tools wired. v3.27: ribbon buttons now wired — **New** / **Refresh** dispatch `loom-copilot:session` CustomEvents the embedded console listens for, **View registry** opens raw `/api/copilot/tools` JSON in a new tab. |
| `ml-model`, `ml-experiment` | `/api/items/ml-model/{id}`, `/api/items/ml-experiment/{id}` → Azure ML / Foundry | **🟢 LOCAL-AZURE** | Works — verified UAT (Foundry-backed) |
| `graphql-api` | `/api/items/graphql-api/{id}/publish` | **🟡 LOOM-COSMOS-ONLY** | Schema is persisted; **actually exposing the GraphQL endpoint** needs APIM provisioning. Spec done, runtime not wired. |
| `user-data-function` | `/api/items/user-data-function/...` | **🟡 LOOM-COSMOS-ONLY** | Body persisted; runtime hosting deferred. |
| `variable-library` | `/api/items/variable-library/...` | **🟡 LOOM-COSMOS-ONLY** | Cosmos store works; consumers (notebooks/pipelines reading vars) not wired. |
| `ontology` | `/api/items/ontology/{id}` + POST to `/api/items/graph-model` (v3.27) | **⚪ MIXED** (v3.27 — was 🟡) | Cosmos persistence works. v3.27: **Materialize as graph-model** button parses the class hierarchy → creates a graph-model item with one node type per class + IS_A edge type. Downstream graph-model → ADX path then lights up. Lakehouse entity binding + Activator triggers still deferred. |
| `graph-model` | `/api/items/graph-model/{id}` + `/materialize` to ADX | **🟢 LOCAL-AZURE** | Real ADX materialize via KQL DDL. |
| `plan` | `/api/items/plan/{id}` (Cosmos) | **⚪ MIXED** (v3.27 — was 🟡) | Cosmos persistence works. v3.27: progress meter + status badge counts (todo/doing/done/overdue) surface real values. Power Automate approval workflow + semantic-model writeback still deferred. |
| `map` | `/api/items/map/{id}` (Cosmos GeoJSON) + Azure Maps Static API (v3.27) | **⚪ MIXED** (v3.27 — was 🟡) | Cosmos persistence + GeoJSON validation + bbox autocompute. v3.27: **Azure Maps tile preview** (Static REST API) renders when `NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY` is set; bbox-driven zoom + center; falls back to MessageBar gate otherwise. Vector overlay rendering of features still v2.x. |
| `operations-agent`, `data-agent` | `/api/items/{type}/{id}` (Cosmos) | **🟡 LOOM-COSMOS-ONLY** | Cosmos config persists. Foundry Agent runtime + per-source typed picker pending — see operations-agent / data-agent parity specs. |
| `data-product-template` | `/api/items/data-product-template/{slug}/instantiate` | **🟢 LOCAL-AZURE** | Instantiate creates real Loom items from a template — works. B-grade. Gap: Purview governance domain linkage + access policy editor. See `data-product-template-parity-spec.md`. |
| `data-product-instance` | (Cosmos state + per-component refs) | **🟢 LOCAL-AZURE** (v3.27) | Components table is real. v3.27: **Health column added** — peeks at each child via `/api/cosmos-items/<slug>/<id>`, classifies as OK (<7d) / Stale (<30d) / Missing / Unknown. Ribbon **Health** button now wired to refresh. Access/Quality/Lineage/Activity tabs still pending. |
| `copy-job`, `dbt-job`, `spark-job-definition`, `environment` | `/api/items/{type}/{id}/run` | **⚪ MIXED** | `spark-job-definition` → Synapse Spark batch (works); `copy-job`, `dbt-job` → Cosmos state + Synapse pipeline run; `environment` → Cosmos only |

## Aggregate verdict

| | Count | Editors |
|---|---:|---|
| 🟢 LOCAL-AZURE (works) | ~45 | All Synapse SQL, Databricks, ADF, APIM, AI Foundry, Power Platform (post-setup), Lakehouse, Cosmos Gremlin, Cypher/ADX, Azure SQL |
| 🟡 LOOM-COSMOS-ONLY (UI saves config, runtime not wired) | ~8 | eventstream, vector-store, graphql-api, user-data-function, variable-library, ontology, plan, operations-agent |
| 🔴 FABRIC-API (wires to wrong backend) | ~12 | notebook, data-pipeline, dataflow, mirrored-database, warehouse, semantic-model, report, dashboard, paginated-report, scorecard, plus partial breakage in kql-queryset/kql-dashboard/activator workspace pickers |
| ⚪ MIXED | ~4 | geo-*, kql-queryset, kql-dashboard, activator (correct backend, wrong workspace picker) |

**Honest summary**: ~12 of 85 editors are pointing at Fabric tenant APIs that won't work in Loom's "Fabric-on-Azure-native" model. The user explicitly hit one of these (notebook) when picking a workspace.

## Phased remediation plan (proposed)

### Phase A (must-fix before "shippable for customers") — 12 editors

For each 🔴, rewire:

1. **Workspace dropdown** → `/api/workspaces` (Loom Cosmos)
2. **Compute / target dropdown** → real ARM-discovered resources in Loom's RGs:
   - notebook: `synapse-spark-pool` list + `databricks-cluster` list
   - data-pipeline + dataflow: `adf-pipeline` list (consolidate, since ADF is the Azure-native equivalent)
   - mirrored-database: `loom-mirroring-engine` jobs API
   - warehouse: pre-existing `synapse-dedicated-sql-pool` editor (wrap or redirect)
   - semantic-model + report + dashboard + paginated-report + scorecard: Power BI tenant API + workspace picker → user's actual Power BI workspaces
3. **Primary action** (Run/Refresh/Publish) → corresponding Azure REST call
4. Add a **per-editor UAT spec** that:
   - Creates a real Lakehouse / Spark pool / cluster / etc.
   - Opens the editor, asserts the dropdown contains it
   - Clicks Run, asserts the job appears in the real Azure backend's job list

### Phase B — 8 editors

Wire the 🟡 LOOM-COSMOS-ONLY ones to real runtimes. Examples:
- eventstream: deploy Event Hubs namespace via bicep + wire to Kusto ingestion
- graphql-api: provision APIM with the saved schema
- vector-store: wire to AI Search vector indexer

### Phase C — Quality of life

- Lakehouse ↔ SQL Analytics Endpoint auto-pairing
- `+ New item` dialog: Favorites tab + 11-category grouping matching Fabric's IA
- Workspace grid: Endorsement + Sensitivity columns + "Included in app" column

## Phase A — sized estimates (rough)

| Editor | Effort | Reason |
|---|---|---|
| notebook | M | new compute picker + 2 backend code paths |
| data-pipeline | S | redirect to existing adf-pipeline wiring |
| dataflow | M | map Dataflow Gen2 actions to ADF Mapping Data Flow REST |
| mirrored-database | M | wire to existing loom-mirroring-engine API |
| warehouse | XS | redirect to synapse-dedicated-sql-pool editor |
| semantic-model | M | Power BI tenant API + DAX runtime |
| report, dashboard, paginated-report, scorecard | M each | Power BI REST + embed token |
| kql-queryset, kql-dashboard, activator | S each | swap workspace picker only |

Total: ~3-4 weeks of focused engineering, not a single PR.

## What this means for the v3 release

The v3 UAT "113/113 pass" claim is **technically true** for the rubric we used (render + documented-gate handling) but **not sufficient** for customer-shippable. Honest release notes should say:

- 45 editors are end-to-end functional against real Azure backings ✅
- 8 editors persist their config to Cosmos but the runtime they describe isn't deployed yet — they should carry a "Preview" badge ⚠️
- 12 editors call Fabric tenant APIs that don't apply outside a Fabric-enabled tenant — **remove from the catalog or block creation until Phase A re-wire** ❌

Until Phase A lands, the catalog should hide or "Preview"-gate those 12 types.

---

*This audit was produced by tracing real fetch() calls in `apps/fiab-console/lib/editors/*.tsx` and visiting Fabric's `casino-fabric-poc` workspace via Playwright. Re-run by:*

```bash
cd apps/fiab-console
for f in lib/editors/*.tsx; do
  echo "=== $(basename $f .tsx) ==="
  grep -oE "fetch\(['\`][^'\`]+['\`]" "$f" | sed -E "s/fetch\(['\`]//" | sort -u
done
```
