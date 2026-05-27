# Loom Databricks Notebook Editor — Parity build spec

> Reference: Azure Databricks workspace UI (`adb-<id>.azuredatabricks.net/workspace`). Distinct from the **Fabric** notebook (separate spec at `notebook-parity-spec.md`). A Databricks notebook lives in the Workspace tree, runs on a Databricks cluster (not Spark Livy pools), and is the unit of work behind every Databricks job.

## Why this exists

Loom already ships a wired-up Databricks Notebook editor (`DatabricksNotebookEditor` in `lib/editors/databricks-editors.tsx`). Today it can browse the workspace tree via `/api/2.0/workspace/list`, open a notebook via `/api/2.0/workspace/export`, save via `/api/2.0/workspace/import`, dispatch a one-time run via `/api/2.1/jobs/runs/submit`, and poll `/api/2.1/jobs/runs/get` for status. That's **A-grade** — it touches real Databricks, no mocks. The polish gaps below are about cell-level UX and Databricks-specific niceties (dbutils widgets, `%magic` commands, viz outputs).

## Databricks notebook UX inventory (Workspace UI)

### Page chrome (top → bottom)

| Region | Elements |
|---|---|
| **Title bar** | Notebook name (editable) · Workspace path breadcrumb · Last-saved indicator · Star/favorite |
| **Right-side global** | Search · Settings (gear) · Help · Account picker · Workspace switcher |
| **Notebook menu strip** | `File` · `Edit` · `View` · `Run` · `Help` (classic menu bar, not ribbon) |
| **Toolbar** | Default-language picker (Python/SQL/Scala/R) · Schedule · Share · Permissions · Comments · Revision history · Run all · Run all below · **Cluster selector** (compute) · **Connect/Disconnect** |

### Status bar (bottom)

| Item | Shows |
|---|---|
| Cluster state | Pending / Running / Terminated chip |
| Last command | Cell-N · ran in Ns · `<status>` |
| Auto-save | Saved <timestamp> |
| Comments | Count + jump-to |

### Left side panel — Workspace browser

| Element | Purpose |
|---|---|
| **Workspace** tree | `/Workspace`, `/Repos`, `/Shared`, `/Users/<upn>` |
| **Recents** | Recently opened notebooks |
| **Data** | Unity Catalog browser (catalogs → schemas → tables) |
| **Compute** | List of attached clusters / SQL warehouses |
| **Workflows** | Jobs that include this notebook as a task |

### Cell-level UX (per-cell)

1. **Language selector** (top-right of cell) — overrides notebook default
2. **Cell-actions menu** — Cut · Copy · Delete · Move up/down · Hide code / hide result · Run · Run all above / below
3. **Genie Code button** — inline AI prompt
4. **Cell focus** (maximize)
5. **Run cell** (▷) — left-edge, hover-visible
6. **Execution badge** — `Cmd N · Ns · <user>`
7. **Output area** — text, tables, charts, MLflow plots, image preview. Toggle Table view ↔ Chart view
8. **Insert cell** buttons (`+ Code` / `+ Text`) — between cells, hover-visible
9. **Comments thread** — pinned to cell

### Cell types & languages

- **Code** — Python (default), SQL, Scala, R. Mixed-language via `%python` `%sql` `%scala` `%r` line magics
- **Markdown** — `%md` (rendered)
- **Auxiliary magics**: `%fs` (dbutils.fs), `%sh` (driver shell), `%pip` / `%uv pip` (notebook-scoped libs), `%run /path` (chain another notebook), `%tensorboard`, `%skip`, `%%profile`, `%%oprofile`, `%set_cell_max_output_size_in_mb`

### dbutils surface

- `dbutils.fs` — DBFS / Unity Catalog Volumes ops
- `dbutils.widgets` — `.text`, `.dropdown`, `.combobox`, `.multiselect`, `.removeAll` (parameterise the notebook; widget bar renders at the top of the notebook)
- `dbutils.secrets` — fetch from secret scopes
- `dbutils.notebook` — `.run(path, timeout, args)`, `.exit(value)`
- `dbutils.jobs.taskValues` — pass values between job tasks

### Schedule / Workflow integration

- **Schedule** button → opens "Schedule" dialog (cron, timezone, pause). Creates a Lakeflow Job behind the scenes.
- **Share** → ACL editor (user/group/SP → Can Read / Run / Edit / Manage).
- **Revision history** → side panel listing every auto-save snapshot.

---

## What Loom has today (wired)

| Capability | Backend | UI |
|---|---|---|
| List workspace tree | `/api/items/databricks-notebook/list` → `listWorkspace()` → `/api/2.0/workspace/list` | Left panel tree, lazy-expand on click |
| Open notebook source | `/api/items/databricks-notebook/[id]?path=` → `getNotebook()` → `/api/2.0/workspace/export` | Textarea editor (single body) |
| Save notebook | `PUT /api/items/databricks-notebook/[id]` → `importNotebook()` → `/api/2.0/workspace/import` | Save button |
| Pick run cluster | `/api/items/databricks-cluster` → `listClusters()` | Dropdown in toolbar |
| Run on cluster | `POST /api/items/databricks-notebook/[id]/run` → `/api/2.1/jobs/runs/submit` with `existing_cluster_id` | Run button |
| Poll active run | `/api/items/databricks-notebook/[id]/runs?runId=` → `getJobRun()` + `getRunOutput()` | 3s poll, badge + pre-formatted output |
| List recent runs | `/api/items/databricks-notebook/[id]/runs` → `listJobRuns()` | Table at bottom |
| Language selector | UI only (PYTHON / SQL / SCALA / R) — persisted on save | Dropdown |

Status: **A-grade**. End-to-end real Databricks. No mocks.

## Gaps for parity (polish)

1. **Cell-based editor** — current UI is a single textarea showing the entire notebook source. Databricks notebooks are cell-segmented (`# COMMAND ----------` is the persisted delimiter in SOURCE format). Parse on load, render each cell with Monaco + per-cell Run.
2. **Per-cell run** — `dbutils.notebook.run` over Databricks Connect or per-cell statement execution against the cluster's REPL. Simpler path: use the new `/api/2.0/command-execution` endpoint (Execution Context API) for cell-scoped runs.
3. **dbutils widgets bar** — parse `dbutils.widgets.*` calls and render a widget bar above the notebook; pass values as `notebook_params` on Run.
4. **Output renderers** — current pre-formatted text dump. Add: table-of-records renderer (Spark DataFrame.toJson output), chart toggle, error traceback formatter, image embed for `display(plt)`.
5. **`%magic` line awareness** — syntax-highlight `%python` / `%sql` / `%md` / `%pip` lines distinctly; render `%md` cells as Markdown.
6. **Schedule dialog** — surface a "Schedule" button that creates a Job (single-task) with this notebook + cron. Wire to existing `createJob()` in `databricks-client.ts`.
7. **Revision history** — `/api/2.0/workspace/get-status` returns `modified_at`; add a drawer listing the import history. (Databricks doesn't expose per-cell diff via REST without Git; best-effort = show last-modified timestamps.)
8. **Permissions** — `/api/2.0/permissions/notebooks/<id>` GET + PATCH. Add a Share button → ACL editor.
9. **Workspace path breadcrumb** — current title is just the path; replace with clickable breadcrumb that re-roots the tree.
10. **Connect/Disconnect cluster state** — show running cluster state as a chip; if the picked cluster is TERMINATED, surface a Start button (reuse `databricksClusterEditor` logic).

## Backend mapping

- Tree: `GET /api/2.0/workspace/list?path=` (wired)
- Read: `GET /api/2.0/workspace/export?path=&format=SOURCE&direct_download=false` (wired)
- Write: `POST /api/2.0/workspace/import` body `{ path, format: SOURCE, language, content: base64, overwrite }` (wired)
- Delete: `POST /api/2.0/workspace/delete` (in client, not yet exposed)
- Run: `POST /api/2.1/jobs/runs/submit` body `{ tasks:[{ existing_cluster_id, notebook_task:{ notebook_path, base_parameters } }] }` (wired)
- Poll: `GET /api/2.1/jobs/runs/get?run_id=` (wired) + `GET /api/2.1/jobs/runs/get-output?run_id=` (wired)
- **NEW for per-cell**: `POST /api/1.2/contexts/create` → `POST /api/1.2/commands/execute` → `GET /api/1.2/commands/status` (Execution Context API)
- **NEW for ACL**: `GET /api/2.0/permissions/notebooks/<object_id>` · `PATCH` same path
- **NEW for schedule**: `POST /api/2.1/jobs/create` (already in `databricks-client.ts` as `createJob`)

## Required Azure resources

- **Azure Databricks workspace** (existing — `LOOM_DATABRICKS_HOSTNAME`)
- **UAMI as workspace user/admin** via SCIM bootstrap (existing — Container App MI is already provisioned as Workspace user; see `scripts/csa-loom/databricks-bootstrap.sh`)
- **Cluster** (any all-purpose; reuses cluster editor's list)
- No new Bicep needed for polish gaps; everything runs against the existing workspace.

## Estimated effort

| Gap | Hours |
|---|---|
| Cell parser + cell-segmented editor (Monaco per cell) | 4 |
| Per-cell run via Execution Context API | 3 |
| Widget bar (parse + render) | 2 |
| Output renderers (table / chart / image / traceback) | 4 |
| Magic-line syntax highlight + `%md` render | 2 |
| Schedule dialog (calls existing `createJob`) | 1.5 |
| Permissions panel | 1.5 |
| Breadcrumb + cluster chip polish | 1 |
| **Total** | **~19 hrs** (3 focused sessions) |
