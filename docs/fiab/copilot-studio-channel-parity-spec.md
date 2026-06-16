# Copilot Studio Channel Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Copilot Studio: publication-fundamentals-publish-channels, publication-add-bot-to-microsoft-teams, publication-add-bot-to-sharepoint, publication-add-bot-to-whatsapp, publication-add-bot-to-facebook, publication-connect-bot-to-web-channels, publication-connect-bot-to-custom-application, publication-connect-bot-to-azure-bot-service-channels, publication-integrate-web-or-native-app-m365-agents-sdk, guidance/channels) + inspection of `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotChannelEditor` and `listChannels` / `publishToChannel` in `apps/fiab-console/lib/azure/copilot-studio-client.ts`.

## Overview

Channels are the surfaces where end users talk to a published agent — Teams, Microsoft 365 Copilot, SharePoint, a custom website, Facebook, WhatsApp, Slack, Telegram, Twilio SMS, Direct Line REST, etc. Each channel has its own configuration (auth, embed code, deployment metadata), and the same published agent can be on many channels simultaneously. Native channels (Teams, M365 Copilot, SharePoint, Power Pages, Demo Website) are deployed straight from Copilot Studio; non-native channels (Slack, Facebook, Telegram, Twilio, Cortana, Line, Kik, GroupMe, Direct Line Speech, Email) route through an Azure Bot Service resource. Custom apps use the Direct Line REST/WebSocket API or the Microsoft 365 Agents SDK.

## Copilot Studio UX

### Channels page chrome
- Grid of channel tiles, each with: name · logo · status (Not connected · Configuring · Published · Error) · `Connect` / `Open` button
- Top of page: **Authentication** summary (Entra / manual / no auth) — controls which channels are available
- Per-channel detail pane with config form + embed snippet + test link

### Channel catalog + per-channel config

| Channel | Configuration |
|---|---|
| **Microsoft Teams + M365 Copilot** | Add channel → auto-creates Azure Bot Service resource · agent name/short-desc/long-desc/dev-name/dev-website/terms/privacy URLs · scope: `Just you` (personal) / `Your organization` (admin approval) · publish version (semver) · icon · color · download manifest .zip · share link · `Show to organization` (submits to admin for tenant-wide) |
| **SharePoint** | Site URL · header customization · publish (the agent appears as a SharePoint web part) |
| **Demo Website** | One-click → public test URL (no auth) for prototyping only |
| **Custom Website** | HTML embed snippet (`<iframe>` against `https://copilotstudio.microsoft.com/.../webchat?botId=...`) · iframe sandbox attributes · per-user auth via JS SDK · welcome script · custom styling |
| **Mobile App / Custom Application** | Direct Line secret (regenerate · 2 keys for zero-downtime rotation) · WebChat JS / React WebChat client picker · M365 Agents SDK download · sample code C# / JS |
| **Facebook Messenger** | Page access token · App ID · App secret · webhook verify token (Facebook Developer console wires this) |
| **WhatsApp** | Business account ID · phone number ID · system user access token · message templates |
| **Azure Bot Service channels** | Lists the bot's Azure resource (auto-created or pre-existing); per-channel config inside Azure portal: **Slack** (client ID · secret · verification token · signing secret · landing page) · **Telegram** (bot API key) · **Twilio** (SID · auth token · phone number) · **Line** (channel secret · access token) · **Kik** (api key · name) · **GroupMe** (token) · **Direct Line Speech** (Cognitive Services Speech resource · region) · **Email** (Office 365 connection) · **Cortana** (deprecated) |
| **Direct Line API** | Primary + secondary secrets · per-channel WebSocket URL · token endpoint for short-lived user tokens · CORS allowlist |
| **Power Pages** | Site selector · page placement · authentication mapped to Power Pages user identity |
| **Omnichannel for Customer Service** | Application ID + tenant ID (registered in Dynamics 365 Customer Service) · queue routing · context vars |

### Authentication panel (top of Channels page)
- **Authenticate with Microsoft** (default) — Entra ID, automatic OBO for Teams/Power Apps/M365 Copilot
- **Authenticate manually** — OAuth 2.0 / generic OAuth provider configuration (client ID · secret · scopes · token URL · token-exchange URL · redirect URL)
- **No authentication** — anyone with the link can chat; disables user-credential tools; Web embed code becomes visible
- Switching mode requires re-publishing the agent

### Publish dialog
- `Publish` button publishes Draft → all attached channels at once
- Per-channel publish status with timestamp + version number
- **Troubleshoot publishing errors** — surfaces missing topic refs, broken connectors, unset secrets, invalid manifest fields

### Channel limitations panel
- Per-channel known limits surfaced inline (e.g. Teams: max 6 suggested-reply chips · no attachment upload · text-only CSAT survey)
- Adaptive Card rendering matrix per channel
- Markdown support matrix per channel

## What Loom has today

From `apps/fiab-console/lib/editors/copilot-studio-editors.tsx::CopilotChannelEditor` and `app/api/items/copilot-studio-channel/**`:
- Env picker + agent picker (shared)
- List channels (`GET /msdyn_botchannels?$filter=_msdyn_copilotid_value eq {agentId}`)
- Per-channel row: name · type · enabled · embedUrl · config (JSON)
- **Publish to channel** action with a `channelType` enum (`teams | web | direct-line | slack | facebook | custom`) + key/value `config`
- **Honest per-channel gating (audit H2)** — `publishToChannel` no longer reports success off a bare
  `msdyn_botchannels` insert (that row does not reach the destination). Channels whose real
  enablement requires Azure Bot Service channel registration (Teams, Direct Line, Web Chat) or a
  third-party OAuth registration (Slack, Facebook) now return a `501` naming exactly what to
  configure on the Azure Bot resource; the editor renders that as a per-channel warning. Only the
  combined Teams + Microsoft 365 Copilot channel used by the data-agent publish orchestration
  (`msteams`) writes the Dataverse row (its downstream M365 admin approval is itself surfaced).
- POST to `/msdyn_botchannels` with `msdyn_copilotid@odata.bind` (gated channels excepted, above)
- MessageBar for Copilot-Studio-not-enabled 503

## Gaps for parity

1. **Channel-type coverage** — Loom supports the metadata for 6 types but is missing native deploy paths for SharePoint, Power Pages, M365 Copilot (vs Teams), WhatsApp, Telegram, Twilio, Line, Kik, GroupMe, Direct Line Speech, Email, Omnichannel
2. **Per-channel typed config form** — Loom has a free-text JSON blob; missing typed forms per channel (Teams metadata · Slack creds · WhatsApp phone IDs · Twilio SID · etc.)
3. **Teams deploy flow** — no Azure Bot Service resource auto-creation, no manifest builder, no scope picker (`Just you` vs `Your organization`), no submit-to-admin flow
4. **Custom Website embed snippet** — no copy-to-clipboard `<iframe>` snippet generator with the agent's bot ID + token endpoint
5. **Direct Line secret management** — no view/rotate of primary + secondary keys, no short-lived token endpoint config, no CORS allowlist
6. **WebChat client picker** — no selection of React WebChat vs WebChat JS for custom app deploys
7. **Microsoft 365 Agents SDK** — no sample-code download (C# / JS)
8. **Channel authentication panel** — Entra / Manual / None mode not exposed; switching is gated in Copilot Studio because it forces re-publish
9. **Publish status surface** — Loom shows `enabled` boolean only; missing per-channel publish timestamp, version, error details
10. **Publish errors troubleshoot** — no surface of missing topic refs / broken connectors / unset secrets
11. **Channel limitations inline help** — no per-channel known-limits callout (Teams 6-chip limit, etc.)
12. **Adaptive Card / Markdown support matrix** — not surfaced; makers ship broken cards into channels that don't support them
13. **Test channel** — no in-context test (e.g. open the Teams app sideload, scan the Direct Line WebChat in an iframe)
14. **Customer engagement hub config** — Dynamics 365 Customer Service / ServiceNow / Salesforce / LivePerson handoff endpoints not exposed
15. **Multi-tenant publishing** — no submit-to-Microsoft-Commercial-Marketplace flow via Partner Center
16. **Demo Website** — no one-click public test URL
17. **Power Pages site picker** — no list of `Microsoft.PowerPlatform/powerpagessites` to bind to

## Backend mapping

Dataverse Web API + adjacent surfaces:
- **Channel CRUD** — `msdyn_botchannels` (id · name · type · enabled · embedurl · `msdyn_configuration` JSON · `_msdyn_copilotid_value`)
- **Azure Bot Service resource** — `Microsoft.BotService/botServices`; for non-native channels (Slack/Facebook/Telegram/Twilio/etc.) channels are configured under `botServices/{name}/channels/{channelName}` in ARM
- **Teams manifest** — `botchannelregistration` → Teams app manifest (`manifest.json` with `botId` + `validDomains` + `webApplicationInfo`); built by Copilot Studio and packaged with icons into a `.zip` for upload to Teams Admin Center
- **Direct Line** — `botServices/{name}/channels/DirectLineChannel` with primary/secondary secrets; token endpoint at `https://directline.botframework.com/v3/directline/tokens/generate`
- **M365 Copilot publish** — uses Microsoft 365 Apps catalog API + Partner Center for marketplace
- **Power Pages binding** — `powerpagecomponent` row in the Power Pages site's solution
- **Authentication config** — `msdyn_botsettings` row with `msdyn_authmode` + OAuth provider details
- **Publish operation** — bound action `msdyn_PublishCopilot` (Loom already calls this) fans out to all attached channels
- **Engagement-hub handoff** — endpoint config in `msdyn_botsettings` (Dynamics 365 Omnichannel app ID / ServiceNow instance URL + creds / Salesforce org ID + creds / LivePerson account ID)

## Required Azure resources / tenant settings

- All Agent-editor prerequisites
- **Azure Bot Service resource** (`Microsoft.BotService/botServices`) — auto-created by Copilot Studio when first non-native channel attached; Loom should detect + surface this
- **For Teams + M365 Copilot**: tenant must allow third-party / custom apps in Teams Admin Center; admin approval for org-wide
- **For Slack / Facebook / Twilio / Line / Kik / GroupMe / Telegram**: each requires its own developer account + app registration + webhook configuration on the third-party side
- **For WhatsApp**: Meta Business account + verified phone number + approved message templates
- **For Direct Line Speech**: Azure Cognitive Services Speech resource (`Microsoft.CognitiveServices/accounts` kind `SpeechServices`) co-located with the Bot Service
- **For Email**: Office 365 connection in the env
- **For Omnichannel handoff**: Dynamics 365 Customer Service license + Omnichannel app registered
- **For Custom Website**: HTTPS-only origin; CORS allowlist on Direct Line; per-user token endpoint hosted on the customer's backend (recommended over exposing the Direct Line secret to the browser)

## Estimated effort

4 sessions. Native channel deploys (Teams + M365 Copilot + SharePoint + Power Pages + Custom Website) with typed config forms + embed snippet + manifest builder is ~2 sessions. Direct Line secret management + WebChat client picker + M365 Agents SDK sample-code download + Demo Website one-click is ~1 session. Azure Bot Service auto-creation + non-native channel configs (Slack / Facebook / WhatsApp / Twilio / Telegram / etc.) is ~1 session. Customer engagement hub handoff config + multi-tenant marketplace flow + channel limitations inline help + Adaptive Card support matrix can fold into a follow-on if scope tight.
