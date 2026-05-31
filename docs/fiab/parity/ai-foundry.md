# ai-foundry — parity with Azure AI Foundry (Microsoft Foundry portal)

**Audit date:** 2026-05-31 · **Auditor:** conservative 1:1 parity pass (no-vaporware.md + ui-parity.md)
**Verdict:** **C** (functional but rough; the headline new-Foundry "Agents" experience is absent, several top-level surfaces are deep-links/gates only).

> This is a brutally honest baseline. The prior self-grade of **A** in
> `ai-foundry-hub.observed.md` covered ONLY the model catalog + chat playground +
> ARM resource-management tabs. It does not reflect the flagship **Agents**
> surface (the center of the *new* Foundry portal), the other 7 playgrounds, the
> Templates gallery, the Observability/Monitoring dashboards, fine-tuning, or
> guardrails authoring — all of which the live 2026-05-29 portal walk enumerated
> as top-level surfaces. Grading those in drops the real score to C.

## Source UI

- Portal: <https://ai.azure.com> (Microsoft Foundry, "new Foundry" experience)
- Learn: <https://learn.microsoft.com/azure/foundry/what-is-foundry>
- Navigation map: <https://learn.microsoft.com/azure/foundry/how-to/navigate-from-classic#navigate-the-portal>
- Playgrounds: <https://learn.microsoft.com/azure/foundry/concepts/concept-playgrounds>
- Agents: <https://learn.microsoft.com/azure/foundry/agents/concepts/runtime-components>
- Tracing/Monitoring: <https://learn.microsoft.com/azure/foundry/observability/how-to/trace-agent-setup>
- Guardrails: <https://learn.microsoft.com/azure/foundry/guardrails/guardrails-overview>
- Live walk artifact: `docs/fiab/parity/ai-foundry-hub.observed.md` (2026-05-29)

## Loom surface

- Hub editor: `apps/fiab-console/lib/editors/foundry-hub-editor.tsx` (14 tabs + account picker + left navigator)
- Catalog + chat playgrounds: `apps/fiab-console/lib/editors/foundry-playground.tsx`
- Sub-editors: `apps/fiab-console/lib/editors/foundry-sub-editors.tsx` (Project / PromptFlow / Evaluation / ContentSafety / Tracing / AiSearchIndex / Compute / Dataset)
- Left navigator: `apps/fiab-console/lib/components/foundry/foundry-tree.tsx`
- Backends: `lib/azure/foundry-cs-client.ts` (CognitiveServices/AIServices data+management plane), `lib/azure/foundry-client.ts` (MLS hub), `lib/azure/foundry-agent-client.ts` (Agent Service data-plane — **present but NOT wired to any AI-Foundry agents UI**; consumed only by Loom/Fabric `data-agent` routes)
- Editor registry: `lib/editors/registry.ts` (`ai-foundry-hub`, `ai-foundry-project`, `prompt-flow`, `evaluation`, `content-safety`, `tracing`, `ai-search-index`, `compute`, `dataset`)
- BFF routes: `app/api/foundry/{accounts,workspace,connections,deployments,model-deployments,models-catalog,quota,networking,rbac,keys,activity,computes,datastores,chat}/route.ts` + `app/api/items/{ai-foundry-project,prompt-flow,evaluation,content-safety,tracing,ai-search-index}/...`

---

## Azure/Foundry feature inventory → Loom coverage

Legend: built ✅ = full 1:1 + real backend · partial ⚠️ = exists but incomplete/rough · gated ⚠️ = honest infra-gate only (no real function) · MISSING ❌ = not present.

### A. Top-level Foundry navigation surfaces

| # | Foundry surface (real portal) | Loom coverage | Backend per control |
|---|---|---|---|
| A1 | **Model catalog** (`/explore/models`) — search, 7 filters, leaderboards, compare, ~11.5k cards, model-card → detail → Deploy | built ✅ search + 7 filters + leaderboard strip + compare + paginated cards + detail + Deploy dialog | `GET /api/foundry/models-catalog` → CS `{account}/models` (account-deployable set, **not** the 11.5k AML-registry superset — that superset is deep-linked, not rendered) |
| A2 | **Playgrounds — Chat** | built ✅ 3-pane Setup/Chat/Config, params, View code | `POST /api/foundry/chat` → AOAI `chat/completions` |
| A3 | **Playgrounds — Images / Audio / Speech / Video / Language / Translator / Assistants** (7 more) | gated ⚠️ tiles that deep-link to ai.azure.com ("deploy a `<type>` model first"); none run in-Loom | none (deep-link only) |
| A4 | **Agents** (build agent: model + instructions + tools + knowledge + memory + guardrails; Chat/YAML/Code tabs; threads; preview; publish; AgentOps traces/evals) — **the headline of new Foundry** | MISSING ❌ no agents editor, no `/api/foundry/agents` route, no navigator group (only a greyed "coming" tooltip row) | `foundry-agent-client.ts` exists (real `{project}/agents` REST) but is wired only to Loom `data-agent`, not to an AI-Foundry agents surface |
| A5 | **Templates** gallery (`/resource/build/templates` — code/solution starter templates) | MISSING ❌ | none |
| A6 | **Monitoring / Observability — Application analytics** dashboard (token consumption, latency, exceptions, response quality via App Insights workbooks) | MISSING ❌ (only a raw trace table exists, see C-Tracing) | none |
| A7 | **Project Overview** (endpoints & keys card, project details, getting-started steps) | partial ⚠️ Hub Overview tab shows workspace metadata; ProjectEditor shows project detail; no consolidated endpoints/keys/getting-started card per Foundry project | `GET /api/foundry/workspace`, `GET /api/items/ai-foundry-project/{id}` |
| A8 | **Data + indexes** (datasets + vector indexes for the project) | partial ⚠️ Datasets tab (read-only list) + full AI Search index editor (schema/search/indexers) | `GET /api/foundry/datastores`, `/api/items/ai-search-index/*` |
| A9 | **Management center** (all resources, connected resources, quota, users) | partial ⚠️ split across Quota, RBAC, Connections, Networking, Keys tabs — functional but not the unified management-center layout | `/api/foundry/{quota,rbac,connections,networking,keys}` |
| A10 | Top toolbar: Foundry-settings, Preview-features, Feedback, profile, **New-Foundry experience toggle**, breadcrumbs | MISSING ❌ (no portal chrome equivalents; Loom has its own shell) | n/a |

### B. Model catalog detail (A1 expanded)

| # | Capability | Loom | Backend |
|---|---|---|---|
| B1 | Search box over name/provider | built ✅ | client-side over real catalog |
| B2 | 7 filter dropdowns (Collections, Industry, Capabilities, Deployment options, Inference tasks, Fine-tuning tasks, Licenses) | partial ⚠️ all 7 render + filter, but Industry/Licenses/Fine-tuning are single honest values (account list-models has no industry/license/FT taxonomy) | catalog API |
| B3 | Model leaderboards section (4 cards) + Browse leaderboards | partial ⚠️ a one-line strip + deep-link, not the 4-card leaderboard surface | deep-link to ai.azure.com |
| B4 | Compare models (side-by-side) | gated ⚠️ button deep-links out; no in-Loom compare grid | deep-link |
| B5 | Model card grid (provider logo + name + capability tags), paginated | built ✅ 12/page prev/next | catalog API |
| B6 | Model detail page (quick facts, details, benchmarks, existing deployments, license, artifacts) | partial ⚠️ details + tasks + caps + SKUs + capacity; **no** Benchmarks tab, **no** Existing-deployments tab, **no** License tab, **no** Artifacts/download | catalog API |
| B7 | Deploy dialog (name, SKU/capacity, content filter) → real deployment | built ✅ | `POST /api/foundry/model-deployments` → CS deployments PUT |
| B8 | Announcements carousel / Hot-models rail | MISSING ❌ | n/a |

### C. Build / Operate sub-surfaces

| # | Capability | Loom | Backend |
|---|---|---|---|
| C1 | **Model deployments** — list / deploy / **delete** / edit capacity / view state | partial ⚠️ list + deploy + delete (navigator) wired; **no edit-capacity / no scale-in-place**; deployment detail panel is read-only | `GET/POST/DELETE /api/foundry/model-deployments` → CS deployments |
| C2 | **Online endpoints** (managed) — list + scoring URI | partial ⚠️ read-only list; no create/test/swap-traffic | `GET /api/foundry/deployments` (MLS) |
| C3 | **Connections** — list + **create / edit / delete** (AOAI, AI Search, Blob, etc.) | partial ⚠️ read-only list only; **no create/edit/delete** despite portal supporting full CRUD | `GET /api/foundry/connections` |
| C4 | **Fine-tuning** — submit a fine-tune job (base model, training/validation data, hyperparams), monitor loss/accuracy charts, deploy fine-tuned model | MISSING ❌ (only a greyed "coming" navigator row) | none |
| C5 | **Evaluations** — create eval (dataset + evaluators + target model), run, view metrics, compare runs | partial ⚠️ EvaluationEditor lists + creates + shows metrics table; **no** AI-quality/risk-safety evaluator picker UI, no run-to-run compare, no charts | `/api/items/evaluation/*` |
| C6 | **Prompt flow** — DAG designer (LLM/Python/Prompt nodes), connections, run, batch run, deploy | partial ⚠️ `PromptFlowBuilder` DAG editor + create/save/run wired; no batch-run, no deploy-as-endpoint, no flow-from-template gallery | `/api/items/prompt-flow/*` (AML data-plane) |
| C7 | **Tracing** (Operate) — connect App Insights, span/trace explorer, trace detail with run steps/tool calls | partial ⚠️ flat trace table (time/op/duration/success); **no** App-Insights connect wizard, no span tree, no trace-detail drill | `GET /api/items/tracing` (App Insights query) |
| C8 | **Guardrails / Content filters (RAI policies)** — create/edit content-filter policies (hate/sexual/self-harm/violence + prompt-shields + groundedness + PII), attach per deployment | partial ⚠️ ContentSafetyEditor runs ad-hoc text/image moderation (real Content Safety call); **no** RAI-policy CRUD, **no** per-deployment attach UI (deploy dialog only picks a preset name) | `/api/items/content-safety` (Content Safety analyze); raiPolicyName passthrough on deploy |
| C9 | **Quota + usage** — per-region usages, request quota increase | built ✅ usages table + one-click gpt-4o-mini deploy | `GET/POST /api/foundry/quota` (CS usages) |
| C10 | **Networking** — public-access toggle + private endpoints | built ✅ PNA Switch (real PATCH) + PE list | `GET/PATCH /api/foundry/networking` |
| C11 | **Identity / RBAC** — role assignments view (+ add/remove) | partial ⚠️ read-only assignments list; **no** add/remove role assignment | `GET /api/foundry/rbac` |
| C12 | **Keys + endpoints** — view/reveal/regenerate keys | partial ⚠️ view + reveal + regional endpoints; **no regenerate** | `GET /api/foundry/keys` |
| C13 | **Activity log** | built ✅ 48h ARM activity feed | `GET /api/foundry/activity` |
| C14 | **Computes** (attached compute/clusters) — list + start/stop/scale | partial ⚠️ read-only list; no start/stop/scale | `GET /api/foundry/computes` |
| C15 | **Datastores** | built ✅ read-only list (matches portal which is mostly read here) | `GET /api/foundry/datastores` |
| C16 | **Jobs / Experiments** (AML runs) | built ✅ experiments + runs tables | `GET /api/items/ml-experiment` |
| C17 | **Registered models** (AML model registry) | built ✅ list | `GET /api/items/ml-model` |
| C18 | **Projects** — list + **create** child projects | built ✅ list + create | `GET/POST /api/items/ai-foundry-project` |
| C19 | **Datasets / Data assets** — register/upload/version data | partial ⚠️ DatasetEditor exists; no upload/version UI verified here | `/api/items/dataset` |
| C20 | **Vector indexes (Add your data / RAG index build)** | partial ⚠️ AI Search index editor manages indexes/indexers; no Foundry "Add your data → build index" wizard | `/api/items/ai-search-index/*` |

### D. Account/hub binding (cross-service)

| # | Capability | Loom | Backend |
|---|---|---|---|
| D1 | Enumerate tenant AI Foundry / Azure OpenAI accounts + select | built ✅ `AccountPickerBar` | `GET /api/foundry/accounts` (ARM `Accounts_List`) |
| D2 | Cross-subscription resource pickers (CS account + MLS hub) | built ✅ `AzureResourcePicker` (Resource Graph) | `/api/azure/resources` |
| D3 | Selected account drives every tab; switch → refetch | built ✅ | per-route `?account=&rg=` selector |
| D4 | No account provisioned → honest gate naming env var + role + bicep | gated ⚠️ correct honest-gate behavior | `CsNotConfiguredError` |

---

## Summary counts (by inventory row, 44 graded)

- **built ✅**: 16
- **partial ⚠️**: 17
- **gated ⚠️**: 3
- **MISSING ❌**: 8

## The honest verdict — **C** (functional but rough)

What's genuinely good (B/A-grade in isolation): the **model catalog + Deploy
flow** and the **chat playground** are real and wired to live Azure REST /
data-plane; the **ARM resource-management tabs** (quota, networking, activity,
keys, datastores, jobs, RBAC view, model deployments) are real and useful; the
**account picker** correctly binds the whole editor to a live account with an
honest gate when none exists. No mock arrays were found in the foundry routes.

Why it is NOT A/B overall, per ui-parity.md ("feature completeness must match"):

1. **Agents is entirely missing** (A4). This is *the* defining surface of the new
   Foundry portal — build an agent from model + instructions + tools (code
   interpreter, file search, web search, function calling) + knowledge + memory +
   guardrails, test it in threads, then publish. The real backend client
   (`foundry-agent-client.ts`, `{project}/agents` REST) already exists in the repo
   but is wired only to the Fabric/Loom Data Agent, not to an AI-Foundry agents
   editor. A greyed "coming" tooltip row is, per ui-parity.md, a forbidden stub.
2. **Fine-tuning is missing** (C4) — no submit/monitor/deploy.
3. **Templates gallery, Monitoring/Observability dashboards, Announcements** are
   missing (A5/A6/B8).
4. **7 of 8 playgrounds are deep-link gates** (A3), not in-Loom surfaces.
5. **Many tabs are read-only where the portal is full-CRUD**: Connections (no
   create/edit/delete), RBAC (no add/remove), Keys (no regenerate), Online
   endpoints / Computes (no lifecycle ops), Model deployment edit-capacity.
6. **Tracing is a flat table, not the span/trace-detail explorer**; **Content
   safety is ad-hoc moderation, not RAI-policy CRUD + per-deployment attach.**

The mix (16 built / 17 partial / 3 gated / 8 missing) is squarely **C**: a real,
working core with broad but shallow coverage and one flagship surface absent.
A grade requires zero ❌ and zero stub rows; this has 8 ❌ plus "coming" tooltip
stubs in the navigator.

## Highest-value gaps to build first

1. **Agents editor + playground** (A4) — wire `foundry-agent-client.ts` into a new
   `/api/foundry/agents` route + an AI-Foundry Agents editor: create/edit agent
   (model picker, instructions, tools = code-interpreter/file-search/web-search/
   function, knowledge sources, guardrails), threads/runs test pane, publish.
2. **Fine-tuning** (C4) — submit job (base model + data + hyperparams), loss/accuracy
   charts, deploy fine-tuned model (CS fine-tuning / AML jobs REST).
3. **Connections CRUD** (C3) — create/edit/delete AOAI/AI-Search/Blob connections
   (the portal's Management-center → Connections), since flows/agents depend on them.
4. **Guardrails / RAI-policy authoring** (C8) — create/edit content-filter policies
   and attach per deployment, not just ad-hoc moderation.
5. **Observability dashboard** (A6) + **trace-detail span explorer** (C7).
6. **Lifecycle ops on read-only tabs** — RBAC add/remove, Keys regenerate, deployment
   edit-capacity, compute start/stop/scale, online-endpoint test.
7. **Templates gallery** (A5) and remaining playgrounds (Images/Audio/Speech) (A3).
