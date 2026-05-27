# Activator (Data Activator / Reflex) Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Fabric Activator docs) + inspection of `apps/fiab-console/lib/editors/phase3-editors.tsx` `ActivatorEditor`. Loom has working Fabric REST CRUD for reflexes and rules (UAT-verified), so spec compares Loom's current surface against the full Fabric Activator authoring UX.

## Overview

Fabric Activator (item kind `Reflex` in the REST API) is a no-code event-detection and rules engine. It subscribes to streaming sources (Eventstream, Real-Time Dashboard visuals, Power BI visuals, Fabric workspace events, Azure events), models incoming records as **events** optionally grouped into **objects** with monitored **properties**, evaluates **rules** continuously (stateless rules < 1s, stateful/aggregated rules up to ~10min), and fires **actions** — Teams · Email · Fabric pipeline/notebook/dataflow/spark-job/UDF · Power Automate flow.

## Fabric UX

### Top-level chrome
- **Activator (Reflex) item** opens in its own editor canvas
- Left **Object Explorer tree**; center **definition pane**; right **monitor / analytics** panes
- Mode toggle: **Design** (authoring) · **Activate** (turn rule on/off live)

### Ribbon — Home tab
- **New rule** · **Start** (activate) · **Stop** (deactivate) · **Test fire** (preview / simulate)
- **Save** · **Get data** (add eventstream/PBI/RTD source) · **Assign to object** (map event columns to object ID + properties)
- Action launchers: **Email** · **Teams** · **Run Fabric item** · **Custom action** (Power Automate)

### Object Explorer (left tree)
Hierarchical view of the reflex's **entities**:
- **Events** — raw event streams subscribed (one node per eventstream/PBI visual/RTD visual data source)
- **Objects** — grouped events keyed by object ID (e.g., `BikepointID`, `PackageID`, `device_id`)
- **Properties** — monitored fields on each object (e.g., `Temperature`, `Status`, computed properties such as 1h rolling average)
- **Rules** — Event Rules, Split-Event Rules, and Property Rules (three rule entity kinds)

Selecting any entity opens its definition + monitor view in the center pane.

### Rule Builder — definition pane
A rule has up to four steps depending on rule kind:

**1. Monitor step**
- Select the base property (Property Rule) or event/column (Event Rule)
- Inline chart of recent values for that property/column (last N minutes)
- Optional **summarization** (avg / sum / min / max / count over a rolling window)

**2. Condition step** — stateful and stateless operators:
- Comparison: `Is greater than` · `Is less than` · `Is equal to` · `Is between` · `Is outside range`
- Change-detection (stateful, multi-point): `BECOMES` (true/condition) · `INCREASES BY` (absolute or %) · `DECREASES BY` · `EXIT RANGE` · `ENTER RANGE`
- Absence: heartbeat / `No data received for N minutes`
- **Occurrence** modifier: `Every time the condition is met` · `When it has been true for N times` (consecutive) · `When it has been true for <duration>`

**3. Property filter step** (up to 3 filters, ANDed): per-filter `Attribute` + `Operation` + `Value`; numeric, text, and boolean attributes supported

**4. Action step** (see "Action types" below)

### Advanced settings (per rule)
- **Wait time for late-arriving events** (default 2 minutes; bounds latency vs. completeness trade-off)
- **Query frequency** (for query-backed sources like Power BI / RTD, default 1h, configurable)
- **Lookback period** (how far back to evaluate when first activated)

### Action types

| Action type | Configuration |
|---|---|
| **Teams message** | Recipients (users · group chat · channel) · headline · optional message · context properties · `messageLocale` |
| **Email** | Recipients · subject · body · context properties · attachments via `@property` mentions |
| **Fabric item invocation** | Pipeline · Notebook · Spark Job Definition · Dataflow Gen2 · User Data Function — pick item, then add parameter name/value pairs (parameters can reference `@property` for value injection) |
| **Custom action** | Launches a Power Automate flow — flow URL + body schema · auth handled by Power Automate |

Action payload supports **`@property`** mentions to inject the live property value at trigger time (e.g., `@BikepointID`, `@Temperature`).

### Monitor & Analytics panes (right side)
- **Definition** sub-pane (steps 1–4 above)
- **Monitor** sub-pane: live chart of the monitored property + the condition threshold overlaid
- **Analytics** sub-pane:
  - Chart 1: **Total activations over time** across all object IDs
  - Chart 2: **Top 5 object IDs** by activation count (find the noisy sensors)

### Activation history
Per-rule log of every activation:
- Timestamp · Object ID · trigger payload · matched condition value · action result (success/fail) · downstream pipeline run ID / Teams message ID / Power Automate run ID

### Test fire / preview
- **Preview rules** before activating — replays historical events through the rule and shows how often it would have fired (catches misconfigured filters and noise)
- **Test fire** button manually triggers the action once with synthetic context (proves Teams webhook / pipeline ID / Power Automate flow actually works)

## What Loom has today

From `apps/fiab-console/lib/editors/phase3-editors.tsx::ActivatorEditor` and `app/api/items/activator/**`:
- Fabric workspace picker (uses shared `useWorkspaces()` hook against live Power BI / Fabric REST)
- List reflexes in a workspace (`GET /api/items/activator?workspaceId=...`)
- Left tree of reflex display names (one-level, leaf only)
- **Create reflex** dialog — displayName + description → live POST to Fabric Items API (UAT-verified)
- Per-reflex **Rules table** — name · object/property · condition (operator + value) · action kind · state · last triggered
- **Add rule** dialog — name + raw JSON condition + raw JSON action (no form builder)
- **Trigger** button per rule → POST that calls the rules-preview endpoint to fire the rule once
- Refresh button · error MessageBars surfaced verbatim from Fabric REST
- Ribbon stub with action labels (Email · Teams · Run pipeline · Run notebook · Power Automate) — labels only, no handlers

## Gaps for parity

1. **Object Explorer tree** — Loom shows reflexes as a flat list; missing the events → objects → properties → rules hierarchy with select-to-edit
2. **Event source registration** — no "Get data" to subscribe an Eventstream / PBI visual / RTD visual to the reflex
3. **Assign to object** — no UI to map event columns to `objectId` + `properties[]`
4. **Property authoring** — no way to define computed properties (e.g., 1h rolling average) reused across rules
5. **Form-based rule builder** — Loom only accepts raw JSON for `condition` and `action`; no Monitor/Condition/Filter/Action stepper, no operator drop-down, no stateful-operator support (`BECOMES`, `INCREASES BY`, etc.)
6. **Occurrence modifier** — not exposed (every time vs. N consecutive vs. duration)
7. **Property filter step** — not exposed (up to 3 ANDed filters)
8. **Action configuration** — actions are free-form JSON; missing typed forms for Teams (recipients/headline/context), Email (subject/body), Fabric-item picker, Power Automate flow URL picker
9. **`@property` mention support** — no insertion UI for live property values into action payloads
10. **Advanced settings** — no `Wait time for late-arriving events` control; no `Query frequency` for query-backed sources
11. **Monitor chart** — no live chart of the monitored property + threshold overlay
12. **Analytics panes** — no "activations over time" or "top 5 object IDs" charts
13. **Activation history** — Loom shows `last triggered` timestamp only; no full history log with payload + action result
14. **Preview rules** — no "would have fired N times on the last X hours" replay simulation
15. **Test fire UX** — Loom has a `Trigger` button but no confirmation dialog showing the actual payload / target / parameter values about to be sent
16. **Start/Stop activation toggle** — Loom rule state is read-only; no UI to activate/deactivate without re-POSTing

## Backend mapping

Live Fabric REST is the canonical path (working today):
- **List / create reflexes** — Fabric Items API `POST /v1/workspaces/{workspaceId}/items` with `type: Reflex` (Loom uses this; UAT-verified)
- **List / create / trigger rules** — Reflex rules preview API `POST /v1/workspaces/{workspaceId}/reflexes/{id}/rules` (Loom uses this when the tenant has the preview API enabled — surfaced via MessageBar otherwise)
- **Reflex definition JSON** — full `ReflexEntities` payload per Microsoft Learn ([Reflex definition](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/reflex-definition)) — `eventstreamSource-v1`, `timeSeriesView-v1` (events/objects/properties/rules), `fabricItemAction-v1`
- **Action types** — `TeamsMessage`, `EmailMessage`, `FabricItemInvocation`, custom (Power Automate webhook)

**Fallback path for sovereign/disconnected deployments without the Reflex API**:
- **Event Hubs** (raw event ingress)
- **Azure Logic Apps Standard** (rule evaluation + action fan-out) — declarative trigger/condition/action workflow that matches Activator's mental model 1:1
- **Azure Monitor Alerts** + **Action Groups** as a degraded path for simple threshold rules on Kusto metrics
- All three already in Loom's roadmap; the Activator editor would target the Reflex API when available and fall through to Logic Apps + Event Hubs when not

## Required Azure resources

For the Fabric REST path: none new — Loom already authenticates and calls the Reflex API.

For the fallback (sovereign / no-Reflex) path:
- **Event Hubs namespace + hub** (`Microsoft.EventHub/namespaces`) — already required for Eventstream parity
- **Logic Apps Standard** (`Microsoft.Web/sites` kind `workflowapp`) — new, one per reflex
- **Storage account** (Logic Apps state) — co-locate with the Logic App
- **Optional**: Azure Monitor metric alert + Action Group for the simple threshold subset

## Estimated effort

3 sessions. Form-based rule builder + Object Explorer tree is ~1 session (the biggest UX lift). Action-type typed forms (Teams / Email / Fabric-item picker / Power Automate) + `@property` mention support is ~1 session. Monitor chart + Analytics panes + Activation history + Preview/Test fire is the third session. The sovereign fallback (Logic Apps generator) is a separate ~2-session track owned by the bicep+runtime side, not by this editor.
