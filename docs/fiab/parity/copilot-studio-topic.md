# copilot-studio-topic — parity with Copilot Studio (topics)

Source UI: Copilot Studio → agent → Topics.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/authoring-create-edit-topics>

## Feature inventory

1. List topics.
2. Create / edit topic (name, trigger phrases, flow definition).
3. Delete topic.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | `msdyn_botcomponents` componenttype 9 |
| Create/edit | built ✅ | name + trigger phrases + Monaco YAML editor; Ctrl+S; dirty guard |
| Delete | built ✅ | per-card Delete |

## Backend per control

- `listTopics`/`getTopic`/`upsertTopic`/`deleteTopic` (Dataverse `msdyn_botcomponents`).

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
