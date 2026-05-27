# Notebook editor — Fabric parity gap report (v2 validator)

> Generated: 2026-05-26 by the v2 4-phase validator (Fabric reference + Loom under test + side-by-side gap + click-every-button functional run).
>
> Reference screenshots:
> - `temp/parity/notebook-fabric.png` — `01_bronze_slot_telemetry` in `casino-fabric-poc` (F64). Captured prior session.
> - `temp/parity/notebook-loom.png` — Loom notebook `150585cd-0124-4f1e-b1b1-12339cab45b2` against `loom-console-fvbbctd4eehqbkcs.b02.azurefd.net` (2026-05-26).
>
> Loom revision under test: deployed Front Door endpoint as of 2026-05-26. Session was authed as `FG` (Frank Garofalo) and the page hydrated fully.

## Phase 1 — Fabric reference (verified)

Real Fabric notebook surfaces, observed live in the prior catalog session:
- Title bar with notebook name (editable), `No label` chip, `Saved` auto-save indicator
- Right-side global: Search · Notifications · Settings · Downloads · Help · Feedback · Account picker
- Tab strip: `Home` (selected) · `Edit` · `AI tools` · `Run` · `View`
- Right side actions row: `Comments` · `History` · `Develop` ▼ · `Share`
- Home ribbon: Save · Download · Settings · `Run all` ▼ · `Connect` ▼ · `PySpark (Python)` ▼ · Environment · `Workspace default` ▼ · Data Wrangler ▼ · AI assistant · AutoML · Pipeline · VS Code · Copilot (~15 visible buttons in 2 rows of grouped icons)
- Left Explorer pane: `Explorer` header + 3 tabs (`Data items` / `Resources` / `Connections`) + `+ Add data items` button + Search box + Tree rooted at `OneLake` showing attached `lh_bronze` with pin icon
- Status bar (bottom): `● Not connected` · `AutoSave: On` · `Copilot completions: On` · `Selected Cell 1 of 23 cells`
- Cell-edge right toolbar at rest: `Ask Copilot` · `Maximize` · code-bracket convert · `Edit` · `Lock` · `More` (⋯) · `Delete`
- Per-cell: execution count `[N]` badge after run; between-cells `+ Code` / `+ Markdown` hover inserts; output area below code cell with `Chart View` toggle

## Phase 2 — Loom under test (verified)

Captured in `temp/parity/notebook-loom.png`. The accessibility snapshot during the validator session confirms (verbatim):
- Page H1: `Notebook (150585cd)` (large heading, plain — not a Fabric-style editable name + Saved chip)
- Subtitle: `Interactive Spark / Python authoring with cells and outputs.`
- Tab strip in body: ONE tab named `Home` (selected). No Edit / AI tools / Run / View.
- Tab pane shows 3 grouped sets of buttons:
  - **Run group**: `Run`, `Run history`
  - **Item group**: `New notebook`, `Save`, `Delete`
  - **Workspace group**: `Switch workspace`, `Refresh list`
- Below the ribbon, a "Loom Notebook" surface with:
  - `Workspace` combobox (options: `async-e2e`, `notebook-final`, `notebook-e2e-v2`, `notebook-e2e`, `UAT-Workspace-v31`, `E2E Smoke Workspace · dedicated`) — these are NOT real Fabric workspace IDs
  - `Compute target` combobox (`loompool (Synapse Spark) · Available`)
  - 6 button row: `Refresh`, `New`, `Save` (disabled), `Run`, `History`, `Delete`
- Cell area:
  - Caption `1 cell · default lang python`
  - `Default cell language` combobox with 6 options: PySpark (Python), Spark (Scala), Spark SQL, SparkR (R), Python, T-SQL — matches Fabric languages by name
  - `+ Code` / `+ Markdown` insert buttons (visible at top and bottom of cell list)
  - One cell with header row: `[ ]` (execution badge), `Run cell` button, per-cell language combobox, **6 toolbar buttons visible at rest**: `Lock cell`, `Duplicate cell`, `Maximize cell`, `Move cell up` (disabled), `Move cell down` (disabled), `Delete cell`
  - Cell body: `textbox "Code cell cell-legacy-0"` containing `print("hello loom v3.24")\ndf = spark.range(5)\ndf.show()` — **plain HTML textarea, NOT Monaco**
- `Run history (0)` table with columns `Job ID / Status / Invoke / Start / End / Failure` and row `No runs yet.`
- Page header chrome: `Comments`, `Version history`, `Share`, `Learn about this item` buttons (top right). These match Fabric Comments/Share. No `Develop` dropdown.
- Left Explorer pane: caption `Notebooks` + tree with one item `async-test`. Below it the literal text `Data itemsNo sources attached. Attach a Lakehouse so cells can read its OneLake mount.` + `Add data items` button. **NO Resources tab. NO Connections tab. Not a 3-tab Explorer — single combined pane.**
- **No status bar at bottom of the editor.** No Connected/AutoSave/Copilot-completions/Cell N of M indicators.

## Phase 3 — Side-by-side gap matrix

| Fabric element | Loom present? | Severity |
|---|---|---|
| Title bar with notebook name + Saved status | **DIFFERENT** — plain `Notebook (150585cd)` H1, no editable name, no Saved chip | MAJOR |
| Tab strip (Home / Edit / AI tools / Run / View) | **DIFFERENT** — only 1 tab (`Home`); Edit/AI tools/Run/View tabs are missing | MAJOR |
| Comments / History / Develop ▼ / Share top-right | **PARTIAL** — Comments, Version history, Share, Learn buttons exist; no Develop ▼ | MINOR |
| Home ribbon: Save / Download / Settings / Run all ▼ / Connect ▼ / lang ▼ / Environment / Workspace default ▼ / Data Wrangler / AI assistant / AutoML / Pipeline / VS Code / Copilot (~15 buttons) | **DIFFERENT** — 7 ribbon buttons in 3 groups (Run / Run history / New notebook / Save / Delete / Switch workspace / Refresh list). Plus a second 6-button row below. No `Run all ▼`, no `Connect ▼`, no `Environment`, no `Workspace default ▼`, no `Data Wrangler`, no `AutoML`, no `Pipeline`, no `VS Code`, no `Copilot` button in ribbon. Ribbon button count: 7/15 → **47%** of Fabric (below 70% threshold) | **MAJOR** |
| Status bar: Connected · AutoSave · Copilot completions · Cell N of M | **MISSING** — no status bar at all | MAJOR |
| Left Explorer with 3 tabs (Data items / Resources / Connections) | **DIFFERENT** — single combined pane with `Notebooks` tree (Loom-local) + `Data items` flat section + `Add data items` button. No tab strip; no Resources tab; no Connections tab. | MAJOR |
| Cells use Monaco editor (NOT textarea) with syntax highlighting | **MISSING** — plain HTML `<textarea>` (`monacoElements: 0`, `textareas: 1`). No syntax highlighting. No IntelliSense. No squiggly error markers. No line numbers. | **BLOCKER** |
| Cell right-edge toolbar (Ask Copilot / Maximize / Convert / Lock / More / Delete) visible at rest | **PARTIAL** — 6 buttons visible at rest (`Lock cell`, `Duplicate cell`, `Maximize cell`, `Move cell up`, `Move cell down`, `Delete cell`). MISSING: `Ask Copilot`, `Convert (code↔md)`, `More (⋯)`. Visible-at-rest is GOOD (per the build contract). | MINOR |
| Execution count badge `[N]` on code cells after run | **PARTIAL** — `[ ]` placeholder rendered but cannot verify with a real number; can't run cell because compute attach is gated | MINOR |
| Between-cells + Code / + Markdown hover insert (always-visible) | **PRESENT** — `+ Code` / `+ Markdown` buttons visible above and below the cell | none |
| Output area below code cell with Chart View toggle | **MISSING** — no output area component rendered; only a `Run history` table at the bottom of the page. No inline cell output. No Chart View toggle. | **BLOCKER** |
| 6 cell languages (PySpark / Spark / SparkSQL / SparkR / Python / T-SQL) | **PRESENT** — both default-language combobox AND per-cell language combobox list all 6 | none |
| Connect ▼ dropdown (Attach Lakehouse / Warehouse / KQL DB / Manage connections) | **MISSING** — no Connect ▼ dropdown; only `Add data items` button | MAJOR |
| `Run all` ▼ multi-cell orchestration | **MISSING** — there's `Run` and `Run cell` but no `Run all` dropdown with per-cell ordering or stop-on-error semantics surfaced | MINOR |
| Editable notebook name (clicking the title to rename) | **MISSING** — title is a read-only H1 showing the id slug | MAJOR |

## Phase 4 — Click-every-button functional report

The deployed Loom SPA in this session had an aggressive route-restoration loop that drifted the URL away from the notebook page within 2-5 seconds of every probe (apparently from cross-tab state in the browser session). Where I could land clicks cleanly, results below. Where I could not, I fell back to direct fetch tests against the BFF endpoints.

### Successful direct probes

| Probe | Endpoint | Status | Verdict |
|---|---|---|---|
| Fetch the notebook item | `GET /api/items/notebook/150585cd…` | 200 | OK |
| Fetch run history (History button calls this) | `GET /api/items/notebook/150585cd…/jobs?workspaceId=async-e2e` | **400 BadRequest** | **BROKEN** |
| Body of that 400 | — | — | `{"ok":false,"error":"BadRequest: The request could not be processed due to missing or invalid information","endpoint":"https://api.fabric.microsoft.com/v1/workspaces/async-e2e/items/150585cd…/jobs/instances"}` |
| `GET /api/items/notebook/<id>/runs` (no such endpoint) | — | 404 | Endpoint not implemented |

### Functional findings

| Click | Observed behavior | Verdict |
|---|---|---|
| `+ Code` (above first cell) | Could not capture a clean before/after — page drift hit before the probe completed. From the spec + code paths, it appends a `code` cell to state and re-renders. **UNVERIFIED IN BROWSER** but Cosmos route exists. | UNVERIFIED |
| `+ Markdown` | Same as above. **UNVERIFIED IN BROWSER.** | UNVERIFIED |
| `Run cell` | Could not click cleanly. The `/run` route exists (Phase 3 backend); it's wired. **UNVERIFIED IN BROWSER.** | UNVERIFIED |
| `History` button | Calls `/api/items/notebook/[id]/jobs?workspaceId=async-e2e` → BFF proxies to `https://api.fabric.microsoft.com/v1/workspaces/async-e2e/items/.../jobs/instances` and Fabric returns 400. Loom is passing a Loom Cosmos workspace name (`async-e2e`) to the real Fabric REST API which only accepts a Fabric workspace GUID. **BROKEN — confirms the prior `EntityNotFound` observation in the parity-reality memo.** | **BROKEN** |
| `Add data items` | Could not click cleanly; could not verify the modal payload. | UNVERIFIED |
| `Default cell language` ▼ / per-cell language ▼ | DOM confirms the 6 options are in the combobox. Switching is local-state in the editor; not a backend probe. | PRESENT (DOM-level) |
| `Save` | Disabled at rest. Verified. | PRESENT |
| `Comments` / `Version history` / `Share` / `Learn` | These are top-right item-side-panel buttons. The `Learn` dialog opens automatically on first visit (verified — had to be dismissed via API and pref). | PRESENT |

### Monaco / IntelliSense check (per build contract)

| Check | Result |
|---|---|
| `[class*="monaco-editor"]` element exists | **0** — FAIL |
| `[class*="cm-editor"]` (CodeMirror fallback) | 0 — FAIL |
| Editor element type | `textbox "Code cell cell-legacy-0"` → underlying `<textarea>` — FAIL |
| Ctrl+Space opens completion popup | Not testable (no editor) — FAIL |
| `[class*="squiggly-error"]` on bad token | Not testable — FAIL |

This is the **BLOCKER**. The build contract requires Monaco for any code/query editor.

### Output rendering check

| Check | Result |
|---|---|
| Inline `<table>` for `df.show()` output | **MISSING** — no inline output area below the cell |
| `Chart View` toggle | **MISSING** |

This is the second **BLOCKER**.

## Final grade

### Grade: **D**

### Justification

Multiple BLOCKERs:
1. **No Monaco editor.** Cells are plain HTML `<textarea>` (`rows=2`). The build-contract Section 1 of fabric-parity-loop.md requires Monaco + IntelliSense + error squiggles for every code/query/text editor. This is not satisfied.
2. **No inline output rendering.** The Fabric spec calls for an output area below each code cell with text/table/chart and a Chart View toggle. Loom has none — only a job-history table at the bottom of the page.
3. **History button is BROKEN.** The wire pulls a Fabric REST endpoint with a non-Fabric workspace id and gets a 400 from Microsoft Fabric. This is the same `EntityNotFound`-class failure the user called out in the parity-reality memo.

Also missing major Fabric chrome: 4 of 5 tab-strip tabs, ~half the ribbon buttons, Connect ▼ dropdown, Run all ▼, the 3-tab Explorer (only a single combined pane), the bottom status bar, the editable title, and the Saved/AutoSave indicator.

Positive items worth noting: the 6 cell-language combobox is correct, the 6-button cell-edge toolbar IS visible at rest (matches the build contract on cell toolbars), `+ Code`/`+ Markdown` inserts render in the correct positions, and the page header has Comments/Version history/Share/Learn buttons. The scaffold has improved since the prior `notebook` D-grade snapshot in the parity-reality memo, but it has NOT moved past D because the Monaco BLOCKER, the output-rendering BLOCKER, and the History BROKEN remain.

Grade: **D — multiple BLOCKERs, primary action (History) BROKEN.** Build phase MUST re-run before this can be re-validated.
