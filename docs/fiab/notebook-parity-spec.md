# Loom Notebook Editor — Fabric-parity build spec

> Reference: real Fabric notebook `01_bronze_slot_telemetry` in `casino-fabric-poc` (F64), captured via Playwright 2026-05-26. Screenshots: `temp/fabric-notebook-real.png` + `temp/fabric-notebook-clean.png`.

## Why this exists

The current Loom notebook is a single textarea + a code-only Save/Run. That's NOT what Fabric ships. This doc inventories every visible Fabric notebook UX element and maps each to its Loom build target.

## Fabric notebook UX inventory (verified live)

### Page chrome (top → bottom)

| Region | Elements | Source |
|---|---|---|
| **Title bar** | `01_bronze_slot_telemetry` (editable name) · `No label` chip · `Saved` status (auto-save indicator) | top-left of page |
| **Right-side global** | Search bar (centered) · Notifications · Settings · Downloads · Help · Feedback · Account picker | top-right |
| **Notebook tab strip** | `Home` (selected) · `Edit` · `AI tools` · `Run` · `View` | below title bar, left half |
| **Notebook right-side actions** | `Comments` · `History` · `Develop` (dropdown) · `Share` | below title bar, right half |
| **Home ribbon** | Save (disk) · Download · Settings (gear) · **Run all** ▼ · **Connect** ▼ · **PySpark (Python)** ▼ · Environment · **Workspace default** ▼ · Data Wrangler ▼ · AI assistant icon · **AutoML** (New AutoML run) · **Pipeline** (Add to pipeline) · **VS Code** (Open in VS Code) · **Copilot** | ribbon strip under tabs |

### Status bar (bottom)

| Item | What it shows |
|---|---|
| Not connected / Connected · | Spark session status |
| AutoSave: On | Auto-save toggle |
| Copilot completions: On | Inline AI suggestions toggle |
| **Selected Cell N of M cells** | Cell selection counter (this notebook has 23 cells) |

### Left side panel — Explorer

| Element | Purpose |
|---|---|
| Header: **Explorer** + collapse arrow | Panel title |
| Tab: **Data items** (selected) | Lakehouses + warehouses attached to this notebook |
| Tab: **Resources** | File attachments (.csv, .py modules) embedded in notebook |
| Tab: **Connections** | External data source connections (SQL, ADLS, Onelake shortcuts) |
| **+ Add data items** button | Attaches a Lakehouse / Warehouse / KQL DB / Real-Time hub source |
| Search box | Filter the tree |
| Tree: **OneLake** root → child Lakehouses with star (pin) icon | Browsable per-attached source: when expanded, shows Tables / Files folders |

### Cell-level UX

Every cell has:
1. **Cell-type icon on the left** — green code-bracket for code cells, hash # for markdown
2. **Collapse arrow** at left edge to fold cell
3. **Cell body** — Monaco editor (code) OR rendered markdown
4. **Right-edge toolbar** (visible on hover): **Ask Copilot**, Maximize/Expand, Convert (code↔md), Edit, Lock, More menu (⋯), Delete
   - Execution count badge `[N]` shown on code cells after run
5. **Between cells on hover**: a thin gap shows `+ Code` and `+ Markdown` buttons to insert a new cell at that position
6. **Output area** below code cells — text, tables (Spark DataFrame.show output), charts (with Chart View toggle)
7. **Run cell** button (▷) at the top-left of the cell when hovered

### Cell types Fabric supports

- **Code** with language taken from the notebook-level default language picker:
  - **PySpark (Python)** — default
  - **Spark (Scala)**
  - **Spark SQL**
  - **SparkR (R)**
  - **Python** (standalone, no Spark — for utility cells)
  - **T-SQL** (when notebook is attached to a Warehouse/SQL endpoint)
- **Markdown** (rendered as headings/lists/links; toggle to edit mode by clicking)

### Connect dropdown options

When user clicks **Connect** ▼ in the ribbon, expected entries:
- **Attach Lakehouse** → opens picker with existing Lakehouses in current Loom workspace + ability to create new
- **Attach Warehouse / SQL endpoint** → similar
- **Attach KQL Database** → picks ADX/Kusto db
- **Manage connections** → opens Connections tab on left panel

### Environment / Workspace default dropdown

- Sets the runtime: which compute pool + which environment (package versions) runs the notebook.
- For Loom: maps to the existing `/api/loom/compute-targets` (Synapse Spark + Databricks clusters).

### History pane

When user clicks **History** top-right:
- Side drawer or full pane showing past runs with timestamps, duration, status, user, parameters
- Each row clickable for details

---

## Loom build plan — what's needed

### Backend (mostly done — small additions)

- ✅ `/api/loom/workspaces` — done
- ✅ `/api/loom/compute-targets` — done (Synapse Spark + Databricks clusters)
- ✅ `/api/items/notebook` (Cosmos-backed list/create) — done (v3.22)
- ✅ `/api/items/notebook/[id]` (read/update/delete with code body) — done (v3.22)
- ✅ `/api/items/notebook/[id]/run` (async dispatch) — done (v3.24)
- ✅ `/api/items/notebook/[id]/runs/[runId]` (polling) — done (v3.24)
- **NEW** `/api/items/notebook/[id]/cells` — return cells[] (each: id, type, lang, source, outputs[])
- **NEW** `/api/items/notebook/[id]/cells/[cellId]/run` — run a single cell against the same session (Spark Livy session is shared across cells in a notebook run)
- **NEW** `/api/items/notebook/[id]/attached-sources` — list Lakehouses/Warehouses/KQL DBs attached to this notebook
- **NEW** `/api/items/notebook/[id]/data-items` — append/remove attached source
- The Cosmos `state` field expands to: `{ cells: [...], defaultLang, attachedSources: [...] }`

### Frontend — full rebuild

Replace single-textarea editor with a **cell-based editor**:

| Component | Tech | Source |
|---|---|---|
| **NotebookEditor** root | New React component, replaces current single-textarea | `lib/editors/notebook-editor.tsx` |
| **Cell** (Code) | Monaco editor with language from cell.lang, Run button, Output area | new `lib/components/notebook/CodeCell.tsx` |
| **Cell** (Markdown) | Two-mode (edit/view) using a Markdown renderer (e.g. react-markdown) | new `lib/components/notebook/MarkdownCell.tsx` |
| **CellAdder** between cells | Hover-visible `+ Code` / `+ Markdown` buttons | `lib/components/notebook/CellAdder.tsx` |
| **Cell right-edge toolbar** | Convert / Maximize / Copy / Edit / Lock / More / Delete | `lib/components/notebook/CellToolbar.tsx` |
| **NotebookRibbon** | Tabs (Home/Edit/AI tools/Run/View) + the Home ribbon contents | `lib/components/notebook/NotebookRibbon.tsx` |
| **LanguagePicker** | Dropdown: PySpark/Spark Scala/Spark SQL/SparkR/Python/T-SQL — sets default lang for new cells | `lib/components/notebook/LanguagePicker.tsx` |
| **CompactCompute** dropdown | Replaces current "Compute target" — same data but rendered as a Fabric-style chip | `lib/components/notebook/ComputeChip.tsx` |
| **ConnectMenu** | Dropdown w/ Attach Lakehouse, Attach Warehouse, Attach KQL DB, Manage connections | `lib/components/notebook/ConnectMenu.tsx` |
| **ExplorerPane** (left side) | Data items / Resources / Connections tabs + tree | `lib/components/notebook/ExplorerPane.tsx` |
| **StatusBar** | Connection status · AutoSave · Cell N of M | `lib/components/notebook/StatusBar.tsx` |
| **HistoryDrawer** | Past runs pane | `lib/components/notebook/HistoryDrawer.tsx` |

### Cell data model (new Cosmos shape)

```typescript
interface NotebookCell {
  id: string;                    // uuid stable across edits
  type: 'code' | 'markdown';
  lang?: 'pyspark' | 'spark' | 'sparksql' | 'sparkr' | 'python' | 'tsql';
  source: string;                // raw code / markdown text
  outputs?: CellOutput[];        // last-run outputs, persisted with cell
  locked?: boolean;
  collapsed?: boolean;
}
interface CellOutput {
  type: 'text' | 'table' | 'error';
  data?: any;                    // table data / JSON
  text?: string;
  ename?: string; evalue?: string; traceback?: string[];
}
interface NotebookState {
  cells: NotebookCell[];
  defaultLang: 'pyspark' | 'spark' | 'sparksql' | 'sparkr' | 'python' | 'tsql';
  attachedSources: {
    kind: 'lakehouse' | 'warehouse' | 'kql-database';
    id: string;        // Loom Cosmos id of the source
    displayName: string;
    isDefault: boolean;
    metadata?: any;
  }[];
}
```

### Run-all execution model

When user clicks **Run all**:
1. Create one Livy session (or one Databricks job context)
2. For each cell in order:
   - If markdown — skip
   - If code — submit statement; await output; persist output to cell; surface inline
3. Track total elapsed + cell-by-cell timings

### Per-cell run

Per-cell **Run cell ▷** button:
- Reuses the **current session** if one exists (Cosmos persists `activeSessionId` for the notebook)
- If no session — creates one, then runs the cell
- Output appended to the cell, persisted on next save

### Attach Lakehouse flow

1. User clicks **+ Add data items** in Explorer panel
2. Modal: list Loom Cosmos items of `itemType = lakehouse` in this workspace
3. Selected → appended to `state.attachedSources[]`, becomes browsable in tree
4. **First attached lakehouse becomes the "default lakehouse"** — Spark session is started with `spark.sql.defaultDatabase = <its name>`
5. **Auto-mount preamble (Azure-native, issue #655)** — when a NEW Spark session is created, an abfss preamble is injected (Synapse Livy: as a session statement; Databricks one-time PYTHON run: prepended to the cell) defining `loom_lakehouses = {"<displayName>": "abfss://<container>@<account>.dfs.<suffix>/<root>"}` so cells can `spark.read.format('delta').load(loom_lakehouses['sales'] + '/Tables/orders')` without typing storage paths. Paths come from the lakehouse's provisioned DLZ ADLS Gen2 coordinates (`state.provisioning.secondaryIds.adlsRoot` / `{container, rootPath}`), resolved by `lib/azure/lakehouse-abfss.ts` — **no OneLake / Microsoft Fabric dependency**. Unresolvable sources (no provisioning record / no `LOOM_*_URL` configured) are skipped silently (no guessed paths, per `no-vaporware.md`); the Data items chip surfaces the resolved path with a copy button, or an honest "path not configured" gate tooltip naming the env var to set.
6. Tree under a lakehouse: `Tables` + `Files` folders, expanded on click — `Tables` lists Delta tables from the Cosmos metadata + ADLS scan; `Files` is the ADLS Gen2 browse (already wired in Lakehouse editor)

---

## Phasing — what fits in one session each

This is too big for one session. Phased build:

### Session N+1 (~2-3 hrs)
- Cell-based editor scaffold (NotebookEditor v2)
- Code cell with Monaco
- Markdown cell with view/edit toggle
- + Code / + Markdown hover insert
- Cell-level Run button (single cell)
- Language picker in ribbon
- Cosmos state migration (single-source → cells[])

### Session N+2 (~2-3 hrs)
- ExplorerPane with Data items / Resources / Connections tabs
- ConnectMenu — Attach Lakehouse modal
- Tree under attached lakehouse (Tables + Files)
- StatusBar
- Run-all
- Cosmos state field for attachedSources

### Session N+3 (~2 hrs)
- HistoryDrawer
- Cell-edge toolbars (Convert / Lock / Delete / Maximize / Copy)
- Outputs: table renderer for Spark DataFrame outputs (HTML schema → DataGrid)
- AI tools tab basic features
- Notebook tab strip (Home/Edit/AI tools/Run/View — each maps to different ribbon)

### Session N+4 — polish
- Visual parity pixel check vs Fabric
- Loading states, keyboard shortcuts (Ctrl+Enter to run cell, etc.)
- A11y audit
- Re-run UAT harness

---

## Why this isn't done today

Honest scope: building this is ~3-4 focused sessions. The single-textarea Loom notebook was always a **stub** disguised as functional — it persisted code, called Run, but had none of the Fabric-parity UX. The wiring-audit graded it A (renders, calls Spark) but should have been **D** (single textarea isn't a notebook).

Updating wiring-audit.md to D for notebook until the cell-based rebuild ships.
