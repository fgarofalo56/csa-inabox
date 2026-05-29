# AI Foundry — parity spec from LIVE screen-by-screen walk (2026-05-29)

**Method**: navigated the real Microsoft Foundry portal (ai.azure.com) signed in
to the Limitless Data tenant, project `fgaro-mdg63bud-eastus2`. This is the
ACTUAL UI to replicate one-for-one in CSA Loom (Loom theme only). Supersedes
the earlier Learn-doc-based guesses in ai-foundry-hub.md.

## Top-level Foundry surfaces (left rail / nav — observed)

| Foundry surface | Real URL | What it does |
|---|---|---|
| **Model catalog** | `/explore/models` | THE headline. Search + 7 filter dropdowns + leaderboards + compare + 11,492 models + per-model deploy |
| **Playgrounds** | `/resource/playgrounds` | 8 playground types (Chat, Video, Images, Audio, Speech, Language, Translator, Assistants) |
| **Templates** | `/resource/build/templates` | Code/solution templates to start from |
| **Monitoring / Observability** | `/observability/applicationAnalytics` | App analytics, traces, evals |
| **Data + indexes** | `/foundryProject/data` | Datasets + vector indexes |
| **Agents** | (project) | Build agent: model + tools + knowledge + memory + guardrails; chat/YAML/code tabs; preview + publish |
| **Overview** | `/foundryProject/overview` | Endpoints & keys, Project details, getting-started steps, templates |

## Model catalog (`/explore/models`) — exact observed UI

- H1: **"Find the right model to build your custom AI solution"**
- **Announcements** carousel (8 panels, prev/next arrows)
- **Model leaderboards** section + "Browse leaderboards" button (4 leaderboard cards)
- **Filter bar — 7 dropdowns**: Collections · Industry · Capabilities · Deployment options · Inference tasks · Fine-tuning tasks · Licenses
- **Compare models** button
- **Search box** ("Search")
- **"Models 11492"** live count heading
- **Model card grid** — 50 cards/page, paginated (Previous / Next page)
- Each card: provider logo + model name + capability tags (e.g. "Chat completion, Responses")
- Click card → **model detail page** (`/catalog/models/<id>`) with **Deploy** button → deploy dialog (deployment name, SKU/capacity, content filter) → creates a real deployment/endpoint
- "Hot models this month" rail on home

## Playgrounds (`/resource/playgrounds`) — exact observed UI

H1: "Discover what's possible with AI Playgrounds". Eight tiles:
1. **Chat playground** — system prompt, chat thread, deployment picker, params (temp/max tokens/top-p), tools, view code
2. **Video playground** (Sora-style)
3. **Images playground** (DALL-E / gpt-image)
4. **Audio playground**
5. **Speech playground**
6. **Language playground**
7. **Translator playground**
8. **Assistants playground**

## Top toolbar (every screen)
Foundry Agent (AI helper) · Preview features · Foundry settings · Feedback ·
Profile (name/email/directory) · "New Foundry" experience toggle · breadcrumbs.

## Gap vs current Loom ai-foundry-hub (what's MISSING — user-confirmed)
- ❌ **Model catalog with search** — search 11k+ models, 7 filters, leaderboards, compare. (Loom has none of this.)
- ❌ **Deploy-from-catalog flow** — pick a model in the catalog → Deploy dialog → real deployment. (Loom's "Deploy a model" is a bare dropdown, not the catalog browse.)
- ❌ **Playgrounds** — all 8, especially the **Chat playground** (the #1 named gap). Loom has none.
- ⚠️ Agents builder — partial; needs model+tools+knowledge+memory+guardrails + chat/YAML/code + publish.
- ⚠️ Templates, Monitoring/observability, Data+indexes — present-ish, verify against real screens.

## Build target for Loom (one-for-one, Loom theme)
1. **Model catalog tab/page**: searchbox + 7 filter dropdowns + leaderboards strip + Compare + paginated model-card grid sourced from the real model catalog API (`/api/foundry/catalog`), each card → detail + **Deploy** dialog hitting the real CognitiveServices deployments PUT.
2. **Playgrounds**: at minimum a real **Chat playground** (deployment picker + system prompt + thread + params + view-code) calling the deployed AOAI model; then Images/Audio/Speech as the account supports.
3. Keep the 6 tabs already built (deployments, quota, networking, identity, keys, activity) — they were correct, just not the whole story.

Screenshot saved: `.playwright-mcp/foundry-model-catalog.png` (live catalog).
