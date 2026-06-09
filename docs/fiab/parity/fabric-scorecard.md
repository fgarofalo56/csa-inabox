# scorecard — parity with Power BI / Fabric metrics scorecard

Source UI: Power BI metrics (scorecards & goals) — https://learn.microsoft.com/power-bi/create-reports/service-goals-introduction
REST: https://learn.microsoft.com/rest/api/fabric (scorecards/goals preview) · https://learn.microsoft.com/rest/api/power-bi/datasets/execute-queries
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` -> `ScorecardEditor`

## Power BI / Fabric feature inventory

| # | Capability | Where in Power BI |
|---|---|---|
| 1 | Scorecard list + select | Workspace content list |
| 2 | Goals grid (name, current, target, status, owner, due) | Scorecard grid |
| 3 | Record a check-in (value, status, note, date) | Goal -> Add check-in |
| 4 | Check-in history per goal | Goal details -> history |
| 5 | Connected metric — goal value pulled live from a model measure | Goal -> Connect to data |
| 6 | Sub-goals (goal hierarchy) | Scorecard edit |
| 7 | Open in Power BI | More options |
| 8 | Goal authoring (status rules, rollups) | Scorecard edit |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | built | /api/items/scorecard list (Fabric REST /workspaces/{ws}/scorecards), auto-select first |
| 2 | built ✅ | Goals grid now has Goal / Current / Target / **Status (badge)** / **Owner** / **Due** + per-row actions, merged from Fabric goals + Cosmos `scorecard-goals` metadata (GET /scorecard/[id]) |
| 3 | built ✅ | Check-in flyout (value SpinButton + status Select + note Textarea + date) -> POST /scorecard/[id]; writes Cosmos `scorecard-checkins` history AND (when live) the Fabric goal value |
| 4 | built ✅ | History flyout -> GET /scorecard/[id]?history=<goalId> (single-partition Cosmos query, newest-first) |
| 5 | built ✅ | Connected-metric binder (dataset Dropdown + DAX expression) -> PUT /scorecard/[id]; live value via GET /scorecard/[id]/metric-value -> aas-client.evaluateDaxScalar -> **Power BI executeQueries** (`EVALUATE ROW("Value", <expr>)`). **Azure-native default — no Fabric capacity required.** Standalone AAS is opt-in (`LOOM_AAS_SERVER` + `LOOM_METRIC_BACKEND=aas-xmla`) and honestly 503-gated (XMLA needs native ADOMD.NET). |
| 6 | built ✅ | Sub-goals: `subGoalIds` stored on the goal record (PUT), rendered indented with a ↳ marker in the grid |
| 7 | built | Open in Power BI (https://app.powerbi.com/groups/{ws}/scorecards/{id}) |
| 8 | honest-gate ⚠️ | Advanced status-rule / rollup authoring lives in Power BI Web; the info MessageBar discloses this. Status + value + connected metric are fully editable in Loom. |

## Backend per control
- List/detail/goals -> Fabric REST api.fabric.microsoft.com /workspaces/{ws}/scorecards[/{id}/goals], merged with Cosmos `scorecard-goals` (PK /scorecardId) extended metadata.
- Check-in -> POST /scorecard/[id]: Cosmos `scorecard-checkins` (PK /goalId) append-only history + (live scorecards only) Fabric POST /goals/{goalId}/values.
- Extended goal metadata (status/owner/due/connectedMetric/subGoalIds) -> PUT /scorecard/[id] upserts Cosmos `scorecard-goals`.
- Connected-metric live value -> GET /scorecard/[id]/metric-value -> `aas-client.evaluateDaxScalar` -> Power BI `executeQueries` REST (scope `analysis.windows.net/powerbi/api`, base via `LOOM_POWERBI_BASE` so Gov uses api.powerbigov.us).

## Honest gates
- The connected-metric default path uses Power BI executeQueries (the only public JSON DAX query API; same VertiPaq engine as AAS). A standalone AAS server requires XMLA — surfaced as a precise 503 (`aas_xmla_not_supported`) with remediation, never a silent failure.
- Bundle-template scorecards (id prefix `loom:`) have no live Fabric goal yet; check-ins are still recorded to Cosmos history (`fabric.recorded:false, reason:scorecard_template_not_live`) so the feature is fully functional with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- The Fabric scorecards/goals REST surface is preview; when goals come back empty the editor states so rather than fabricating goals.

Grade: A (goals grid + connected metrics + check-ins/history all real-backend; advanced status-rule authoring honest-gated to Power BI Web).
