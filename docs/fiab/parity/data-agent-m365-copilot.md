# data-agent-m365-copilot — parity with Copilot Studio "Publish to Microsoft 365 Copilot"

Source UI: Copilot Studio → agent → **Channels → Teams and Microsoft 365 Copilot**
(https://learn.microsoft.com/microsoft-copilot-studio/publication-add-bot-to-microsoft-teams) +
Publish agents for Microsoft 365 Copilot
(https://learn.microsoft.com/microsoft-365/copilot/extensibility/publish)

Loom surface: data-agent editor → **Publish** tab → "Publish to Microsoft 365 Copilot" section.

## Azure / Copilot Studio feature inventory (grounded in Learn)

1. Build / configure an agent (instructions + knowledge + sources).
2. Publish the agent (makes it available to channels).
3. Open the **Teams and Microsoft 365 Copilot** channel config panel.
4. Toggle **Make agent available in Microsoft 365 Copilot** (else Teams-only).
5. **Add channel** — registers the agent on the Teams + M365 Copilot channel.
6. Submission flows to the **Microsoft 365 admin center → Agents → Requests** for
   tenant-admin approval before end-user availability in the M365 Copilot Agent Store.
7. Re-publish after edits updates all connected channels.

## Loom coverage

| Capability | Status | Notes |
|---|---|---|
| Build agent from data-agent config | built ✅ | Data-agent Build tab (instructions + typed 5-source picker) |
| Upsert Copilot Studio agent | built ✅ | `upsertAgentByName` → Dataverse `msdyn_copilot` (idempotent by name) |
| Attach knowledge / source reference | built ✅ | `addKnowledgeSource` (Loom item deep link when `LOOM_CONSOLE_PUBLIC_URL` set) |
| Publish the agent | built ✅ | `publishAgent` → `msdyn_PublishCopilot` bound action |
| Teams + M365 Copilot channel | built ✅ | `publishToChannel`/PATCH `msdyn_botchannels` type `msteams` |
| "Make available in M365 Copilot" toggle | built ✅ | Fluent `Switch`; sets `makeAvailableInMicrosoft365Copilot` in channel config |
| Environment selection | built ✅ | Fluent `Dropdown` over `listEnvironments()` (no raw env-id field) |
| Re-publish (idempotent) | built ✅ | Re-uses existing agent + channel rows; vitest covers both paths |
| Tenant-admin approval | honest-gate ⚠️ | Outside Loom RBAC; result MessageBar links the M365 admin center Requests queue |
| No Copilot Studio env configured | honest-gate ⚠️ | Warning MessageBar names `LOOM_COPILOT_STUDIO_ENVIRONMENT_ID` + `LOOM_DATAVERSE_*` |

Zero ❌. No Microsoft Fabric / Power BI dependency — Power Platform / Dataverse is
an honest Azure-family requirement, surfaced as an infra-gate when absent.

## Backend per control

- Environment dropdown → `GET /api/items/data-agent/[id]/m365-copilot` → `listEnvironments()` (BAP admin REST).
- "Publish to M365 Copilot" button → `POST /api/items/data-agent/[id]/m365-copilot` →
  `publishToM365Copilot()` → Dataverse Web API (`msdyn_copilots`, `msdyn_knowledgesources`,
  `msdyn_PublishCopilot`, `msdyn_botchannels`). Receipt persisted to the Cosmos item (`state.m365Copilot`).

## Tests

`lib/azure/__tests__/copilot-studio-m365-publish.test.ts` — mocks `@azure/identity`
+ `fetch`; asserts create→publish→channel, idempotent re-publish (PATCH agent + channel),
and `resolvePublishEnvId` precedence.
