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

## Per-cloud notes

Copilot Studio analytics is served by the **Power Platform admin (BAP)**
endpoint — sovereign routing is BAP-specific.
`lib/azure/copilot-studio-client.ts` reads the BAP host from env
(auto-derived from the detected cloud by
`cloud-endpoints.powerPlatformEndpoints()`; `LOOM_BAP_BASE` overrides) so the same
code targets each cloud.

| Concern | Commercial / GCC | GCC-High | IL5 / DoD |
| --- | --- | --- | --- |
| BAP base (auto-derived; `LOOM_BAP_BASE` overrides) | `api.bap.microsoft.com` | `gov.api.bap.microsoft.us` (GCC) / `high.api.bap.microsoft.us` (GCC High) / `api.bap.appsplatform.us` (DoD) | Power Platform unavailable — honest ⚠️ gate |
| Analytics auth | `LOOM_DATAVERSE_CLIENT_ID` / `_SECRET` / `_TENANT_ID` (MSAL SP) | same vars, US-cloud audience | N/A |
| Empty-data behavior | truthful zeros when the analytics pipeline has no data yet (no mocks) | same | N/A |
| Availability | GA | GA with limits | not available — render `MessageBar intent="error"` |
