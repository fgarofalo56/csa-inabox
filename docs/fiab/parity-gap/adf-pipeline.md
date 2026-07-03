# Parity gap — `adf-pipeline`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure Data Factory Studio → Author → Pipelines.
> Loom route: `https://<your-console-hostname>/items/adf-pipeline/new`.
> Editor source: `apps/fiab-console/lib/editors/azure-services-editors.tsx` (lines 739-943); shared canvas at `apps/fiab-console/lib/components/pipeline/pipeline-dag-view.tsx`.

## Phase 3 — gap matrix vs ADF Studio Author

This is structurally identical to `synapse-pipeline` — the same `PipelineDagView` component, same JSON tab with `<textarea>`, same 3-tab layout, same ribbon-vapor. ADF Studio is the canonical reference for what a pipeline editor should look like (Synapse Studio inherited from ADF). The same gaps apply.

| # | ADF Studio canvas element | Loom present? | Severity |
|---|---|---|---|
| 1 | Graph tab with **SVG arrows** (success/fail/completion/skip colored arrows with arrowheads) | **MISSING SVG ARROWS** — pipeline-dag-view.tsx renders edges as `<Caption1>` text spans `{from} → {to}` (lines 369-384), not SVG `<path>` elements | **BLOCKER** |
| 2 | Drag-to-position activities + auto-route | MISSING — column-based topo layout | MAJOR |
| 3 | Activity properties pane (right side panel — General / Settings / Parameters / User properties) | MISSING | MAJOR |
| 4 | Activity-type palette with ~50 types | Partial — 8 button palette (Copy / Notebook / Dataflow / Lookup / ForEach / IfCondition / Wait / ExecutePipeline) | MAJOR |
| 5 | JSON code view with Monaco + ADF schema validation | **MISSING Monaco** — `<textarea>` (lines 900-908) | **BLOCKER** |
| 6 | Pipeline tree with folders + New pipeline button | Present partial — list + "+ New pipeline" button (lines 857-870) | OK partial |
| 7 | Save + Run + Refresh | Present (lines 875-882) | OK |
| 8 | Run history with status drill-into per-activity | Partial — runs table only, no per-activity drill | MAJOR |
| 9 | Validate (sees ADF backend's schema-validation report) | MISSING | MINOR |
| 10 | Debug mode with breakpoints | MISSING | MINOR |
| 11 | Add trigger / Publish all ribbon actions | Ribbon-vapor (lines 718-721) | MINOR |
| 12 | Parameters / Variables / Settings / Output tabs (bottom pane) | MISSING — only Graph / JSON / Runs tabs | MAJOR |
| 13 | Activity-level right-click → Edit / Disable / Duplicate / Delete | MISSING | MAJOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| **Save** | `save()` (line 786-800) — real `PUT /api/items/adf-pipeline/{name}` | Real |
| **Run** | `run()` (line 802-816) — real `POST .../run` | Real |
| **Refresh** | `loadPipeline + loadRuns` | Real |
| **+ New pipeline** | `createNew()` (line 818-833) — real `POST` with empty `properties.activities = []`, uses `window.prompt` for name | Real |
| Palette buttons | `addActivity` (line 842-852) — same mutation pattern as synapse-pipeline | Real |
| Pipeline tree leaf | `setSelected(name)` | Real |
| Tab switch | `setTab` local state | Real |
| Activity node click on graph | No handler — node read-only | **DEAD** |
| Ribbon "Copy data" / "Mapping data flow" / "Notebook" / "SP" / "Debug" / "Add trigger" / "Publish all" | No handlers | **DEAD** — 7 ribbon vapor |

## Grade

**D** — same shared DAG component as synapse-pipeline produces the same BLOCKER (no SVG arrows). Same JSON-tab textarea BLOCKER. Same 7-button ribbon vapor. Same lack of per-activity edit dialog.

Critically: this is the canonical reference editor — ADF Studio is the platonic ideal of what a pipeline editor looks like. Loom currently delivers a "headless ADF" (CRUD against `/datafactory/.../pipelines/{name}`) without the canvas chrome that makes ADF Studio usable for non-experts. Save / Run / Refresh / Add-activity-via-palette work, so this isn't F. But by the `parity-validation-standard` rubric, "multiple BLOCKERs (no SVG arrows + no Monaco)" = D.

Remediation is the same as `synapse-pipeline` — they share the component.

