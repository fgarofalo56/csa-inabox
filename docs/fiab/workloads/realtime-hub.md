# Real-Time Hub — workload reference

> **Family:** Real-Time Intelligence
> **Surface:** `/realtime-hub` (left nav → *Real-Time Hub*)
> **View:** `apps/fiab-console/lib/components/realtime-hub/realtime-hub-view.tsx`
> **BFF routes:** `app/api/realtime-hub/**`

## Purpose

Loom's parity for the Fabric **Real-Time Hub** — discover all data-in-motion and
connect streaming sources. **Azure-native by default** (no Microsoft Fabric, per
`.claude/rules/no-fabric-dependency.md`).

## Connect a source ("Get events")

The **Connect source** wizard (`connect-source-dialog.tsx`) presents the full
connector catalog (`source-catalog.ts`) — Azure Event Hubs, IoT Hub, Service
Bus, SQL/MI/Cosmos/Postgres/MySQL CDC, Kafka (Apache/Confluent/MSK), Kinesis,
Pub/Sub, Blob/Fabric events, Custom endpoint, Sample data — grouped and
colour-coded one-for-one with Fabric.

On **Connect**, `POST /api/realtime-hub/connect-source` creates a **Loom-native
`eventstream` item** in the chosen Loom workspace carrying the source topology
(`state.definition.sources[0]`). Open the eventstream to wire processing +
destinations on the canvas. The runtime is Azure Event Hubs (+ Stream Analytics
for processing) — **no Fabric workspace required**.

> **Fabric opt-in:** set `LOOM_EVENTSTREAM_BACKEND=fabric` (and provide a Fabric
> workspace) to create a real Fabric Eventstream instead.

## All data streams

`GET /api/realtime-hub/streams` lists the tenant's Loom **eventstream** items
(as *streams*) and **kql-database / eventhouse** items (as *tables*) from Cosmos
across the caller's Loom workspaces. Preview + endpoints actions operate on the
selected stream.

## Real backend it calls

- `app/api/realtime-hub/connect-source` → `createOwnedItem('eventstream')`.
- `app/api/realtime-hub/streams` → `listAllOwnedItems` + `listOwnedWorkspaces`.
- Fabric opt-in path → `lib/azure/fabric-client.ts` (`connectEventstreamSource`,
  `listEventstreams`, `listKqlDatabases`).

## Tests

`app/api/realtime-hub/__tests__/routes.test.ts` — 16 contract tests: auth gates,
content-type guard, Azure-native stream listing (eventstream→stream,
kql-database→table, other types excluded), connect-source creates a Loom
eventstream item with the source topology, and createOwnedItem failure
pass-through.

## Bicep + env

| Env | Purpose |
|---|---|
| `LOOM_EVENTHUB_NAMESPACE` / Event Hubs config | eventstream runtime (Azure-native) |
| `LOOM_EVENTSTREAM_BACKEND=fabric` | opt into the Fabric Eventstream backend |
