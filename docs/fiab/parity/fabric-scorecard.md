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
| 5 | Subgoal rollup (Sum / Average / Min / Max) | Goal settings -> Rollup |
| 6 | Status rules (threshold -> status color), ordered, % of target or value | Goal settings -> Status rules |
| 7 | Goal status display (On Track / At Risk / Behind / Completed / Not Started) | Scorecard grid status column |
| 8 | Goal authoring (hierarchy, connections) | Scorecard edit |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | built | /api/items/scorecard list (Fabric REST /workspaces/{ws}/scorecards), auto-select first |
| 2 | built | Goals table from GET /scorecard/[id] (listScorecardGoals) |
| 3 | built | Add value dialog -> POST /scorecard/[id] (addScorecardGoalValue -> /goals/{id}/values) |
| 4 | built | Open in Power BI (cloud-correct host via NEXT_PUBLIC_LOOM_POWERBI_PORTAL; hidden when empty for GCC-High/IL5) |
| 5 | built | **Azure-native** rollup engine (`app/api/items/scorecard/rollup.ts`) — Sum/Average/Min(worst-child)/Max. Configured per-goal via the "Configure rollups" panel (dropdowns, no freeform). Parent goal shows rolled-up `computedValue`. No Fabric dependency. |
| 6 | built | Ordered status rules (operator + threshold + value/%-of-target -> status color), first-match-wins + Otherwise fallback. Edited in the rollup panel via fixed-enum Selects. Computed server-side in the BFF. |
| 7 | built | Status column renders a Fluent Badge per goal (success/warning/danger/informative/subtle) reflecting the computed status. |
| 8 | honest-gate | Live Fabric goal hierarchy / connections authoring still routes to Power BI Web; the rollup + status config Loom applies is overlaid onto live goals via the Cosmos `scorecard-config` container (loom: bundle scorecards carry it inline in state.content). |

## Backend per control
- List/detail/goals -> Fabric REST api.fabric.microsoft.com /workspaces/{ws}/scorecards[/{id}/goals] (opt-in; loom: items use state.content with no Fabric call).
- Add value -> POST /workspaces/{ws}/scorecards/{id}/goals/{goalId}/values.
- Rollup + status -> `computeRollups()` pure engine in the BFF (Azure-native, no Fabric); config persisted to / loaded from Cosmos `scorecard-config` (PK /scorecardId) via GET/PATCH `/api/items/scorecard/[id]/config`.

## Honest gates
- The Fabric scorecards/goals REST surface is preview and may not be enabled in every tenant; when goals come back empty the editor states "(or the Fabric scorecard preview API is not enabled in this tenant)" rather than fabricating goals. Live-goal *authoring* (hierarchy/connections) is routed to Power BI Web, but **rollup + status rules are fully functional in Loom** against the Azure-native engine + Cosmos config — no Fabric workspace required.

## Cloud matrix
| Dimension | Commercial | GCC | GCC-High | IL5 |
|---|---|---|---|---|
| Rollup engine + status rules | BFF (Cosmos overlay) | BFF | BFF (loom:/state.content) | BFF (loom:/state.content) |
| Config persistence | Cosmos `scorecard-config` | Cosmos | Cosmos / inline | Cosmos / inline |
| "Open in Power BI" host | app.powerbi.com (default) | set NEXT_PUBLIC_LOOM_POWERBI_PORTAL=app.powerbigov.us | set to "" (hidden) | set to "" (hidden) |

Grade: A (rollup + status rules are a real Azure-native BFF compute over real Cosmos config — verified by `app/api/items/__tests__/scorecard-rollup.test.ts` covering sum/avg/min/max + value + %-of-target + the FedRAMP worst-child scenario; live-goal authoring honest-gates to Power BI Web).
