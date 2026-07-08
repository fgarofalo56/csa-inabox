# PRP — Databricks Feature Parity (Loom Apps hosting, Genie-class NL rooms, Lakeflow pipelines, Mosaic-AI-class serving)

**Title:** Databricks feature parity incl. Loom Apps hosting (ACA), Genie-class NL rooms, Lakeflow-class pipelines, Mosaic-AI-class serving
**Date:** 2026-07-08
**Status:** proposed
**Author:** Parity Architect (Databricks → CSA Loom)
**Domain:** Data + AI platform parity with Azure Databricks (DAIS 2026 wave)

**Sources consulted:**
- Code audit (verified against source, not doc claims): `apps/fiab-console/lib/azure/databricks-client.ts` (2558 lines), `unity-catalog-client.ts`, `mlflow-client.ts`, `aml-automl-client.ts`, `mcp-deploy-client.ts` + `container-apps-arm-client.ts`, `lib/editors/databricks/*`, `lib/catalog/item-types/*`, `docs/fiab/parity/{loom-apps,data-agent,slate-app,copilot-maf}.md`, `docs/migrations/databricks-to-fabric/feature-mapping-complete.md`.
- Databricks product grounding: Databricks Apps (`https://docs.databricks.com/en/dev-tools/databricks-apps/index.html`), Lakeflow Declarative Pipelines / DLT (`https://docs.databricks.com/aws/en/dlt/`), Lakeflow Connect (`https://docs.databricks.com/en/ingestion/lakeflow-connect/index.html`), Lakebase (`https://docs.databricks.com/en/oltp/index.html`), Unity Catalog Metric Views (`https://docs.databricks.com/en/metric-views/index.html`), Managed Iceberg + UniForm (`https://docs.databricks.com/en/delta/uniform.html`), Catalog Federation (`https://docs.databricks.com/en/query-federation/index.html`), Genie / Genie One Managed MCP (`https://docs.databricks.com/aws/en/genie/`), Mosaic AI Agent Framework / Agent Bricks (`https://docs.databricks.com/en/generative-ai/agent-framework/`), MLflow 3.x GenAI tracing + Prompt Registry (`https://mlflow.org/docs/latest/`), Feature Store / Online Tables (`https://docs.databricks.com/en/machine-learning/feature-store/index.html`). DAIS 2026 keynote announcements (Lakebase GA, Lakeflow Designer GA, UC Metric Views, ABAC GA + Catalog Federation, Agent Bricks, managed Iceberg/UniForm).
- Governing rules: `.claude/rules/no-fabric-dependency.md`, `.claude/rules/no-vaporware.md`, `.claude/rules/ui-parity.md`, memory `loom_no_freeform_config`, `loom_design_standards`, `csa_loom_web5_visual_program` (canvas-node-kit), `csa_loom_gh_aca_runner` + `csa_loom_mcp_library` (proven ACA/ARM deploy pattern), `csa_loom_centralus_roll_recipe` (`az acr build`).

---

## Executive summary — the strategic why

Azure Databricks is a **first-party Azure resource** (`Microsoft.Databricks/workspaces`). Driving its REST/SQL surface is not a Fabric-dependency violation — it is the correct "drive the real backend" pattern under `no-vaporware.md`, and Loom already does it well: `databricks-client.ts` (2558 lines) runs a customer's *actual* workspace for SQL warehouses (Statement Execution API), clusters, jobs, notebooks, Unity Catalog (catalogs/schemas/tables/volumes/grants, governed tags + ABAC `CREATE POLICY`, Clean Rooms read surface), MLflow, Model Serving, Delta Sharing, and DLT pipeline lifecycle. That is real, verified parity for shops that keep a Databricks estate.

The strategic point of this wave is the same one that governs the whole product: **Loom must be Databricks-class on pure Azure/OSS, for Commercial *and* Government, with zero hard Databricks dependency.** Where a customer has Databricks bound, Loom drives it. Where they do not, every capability here still ships against a Loom-owned Azure-native/OSS backend — Container Apps for hosted apps, Postgres Flexible Server for Lakebase, the Loom-native semantic layer for Metric Views, the AOAI-backed Data Agent for Genie, Synapse/ADF for pipelines. This is exactly the dual path already proven by `ai-functions-helper.tsx` (ai_query when Databricks is present, AOAI otherwise) and by the mirrored-database engine (ADF CDC → ADLS Bronze Delta, which is the *only* HTAP story available in sovereign clouds where Databricks/Fabric mirroring does not run).

DAIS 2026 shipped a large batch — Lakebase GA, Lakeflow Designer GA, UC Metric Views, ABAC GA + Catalog Federation, Databricks Apps + Agent Bricks (deploy any agent harness with horizontal autoscaling), managed Iceberg/UniForm, Genie One's Managed MCP Server. Loom has real backends for the mature primitives but has **not** wired the newest surfaces, and — the single biggest gap verified in code — has **no generic hosted-app runtime**: nowhere can an operator supply a Streamlit/Dash/Gradio/Flask/Node app and get an autoscaled, OAuth-scoped, live URL the way Databricks Apps does. The proven pattern to build it already ships in production (`mcp-deploy-client.ts` + `container-apps-arm-client.ts` deploy arbitrary container images to ACA with per-app UAMI, KV secretRef, Azure Files, and an allowlisted env-var guard). This PRP points that pattern at user source and closes the surrounding Databricks-parity gaps.

**Non-negotiables applied to every item below:** no hard Databricks/Fabric/Power BI dependency (opt-in only, Azure-native default); no freeform JSON config (wizards/dropdowns/canvas/Copilot per `loom_no_freeform_config`); Fluent v9 + Loom tokens + `canvas-node-kit.tsx` for any designer; every real-backend receipt per `no-vaporware.md`; Commercial + Government cloud paths (endpoint suffix + honest-gate matrix) for each.

---

## Work items

| # | Item | Capability | Source product | Loom state | Priority | Effort |
|---|------|-----------|----------------|-----------|----------|--------|
| 1 | `loom-app-runtime` | One-click hosted Python/Node data-and-AI apps on ACA (autoscale-to-zero, OAuth-scoped) — Databricks Apps opt-in as alt target | Databricks Apps + Agent Bricks | MISSING | **P0** | XL |
| 2 | Custom agent hosting | Bring-your-own agent harness (LangGraph/CrewAI/SDK) built + hosted as an autoscaled endpoint | Databricks Agent Bricks | PARTIAL | P1 | L |
| 3 | `databricks-pipeline` | Lakeflow Declarative Pipelines (DLT) visual editor — DAG canvas, expectations, run history, event log | Lakeflow / DLT | PARTIAL | P1 | L |
| 4 | `lakebase-postgres` | Serverless Postgres OLTP w/ branching/snapshots + pgvector hybrid search | Databricks Lakebase | MISSING | P1 | L |
| 5 | Data Agent Genie deltas | Metric-view grounding + "Open in Databricks Genie" deep link on the already-built A-grade Data Agent | Databricks Genie (next-gen) | PARTIAL | P2 | S |
| 6 | UC Metric Views | Governed reusable KPI definitions (multi-fact, LOD, window measures, materialization) | Unity Catalog Metric Views | MISSING | P2 | M |
| 7 | Streaming tables + MVs | First-class `CREATE STREAMING TABLE` / `CREATE MATERIALIZED VIEW` in the SQL editor object tree + refresh schedule | Databricks SQL / Lakeflow | PARTIAL | P2 | M |
| 8 | Clean Rooms create + tasks | `createCleanRoom` + CLEAN ROOM TASK CRUD/run (extends the read-only surface) | Databricks Clean Rooms | PARTIAL | P2 | M |
| 9 | Publish Data Agent as MCP | Expose a `data-agent` as a Managed MCP Server tool endpoint | Databricks Genie One (Managed MCP) | MISSING | P2 | M |
| 10 | MLflow 3.x GenAI | Unified GenAI trace tab in `ml-experiment` + versioned Prompt Registry | MLflow 3.x | PARTIAL | P2 | M |
| 11 | Managed Iceberg + UniForm | Table-format dropdown (Delta / UniForm-Iceberg / managed Iceberg) + deletion-vectors/row-lineage toggles | UC / Delta Lake | MISSING | P2 | S |
| 12 | Lakeflow Connect sink | `sink = Databricks UC managed table` option on the existing mirror-source wizard | Lakeflow Connect | MISSING | P3 | M |
| 13 | Catalog Federation | Cross-account/region/cloud UC catalog federation (admin wizard) | UC Catalog Federation | MISSING | P3 | M |
| 14 | Feature Store + Online Tables | Offline Delta features → Cosmos online store for low-latency serving lookups | Databricks Feature Store | MISSING | P3 | L |

> Items scored **BUILT** in research and therefore *excluded*: Vector Search (`vector-store` on AI Search), MLflow experiment tracking / model registry (`ml-experiment` + `mlflow-client.ts`), AutoML (`aml-automl-client.ts`), Model Serving / deployment (`ml-model` + Foundry model-catalog browse/deploy), Delta Sharing bidirectional marketplace (PR #1578), the core Databricks workspace REST integration (clusters/jobs/notebooks/warehouses/serving/UC), and the A-grade Genie-class **Data Agent** itself (`docs/fiab/parity/data-agent.md`) — only its two incremental deltas survive as item #5.

---

## 1 — Loom App Runtime (`loom-app-runtime`) — P0, XL

**Capability.** One-click hosted Python/Node data-and-AI apps (Streamlit / Dash / Gradio / Flask / Express / React) with managed serverless compute, autoscale-to-zero, OAuth-scoped access to the operator's *own* Azure data/AI resources, and a live app URL. This is the marquee gap and the foundation for items #2 and #9.

**Source-product grounding.** Databricks Apps — `https://docs.databricks.com/en/dev-tools/databricks-apps/index.html` (deploy a framework app backed by serverless compute + Unity Catalog with OAuth-scoped access). DAIS 2026 Agent Bricks: "deploy any agent harness to Databricks Apps with horizontal autoscaling."

**Current Loom state — MISSING (verified).** No generic container-hosting item type exists: `grep "slug: '.*container-app"` across `apps/fiab-console/lib/catalog/item-types/*.ts` returns zero hits. The "Loom Apps" category (`lib/catalog/item-types/fabric-apps.ts`, `docs/fiab/parity/loom-apps.md`) contains only: `loom-app` (Cosmos-persisted bundler of *existing* items — no new compute), `rayfin-app` (scaffolds Functions + Cosmos + SWA, AAS-bound read views — no arbitrary user code), `slate-app` (Palantir-Slate-parity canvas, D-grade, Publish emits a copy-paste SWA bundle only — no live deploy), `workshop-app` (ontology CRUD against Synapse SQL). None hosts arbitrary user source as a running, autoscaled URL.

**Azure-first / OSS build.**
- **Backend service:** Azure Container Apps (`Microsoft.App/containerApps`) as the default runtime; Loom ACR for image builds via ACR Task (`az acr build`, the proven roll pattern per `csa_loom_centralus_roll_recipe`). No Databricks needed on the default path.
- **Client lib:** extend `apps/fiab-console/lib/azure/container-apps-arm-client.ts` (currently MCP-server-specific) to accept an arbitrary `image` + `env[]` + `ingress` shape; reuse `mcp-deploy-client.ts`'s per-app UAMI, KV `secretRef` resolution, Azure Files volume mount, and the allowlisted env-var-prefix guard (`LOOM_|MCP_|AZURE_|APPLICATIONINSIGHTS_|KEYVAULT_|CSA_LOOM_`) that satisfies `loom_no_freeform_config`. Add a thin `lakebase`-style optional `loom-app-databricks-client.ts` only for the opt-in Databricks Apps target (below).
- **BFF routes:** `POST /api/items/loom-app-runtime/[id]/build` (generate Dockerfile → `az acr build` → push to Loom ACR); `POST .../deploy` (ARM create/update with `minReplicas:0` + `authConfig` wired to Entra OAuth so the app inherits the caller's Loom session claims — mirrors Databricks Apps' OAuth-to-UC); `POST .../{start,stop}`, `DELETE`, and `GET .../logs` (Container Apps log-stream).
- **Editor / UI shape (Fluent v9 + Loom tokens):** a **runtime-template picker** (Streamlit / Dash / Gradio / Flask / Express — dropdown, no freeform) → either paste `app.py`/`server.js` + `requirements.txt`/`package.json` in a Monaco pane, or point at a GitHub repo path. Tabs: **Source**, **Deploy** (replica min/max sliders, ingress toggle, resource dropdown), **Bindings** (checkbox list to inject `LOOM_*` endpoints for the operator's own Synapse/ADX/AI Search/Cosmos so the app calls back into Loom's data plane — the UC-analogue), **Logs** (live stream), **Lifecycle** (Start/Stop/Delete). Opt-in **"Deploy to Databricks Apps"** path appears only when a Databricks workspace is bound: `POST /api/2.0/apps` + `PATCH .../deployments` via the existing `dbxFetch` helper in `databricks-client.ts`.
- **Catalog wiring:** new item in the **Loom Apps** family in `fabric-item-types.ts` + `registry.ts`; single head tile per the catalog-consolidation convention.
- **Bicep needs:** extend `platform/fiab/bicep/modules/**/app-deployments.bicep` (exists per the MCP path) to grant the Console UAMI **Container Apps Contributor** + **AcrPush** scoped to a `loom-apps` sub-RG; add env vars `LOOM_APPS_CAE_ID`, `LOOM_APPS_ACR_LOGIN_SERVER` mirroring the existing `LOOM_CAE_ID`/`LOOM_ADMIN_RG` MCP vars in `admin-plane/main.bicep`.
- **Default-ON / opt-out posture (per the WAVES.md global principle):** the runtime ships **enabled by default** — there is **no spend-approval gate and no per-app enablement gate**. Any operator can build and deploy an app the moment the runtime is wired; apps are **deploy default-allowed**. Cost is bounded structurally, not by a gate: every deployed app defaults to **ACA autoscale-to-zero** (`minReplicas:0`) so a resting app costs ~$0. Admin control is **opt-out**: a **per-app shutdown / disable** toggle on the Lifecycle tab (Stop/Delete already real ARM calls) plus a **tenant-wide runtime kill switch** in tenant settings (`LOOM_APPS_RUNTIME_ENABLED`, default `true`) that admins can flip to halt all app deploys/starts. The kill switch and per-app disable remove a running default — they are never a prerequisite to using the feature. (The only honest gate remains the infra one below: if `LOOM_APPS_CAE_ID`/`AcrPush` isn't wired, a MessageBar names it.)
- **Gov notes:** Container Apps is GA in Commercial + most Gov regions; for AKS-boundary clouds (GCC-High / IL5) fall back to the **same GitOps-manifest honest-gate** `mcp-deploy-client.ts` already uses. No Fabric/Databricks dependency anywhere on the default path.

**Acceptance criteria (real-backend receipt).** Deploy a Streamlit app from pasted source in a UAMI-only environment (Databricks unbound): receipt = the ACR build run id + the ARM PUT response + the live `https://<app>.<region>.azurecontainerapps.io` URL returning HTTP 200 behind Entra auth, plus a Playwright screenshot of the running app. Autoscale-to-zero verified (replica count → 0 when idle, cold-start on hit). Stop/Delete lifecycle returns real ARM responses. No mock arrays; no `return []`.

---

## 2 — Custom agent hosting — P1, L

**Capability.** Bring-your-own agent harness (LangGraph / CrewAI / Claude Agent SDK / OpenAI Agents SDK-style code) built and deployed as an autoscaled hosted agent endpoint — distinct from the single-purpose NL2SQL Data Agent.

**Source-product grounding.** Databricks Agent Bricks — `https://docs.databricks.com/en/generative-ai/agent-framework/` (DAIS 2026: "build agents with any model and any harness… deploy with horizontal autoscaling to Databricks Apps").

**Current Loom state — PARTIAL.** `data-agent` (`docs/fiab/parity/data-agent.md`, A-grade) is a real Genie-class NL-to-data agent but a *fixed* shape (NL → query → grounded answer) with no surface for operator-supplied agent code. Loom's own multi-step orchestrator (`lib/azure/copilot-orchestrator.ts`, the `copilot-maf` Container App) is Loom's *internal* Copilot backend only — not exposed as an end-user builder.

**Azure-first / OSS build.** Rides entirely on item #1. Add an **"Agent" runtime template** alongside Streamlit/Dash — a FastAPI/Flask scaffold pre-wired with the AOAI client (reuse `resolveAoaiTarget()`), a tool-calling loop skeleton, and optional bindings to Loom's data-plane clients (`kusto-client`, `synapse-sql-client`, `foundry-client`). Operator authors/pastes any-framework Python (it is just a container), Loom builds via ACR Task and deploys to ACA with `minReplicas:0`. **Compose-back:** register the agent's `/invoke` endpoint as a Data Agent tool source by extending `DA_SOURCE_TYPES` in `lib/editors/_family-utils.ts`, so custom agents fold into the existing Genie-style chat. Catalog: same Loom Apps family, "Agent" template variant. Bicep: none beyond #1. Gov: inherits #1's matrix.

**Acceptance criteria.** Deploy a LangGraph agent from pasted source; receipt = live `/invoke` returning a real multi-step tool-calling response, and the agent appearing as a selectable tool source inside a Data Agent chat that executes it end-to-end.

---

## 3 — Lakeflow Declarative Pipelines (DLT) visual editor (`databricks-pipeline`) — P1, L

**Capability.** Pipeline authoring with a DAG view, expectations, run/update history, and event log — the visual editor Databricks ships for DLT.

**Source-product grounding.** Lakeflow Declarative Pipelines / DLT — `https://docs.databricks.com/aws/en/dlt/`; Lakeflow Designer GA (DAIS 2026).

**Current Loom state — PARTIAL.** The client is real: `databricks-client.ts:2203-2286` (`listDltPipelines` / `createDltPipeline` / `deleteDltPipeline` via `/api/2.0/pipelines`). But `lib/editors/databricks/job-editor.tsx:1068` shows the Job editor's `pipeline_task` field is a raw Input asking the user to "Paste the pipeline id from the Databricks Delta Live Tables UI — no Loom DLT editor yet (tracked gap)." No canvas, DAG, or expectations UI exists anywhere in `lib/editors`.

**Azure-first / OSS build.**
- **Backend/client:** extend `databricks-client.ts` with `GET /api/2.0/pipelines/{id}` (spec + latest update), `GET .../events` (event log), `GET .../updates` (run history) — all real REST around the existing scaffold.
- **BFF routes:** `app/api/items/databricks-pipeline/[id]/{spec,events,updates,start,stop}/route.ts`.
- **Editor / canvas UI:** new `lib/editors/databricks/pipeline-editor.tsx` — a **React Flow DAG** built on `canvas-node-kit.tsx` (per `csa_loom_web5_visual_program`) rendering the pipeline's library/flow graph parsed from the spec (notebook/glob libraries + target schema); a **run/update history** DataGrid; an **event-log panel** (info/warning/error rows with expectation pass/fail counts). **No freeform JSON** (`loom_no_freeform_config`): spec edits via a library-picker (notebook/file dropdown) + target-schema/catalog dropdowns + continuous-vs-triggered toggle + photon toggle + serverless toggle. Honest-gate MessageBar if Databricks unconfigured (reuse the `UnityCatalogError` pattern at `unity-catalog-client.ts:65`).
- **Catalog:** new item type in `fabric-item-types.ts` + `registry.ts`.
- **Bicep:** none (drives the bound Databricks workspace).
- **Gov / no-Databricks path:** this item only applies when Databricks *is* the chosen backend; when it is not, Loom's own Synapse/ADF `data-pipeline` item (already built per `no-fabric-dependency.md`) is the parity surface — do **not** hard-require Databricks.

**Acceptance criteria.** Against a bound workspace, open an existing DLT pipeline: receipt = the DAG rendering its real library nodes, the event-log panel showing real expectation pass/fail counts from `/events`, and a Start returning a real update id from `/api/2.0/pipelines/{id}/updates`.

---

## 4 — Lakebase — serverless Postgres OLTP (`lakebase-postgres`) — P1, L

**Capability.** Serverless Postgres OLTP with git-style branching/snapshots, autonomous ops, and hybrid vector + full-text search (Lakebase Search). Databricks Lakebase went GA June 2026.

**Source-product grounding.** Databricks Lakebase — `https://docs.databricks.com/en/oltp/index.html`.

**Current Loom state — MISSING.** `grep "lakebase"` across `lib/` and `app/` = zero hits (no item type, client, or editor).

**Azure-first / OSS build.** A textbook `no-fabric-dependency` decision — Azure has a first-party equivalent, so make it the **default**:
- **Backend service:** **Azure Database for PostgreSQL Flexible Server** (serverless/auto-scaling tier) — or Cosmos DB for PostgreSQL for the HTAP/branching story — provisioned via `arm-client` (`Microsoft.DBforPostgreSQL/flexibleServers`).
- **Client lib:** `postgres-flexible-client.ts` wrapping `az rest`: branch = point-in-time-restore-as-new-server (approximates git-branching); read-replica APIs for DR. Opt-in `lakebase-databricks-client.ts` drives real Lakebase REST (`POST /api/2.0/database/instances`, branch, etc.) only when `LOOM_LAKEBASE_BACKEND=databricks` + a workspace is bound (mirrors the SQL-database Fabric-vs-Azure pattern in `docs/fiab/prp/databases.md`).
- **BFF routes:** `app/api/items/lakebase-postgres/[id]/{query,branches,snapshot,replicas}/route.ts`.
- **Editor / UI:** connection panel + **query tool** (Monaco, pg dialect) + **branch/snapshot list** (PITR restores) + **pgvector extension toggle** for the Lakebase-Search parity (Flexible Server supports `pgvector` natively — hybrid vector + full-text without Databricks). All controls wizard/dropdown-driven, no freeform config.
- **Catalog:** new item type; Databases family.
- **Bicep:** `platform/fiab/bicep/modules/**/postgres-flexible.bicep` (server + firewall/PE + `pgvector` allowlist); Console UAMI as AAD admin; env `LOOM_LAKEBASE_BACKEND`.
- **Gov notes:** endpoint suffix differs — `postgres.database.azure.com` (Commercial) vs `postgres.database.usgovcloudapi.net` (Gov); resolve per cloud in the client.

**Acceptance criteria.** Provision a Flexible Server (Databricks unbound), create a table + insert rows via the query tool (real TDS/pg execution receipt), create a branch (real PITR restore id), enable `pgvector` and run a vector-distance query returning real rows.

---

## 5 — Data Agent Genie deltas (metric-view grounding + Databricks deep-link) — P2, S

**Capability.** Two incremental enhancements to the *already-built* A-grade Genie-class Data Agent: (a) ground chat on **Metric Views** (item #6) so NL questions resolve to governed KPI definitions, and (b) an **"Open in Databricks Genie"** deep link for power users when a workspace is bound.

**Source-product grounding.** Databricks Genie (next-gen conversational analytics across structured + unstructured sources) — `https://docs.databricks.com/aws/en/genie/`.

**Current Loom state — PARTIAL (reconciled).** Research stream 1 flagged "Genie" as broadly missing, but the code-verified stream 2 confirms `data-agent` (`docs/fiab/parity/data-agent.md`) already delivers the Genie-class room: curated typed sources + instructions + example queries, live grounded chat that *executes* generated SQL/KQL against Synapse/ADX/AI Search and re-prompts with real rows, plus Foundry Agent Service publish. So the room itself is **BUILT** — only these two deltas remain, hence S not L.

**Azure-first / OSS build.** (a) Extend the Data Agent source picker (`DA_SOURCE_TYPES` in `lib/editors/_family-utils.ts`) to accept a **metric-view** source; the grounding prompt then references governed measure definitions instead of raw columns, executing the compiled metric SQL via the existing `data-agent-execute.ts` path. (b) Add a conditional **"Open in Databricks Genie"** action (deep link) that renders only when a workspace is bound — Loom's own Data Agent stays the default, so the feature works with zero Databricks dependency. No new infra.

**Acceptance criteria.** A Data Agent grounded on a metric view answers a KPI question by executing the metric's compiled SQL (real rows in the receipt); the deep link is absent when no workspace is bound and resolves to the correct Genie URL when one is.

---

## 6 — Unity Catalog Metric Views — P2, M

**Capability.** Governed, reusable business-KPI definitions: multi-fact relationships, LOD calcs, parameterized metrics, window measures, and materialization for fast agent/dashboard queries.

**Source-product grounding.** UC Metric Views — `https://docs.databricks.com/en/metric-views/index.html` (DAIS 2026 GA).

**Current Loom state — MISSING.** `grep "metric view" / "CREATE METRIC"` across `lib/azure/*.ts` and `lib/editors/databricks/*.tsx` = zero hits; `unity-catalog-client.ts` has catalogs/schemas/tables/volumes/tags/ABAC/clean-rooms but no metric-view CRUD.

**Azure-first / OSS build.** Loom already owns a native semantic/tabular layer (`no-fabric-dependency.md` row `semantic-model` → "Loom-native tabular layer over warehouse/lakehouse") and a report designer (`csa_loom_report_designer_pbi_copilot`, DAX + save). Extend **that** semantic-model editor with a **Metric** object type (name, expression over one or more fact tables, dimensions, filters, window/LOD calc builder — all dropdown/wizard, no freeform) that compiles to **(a)** a DAX measure in the Loom semantic model when the source is warehouse/lakehouse, or **(b)** real `CREATE METRIC VIEW` DDL via `unity-catalog-client.executeStatement` when the source is a bound Databricks UC catalog. Add a **Metric Views** tab to `uc-dialogs.tsx` (list/describe/create via `SHOW METRIC VIEWS` / `DESCRIBE` / `CREATE METRIC VIEW` real SQL over the Statement Execution API — same pattern as the shipped ABAC/tags work). Materialization = scheduled `REFRESH` via Databricks Jobs (existing `job-editor`) on the Databricks path, or a Synapse materialized view on the Azure-native path. Catalog: extends the existing `semantic-model` item. Bicep: none. Gov: pure SQL/DAX, both suffixes.

**Acceptance criteria.** Create a metric over two fact tables; receipt = the compiled DAX measure returning a real aggregate on the Azure path, and the `CREATE METRIC VIEW` DDL + a `SELECT` against it returning real rows on the bound-Databricks path.

---

## 7 — Streaming tables + Materialized Views in the SQL editor — P2, M

**Capability.** `CREATE STREAMING TABLE` / `CREATE MATERIALIZED VIEW` as first-class SQL objects with refresh scheduling and incremental refresh, surfaced in the SQL editor's object explorer and Get-Data flows. Ship together with item #3 (streaming tables/MVs are DLT-backed).

**Source-product grounding.** Databricks SQL / Lakeflow — `https://docs.databricks.com/aws/en/dlt/` (streaming tables & materialized views).

**Current Loom state — PARTIAL.** `CREATE MATERIALIZED VIEW` appears only as a UC privilege-string literal in the `databricks-editors.tsx` grants list — no DDL template, no refresh-schedule UI, no object-explorer node type distinct from normal tables/views.

**Azure-first / OSS build.** Extend the SQL Warehouse editor's object tree (`sql-warehouse-editor.tsx`) to classify objects by `table_type` (from `SHOW TABLES` / `DESCRIBE`) into **Tables / Views / Streaming Tables / Materialized Views** with distinct icons. Add **"New Streaming Table"** / **"New Materialized View"** to the New-Query template menu (existing template dropdown per `databases.md` T3) inserting real `CREATE STREAMING TABLE … AS SELECT … FROM STREAM read_files(...)` / `CREATE MATERIALIZED VIEW … AS SELECT …` DDL, executed via `executeStatement`. Add a **refresh-schedule control** calling the pipeline/job scheduling REST already built in `databricks-client.ts` for DLT (streaming tables/MVs are DLT-backed) — ties directly into item #3. Catalog: no new item (editor enhancement). Bicep: none. Gov: SQL over the bound warehouse.

**Acceptance criteria.** Create a streaming table from `read_files` over an ADLS path; receipt = the object appearing under the Streaming Tables node with its real `table_type`, a scheduled refresh returning a real update/job id, and a `SELECT` returning ingested rows.

---

## 8 — Clean Rooms create + task CRUD — P2, M

**Capability.** Create a clean room, add collaborators, and CREATE/MODIFY/EXECUTE CLEAN ROOM TASK (notebook jobs on clean-room-scoped compute).

**Source-product grounding.** Databricks Clean Rooms — `https://docs.databricks.com/en/clean-rooms/index.html`.

**Current Loom state — PARTIAL.** `uc-dialogs.tsx:2469-2527` + `unity-catalog-client.ts:2183-2257` build a real but explicitly **read-only** surface (list/get/collaborators/assets), per the inline comment: "Creating a clean room … and running clean-room TASKS … are niche/preview flows, so list + view is the solid surface." No `createCleanRoom`, no task CRUD/run.

**Azure-first / OSS build.** Add `createCleanRoom` (`POST /api/2.0/clean-rooms`) and a task-management surface (list/create/run CLEAN ROOM TASK via the Statement Execution API against the clean-room-scoped warehouse) to `unity-catalog-client.ts`, mirroring the already-real `createUcPolicy`/`dropUcPolicy` build+execute-SQL pattern. Editor: extend the existing Clean Rooms tab in `uc-dialogs.tsx` with a **"New clean room" wizard** (name, collaborator picker reusing `listUcPrincipals`/SCIM directory, cloud/region — all dropdown) and a **Tasks** sub-tab (notebook-backed task picker + run button + run history). **Azure-native default for no-Databricks shops:** document Azure Clean Rooms preview (confidential computing + Azure Data Share), or pragmatically a Purview-governed two-tenant Synapse Serverless view with row-level security, as the parity story — do **not** hard-require Databricks for any "shared analytics without raw data movement" claim in Loom's marketing surfaces. Catalog: editor enhancement. Bicep: none for the Databricks path. Gov: SQL/REST over the bound workspace.

**Acceptance criteria.** Create a clean room + add a collaborator (real `POST /api/2.0/clean-rooms` response), create and run a CLEAN ROOM TASK (real run id + result), all visible in the Tasks sub-tab.

---

## 9 — Publish a Data Agent as a Managed MCP Server — P2, M

**Capability.** Expose an existing `data-agent` as an MCP tool endpoint other agents / Copilot Studio / Claude / VS Code can call — grounded NL data Q&A over MCP.

**Source-product grounding.** Databricks Genie One — Managed MCP Server (Beta 2026): "any agent can ask natural-language data questions across Genie Spaces and Unity Catalog data and receive grounded answers" via MCP.

**Current Loom state — MISSING.** Loom's MCP surface (`lib/azure/mcp-catalog.ts`, `lib/mcp/catalog.ts`, admin `mcp-servers` pages) is entirely **consume-side** (deploys third-party MCP servers as Container Apps for Loom/Copilot to call). No route/UI exposes a `data-agent` *as* an MCP server. `grep "expose.*as.*mcp" / "publish.*mcp server"` = zero hits outside the unrelated catalog.

**Azure-first / OSS build.** New route `POST /api/items/data-agent/[id]/publish-mcp` deploying a thin MCP-protocol adapter (reuse the item #1 / `mcp-deploy-client.ts` ACA path) that wraps the existing `chatGrounded()` from `lib/azure/data-agent-execute.ts` as a single MCP tool (`ask_<agent-name>`). Editor: a **"Publish as MCP Server"** toggle on the Data Agent Publish tab (beside the existing Foundry Agent Service publish) returning the MCP server URL + a copy-paste config block for Claude Desktop / Copilot Studio / VS Code. Per-agent UAMI scoped read to the agent's bound sources. Bicep: same `LOOM_CAE_ID` boundary as the MCP catalog. Gov: honest-gate 503 naming `LOOM_CAE_ID` when the ACA boundary isn't configured; GCC-High/IL5 fall back to the GitOps-manifest path per `mcp-deploy-client.ts`.

**Acceptance criteria.** Publish a Data Agent as MCP; receipt = the live MCP server URL, an MCP `tools/list` returning the `ask_<agent>` tool, and an MCP `tools/call` returning a real grounded answer with executed rows.

---

## 10 — MLflow 3.x GenAI tracing + Prompt Registry — P2, M

**Capability.** Unified GenAI tracing (LLM/agent span traces inside the experiment/run view) + a versioned Prompt Registry tied to evaluation runs.

**Source-product grounding.** MLflow 3.x — `https://mlflow.org/docs/latest/` (GenAI tracing integrated into experiment/run view; Prompt Registry).

**Current Loom state — PARTIAL.** `ml-experiment-editor.tsx` (built, not a stub — real MLflow REST via `mlflow-client.ts`: `searchExperiments`, `searchRuns`, metric-step charts, parallel-coordinates compare, `MLFLOW_MODEL_STAGES` transitions) covers *classical* tracking well. But LLM/agent tracing lives in a **separate** item — `tracing` (`FoundryTracing`, `lib/catalog/item-types/azure-ai-foundry.ts`) — App-Insights operation traces, *not* the MLflow trace data model, and not cross-linked into the `ml-experiment` runs table. No prompt-registry item exists (`prompt-flow` is a LangChain-style flow graph, not a versioned-prompt registry).

**Azure-first / OSS build.** **(a) Tracing:** add a **Traces** tab to `ml-experiment-editor.tsx` querying the *same* App Insights backend the `tracing` item already uses, joined by MLflow `run_id` tag so an LLM call inside a tracked run shows its span tree inline — a BFF-route join, **no new Azure resource**. **(b) Prompt Registry:** new lightweight Cosmos-backed item `prompt-template` (name, template text with `{{var}}` placeholders — reuse the injection-safe substitution helper from `slate-app` P1 work per `docs/fiab/parity/slate-app.md`), a version-history list, and a **"Run evaluation"** button that hands the selected prompt version to the **existing** `evaluation` (Foundry Evaluation) item — no new eval engine. Catalog: one new `prompt-template` item + one editor tab. Bicep: none (Cosmos container via `createIfNotExists`). Gov: App Insights + Cosmos both GA in Gov.

**Acceptance criteria.** A tracked run's LLM call shows its real span tree in the Traces tab (joined by `run_id`); a prompt template versioned to v2 runs a real Foundry Evaluation returning scored results tied to that version.

---

## 11 — Managed Iceberg tables + UniForm — P2, S

**Capability.** UC managed Iceberg tables + UniForm (Delta ↔ Iceberg interop), Iceberg v3 (deletion vectors, VARIANT, row lineage), cross-engine reads.

**Source-product grounding.** UC / Delta Lake UniForm — `https://docs.databricks.com/en/delta/uniform.html`.

**Current Loom state — MISSING.** `grep "iceberg" / "uniform"` across `lib/azure/*.ts` = zero hits; the create-table dialog exposes only managed Delta (no `table_type` or `delta.universalFormat.enabledFormats` property).

**Azure-first / OSS build.** Pure-additive change to the already-real `CREATE TABLE` statement builder in `lib/editors/databricks/uc-dialogs.tsx` (same file as Clean Rooms): add a **"Table format"** dropdown — Delta (default) / **Delta + UniForm-Iceberg** (adds `TBLPROPERTIES('delta.universalFormat.enabledFormats'='iceberg')` via the existing `executeStatement` path) / **Managed Iceberg**. Surface **deletion-vector** and **row-lineage** as checkboxes (`TBLPROPERTIES delta.enableDeletionVectors` / `delta.enableRowTracking`). No new infra, no new client. Catalog: dialog enhancement. Gov: SQL over the bound warehouse.

**Acceptance criteria.** Create a table with UniForm-Iceberg enabled; receipt = the `CREATE TABLE … TBLPROPERTIES(...)` execution response and `DESCRIBE EXTENDED` showing the Iceberg format + deletion-vectors/row-lineage properties set.

---

## 12 — Lakeflow Connect sink = Databricks UC managed table — P3, M

**Capability.** Managed ingestion connectors (SaaS/DB CDC) with automatic UC lineage, landing into a Databricks-hosted UC catalog.

**Source-product grounding.** Lakeflow Connect — `https://docs.databricks.com/en/ingestion/lakeflow-connect/index.html`.

**Current Loom state — MISSING (but largely covered by an Azure-native default).** `grep "lakeflow connect"` = zero hits. Loom's `mirrored-database` item + `mirror-engine.ts` (ADF CDC → ADLS Bronze Delta, sources: Azure SQL / SQL Server / Snowflake / Cosmos / Postgres per `databases.md` T19) is the correct Azure-native default connector story and already delivers full parity value.

**Azure-first / OSS build.** No new Databricks-specific ingestion path needed **unless** the target is specifically a Databricks-hosted UC catalog. In that case add a **`sink = Databricks UC managed table`** option to the existing mirror-source wizard (`databases.md` T19) that, instead of landing Bronze Delta in Loom-owned ADLS, writes via `createTable`/`COPY INTO` against the bound Databricks warehouse. Low priority — the ADLS-Bronze default already gives parity. Catalog: wizard option on the existing item. Bicep: none. Gov: mirroring is unavailable in sovereign clouds for Fabric/Databricks — the ADLS-Bronze default remains the *only* Gov path, so this item is Commercial-oriented.

**Acceptance criteria.** With a Databricks target selected, run the mirror wizard against an Azure SQL source; receipt = a UC managed table populated via `COPY INTO` with real rows and lineage recorded.

---

## 13 — Catalog Federation (cross-account/region/cloud) — P3, M

**Capability.** UC Catalog Federation across accounts/regions/clouds with zero-copy federated read + Automatic Identity Management.

**Source-product grounding.** UC Catalog Federation — `https://docs.databricks.com/en/query-federation/index.html` (DAIS 2026 multi-account/multi-cloud).

**Current Loom state — MISSING.** `createUcCatalog` (`databricks-client.ts:1567-1589`) supports `MANAGED_CATALOG` / `FOREIGN_CATALOG` (single-account UC-to-external-DB federation) and `DELTASHARING_CATALOG`, but no cross-metastore / cross-account federation.

**Azure-first / OSS build.** Narrow, account-plane feature (needs a second UC metastore + account-level federation config) — lowest priority. If pursued: add a federated-catalog registration call to `unity-catalog-account-client.ts` (the account-plane client already used for metastore ops), surfaced as an **admin-only wizard step** beside the existing metastore-assignment UI. Until Databricks documents a stable GA REST contract, keep this as an **honest-gate** ("cross-account catalog federation requires a Databricks account-admin API not yet stabilized") rather than building against a moving preview surface. Catalog: admin wizard. Bicep: none. Gov: admin-plane, both suffixes.

**Acceptance criteria.** Either a real federated-catalog registration response against a second metastore, or (until GA) an honest-gate MessageBar naming the exact account-admin prerequisite — no stub that pretends to federate.

---

## 14 — Feature Store + Online Tables — P3, L

**Capability.** Offline feature engineering tied to Delta/Lakehouse tables, materialized to a low-latency online store for real-time model-serving lookups.

**Source-product grounding.** Databricks Feature Store / Online Tables — `https://docs.databricks.com/en/machine-learning/feature-store/index.html` (repo's own `docs/migrations/databricks-to-fabric/feature-mapping-complete.md` row #48 marks it **Preview** as of April 2026).

**Current Loom state — MISSING.** `grep -rn "feature-store|online-table" lib/catalog` = zero hits. `ml-model`/`ml-experiment`/`aml-automl-client.ts` cover training + registry + AutoML but nothing materializes engineered features into a low-latency lookup store.

**Azure-first / OSS build.** Lowest priority — even Databricks'/Fabric's own Feature Store is Preview-grade per the loaded migration doc. If pursued: new item `feature-store` backed by **(a)** offline features = Delta tables in ADLS via the existing `synapse-sql-client`/`delta-rs` pattern (notebook Datastore explorer), **(b)** online serving = **Azure Cosmos DB** (already a first-class Loom backend, `azure-cosmos-account` item) as the low-latency key-value online table, with a BFF route materializing a feature view's latest values into a Cosmos container on a schedule (reuse the AML Job schedule client from the data-science PRP TASK14). `ml-model`'s online-endpoint deploy path accepts an optional `featureStoreLookup` config injecting a Cosmos read before scoring. Catalog: new item. Bicep: Cosmos container via `createIfNotExists`; scheduled materialization via existing AML/Job scheduler. Gov: Cosmos + ADLS both GA in Gov.

**Acceptance criteria.** Define a feature view over a Delta table, schedule materialization to Cosmos (real container write receipt), and score an `ml-model` online endpoint that joins the online feature at request time (real inference response including the looked-up feature).

---

## Cross-cutting notes

- **One foundation, three payoffs:** items #1 (Loom App Runtime), #2 (custom agents), and #9 (publish-as-MCP) all reuse the proven `mcp-deploy-client.ts` + `container-apps-arm-client.ts` ACA pattern. Build #1 first; #2 and #9 are thin riders. This is why #1 is P0/XL and the rest are M/L.
- **Ship #3 + #7 together** — streaming tables and materialized views are DLT-backed and share the pipeline/job scheduling REST.
- **Ship #5 after #6** — the Data Agent metric-view grounding delta depends on Metric Views existing.
- **Every item is dual-path:** the Databricks REST path is opt-in (drives the customer's real first-party workspace, which is *allowed* — it is Azure-native, not Fabric); the default path is a Loom-owned Azure/OSS backend so the capability works with **zero** Databricks dependency, Commercial and Government alike.
- **Verification per merge (`no-vaporware.md`):** each item's PR must attach a real-backend receipt (endpoint hit + first-300-char response + Playwright screenshot/trace + any bicep diff), demonstrated on the **Azure-native default path** (Databricks unbound) where one exists.
