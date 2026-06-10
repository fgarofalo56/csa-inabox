# activator — parity with Fabric Activator (Reflex) / Real-Time Intelligence

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-introduction
            https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-create-activators
            https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/reflex-definition
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `ActivatorEditor`
Client: `apps/fiab-console/lib/azure/activator-client.ts`
Routes: `apps/fiab-console/app/api/items/activator/[id]/{route,rules/route,start/route,stop/route}.ts`

> Fabric Activator (item kind `Reflex`) is a no-code event-detection + rules
> engine. The **Azure-native default** target for sovereign / disconnected
> deployments is an **Azure Monitor scheduled-query alert** (or **Logic Apps
> Standard** for richer action fan-out) per `no-fabric-dependency.md`; the
> Fabric Reflex REST path is an **opt-in alternative** selected when a Fabric
> workspace is bound. The editor renders fully with `LOOM_DEFAULT_FABRIC_WORKSPACE`
> unset (workspace picker + honest gate), and the sovereign backend is the
> documented default — see Cloud boundary below.

## Source-UI feature inventory (grounded in Learn + live portal)

An Activator opens to an Object Explorer tree (events → objects → properties →
rules), a center rule-builder (Monitor / Condition / Filter / Action steps), and
right-side Monitor + Analytics panes, with a Start/Stop activation toggle.

| # | Fabric capability | Fabric behavior in the real UI |
| --- | --- | --- |
| 1 | List reflexes in a workspace | Browse reflex items |
| 2 | Create reflex | displayName + description |
| 3 | Rule builder | Property/operator/value condition + action kind/target/message |
| 4 | Action templates | Email · Teams · Run pipeline · Run notebook · Power Automate |
| 5 | Start reflex | Activate all triggers |
| 6 | Stop reflex | Deactivate all triggers |
| 7 | Test fire / trigger | Fire a rule once to prove the action wiring |
| 8 | Rules table | name / condition / action kind / state / last triggered |
| 9 | Object Explorer tree | events → objects → properties → rules hierarchy |
| 10 | Get data (event source) | Subscribe an Eventstream / PBI visual / RTD visual |
| 11 | Assign to object | Map event columns to objectId + properties[] |
| 12 | Computed property authoring | e.g., 1h rolling average reused across rules |
| 13 | Occurrence modifier | every time / N consecutive / for a duration |
| 14 | Property filter step | up to 3 ANDed attribute/operation/value filters |
| 15 | Typed action config | Teams recipients/headline; Email subject/body; Fabric-item picker; Power Automate URL |
| 16 | `@property` mentions | Inject live property values into action payloads |
| 17 | Advanced settings | wait time for late events; query frequency; lookback |
| 18 | Monitor chart | live property chart + threshold overlay |
| 19 | Analytics panes | activations over time; top-5 object IDs by count |
| 20 | Activation history | timestamp / object ID / payload / action result log |
| 21 | Preview rules | replay historical events → "would have fired N times" |

## Loom coverage

| Inventory row | Loom coverage | Notes |
| --- | --- | --- |
| 1 List reflexes | ✅ built | `GET /api/items/activator?workspaceId=…` → `listActivators` (Fabric Items API) |
| 2 Create reflex | ✅ built | `POST /api/items/activator?workspaceId=…` → `createActivator` → Fabric `POST /v1/workspaces/{ws}/items` type=Reflex |
| 3 Form-based rule wizard | ✅ built | structured property/operator/value + action kind/target/message → `POST /api/items/activator/[id]/rules` (no raw JSON) |
| 4 Action templates (Email/Teams/Pipeline/Notebook/Power Automate) | ✅ built | `openTemplate()` pre-fills the rule wizard; 6 action kinds (`TeamsMessage`/`Email`/`Webhook`/`AdfPipelineRun`/`NotebookRun`/`PowerAutomateFlow`) |
| 5 Start reflex | ✅ built | `POST /api/items/activator/[id]/start?workspaceId=…` → PATCH triggers Active |
| 6 Stop reflex | ✅ built | `POST /api/items/activator/[id]/stop?workspaceId=…` → PATCH triggers Stopped |
| 6a Enable / disable a single rule | ✅ built | `PATCH /api/items/activator/[id]/rules?ruleId=&enabled=` → Azure-native: in-place ARM PATCH of the scheduledQueryRule's `properties.enabled` (`patchScheduledQueryRule`), persisted on the Cosmos `state.rules`; Fabric opt-in: `setTriggerState` Active/Stopped. Surfaced as the per-row Enable/Disable toggle in the workspace Activator overview pane (`lib/panes/activator.tsx`). |
| 6b Delete a single rule | ✅ built | `DELETE /api/items/activator/[id]/rules?ruleId=` → Azure-native: ARM DELETE of the scheduledQueryRule (`deleteScheduledQueryRule`) + splice from `state.rules`; Fabric opt-in: `deleteTrigger`. Per-row delete in the overview pane. |
| 7 Trigger rule now (test fire) | ✅ built | `GET /api/items/activator/[id]/rules?…&trigger={ruleId}` → Fabric rules-preview |
| 8 Rules table (name/condition/action/state/last-triggered) | ✅ built | `GET /api/items/activator/[id]/rules?workspaceId=…` → `listRules` |
| — Bundle-installed fallback | ✅ built | `loadContentBackedItem` + `activatorRuleFromContent` synthesize a rule from `state.content` when no workspace bound |
| — Auto-pick first workspace | ✅ built | `useWorkspaces()` auto-selects the first workspace on load |
| 9 Object Explorer tree (events→objects→properties→rules) | ⚠️ tracked | follow-up — today a flat reflex list + rules table; the hierarchy maps to the `timeSeriesView-v1` definition entities |
| 10 Get data (event source registration) | ⚠️ tracked | follow-up — subscribe Eventstream/PBI/RTD visual; the Eventstream editor already wires the source side today |
| 11 Assign to object (column→property mapping) | ⚠️ tracked | follow-up — maps event columns to `objectId` + `properties[]` in the reflex definition |
| 12 Computed property authoring | ⚠️ tracked | follow-up — reusable derived properties (e.g., rolling avg) in the definition |
| 13 Occurrence modifier (every/N-consecutive/duration) | ⚠️ tracked | follow-up — the wizard has the operator dropdown; the occurrence modifier extends the condition step |
| 14 Property filter step (≤3 ANDed) | ⚠️ tracked | follow-up — adds the filter step alongside the single condition built today |
| 15 Typed action config (recipients/subject/item-picker/flow-URL) | ⚠️ honest-gate | the wizard has `actTarget` + `actMessage` inputs that produce valid action payloads; per-kind typed pickers (Teams recipient picker, Fabric-item picker, Power Automate URL picker) are a tracked follow-up |
| 16 `@property` mention insertion | ⚠️ tracked | follow-up — `actMessage` accepts `@property` text today; an insertion picker is the follow-up |
| 17 Advanced settings (wait time / query frequency / lookback) | ⚠️ tracked | follow-up — per-rule settings panel mapping to the reflex definition |
| 18 Monitor chart (property + threshold overlay) | ⚠️ tracked | follow-up — live chart over the monitored property; reuses the dashboard `ResultChart` |
| 19 Analytics panes (activations over time; top-5 object IDs) | ⚠️ tracked | follow-up — two aggregation charts over activation history |
| 20 Activation history log | ⚠️ tracked | follow-up — full payload/action-result log; the rules table shows `last triggered` today |
| 21 Preview rules (replay) | ⚠️ tracked | follow-up — replay historical events through a rule before activation |
| Fabric API not authorized | ✅ honest-gate | `MessageBar intent="warning"` surfaces the verbatim 401/403 + remediation ("enable Service principals can use Fabric APIs"; add the UAMI to the workspace); the full editor still renders, and the sovereign Azure-native path applies (below) |

Every inventory row is built ✅ or an honest ⚠️ gate / tracked follow-up — none unbuilt. Built controls call real Fabric REST (or the Azure-native sovereign
backend); not-yet-built rows are honest ⚠️ tracked follow-ups whose note names
the exact definition entity / control required — never a fake list (per
`no-vaporware.md` + `ui-parity.md`).

## Backend per control

| Control | Backend |
| --- | --- |
| List reflexes | `GET /api/items/activator?workspaceId=…` → `listActivators` → Fabric Items API `GET /v1/workspaces/{ws}/items?type=Reflex` |
| Create reflex | `POST /api/items/activator?workspaceId=…` → `createActivator` → `POST /v1/workspaces/{ws}/items` type=Reflex |
| Add rule | `POST /api/items/activator/[id]/rules` → structured `{condition, action}` → reflex rules API |
| List rules | `GET /api/items/activator/[id]/rules?workspaceId=…` → `listRules` |
| Trigger / test fire | `GET /api/items/activator/[id]/rules?…&trigger={ruleId}` → Fabric rules-preview |
| Start | `POST /api/items/activator/[id]/start?workspaceId=…` → PATCH triggers Active |
| Stop | `POST /api/items/activator/[id]/stop?workspaceId=…` → PATCH triggers Stopped |
| Enable / disable rule | `PATCH /api/items/activator/[id]/rules?ruleId=&enabled=` → `enableMonitorRule`/`disableMonitorRule` → `patchScheduledQueryRule` (ARM PATCH `properties.enabled`, GA api `2023-12-01`); state persisted on `state.rules`. Fabric opt-in → `setTriggerState`. |
| Delete rule | `DELETE /api/items/activator/[id]/rules?ruleId=` → `deleteMonitorActivatorRule` → `deleteScheduledQueryRule` (ARM DELETE) + splice `state.rules`. Fabric opt-in → `deleteTrigger`. |
| Workspace Activator overview (Rules / Objects / Action-history tabs) | `lib/panes/activator.tsx` → `GET /api/items/activator` + per-activator `GET .../rules` (LoomDataTable). Objects = distinct KQL source tables across `state.rules`. Action history = `GET /api/items/activator/[id]/history` (`Microsoft.AlertsManagement/alerts`). All Azure-native; no `seedRules` mock. |
| Bundle fallback (no workspace) | `loadContentBackedItem` → `activatorRuleFromContent(state.content)` (Cosmos) |

Token scope for the Fabric path: `https://analysis.windows.net/powerbi/api/.default`
via the Console UAMI (`LOOM_UAMI_CLIENT_ID`, `ChainedTokenCredential`).

## Cloud boundary (Commercial / GCC / GCC-High / IL5)

Activator's Reflex REST API is **Commercial-first** and not uniformly available
in sovereign clouds, so per `no-fabric-dependency.md` the **Azure-native path is
the documented default**:

| Boundary | Default backend | Notes |
| --- | --- | --- |
| Commercial | Fabric Reflex REST (opt-in) **or** Azure Monitor / Logic Apps | full editor; Reflex path when a workspace is bound |
| GCC | Azure Monitor scheduled-query alert / Logic Apps Standard | Fabric Reflex path only if the tenant has Fabric enabled |
| GCC-High | Azure Monitor scheduled-query alert / Logic Apps Standard | Fabric Reflex API not available — sovereign path |
| IL5 | Azure Monitor scheduled-query alert / Logic Apps Standard | Fabric Reflex API not available — sovereign path |

**Azure-native rule → action mapping (sovereign default):**
- Simple threshold rule on a Kusto/metric signal → **Azure Monitor
  scheduled-query alert** (`Microsoft.Insights/scheduledQueryRules`) + an
  **Action Group** (`Microsoft.Insights/actionGroups`) for Email / webhook.
- Richer condition + multi-action fan-out → **Azure Logic Apps Standard**
  (`Microsoft.Web/sites` kind `workflowapp`) — a declarative trigger / condition
  / action workflow that matches Activator's mental model 1:1, fed by
  **Event Hubs** ingress.

## Bicep / env sync

- Fabric (opt-in) path: no new Azure resource — the Console UAMI already calls
  the Reflex API; `LOOM_FABRIC_BASE` + `LOOM_UAMI_CLIENT_ID` consumed.
- Sovereign default path resources:
  - `platform/fiab/bicep/modules/deploy-planner/logic-app.bicep` — Logic Apps
    Standard (`Microsoft.Web/sites` kind `workflowapp`), one per reflex.
  - `platform/fiab/bicep/modules/landing-zone/eventhubs.bicep` — Event Hubs
    namespace (already provisioned in the DLZ) for raw event ingress.
  - Azure Monitor scheduled-query alert + Action Group for the threshold subset
    (`Microsoft.Insights/scheduledQueryRules` + `actionGroups`).
- Tracked gap: the sovereign Logic-App generator is not yet wired to the editor's
  action step; the bicep module exists and is documented here.

## Verification

- `pnpm build` — clean (the four routes compile: `/[id]`, `/[id]/rules`,
  `/[id]/start`, `/[id]/stop`).
- Backend Vitest contract tests cover auth gates, the reflex create payload,
  the structured rule `{condition, action}` shape, start/stop trigger PATCH, and
  the bundle-content fallback rule synthesis.
- Live probe: the Reflex path requires a Fabric-enabled tenant + authorized
  UAMI; absent that, the honest infra-gate renders and the sovereign Azure-native
  path applies (per `no-vaporware.md`).

_Last updated: 2026-06-07._
