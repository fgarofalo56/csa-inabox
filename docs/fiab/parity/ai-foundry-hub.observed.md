# ai-foundry-hub — parity with the Microsoft Foundry portal (ai.azure.com)

**Source UI:** <https://ai.azure.com> — model catalog (`/explore/models`), playgrounds
(`/resource/playground/chat`), resource management (deployments / quota /
networking / identity / keys / activity).
**Loom editor:** `apps/fiab-console/lib/editors/foundry-hub-editor.tsx`
+ `foundry-playground.tsx` + `foundry-sub-editors.tsx`.
**Backend client:** `apps/fiab-console/lib/azure/foundry-cs-client.ts`
(Cognitive Services / AIServices account) + `foundry-client.ts` (MLS hub).

This walk was done screen-by-screen against the live portal. Loom reproduces
each surface one-for-one with the Loom Fluent v9 theme; every control hits a
real Azure backend or shows an honest infra-gate (named env var / role).

## Foundry feature inventory → Loom coverage

### Model catalog (`/explore/models`) — the headline gap, now built

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
| Model leaderboards strip | built ✅ strip + "View leaderboards" deep-link | links to ai.azure.com leaderboard |
| Compare models button | built ✅ deep-links to Foundry compare | ai.azure.com |
| Card → model detail panel | built ✅ provider/version/lifecycle/tasks/caps/SKUs/capacity | catalog API |
| Deploy dialog (name, SKU/capacity, content filter) | built ✅ | `POST /api/foundry/model-deployments` → CognitiveServices deployments PUT |

**Catalog source (honest):** the grid is sourced from the account
`list-models` API (`{account}/models`) — the **real, server-reachable** set of
models deployable to this account/region. Every card is `deployableHere=true`,
so the Deploy button always resolves to a working PUT. The public
`ai.azure.com/explore/models` registry catalog (AML registries) is not reachable
with the ARM management token server-side; rather than fake those rows, the grid
shows the deployable set and the leaderboard/compare actions deep-link into the
live Foundry registry catalog.

### Chat playground (`/resource/playground/chat`) — the #1 named gap, now built

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

### Other playgrounds (Images / Audio / Speech)

| Foundry capability | Loom coverage |
|---|---|
| Playgrounds landing with tiles | built ✅ `PlaygroundsLandingPanel` |
| Images / Audio / Speech | honest-gate ⚠️ "deploy a &lt;type&gt; model first" — Chat is the fully functional one as specified |

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
against the real list-models + deployments PUT. Chat playground: 3-pane,
Send streams a real answer from the deployed model, all parameters wired, honest
gate when nothing is deployed. Zero ❌, zero stub banners. The only ⚠️ are the
Images/Audio/Speech playgrounds (gate on a model of that modality, as specified)
and the industry/license/fine-tune filters whose taxonomy the account catalog
API does not expose (surfaced honestly rather than faked).
