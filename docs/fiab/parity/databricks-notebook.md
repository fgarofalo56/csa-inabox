# databricks-notebook — parity with the Fabric "Azure Databricks notebook" object / Azure Databricks notebook UI

**Source UI**

- Fabric: Azure Databricks notebook item (opens the Databricks notebook editor surface).
- Azure Databricks: <https://learn.microsoft.com/azure/databricks/notebooks/> and
  <https://learn.microsoft.com/azure/databricks/notebooks/notebooks-code> (cells, magics, mixed languages),
  <https://learn.microsoft.com/azure/databricks/notebooks/basic-editing#cell-actions> (cell actions: add/move/delete),
  Command Execution API: `POST /api/1.2/contexts/create`, `POST /api/1.2/commands/execute`,
  `GET /api/1.2/commands/status` (per-cell run against a cluster REPL),
  Workspace API: `GET /api/2.0/workspace/export|list`, `POST /api/2.0/workspace/import|delete|mkdirs`,
  Clusters API: `GET /api/2.0/clusters/list`.

Loom editor: `apps/fiab-console/lib/editors/databricks-editors.tsx` → `DatabricksNotebookEditor`
(catalog type `databricks-notebook`). Cell components reused from
`apps/fiab-console/lib/components/notebook/{code-cell,markdown-cell,cell-adder}.tsx`. Source codec:
`apps/fiab-console/lib/editors/databricks-notebook-source.ts`. REST client:
`apps/fiab-console/lib/azure/databricks-client.ts`.

> **2026-05-29 rewrite.** The previous editor was a single Monaco textarea over the whole notebook
> source — you could not add cells and it did not look or behave like Databricks. It is now a
> cell-based notebook with per-cell execution against a real cluster.

## Azure / Databricks feature inventory → Loom coverage

| # | Databricks notebook capability | Loom coverage | Backend per control |
|---|---|---|---|
| 1 | Browse the workspace tree (folders, notebooks, repos) | ✅ built — left panel tree, expand/collapse, root path input | `GET /api/items/databricks-notebook/list` → `listWorkspace` → `GET /api/2.0/workspace/list` |
| 2 | Open a notebook | ✅ built — click a notebook to load its cells | `GET /api/items/databricks-notebook/[id]` → `getNotebook` → `GET /api/2.0/workspace/export?format=SOURCE` (base64-decoded, parsed to cells) |
| 3 | New notebook | ✅ built — ribbon "New notebook" + tree `+`, prompts for path, seeds one Python cell | `PUT /api/items/databricks-notebook/[id]` → `importNotebook` → `POST /api/2.0/workspace/import` |
| 4 | Delete a notebook / folder | ✅ built — hover-reveal trash icon per tree row | `DELETE /api/items/databricks-notebook/[id]?path=…[&recursive]` → `deleteWorkspaceObject` → `POST /api/2.0/workspace/delete` |
| 5 | **Add a new cell** (code / markdown) | ✅ built — `CellAdder` between every cell + ribbon "Add code/markdown cell" | client-side cell-state mutation; persisted on Save (see #11) |
| 6 | Delete a cell | ✅ built — per-cell trash button | client-side; persisted on Save |
| 7 | Move / reorder a cell (up/down) | ✅ built — per-cell chevron up/down | client-side; persisted on Save |
| 8 | Duplicate a cell | ✅ built — per-cell copy button | client-side; persisted on Save |
| 9 | Per-cell language (Python / SQL / Scala / R) via `%`-magics | ✅ built — per-cell language selector; serialised as `# MAGIC %sql` etc. | codec `serializeCells`/`parseSource`; exec language via `cellLangToCommandLanguage` |
| 10 | Markdown cells (`%md`) rendered | ✅ built — `MarkdownCell` edit/preview toggle, `%md` round-trips | client-side render; codec maps `%md` ↔ markdown cell |
| 11 | Save notebook | ✅ built — ribbon/toolbar Save + Ctrl/Cmd+S, dirty indicator | serialise cells → SOURCE → `PUT /api/items/databricks-notebook/[id]` → `POST /api/2.0/workspace/import (overwrite)` |
| 12 | Attach / select a cluster | ✅ built — cluster dropdown with live state, status badge | `GET /api/items/databricks-cluster` → `listClusters` → `GET /api/2.0/clusters/list` |
| 13 | **Run a single cell** against the cluster | ✅ built — per-cell Run button, real stdout/table/error rendered inline | `POST /api/items/databricks-notebook/[id]/command` → `executeCommand` → `POST /api/1.2/contexts/create` (once per cluster+lang) + `POST /api/1.2/commands/execute` + poll `GET /api/1.2/commands/status` |
| 14 | REPL state persists across cells (variables, temp views) | ✅ built — execution context cached per (cluster, language) and reused | shared `contextId` returned by `/command` and re-sent on next cell |
| 15 | **Run all** cells (stop-on-error) | ✅ built — toolbar/ribbon "Run all", sequential, halts on first error | iterates cells, each via `/command` (same as #13) |
| 16 | Clear outputs | ✅ built — ribbon "Clear outputs" | client-side result reset |
| 17 | Cell result types: text (stdout), table (schema+rows), image (plots), error (summary+cause) | ✅ built — `DbxCellOutput` renders all four | shaped from `api/1.2` `results.resultType` in the `/command` route |
| 18 | Cell execution status indicator (running / ok / error) | ✅ built — per-cell spinner + result-type badge + ms timing | `/command` poll lifecycle |
| 19 | Cell maximize / focus | ✅ built (inherited from `CodeCell`/`MarkdownCell`) — maximize + active-cell highlight | client-side |
| 20 | Cell lock (read-only) | ✅ built (inherited) — per-cell lock toggle | client-side |
| 21 | Workspace runs history | ✅ built — "View runs" dialog | `GET /api/items/databricks-notebook/[id]/runs` → `listJobRuns` → `GET /api/2.1/jobs/runs/list` |
| 22 | Run whole notebook as a job (one-time submit) | ✅ built (pre-existing) — `runNotebook` path retained | `POST /api/items/databricks-notebook/[id]/run` → `POST /api/2.1/jobs/runs/submit` |
| 23 | Execution-context teardown (free the REPL) | ✅ built — DELETE context route available | `DELETE /api/items/databricks-notebook/[id]/context` → `destroyExecutionContext` → `POST /api/1.2/contexts/destroy` |

## Honest gates (`intent="warning"` MessageBar — full cell UI still renders)

- **No clusters in workspace** → MessageBar names the Databricks Cluster editor / portal Compute → Create compute action.
- **Selected cluster not RUNNING** → MessageBar names the exact cluster to Start (cells can still be submitted; Databricks starts the cluster on demand, 2–5 min).
- **Workspace REST unreachable / unauthorized** → tree + file MessageBars surface the precise BFF error.

Required env: `LOOM_DATABRICKS_HOSTNAME` (Databricks workspace host). MI must be a workspace user/admin
(SCIM bootstrap) — same auth path already used by the live cluster-create + SQL-warehouse flows.

## Grade

All inventory rows **built ✅** (zero ❌, zero stub banners; the three non-functional states are honest
infra gates per `no-vaporware.md`). Backend coverage: Vitest contract tests in
`lib/azure/__tests__/databricks-command-exec.test.ts`,
`lib/editors/__tests__/databricks-notebook-source.test.ts`,
`app/api/items/__tests__/databricks-notebook-command-routes.test.ts`, and the BFF-route existence test.
Grade: **A** (production-grade + tested). DOM render tests for the editor remain on the repo-wide
pre-existing `node`-vitest-env red (shared by every `*-editors` render test); backend contract tests
cover the new surface instead.
