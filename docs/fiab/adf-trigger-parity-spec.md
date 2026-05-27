# Loom ADF Trigger Editor — Studio-parity spec

> Captured 2026-05-26 by catalog agent. Source: ADF Studio → Manage hub → Triggers + `learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers` + `how-to-create-schedule-trigger` + `how-to-create-tumbling-window-trigger` + `how-to-create-event-trigger` + `how-to-create-custom-event-trigger` + Loom `AdfTriggerEditor` (apps/fiab-console/lib/editors/azure-services-editors.tsx:1139) + `adf-client.ts`.

## Overview

A Trigger is the unit of processing that decides **when** a pipeline runs. ADF supports five trigger types: **Schedule**, **Tumbling Window**, **Storage event** (Blob events), **Custom event** (Event Grid custom topics), and an implicit "Trigger now" / manual mode. Triggers are addressable on the ARM provider `Microsoft.DataFactory/factories/triggers` and have a runtime state (Started / Stopped / Disabled) that must be explicitly started after upsert. Pipelines and triggers are many-to-many (except Tumbling Window, which is strictly one-to-one).

## UI components (ADF Studio Manage hub → Triggers)

### Manage hub left nav
- **Triggers** node (under **Author**) — list view of all triggers in the factory
- Columns: Name · Type · Status · Next run · Pipelines · Last modified

### Trigger list toolbar
- **+ New** — opens the new-trigger flyout
- **Refresh**, **Delete**, **Move to folder**
- Per-row toggle: Start / Stop

### New / Edit trigger flyout (right drawer)

Universal fields:
- **Name**
- **Description**
- **Type** dropdown — Schedule · Tumbling window · Storage events · Custom events
- **Status** toggle (Started / Stopped at create time)

#### Schedule trigger
- **Start date** + **Time** + **Time zone** (IANA tz)
- **Recurrence**: every {N} {Minute / Hour / Day / Week / Month}
- **Advanced recurrence options** (when frequency = Day / Week / Month):
  - At these **hours** (multi-select 0-23)
  - At these **minutes** (multi-select 0-59)
  - **Days of week** (Mon-Sun, when frequency = Week)
  - **Day of month** OR **monthlyOccurrence** (e.g., last Sunday) (when frequency = Month)
- **Specify an end date** (toggle) → end date + time
- Annotations
- Many-to-many: can attach multiple target pipelines, each with its own parameter set

#### Tumbling Window trigger
- **Start date** + **Time** (UTC only)
- **Recurrence**: every {N} {Minute / Hour / Month}; minimum interval is 15 minutes
- **End** — Never / On date
- **Delay** (HH:MM:SS) — how long past window end to wait before firing
- **Max concurrency** (1-50)
- **Retry policy** — Count + Interval (seconds)
- **Advanced → Trigger dependencies**: depend on other Tumbling Window triggers with offset + size (self-dependency supported for back-pressure)
- Strictly **one-to-one** with a single target pipeline
- Surfaces `@trigger().outputs.windowStartTime` / `windowEndTime` system variables to the pipeline

#### Storage event trigger (BlobEventsTrigger)
- **Azure subscription** + **Storage account name** picker
- **Container name** dropdown
- **Blob path begins with** — prefix filter (e.g., `/raw/`)
- **Blob path ends with** — suffix filter (e.g., `.parquet`)
- **Event** checkboxes — Blob created · Blob deleted
- **Ignore empty blobs** toggle
- Auto-provisions an Event Grid system topic subscription on the storage account on first save (requires `Microsoft.EventGrid` RP registered + role: EventGrid EventSubscription Contributor)

#### Custom event trigger (CustomEventsTrigger)
- **Azure subscription** + **Event Grid topic** picker (custom topic, not system topic)
- **Subject begins with / ends with** filters
- **Event types** — multi-input list (matches `eventType` on the Event Grid event)
- Pipeline parameters can map from `@triggerBody().event.{property}` expressions

### Parameters mapping
- For each attached pipeline: a Parameters panel that maps trigger system variables → pipeline parameters
  - Schedule: `@trigger().scheduledTime`, `@trigger().startTime`
  - Tumbling window: `@trigger().outputs.windowStartTime`, `@trigger().outputs.windowEndTime`, `@trigger().scheduledTime`, `@trigger().startTime`
  - Storage event: `@triggerBody().fileName`, `@triggerBody().folderPath`, `@trigger().startTime`
  - Custom event: `@triggerBody().event.{property}` paths

### Publish / state
- Triggers must be **published** before they take effect (direct-mode publishes on Save; Git-mode requires explicit Publish)
- After upsert, runtime state is **Stopped** by default — must be explicitly **Started** via `/triggers/{name}/start`

### Trigger runs view (Monitor hub → Trigger runs)
- Tabular list — Trigger name · Type · Trigger time · Status · Triggered pipelines
- Drill-down: trigger payload JSON (especially useful for event-based triggers to see `triggerBody()`)
- Rerun-trigger button

## What Loom has today

- `AdfTriggerEditor` (`apps/fiab-console/lib/editors/azure-services-editors.tsx:1139`) — trigger tree, type dropdown (3 of 5: **ScheduleTrigger · TumblingWindowTrigger · BlobEventsTrigger**), target-pipeline dropdown (one-to-one), frequency + interval + timeZone inputs, Save, **Start**, **Stop**, + New trigger (creates a ScheduleTrigger@Hour skeleton)
- Backend: `adf-client.ts:listTriggers / getTrigger / upsertTrigger / deleteTrigger / startTrigger / stopTrigger` (wired)
- Routes: `/api/items/adf-trigger` (GET list, POST create) + `/api/items/adf-trigger/[id]` (GET/PUT/DELETE) + `/api/items/adf-trigger/[id]/state` (POST `{action: 'start' | 'stop'}`)
- Ribbon stub: Activate group with Start / Stop / New trigger
- BlobEventsTrigger creates with a hard-coded `blobPathBeginsWith: '/container/blobs/'` placeholder — not user-editable
- **No** custom event trigger, **no** advanced recurrence (weekDays / monthlyOccurrences / monthDays / hours / minutes), **no** end-date, **no** dependency editor for tumbling, **no** parameter mapping, **no** multi-pipeline attach, **no** event-subscription auto-provisioning

## Gaps for Studio parity

1. **Custom event trigger** — fifth trigger type entirely missing
2. **Schedule advanced recurrence** — `weekDays`, `monthlyOccurrences`, `monthDays`, `hours[]`, `minutes[]` per `concepts-pipeline-execution-triggers#schedule-trigger-definition`
3. **Schedule end date** — `endTime` field
4. **Tumbling window dependencies** — `dependsOn[]` with offset + size + self-dependency support
5. **Tumbling window retry policy** — `retryPolicy.count` + `intervalInSeconds`
6. **Storage event blob filters** — make `blobPathBeginsWith` / `blobPathEndsWith` / `events[]` / `ignoreEmptyBlobs` editable; auto-provision Event Grid subscription on the storage account
7. **Multi-pipeline attach** — Schedule and event triggers are many-to-many; Loom currently locks to one pipeline only
8. **Parameter mapping panel** — per-pipeline `parameters{}` populated with `@trigger()...` expressions
9. **Trigger runs drill-down** — surface `triggerBody()` payload for event triggers (gap; Loom currently has no trigger-runs view at all)
10. **Storage / Event Grid pickers** — subscription → storage account → container dropdowns (currently no UI)
11. **Annotations + Description** fields
12. **Publish/Save semantics** — direct-mode is fine; Git-mode publish queue not required for MVP

## Backend mapping

- ARM REST under `https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.DataFactory/factories/{factory}`:
  - `GET /triggers?api-version=2018-06-01` — list (wired in `adf-client.ts:listTriggers`)
  - `GET/PUT/DELETE /triggers/{name}?api-version=2018-06-01` — get/upsert/delete (wired)
  - `POST /triggers/{name}/start?api-version=2018-06-01` — start (wired in `startTrigger`)
  - `POST /triggers/{name}/stop?api-version=2018-06-01` — stop (wired in `stopTrigger`)
  - `POST /triggers/{name}/subscribeToEvents` — provisions Event Grid subscription for BlobEventsTrigger / CustomEventsTrigger (gap)
  - `POST /triggers/{name}/getEventSubscriptionStatus` — check subscription state (gap)
  - `POST /triggers/{name}/unsubscribeFromEvents` — teardown (gap)
  - `POST /queryTriggerRuns` — list runs across triggers with date range + filters (gap)
- Schedule JSON shape: `properties.typeProperties.recurrence` with `frequency`, `interval`, `startTime`, `endTime`, `timeZone`, optional `schedule.{minutes,hours,weekDays,monthlyOccurrences,monthDays}`
- Tumbling JSON shape: `properties.typeProperties.{frequency,interval,startTime,endTime,delay,maxConcurrency,retryPolicy,dependsOn}`
- BlobEventsTrigger JSON: `properties.typeProperties.{blobPathBeginsWith,blobPathEndsWith,events[],scope,ignoreEmptyBlobs}` where `scope` is the storage account resource ID
- CustomEventsTrigger JSON: `properties.typeProperties.{subjectBeginsWith,subjectEndsWith,events[],scope}` where `scope` is the Event Grid topic resource ID

## Required Azure resources

- ADF instance (`Microsoft.DataFactory/factories`) — already provisioned
- UAMI granted **Data Factory Contributor** at factory scope (already wired)
- For Storage event triggers: `Microsoft.EventGrid` resource provider registered on the subscription + UAMI granted **EventGrid EventSubscription Contributor** on the target storage account + storage account must be General Purpose v2 or Blob Storage (Standard_LRS / Standard_GRS)
- For Custom event triggers: an Event Grid custom topic (`Microsoft.EventGrid/topics`) with the same UAMI granted EventGrid EventSubscription Contributor
- For Tumbling window with dependencies: triggers can self-depend, but external dependencies must be Tumbling-window triggers within the same factory

## Estimated effort

**3 sessions.** MVP (1 session): full Schedule advanced recurrence + endTime + multi-pipeline attach + parameter mapping. (1 session): editable Storage event filters with subscription auto-provision + storage picker. (1 session): Custom event trigger + Tumbling dependencies + retry policy + trigger-runs drill-down view.

## Notes

- Triggers are one of the more self-contained ADF surfaces — backend is already fully wired in `adf-client.ts`. Most of the work is UI form-building, not API plumbing
- Event Grid subscription auto-provisioning is the only RBAC tripwire — Loom should pre-grant the UAMI the EventGrid EventSubscription Contributor role on candidate storage accounts via Bicep, otherwise the first Save will 403
- Tumbling Window trigger's strict one-to-one constraint is enforced by the service; the UI should disable the "add pipeline" button when type=TumblingWindowTrigger
- Trigger-runs drill-down view is a useful sibling to the existing pipeline-runs table on the AdfPipelineEditor — consider building it once and linking from both
