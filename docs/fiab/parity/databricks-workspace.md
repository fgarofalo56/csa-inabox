# databricks-workspace — parity with the Azure Databricks workspace UI

> Brutally-honest 1:1 parity audit (regenerated 2026-05-31). Grading per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`. Graded
> conservatively; when in doubt, graded DOWN. This is the **consolidated** audit
> across the entire Loom Databricks surface (navigator + 4 editors + UC), not
> just the navigator. Per-object detail also lives in `databricks-cluster.md`,
> `databricks-job.md`, `databricks-notebook.md`, `databricks-sql-warehouse.md`.
>
> (An earlier version of this file scoped only the navigator and labelled the
> editor-level gaps "deferred." That under-counted the whole-service parity bar
> in `ui-parity.md`; this version counts them honestly.)

**Source UI (grounded in Microsoft Learn, not memory):**
- Workspace / sidebar concepts — https://learn.microsoft.com/azure/databricks/getting-started/concepts
- Compute (clusters) create/config — https://learn.microsoft.com/azure/databricks/compute/configure , https://learn.microsoft.com/azure/databricks/compute/simple-form
- Compute policies — https://learn.microsoft.com/azure/databricks/admin/clusters/policies
- Lakeflow Jobs UI — https://learn.microsoft.com/azure/databricks/jobs/configure-job , /configure-task , /repair-job-failures , /monitor
- SQL warehouses + SQL editor — https://learn.microsoft.com/azure/databricks/compute/sql-warehouse/create , https://learn.microsoft.com/azure/databricks/query/
- Unity Catalog / Catalog Explorer — https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/ , https://learn.microsoft.com/azure/databricks/catalogs/create-catalog
- Git folders (Repos) — https://learn.microsoft.com/azure/databricks/repos/

**Loom surface:**
- Navigator: `apps/fiab-console/lib/components/databricks/databricks-workspace-tree.tsx`
- Editors: `apps/fiab-console/lib/editors/databricks-editors.tsx` (SQL Warehouse, Notebook, Job, Cluster) + `mirrored-databricks-editor.tsx`
- REST client (real, AAD-token, no mocks): `apps/fiab-console/lib/azure/databricks-client.ts`
- Workspace-level BFF: `apps/fiab-console/app/api/databricks/{jobs,notebooks,clusters,warehouses,repos,catalogs,workspace}/route.ts`
- Item-level BFF: `apps/fiab-console/app/api/items/databricks-{cluster,job,notebook,sql-warehouse}/**`
- Registry: `apps/fiab-console/lib/editors/registry.ts` (all 4 wired); contract tests in `lib/editors/__tests__/databricks-*.test.tsx`

**Backend reality check.** `databricks-client.ts` acquires a real AAD token
(`DBX_SCOPE = 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default`, UAMI via
`ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
DefaultAzureCredential)`) and calls the real Databricks REST surface: Clusters
2.0, Jobs 2.1, SQL Warehouses 2.0, SQL Statements 2.0, Workspace 2.0, Command
Execution 1.2, Unity Catalog 2.1, Repos 2.0. **No `return []`, no `MOCK_`, no
`useState(SAMPLE)` anywhere in the Databricks surface.** Honest 503 /
`code:'not_configured'` gate keyed on `LOOM_DATABRICKS_HOSTNAME`. This is a
genuine functional surface, not a scaffold.

---

## Azure feature inventory → Loom coverage → backend

Legend: built ✅ (full 1:1 + real backend) · partial ⚠️ (exists, incomplete/rough)
· gated ⚠️ (honest infra-gate only) · MISSING ❌

### A. Workspace navigator (Azure left sidebar collapsed into one tree)

| # | Azure capability | Loom | Where / backend |
|---|---|---|---|
| A1 | Typed object groups with live counts + filter | ✅ built | `databricks-workspace-tree.tsx`; counts from real list calls |
| A2 | "+ Add new" menu (Job/Notebook/Cluster/Warehouse/Repo) | ✅ built | menu → create dialogs / editor |
| A3 | Jobs group: list, run-now, open, delete | ✅ built | `/api/databricks/jobs` → Jobs 2.1 |
| A4 | Notebooks/workspace files: list, create, delete | ⚠️ partial | `/api/databricks/notebooks` lists `/Workspace` root only in *this* tree (no nested expand here; the Notebook editor's own tree does nested) |
| A5 | Clusters: list, create, start, terminate, delete | ✅ built | `/api/databricks/clusters` → Clusters 2.0 |
| A6 | SQL Warehouses: list, create, start, stop, delete | ✅ built | `/api/databricks/warehouses` → SQL Warehouses 2.0 |
| A7 | Repos (Git folders): list, create, delete | ✅ built | `/api/databricks/repos` → Repos 2.0 |
| A8 | Unity Catalog: list catalogs (read-only) | ⚠️ partial | `/api/databricks/catalogs` → UC 2.1; list only, no drill/grant here |
| A9 | DLT / Lakeflow pipelines | ⚠️ gated | honest "Not yet wired" row naming `/api/2.0/pipelines` |
| A10 | MLflow experiments & registered models | ⚠️ gated | honest "Not yet wired" row |
| A11 | Dashboards / Queries / Alerts (Databricks SQL authoring) | ⚠️ gated | honest "Not yet wired" row |
| A12 | Model serving endpoints | ⚠️ gated | honest "Not yet wired" row |

### B. Compute / Clusters editor (Azure "Compute → Create compute" + cluster detail)

| # | Azure capability | Loom | Where / backend |
|---|---|---|---|
| B1 | List clusters with state + node type | ✅ built | `DatabricksClusterEditor`; `/api/items/databricks-cluster` → Clusters 2.0 |
| B2 | Create cluster (name, node type, runtime, autoscale min/max OR fixed workers, autotermination) | ✅ built | POST → `createCluster` |
| B3 | Node type + runtime dropdowns from real catalog | ✅ built | `/databricks-cluster/options` → `listNodeTypes`+`listSparkVersions` |
| B4 | Start / Stop / Restart | ✅ built | `/[id]/state` → start/terminate/restart |
| B5 | Permanent delete | ✅ built | `/[id]?permanent=true` → `permanentDeleteCluster` |
| B6 | View Spark config (read) | ✅ built | config tab reads `spark_conf` from `clusters/get` |
| B7 | View installed Libraries (status) | ⚠️ partial | read-only tab via `/api/2.0/libraries/cluster-status`; **install/uninstall MISSING** |
| B8 | View Init scripts | ⚠️ partial | read-only tab from `clusters/get`; **add/edit/reorder MISSING** |
| B9 | Cluster events / event log | ✅ built | events tab → `/api/2.0/clusters/events` |
| B10 | **Edit existing cluster spec** (resize, change node/runtime, autoterm) | ❌ MISSING | editor hard-codes "edit not exposed… recreate to change spec" (~L2838); fields disabled when a cluster is selected. `editCluster()` exists in client, **unwired** |
| B11 | Access mode (Standard/Dedicated / `data_security_mode`) | ❌ MISSING | not in create form; UC-compliance access mode can't be chosen |
| B12 | Compute **policy** selection | ❌ MISSING | Azure simple-form *leads* with Policy; absent |
| B13 | Spot instances / on-demand mix | ❌ MISSING | not in form |
| B14 | Single-node toggle / driver type | ❌ MISSING | not in form |
| B15 | Custom tags on cluster | ❌ MISSING | `custom_tags` in client type, not in form |
| B16 | Advanced: local-disk encryption, log delivery, SSH, env vars, Docker image | ❌ MISSING | none surfaced |
| B17 | Cluster permissions (ACL modal) | ❌ MISSING | not present |
| B18 | Instance pools | ❌ MISSING | not present |
| B19 | Metrics / Spark UI / driver-log deep links | ❌ MISSING | not present |

### C. Lakeflow Jobs editor (Azure "Jobs & Pipelines")

| # | Azure capability | Loom | Where / backend |
|---|---|---|---|
| C1 | List jobs (name, creator) | ✅ built | `DatabricksJobEditor`; `/api/items/databricks-job` → Jobs 2.1 |
| C2 | Create / Save (reset) / Delete job | ✅ built | POST/PUT/DELETE → create/reset/delete |
| C3 | Multi-task DAG, all task types (notebook, python script, wheel, JAR, spark-submit, SQL, dbt, pipeline, run-job) | ✅ built | full form ↔ spec round-trip (`taskToSpec`/`specToTask`) |
| C4 | depends_on + run_if (ALL_SUCCESS … ALL_FAILED) | ✅ built | per-task toggles + run_if dropdown |
| C5 | Compute per task: existing cluster OR new job cluster (runtime/node/workers) | ✅ built | `new_cluster` from real options |
| C6 | Per-task retries, min-retry-interval, timeout | ✅ built | form → spec |
| C7 | Visual task graph (DAG view) | ✅ built | `PipelineDagView` |
| C8 | Schedule/trigger: none / cron (quartz+tz+pause) / continuous / file-arrival | ✅ built | schedule tab → `schedule`/`continuous`/`trigger` |
| C9 | Job settings: max concurrent, timeout, tags, job_parameters, email on failure/success | ✅ built | settings tab → spec |
| C10 | Run now (with job_parameters defaults) | ✅ built | `/[id]/run` → run-now |
| C11 | Run history (state, start, exec, creator) | ✅ built | `/[id]/runs` → runs/list |
| C12 | Run output viewer (notebook output, logs, error trace) | ✅ built | `/[id]/run-output` → runs/get-output |
| C13 | View JSON (live create/reset payload) | ✅ built | JSON tab (Monaco read-only) |
| C14 | **Repair run** (re-run failed/skipped subset) | ❌ MISSING | first-class Lakeflow feature (`jobs/repairrun`); not wired |
| C15 | **Run now with different parameters** dialog | ⚠️ partial | only sends saved job_parameters; no per-run override dialog |
| C16 | Notifications beyond email (Slack / webhooks / system destinations) | ❌ MISSING | only `email_notifications` |
| C17 | Duration thresholds / health rules | ❌ MISSING | not surfaced |
| C18 | Git source for job tasks | ❌ MISSING | `git_source` not editable |
| C19 | Job permissions / ACLs | ❌ MISSING | not present |
| C20 | Matrix/Gantt run view, task-run drill-in, Genie "Diagnose error" | ❌ MISSING | flat run table only |
| C21 | Switch to code version (YAML/bundle) | ❌ MISSING | JSON view only |

### D. Notebook editor (Azure notebook surface)

| # | Azure capability | Loom | Where / backend |
|---|---|---|---|
| D1 | Workspace tree: browse/expand (nested), open, new, delete | ✅ built | `DatabricksNotebookEditor`; `/list`, `/[id]` PUT/DELETE → Workspace 2.0 |
| D2 | Open notebook → cells (export SOURCE, parse) | ✅ built | `/[id]?path=` → workspace/export; `parseSource` |
| D3 | Save notebook (serialize cells → import SOURCE) | ✅ built | `/[id]` PUT → workspace/import |
| D4 | Cell authoring: add code/markdown, reorder, delete, duplicate; per-cell language | ✅ built | `CodeCell`/`MarkdownCell`/`CellAdder` + Monaco |
| D5 | Attach cluster + live state badge | ✅ built | cluster dropdown from real list |
| D6 | Run cell / Run all (real REPL, stop-on-error) | ✅ built | `/[id]/command` → Command Execution 1.2, persisted contextId |
| D7 | Cell output: text / table / image / error | ✅ built | `DbxCellOutput` |
| D8 | Runs history | ✅ built | `/[id]/runs` → runs/list |
| D9 | Markdown render | ✅ built | `MarkdownCell` |
| D10 | Schedule notebook as job (inline one-click) | ⚠️ partial | done via Job editor, not a "Schedule" button on the notebook |
| D11 | Notebook **revision history / version compare** | ❌ MISSING | no revision timeline |
| D12 | Comments / co-presence / real-time co-edit | ❌ MISSING | single-user |
| D13 | Variable explorer / data profile / built-in viz builder | ❌ MISSING | raw table/text/image only |
| D14 | Notebook-level Git status / commit | ❌ MISSING | not present |
| D15 | %run / dbutils.notebook.run cross-notebook | ❌ MISSING | per-cell REPL only |

### E. SQL Warehouse / SQL editor (Azure Databricks SQL)

| # | Azure capability | Loom | Where / backend |
|---|---|---|---|
| E1 | List warehouses + state | ✅ built | `DatabricksSqlWarehouseEditor`; `/warehouses` → SQL Warehouses 2.0 |
| E2 | Start / Stop warehouse (with poll) | ✅ built | `/start`, `/state` POST |
| E3 | Unity Catalog browse: catalogs → schemas → tables (lazy) | ✅ built | `/schema` → SHOW CATALOGS/SCHEMAS/TABLES via Statement exec |
| E4 | SQL editor (Monaco) + Run + results grid | ✅ built | `/query` → Statements 2.0 with polling |
| E5 | Click table → templated SELECT | ✅ built | tree click inserts SELECT |
| E6 | Query history (paginated) | ✅ built | `/query-history` → history/queries |
| E7 | Result count / exec ms / truncated badge | ✅ built | `ResultsPanel` |
| E8 | **Create warehouse** from this editor | ⚠️ partial | navigator + portal create it; editor says "create in portal" |
| E9 | **Edit/scale warehouse** (size, min/max clusters, auto-stop, type, serverless) | ❌ MISSING | `editWarehouse()` in client, **no editor UI calls it** |
| E10 | Warehouse **monitoring** (running clusters, query queue, peak) | ❌ MISSING | state badge only |
| E11 | Saved **Queries** / **Dashboards** / **Alerts** objects | ❌ MISSING | ad-hoc SQL only |
| E12 | Warehouse permissions / channel (preview/current) / tags | ❌ MISSING | not present |
| E13 | Visualizations / download results (CSV) | ❌ MISSING | grid only |

### F. Unity Catalog / Catalog Explorer (governance)

| # | Azure capability | Loom | Where / backend |
|---|---|---|---|
| F1 | List catalogs | ✅ built | navigator + `/api/databricks/catalogs` → UC 2.1 |
| F2 | Browse schemas/tables (SQL editor via SHOW) | ✅ built | SQL editor tree (E3) |
| F3 | Mirrored Databricks catalog object | ⚠️ partial | `mirrored-databricks-editor.tsx` + `/api/items/mirrored-databricks/[id]/catalog` |
| F4 | **Create catalog / schema / table / volume** | ❌ MISSING | read-only; create lives in portal (metastore-admin) |
| F5 | **Grant/revoke privileges**, ownership, workspace bindings | ❌ MISSING | no UC permissions UI |
| F6 | Tags / comments on securables | ❌ MISSING | not present |
| F7 | Data **lineage**, sample data, column details, history | ❌ MISSING | not present |
| F8 | External locations, storage credentials, connections, Delta Sharing shares | ❌ MISSING | not present |

### G. Repos / Git folders

| # | Azure capability | Loom | Where / backend |
|---|---|---|---|
| G1 | List / create (link remote + provider) / delete Git folder | ✅ built | navigator → `/api/databricks/repos` → Repos 2.0 |
| G2 | **Checkout branch/tag, pull, diff/commit history** | ❌ MISSING | client `update`(checkout) unused; no branch UI |
| G3 | Git credential management (linked accounts) | ❌ MISSING | disclosed in dialog text only; not actionable |

### H. Workspace-level / admin surfaces

| # | Azure capability | Loom | Where / backend |
|---|---|---|---|
| H1 | Honest "which workspace" disclosure + infra gate | ✅ built | `/api/databricks/workspace`; MessageBar names `LOOM_DATABRICKS_HOSTNAME` |
| H2 | Compute **Policies** tab | ❌ MISSING | not present |
| H3 | Instance **Pools** tab | ❌ MISSING | not present |
| H4 | **DLT / Lakeflow Pipelines** editor | ⚠️ gated | navigator gate row only; no editor |
| H5 | **MLflow** experiments/models, **Model serving** | ⚠️ gated | navigator gate rows only |
| H6 | Databricks **SQL** Dashboards/Queries/Alerts/Genie | ⚠️ gated | navigator gate row only |
| H7 | Admin settings / SCIM / secrets / workspace settings | ❌ MISSING | SCIM handled at bicep bootstrap, not UI |
| H8 | Marketplace / Partner Connect / Lakeflow Connect ingestion | ❌ MISSING | not present |

---

## Coverage tally

- **built ✅: 41**
- **partial ⚠️: 9**
- **gated ⚠️ (honest infra-gate): 5**
- **MISSING ❌: 33**

## Honest grade: **B−**

The four shipped editors and the navigator are genuinely **production-grade**:
real AAD-authenticated Databricks REST across Clusters/Jobs/Warehouses/Workspace/
Command-Exec/UC/Repos, proper `{ok,data,error}` BFF contracts with honest
`not_configured` 503 gates, Fluent v9 + Loom theme, ribbons, Monaco, contract
tests present. **No vaporware** — nothing fake. The **Jobs editor (C)** and
**Notebook editor (D)** are A-/A-grade in isolation: near-complete 1:1 with the
Lakeflow Jobs UI and the Databricks notebook surface.

Held to **B−** (not A) by `ui-parity.md`'s "feature completeness must match" bar
applied to the whole Azure Databricks workspace:

1. **Cluster editor can't EDIT** (B10) — create / lifecycle / view only; can't
   change an existing cluster's spec. `editCluster()` exists in the client and is
   simply not wired. Highest-value, lowest-effort gap.
2. **No compute policy / access-mode / advanced options** (B11–B16) — the Azure
   simple-form *leads* with Policy and Access mode (the UC-compliance gate); absent.
3. **No SQL-warehouse edit/scale** (E9) — `editWarehouse()` exists, unwired.
4. **No job Repair-run** (C14) — first-class Lakeflow feature.
5. **Unity Catalog is read-only** (F4–F8) — no create/grant/lineage/external-locations.
6. Whole object classes absent or honest-gated: **DLT pipelines, MLflow, Model
   serving, Databricks SQL Dashboards/Queries/Alerts, Pools, Policies, Marketplace**.

Gated rows are *disclosed honestly* (per no-vaporware) so they don't drag the grade
below B; the genuinely-missing edit paths for resources that are otherwise managed
(cluster edit, warehouse scale, job repair) are what keep it under A.

## Highest-value gaps to build first

1. **Wire `editCluster()` into the Cluster editor** (B10) — un-disable fields on a
   selected cluster, PUT to a new edit route. Client fn already exists.
2. **Wire `editWarehouse()` scale UI** (E9) — size / min-max clusters / auto-stop /
   serverless. Client fn already exists.
3. **Cluster create: Policy + Access mode + tags + spot/single-node** (B11–B15).
4. **Job Repair-run** (C14) + run-with-different-parameters dialog (C15).
5. **Unity Catalog write**: create catalog/schema, GRANT/REVOKE, tags, lineage (F4–F7).
6. **DLT / Lakeflow Pipelines editor** (H4).
7. **Repos branch ops** (G2) — checkout/pull/diff; client `update` is unused.

## Backend per control (workspace-level navigator routes)

| Control | BFF route | client fn | Databricks endpoint |
|---------|-----------|-----------|---------------------|
| Jobs list | `/api/databricks/jobs` (GET) | `listJobs` | `GET /api/2.1/jobs/list` |
| Job create | `/api/databricks/jobs` (POST) | `createJob` | `POST /api/2.1/jobs/create` |
| Job run-now | `/api/databricks/jobs` (POST) | `runJob` | `POST /api/2.1/jobs/run-now` |
| Job delete | `/api/databricks/jobs` (DELETE) | `deleteJob` | `POST /api/2.1/jobs/delete` |
| Workspace list | `/api/databricks/notebooks` (GET) | `listWorkspace` | `GET /api/2.0/workspace/list` |
| Notebook import | `/api/databricks/notebooks` (POST) | `importNotebook` | `POST /api/2.0/workspace/import` |
| Folder mkdirs | `/api/databricks/notebooks` (POST) | `mkdirsWorkspace` | `POST /api/2.0/workspace/mkdirs` |
| Workspace delete | `/api/databricks/notebooks` (DELETE) | `deleteWorkspaceObject` | `POST /api/2.0/workspace/delete` |
| Clusters list | `/api/databricks/clusters` (GET) | `listClusters` | `GET /api/2.0/clusters/list` |
| Cluster create | `/api/databricks/clusters` (POST) | `createCluster` (+options) | `POST /api/2.0/clusters/create` |
| Cluster start/restart | `/api/databricks/clusters` (POST) | `startCluster`/`restartCluster` | `POST /api/2.0/clusters/{start,restart}` |
| Cluster terminate | `/api/databricks/clusters` (DELETE) | `terminateCluster` | `POST /api/2.0/clusters/delete` |
| Warehouses list | `/api/databricks/warehouses` (GET) | `listWarehouses` | `GET /api/2.0/sql/warehouses` |
| Warehouse create | `/api/databricks/warehouses` (POST) | `createWarehouse` | `POST /api/2.0/sql/warehouses` |
| Warehouse start/stop | `/api/databricks/warehouses` (POST) | `startWarehouse`/`stopWarehouse` | `POST /api/2.0/sql/warehouses/{id}/{start,stop}` |
| Warehouse delete | `/api/databricks/warehouses` (DELETE) | `deleteWarehouse` | `DELETE /api/2.0/sql/warehouses/{id}` |
| Repos list | `/api/databricks/repos` (GET) | `listRepos` | `GET /api/2.0/repos` (paginated) |
| Repo create | `/api/databricks/repos` (POST) | `createRepo` | `POST /api/2.0/repos` |
| Repo delete | `/api/databricks/repos` (DELETE) | `deleteRepo` | `DELETE /api/2.0/repos/{id}` |
| UC catalogs/schemas | `/api/databricks/catalogs` (GET) | `listUcCatalogs`/`listUcSchemas` | `GET /api/2.1/unity-catalog/{catalogs,schemas}` |
| SQL statement exec | `/api/items/databricks-sql-warehouse/[id]/query` | `executeStatement` | `POST /api/2.0/sql/statements` (+poll) |
| Schema browse (SHOW) | `/api/items/databricks-sql-warehouse/[id]/schema` | `executeStatement` | `POST /api/2.0/sql/statements` |
| Query history | `/api/items/databricks-sql-warehouse/[id]/query-history` | `listQueryHistory` | `GET /api/2.0/sql/history/queries` |
| Notebook cell run | `/api/items/databricks-notebook/[id]/command` | Command Exec | `POST /api/1.2/commands/execute` (+contexts) |
| Cluster options | `/api/items/databricks-cluster/options` | `listNodeTypes`/`listSparkVersions` | `GET /api/2.0/clusters/{list-node-types,spark-versions}` |
| Cluster libraries | `/api/items/databricks-cluster/[id]/libraries` | `listClusterLibraries` | `GET /api/2.0/libraries/cluster-status` |

## Bicep / env sync

- Env var consumed: **`LOOM_DATABRICKS_HOSTNAME`** (already consumed by all 4
  editors + the `/api/databricks/workspace` gate; no new bicep app-env entry).
- Role: the Loom UAMI must be a **workspace user/admin** (SCIM bootstrap) and hold
  **Contributor** on the workspace resource. Provisioned by
  `platform/fiab/bicep/modules/landing-zone/databricks*.bicep`.
- Cluster-create needs the `allow-cluster-create` SCIM entitlement — runbook:
  `docs/fiab/runbooks/databricks-cluster-create-permission.md` (the cluster editor
  surfaces a precise remediation message on the 403).
- No new Azure resource or Cosmos container.

## Verification

- All 4 editors registered in `lib/editors/registry.ts`; contract tests in
  `lib/editors/__tests__/databricks-*.test.tsx`.
- Per `no-vaporware.md`: every list/create/delete/lifecycle/exec call hits real
  Databricks REST; honest infra-gate renders when `LOOM_DATABRICKS_HOSTNAME` unset.
- Live `pnpm uat` side-by-side against the Databricks workspace UI: **pending**
  (no minted session / reachable workspace in this worktree). DOM strings ≠ parity
  per the no-scaffold rule — the MISSING/partial rows above were derived from code,
  not a live click-through, and should be confirmed against the live portal.
