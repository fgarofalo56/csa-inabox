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
| A3 | Import / export IPYNB | ✅ built | Import button (`/api/items/notebook/import`) + **Export .ipynb** (R4-NB-8): builds nbformat-4 JSON (parameters cell carries the `parameters` tag) and downloads |
| A4 | Rename / move in workspace | ✅ built | inline **Rename** dialog (R4-NB-8) → `PUT …/notebook/[id] {displayName}`; move-to-folder already present |
| A5 | Git integration | ❌ MISSING | no Git bind |

### B. Cells & editing (shared `CodeCell`)

| # | Fabric capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Code + markdown cells | ✅ built | `CodeCell` / `MarkdownCell` |
| B2 | Add / insert / move / duplicate / delete cell | ✅ built | `CellAdder` + `CodeCell` toolbar; drag-reorder supported |
| B3 | Default language + per-cell language magics (`%%pyspark/%%spark/%%sql/%%sparkr`) | ✅ built | `SPARK_MAGICS` detection; `defaultLang` |
| B4 | Markdown render + maximize | ✅ built | `renderMarkdown`; maximize toggle |
| B5 | Lock / copy / convert-to-markdown cell | ✅ built | `CodeCell` toolbar |
| B6 | Collapse cell input / output | ✅ built | whole-cell collapse + **independent output collapse** (R4-NB-6): `CodeCell` output-toggle honoring `cell.outputCollapsed` |
| B7 | IntelliSense + LSP (pylsp) inline completion + ghost text | ✅ built | `CodeCell` Monaco + `lspWsUrl` + schema-hint ghost text |
| B8 | Cluster-aware completion (dbutils vs mssparkutils vs azure.ai.ml) | ✅ built | `clusterRuntime` → `cluster-intellisense` |
| B9 | Notebook **outline** | ✅ built | `OutlinePane` (R4-NB-6): markdown-heading TOC, click-to-scroll via per-cell refs |
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
| C10 | **Spark progress bar** (real-time + task/stage counts) | ⚠️ partial | `RunProgress` (R4-NB-4) renders under a running cell: consumes the poll `progress` (percent + stage/task counts + Spark-UI link) when present, honest indeterminate bar (phase + elapsed) until the shared server progress surface (R4-SYN-5) lands on main |
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
| D6 | Data profile / summary stats | ✅ built | `RichDisplay` **Profile** tab (R4-NB-7): per-column dtype / null % / distinct / min·max·mean·stddev / top-values over the sampled rows (real server profiler stats) |
| D7 | Multiple outputs per cell | ⚠️ partial | primary output; not multi-output |

### E. Data & environment

| # | Fabric capability | Loom | Where / backend |
|---|---|---|---|
| E1 | **Data Wrangler** (visual prep → code) | ✅ built | `DataWranglerPanel` (+ `wrangler-ai-tab`) |
| E2 | **Variable explorer** | ✅ built | `VariablesPane` (kernel snapshot) |
| E3 | Attach **data sources** (lakehouses/warehouses/KQL) + abfss resolve | ✅ built | attach modal; `resolvedPaths` |
| E4 | **Environment / libraries** (attach AML env + custom .jar/.whl) | ✅ built | `EnvironmentPanel` → `/api/aml/environments` |
| E5 | **Resources pane** (Unix-like file folder + in-notebook file editor) | ✅ built | `ResourcesPane` (R4-NB-3): Loom-native file bundle (new/rename/delete + Monaco keyword-highlighted editor, ≤1 MB) persisted in the notebook definition (Cosmos) — no Fabric/OneLake/AML file share |
| E6 | Datastore explorer | ✅ built | `datastore-explorer` |

### F. AI, collaborate, schedule

| # | Fabric capability | Loom | Where / backend |
|---|---|---|---|
| F1 | **Copilot** (docked chat: generate/refactor/summarize/`/fix`) | ✅ built | `CopilotChatPane` (docked ~25% drawer) |
| F2 | Copilot notebook-persona context (attached lakehouses, active lang) | ✅ built | `setCopilotContext` |
| F3 | **History** (run/version history drawer) | ✅ built | `HistoryDrawer` |
| F4 | **Schedule** the notebook (built-in scheduled run) | ✅ built | `ScheduleWizard` (R4-NB-1) → `/api/notebook/[id]/schedule` (real AML `workspaces/schedules`); list / enable-disable / **delete** in a schedule card — same wizard as the Synapse flavor |
| F5 | **Parameters cell** / parameterized run | ✅ built | "Mark as parameters cell" tag + **Run with parameters** (R4-NB-2): papermill semantics — override cell injected after the parameters cell, persisted, then run on the live session |
| F6 | Add notebook to a **pipeline** activity | ⚠️ partial | via pipeline editor, not from here |
| F7 | **Real-time co-authoring** / comments | ❌ MISSING | single-editor; no cell comments |
| F8 | Share / permissions | ⚠️ partial | item-level share; no notebook-specific share dialog |

---

## Coverage tally (after R4-NB-1..8)

- **built ✅: 35** (+8: F4 schedule, F5 parameters, E5 resources, B9 outline, B6 output-collapse, D6 profile, A3 export, A4 rename)
- **partial ⚠️: 10** (C10 progress now renders — server progress field pending R4-SYN-5; D5 displayHTML, D7 multi-output still generic; F6/F8 pipeline/share)
- **honest-gate ⚠️: (session-pool + AML schedule/environment gates, surfaces still render)**
- **MISSING ❌: 3** (A5 Git bind, C11 high-concurrency session, F7 real-time co-authoring/comments)

## Honest grade: **B / B+ (feature gaps largely closed; reliability + HC/co-author remain)**

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

## R4 build list — status

- **R4-NB-1 — Scheduling (F4). ✅ DONE.** `ScheduleWizard` wired into this editor →
  `/api/notebook/[id]/schedule` (real AML `workspaces/schedules`), with list / enable-disable /
  **delete** (new `deleteNotebookSchedule` in `foundry-client` + `DELETE` route handler). Same
  wizard as the Synapse flavor; honest MessageBar gate when the AML workspace is unset.
- **R4-NB-2 — Parameters cell + parameterized run (F5). ✅ DONE.** "Mark as parameters cell"
  tags exactly one code cell (chip rendered above it); **Run with parameters** parses the
  `name = value` declarations, injects an override cell after the parameters cell (papermill),
  persists, then runs on the live session. *Note:* the AML **scheduled** job is still the shared
  placeholder Command (not a full papermill executor) — the fully-executable parameterized path
  is the manual "Run with parameters".
- **R4-NB-3 — Resources pane + file editor (E5). ✅ DONE.** `ResourcesPane`: Loom-native file
  bundle (new/rename/delete + Monaco keyword-highlighted editor, ≤1 MB) persisted in the notebook
  definition (Cosmos) — Azure-native, no Fabric/OneLake/AML file share required.
- **R4-NB-4 — Real-time Spark progress (C10). ⚠️ UI DONE, server hookup pending.** `RunProgress`
  renders under a running cell and consumes the poll `progress` object (percent + stage/task
  counts + Spark-UI link) when present; honest indeterminate bar (phase + elapsed) until the
  shared server progress surface (**R4-SYN-5**) lands on main. No poll-route edit here — the
  merge-time hookup is a one-line consume of the shared field.
- **R4-NB-5 — High-concurrency session (C11). ❌ NOT DONE (honest).** No shared-session backend
  exists yet; deferred rather than faked. Still one session per notebook.
- **R4-NB-6 — Outline (B9) + independent output collapse (B6). ✅ DONE.** `OutlinePane`
  (markdown-heading TOC, click-to-scroll) + per-cell `outputCollapsed` toggle in `CodeCell`.
- **R4-NB-7 — Data profile tab (D6). ✅ DONE.** `RichDisplay` **Profile** tab (per-column real
  stats). `displayHTML` first-class (D5) + multi-output (D7) remain generic ⚠️.
- **R4-NB-8 — Export IPYNB (A3) + inline rename (A4). ✅ DONE.** Export builds nbformat-4 JSON
  (parameters tag preserved) and downloads; Rename dialog → `PUT …/notebook/[id] {displayName}`.
  Cell comments/co-authoring (F7), Git bind (A5), share dialog (F8) remain the collaboration
  long-tail (F7/A5 still ❌).

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
| Schedule create/list/toggle/delete (R4-NB-1) | `/api/notebook/[id]/schedule` (GET/POST/PATCH/DELETE) | AML `workspaces/schedules` (real ARM) |
| Resource files (R4-NB-3) | `PUT …/notebook/[id] {definition.resources}` | Cosmos item state (Loom-native) |
| Parameterized run (R4-NB-2) | `PUT …/notebook/[id]` then `POST …/run` | Livy statement on the warm Spark pool |

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
