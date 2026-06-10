# ai-foundry — parity with Azure AI Foundry (Microsoft Foundry portal)

**Audit date:** 2026-05-31 · **Auditor:** conservative 1:1 parity pass (no-vaporware.md + ui-parity.md)
**rev.2 — corrected against current code (2026-05-31):** the flagship **Agents** surface (A4) is now BUILT and wired (real Foundry Agent Service REST, honest 501 gate). Grade raised **C → C+**.
**Verdict:** **C+** (functional but rough; the headline new-Foundry "Agents" experience is now built end-to-end, but fine-tuning, Templates, Observability dashboards, and most read-only-where-portal-is-CRUD tabs remain).

> This is a brutally honest baseline. The prior self-grade of **A** in
> `ai-foundry-hub.observed.md` covered ONLY the model catalog + chat playground +
> ARM resource-management tabs. As of rev.2 the flagship **Agents** surface (the
> center of the *new* Foundry portal) is built and wired; the other 7 playgrounds,
> the Templates gallery, the Observability/Monitoring dashboards, fine-tuning, and
> guardrails authoring remain absent or shallow. With Agents built the real score
> is C+ (one ❌ → ✅; 7 ❌ remain).

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
- Backends: `lib/azure/foundry-cs-client.ts` (CognitiveServices/AIServices data+management plane), `lib/azure/foundry-client.ts` (MLS hub), `lib/azure/foundry-agent-client.ts` (Agent Service data-plane — **rev.2: now wired to the Agents editor** via `app/api/foundry/agents/*`; also consumed by the Loom/Fabric `data-agent` routes)
- **rev.2 Agents surface:** UI `lib/components/foundry/foundry-agents.tsx` (`FoundryAgentsPanel`), routes `app/api/foundry/agents/route.ts` (GET list / POST create-or-update), `app/api/foundry/agents/[name]/route.ts` (GET / DELETE), `app/api/foundry/agents/run/route.ts` (POST run+inspect). Wired into `foundry-hub-editor.tsx` (Agents tab @ line ~898/915) and the navigator `foundry-tree.tsx` (g-agents leaf + New→Agent menu).
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
| A3 | **Playgrounds — Images / Audio / Speech / Video / Language / Translator / Assistants** (7 more) | partial ⚠️ **Images** + **Audio** now run in-Loom (`ImagesPlaygroundPanel` / `AudioPlaygroundPanel`, real AOAI data-plane, honest gate when no model of that modality is deployed); Speech (TTS) is an honest deep-link (needs in-browser audio playback); Video/Language/Translator/Assistants remain deep-links | Images `POST /api/foundry/images` → AOAI `images/generations`; Audio `POST /api/foundry/audio` → AOAI `audio/transcriptions` |
| A4 | **Agents** (build agent: model + instructions + tools + knowledge + memory + guardrails; Chat/YAML/Code tabs; threads; preview; publish; AgentOps traces/evals) — **the headline of new Foundry** | built ✅ (rev.2) — `FoundryAgentsPanel` (`lib/components/foundry/foundry-agents.tsx`): builder (list + create/edit/delete; name, model-deployment picker, instructions, tools multi-select = code_interpreter/file_search/function) + playground (pick agent → ask → run with thread/run/**steps** inspector + answer). Wired as the hub **Agents** tab + navigator g-agents leaf. ⚠️ partial vs full portal: no knowledge/memory/guardrails attach, no YAML/Code tabs, no publish/versioning, no AgentOps eval dashboards — but the core build+test loop is real. | `GET/POST /api/foundry/agents` → `listAgents`/`createOrUpdateAgent` (Agent Service `{project}/agents` POST/PATCH/GET REST); `DELETE /api/foundry/agents/{name}`; `POST /api/foundry/agents/run` → `runAgentAndInspect` (threads→messages→runs→steps REST). Honest 501 gate on `LOOM_FOUNDRY_PROJECT_ENDPOINT` (the live state). |
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
| C4 | **Fine-tuning** — submit a fine-tune job (base model, training/validation data, hyperparams), monitor loss/accuracy, deploy fine-tuned model | built ✅ `FoundryHubEditor` **Fine-tuning** tab: upload JSONL training/validation files, pick a fine-tunable base model, set suffix + hyperparams (epochs/batch/LR), create job, monitor jobs table + per-step training/validation-loss events, cancel a running job. (Deploying the resulting fine-tuned model reuses the existing Models-deployments deploy flow.) | files `POST /api/foundry/fine-tuning/files`; jobs `GET/POST /api/foundry/fine-tuning`; detail+events+cancel `GET/POST /api/foundry/fine-tuning/{jobId}` → AOAI `fine_tuning/jobs` data-plane. Role: Cognitive Services OpenAI Contributor (granted in `ai-foundry.bicep`). |
| C5 | **Evaluations** — create eval (dataset + evaluators + target model), run, view metrics, compare runs | partial ⚠️ EvaluationEditor lists + creates + shows metrics table; **no** AI-quality/risk-safety evaluator picker UI, no run-to-run compare, no charts | `/api/items/evaluation/*` |
| C6 | **Prompt flow** — DAG designer (LLM/Python/Prompt nodes), connections, run, batch run, deploy | partial ⚠️ `PromptFlowBuilder` DAG editor + create/save/run wired; no batch-run, no deploy-as-endpoint, no flow-from-template gallery | `/api/items/prompt-flow/*` (AML data-plane) |
| C7 | **Tracing** (Operate) — connect App Insights, span/trace explorer, trace detail with run steps/tool calls | built ✅ flat trace table + **per-trace span tree drill** ("View spans" → reconstructed parent→child tree from App Insights dependencies+requests; per-span model, GenAI token usage in/out, duration, success). App-Insights binding surfaced via the hub Overview tab (honest disclosure of `applicationInsights`). | list `GET /api/items/tracing`; detail `GET /api/items/tracing/{traceId}` → `queryTraceDetail` (App Insights KQL union over `operation_Id`) |
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

## Summary counts (by inventory row, 44 graded) — rev.2

- **built ✅**: 20 (audit-t19: + C4 Fine-tuning, + C7 Tracing span-tree; A3 Images/Audio now in-Loom)
- **partial ⚠️**: 17 (A3 now partial — Images/Audio built, 5 modalities deep-link)
- **gated ⚠️**: 2
- **MISSING ❌**: 5 (A5 Templates, A6 Observability dashboard, A10 portal chrome, B8 carousel, + remaining playground modalities under A3)

## The honest verdict — **B-** (functional; flagship Agents, Fine-tuning, Tracing span-tree, Images/Audio playgrounds now built)

> 2026-06-10 (audit-t19): Fine-tuning (C4) shipped end-to-end (upload→job→loss
> events→cancel) with the Cognitive Services OpenAI Contributor grant added to
> `ai-foundry.bicep`; Tracing (C7) gained a real per-trace span-tree drill; the
> Images + Audio playgrounds (A3) now call the real AOAI data-plane in-Loom.

What's genuinely good (B/A-grade in isolation): the **model catalog + Deploy
flow** and the **chat playground** are real and wired to live Azure REST /
data-plane; the **ARM resource-management tabs** (quota, networking, activity,
keys, datastores, jobs, RBAC view, model deployments) are real and useful; the
**account picker** correctly binds the whole editor to a live account with an
honest gate when none exists. No mock arrays were found in the foundry routes.

Why it is NOT A/B overall, per ui-parity.md ("feature completeness must match"):

1. **Agents is now built** (A4, rev.2) — the defining surface of the new Foundry
   portal is wired end-to-end: build an agent (model + instructions + tools =
   code-interpreter/file-search/function), test it in the playground with a real
   thread→run→**steps** inspector. `foundry-agent-client.ts` (`{project}/agents`
   REST) drives `app/api/foundry/agents/*`; honest 501 gate on
   `LOOM_FOUNDRY_PROJECT_ENDPOINT`. Still short of *full* portal parity (no
   knowledge/memory/guardrails attach, no YAML/Code tabs, no publish/versioning,
   no AgentOps eval dashboards) — so the broader agent experience remains partial.
2. **Fine-tuning is missing** (C4) — no submit/monitor/deploy.
3. **Templates gallery, Monitoring/Observability dashboards, Announcements** are
   missing (A5/A6/B8).
4. **7 of 8 playgrounds are deep-link gates** (A3), not in-Loom surfaces.
5. **Many tabs are read-only where the portal is full-CRUD**: Connections (no
   create/edit/delete), RBAC (no add/remove), Keys (no regenerate), Online
   endpoints / Computes (no lifecycle ops), Model deployment edit-capacity.
6. **Tracing is a flat table, not the span/trace-detail explorer**; **Content
   safety is ad-hoc moderation, not RAI-policy CRUD + per-deployment attach.**

The mix (17 built / 17 partial / 3 gated / 7 missing) is **C+**: a real, working
core — now including the flagship Agents build+test loop — with broad but shallow
coverage. A grade requires zero ❌ and zero stub rows; this has 7 ❌ remaining and
several read-only-where-portal-is-CRUD tabs.

## Highest-value gaps to build first

1. ~~**Agents editor + playground** (A4)~~ — **DONE (rev.2)**. Built: create/edit/delete
   agent (model picker, instructions, tools = code-interpreter/file-search/function)
   + threads/runs/steps playground, real `/api/foundry/agents/*` REST, honest gate.
   Remaining agent depth (knowledge/memory/guardrails attach, YAML/Code tabs,
   publish/versioning, AgentOps eval dashboards) is the next agent increment.
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
