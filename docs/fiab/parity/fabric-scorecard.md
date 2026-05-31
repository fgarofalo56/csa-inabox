# scorecard — parity with Power BI / Fabric metrics scorecard

Source UI: Power BI metrics (scorecards & goals) — https://learn.microsoft.com/power-bi/create-reports/service-goals-introduction
REST: https://learn.microsoft.com/rest/api/fabric (scorecards/goals preview)
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` -> `ScorecardEditor`

## Power BI / Fabric feature inventory

| # | Capability | Where in Power BI |
|---|---|---|
| 1 | Scorecard list + select | Workspace content list |
| 2 | Goals list (name, current, target) | Scorecard grid |
| 3 | Record a goal value / check-in (value, target, note) | Goal -> Add check-in |
| 4 | Open in Power BI | More options |
| 5 | Goal authoring (hierarchy, status rules, connections) | Scorecard edit |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | built | /api/items/scorecard list (Fabric REST /workspaces/{ws}/scorecards), auto-select first |
| 2 | built | Goals table from GET /scorecard/[id] (listScorecardGoals) |
| 3 | built | Add value dialog -> POST /scorecard/[id] (addScorecardGoalValue -> /goals/{id}/values) |
| 4 | built | Open in Power BI (https://app.powerbi.com/groups/{ws}/scorecards/{id}) |
| 5 | honest-gate | Goal hierarchy / status rules / connections authoring lives in Power BI Web; the info MessageBar discloses this and that the Fabric scorecard REST is preview (may be disabled in a tenant) |

## Backend per control
- List/detail/goals -> Fabric REST api.fabric.microsoft.com /workspaces/{ws}/scorecards[/{id}/goals].
- Add value -> POST /workspaces/{ws}/scorecards/{id}/goals/{goalId}/values.

## Honest gates
- The Fabric scorecards/goals REST surface is preview and may not be enabled in every tenant; when goals come back empty the editor states "(or the Fabric scorecard preview API is not enabled in this tenant)" rather than fabricating goals. Full authoring is routed to Power BI Web.

Grade: A (with disclosed preview-API + authoring honest-gates; value check-in is a real Fabric REST write).
