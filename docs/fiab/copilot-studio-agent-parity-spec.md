# Copilot Studio Agent Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Copilot Studio: fundamentals-get-started, configure-starter-prompts, nlu-gpt-overview, publication-fundamentals-publish-channels) + inspection of `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotStudioAgentEditor` and `apps/fiab-console/lib/azure/copilot-studio-client.ts`. The Copilot Studio family backs onto Dataverse (`msdyn_copilots`) which only exists once the env admin has enabled Copilot Studio — Loom surfaces a 503 MessageBar with the exact PPAC enablement path when the table is absent.

## Overview

Copilot Studio is Microsoft's low-code agent authoring surface (the successor to Power Virtual Agents). Each agent is a Dataverse row of type `msdyn_copilot` inside a Power Platform environment. The maker UX is centered on a per-agent **Overview** page with five linked workspaces: **Knowledge**, **Topics**, **Tools/Actions**, **Channels**, and **Analytics**. Generative orchestration ties them together — at runtime the orchestrator selects which topic, knowledge source, or tool to invoke based on the agent's instructions, descriptions, and the user's utterance.

## Copilot Studio UX

### Top-level chrome
- Left rail: **Overview · Knowledge · Topics · Tools · Channels · Analytics · Activity · Settings**
- Top bar: agent name + icon · environment picker · **Test your agent** chat panel · **Publish**
- Per-agent **Overview** page is the home — surfaces identity + suggested prompts + AI suggestions for tools/knowledge/channels

### Agent identity (Overview · Edit details)
- **Name** — display name shown in Teams/M365 catalog
- **Description** — 1024-char description; AI uses it to seed instructions + suggested prompts
- **Instructions** — the system-prompt-style guidance the orchestrator uses to pick topics/tools (`msdyn_instructions`)
- **Icon** — PNG, ≤72 KB, ≤192×192 px
- **Schema name** — Dataverse logical name; immutable after create
- **Primary language** — fixed at create-time
- **Solution** — which Dataverse solution the agent belongs to (for ALM)

### Conversation start config
- **Greeting message** — first thing the agent says when opened
- **Conversation Start system topic** — toggle on/off; off = welcome page only (Teams)
- **Start over message** · **Reset conversation message** · **No match message** · **Multiple topics matched message** · **Escalate link**
- **Suggested prompts** — up to 10 title+prompt pairs shown on the Teams/M365 welcome page

### Generative AI controls (Settings · Generative AI)
- **Orchestration mode**: *Classic* (intent matching) vs *Generative* (orchestrator chooses topics/tools/knowledge at runtime)
- **Allow ungrounded responses** — toggle; when on, the agent can answer general questions outside the knowledge sources
- **Content moderation level** — low / medium / high (controls hallucination guards)
- **Model deployment** — pick model (default GPT-4o family; can swap to Foundry-deployed model in some envs)
- **Prompt modification** — custom instructions for tone / format / brand voice
- **Conversational boosting system topic** — toggle; controls whether knowledge sources answer when no topic matches

### Lifecycle
- **Draft** — `statecode=0`; not callable from any channel
- **Test your agent** chat panel — always uses the latest unpublished content
- **Publish** — pushes Draft → Published; takes a few minutes; updates all attached channels at once
- **Published** — `statecode=1`; user-facing version on every channel
- **Disabled** — `statecode=2`; channels stop responding
- **Version history** — list of publishes with timestamp + publisher; rollback by re-publishing a previous solution

### Settings
- **Security** — Authentication = `Authenticate with Microsoft` (default, Entra) · `Authenticate manually` (custom OAuth) · `No authentication`. No-auth disables user-credential tools
- **Web channel security** — Direct Line secret rotation
- **Data Loss Prevention** — env-level connector policy enforced; agent shows which connectors are blocked
- **Languages** — primary + secondary languages
- **Skills** — register Bot Framework skills the agent can call
- **Customer engagement hubs** — Dynamics 365 / ServiceNow / Salesforce / LivePerson handoff config

## What Loom has today

From `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotStudioAgentEditor` and `app/api/items/copilot-studio-agent/**`:
- Power Platform environment picker (BAP `/environments` API; UAMI token)
- List agents in an env (`GET /msdyn_copilots` via Dataverse Web API)
- Per-agent row: name · description · instructions · model deployment · schema name · state (Draft/Published/Disabled) · modified-on timestamp
- **Create agent** dialog — name + description + instructions + modelDeployment → POST to `/msdyn_copilots`
- **Edit agent** dialog — PATCH name/description/instructions/modelDeployment
- **Delete agent** — DELETE on `/msdyn_copilots({id})`
- **Publish** button per agent — calls bound action `Microsoft.Dynamics.CRM.msdyn_PublishCopilot`
- Tabs across to Knowledge / Topics / Actions / Channels / Analytics editors with the selected agent ID propagated
- MessageBar `intent=warning` when env has no Dataverse, when Copilot Studio is not enabled (503 from client), or when the UAMI is not a Dataverse application user
- **Honest schema errors (audit H1)** — the client's Dataverse error handler now maps ONLY the true
  Copilot-Studio core entities (`msdyn_copilots` / `msdyn_knowledgesources` / `msdyn_botcomponents`)
  to the friendly "enable Copilot Studio" 503. A genuine missing-entity (e.g. `msdyn_botchannels`,
  `msdyn_bot_actions`) or missing-column (e.g. `msdyn_instructions`, `msdyn_modeldeployment` if they
  do not exist on the live tenant's `msdyn_copilots`) now surfaces an honest error naming the
  offending entity/column instead of masquerading as the enablement gate. **Live-tenant
  verification of every `msdyn_*` entity/column remains required** — the client tells the truth on
  failure, but confirming the schema against a provisioned Dataverse is the outstanding work.

## Gaps for parity

1. **Icon upload** — no PNG picker / 192×192 enforcement / Dataverse `entityimage` field write
2. **Suggested prompts editor** — no UI to add/edit/reorder up to 10 title+prompt pairs (separate Dataverse table `msdyn_copilotstarterprompts`)
3. **Conversation start config** — greeting / start-over / no-match / multi-topic / escalate-link / reset messages are not editable; live in the Conversation Start system topic + agent metadata fields
4. **Generative AI panel** — no controls for orchestration mode (Classic vs Generative), `Allow ungrounded responses`, content moderation level, prompt modification (lives on `msdyn_botsettings` rows)
5. **Model deployment picker** — Loom accepts a free-text string; should be a dropdown of `Microsoft.CognitiveServices/accounts/deployments` from the env's bound Foundry resource + the default GPT-4o family
6. **Solution + schema name on create** — Loom doesn't let the maker pick the target solution (defaults to Default solution), and doesn't validate schema-name uniqueness
7. **Primary language** — not selectable on create
8. **Test your agent chat panel** — no in-Loom chat surface that calls Direct Line against the Draft version
9. **Version history** — no list of past publishes / no rollback button
10. **AI suggestions on Overview** — no surfacing of orchestrator-suggested topics/knowledge/channels/tools based on description + instructions (AI authoring assist)
11. **Security panel** — auth mode (Entra / manual / none) not exposed; Direct Line secret rotation absent
12. **DLP impact viewer** — no surface showing which connectors are blocked by env DLP policy
13. **Skills registration** — no Bot Framework skill manifest URL field
14. **Customer engagement handoff config** — Dynamics 365 / ServiceNow / Salesforce / LivePerson endpoint + auth not exposed
15. **Activity feed** — no per-agent change log (who edited instructions / who published / who attached knowledge)

## Backend mapping

Dataverse Web API on the env's instance URL (`https://<env>.crm.dynamics.com/api/data/v9.2`):
- **Agent CRUD** — `msdyn_copilots` (id · name · description · instructions · modeldeployment · schemaname · statecode · entityimage)
- **Publish** — bound action `Microsoft.Dynamics.CRM.msdyn_PublishCopilot` (Loom calls this)
- **Suggested prompts** — `msdyn_copilotstarterprompts` (related to `msdyn_copilot` via `msdyn_copilotid`)
- **Bot settings** — `msdyn_botsettings` (orchestration mode, `allowungroundedresponses`, content moderation, prompt modification)
- **System topic overrides** — `msdyn_botcomponents` with `componenttype=9` and system-topic name (Conversation Start, Fallback, Escalate, etc.)
- **Solution lookup** — Dataverse `solutions` table; new agents add a `solutioncomponent` row referencing `msdyn_copilots({id})`
- **Auth** — Dataverse Application User: the SP (MSAL Web App SP per the env's auth note in `csa-loom v3.3` memory) must have a security role granting CRUD on `msdyn_*` entities

## Required Azure resources / tenant settings

- **Power Platform environment** with Dataverse provisioned (every Copilot Studio agent lives here)
- **Copilot Studio enabled per environment** — PPAC → Environment → Settings → Product → Features → "Copilot Studio" = On (creates the `msdyn_copilot*` tables; this is the gate that surfaces the 503 in Loom today)
- **Copilot Studio license** — per-tenant SKU or per-message capacity add-on (`Microsoft.PowerApps/accounts` quota)
- **Dataverse Application User** for the MSAL Web App SP (`LOOM_DATAVERSE_CLIENT_ID`) with "System Customizer" + "Copilot Studio Maker" security roles
- **Tenant isolation policy** must allow the SP if Power Platform tenant isolation is enabled
- **Optional**: Azure AI Foundry deployment for custom model picker; Azure Bot Service resource for non-native channels

## Estimated effort

3 sessions. Suggested prompts editor + conversation-start config + generative AI panel is ~1 session (mostly typed Fluent forms over `msdyn_botsettings` + `msdyn_copilotstarterprompts`). Icon upload + solution picker + schema-name validation + version history is ~1 session. Test your agent chat panel (Direct Line embed against the Draft) + AI suggestions on Overview + Activity feed is the third session. Security panel + DLP viewer + Skills registration + engagement-hub config can fold into the third session if scope tight, otherwise carry into a separate Channels-spec follow-on.
