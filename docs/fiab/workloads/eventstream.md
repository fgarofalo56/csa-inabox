# Eventstream editor

The **Eventstream** editor is the visual pipeline designer for Real-Time
Intelligence ingestion. v2.x ships a **configuration-only** editor — the
pipeline metadata is persisted to Cosmos and validated against a JSON
schema, but the actual Event Hubs → ADX runtime is wired separately via the
Eventhouse editor's `Ingest → Event Hub` action.

Until the visual designer's runtime lands in v3, the editor displays a Fluent
UI `MessageBar intent="warning"` at the top making the gap explicit (per
`no-vaporware.md`).

## Backend

| Layer | Implementation |
|---|---|
| Persistence | Cosmos DB `items` container, `state.source / state.sink / state.transforms` |
| Runtime wiring | **Today**: use Eventhouse → Ingest → Event Hub (provisions an ADX data connection). **v3**: this editor will provision + start the same data connection via its own Save button. |
| BFF routes | `GET /api/items/eventstream/[id]`, `PUT /api/items/eventstream/[id]` |

## What works today

| Action | Backend call | Status |
|---|---|---|
| Read pipeline config | Cosmos read | live |
| Edit JSON (Monaco) | client state | live |
| JSON parse validation | client | live |
| Save (Ctrl+S or button) | Cosmos `replace()` | live |
| Workspace picker | `GET /api/loom/workspaces` | live |

## What's intentionally honest-disabled / gated

| Surface | Gate / reason |
|---|---|
| MessageBar at top of editor | `v2.1 — configuration only`. Runtime publish/start lands in v3 with a dedicated `Publish` action that re-uses the Eventhouse data-connection ARM call. |
| Ribbon `Publish` | Disabled, title "runtime publish/start not yet wired" |
| Visual source / transform / destination pickers | Disabled — edit JSON below |

## Bicep

- Cluster + databases: see [Eventhouse](eventhouse.md)
- Event Hubs namespace: **must be provisioned out-of-band** today. Set
  `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` to its ARM id. A `platform/fiab/
  bicep/modules/admin-plane/eventhub-namespace.bicep` module is on the v3
  roadmap.

## Env vars

| Variable | Purpose |
|---|---|
| `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` | ARM id of the Event Hubs namespace |
| `LOOM_KUSTO_*` | Same as Eventhouse |
