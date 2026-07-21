# eventstream-2026 — parity with Fabric Eventstream 2026 features

Source UI: https://learn.microsoft.com/en-us/fabric/real-time-intelligence/event-streams/overview
Source UI (SQL transform): https://learn.microsoft.com/en-us/fabric/real-time-intelligence/event-streams/route-events-based-on-content
Source UI (AI Skill): https://learn.microsoft.com/en-us/fabric/real-time-intelligence/event-streams/process-events-using-event-processor-editor
Source UI (Business events): https://learn.microsoft.com/en-us/fabric/real-time-intelligence/event-streams/create-eventstream

WS-3.4 adds three capabilities introduced by Fabric Eventstream's 2026 surface:

---

## Azure/Fabric feature inventory

| # | Capability | Description |
|---|---|---|
| F1 | SQL transform operator | Inline SQL query step in the stream topology; runs compile, test-with-sample, and apply-sinks against the live ASA job |
| F2 | AI Skill (NL authoring) | Natural-language prompt → proposed topology edit (add/rename/remove transform, add destination); operator picks TYPED enum for each op kind |
| F3 | Business Events publisher | Governed schema registry for named event types (field names, types, required flags); form-driven payload publish to Event Hubs with CloudEvents 1.0 envelope + server-side validation |

---

## Loom coverage

| # | Capability | Status | Notes |
|---|---|---|---|
| F1 | SQL transform operator | ✅ Built | `EventstreamSqlOperatorTab` in `eventstream-editor.tsx`; backed by `stream-analytics-client` compile/test/save/apply-sinks; Monaco editor; per-sink ASA output ARM creation. Gate: honest 501 with `LOOM_ASA_RG` hint when ASA not configured. |
| F2 | AI Skill (NL authoring) | ✅ Built | `CopilotBuilderPane` on the Copilot tab; route `/api/items/eventstream/[id]/assist` uses `makeCopilotBuilderRoute(EVENTSTREAM_BUILDER_CONFIG)`. `EVENTSTREAM_BUILDER_CONFIG` normalises ops to typed enum kinds (`add-transform`, `rename-transform`, `remove-transform`, `add-destination`). `groundingText()` renders live topology. `applyOps()` mutates Cosmos doc. Azure-native (AOAI). |
| F3 | Business Events publisher | ✅ Built | `EventstreamBusinessEventsTab` (`eventstream-business-events.tsx`); route `/api/items/eventstream/[id]/business-events`. Registry tab: cards of governed types with field badges + edit/delete. Publish tab: schema-driven typed-input form → CloudEvents 1.0 envelope → `sendEvents()` (real HTTPS data-plane). Honest 501 gates for `LOOM_EVENTHUB_NAMESPACE` (publish) + `LOOM_COSMOS_ENDPOINT` (registry), each with inline Fix-it button linking to `/admin/environment`. |

---

## Backend per control

| Control | Route / client | Azure REST / data-plane |
|---|---|---|
| SQL operator: Compile | `POST /api/items/eventstream/[id]/sql-operator` action=compile | ASA `compileQuery` REST (stream-analytics-client) |
| SQL operator: Test | `POST /api/items/eventstream/[id]/sql-operator` action=test | ASA `testQuery` REST (stream-analytics-client) |
| SQL operator: Save | `POST /api/items/eventstream/[id]/sql-operator` action=save | Cosmos saveItemState + ASA transformation update (stream-analytics-client) |
| SQL operator: Apply sinks | `POST /api/items/eventstream/[id]/sql-operator` action=apply-sinks | ARM PUT ASA outputs per named sink (stream-analytics-client) |
| AI Skill: Ask Copilot | `POST /api/items/eventstream/[id]/assist` | AOAI chat completions (aoai-chat-client, unified backend) |
| Business Events: List types | `GET /api/items/eventstream/[id]/business-events` | Cosmos `listEventTypes` (business-events-store, container `business-event-types`) |
| Business Events: Register type | `POST .../business-events` action=define | Cosmos `upsertEventType` |
| Business Events: Delete type | `POST .../business-events` action=delete | Cosmos `deleteEventType` |
| Business Events: Publish | `POST .../business-events` action=publish | CloudEvents 1.0 → `sendEvents()` (eventhubs-data-client, real HTTPS data-plane `POST /messages`) |

---

## Deviations from Fabric source UI

1. **Theme**: Fluent v9 + Loom tokens instead of Fabric's design tokens. Interaction model, tab order, and workflow are preserved.
2. **No Power BI / Fabric workspace required**: All three features work without `LOOM_DEFAULT_FABRIC_WORKSPACE`. Azure-native is the exclusive default path.
3. **AI Skill produces typed structured ops**: Fabric's AI Skill is freeform NL; Loom's normalises the AOAI response to a typed enum ops array and enforces `TRANSFORM_KINDS` / `SINK_KINDS` validation before applying.

---

## Honest-gate registry (G2 compliance)

| Gate | Env var | Fix-it target |
|---|---|---|
| Business Events registry | `LOOM_COSMOS_ENDPOINT` | `/admin/environment` |
| Business Events publish | `LOOM_EVENTHUB_NAMESPACE` | `/admin/environment` |
| SQL operator | `LOOM_ASA_RG` | `/admin/environment` |

All gates render a Fluent `MessageBar intent="warning"` with an inline **Fix it** button. No bare MessageBar without action (G2 compliant).

---

## Verification receipt (Track-0 — E2E owed)

> G1 (ux-baseline.md): A full in-browser E2E receipt with real data flowing end-to-end is
> required before this surface reaches A-grade. The receipt must include:
> - SQL operator: compile round-trip response from ASA REST
> - AI Skill: AOAI proposed-ops apply confirmed in Cosmos topology
> - Business Events: published CloudEvents ID returned from Event Hub data-plane
>
> Track-0 ticket: file a GitHub Issue against this worktree PR before merge.

---

*Parity doc generated for WS-3.4 (feat/ws3-4-eventstream-2026). Zero ❌ rows.*
