# Loom data-pipeline editor — Fabric parity gap (v2 validator, 2026-05-26)

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


> Validator agent: independent fabric-parity-loop v2 validator
> Loom build under test: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net` (Azure Front Door)
> Loom routes tested: `/items/data-pipeline/new` (DataPipelineEditor) AND `/items/adf-pipeline/new` (AdfPipelineEditor)
> Fabric reference: see `docs/fiab/data-pipeline-parity-spec.md` (Phase-1 catalog spec) — live Fabric capture was BLOCKED on MSAL re-auth, see Phase 1 note below.

## Final grade: **D**

Multiple BLOCKERs: no Monaco JSON editor, DAG has no real SVG arrows, the editor has no Validate / Schedule / Trigger / Copilot ribbon actions, no activity-library sidebar, no properties pane. Several ribbon buttons are silently dead (BROKEN per `no-vaporware.md`). The /new route is barely past "workspace picker" — without picking a workspace and creating a pipeline you cannot exercise the editor at all.

Rationale below.

## Phase 1 — Fabric reference capture

**Status: BLOCKED on MSAL.** Playwright session does not have a usable Fabric token (the validator session is signed in to Loom but the Fabric portal at `https://app.fabric.microsoft.com` triggers an interactive MSAL redirect and there is no headless way to complete it). Per the validation-standard failure-handling protocol, I am proceeding using the Phase-1 catalog spec already captured in this repo by a prior catalog agent on 2026-05-26.

Reference document used in lieu of live capture: `docs/fiab/data-pipeline-parity-spec.md` (`pl_casino_medallion_daily` + `Pipeline_1` template in casino-fabric-poc workspace). That spec was produced by a sibling Explore agent following the same standard, and matches the public Fabric Data Factory docs.

Screenshot placeholder: `temp/parity/data-pipeline-fabric.png` (MSAL login page — proof that interactive auth is required).

## Phase 2 — Loom under test capture

Screenshot: `temp/parity/data-pipeline-loom.png` (captured at h1="New data pipeline", URL=`/items/data-pipeline/new`).

DOM marker dump: `temp/parity/data-pipeline-loom.dump.json`:

```json
{ "url": "/items/data-pipeline/new",
  "h1": "New data pipeline",
  "monaco": 0,
  "textareas": 0,
  "svgs": 10,             // 10 button-icon SVGs only
  "svgLines": 0,          // ZERO line elements
  "polylines": 0,         // ZERO polyline elements
  "activityNodes": 0,     // ZERO data-activity-name nodes
  "paletteButtons": [],   // ZERO data-palette-type buttons
  "ribbonTabs": ["Home", "data pipeline · new", ...]
}
```

ADF Pipeline secondary route (`/items/adf-pipeline/new`) does render the palette and tabs, but no pipeline is actually authored:

```json
{ "h1": "New adf pipeline",
  "monaco": 0, "textareas": 0,
  "buttons": ["Copy data","Mapping data flow","Notebook","SP","Debug","Add trigger",
              "Publish all","+ New pipeline","Save","Run","Refresh",
              "Graph (0 acts)","Spec (JSON)","Run history (0)",
              "Copy","Notebook","Dataflow","Lookup","ForEach","IfCondition","Wait","ExecutePipeline"] }
```

After clicking the `Copy` palette button on `/items/adf-pipeline/new` (no pipeline selected):

```json
{ "activityNodes": 0, "svgLines": 0, "captionEdges": [] }
```

No node added — palette requires a selected pipeline first.

## Phase 3 — Side-by-side gap matrix

| # | Fabric element (from parity-spec.md) | Loom presence (`/items/data-pipeline/new`) | Severity |
|---|---|---|---|
| 1 | Title bar with pipeline name + label dropdown | Loom shows "New data pipeline" title only — no label dropdown | MINOR |
| 2 | Multi-tab open item support (color-coded item icons) | Tab strip exists but no per-tab item icon colors | MINOR |
| 3 | **Ribbon — Home tab**: Validate / Run / Schedule / Trigger / View run history | Loom ribbon has only `Run / Run history / New pipeline / Save / Delete` (5 labels). **No Validate, no Schedule, no Trigger.** | **BLOCKER** |
| 4 | Activity quick-add buttons in ribbon (Copy data / Dataflow / Notebook / Lookup / Invoke Pipeline) | Absent on DataPipelineEditor `/items/data-pipeline/new`. Adf-pipeline route has them only in the DAG palette, not in the ribbon. | MAJOR |
| 5 | Copilot AI button (NL pipeline build) | Absent | MAJOR |
| 6 | **Ribbon — Activities tab** (full activity library/toolbox) | Absent — there is only the "Home" ribbon tab | **BLOCKER** |
| 7 | **Ribbon — Run tab** (execution + debug controls) | Absent | MAJOR |
| 8 | **Ribbon — View tab** (zoom + layout + minimap toggle) | Absent | MAJOR |
| 9 | **Left sidebar — Activity Library** (Move+Transform, Compute, Iteration+Conditional, Lookup+Metadata, External, Office groups with drag-drop) | Absent. Left pane is a "Pipelines (n)" tree of existing pipelines — no activity catalogue. | **BLOCKER** |
| 10 | **Canvas with drag-drop, branching, click-to-select, right-click context** | Absent. PipelineDagView renders `<div>` boxes in column layout (per `apps/fiab-console/lib/components/pipeline/pipeline-dag-view.tsx` lines 343-368). No drag, no zoom, no right-click. | **BLOCKER** |
| 11 | **Connector arrows** (success=green, failure=red, completion=blue, skip=gray) — SVG/Canvas | **Absent.** `svgLines: 0, polylines: 0, markers: 0`. Code review of pipeline-dag-view.tsx confirms edges are rendered as a single `<Caption1>` text paragraph: `{edges.slice(0, 5).map((e, i) => <span>...{e.from} → {e.to}...</span>)}` (line 376-381). The "edgeOverlay" class is declared (line 72-76) but never instantiated. **The comment at line 12 ("SVG overlay draws ... arrows") is inaccurate.** | **BLOCKER** |
| 12 | **Right pane — Properties (5 tabs: Parameters / Variables / Settings / Output / Library variables)** | **Absent.** No properties pane of any kind. Pipeline definition is edited as **raw JSON in a plain `<textarea>`** (data-pipeline-editor.tsx line 322). | **BLOCKER** |
| 13 | Canvas controls (right edge): zoom in/out, fit-to-screen, pan, full-screen, minimap | Absent | MAJOR |
| 14 | Schedule + Trigger UI (frequency, start/end date+time, timezone, advanced recurrence; time/event/manual triggers) | Absent. Per parity-spec note "currently `state.schedule` JSON". | MAJOR |
| 15 | Empty-state wizard (Blank / Guidance / Copy-data assistant / Sample / Templates) | Absent | MINOR |
| 16 | Run history drill-down (per-activity status, duration, rows R/W, logs, error stack, I/O JSON, rerun-from-failed, cancel) | Loom has a flat run-history table with: Job ID / Status / Invoke / Start / End / Failure — no drill-down, no per-activity expansion, no rerun-from-failed | MAJOR |
| 17 | Validate (syntax + missing-config + cycle detection + errors/warnings pane) | Absent | MAJOR |
| 18 | **Monaco editor for Pipeline JSON** (or DAG editor that abstracts JSON entirely) | **Absent.** Loom uses `<textarea>` (data-pipeline-editor.tsx line 322). No syntax highlighting, no schema-validation squiggles, no IntelliSense for ADF pipeline JSON shape. | **BLOCKER** (per fabric-parity-loop v2 build contract section 1) |

### Severity tallies

- BLOCKER: 6 rows
- MAJOR: 8 rows
- MINOR: 3 rows
- COSMETIC: 0

## Phase 4 — Functional click-every-button verification

Tested via Playwright `evaluate` on `/items/data-pipeline/new` (no workspace selected, since selecting one requires Fabric workspace data the validator cannot guarantee is reachable in this session):

| Loom control | Source | State | Click effect | Verdict |
|---|---|---|---|---|
| Ribbon "Run" label | RIBBON definition in data-pipeline-editor.tsx line 31-36 | enabled | dialogs 0→0, alerts 0→0, url unchanged | **BROKEN — silently dead** |
| Ribbon "Run history" label | same | enabled | no-effect | **BROKEN — silently dead** |
| Ribbon "New pipeline" label | same | enabled | no-effect | **BROKEN — silently dead** |
| Ribbon "Save" label | same | enabled | no-effect | **BROKEN — silently dead** |
| Ribbon "Delete" label | same | enabled | no-effect | **BROKEN — silently dead** |
| Workspace toolbar "Refresh" | inline | enabled | fires `/api/loom/workspaces` GET (not verified in this run — needs workspace data) | unverified |
| Workspace toolbar "New" | inline | disabled until workspace selected | (correctly gated) | OK |
| Workspace toolbar "Save" | inline | disabled until pipelineId | (correctly gated) | OK |
| Workspace toolbar "Run" | inline | disabled until pipelineId | (correctly gated) | OK |
| Workspace toolbar "Delete" | inline | disabled until pipelineId | (correctly gated) | OK |

**Side check** on `/items/adf-pipeline/new` (AdfPipelineEditor — also DAG-based):

- Palette buttons (Copy / Notebook / Dataflow / Lookup / ForEach / IfCondition / Wait / ExecutePipeline) render and have `data-palette-type` markers. Click was attempted with no workspace/pipeline selected → **no activity added** (`activityNodes: 0`). The AdfPipelineEditor `addActivity` callback (azure-services-editors.tsx line 896) only fires when a pipeline is `selected`.
- Spec (JSON) tab → renders a `<textarea>` with class name `s.monaco` that is **not actually Monaco** (azure-services-editors.tsx line 901-908). The class name is misleading.

### Honesty-check verdicts (the two specific user callouts in `no-scaffold-claims.md`)

| Honesty check | Verdict |
|---|---|
| **"The DAG renders `<div>` boxes in vertical columns and prints `A → B` as text — no SVG arrows."** | **CONFIRMED.** Live DOM probe of `/items/data-pipeline/new` and `/items/adf-pipeline/new` shows `svgLines: 0, polylines: 0`. Code review of pipeline-dag-view.tsx lines 343-385 confirms edges are a single `<Caption1>` text paragraph rendering `{e.from} → {e.to}{cond ? ` (cond)` : ''}`. The `edgeOverlay` style is declared (line 72-76) but never rendered. |
| **"The JSON / SQL editor is a `<textarea>`, not Monaco."** | **CONFIRMED.** `document.querySelectorAll('[class*="monaco-editor"]')` returns 0 across `/items/data-pipeline/new`, `/items/adf-pipeline/new`, `/items/warehouse/new`, `/items/synapse-dedicated-sql-pool/new`. Repo-wide grep for `monaco-editor` returns 0 matches in `apps/fiab-console/`. |

## Grading rationale

Per parity-validation-standard rubric (STRICTEST observed):

- Phase 3 has 6 BLOCKER rows (no Monaco; no DAG arrows; no Activities ribbon; no Activity Library sidebar; no canvas; no properties pane) → **C** is the ceiling.
- Phase 4 has 5 BROKEN ribbon controls (Run / Run history / New pipeline / Save / Delete are dead clickable labels) → **D**.
- Per Build-phase contract section 1, **no editor that uses a textarea where Monaco is required can grade above C**. Combined with 5 BROKEN primary-action ribbon controls → **D**.

**Final grade: D.** Loop back to Build phase.

## Recommended Build-phase remediation (ordered by impact)

1. **Wire the ribbon labels to actual handlers** (or remove them). The `RIBBON` constant in data-pipeline-editor.tsx must produce buttons whose onClick fires `run` / `loadJobs` / `createNew` / `save` / `del` respectively. As-is they are 5 vaporware controls. Same for AdfPipelineEditor (RIBBON at azure-services-editors.tsx — needs onClick wired). Same for WarehouseEditor's `WH_RIBBON`.
2. **Replace `<textarea>` with `@monaco-editor/react`** for the Pipeline JSON editor (data-pipeline-editor.tsx line 322 and azure-services-editors.tsx line 901). Configure `language="json"` with a custom completion provider for ADF Pipeline schema (activities array shape, dependsOn dependencyConditions, common typeProperties). Add JSON schema validation via `setModelMarkers`.
3. **Add real SVG arrows to PipelineDagView**: render an absolute-positioned `<svg>` overlay (`edgeOverlay` class is already declared) with `<line>` or `<path>` elements between activity nodes, computing source-card right-edge → target-card left-edge coordinates using `getBoundingClientRect`. Color by `dependencyConditions` per existing `COND_COLORS` map. Use `<marker>` for arrowheads.
4. **Build an Activities sidebar pane** (left side, separate from the existing Pipelines tree) containing drag-drop activity categories: Move+Transform / Compute / Iteration+Conditional / Lookup+Metadata / External / Office. Each leaf drags onto the canvas to append an activity (drop coordinates set the rank).
5. **Build a Properties right pane** with 5 tabs (Parameters / Variables / Settings / Output / Library variables) bound to the parsed pipeline JSON. Edits flow back through `setDefText`.
6. **Add a real Validate action**: client-side parse + activity-graph cycle detection + missing-config check. Surface inline errors in a "Messages" tab at the bottom of the canvas.
7. **Add Schedule + Trigger guided forms** that compile to an ADF Trigger payload and call `/api/items/data-pipeline/[id]/schedule` (currently absent — needs backend route too).
8. **Run history drill-down**: per-row expand to fetch `/api/items/data-pipeline/[id]/jobs/[runId]` and render the per-activity status grid.

Estimated effort to reach **B**: 4-5 focused sessions (Monaco swap = 0.5; ribbon wiring = 0.5; SVG arrows = 1; Activities pane = 1; Properties pane = 1; Validate + Schedule + Trigger forms = 1).

To reach **A** add: real drag-drop on the canvas + zoom/pan/minimap + run-history drill-down + Copilot NL build.

## Receipts

- `temp/parity/data-pipeline-fabric.png` (MSAL block page)
- `temp/parity/data-pipeline-loom.png` (live, h1="New data pipeline")
- `temp/parity/data-pipeline-loom.dump.json` (DOM marker dump)
- `temp/parity/data-pipeline-loom.snapshot.yml` (a11y snapshot; may have rotated mid-capture due to known tab-rotator instability)
- `temp/parity/data-pipeline-ribbon-clicks.json` (5 BROKEN clicks)
- `temp/parity/adf-pipeline-loom.dump.json` (adf-pipeline variant)
- `temp/parity/adf-pipeline-palette-click.json` (palette click → 0 new activities)
- Source code references: `apps/fiab-console/lib/editors/data-pipeline-editor.tsx`, `apps/fiab-console/lib/editors/azure-services-editors.tsx`, `apps/fiab-console/lib/components/pipeline/pipeline-dag-view.tsx`
- Reference spec: `docs/fiab/data-pipeline-parity-spec.md`

## Side-finding (not in the rubric but worth flagging)

The live Loom production app has a **runtime tab-rotator that auto-changes the URL every ~3-6 seconds** without user input. Concretely: `await page.goto('/items/data-pipeline/new')` → URL stays for ~150-200 ms → URL changes to `/items/notebook/...`, then `/items/eventstream/...`, then `/items/semantic-model/...`, etc. Console logs show `Failed to fetch RSC payload for ...` errors at the same cadence. This is a stability blocker that affects ALL editors and was not caused by the validator — `await page.evaluate(...)` calls had their execution context destroyed mid-eval. Likely a Next.js RSC prefetch loop interacting with a tabs-state mutation. Worth opening a separate bug.
