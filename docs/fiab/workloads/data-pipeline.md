# Data Pipeline parity

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


## What Fabric does

Fabric Data Pipelines is the Synapse / ADF orchestration surface
re-shipped inside Fabric workspaces. It exposes a drag-and-drop visual
designer with three panes (palette / canvas / properties), a top tab
strip (Pipeline / Parameters / Variables / Settings / Output), and a
ribbon for Save / Validate / Run / Debug / Schedule. Activities span
data movement (Copy, Mapping data flow, Dataflow Gen2 refresh, Lookup),
compute invocation (Notebook, Spark Job, Script, Stored procedure,
Web, Office 365 Outlook), and control flow (Set / Append Variable,
Filter, ForEach, If condition, Switch, Until, Wait). The same JSON
shape (`{ properties: { activities, parameters, variables, ... } }`)
is shared with Azure Data Factory and Synapse Integrate.

## CSA Loom parity design

Loom Console exposes the **Data pipeline** item type backed by Azure
Data Factory (`Microsoft.DataFactory/factories`). The editor
(`apps/fiab-console/lib/editors/data-pipeline-editor.tsx`) renders the
same three-pane layout and ribbon Fabric ships, and every primary
action calls ADF REST end-to-end.

| Fabric concept | Loom backing | Where |
|---|---|---|
| Pipeline JSON | ADF pipeline | `PUT /pipelines/{name}?api-version=2018-06-01` |
| Activity palette | `lib/components/pipeline/palette.tsx` + `activity-catalog.ts` | 18 activity types |
| Canvas + DAG | `lib/components/pipeline/canvas.tsx` (DnD, pan/zoom, minimap) | + `activity-node.tsx`, `connector.tsx` |
| Properties pane | `properties-panel.tsx` (5 tabs) | General / Source-Sink / Settings / Parameters / User properties |
| Top tabs | `top-tabs.tsx` | Pipeline / Parameters / Variables / Settings / Output |
| Save | `PUT /api/items/data-pipeline/[id]` → `upsertPipeline` | ADF |
| Validate | `POST /api/items/data-pipeline/[id]/validate` → `validatePipeline` | ADF |
| Run | `POST /api/items/data-pipeline/[id]/run` → `runPipeline` | ADF createRun |
| Debug | `POST /api/items/data-pipeline/[id]/debug` → `debugPipeline` | ADF createRun + isRecovery |
| Schedule / Add trigger | `POST /api/items/data-pipeline/[id]/triggers` → `upsertTrigger` | ADF triggers |
| Run history / per-activity output | `GET /api/items/data-pipeline/[id]/output[?runId=...]` | `queryActivityruns` |

## Activity catalog

The editor exposes 18 activity types, grouped in the palette as
Fabric does (Move & transform / Activities):

### Move & transform
- **Copy data** — `Copy` activity (any supported connector → any supported connector)
- **Dataflow Gen2 refresh** — `RefreshDataflow` (Fabric-only; **save-only** against ADF backing)
- **Mapping data flow** — `ExecuteDataFlow` (ADF-native data flow)
- **Lookup** — `Lookup`

### Activities
- **Notebook** — `DatabricksNotebook` (also covers Fabric/Synapse notebooks via linked services)
- **Spark Job Definition** — `SynapseSparkJobDefinitionActivity`
- **Script** — `Script` (inline SQL/Hive/Pig)
- **Stored procedure** — `SqlServerStoredProcedure`
- **Web** — `WebActivity` (custom REST)
- **Office 365 Outlook** — `Office365OutlookSendEmail` (Fabric-only; **save-only**)
- **Set variable** — `SetVariable`
- **Append variable** — `AppendVariable`
- **Filter** — `Filter`
- **ForEach** — `ForEach` (parallel/sequential, batch count)
- **If condition** — `IfCondition`
- **Switch** — `Switch`
- **Until** — `Until`
- **Wait** — `Wait`

Activities marked **save-only** above persist correctly to ADF but
will not execute because ADF lacks a native equivalent. The editor
surfaces a precise `MessageBar intent="warning"` on the canvas + a
"Save-only" badge in the properties pane with remediation text (e.g.
"Office 365 Outlook send-email is a Fabric pipeline activity. ADF
backing has no native equivalent — use Web activity against
Microsoft Graph instead.").

## Connectors

The canvas draws four colours of dependency edges, matching Fabric:

| Condition | Colour | Hex |
|---|---|---|
| Succeeded | green | `#107c10` |
| Failed | red | `#d13438` |
| Completed | blue | `#0078d4` |
| Skipped | grey | `#888888` |

Edges are SVG paths with auto-routed Bezier curves and arrowhead
markers. Each can be inspected by hovering the wider invisible
hit-target along the path.

## Pipeline-scoped state

Parameters and variables surface as flat editable tables under the
top tabs:

- **Parameters** — typed inputs (`string`, `int`, `float`, `bool`,
  `array`, `object`, `secureString`). Referenced from activities
  with `@pipeline().parameters.<name>`.
- **Variables** — scoped variables (`String`, `Boolean`, `Array`)
  manipulated by SetVariable / AppendVariable activities.

Both round-trip through the ADF wire format
(`properties.parameters` / `properties.variables`).

## Ribbon

The editor's ribbon mirrors the Fabric ribbon:

- **Home**: New pipeline, Save, Refresh, Discard, Validate, Run, Debug,
  Schedule, Add trigger, Delete
- **View**: Show grid, Snap to grid, Fit to screen, Reset zoom
- **Output**: Pin output, Open Output tab

`Ctrl+S` / `Cmd+S` is bound to Save and consumed by the editor (no
browser save-dialog).

## Backend wiring

```
Editor                       BFF route                              Azure
─────                       ─────────                              ─────
ActivityPalette drag        POST /api/items/data-pipeline          ADF pipelines/{name}?api-version=2018-06-01 (PUT)
Save (Ctrl+S)               PUT  /api/items/data-pipeline/[id]     same
Validate (ribbon)           POST /api/items/data-pipeline/[id]/validate  validatePipeline (ADF)
Run (ribbon)                POST /api/items/data-pipeline/[id]/run      pipelines/{n}/createRun
Debug (ribbon)              POST /api/items/data-pipeline/[id]/debug    pipelines/{n}/createRun?isRecovery=false
Schedule (dialog)           POST /api/items/data-pipeline/[id]/triggers triggers/{n}?api-version=2018-06-01 (PUT)
Trigger Start/Stop          PUT  /api/items/data-pipeline/[id]/triggers triggers/{n}/start | stop
Output tab — runs           GET  /api/items/data-pipeline/[id]/output   queryPipelineRuns
Output tab — per activity   GET  /api/items/data-pipeline/[id]/output?runId=... queryActivityruns
```

## Tests

- **Vitest**: `lib/components/pipeline/__tests__/*.test.ts` covers the
  activity catalog (18 entries), `nextNameSuffix` auto-incrementer,
  spec <-> text round-trips, parameters/variables conversion, and the
  four connector colours.
- **Playwright UAT**: `e2e/data-pipeline.uat.ts` walks a 2-activity
  pipeline (Wait + Web) through palette → canvas → save → validate →
  run end-to-end against a real ADF factory. Honest gate on missing
  ADF backing.

## Limitations vs Fabric

Honest list — these are tracked as enhancements, **not** vaporware:

- **Activity drag-to-move on canvas**: implemented (positions stored
  client-side). ADF does not persist node positions in pipeline JSON,
  so re-opening a pipeline auto-layouts from `dependsOn[]`.
- **Cross-pipeline `ExecutePipeline`**: caller must enter the
  referenced pipeline name by hand in the properties panel (no
  picker yet).
- **Mapping Data Flow inline editor**: opens via the linked
  `dataflow` reference; the inline DF editor itself lives in the
  Dataflow Gen2 editor.
- **Dataset / linked service picker**: properties panel surfaces
  these as raw JSON. A typed picker is queued for the next release.
- **Real-time run pings**: the Output tab refreshes on demand;
  push-based streaming is queued behind the ADF stream-runs API.

## Bicep sync

The Data Pipeline editor requires:

- `LOOM_ADF_NAME` env var pointing at a deployed
  `Microsoft.DataFactory/factories` (default: `adf-loom-default-eastus2`).
- `uami-loom-console-eastus2` granted **Data Factory Contributor** on
  that factory (already wired in
  `platform/fiab/bicep/modules/data-factory/data-factory.bicep`).

No new bicep modules are required for this release — the factory is
already in `commercial-full.bicepparam`. Triggers and pipelines are
created via REST at runtime, not bicep.
