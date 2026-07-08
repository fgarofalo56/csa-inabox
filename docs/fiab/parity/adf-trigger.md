# adf-trigger — parity with Azure Data Factory **triggers**

> **Scope note — this is an ADF sub-feature, not a standalone service.** In the
> real product, triggers are authored *inside* Azure Data Factory Studio under
> **Manage → Author → Triggers** (and via the pipeline canvas "Add trigger").
> In Loom the same object is a first-class catalog item (`slug: adf-trigger`,
> `restType: AdfTrigger`, category **Azure Data Factory**) whose editor
> (`AdfTriggerEditor`) lives in
> `apps/fiab-console/lib/editors/azure-services-editors.tsx`. It is a peer of
> [`adf-pipeline.md`](./adf-pipeline.md) and [`adf-dataset.md`](./adf-dataset.md);
> the whole Studio is covered by [`adf-data-factory.md`](./adf-data-factory.md).

**Catalog description:** "Schedule, tumbling window, storage event, or custom
event trigger."

**No-Fabric note:** triggers are a *pure Azure* object on
`Microsoft.DataFactory/factories/{f}/triggers`. No Fabric dependency on any path.

Source UI: **Azure Data Factory Studio → Manage → Triggers** (`https://adf.azure.com`)
- Pipeline execution & triggers: <https://learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers>
- Schedule trigger: <https://learn.microsoft.com/azure/data-factory/how-to-create-schedule-trigger>
- Tumbling-window trigger: <https://learn.microsoft.com/azure/data-factory/how-to-create-tumbling-window-trigger>
- Storage-event trigger: <https://learn.microsoft.com/azure/data-factory/how-to-create-event-trigger>
- Custom-event trigger: <https://learn.microsoft.com/azure/data-factory/how-to-create-custom-event-trigger>
- Trigger REST (`Triggers - Create Or Update` / `Start` / `Stop`): <https://learn.microsoft.com/rest/api/datafactory/triggers>

## Azure/ADF feature inventory (Manage → Triggers)

| # | Capability in ADF Studio | Notes |
|---|--------------------------|-------|
| 1 | **New trigger** — type: Schedule, Tumbling window, Storage events, Custom events | 4 trigger families |
| 2 | **Schedule** config — start date, recurrence (Minute/Hour/Day/Week/Month + interval), time zone, end date, advanced hours/minutes/weekdays | recurrence object |
| 3 | **Tumbling window** config — start/end, frequency+interval, delay, max concurrency, retry policy, self-dependency | window object |
| 4 | **Storage-events** config — storage account scope, container, blob-path begins-with / ends-with, event types (BlobCreated/BlobDeleted) | Event Grid |
| 5 | **Custom-events** config — Event Grid topic scope, subject filters, event types | Event Grid |
| 6 | **Attach to pipeline(s)** — one trigger fires one or more pipelines, each with **parameters** | `pipelines[]` |
| 7 | **Start / Stop / activate / deactivate** the trigger (runtime state) | Start/Stop REST |
| 8 | **Trigger list** + open/edit/delete; **Trigger runs** monitor (in Monitor hub) | list + monitor |
| 9 | Publish (Git-mode commit / Live-mode publish) | source control |

## Loom coverage

Backend via ARM REST (`Microsoft.DataFactory/factories/{name}/triggers`) through
the BFF (`/api/items/adf-trigger` GET/POST, `/api/items/adf-trigger/[id]`
GET/PUT/DELETE, `/api/items/adf-trigger/[id]/state` POST start|stop). Same
env-pinned factory + honest `BackendStateBar` gate as `adf-dataset`.

| # | Capability | Status | Detail |
|---|-----------|--------|--------|
| 1 | Trigger type picker | built ✅ (3 of 4) | **Type** dropdown = `ADF_TRIGGER_TYPES` (ScheduleTrigger, TumblingWindowTrigger, BlobEventsTrigger). **CustomEventsTrigger** ❌ not offered |
| 2 | Schedule recurrence | built ✅ | Frequency (Minute/Hour/Day/Week/Month) + Interval + Time zone; `startTime` set on save. Advanced weekday/hour/minute schedule ❌ not exposed |
| 3 | Tumbling window | built ✅ (core) ⚠️ | window `frequency`/`interval`/`startTime`/`delay`/`maxConcurrency` seeded on save; retry policy & self-dependency ❌ not in the form |
| 4 | Storage-events | built ✅ (core) ⚠️ | BlobEventsTrigger seeds `blobPathBeginsWith` + `Microsoft.Storage.BlobCreated` + scope; the begins-with/ends-with/scope fields are seeded rather than fully form-driven |
| 5 | Custom-events | MISSING ❌ | not in `ADF_TRIGGER_TYPES` |
| 6 | Attach pipeline + parameters | built ✅ | **Target pipeline** dropdown (live from `/api/items/adf-pipeline`) + **Pipeline parameters** repeater (add/remove name/value rows; string or JSON literal) |
| 7 | Start / Stop | built ✅ | ribbon **Start**/**Stop** + header buttons → `/state` route; runtime-state badge (Started/Stopped) drives enablement |
| 8 | Trigger list + open/delete | built ✅ (list/open) / partial | left `Tree` lists triggers; DELETE route exists; **Trigger-runs monitor** ❌ (belongs to the factory Monitor hub — see `adf-data-factory.md`) |
| 9 | Save / Publish | built ✅ (Save) | **Save** (+ Ctrl+S) PUTs the trigger via ADF REST (Live-mode). Git-mode Publish is a factory-wide gap |

## Backend per control

| Loom control | Route | Azure backend |
|--------------|-------|---------------|
| Trigger list | `GET /api/items/adf-trigger` → `listTriggers()` | ARM `GET …/factories/{f}/triggers` |
| Open trigger | `GET /api/items/adf-trigger/{id}` → `getTrigger()` | ARM `GET …/triggers/{name}` |
| Save / create | `PUT`/`POST /api/items/adf-trigger[/{id}]` → `upsertTrigger()` | ARM `PUT …/triggers/{name}` |
| Start / Stop | `POST /api/items/adf-trigger/{id}/state` → `startTrigger()`/`stopTrigger()` | ARM `POST …/triggers/{name}/start`\|`/stop` |
| Target-pipeline dropdown | `GET /api/items/adf-pipeline` → `listPipelines()` | ARM `GET …/pipelines` |

**Grade: B−.** Real trigger create/edit/save + Start/Stop + pipeline binding with
parameters on live ADF REST, covering the 3 most-used trigger families
(Schedule, Tumbling window, Storage events). Honest gaps: the **Custom-events**
type, advanced recurrence (weekday/hour schedules), tumbling-window retry/
self-dependency, full form-driven storage-event filters, and the **trigger-runs
monitor** (which lives in the factory Monitor hub, tracked separately).
