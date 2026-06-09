# copilot-studio-knowledge — parity with Copilot Studio (knowledge)

Source UI: Copilot Studio → agent → Knowledge.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/knowledge-add-file-upload>

## Feature inventory

1. List knowledge sources.
2. Add source (URL / file / SharePoint / Dataverse table).
3. Remove source.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | `msdyn_knowledgesources` |
| Add | built ✅ | type dropdown + name + URI |
| Remove | built ✅ | per-row Remove |

## Backend per control

- `listKnowledgeSources`/`addKnowledgeSource`/`deleteKnowledgeSource` (Dataverse `msdyn_knowledgesources`).

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
