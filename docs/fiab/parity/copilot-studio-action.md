# copilot-studio-action — parity with Copilot Studio (actions)

Source UI: Copilot Studio → agent → Actions.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/advanced-plugin-actions>

## Feature inventory

1. List bound actions.
2. Bind action (Power Automate flow / custom connector / prebuilt).
3. Remove action.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | `msdyn_bot_actions` |
| Bind | built ✅ | type dropdown + flow/connector id |
| Remove | built ✅ | per-row Remove |

## Backend per control

- `listActions`/`bindAction`/`deleteAction` (Dataverse `msdyn_bot_actions`).

## Per-cloud notes

Copilot Studio is a **Power Platform / Dataverse** workload — sovereign routing
is Dataverse-specific. `lib/azure/copilot-studio-client.ts` reads the BAP host
from env (`LOOM_POWER_PLATFORM_BAP_BASE`) so the same code targets each cloud.

| Concern | Commercial / GCC | GCC-High | IL5 / DoD |
| --- | --- | --- | --- |
| BAP base (`LOOM_POWER_PLATFORM_BAP_BASE`) | `api.bap.microsoft.com` | `api.bap.microsoft.us` | Power Platform unavailable — honest ⚠️ gate |
| Dataverse host | `*.crm.dynamics.com` / `*.crm9.dynamics.com` (GCC) | `*.crm.microsoftdynamics.us` | N/A |
| Dataverse auth | `LOOM_DATAVERSE_CLIENT_ID` / `_SECRET` / `_TENANT_ID` (MSAL SP) | same vars, US-cloud audience | N/A |
| Availability | GA | GA with limits | not available — render `MessageBar intent="error"` |
