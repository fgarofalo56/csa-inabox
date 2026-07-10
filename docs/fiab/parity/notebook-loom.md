# notebook-loom — parity with the Microsoft Fabric notebook (the default "regular" flavor)

> R4 notebook-parity inventory (2026-07-10). Grading per `.claude/rules/ui-parity.md`
> + `.claude/rules/no-vaporware.md`. Graded conservatively; when in doubt, graded
> DOWN. This doc covers the **default Loom notebook** — the Fabric-style flavor that
> back-ends onto Synapse Spark (Livy warm pool) or an AML compute instance, NOT the
> Synapse-Studio or Databricks flavors. Sibling docs:
> [`notebook-synapse.md`](notebook-synapse.md), [`notebook-databricks.md`](notebook-databricks.md).
>
> **Why this doc exists.** This is the richest of the three flavors by UI shell — it
> already wires the shared `RichDisplay` (Table⇄Chart viz builder), `VariablesPane`
> (variable explorer), `DataWranglerPanel`, a docked `CopilotChatPane`, a History
> drawer, an Environment/library panel, a dropdown session-config dialog, LSP-backed
> IntelliSense, and attach-data-sources. Its two problems are the ones the operator
> called out: (1) **it often doesn't actually work** — slow cells, infinite spinners,
> missing outputs (tracked separately as **R3**, task #37), and (2) it is **missing
> scheduling and parameters/widgets** that the Fabric notebook and even the sibling
> Synapse flavor expose. R4 covers the feature gaps; R3 covers the reliability.

**Source UI (grounded in Microsoft Learn, not memory):**
- How to use Microsoft Fabric notebooks (resources pane, file editor, sessions): https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook
- Develop, execute, and manage Fabric notebooks (magics, run): https://learn.microsoft.com/fabric/data-engineering/author-execute-notebook
- Notebook visualization in Fabric (built-in charts): https://learn.microsoft.com/fabric/data-engineering/notebook-visualization
- Data Wrangler in Fabric: https://learn.microsoft.com/fabric/data-science/data-wrangler
- High concurrency mode for notebooks: https://learn.microsoft.com/fabric/data-engineering/configure-high-concurrency-session-notebooks
- Fabric vs Synapse notebook comparison (resources, collaborate, HC, scheduled run): https://learn.microsoft.com/fabric/data-engineering/comparison-between-fabric-and-azure-synapse-spark

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/notebook-editor.tsx` (`NotebookEditor`) — reuses
  shared `CodeCell` / `MarkdownCell` / `CellAdder` / `RichDisplay`.
- Panels: `VariablesPane`, `DataWranglerPanel`, `CopilotChatPane`, `HistoryDrawer`,
  `EnvironmentPanel`, `SessionConfigDialog` (all under `lib/components/notebook/`).
- Compute: `runtimeFromComputeKind` (Synapse Spark / Databricks / AML CI); warm Spark
  pool via `/api/spark/session-pool`; prewarm on compute select.

**Backend reality check.** Cells run → `POST …/run` (Livy against the warm Spark pool,
or the attached compute). `display()` → server profiler (`display-stats.ts`) + kernel
payload (`ai-display.py`) → `RichDisplay`. Variables → kernel variable snapshot.
Environments → `/api/aml/environments`. Save → notebook definition (cells/defaultLang/
attachedSources/attachedAmlEnv/customLibraries/sessionConfig) to Cosmos. Honest gates:
`/api/spark/session-pool` 503 and AML 503 leave the panels visible with a MessageBar
naming the missing resource. No mocks. Azure-native — no Fabric required.

---

## Fabric feature inventory → Loom coverage → backend

Legend: built ✅ · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Notebook management

| # | Fabric capability | Loom | Where / backend |
|---|---|---|---|
| A1 | Create / open / delete notebook (folder tree) | ✅ built | `renderNbFolder`/`renderNbLeaf` tree; New/Refresh |
| A2 | Save notebook | ✅ built | definition → Cosmos |
| A3 | Import / export IPYNB | ⚠️ partial | round-trips cells; no explicit import/export button |
| A4 | Rename / move in workspace | ⚠️ partial | new/open/delete; no inline rename |
| A5 | Git integration | ❌ MISSING | no Git bind |

### B. Cells & editing (shared `CodeCell`)

| # | Fabric capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Code + markdown cells | ✅ built | `CodeCell` / `MarkdownCell` |
| B2 | Add / insert / move / duplicate / delete cell | ✅ built | `CellAdder` + `CodeCell` toolbar; drag-reorder supported |
| B3 | Default language + per-cell language magics (`%%pyspark/%%spark/%%sql/%%sparkr`) | ✅ built | `SPARK_MAGICS` detection; `defaultLang` |
| B4 | Markdown render + maximize | ✅ built | `renderMarkdown`; maximize toggle |
| B5 | Lock / copy / convert-to-markdown cell | ✅ built | `CodeCell` toolbar |
| B6 | Collapse cell input / output | ⚠️ partial | maximize/collapse present; independent output collapse not confirmed |
| B7 | IntelliSense + LSP (pylsp) inline completion + ghost text | ✅ built | `CodeCell` Monaco + `lspWsUrl` + schema-hint ghost text |
| B8 | Cluster-aware completion (dbutils vs mssparkutils vs azure.ai.ml) | ✅ built | `clusterRuntime` → `cluster-intellisense` |
| B9 | Notebook **outline** | ⚠️ partial | not confirmed in this editor (Synapse flavor has it) |
| B10 | Command/edit modal keymap | ⚠️ partial | run keys wired; full modal keymap unconfirmed |

### C. Run, compute & session

| # | Fabric capability | Loom | Where / backend |
|---|---|---|---|
| C1 | Run cell | ✅ built | `POST …/run` (Livy) |
| C2 | Run all | ✅ built | `run` (ribbon "Run all") |
| C3 | **Warm-pool / fast session start** | ✅ built | `/api/spark/session-pool`; prewarm on compute-select |
| C4 | Attach compute (Synapse Spark / Databricks cluster / AML CI) | ✅ built | `runtimeFromComputeKind`; compute selector |
| C5 | Start a terminated compute from the editor | ✅ built | `/api/loom/compute-targets/{id}/start` (poll to running) |
| C6 | Provision own per-user AML compute instance | ✅ built | honest quota gate |
| C7 | **Session config UI** (executors/memory/idle-timeout dialog = `%%configure`) | ✅ built | `SessionConfigDialog` → session-create body |
| C8 | Session status indicator (Idle/Running/Error) | ✅ built | bottom-left session badge |
| C9 | Cell status + duration | ⚠️ partial | status present; per-step timeline/duration summary partial |
| C10 | **Spark progress bar** (real-time + task/stage counts) | ❌ MISSING | spinner only; no live progress/task counts |
| C11 | **High-concurrency session** (share one session across notebooks) | ❌ MISSING | one session per notebook |
| C12 | Reliability: cells complete, outputs land, no infinite spinner | ⚠️ partial | **R3 (task #37)** — slow cells / infinite spinner / missing outputs |

### D. Outputs & visualization (shared `RichDisplay`)

| # | Fabric capability | Loom | Where / backend |
|---|---|---|---|
| D1 | `display()` results **table** (sort, column select) | ✅ built | `RichDisplay` Table view |
| D2 | Built-in **chart view** (Table⇄Chart, bar/line/scatter/heatmap + agg) | ✅ built | `RichDisplay` Charts view; recommended charts |
| D3 | CSV copy / download of results | ✅ built | `RichDisplay` table export |
| D4 | Image / matplotlib output | ✅ built | `RichDisplay` image |
| D5 | Rich HTML / `displayHTML` | ⚠️ partial | handled generically; not a first-class path |
| D6 | Data profile / summary stats | ⚠️ partial | server profiler feeds charts; no dedicated profile tab |
| D7 | Multiple outputs per cell | ⚠️ partial | primary output; not multi-output |

### E. Data & environment

| # | Fabric capability | Loom | Where / backend |
|---|---|---|---|
| E1 | **Data Wrangler** (visual prep → code) | ✅ built | `DataWranglerPanel` (+ `wrangler-ai-tab`) |
| E2 | **Variable explorer** | ✅ built | `VariablesPane` (kernel snapshot) |
| E3 | Attach **data sources** (lakehouses/warehouses/KQL) + abfss resolve | ✅ built | attach modal; `resolvedPaths` |
| E4 | **Environment / libraries** (attach AML env + custom .jar/.whl) | ✅ built | `EnvironmentPanel` → `/api/aml/environments` |
| E5 | **Resources pane** (Unix-like file folder + in-notebook file editor) | ❌ MISSING | no resources/file-editor pane |
| E6 | Datastore explorer | ✅ built | `datastore-explorer` |

### F. AI, collaborate, schedule

| # | Fabric capability | Loom | Where / backend |
|---|---|---|---|
| F1 | **Copilot** (docked chat: generate/refactor/summarize/`/fix`) | ✅ built | `CopilotChatPane` (docked ~25% drawer) |
| F2 | Copilot notebook-persona context (attached lakehouses, active lang) | ✅ built | `setCopilotContext` |
| F3 | **History** (run/version history drawer) | ✅ built | `HistoryDrawer` |
| F4 | **Schedule** the notebook (built-in scheduled run) | ❌ MISSING | **no schedule UI in this editor** (Synapse flavor has `ScheduleWizard`) |
| F5 | **Parameters cell** / parameterized run | ❌ MISSING | no parameters cell/panel |
| F6 | Add notebook to a **pipeline** activity | ⚠️ partial | via pipeline editor, not from here |
| F7 | **Real-time co-authoring** / comments | ❌ MISSING | single-editor; no cell comments |
| F8 | Share / permissions | ⚠️ partial | item-level share; no notebook-specific share dialog |

---

## Coverage tally

- **built ✅: 27**
- **partial ⚠️: 14**
- **honest-gate ⚠️: (session-pool + AML gates, surfaces still render)**
- **MISSING ❌: 8**

## Honest grade: **B− (functionally the richest, but reliability-capped)**

By raw feature surface this is the strongest of the three flavors and the closest to
the Fabric notebook: real Livy runs on a warm Spark pool, a real `display()` viz builder,
a real variable explorer, real Data Wrangler, a docked Copilot, attach-data-sources with
abfss resolution, an environment/library panel, a dropdown session-config dialog, and
LSP-backed cluster-aware IntelliSense. **No vaporware** — every panel calls a real backend
or shows an honest gate.

It is **not** graded higher for two reasons, both operator-stated: (1) **reliability** —
"a lot of functionality but it often doesn't work" (slow cells, infinite spinners, missing
outputs), which is the **R3** track (task #37) and is the single most important thing to
fix here; and (2) **feature gaps** vs Fabric: **no scheduling**, **no parameters/widgets**,
**no resources pane / in-notebook file editor**, **no high-concurrency session**, and **no
real-time Spark progress bar**. The scheduling gap is notable because the sibling Synapse
flavor already ships `ScheduleWizard` → AML schedules — it just is not wired into this editor.

## R4 build list (the ❌ rows, prioritized)

- **R4-NB-1 — Wire scheduling (F4).** Bring `ScheduleWizard` (already used by the Synapse
  flavor) into this editor → real AML `workspaces/schedules` via `/api/notebook/[id]/schedule`,
  plus list/disable/delete. *Accept:* schedule the open notebook; a real AML schedule is
  created and listed; side-by-side with the Synapse flavor shows the same wizard.
- **R4-NB-2 — Parameters cell + parameterized run (F5).** A `parameters`-tagged cell (papermill
  semantics) whose values are injected on scheduled/pipeline runs. *Accept:* mark a cell as
  parameters; a scheduled run overrides those values.
- **R4-NB-3 — Resources pane + in-notebook file editor (E5).** A Unix-like resources folder
  with a file editor (CSV/TXT/PY/SQL/YML/HTML, ≤1 MB, manual save) per Fabric. *Accept:* create/
  edit a `.py` resource file with keyword highlighting; it persists with the notebook.
- **R4-NB-4 — Real-time Spark progress bar (C10).** Live progress + task/stage counts under a
  running cell, driven by Livy/Spark job status, with a Spark-UI drill link. *Accept:* a
  multi-stage job shows advancing progress, not just a spinner. (Shared with R4-SYN-5.)
- **R4-NB-5 — High-concurrency session (C11).** Allow attaching to a shared session across
  notebooks (single-user boundary, matching lakehouse + Spark config). *Accept:* a second
  notebook attaches to a running session and starts instantly; status bar shows attached count.
- **R4-NB-6 — Notebook outline (B9) + independent output collapse (B6).** Markdown-heading
  outline nav in this editor; collapse output separately from input.
- **R4-NB-7 — Data profile tab (D6) + `displayHTML` first-class (D5) + multi-output (D7).**
- **R4-NB-8 — Cell comments / co-authoring (F7), IPYNB import/export buttons (A3), inline
  rename (A4), Git bind (A5), notebook share dialog (F8).** Collaboration + management long-tail.

> **R3 dependency (not an R4 item, but the top priority for this flavor).** The reliability
> defects — slow cells, infinite spinners, missing outputs — are tracked as **R3 (task #37)**.
> R4 feature work here should land on top of an R3-stabilized run path; a scheduled or
> parameterized run is only as good as the run that backs it.

## Backend per control

| Control | BFF route | backend |
|---|---|---|
| Run cell / run all | `POST …/run` | Livy on warm Spark pool / attached compute |
| Warm pool status | `/api/spark/session-pool` | Spark session pool |
| Start compute | `/api/loom/compute-targets/{id}/start` | ARM / Databricks / AML |
| display() viz | kernel `ai-display.py` + `display-stats.ts` | Spark aggregation |
| Variables | kernel variable snapshot | Livy statement |
| Environments | `/api/aml/environments` | AML environments REST |
| Save | notebook definition | Cosmos |
| Schedule (R4-NB-1) | `/api/notebook/[id]/schedule` | AML `workspaces/schedules` |

## Bicep / env sync

- Env: warm-pool config, `LOOM_AOAI_*` (Copilot), AML workspace (environments + schedules).
- Roles: Console UAMI Spark access; AML contributor for environments/schedules/CI.
- No new Cosmos container (notebook definition stored on the item).

## Verification

- Per `no-vaporware.md`: runs hit a live Livy session; `display()`/Variables read real
  kernel state; panels gate honestly.
- Live `pnpm uat` side-by-side against a Fabric notebook: **pending**. MISSING/partial rows
  derived from code; confirm each against the live Fabric UI per `no-scaffold`. Reliability
  (C12) validated by the R3 track.
