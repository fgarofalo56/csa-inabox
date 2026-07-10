# notebook-databricks — parity with the Azure Databricks notebook

> R4 notebook-parity inventory (2026-07-10). Grading per `.claude/rules/ui-parity.md`
> + `.claude/rules/no-vaporware.md`. Graded conservatively; when in doubt, graded
> DOWN. This doc isolates the **Databricks-flavored** Loom notebook. Sibling docs:
> [`notebook-synapse.md`](notebook-synapse.md), [`notebook-loom.md`](notebook-loom.md).
>
> **Why this doc exists.** The Databricks flavor (`databricks/databricks-notebook-editor.tsx`)
> correctly reuses the shared `CodeCell`/`RichDisplay` stack, so it gets the display()
> Table⇄Chart viz builder and real per-cell run for free. But it is missing the
> Databricks-specific surfaces that make a Databricks notebook a Databricks notebook:
> **dbutils widgets**, **version/revision history + side-by-side diff**, **schedule-as-a-job**,
> the **variable explorer**, **comments**, **Repos/Git**, and notebook **parameters**. The
> in-editor helper text even promises "schedule the notebook as a job," but no schedule
> UI is wired — that is exactly the kind of gap R4 closes.

**Source UI (grounded in Microsoft Learn, not memory):**
- Databricks notebooks (overview): https://learn.microsoft.com/azure/databricks/notebooks/
- Develop code in notebooks (magics `%python/%r/%scala/%sql/%md/%pip/%sh/%fs/%run`): https://learn.microsoft.com/azure/databricks/notebooks/notebooks-code
- Basic editing (cells, side-by-side, shortcuts): https://learn.microsoft.com/azure/databricks/notebooks/basic-editing
- Notebook outputs and results (results table, sort/filter, download, clear state): https://learn.microsoft.com/azure/databricks/notebooks/notebook-outputs
- Visualizations in notebooks (viz builder, data profile): https://learn.microsoft.com/azure/databricks/visualizations/
- Databricks widgets (`dbutils.widgets`): https://learn.microsoft.com/azure/databricks/notebooks/widgets
- Version history in notebooks (restore/diff): https://learn.microsoft.com/azure/databricks/notebooks/notebook-version-history
- Schedule notebook as a job: https://learn.microsoft.com/azure/databricks/notebooks/schedule-notebook-jobs

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/databricks/databricks-notebook-editor.tsx`
  (`DatabricksNotebookEditor`) — reuses shared `CodeCell` / `MarkdownCell` /
  `CellAdder` / `RichDisplay`.
- Source round-trip: `apps/fiab-console/lib/editors/databricks-notebook-source.ts`
  (`parseSource` / `serializeCells` — `# COMMAND ----------` separators + `# MAGIC %md`).
- Workspace tree: `apps/fiab-console/lib/components/databricks/databricks-workspace-tree.tsx`.
- Result export: `apps/fiab-console/lib/editors/components/result-export.ts`.

**Backend reality check.** List/open/save/new/delete → `/api/items/databricks-notebook[/list|/<id>]`
(Databricks Workspace `export`/`import` REST). Cells run against a real attached
cluster via a per-`(cluster,language)` **execution context** (command execute + poll),
so REPL state persists across same-language cells. Clusters come from
`/api/items/databricks-cluster`; runs history from `/api/items/databricks-notebook/<id>/runs`
(Jobs `runs/list`). Results stream back into `RichDisplay`. No mocks. Azure-native —
this flavor targets a real Databricks workspace (`LOOM_DATABRICKS_*`), which is an
honest Azure-side infra gate, not a Fabric one.

---

## Databricks feature inventory → Loom coverage → backend

Legend: built ✅ · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Notebook management

| # | Databricks capability | Loom | Where / backend |
|---|---|---|---|
| A1 | Create notebook | ✅ built | New → `POST /api/items/databricks-notebook/<id>` (import) |
| A2 | Open notebook (workspace tree) | ✅ built | tree → export SOURCE → `parseSource` |
| A3 | Save (import SOURCE) | ✅ built | `serializeCells` → Workspace import |
| A4 | Delete notebook | ✅ built | `DELETE …/<id>?path=` |
| A5 | Hydrate cells from installed app bundle | ✅ built | `/api/cosmos-items/databricks-notebook/<id>` |
| A6 | Import/export (.dbc/.ipynb/.py SOURCE) | ⚠️ partial | SOURCE round-trip on save/open; no explicit import/export dialog |
| A7 | Move / clone / rename in workspace | ❌ MISSING | tree is open/new/delete only |
| A8 | **Repos / Git folders** integration | ❌ MISSING | no Git bind |

### B. Cells & editing (shared `CodeCell`)

| # | Databricks capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Code cell + markdown cell | ✅ built | `CodeCell` / `MarkdownCell` |
| B2 | Add / insert cell | ✅ built | `CellAdder` |
| B3 | Move / duplicate / delete cell | ✅ built | `CodeCell` toolbar |
| B4 | Default language + per-cell language | ✅ built | `baseLanguage` + `cellLangToCommandLanguage` |
| B5 | Language magics `%python/%r/%scala/%sql` | ✅ built | `# MAGIC` round-trip in SOURCE |
| B6 | Auxiliary magics `%md` | ✅ built | markdown cell ↔ `# MAGIC %md` |
| B7 | Auxiliary magics `%sh` / `%fs` / `%pip` / `%run` | ❌ MISSING | not parsed/executed as Databricks magics |
| B8 | Monaco IntelliSense / autocomplete | ✅ built | `CodeCell` Monaco + inline-completion |
| B9 | Lock cell / copy cell / convert-to-markdown | ✅ built | `CodeCell` toolbar |
| B10 | **Side-by-side** notebook (split view) | ❌ MISSING | single-pane |
| B11 | Multi-cursor / SQL-in-Python highlight | ⚠️ partial | Monaco baseline; not Databricks-specific SQL-in-python |
| B12 | Command/edit modal shortcut keys | ⚠️ partial | Monaco keys; no Databricks command-mode keymap |

### C. Run & compute

| # | Databricks capability | Loom | Where / backend |
|---|---|---|---|
| C1 | Run cell | ✅ built | command execute against exec context |
| C2 | Run all (stop-on-error) | ✅ built | `runAll` sequential |
| C3 | **Cluster attach dropdown** | ✅ built | `/api/items/databricks-cluster`; auto-selects a running cluster |
| C4 | Start a terminated cluster from the editor | ⚠️ partial | cluster state shown; start action is in the cluster editor |
| C5 | Per-`(cluster,language)` execution context (REPL persistence) | ✅ built | `ctxKey = clusterId:lang` |
| C6 | Serverless / SQL-warehouse compute option | ❌ MISSING | interactive clusters only |
| C7 | Cancel running cell | ⚠️ partial | run state tracked; explicit cancel not surfaced |
| C8 | **Clear state / clear outputs / clear-and-run-all** | ❌ MISSING | no clear-state menu |
| C9 | Run-status per cell (running/success/error + duration) | ✅ built | `CellResult` status |

### D. Outputs, results & visualization (shared `RichDisplay`)

| # | Databricks capability | Loom | Where / backend |
|---|---|---|---|
| D1 | `display()` tabular results table | ✅ built | `RichDisplay` Table view |
| D2 | Sort / select columns in results table | ✅ built | `RichDisplay` sortable + column select |
| D3 | **Viz builder** (bar/line/scatter/… + aggregation) | ✅ built | `RichDisplay` Charts view (bar/line/scatter/heatmap + agg) |
| D4 | Download results (CSV / JSON) | ✅ built | `downloadResultsCsv` / `downloadResultsJson` |
| D5 | Download to Excel | ❌ MISSING | CSV/JSON only |
| D6 | `displayHTML()` rich HTML output | ⚠️ partial | HTML handled by `RichDisplay`; not a first-class `displayHTML` path |
| D7 | **Data profile** (summary stats tab on a DataFrame) | ❌ MISSING | no profile tab |
| D8 | `%sql` cell results as `_sqldf` for next cell | ❌ MISSING | no implicit `_sqldf` chaining |
| D9 | Multiple outputs per cell | ⚠️ partial | primary output rendered; not multi-output |
| D10 | Resize output area | ⚠️ partial | maximize toggle; no drag-resize |

### E. Interactivity, parameters, scheduling

| # | Databricks capability | Loom | Where / backend |
|---|---|---|---|
| E1 | **Widgets** (`dbutils.widgets` text/dropdown/combobox/multiselect bar) | ❌ MISSING | no widgets bar |
| E2 | Notebook **parameters** (re-run with params) | ❌ MISSING | no params cell/panel |
| E3 | **Schedule as a job** (create/run/pause/view) | ❌ MISSING | helper text promises it; **no schedule UI wired** |
| E4 | **Runs history** (jobs runs list) | ✅ built | Runs dialog → `/api/items/databricks-notebook/<id>/runs` |
| E5 | Export a run result to HTML | ❌ MISSING | not surfaced |

### F. Versioning, collaboration, assist

| # | Databricks capability | Loom | Where / backend |
|---|---|---|---|
| F1 | **Version/revision history** (view/restore/delete versions) | ❌ MISSING | no version history panel |
| F2 | **Side-by-side diff** of versions | ❌ MISSING | none |
| F3 | **Comments** on cells | ❌ MISSING | none |
| F4 | Real-time **co-authoring** | ❌ MISSING | single-editor |
| F5 | **Variable explorer** | ❌ MISSING | `VariablesPane` exists but not wired |
| F6 | **Assistant / Genie Code** (generate/explain/fix) | ⚠️ partial | `SqlCopilotEditor` imported; notebook-wide Copilot not wired like the regular flavor |
| F7 | UC **lineage** panel | ✅ built | `UcLineagePanel` |

---

## Coverage tally

- **built ✅: 22**
- **partial ⚠️: 9**
- **honest-gate ⚠️: 1** (Databricks workspace gate `LOOM_DATABRICKS_*`)
- **MISSING ❌: 18**

## Honest grade: **C+**

The Databricks flavor is a **real** notebook against a real workspace: it exports/imports
SOURCE with correct `# COMMAND` / `# MAGIC` semantics, attaches real clusters, runs cells
through per-language execution contexts so REPL state persists, streams results into the
shared `RichDisplay` (table + chart viz + CSV/JSON download), lists real job runs, and
shows UC lineage. **No vaporware.**

Held below B by `ui-parity.md`. The Databricks-specific surfaces are the gap: **no
widgets bar**, **no version/revision history or diff**, **no schedule-as-a-job** (despite
the editor text promising it), **no variable explorer**, **no `%sql`→`_sqldf` chaining**,
**no data profile**, **no `%sh/%fs/%pip/%run` magics**, **no comments/co-authoring**, and
**no Repos/Git**. The variable explorer is especially low-cost because `VariablesPane`
already exists in the repo.

## R4 build list (the ❌ rows, prioritized)

- **R4-DBX-1 — Schedule-as-a-job (E3).** Wire a Schedule action that creates a
  Databricks **Job** (`jobs/create` with a notebook task + schedule), plus list/run/
  pause/delete. *Accept:* schedule the open notebook; the created job appears in Runs
  and fires on cadence — matching the editor's own promise text.
- **R4-DBX-2 — dbutils widgets bar (E1) + parameters (E2).** Render a widgets strip
  above the cells (text/dropdown/combobox/multiselect) fed by `dbutils.widgets` calls;
  pass values as job/run params. *Accept:* a `dbutils.widgets.dropdown(...)` cell
  renders an interactive control; changing it re-runs dependent cells with the value.
- **R4-DBX-3 — Version/revision history + diff (F1, F2).** A history panel listing
  saved versions with add-description / restore / delete, and a side-by-side color
  diff. *Accept:* save, edit, restore-previous returns exact prior content; diff shows
  changed lines.
- **R4-DBX-4 — Variable explorer (F5).** Mount `VariablesPane` + a toggle populated
  from the execution-context variable snapshot. *Accept:* defined vars list name/type/
  value after a run.
- **R4-DBX-5 — `%sql`→`_sqldf` chaining (D8) + `%sh/%fs/%pip/%run` magics (B7).**
  Assign SQL cell results to `_sqldf` usable in a following Python/SQL cell; execute the
  auxiliary magics with Databricks semantics. *Accept:* a `%sql` cell then a `%python`
  cell reading `_sqldf` works; `%pip install` and `%run` behave as documented.
- **R4-DBX-6 — Data profile tab (D7).** A "Data Profile" tab on a DataFrame result with
  summary stats/histograms (reuse `display-stats.ts`). *Accept:* profile shows per-column
  stats for a `display(df)` result.
- **R4-DBX-7 — Clear state / outputs menu (C8) + serverless/SQL-warehouse compute (C6).**
  A Run-menu with clear-outputs / clear-state / clear-and-run-all; allow selecting a SQL
  warehouse or serverless as the run target.
- **R4-DBX-8 — Notebook-wide Copilot/Assistant (F6).** Bring the regular flavor's docked
  `CopilotChatPane` (or the inline generate/explain/fix) into this editor for parity with
  Databricks Assistant/Genie. *Accept:* "Fix with Copilot" on a failed cell proposes a diff.
- **R4-DBX-9 — Side-by-side split (B10) + Databricks command-mode keymap (B12).**
- **R4-DBX-10 — Cell comments (F3), Excel download (D5), export-run-to-HTML (E5),
  Repos/Git (A8), workspace move/clone/rename (A7).** The long-tail collaboration and
  workspace-management affordances.

## Backend per control

| Control | BFF route | backend |
|---|---|---|
| List/open/save/new/delete | `/api/items/databricks-notebook[/list|/<id>]` | Workspace export/import REST |
| Run cell / run all | command execute (per exec context) | Databricks command API |
| Cluster list | `/api/items/databricks-cluster` | Clusters REST |
| Runs history | `/api/items/databricks-notebook/<id>/runs` | Jobs `runs/list` |
| Result export | `result-export.ts` | client-side CSV/JSON |
| UC lineage | `UcLineagePanel` | Unity Catalog lineage REST |
| Schedule (R4-DBX-1) | new `…/schedule` route | Jobs `jobs/create` |
| Widgets (R4-DBX-2) | run/param body | job/run parameters |

## Bicep / env sync

- Env: `LOOM_DATABRICKS_HOST` / workspace + auth (SCIM/PAT via KV secretRef). Honest
  infra gate when unset.
- Roles: Console UAMI / SPN with workspace + Jobs + Clusters access; UC lineage read.
- No new Cosmos container (bundle cells hydrate from the item state).

## Verification

- Per `no-vaporware.md`: cells run on a real cluster execution context; runs list is live.
- Live `pnpm uat` side-by-side against a Databricks notebook: **pending**. MISSING/partial
  rows derived from code; confirm each against the live workspace per `no-scaffold`.
