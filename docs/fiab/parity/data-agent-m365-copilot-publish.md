# data-agent-m365-copilot-publish — parity with "Publish agent to Microsoft 365 Copilot & Teams"

Source UI: Microsoft Foundry portal → agent → **Publish → Publish to Teams and
Microsoft 365 Copilot** (Build 2026 #4).
- https://learn.microsoft.com/azure/foundry/agents/how-to/publish-copilot
- https://learn.microsoft.com/microsoft-365/copilot/extensibility/publish

Loom surface: data-agent editor → **Publish** tab → "Publish to Microsoft 365
Copilot" section (below the Foundry publish block).

## Azure feature inventory (Foundry "Publish to Teams & M365 Copilot")

| # | Capability (Foundry portal) | Backend |
|---|------------------------------|---------|
| 1 | Select active agent version with a stable endpoint | Foundry Agent Service publish (existing `/publish`) |
| 2 | "Publish to Teams and Microsoft 365 Copilot" dialog — auto-create / reuse an **Azure Bot Service** resource | `Microsoft.BotService/botServices` PUT |
| 3 | Required metadata: Name, Publish version, Short description, Description, Developer | manifest fields |
| 4 | Optional metadata: Developer website, Terms of use, Privacy statement | manifest fields |
| 5 | **Direct publish** — choose scope: "Just you" (individual) or "People in your organization" (org, needs admin approval) | scope flag + Teams channel |
| 6 | Enable the **Teams / Microsoft 365 Copilot channel** (what surfaces the agent in M365 Copilot) | `…/channels/MsTeamsChannel` PUT |
| 7 | **Download & customize** — download the app manifest ZIP for manual sideload / org-catalog upload | deps-free ZIP builder |
| 8 | Update published agent metadata / display properties | re-PUT bot + republish manifest |
| 9 | Provider registration (`Microsoft.BotService`) + RBAC (bot service write) | bicep param + RG Contributor grant |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | ✅ | Requires the existing Foundry publish first (honest 409 gate if absent). |
| 2 | ✅ | `ensureBotRegistration()` — idempotent ARM PUT, endpoint = `agentMessagingEndpoint(name)`. |
| 3 | ✅ | Display name, version, short + full description, developer — editable form fields. |
| 4 | ✅ | website / terms / privacy carried in `M365ManifestArgs` (defaults applied). |
| 5 | ✅ | Scope dropdown (organization / individual) → `nextStep` guidance + persisted. |
| 6 | ✅ | `enableTeamsChannel()` — `MsTeamsChannel` PUT (M365 Copilot consumes the same channel). |
| 7 | ✅ | "Download app package (.zip)" → `buildM365AppPackage()` (manifest.json + icons), streamed as attachment. |
| 8 | ✅ | Re-publish reuses the persisted `manifestId` so the catalog entry updates in place. |
| 9 | ⚠️ honest-gate | `m365BotAppId` bicep param + `LOOM_M365_BOT_APP_ID` env; RG Contributor granted in `m365-copilot-bot.bicep`. When the Entra app id is unset, the UI shows an infra-gate MessageBar naming the exact var/role — never a dead control. |

Zero ❌. Non-functional states are honest infra-gates only (no Foundry publish
yet → 409; `LOOM_M365_BOT_APP_ID` unset / RBAC missing → 501 with the exact
remediation), per `.claude/rules/no-vaporware.md`.

## Backend per control

| Control | Route | Backend |
|---------|-------|---------|
| Status (on tab open) | `GET /api/items/data-agent/[id]/publish-m365` | `getBotRegistration()` (ARM GET) |
| Publish to M365 Copilot | `POST …/publish-m365 {action:'publish'}` | `ensureBotRegistration()` + `enableTeamsChannel()` (ARM PUT) → persist `state.m365` |
| Download app package | `POST …/publish-m365 {action:'package'}` | `buildM365AppPackage()` → `application/zip` attachment |

## No-Fabric note

Fully Azure-native: Azure Bot Service + Foundry Agent Service endpoint. No call
to `api.fabric.microsoft.com` / `api.powerbi.com`, no `fabricWorkspaceId` read.
Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
