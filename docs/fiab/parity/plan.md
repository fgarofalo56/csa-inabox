# plan — parity with Fabric IQ Plan (preview)

Source UI: Fabric IQ → Plan (preview) · https://learn.microsoft.com/fabric/iq/plan/overview

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Task list (title, owner, due, status) | planning grid |
| 2 | Dependencies between tasks | dependency column |
| 3 | Add / delete tasks | grid actions |
| 4 | Progress / status rollup | summary |
| 5 | Overdue / timeline awareness | status badges |
| 6 | Save | save |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | editable table: title, owner, due (date picker), status select |
| 2 | ✅ built | "Depends on" column (task title reference) |
| 3 | ✅ built | New task / Delete row |
| 4 | ✅ built | counts (todo/doing/done) + % complete progress bar |
| 5 | ✅ built | overdue badge (due date passed and not done) |
| 6 | ✅ built | SaveBar + Ctrl+S → Cosmos item state |

## Backend per control
- All edits → PATCH `/api/items/plan/[id]` (Cosmos). Functional setState avoids stale-closure clobber on rapid edits.
- Rollup/overdue computed client-side from task state.
- Approval-workflow handoff to `power-automate-flow` + semantic-model writeback: disclosed as deferred in the editor MessageBar (honest disclosure, no disabled button).
