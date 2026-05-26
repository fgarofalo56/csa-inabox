# Parity gap — `synapse-pipeline`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure Synapse Studio → Integrate → Pipelines (visual canvas + JSON code view).
> Loom route: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/synapse-pipeline/new`.
> Editor source: `apps/fiab-console/lib/editors/azure-services-editors.tsx` (lines 391-577); shared canvas at `apps/fiab-console/lib/components/pipeline/pipeline-dag-view.tsx`.

## Phase 3 — gap matrix vs Synapse Studio Integrate

| # | Fabric / Synapse Studio canvas element | Loom present? | Severity |
|---|---|---|---|
| 1 | Graph tab with **SVG arrows** between activities (success/failure/completion/skipped colored edges with arrowheads) | **MISSING SVG ARROWS** — pipeline-dag-view.tsx defines an `edgeOverlay` CSS class (lines 72-76) but never renders an `<svg>` element. Edges are emitted as a `<Caption1>` text line: `{e.from} → {e.to}` (lines 369-384). The Unicode `→` arrow is the only visual edge indicator. | **BLOCKER** |
| 2 | Drag-to-position activity boxes on canvas | MISSING — column-based topological layout, no drag (computed via `computeRanks` line 146-167) | MAJOR |
| 3 | Right-click / context menu on activity → Edit / Delete / Disable / Duplicate | MISSING — no `onContextMenu`, no popovers | MAJOR |
| 4 | Activity properties side-pane (per-activity typeProperties form) | MISSING — only JSON tab is editable | MAJOR |
| 5 | Activity palette (drag-to-add OR click-to-add for 50+ activity types) | Partial — 8 click-to-add palette entries (Copy/Notebook/Dataflow/Lookup/ForEach/IfCondition/Wait/ExecutePipeline) at lines 183-235. Fabric/Synapse have ~50 activity types. | MAJOR |
| 6 | JSON spec editor with Monaco + JSON schema validation against ADF pipeline schema | **MISSING Monaco** — plain `<textarea>` (lines 535-543) | **BLOCKER** |
| 7 | Pipeline list tree (with folders) | Present (lines 493-505) — flat list, no folder grouping | MINOR |
| 8 | Run history with status badges + drill-into activity-level run details | Present partial (lines 545-573) — table with status, start, duration, invoked-by; no drill-into-activity | MAJOR |
| 9 | Trigger management inline (Add trigger / Trigger now) | MISSING — ribbon claims "Triggers", no handler. Triggers exist as separate editor `adf-trigger`. | MINOR |
| 10 | Debug mode (run a single activity, set breakpoints) | MISSING — ribbon claims "Debug", no impl | MINOR |
| 11 | Parameters / Variables / Settings / Output tabs (bottom pane) | MISSING — only Graph / JSON / Runs tabs | MAJOR |
| 12 | Save button + dirty-state indicator | Present (lines 513) — real PUT, dirty bit tracked | OK |
| 13 | Run / Debug / Add trigger / Publish all ribbon | Buttons exist as RibbonTab pills (lines 371-373) but no `onClick` handlers — ribbon-vapor | **DEAD ribbon** |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| **Save** | `save()` (line 438-452) — real `PUT /api/items/synapse-pipeline/{name}` | Real |
| **Run** | `run()` (line 454-469) — real `POST /api/items/synapse-pipeline/{name}/run` | Real |
| **Refresh** | `loadPipeline + loadRuns` | Real |
| Tab switch (Graph / JSON / Runs) | `setTab(...)` — local state | Real |
| Palette button (Copy / Notebook / Dataflow / etc.) | `addActivity()` — mutates JSON spec via `JSON.parse → push → JSON.stringify` (lines 477-487) | Real |
| Pipeline tree leaf | `setSelected(name)` | Real |
| Activity node on graph | No onClick handler — node is read-only | **DEAD** (can't click an activity to edit it) |
| Ribbon "Copy data" / "Notebook" / "Stored procedure" / "Mapping data flow" / "Run" / "Debug" / "Triggers" | No handlers (RibbonTab `actions[].label` only) | **DEAD** — 7 ribbon vapor |

## Grade

**D** — multiple BLOCKERs.

The graph tab is the headline feature of any pipeline editor; here it renders activities as styled `<div>` boxes in columns with edges shown as a one-line text caption (`{from} → {to}`). The very rule in `no-scaffold-claims` memory explicitly calls this out as the 2026-05-26 regression: "renders columns of `<div>` boxes with NO ARROWS — edges shown as a paragraph caption". The validator confirms: pipeline-dag-view.tsx:369-384 still emits edges as text spans inside a `<Caption1>`, not SVG `<path>` elements. The `edgeOverlay` CSS class is defined but not used.

Plus the JSON tab is a textarea (BLOCKER #2), 7 ribbon buttons are dead, no Properties/Parameters/Output side panes, no per-activity edit dialog.

Save + Run + Refresh + palette-add are real, which keeps this above F.

Remediation: render a proper `<svg>` overlay with computed `<path d="M..."/>` lines + arrowhead `<marker>` between activity nodes (use the per-node `id="activity-node-{name}"` already emitted at line 351); replace JSON `<textarea>` with `@monaco-editor/react language="json"`; wire activity-node clicks to a Properties pane.

