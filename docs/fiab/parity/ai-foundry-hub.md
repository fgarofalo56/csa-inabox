# ai-foundry-hub — parity with the Azure AI Foundry **hub**

> **Standalone editor (with a rich sub-surface set).** `slug: ai-foundry-hub`,
> `restType: AiFoundryHub`, category **Azure AI Foundry**. Editor:
> `apps/fiab-console/lib/editors/foundry-hub-editor.tsx` (`FoundryHubEditor`).
> A **live screen-by-screen walk** of the real Foundry portal already exists at
> [`ai-foundry-hub.observed.md`](./ai-foundry-hub.observed.md) and stays the
> authoritative source-UI inventory; this doc is the parity ledger that maps
> that inventory to the shipped editor + backend. Related:
> [`ai-foundry.md`](./ai-foundry.md), [`ai-foundry-project.md`](./ai-foundry-project.md),
> [`compute.md`](./compute.md).

**Catalog description:** "Azure AI Foundry hub workspace — connections, models,
online endpoints, computes, datastores, and jobs. Native in Loom."

**No-Fabric note:** the hub is `Microsoft.MachineLearningServices/workspaces`
(kind=Hub) + an Azure OpenAI / AI Services (Cognitive Services) account. It is
100% Azure-native — no Fabric/Power BI dependency anywhere. When the workspace
or account isn't wired, the BFF raises `NotDeployedError` → a 503 honest-gate
MessageBar (per `no-vaporware.md`).

Source UI: **Azure AI Foundry portal** (`https://ai.azure.com`)
- Foundry hubs/resources: <https://learn.microsoft.com/azure/ai-foundry/concepts/ai-resources>
- Management center: <https://learn.microsoft.com/azure/ai-foundry/concepts/management-center>
- Model catalog: <https://learn.microsoft.com/azure/ai-foundry/how-to/model-catalog-overview>
- Connections: <https://learn.microsoft.com/azure/ai-foundry/how-to/connections-add>
- Deploy models: <https://learn.microsoft.com/azure/ai-foundry/how-to/deploy-models-openai>
- Evaluations: <https://learn.microsoft.com/azure/ai-foundry/how-to/develop/evaluate-sdk>

## Azure AI Foundry hub — feature inventory (from the observed walk)

| # | Foundry surface | What it does |
|---|-----------------|--------------|
| 1 | **Overview** | hub metadata, endpoints & keys, getting-started |
| 2 | **Model catalog** | search + filter (collections/industry/capabilities/deployment/inference/fine-tuning/licenses), leaderboards, compare, model-card grid, per-model **Deploy** |
| 3 | **Playgrounds** | Chat, Images, Audio, Speech, Language, Translator, Assistants, Video |
| 4 | **Agents** | build agent: model + tools + knowledge + guardrails; publish |
| 5 | **Connections** | list/add connections (AOAI, AI Services, Storage, AI Search, custom keys) |
| 6 | **Models + endpoints** | registered models, AOAI **model deployments** (create/delete), online **endpoints** |
| 7 | **Fine-tuning** | create + monitor fine-tune jobs |
| 8 | **Evaluations** | create evaluation (graders / testing-criteria), upload dataset, run, view metrics |
| 9 | **Monitoring / tracing** | app analytics, traces, evals over App Insights |
| 10 | **Quota + usage** | per-region model quota / usage; request quota |
| 11 | **Networking** | public network access toggle + private endpoints |
| 12 | **Identity / RBAC** | role assignments on the workspace/account |
| 13 | **Keys / endpoints** | primary/secondary keys + regional endpoints |
| 14 | **Activity log** | ARM activity feed |
| 15 | **Computes** | AML compute list (detailed in [`compute.md`](./compute.md)) |
| 16 | **Datastores** | linked datastores |
| 17 | **Jobs** | experiments + runs |

## Loom coverage

`FoundryHubEditor` renders a Fluent **Tab** strip that maps one-for-one to the
observed rail. Each tab lazy-loads and hits a real BFF route or shows an honest
gate. Backend clients: `foundry-client.ts` (ML workspace, ARM
`Microsoft.MachineLearningServices/workspaces` + subresources) and
`foundry-cs-client.ts` (Cognitive Services / AI Services account). Coordinates:
`LOOM_FOUNDRY_NAME`/`LOOM_FOUNDRY_HUB_NAME` + `LOOM_FOUNDRY_SUB`/`LOOM_SUBSCRIPTION_ID`
+ `LOOM_FOUNDRY_RG`.

| # | Tab | Status | Route(s) |
|---|-----|--------|----------|
| 1 | Overview | built ✅ | `/api/foundry/workspace` |
| 2 | Model catalog + Deploy dialog | built ✅ | `/api/foundry/models-catalog`, `POST /api/foundry/model-deployments` |
| 3 | Playgrounds (Chat / Images / Audio) | built ✅ | Chat/Images/Audio tabs wired to deployments; Speech/Language/Translator/Assistants/Video ⚠️ deep-link to ai.azure.com |
| 4 | Agents | built ✅ | Agents tab |
| 5 | Connections | built ✅ | `/api/foundry/connections` |
| 6 | Models + endpoints | built ✅ | `/api/items/ml-model`, `/api/foundry/model-deployments` (+ delete), `/api/foundry/deployments` |
| 7 | Fine-tuning | built ✅ | fine-tuning tab |
| 8 | Evaluations | built ✅ | `POST /api/foundry/evaluations` with real AOAI Evals testing-criteria (string_check / text_similarity / label_model) |
| 9 | Monitoring | built ✅ | monitoring tab (App Insights) |
| 10 | Quota + usage | built ✅ | `GET /api/foundry/quota` + `POST` one-click gpt-4o-mini |
| 11 | Networking | built ✅ | `GET`/`PATCH /api/foundry/networking` (public-access toggle + PE list) |
| 12 | Identity / RBAC | built ✅ | `GET /api/foundry/rbac` |
| 13 | Keys / endpoints | built ✅ | `GET /api/foundry/keys` |
| 14 | Activity log | built ✅ | `GET /api/foundry/activity` |
| 15 | Computes | built ✅ | `GET /api/foundry/computes` (full CRUD in `compute.md`) |
| 16 | Datastores | built ✅ | `GET /api/foundry/datastores` |
| 17 | Jobs | built ✅ | `GET /api/items/ml-experiment` |

## Backend per control

| Loom control | Azure backend |
|--------------|---------------|
| Hub metadata / computes / datastores / networking / rbac / activity | ARM `Microsoft.MachineLearningServices/workspaces` (+ subresources), api-version pinned in `foundry-client.ts` |
| Model catalog / deployments / keys / quota | Cognitive Services / Azure OpenAI account (`foundry-cs-client.ts`) — `Microsoft.CognitiveServices/accounts/{a}/deployments`, `/models`, `listKeys`, usages |
| Evaluations | Azure OpenAI **Evals** data-plane (`/openai/evals`) |
| Every unwired backend | `NotDeployedError` → 503 honest MessageBar naming the env var / resource |

**Grade: A− / B+.** The hub reproduces the full Foundry rail one-for-one with
real Azure backends (ML workspace + AOAI account), including the headline model
catalog + deploy, evaluations with real graders, quota, networking, RBAC, keys,
and activity. The only ⚠️ items are the four less-used playgrounds
(Speech/Language/Translator/Assistants/Video) which deep-link to ai.azure.com
rather than re-hosting the experience. See `ai-foundry-hub.observed.md` for the
exhaustive control-by-control comparison.
