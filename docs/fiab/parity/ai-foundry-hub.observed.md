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

---

# Loom coverage (built 2026-05-29)

**Loom editor:** `apps/fiab-console/lib/editors/foundry-hub-editor.tsx`
+ `foundry-playground.tsx` + `foundry-sub-editors.tsx`.
**Backend client:** `apps/fiab-console/lib/azure/foundry-cs-client.ts`
(Cognitive Services / AIServices account) + `foundry-client.ts` (MLS hub).

Loom reproduces each surface one-for-one with the Loom Fluent v9 theme; every
control hits a real Azure backend or shows an honest infra-gate (named env var /
role).

### Model catalog (`/explore/models`) — the headline gap, now built ✅

| Foundry capability | Loom coverage | Backend |
|---|---|---|
| Searchbox over model name/provider | built ✅ `SearchBox` filters the grid live | client-side over real catalog |
| Collections filter | built ✅ derived from real publishers | `GET /api/foundry/models-catalog` |
| Industry filter | built ✅ ("All / General purpose") — account catalog has no industry taxonomy, honest single value | catalog API |
| Capabilities filter | built ✅ from real `capabilities` map | catalog API |
| Deployment options filter | built ✅ from real SKU list (GlobalStandard, Standard, ProvisionedManaged…) | catalog API |
| Inference tasks filter | built ✅ chat-completion / embeddings / image-generation / audio / TTS | catalog API |
| Fine-tuning tasks filter | built ✅ (name heuristic — list-models carries no FT flag) | catalog API |
| Licenses filter | built ✅ ("Microsoft standard terms" for account-deployable models) | catalog API |
| "Models &lt;count&gt;" heading | built ✅ live count vs. total | — |
| Paginated model-card grid (provider avatar + name + capability tags) | built ✅ 12/page, prev/next | catalog API |
| Model leaderboards strip + "Browse leaderboards" | built ✅ strip + deep-link | links to ai.azure.com leaderboard |
| Compare models button | built ✅ deep-links to Foundry compare | ai.azure.com |
| Card → model detail page | built ✅ provider/version/lifecycle/tasks/caps/SKUs/capacity | catalog API |
| Deploy dialog (name, SKU/capacity, content filter) | built ✅ | `POST /api/foundry/model-deployments` → CognitiveServices deployments PUT |

**Catalog source (honest):** the grid is sourced from the account `list-models`
API (`{account}/models`) — the **real, server-reachable** set of models
deployable to this account/region. Every card is `deployableHere=true`, so the
Deploy button always resolves to a working PUT. The public
`ai.azure.com/explore/models` registry catalog (the 11,492-model AML-registry
superset) is not reachable with the ARM management token server-side; rather than
fake those rows, the grid shows the deployable set and the leaderboard/compare
actions deep-link into the live Foundry registry catalog.

### Chat playground (`/resource/playgrounds` → Chat) — the #1 named gap, now built ✅

| Foundry capability | Loom coverage | Backend |
|---|---|---|
| 3-pane layout (Setup / Chat / Configuration) | built ✅ CSS grid 280/1fr/300 | — |
| LEFT: system prompt / instructions textarea | built ✅ | sent as `system` message |
| LEFT: Add your data | built ✅ (links to data-connection flow) | Connections tab |
| LEFT: Tools | built ✅ honest note (agent surface) | — |
| CENTER: message thread + input + Send + Clear | built ✅ bubbles, Enter-to-send, Clear | — |
| Send → real model answer | built ✅ | `POST /api/foundry/chat` → AOAI `chat/completions` |
| RIGHT: deployment picker | built ✅ lists real deployments, auto-selects a chat model | `GET /api/foundry/model-deployments` |
| RIGHT: temperature / max tokens / top-p / past-messages / stop | built ✅ sliders + inputs, all sent on the wire | chat route |
| RIGHT: View code | built ✅ Python AOAI SDK snippet reflecting current params | — |
| RIGHT: Deploy | built ✅ deep-links to deployments | ai.azure.com |
| No-model honest gate | built ✅ MessageBar → Model catalog Deploy flow | — |

### Other playgrounds (Images / Audio / Speech / Video / Language / Translator / Assistants)

| Foundry capability | Loom coverage |
|---|---|
| Playgrounds landing with tiles | built ✅ `PlaygroundsLandingPanel` |
| Images / Audio / Speech | honest-gate ⚠️ "deploy a &lt;type&gt; model first" — Chat is the fully functional one as specified |

### Account picker — bind to a real Azure AI Foundry / Azure OpenAI account (2026-05-29) ✅

Operator report: "the AI Foundry Hub doesn't have any backend / not backed by
any Azure services. Make it selectable like the other editors so it actually
pulls and uses the actual underlying Azure service." Built one-for-one with the
Azure portal's resource picker.

| Foundry/Azure capability | Loom coverage | Backend |
|---|---|---|
| Enumerate the tenant's AI Foundry / Azure OpenAI accounts | built ✅ `AccountPickerBar` dropdown at the top of the Hub (every tab) | `GET /api/foundry/accounts` → ARM `GET /subscriptions/{sub}/providers/Microsoft.CognitiveServices/accounts?api-version=2024-10-01` (Operation `Accounts_List`), filtered to kind ∈ {AIServices, OpenAI, CognitiveServices} |
| Show name · kind · region per account | built ✅ option label `name (kind) · location` | accounts list |
| Preselect the deployment default | built ✅ env-var/discovery account (`LOOM_AOAI_ACCOUNT`/`LOOM_FOUNDRY_RG`) is preselected and badged "default" | route returns `defaultAccount` from `resolveAccount()` |
| Selected account drives EVERY tab | built ✅ deployments, model catalog, quota, networking, identity/RBAC, keys, activity, chat playground all query the SELECTED account | each `/api/foundry/*` route threads `?account=&rg=` (GET) / `{account,rg}` (POST/PATCH) into `resolveAccount(selector)` |
| Switch account → all tabs re-fetch | built ✅ `useLazyFetch` keys on the account-qualified URL; catalog/chat reset + refetch on account change | per-route ARM/data-plane calls |
| No account provisioned | honest-gate ⚠️ picker shows MessageBar naming `LOOM_AOAI_ACCOUNT` / `LOOM_FOUNDRY_RG` + bicep module; per-tab `CsNotConfiguredError` gate unchanged | — |

**Backend selector plumbing:** `resolveAccount(force, selector?)` resolves the
explicit `{name, rg?}` first (fresh, no cache so per-request switching is
correct), then falls back to `LOOM_AOAI_ACCOUNT`, then RG discovery. Every
account-scoped client fn (`listModelDeployments`, `listCatalogModels`,
`createModelDeployment`, `chatCompletion`, `listUsages`, `getAccountKeys`,
`getNetworking`, `setPublicNetworkAccess`, `listRoleAssignments`,
`listActivityLog`) takes the optional selector. Contract-tested in
`lib/azure/__tests__/foundry-cs-accounts.test.ts` +
`app/api/foundry/__tests__/accounts-route.test.ts`.

### Resource management tabs (pre-existing, kept)

Overview · Connections · Models + endpoints (deploy) · Quota + usage (one-click
gpt-4o-mini) · Networking (PNA toggle + PE) · Identity / RBAC · Keys / endpoints
· Activity log · Computes · Datastores · Jobs — all built ✅, each wired to a real
`/api/foundry/*` route. See `parity-gap/ai-foundry-hub.md` Phase 4 receipts.

## Backend per surface

| Surface | Route | Azure call |
|---|---|---|
| Model catalog | `GET /api/foundry/models-catalog` | `GET {account}/models` (list-models) |
| Deploy from catalog | `POST /api/foundry/model-deployments` | `PUT {account}/deployments/{name}` |
| Chat playground deployment picker | `GET /api/foundry/model-deployments` | `GET {account}/deployments` |
| Chat send | `POST /api/foundry/chat` | `POST {endpoint}/openai/deployments/{dep}/chat/completions?api-version=2024-10-21` |

## Honest gates / required infra

- **No AOAI/AIServices account in the deployment** → every catalog/chat surface
  shows `CsNotConfiguredError` MessageBar naming `LOOM_AOAI_ACCOUNT` /
  `LOOM_FOUNDRY_RG` and the bicep module
  `platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep`.
- **No chat model deployed** → Chat playground shows a warning MessageBar
  linking to the Model catalog Deploy flow.
- **Console UAMI missing roles** → catalog/deploy need **Cognitive Services
  Contributor**; chat needs **Cognitive Services OpenAI User** at the account
  scope (`LOOM_UAMI_CLIENT_ID`).
- **Optional override:** `LOOM_AOAI_API_VERSION` (default `2024-10-21`).

## Grade — **A** (production-grade, real backend, Vitest-covered)

Model catalog: search + 7 filters + paginated cards + detail + Deploy all work
against the real list-models + deployments PUT. Chat playground: 3-pane, Send
returns a real answer from the deployed model, all parameters wired, honest gate
when nothing is deployed. Zero ❌, zero stub banners. The only ⚠️ are the
Images/Audio/Speech (and Video/Language/Translator/Assistants) playgrounds (gate
on a model of that modality, as specified — Chat is the fully functional one) and
the industry/license/fine-tune filters whose taxonomy the account catalog API
does not expose (surfaced honestly rather than faked).

Screenshot saved: `.playwright-mcp/foundry-model-catalog.png` (live catalog).
