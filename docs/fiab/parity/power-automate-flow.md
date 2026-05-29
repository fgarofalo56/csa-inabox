# power-automate-flow — parity with the Power Automate flow designer

Source UI: Power Automate (`make.powerautomate.com → My flows`).
Learn: <https://learn.microsoft.com/power-automate/get-started-logic-flow>

## Feature inventory

1. List flows (name, state, trigger, modified).
2. Flow detail (metadata).
3. Run flow (manual trigger).
4. Run history (status, start/end, error).
5. Edit in designer — portal-only canvas.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | Flow admin API |
| Detail | built ✅ | metadata grid |
| Run | built ✅ | manual trigger POST |
| Run history | built ✅ | `…/runs` with status badges |
| Edit in designer | honest-gate ⚠️ | "Open in Power Platform" deep-link (portal-only canvas) |

## Backend per control

- List → `listFlows`; Detail → `getFlow`; Run → `runFlow` (manual trigger); Runs → `listFlowRuns`.
