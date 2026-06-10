# eventstream-add-alert — parity with Fabric Eventstream "Set alert" (embedded Activator)

Source UI: Microsoft Fabric Real-Time Intelligence → Eventstream → ribbon
**Set alert** action (and the per-node "Set alert" inline action), which creates
a Fabric Activator (Reflex) pre-wired to the selected stream/node as its data
source. Learn: <https://learn.microsoft.com/en-us/fabric/real-time-intelligence/data-activator/activator-get-data-eventstreams>

## Azure / Fabric feature inventory

| # | Capability (Fabric) | Notes |
|---|---------------------|-------|
| 1 | Ribbon **Set alert** quick-create on the Eventstream | One click from the stream surface |
| 2 | Creates a new Activator (Reflex) item and **links** it to the stream | The Activator's data source is pre-populated with the stream |
| 3 | Pre-seeds the alert with the **stream source** | The new alert is scoped to the stream's events without manual rebinding |
| 4 | Condition builder: property + operator + threshold | Typed condition, not raw query |
| 5 | Evaluation cadence | How often the condition is checked |
| 6 | Notification action (email / Teams) | Who is notified when the alert fires |
| 7 | Open the created Activator to manage the rule | Navigate to the rule editor |

## Loom coverage

| # | Capability | Status | How |
|---|------------|--------|-----|
| 1 | Ribbon **Add alert** quick-create | built ✅ | Home → **Alerts** group → "Add alert" opens a typed dialog |
| 2 | Create + **link** a backing Activator | built ✅ | `POST /api/items/eventstream/[id]/activator` lazily creates an `activator` item and links it via `state.activatorId` (reused on subsequent calls) |
| 3 | Pre-seed with the **stream source** | built ✅ | The route resolves the stream's first source node (`sources[]`/`source`/`content.sources[]`) and composes the alert KQL scoped to that source name; the source is stamped on the Activator (`state.sourceNode`) and the rule record |
| 4 | Condition builder (property/operator/threshold) | built ✅ | Dialog fields → composed into the rule KQL by the route |
| 5 | Evaluation cadence | built ✅ | "Evaluate every" dropdown (1m/5m/15m/1h) → `evaluationFrequency` + `windowSize` |
| 6 | Notification action (email) | built ✅ | "Notify email" → `action.target` → real Azure Monitor action group (email receiver) |
| 7 | Open the created Activator | built ✅ | Success receipt links to `/items/activator/<activatorId>` |

Zero ❌. The only non-functional state is the honest Azure infra-gate below.

## Backend per control

| Control | Backend |
|---------|---------|
| Add alert → Create alert | `POST /api/items/eventstream/[id]/activator` → `createOwnedItem('activator', …)` (Cosmos) + `createMonitorActivatorRule()` → real **Azure Monitor** `scheduledQueryRule` + action group (`monitor-client`) |
| Linked-Activator read | `GET /api/items/eventstream/[id]/activator` → reads `state.activatorId` and the Activator's `state.rules` from Cosmos |
| Open Activator | client nav to the existing `activator` editor |

## No-Fabric / Azure-native default

Per `.claude/rules/no-fabric-dependency.md` the Activator backend is the
**Azure-native** path by default: a Loom Activator rule maps to an Azure Monitor
scheduled-query alert rule — identical to the ontology `activator` route and the
`activator/[id]/rules` default branch. **No Fabric Reflex / workspace is
required** and the feature works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. A
Fabric Reflex remains an opt-in alternative (`LOOM_ACTIVATOR_BACKEND=fabric`).

## Honest infra-gate

When Azure Monitor is not yet wired (`LOOM_LOG_ANALYTICS_RESOURCE_ID` /
`LOOM_ALERT_RG` unset, or the Console UAMI lacks Monitoring Contributor on the
alert RG), the dialog shows a Fluent `MessageBar intent="warning"` naming the
exact env var to set / role to grant. These env vars are already declared in
`platform/fiab/bicep/modules/admin-plane/main.bicep` +
`platform/fiab/bicep/modules/admin-plane/monitoring.bicep` (no new bicep
required — this feature reuses the existing Azure Monitor activator wiring).

## Verification

- `npx tsc --noEmit` clean for `phase3-editors.tsx` and the new route.
- Vitest: `lib/editors/__tests__/eventstream-add-alert.test.tsx` covers the
  ribbon action, the typed dialog (no raw JSON), the POST to the activator
  route, and the linked-Activator receipt with the open-Activator link.
