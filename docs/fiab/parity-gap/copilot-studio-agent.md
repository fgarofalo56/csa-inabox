# copilot-studio-agent — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/copilot-studio-agent/new`
**Fabric reference**: copilotstudio.microsoft.com — Agent designer (Overview · Knowledge · Topics · Actions · Channels · Analytics tabs)
**Loom screenshot**: `temp/parity/copilot-studio-agent-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/copilot-studio-agent?envs=1` | 200 | Returns 1 environment: `Limitless Data (default)` (Dataverse-enabled, tenant `d1fc0498-...`) |
| `GET /api/items/copilot-studio-agent?envId=<env>` | (returned 0 agents in the tested env) | No Copilot Studio agents in this env yet |

The editor renders correctly: env picker preloaded with "Limitless Data (default)", a left-rail "Agents (0)" tree with "+ New agent", a 5-tab body (Agent · Knowledge · Topics · Actions · Channels · Analytics), and a form with Name / Description / Model deployment / Instructions on the Agent tab. Ribbon has Save · Publish · Delete · Refresh (5 actions).

## Phase 3 — Fabric vs Loom

| Copilot Studio element | Loom present? | Severity |
|---|---|---|
| Env picker | YES | — |
| Agent list + selection | YES (empty here) | — |
| Agent tab: Name · Description · Instructions · Model | YES | — |
| **Generative orchestration toggle (classic vs generative)** | NO | MAJOR |
| **Greeting / fallback message editor** | NO | MAJOR |
| **Authentication config** (none / Teams / Entra / OAuth provider) | NO | MAJOR |
| **AI Builder model attach** | NO | MAJOR |
| **Voice + multilingual settings** | NO | MAJOR |
| **Solutions / publish to Power Platform pipeline** | NO | MAJOR |
| Knowledge tab (URL · file · SharePoint · Dataverse) | YES — see copilot-studio-knowledge | — |
| Topics tab | YES — see copilot-studio-topic (yaml `<textarea>` not Monaco) | — |
| Actions tab | YES (but Dataverse-403 due to msdyn_bot_actions missing — see action gap doc) | — |
| Channels tab | YES — Teams/Web/Direct Line/Slack/Facebook/Custom cards | — |
| Analytics tab | YES — see copilot-studio-analytics | — |
| **"Test your bot" live chat pane** (right-rail conversation while authoring) | **NO** | **BLOCKER** — defining Copilot Studio UX feature |

## Functional

- Save / Publish / Delete fire real Dataverse calls (verified env picker works; CRUD not exercised live to avoid creating noise data)
- "Test your bot" widget is completely absent

## Grade — **C**

The shell is honest: real env list, real left rail, all 5 tabs render their sub-editors with honest 503/404 MessageBars from the BFF when Copilot Studio isn't enabled. But the **"Test your bot" live chat pane is the signature Copilot Studio feature and it's missing entirely** — that alone is a BLOCKER. Plus missing generative orchestration toggle, greeting editor, auth config. **Grade C.**
