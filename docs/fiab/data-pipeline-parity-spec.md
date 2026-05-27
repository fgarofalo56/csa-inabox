# Loom Data Pipeline Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `aff49f5c28912ff78`. Source: live `pl_casino_medallion_daily` + `Pipeline_1` (empty template) in `casino-fabric-poc` + Fabric Data Factory docs.

## Overview
No-code/low-code visual orchestration. Drag-drop activity canvas, ribbon-driven actions, properties pane for parameters/variables/settings, full Schedule + Trigger + Run History. Loom equivalent today = ADF proxy (real Azure Data Factory) wired via the `data-pipeline` editor route group.

## UI components

### Title bar + tab strip
- Pipeline name with label dropdown ("No label" default)
- Multi-tab open item support (Pipeline, Notebook, Dataflow, Eventhouse, etc.) with color-coded icons (Notebook=blue, Pipeline=green)
- Per-tab close (X)

### Ribbon (4 tabs)
**Home** (default active):
- **Validate** (checkmark icon)
- **Run** (play icon)
- **Schedule** (calendar icon)
- **Trigger** (lightning bolt + dropdown)
- **View run history** (history icon)
- Activity quick-add buttons: **Copy data · Dataflow · Notebook · Lookup · Invoke Pipeline**
- **Copilot** (AI icon) — NL pipeline build

**Activities**: full activity library/toolbox surface

**Run**: execution + debug controls

**View**: zoom + layout + minimap toggle

### Left sidebar — Activity Library
- Search/pan navigator icon (crosshair)
- Activity categories:
  - **Move + Transform**: Copy data · Dataflow Gen2
  - **Compute**: Notebook · Spark job definition · Stored procedure
  - **Iteration + Conditional**: ForEach · IfCondition · Switch · Until · Wait
  - **Lookup + Metadata**: Lookup · GetMetadata · Set Variable · Append Variable
  - **External**: Web · WebHook · Azure Function · Custom · Databricks Notebook
  - **Office**: Office365 Outlook · Teams · Fabric items
- Drag-drop onto canvas

### Canvas
**Empty state**: welcome overlay with options
- Start with a blank canvas
- Start with guidance
- Copy data assistant
- Practice with sample data
- Templates gallery

**Populated state**:
- Activity cards (icon + display name)
- Connector arrows (success=green, failure=red, completion=blue, skip=gray)
- Per-card edit (pencil) + status checkmark
- Visual dependency chain (left-to-right or branching DAG)
- Click-to-select / right-click context menu (Copy / Delete / Rename / Clone / Disable)

### Right pane — Properties (5 tabs)
- **Parameters**: pipeline input parameters (Name · Type {String/Int/Boolean/Array/Object} · Default · Required · Description)
- **Variables**: runtime variables (`@variables('x')` access)
- **Settings**: metadata, owner, tags, concurrency, retention
- **Output**: schema definitions and which activities surface as pipeline output
- **Library variables**: shared workspace variables (read-only lookup)
- Collapsible (arrow toggle, top-right)

### Canvas controls (right edge)
- Zoom in / zoom out / zoom % display
- Fit-to-screen (bounds icon)
- Pan mode (hand)
- Full-screen toggle (expand)
- Minimap

### Schedule + Trigger
- **Schedule**: frequency (hourly/daily/weekly/monthly), start+end date+time, timezone, advanced recurrence
- **Trigger**: time-based, event-based, manual, Power Automate / Logic Apps integration

### Run history
- Per-run row: timestamp · status (Success / Failed / In progress) · duration · triggered-by
- Drill-down: per-activity status, duration, rows read/written, logs, error stack, inputs/outputs JSON
- Rerun (whole pipeline or from failed activity)
- Cancel button on active runs

### Validate
- Syntax + missing-config detection
- Dependency cycle detection
- Errors + warnings surfaced in messages pane

## What Loom has
- ADF proxy already wired (`/api/items/data-pipeline/*` → real ADF pipelines named `loom_<wsHash>_<displayName>`)
- Create / Read / Update / Delete via Cosmos with ADF backing
- `/run` POST → `runPipeline()` against ADF
- `/jobs` GET → `listPipelineRuns()` for run history
- Editor is a thin JSON form, **no canvas / no activity library / no properties pane**

## Gaps for parity
1. **Visual canvas** — needs the drag-drop activity DAG editor
2. **Activity library** — 8+ activity categories with drag-drop add
3. **Ribbon** — Validate/Run/Schedule/Trigger/View-history/Copilot quick actions
4. **Properties pane** — 5-tab pane (Parameters/Variables/Settings/Output/Library variables)
5. **Empty-state wizard** — Copy data assistant + templates
6. **Run history drill-down** — currently flat list, needs per-activity expansion
7. **Schedule + Trigger UI** — currently `state.schedule` JSON, needs guided form
8. **Connector arrows + branching** — success/failure/completion/skip paths

## Backend mapping
- ADF Linked Services library (browser already partially exposed at `/api/adf/linked-services`)
- ADF Pipeline JSON read/write — convert canvas DAG → ADF Pipeline payload + back
- `/api/items/data-pipeline/[id]/jobs/[runId]` — fetch ADF activity-run detail
- Schedule wiring: ADF Trigger create/start/stop (`/triggers/{name}`)
- Validate: server-side parse + ADF `/validate` REST call

## Required Azure resources
- ADF instance (`loom-adf-<suffix>` already deployed)
- ADF Managed Private Endpoint to relevant data sources (Synapse, Storage, Cosmos, etc.)
- UAMI Data Factory Contributor on ADF

## Estimated effort
**4-5 sessions.** Visual canvas (DAG editor) is the heaviest piece. MVP path: ribbon + activity quick-add buttons + properties pane (3 sessions), defer drag-drop canvas to v2.

## Notes
- Activities map 1:1 to ADF activity types — backend translation layer is straightforward
- Copilot NL → pipeline build is parked until AI Foundry agent wired
- Reference pipeline in tenant: `pl_casino_medallion_daily` (3 sequential Notebook activities, Gold-Slot → Gold-Player 360 → Gold-1)
