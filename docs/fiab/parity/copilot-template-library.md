# copilot-template-library — parity with Copilot Studio (agent templates)

Source UI: Copilot Studio → Create → templates gallery.
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/authoring-first-bot>

## Feature inventory

1. Template gallery grouped by category.
2. Template detail (description, suggested model, knowledge/topic counts).
3. "Use template" → instantiate an agent in the target environment.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| Gallery | built ✅ | category-grouped cards (Cosmos-backed) |
| Detail | built ✅ | description, model, knowledge/topic badges |
| Use template | built ✅ | creates agent + knowledge + topics in selected env |

## Backend per control

- List → `GET /api/items/copilot-template-library`
- Use → `POST .../[id]` — creates a real `msdyn_copilots` agent and seeds knowledge/topics via the Dataverse Web API.

## Per-cloud notes

The gallery is Cosmos-backed (cloud-agnostic); "Use template" instantiates a
real agent via **Power Platform / Dataverse**, so its sovereign routing is
Dataverse-specific. `lib/azure/copilot-studio-client.ts` reads the BAP host from
env (`LOOM_POWER_PLATFORM_BAP_BASE`) so the same code targets each cloud.

| Concern | Commercial / GCC | GCC-High | IL5 / DoD |
| --- | --- | --- | --- |
| Gallery (Cosmos) | works in every cloud | works | works (template list renders; "Use" gated) |
| BAP base (`LOOM_POWER_PLATFORM_BAP_BASE`) | `api.bap.microsoft.com` | `api.bap.microsoft.us` | Power Platform unavailable — honest ⚠️ gate on "Use template" |
| Dataverse host | `*.crm.dynamics.com` / `*.crm9.dynamics.com` (GCC) | `*.crm.microsoftdynamics.us` | N/A |
| Dataverse auth | `LOOM_DATAVERSE_CLIENT_ID` / `_SECRET` / `_TENANT_ID` (MSAL SP) | same vars, US-cloud audience | N/A |
| Availability | GA | GA with limits | "Use template" not available — render `MessageBar intent="error"` |
