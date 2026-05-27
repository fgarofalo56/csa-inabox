# Copilot Studio Action Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Copilot Studio: advanced-flow, advanced-flow-input-output, advanced-connectors, authoring-connections, add-tools-custom-agent, guidance/agent-tools, nlu-prompt-node, advanced-generative-actions, advanced-use-skills) + inspection of `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotActionEditor` and `listActions` / `bindAction` in `apps/fiab-console/lib/azure/copilot-studio-client.ts`.

## Overview

Actions (also called **Tools** in current Copilot Studio terminology) let an agent take action on external systems — call REST APIs, run business logic, invoke AI prompts, query data. They're the agent's hands. Each action declares typed **inputs** (collected from the conversation) and **outputs** (returned to the agent for use in subsequent nodes). The orchestrator in generative mode picks tools dynamically based on the user's intent and the tool's description; in classic mode, topics explicitly call tools via a **Call an action** node. Tools come in five flavors: Power Automate flow, prebuilt connector action, custom connector action, AI prompt, and Bot Framework skill.

## Copilot Studio UX

### Tools page chrome
- Left rail entry: **Tools** (formerly **Actions** / **Plugins**)
- List columns: name · type icon · description · used-by-N-topics · last-modified
- Row actions: **Edit** · **Test** · **Delete** · **Enable/Disable** · **View runs**
- Top-right: **Add a tool** dropdown — `New action` (Power Automate flow) · `Prebuilt connector` · `Custom connector` · `Prompt` (Foundry/GPT) · `Skill` (Bot Framework manifest URL) · `Conversational tool` (from another agent)

### Tool authoring

#### Power Automate flow tool
- Pick existing flow from env, or **Create new** → opens Power Automate authoring canvas pre-seeded with a "When Power Virtual Agents calls a flow" trigger
- **Inputs** — typed parameters declared on the flow trigger (`Number`, `String`, `Boolean` — list/object/date types NOT supported as inputs from the agent)
- **Outputs** — typed return values from the "Return value(s) to Power Virtual Agents" action at the end of the flow
- **Description** — used by the orchestrator to decide when to call this tool (mandatory for generative mode)
- **Authentication** — flow runs as the maker (default) or as the end user (per-user connections)

#### Prebuilt connector action
- Browse ~1500 Power Platform connectors (Salesforce · ServiceNow · Jira · SharePoint · Outlook · Teams · Dataverse · Microsoft Graph · OpenAI · etc.)
- Pick an operation (e.g. SharePoint → `Create item`, Outlook → `Send email`)
- **Connection reference** — bind to an env-scoped connection (which authenticates with shared creds or per-user OBO)
- Map agent variables to connector operation parameters (typed)
- Map connector response fields to agent output variables
- **Description** — orchestrator routing hint

#### Custom connector action
- Pick a custom connector defined in the env (`Microsoft.PowerApps/connectors`)
- Same flow as prebuilt connector
- Custom connectors are defined separately in Power Apps maker portal (OpenAPI spec or "from blank" with HTTP triggers)
- **Auth modes**: OAuth 2.0 (Entra preferred) · API key · Basic · No auth · Windows

#### AI prompt tool
- Author a prompt with typed inputs (variables) referenced as `{{var}}`
- Pick **Model** — GPT-4o / GPT-4o-mini / Foundry-deployed model
- Optional **Grounding sources**: Dataverse table · uploaded file · image input
- Optional **Code interpreter** for structured data
- **Output format**: text · JSON (with declared schema)
- **Temperature** · **Max tokens**
- Tested in Prompt Builder before binding

#### Bot Framework skill
- **Manifest URL** — points to a Bot Framework skill manifest (V3) describing actions + activities
- Skill registration tokens are managed by Azure Bot Service
- Agent calls skill actions like sub-conversations

### Connections page (linked from Tools)
- List all env connections used by Tools
- Per connection: connector name · auth mode · owner · status (Connected · Expired · Failed)
- **Test connection** · **Reconnect** · **Delete**

### Tool runs / activity
- Per-tool runs list with status (Success · Failed · Pending) · inputs · outputs · timestamp · cost (for AI prompts)
- Drill-down to per-run trace (Power Automate run details / connector call response / prompt completion text)

## What Loom has today

From `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotActionEditor` and `app/api/items/copilot-studio-action/**`:
- Env picker + agent picker (shared)
- List actions (`GET /msdyn_bot_actions?$filter=_msdyn_copilotid_value eq {agentId}`)
- Per-action row: name · type · connectorId · flowId · enabled (statecode==0)
- **Bind action** dialog with a `type` dropdown (`power-automate-flow | custom-connector | prebuilt`) + free-text `name`, `connectorId`, `flowId`
- POST to `/msdyn_bot_actions` with `msdyn_copilotid@odata.bind`
- **Delete action**
- MessageBar for Copilot-Studio-not-enabled 503

## Gaps for parity

1. **Tool-type coverage** — Loom supports the metadata for flow / custom-connector / prebuilt, but is missing AI prompt and Bot Framework skill tool types
2. **Flow picker** — Loom takes a free-text `flowId`; no list of env-scoped Power Automate flows with name/owner/last-run
3. **Create new flow** — no entry point to open Power Automate authoring canvas pre-seeded with the PVA trigger
4. **Connector browser** — no UI to browse the 1500+ connectors with category filters + auth-mode info + premium-badge surfacing
5. **Connector operation picker** — no operation list per connector (e.g. SharePoint → `Create item`, `Get items`, `Update item`)
6. **Typed input/output mapping** — Loom binds the action shell only; the per-input variable mapping (`Number | String | Boolean`) is not authored, and no validation against the connector's OpenAPI schema
7. **Description field** — `msdyn_description` not exposed; orchestrator generative-routing breaks without it
8. **Connection reference picker** — Loom can't pick or create env connections; no `connectionreferences` table integration
9. **AI prompt authoring** — no Prompt Builder embed for model + temperature + grounding sources + output schema
10. **Bot Framework skill manifest URL** — not exposed
11. **Tool runs / activity feed** — no per-run inputs/outputs/status drill-down
12. **Test action** — Loom has no way to fire a tool with synthetic inputs and inspect the output
13. **Enabled/Disabled toggle** — `statecode` is read-only in Loom (mapped to `enabled` boolean but not writable)
14. **Used-by-N-topics** — Loom doesn't compute the reverse lookup (which topics call this tool)
15. **Per-user vs shared auth** — connection auth mode not exposed
16. **DLP impact** — env DLP policy may block a connector; Loom doesn't surface why a tool fails to bind
17. **Custom-connector OpenAPI import** — no embed of the custom-connector authoring flow (defined in Power Apps maker portal)
18. **List/object/date input parameters** — Microsoft Learn explicitly calls out these are NOT supported as flow inputs from the agent; Loom should validate and block

## Backend mapping

Dataverse Web API:
- **Action CRUD** — `msdyn_bot_actions` (id · name · type · `msdyn_connectorid` · `msdyn_flowid` · `_msdyn_copilotid_value` · statecode · description · inputs JSON · outputs JSON)
- **Tools/Plugins (new framework)** — recent Copilot Studio versions are migrating to `msdyn_plugin` + `msdyn_pluginaction` tables (declarative-agent tool framework); Loom currently targets the older `msdyn_bot_actions` table — for forward parity, also support `msdyn_plugin` rows
- **Power Automate flow lookup** — `workflow` table (Dataverse) `category=5` (modern flow); flow's PVA trigger is identified by `clientdata` JSON containing `"connectorName":"shared_powervirtualagents"`
- **Custom connector lookup** — `connector` table (Dataverse legacy) or `Microsoft.PowerApps/connectors` ARM
- **Prebuilt connector metadata** — Power Platform REST `https://api.powerapps.com/providers/Microsoft.PowerApps/apis?api-version=2020-06-01` returns the full connector list + per-connector OpenAPI
- **Connections** — `connectionreferences` table (Dataverse); each tool binds via `msdyn_connectionreferenceid`
- **AI prompts** — `msdyn_aimodel` + `msdyn_aimodelschema` tables; prompt versions in `msdyn_aigeneration`
- **Skills** — `botcomponent` rows of skill kind referencing manifest URL
- **Run history** — Power Automate run records in `flowrun` table (env-scoped) + cross-ref to bot conversation log
- **Train + publish** — `msdyn_PublishCopilot` bound action regenerates the orchestrator's tool registry from `msdyn_bot_actions` / `msdyn_plugin` rows

## Required Azure resources / tenant settings

- All Agent-editor prerequisites
- **Power Automate license** for the SP/env (Per User / Per Flow / included with Copilot Studio license)
- **Premium connector** licensing for connectors flagged premium (Salesforce / ServiceNow / SQL / etc.) — Power Apps per-user or per-app plan
- **Connection references** for each connector in scope — SP needs `prvReadconnectionreference` + `prvWriteconnectionreference`
- **For AI prompts**: Azure OpenAI / Foundry model deployment with quota; alternatively the default GPT-4o family included with Copilot Studio messages
- **For Bot Framework skills**: Azure Bot Service resource (`Microsoft.BotService/botServices`) registered as the skill endpoint
- **DLP policy review** — env DLP policy must permit the connectors the agent will use

## Estimated effort

3–4 sessions. Flow picker + connector browser + connector operation list + typed input/output mapping is ~1.5 sessions (Power Platform REST integration + OpenAPI rendering). AI prompt builder embed + description field + enabled/disabled toggle + used-by lookup is ~1 session. Tool runs / activity feed + Test-action panel + DLP impact viewer is ~1 session. Bot Framework skill + custom-connector OpenAPI import + `msdyn_plugin` forward-compat layer can fold into the third session, or carry into a follow-on if scope tight.
