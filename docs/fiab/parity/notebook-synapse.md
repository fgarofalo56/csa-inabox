# notebook-synapse — parity with the Azure Synapse Studio notebook

> R4 notebook-parity inventory (2026-07-10). Grading per `.claude/rules/ui-parity.md`
> + `.claude/rules/no-vaporware.md`. Graded conservatively; when in doubt, graded
> DOWN. This doc isolates the **Synapse-flavored** Loom notebook. Sibling docs:
> [`notebook-databricks.md`](notebook-databricks.md) (Databricks flavor),
> [`notebook-loom.md`](notebook-loom.md) (the default "regular" Fabric-style flavor).
>
> **Why this doc exists.** The three Loom notebook flavors diverged: each editor
> was built at a different time and exposes a *different subset* of features. The
> Synapse editor (`synapse-notebook-editor.tsx`) has scheduling, a parameters
> cell, and a markdown outline that the "regular" flavor lacks — but it is missing
> the **variable explorer**, the **display() chart/viz builder**, **Data Wrangler**,
> **`%run` reference**, and **cross-language temp-table** affordances that a real
> Synapse Studio notebook exposes and that the shared `RichDisplay`/`VariablesPane`
> components already provide to the other flavors. R4 closes that gap.

**Source UI (grounded in Microsoft Learn, not memory):**
- Create, develop, and maintain Synapse notebooks: https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks
- Synapse notebook concept: https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-notebook-concept
- Data visualization in notebooks: https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-data-visualization
- Microsoft Spark utilities (mssparkutils): https://learn.microsoft.com/azure/synapse-analytics/spark/microsoft-spark-utilities

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/synapse-notebook-editor.tsx` (`SynapseNotebookEditor`)
  — self-contained cell renderer (own `richTable`/`richImg` output styles; does
  **not** reuse the shared `CodeCell`/`RichDisplay`).
- Schedule: `apps/fiab-console/lib/components/notebook/schedule-wizard.tsx`
  (`ScheduleWizard` → AML `workspaces/schedules`).
- Inline AI: "Ask Copilot / Explain / Fix" affordances in the cell toolbar.

**Backend reality check.** List/open/save/delete → `/api/synapse/notebooks[/<name>]`
(Synapse dev-plane Artifact REST, api-version 2020-12-01). Attach picker →
`/api/items/synapse-spark-pool/list` (ARM `bigDataPools`). Run cell → `POST
/api/synapse/notebooks/<name>/run-cell` (Livy create-session + submit-statement,
poll via GET). `%%configure` intercepted client-side, applied to the next
session-create body. Scheduling → `/api/notebook/[id]/schedule` (real AML
`Microsoft.MachineLearningServices/workspaces/schedules`). Honest gate: workspace
503 `not_configured` → full designer renders behind a MessageBar naming
`LOOM_SYNAPSE_WORKSPACE`. No mocks. Azure-native — no Fabric required.

---

## Synapse feature inventory → Loom coverage → backend

Legend: built ✅ · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Notebook management

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| A1 | Create notebook | ✅ built | New → `POST /api/synapse/notebooks` |
| A2 | Open notebook (list tree) | ✅ built | `/api/synapse/notebooks` → open `/<name>` |
| A3 | Delete notebook | ✅ built | `DELETE /api/synapse/notebooks/<name>` |
| A4 | Save / **Publish** artifact | ✅ built | publish via Synapse Artifact Publisher + ADLS `.ipynb` backup |
| A5 | **Import** existing IPYNB | ❌ MISSING | no import path; only new/open |
| A6 | Rename notebook | ⚠️ partial | via save-as name; no inline rename affordance |
| A7 | Git / workspace source-control integration | ❌ MISSING | no Git bind; publish-only |

### B. Develop cells

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Add code cell / markdown cell | ✅ built | cell adder (`+Code` / `+Markdown`) |
| B2 | Insert cell between cells | ✅ built | inter-cell add bar |
| B3 | Set notebook **primary language** | ✅ built | `defaultLang` dropdown (pyspark default) |
| B4 | Per-cell language via `%%magic` (pyspark/spark/sql/sparkr/**.NET-C#**) | ✅ built | `KIND_MAGIC` write/strip round-trip in IPYNB |
| B5 | Markdown cell render | ✅ built | `renderMarkdown` |
| B6 | Move / duplicate / delete cell | ✅ built | per-cell toolbar |
| B7 | Collapse cell **input** | ✅ built | collapse toggle |
| B8 | Collapse cell **output** | ⚠️ partial | input collapse only; output not independently collapsible |
| B9 | Notebook **outline** (markdown headings → nav) | ✅ built | outline panel from `#` headings |
| B10 | **IDE IntelliSense** (Monaco syntax + completion) | ✅ built | `MonacoTextarea` + inline-completion |
| B11 | **Code snippets** library | ❌ MISSING | no snippet inserter |
| B12 | **Format text cell** via markdown toolbar buttons (bold/heading/list/link) | ❌ MISSING | raw markdown only, no WYSIWYG toolbar |
| B13 | **Undo/redo cell operation** (add/delete/move) | ❌ MISSING | Monaco undo only; no notebook-level cell-op undo |
| B14 | **Comment on a code cell** (collaborate) | ❌ MISSING | no cell comments |
| B15 | **Cross-language temp tables** helper (createOrReplaceTempView pattern) | ❌ MISSING | works at runtime; no guided affordance |
| B16 | Drag-to-reorder cells | ⚠️ partial | move up/down buttons; no drag handle |

### C. Run & session

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| C1 | Run cell | ✅ built | `POST …/run-cell` (Livy submit statement) |
| C2 | Run all | ✅ built | sequential submit, stop-on-error |
| C3 | Shift+Enter / Ctrl+Enter / Alt+Enter run shortcuts | ⚠️ partial | run wired; not all three keymaps confirmed |
| C4 | Cancel / stop running cell | ⚠️ partial | session kill on unmount; per-cell stop not surfaced |
| C5 | **Cell status indicator** (step-by-step + duration + end time) | ⚠️ partial | status text + ok/error; no step timeline or persisted duration summary |
| C6 | **Spark progress indicator** (real-time bar + task/stage counts) | ❌ MISSING | no live progress bar or task counts |
| C7 | **Spark UI drill-down** link (job/stage) | ✅ built | Spark UI link from session |
| C8 | Active-session management (state badge, keepalive, reuse) | ✅ built | `sessionState` badge; keepalive; kill-on-unmount |
| C9 | Attach **Spark pool** (Big Data pool) | ✅ built | `/api/items/synapse-spark-pool/list` |
| C10 | Attach **environment** (Spark configuration) | ✅ built | `a365ComputeOptions` on the notebook |
| C11 | **Configure session UI** (executors/memory/timeout dialog) | ⚠️ partial | `%%configure` **magic** parsed; no dropdown session-config dialog (regular flavor has one) |
| C12 | Command vs edit **modal** shortcut keys (A/B/J/K/Shift+D…) | ❌ MISSING | edit-mode only; no command-mode keymap |

### D. Magic commands

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| D1 | Language magics `%%pyspark/%%spark/%%sql/%%csharp/%%sparkr` | ✅ built | per-cell magic round-trip |
| D2 | `%%configure` (session sizing) | ✅ built | intercepted → next session body |
| D3 | `%run` reference another notebook | ❌ MISSING | not parsed/executed |
| D4 | `%%html` render | ⚠️ partial | markdown HTML only; no `%%html` cell magic |
| D5 | `%lsmagic` / `%time` / `%timeit` / `%history` / `%load` / `%%capture` / `%%writefile` | ❌ MISSING | not surfaced |

### E. Data output & visualization

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| E1 | Tabular cell output | ✅ built | `richTable` inline render |
| E2 | Image / matplotlib output | ✅ built | `richImg` |
| E3 | Error traceback output | ✅ built | error status text |
| E4 | **Built-in chart view** of a table result (Table ⇄ Chart toggle, chart-type picker) | ❌ MISSING | no chart view; the shared `RichDisplay` (Table+Charts, bar/line/scatter/heatmap) is **not** wired into this editor |
| E5 | **Variable explorer** (Python vars: name/type/length/value, sortable) | ❌ MISSING | `VariablesPane` exists in the repo but is **not** wired here |
| E6 | **Data Wrangler** (visual data-prep → code) | ❌ MISSING | `DataWranglerPanel` exists but not wired here |
| E7 | Multiple outputs per cell | ⚠️ partial | last output shown; not multi-output |

### F. Parameterize, schedule, collaborate

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| F1 | **Parameters cell** (papermill/ADF `parameters` tag) | ✅ built | `isParameters` tag; at most one per notebook |
| F2 | Schedule the notebook (recurrence) | ✅ built | `ScheduleWizard` → AML `workspaces/schedules` |
| F3 | List / disable / delete schedules | ✅ built | `/api/notebook/[id]/schedule` |
| F4 | Add to a **pipeline** (notebook activity) | ⚠️ partial | via the data-pipeline editor, not from here |
| F5 | Inline **Copilot** (generate / explain / fix a cell) | ✅ built | "Ask Copilot / Explain / Fix" → AOAI (honest gate on `LOOM_AOAI_*`) |
| F6 | **Real-time co-authoring** (multi-user presence) | ❌ MISSING | single-editor |
| F7 | Export notebook (IPYNB download) | ⚠️ partial | ADLS `.ipynb` backup on save; no one-click export button |

---

## Coverage tally

- **built ✅: 24**
- **partial ⚠️: 11**
- **honest-gate ⚠️: 1** (workspace gate `LOOM_SYNAPSE_WORKSPACE`, full surface renders)
- **MISSING ❌: 14**

## Honest grade: **C+**

The Synapse editor is a **real** Livy-backed multi-language Spark notebook: it lists,
opens, publishes, and deletes real Synapse artifacts, attaches real Big Data pools
and Spark configurations, runs cells against live interactive sessions, parses
`%%configure`, carries a parameters cell, and schedules via real AML schedules — all
with an honest workspace gate. **No vaporware.**

Held below B by `ui-parity.md`'s completeness bar. The biggest disparity is that
this editor **does not reuse the shared cell/output stack** the other two flavors
use, so three Synapse-Studio hallmarks are simply absent even though the components
exist in the repo: the **display() Table⇄Chart viz builder** (`RichDisplay`), the
**variable explorer** (`VariablesPane`), and **Data Wrangler** (`DataWranglerPanel`).
Also missing: `%run` reference, a real-time **Spark progress bar** with task/stage
counts, command-mode keyboard shortcuts, cell comments, IPYNB import, code snippets,
and a markdown formatting toolbar.

## R4 build list (the ❌ rows, prioritized)

Item IDs are stable references for the R4 wave.

- **R4-SYN-1 — Wire the shared `RichDisplay` output surface (E4).** Replace the
  editor's bespoke `richTable`/`richImg` rendering with the shared `RichDisplay`
  (Table + Charts views: bar/line/scatter/heatmap w/ agg, add/duplicate/move chart).
  *Accept:* a `display(df)` cell renders a sortable table AND a Charts tab identical
  to the regular flavor; chart aggregations fire the same server profiler
  (`display-stats.ts`); side-by-side with the other flavor shows the same surface.
- **R4-SYN-2 — Wire the variable explorer (E5).** Mount `VariablesPane` and a
  "Variables" ribbon toggle; populate from the kernel variable snapshot after a run.
  *Accept:* running a PySpark cell that defines vars lists name/type/length/value,
  sortable by column header, matching the Synapse variable explorer.
- **R4-SYN-3 — Wire Data Wrangler (E6).** Mount `DataWranglerPanel` with a "Data
  Wrangler" launch on an active DataFrame; export generated pandas/PySpark back to a
  cell. *Accept:* launch from a DataFrame, apply a clean op, "Add code to notebook"
  inserts working code.
- **R4-SYN-4 — `%run` reference notebook (D3).** Parse a leading `%run <path|name>`
  and execute the referenced (published) notebook in-session before the cell.
  *Accept:* a `%run` cell pulls functions/vars from the referenced notebook; honors
  Synapse's published-only + non-recursive constraints with a clear error otherwise.
- **R4-SYN-5 — Real-time Spark progress indicator (C6).** Live progress bar + task/
  stage counts under a running cell, driven by the Livy/Spark job status, with the
  existing Spark-UI link as drill-down. *Accept:* a multi-stage job shows advancing
  progress and task counts, not just a spinner.
- **R4-SYN-6 — Session-config dialog (C11).** Add the dropdown-driven session-config
  dialog (reuse `session-config-dialog.tsx`) as the UI twin of `%%configure`
  (executors / memory / idle timeout). *Accept:* saving the dialog sizes the next
  Livy session; equivalent to typing `%%configure`, no raw magic required.
- **R4-SYN-7 — Command-mode keyboard shortcuts (C12).** Implement the Synapse modal
  keymap (Esc→command; A/B insert; J/K select; Shift+D delete; Enter→edit).
  *Accept:* each shortcut does exactly what the Learn "Use shortcut keys" table says.
- **R4-SYN-8 — Independent output collapse (B8) + multi-output (E7).** Collapse cell
  output separately from input; render multiple outputs per cell.
- **R4-SYN-9 — Cell comments (B14) / co-authoring stub (F6).** Per-cell comment
  thread persisted with the notebook definition. *Accept:* add/resolve a comment on
  a cell; it survives save/reopen.
- **R4-SYN-10 — IPYNB import (A5) + one-click export (F7).** "Import" reads a
  standard IPYNB into cells; "Export" downloads the current notebook as IPYNB.
- **R4-SYN-11 — Markdown formatting toolbar (B12) + code snippets (B11).** WYSIWYG
  bold/heading/list/link buttons on markdown cells; a snippet inserter for common
  Spark patterns.
- **R4-SYN-12 — Cell-op undo/redo (B13) + drag-reorder (B16).** Notebook-level
  undo/redo for add/delete/move; drag handle to reorder cells.

## Backend per control

| Control | BFF route | backend |
|---|---|---|
| List/open/save/delete notebook | `/api/synapse/notebooks[/<name>]` | Synapse Artifact REST 2020-12-01 |
| Run cell / run all | `POST /api/synapse/notebooks/<name>/run-cell` | Livy create-session + submit-statement |
| Attach Spark pool | `/api/items/synapse-spark-pool/list` | ARM `bigDataPools` |
| `%%configure` | (client parse) → run-cell session body | Livy session sizing |
| Schedule | `/api/notebook/[id]/schedule` | AML `workspaces/schedules` |
| Inline Copilot | notebook Copilot route | AOAI (`LOOM_AOAI_*`) |
| display() viz (R4-SYN-1) | shared display kernel + `display-stats.ts` | Spark aggregation |
| Variables (R4-SYN-2) | kernel variable snapshot | Livy statement |

## Bicep / env sync

- Env: `LOOM_SYNAPSE_WORKSPACE` (workspace gate), `LOOM_AOAI_ENDPOINT` /
  `LOOM_AOAI_DEPLOYMENT` (Copilot), AML workspace for schedules.
- Roles: Console UAMI holds Synapse **Artifact Publisher** + Spark access; AML
  contributor for schedules. No new Cosmos container (definition stored on the item).

## Verification

- Per `no-vaporware.md`: every Run hits a live Livy session; no mock rows.
- Live `pnpm uat` side-by-side against Synapse Studio: **pending**. MISSING/partial
  rows derived from code; confirm each against the live Studio UI per `no-scaffold`.
