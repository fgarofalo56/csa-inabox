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
| A5 | **Import** existing IPYNB | ✅ built (R4-SYN-10) | ribbon Import → client-side `ipynbToCells`; publish with Save |
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
| B8 | Collapse cell **output** | ✅ built (R4-SYN-8) | independent output-collapse toggle (IPYNB `jupyter.outputs_hidden`) |
| B9 | Notebook **outline** (markdown headings → nav) | ✅ built | outline panel from `#` headings |
| B10 | **IDE IntelliSense** (Monaco syntax + completion) | ✅ built | `MonacoTextarea` + inline-completion |
| B11 | **Code snippets** library | ✅ built (R4-SYN-11) | ribbon Snippets dropdown → `SPARK_SNIPPETS` inserts a cell |
| B12 | **Format text cell** via markdown toolbar buttons (bold/heading/list/link) | ✅ built (R4-SYN-11) | WYSIWYG toolbar on `MarkdownCell` (`applyMarkdownFormat`) |
| B13 | **Undo/redo cell operation** (add/delete/move) | ✅ built (R4-SYN-12) | notebook-level history stack + ribbon + Ctrl+Z/Ctrl+Shift+Z |
| B14 | **Comment on a code cell** (collaborate) | ✅ built (R4-SYN-9) | per-cell comment thread persisted in IPYNB `loomComments` |
| B15 | **Cross-language temp tables** helper (createOrReplaceTempView pattern) | ✅ built (R4-SYN-11) | `temp-view` snippet (register PySpark DF → query from `%%sql`) |
| B16 | Drag-to-reorder cells | ✅ built (R4-SYN-12) | HTML5 drag handle on every cell (`moveCellToIndex`) |

### C. Run & session

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| C1 | Run cell | ✅ built | `POST …/run-cell` (Livy submit statement) |
| C2 | Run all | ✅ built | sequential submit, stop-on-error |
| C3 | Shift+Enter / Ctrl+Enter / Alt+Enter run shortcuts | ⚠️ partial | run wired; not all three keymaps confirmed |
| C4 | Cancel / stop running cell | ⚠️ partial | session kill on unmount; per-cell stop not surfaced |
| C5 | **Cell status indicator** (step-by-step + duration + end time) | ⚠️ partial | status text + ok/error; no step timeline or persisted duration summary |
| C6 | **Spark progress indicator** (real-time bar + task/stage counts) | ✅ built (R4-SYN-5) | live Livy statement progress bar (0–100%) under a running cell + Spark UI link. Livy exposes fractional progress, **not** stage/task counts, so counts are honestly omitted (not fabricated) |
| C7 | **Spark UI drill-down** link (job/stage) | ✅ built (R4-SYN-5) | real `appInfo.sparkUiUrl` from the session — now surfaced in the toolbar + running cell (was previously dead code) |
| C8 | Active-session management (state badge, keepalive, reuse) | ✅ built | `sessionState` badge; keepalive; kill-on-unmount |
| C9 | Attach **Spark pool** (Big Data pool) | ✅ built | `/api/items/synapse-spark-pool/list` |
| C10 | Attach **environment** (Spark configuration) | ✅ built | `a365ComputeOptions` on the notebook |
| C11 | **Configure session UI** (executors/memory/timeout dialog) | ✅ built (R4-SYN-6) | shared `SessionConfigDialog` → maps to `configureOptions` (== `%%configure`) |
| C12 | Command vs edit **modal** shortcut keys (A/B/J/K/Shift+D…) | ✅ built (R4-SYN-7) | Esc→command mode; A/B insert · J/K select · Shift+D delete · Enter edit · M/Y convert; shortcut reference dialog |

### D. Magic commands

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| D1 | Language magics `%%pyspark/%%spark/%%sql/%%csharp/%%sparkr` | ✅ built | per-cell magic round-trip |
| D2 | `%%configure` (session sizing) | ✅ built | intercepted → next session body |
| D3 | `%run` reference another notebook | ✅ built (R4-SYN-4) | leading `%run <name>` resolves the PUBLISHED notebook's PySpark cells into the warm session (published-only + non-recursive enforced) |
| D4 | `%%html` render | ⚠️ partial | markdown HTML only; no `%%html` cell magic |
| D5 | `%lsmagic` / `%time` / `%timeit` / `%history` / `%load` / `%%capture` / `%%writefile` | ❌ MISSING | not surfaced |

### E. Data output & visualization

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| E1 | Tabular cell output | ✅ built | `richTable` inline render |
| E2 | Image / matplotlib output | ✅ built | `richImg` |
| E3 | Error traceback output | ✅ built | error status text |
| E4 | **Built-in chart view** of a table result (Table ⇄ Chart toggle, chart-type picker) | ✅ built (R4-SYN-1) | shared `RichDisplay` (Table+Charts, bar/line/scatter/heatmap) wired via `buildRichFromTable` |
| E5 | **Variable explorer** (Python vars: name/type/length/value, sortable) | ✅ built (R4-SYN-2) | `VariablesPane` — real `globals()` snapshot over the live session |
| E6 | **Data Wrangler** (visual data-prep → code) | ✅ built (R4-SYN-3) | `DataWranglerPanel` → export pandas/PySpark into a cell |
| E7 | Multiple outputs per cell | ✅ built (R4-SYN-8) | `SynapseCellOutput` renders stdout text + rich table/chart + HTML + image together |

### F. Parameterize, schedule, collaborate

| # | Synapse Studio capability | Loom | Where / backend |
|---|---|---|---|
| F1 | **Parameters cell** (papermill/ADF `parameters` tag) | ✅ built | `isParameters` tag; at most one per notebook |
| F2 | Schedule the notebook (recurrence) | ✅ built | `ScheduleWizard` → AML `workspaces/schedules` |
| F3 | List / disable / delete schedules | ✅ built | `/api/notebook/[id]/schedule` |
| F4 | Add to a **pipeline** (notebook activity) | ⚠️ partial | via the data-pipeline editor, not from here |
| F5 | Inline **Copilot** (generate / explain / fix a cell) | ✅ built | "Ask Copilot / Explain / Fix" → AOAI (honest gate on `LOOM_AOAI_*`) |
| F6 | **Real-time co-authoring** (multi-user presence) | ⚠️ honest-gate (R4-SYN-9) | persisted per-cell comments ship; live multi-user presence is disclosed as unavailable on the Azure-native backend (needs a presence backend) |
| F7 | Export notebook (IPYNB download) | ✅ built (R4-SYN-10) | ribbon Export → one-click `.ipynb` download (client-side Blob) |

---

## Coverage tally (after R4-SYN wave 1 + 2)

- **built ✅: 45**
- **partial ⚠️: 6** (A6 rename, C3 run keymaps, C4 per-cell stop, C5 step timeline, D4 `%%html`, F4 add-to-pipeline)
- **honest-gate ⚠️: 2** (workspace gate `LOOM_SYNAPSE_WORKSPACE`; F6 live co-authoring disclosed unavailable, comments ship)
- **MISSING ❌: 2** (A7 Git source-control bind, D5 niche magics `%lsmagic`/`%history`/… — both out of the R4 wave scope)

## Honest grade: **A−**

The Synapse editor is a **real** Livy-backed multi-language Spark notebook that now
reuses the shared cell/output stack: it lists, opens, publishes, imports, exports,
and deletes real Synapse artifacts; attaches real Big Data pools and Spark
configurations; runs cells against live interactive sessions with a **real Livy
progress bar** + Spark UI drill-down; renders the **display() Table⇄Chart builder**
(`RichDisplay`), the **variable explorer** (`VariablesPane`), and **Data Wrangler**
(`DataWranglerPanel`); resolves **`%run`** into the warm session; carries a
parameters cell; exposes a **dropdown session-config dialog** (== `%%configure`),
**command-mode keyboard shortcuts**, **cell comments**, **cell-op undo/redo +
drag-reorder**, a **markdown formatting toolbar**, and a **Spark snippet library** —
all with honest gates. **No vaporware.**

Held just below A only by the two out-of-R4-scope ❌ rows (A7 Git source-control
bind; D5 niche IPython magics) and the six partials; every R4-SYN item (1–12) is
built or honestly gated.

## R4 build list — COMPLETE ✅ (waves 1 + 2)

Item IDs are stable references for the R4 wave. Wave 1 = `#1855` (SYN-1/2/3);
wave 2 = this PR (SYN-4…12).

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
- **R4-SYN-4 — `%run` reference notebook (D3). ✅ DONE.** `parseRunReference` +
  `buildRunPreamble` resolve a leading `%run <name>` to the published notebook's
  PySpark cells and run them in the warm session before subsequent cells use its
  functions/vars. Published-only (workspace GET) + non-recursive (throws on nested
  `%run`) enforced with clear errors.
- **R4-SYN-5 — Real-time Spark progress indicator (C6). ✅ DONE.** The execute poll
  route already passes Livy statement `progress` (0..1) through; the editor renders a
  live `ProgressBar` + percentage under the running cell and surfaces the real
  `appInfo.sparkUiUrl` drill-down. Livy does **not** expose stage/task counts, so
  those are honestly omitted (not fabricated) per the no-vaporware bar.
- **R4-SYN-6 — Session-config dialog (C11). ✅ DONE.** Reuses the shared
  `SessionConfigDialog`; Apply maps to `configureOptions` (identical to `%%configure`)
  and resets the session so the next run is sized. No raw magic required.
- **R4-SYN-7 — Command-mode keyboard shortcuts (C12). ✅ DONE.** Esc→command mode;
  A/B insert, J/K (and ↑/↓) select, Shift+D delete, Enter edit, M/Y convert, plus
  Ctrl/⌘+Z / Ctrl/⌘+Shift+Z undo/redo; a Shortcuts dialog documents the keymap.
- **R4-SYN-8 — Independent output collapse (B8) + multi-output (E7). ✅ DONE.**
  `outputCollapsed` per cell (persisted as `jupyter.outputs_hidden`) with its own
  toggle; `SynapseCellOutput` renders stdout + table/chart + HTML + image together.
- **R4-SYN-9 — Cell comments (B14) / co-authoring (F6). ✅ DONE.** Per-cell comment
  thread persisted in IPYNB `loomComments` (add/resolve, survives save/reopen). Live
  multi-user presence is honestly disclosed as unavailable on the Azure-native
  backend (needs a presence service) rather than faked.
- **R4-SYN-10 — IPYNB import (A5) + one-click export (F7). ✅ DONE.** Import parses a
  standard `.ipynb` client-side via `ipynbToCells`; Export downloads the current
  notebook as `.ipynb` (client-side Blob).
- **R4-SYN-11 — Markdown formatting toolbar (B12) + code snippets (B11). ✅ DONE.**
  WYSIWYG bold/italic/H1/H2/list/quote/code/link toolbar on the shared `MarkdownCell`
  (`applyMarkdownFormat`); a ribbon Snippets dropdown inserts common Spark patterns
  incl. the cross-language `createOrReplaceTempView` helper (B15).
- **R4-SYN-12 — Cell-op undo/redo (B13) + drag-reorder (B16). ✅ DONE.**
  Notebook-level history stack for add/delete/move/duplicate/convert with ribbon +
  keyboard undo/redo; HTML5 drag handle on every cell reorders via `moveCellToIndex`.

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
