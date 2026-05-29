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
