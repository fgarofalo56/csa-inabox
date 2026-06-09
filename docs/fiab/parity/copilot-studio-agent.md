# copilot-studio-agent — parity with Copilot Studio (agent)

Source UI: Copilot Studio (`copilotstudio.microsoft.com → Agents → <agent>`).
Learn: <https://learn.microsoft.com/microsoft-copilot-studio/authoring-test-bot>,
<https://learn.microsoft.com/microsoft-copilot-studio/publication-connect-bot-to-custom-application>

## Feature inventory

1. Agent config — name, description, instructions, model deployment.
2. Topics list.
3. Actions.
4. Knowledge sources.
5. Channels.
6. Publish.
7. Test chat ("Test your agent" panel over Direct Line).
8. Delete.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| Config (CRUD) | built ✅ | name/description/instructions/model; Save/Create/Delete; Ctrl+S; dirty guard |
| Topics | built ✅ | Topics tab (inline TopicsPanel) |
| Actions | built ✅ | Actions tab (inline ActionsPanel) |
| Knowledge | built ✅ | Knowledge tab (inline KnowledgePanel) |
| Channels | built ✅ | Channels tab (inline ChannelsPanel) |
| Publish | built ✅ | bound action `msdyn_PublishCopilot` |
| Test chat | built ✅ | **NEW** Test tab — live Direct Line conversation; honest 424 gate when no DL secret |
| Delete | built ✅ | Dataverse DELETE on `msdyn_copilots` |

Zero ❌.

## Backend per control

- CRUD → `listAgents`/`getAgent`/`createAgent`/`updateAgent`/`deleteAgent` (Dataverse `msdyn_copilots`)
- Publish → `publishAgent` (`msdyn_PublishCopilot`)
- Test chat → `POST .../[id]/directline-token` → `getDirectLineToken` (Bot Framework Direct Line token-generate);
  the browser then drives `directline.botframework.com/v3/directline` (start conversation, post activity, poll).
  Requires `LOOM_COPILOT_DIRECTLINE_SECRET[_<agentId>]`; absent → honest 424 MessageBar with the exact env var.

## Per-cloud notes

Copilot Studio is a **Power Platform** workload, so its sovereign routing is
Power-Platform/Dataverse-specific (not the AOAI routing the rest of the Copilot
family uses). `lib/azure/copilot-studio-client.ts` reads the BAP host and Direct
Line token URL from env so the same code targets each cloud.

| Concern | Commercial / GCC | GCC-High | IL5 / DoD |
| --- | --- | --- | --- |
| BAP base (`LOOM_POWER_PLATFORM_BAP_BASE`) | `api.bap.microsoft.com` (default) | `api.bap.microsoft.us` (set the env var) | Power Platform unavailable — honest ⚠️ gate |
| BAP token scope (`BAP_SCOPE`) | `api.bap.microsoft.com/.default` | currently hardcoded to `.com`; GCC-High needs `api.bap.microsoft.us/.default` (known follow-up — surfaced as an honest gate if the token is rejected) | N/A |
| Dataverse host | `*.crm.dynamics.com` / `*.crm9.dynamics.com` (GCC) | `*.crm.microsoftdynamics.us` | N/A |
| Dataverse auth (client-secret SP) | `LOOM_DATAVERSE_CLIENT_ID` / `_SECRET` / `_TENANT_ID` (re-uses the MSAL SP) | same vars; US-cloud audience | N/A |
| Direct Line token URL (`LOOM_DIRECTLINE_TOKEN_URL`) | `directline.botframework.com` (default) | override for GCC-High | not available — Test chat shows the honest 424 gate |
| Copilot Studio availability | GA | GA with limits | not available — render `MessageBar intent="error"` |
