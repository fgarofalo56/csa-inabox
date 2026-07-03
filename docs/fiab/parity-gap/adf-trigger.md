# Parity gap — `adf-trigger`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure Data Factory Studio → Manage → Triggers.
> Loom route: `https://<your-console-hostname>/items/adf-trigger/new`.
> Editor source: `apps/fiab-console/lib/editors/azure-services-editors.tsx` (lines 1183-1404).

## Phase 3 — gap matrix vs ADF Trigger UI

| # | ADF Studio trigger element | Loom present? | Severity |
|---|---|---|---|
| 1 | Trigger list + "+ New trigger" | Present (lines 1341-1356) | OK |
| 2 | Type selector (Schedule / Tumbling Window / Storage Events / Custom Events) | Partial — 3 of 4 types (`ScheduleTrigger`, `TumblingWindowTrigger`, `BlobEventsTrigger`) at line 1181. Missing CustomEventsTrigger. | MINOR |
| 3 | Target pipeline picker | Present (lines 1378-1383) — real dropdown sourced from `/api/items/adf-pipeline` | OK |
| 4 | Frequency / Interval / Time zone for schedule trigger | Present (lines 1385-1396) | OK |
| 5 | Start time / End time / Schedule end-of-window | **Missing End time** — only `startTime: new Date().toISOString()` (line 1254) — always "starts now". Caption-only. | MAJOR |
| 6 | Tumbling window: delay / maxConcurrency / retryPolicy editor | Hardcoded — `delay: '00:00:00'`, `maxConcurrency: 1` (lines 1262-1263). User can't change. | MAJOR |
| 7 | Blob events trigger: scope / path begins / events checkboxes | Hardcoded placeholder (lines 1266-1270). User can't change scope or events. | MAJOR |
| 8 | Parameters mapping (trigger → pipeline params) | MISSING — `parameters: {}` always empty (line 1278) | MAJOR |
| 9 | Save / Start / Stop | Present (lines 1363-1365) — real PUT + state POST | OK |
| 10 | Runtime state badge (Started / Stopped / Disabled) | Present (line 1362) | OK |
| 11 | Trigger run history | MISSING — ADF Studio shows trigger runs separately from pipeline runs | MAJOR |
| 12 | Status bar | MISSING | MINOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| Trigger list click | `setSelected` → `loadTrigger` (line 1218-1235) — real GET | Real |
| Type dropdown | `setType` local state | Real |
| Frequency / Interval / Timezone inputs | Local state | Real |
| Target pipeline dropdown | `setTargetPipeline` local state | Real |
| **Save** | `save()` (line 1240-1292) — builds correct typeProperties per type, real `PUT /api/items/adf-trigger/{name}` | Real |
| **Start** | `setState('start')` (line 1294-1307) — real `POST .../state {action: 'start'}` | Real |
| **Stop** | `setState('stop')` — same handler | Real |
| **+ New trigger** | `createNew()` (line 1309-1335) — real `POST` | Real |
| Ribbon "Start" / "Stop" / "Recurrence" / "Parameters" | No handlers (Start/Stop are real but as top-bar buttons, not ribbon-bar buttons) | **DEAD** — 4 ribbon vapor |

## Grade

**C** — Schedule trigger create / save / start / stop is real-REST and works. But Tumbling Window and Blob Events triggers have hardcoded fields that the user can't edit (MAJOR — the user-visible form doesn't expose Delay / MaxConcurrency / Scope / EventTypes), no End time, no trigger-parameters editor, no trigger run history.

If you only ever wanted a Schedule trigger with default settings, this is a B. Anything beyond that and it falls to C. 4 dead ribbon entries are minor compared to the form-fidelity gaps.

