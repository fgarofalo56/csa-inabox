# copilot-studio-analytics — parity with Copilot Studio (analytics)

Source UI: Copilot Studio → agent → Analytics.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/analytics-overview>

## Feature inventory

1. KPI cards — sessions, resolved, escalated, CSAT.
2. Resolution / escalation rate.
3. Daily sessions trend.
4. Time-window selector (7/30/90 days).

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| KPI cards | built ✅ | sessions / resolved / escalated / CSAT |
| Rates | built ✅ | resolution + escalation rate |
| Daily trend | built ✅ | bar sparkline from `daily[]` |
| Window selector | built ✅ | 7/30/90d buttons + ribbon |

Returns truthful zeros when the BAP analytics pipeline has no data yet (no mock data).

## Backend per control

- `getAnalytics` → BAP admin copilots/analytics endpoint.
