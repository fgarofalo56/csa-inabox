# Appendix — Refactor: One AOAI Chat Client (`refactor-aoai-consolidation`)

**Domain owner:** Enterprise-hardening PRP · **Scale target:** 100 → 60,000 users · **Clouds:** Commercial + Azure Government (GCC / GCC-High / DoD IL4-5)
**Status of the existing fix:** the `max_tokens → max_completion_tokens` correction already landed systemically (task #36, commit `38e6d5db`), but it landed as ~18 *parallel copies* of the same logic. This appendix is the **structural** fix: collapse those copies into one owned client so model-contract drift, quota, routing, cost, and telemetry have exactly one home.

---

## 1. Problem statement (grounded in the real code)

AOAI chat-completions is hand-rolled in **~18+ call sites**, each re-implementing the *same* five concerns with subtle divergence:

1. **Credential construction** — every file rebuilds the identical chain:
   ```ts
   const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
   const credential = uamiClientId
     ? new ChainedTokenCredential(new AcaManagedIdentityCredential(),
         new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
     : new DefaultAzureCredential();
   ```
   Confirmed verbatim in `copilot-orchestrator.ts`, `copilot-router.ts`, `help-copilot-orchestrator.ts`, `ai-functions-client.ts`, `data-agent-client.ts` (and the same shape in `dataflow-engine-client.ts`, `foundry-cs-client.ts`, the `lib/copilot/*-tools.ts`).

2. **Token scope** — `copilot-orchestrator.ts` / `copilot-router.ts` correctly call `cogScope()` (sovereign-aware: `cognitiveservices.azure.us` in Gov). But `ai-functions-client.ts` and `help-copilot-orchestrator.ts` **hard-code** `'https://cognitiveservices.azure.com/.default'` — a latent **Gov auth bug**: those two surfaces will 401 in GCC-High/DoD because they mint a Commercial-scoped token.

3. **Endpoint/URL assembly + api-version** — each site rebuilds `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=...`. Three different api-version sources exist: `LOOM_AOAI_API_VERSION || '2024-10-21'` (orchestrator), `AOAI_DATA_API` (foundry-cs-client), and inline literals.

4. **The model-param contract** — the bug surface. Divergence today:
   - `callAoai` (the tool loop, `copilot-orchestrator.ts:1213`) sets **no token cap at all** and does the temperature-fallback retry.
   - `aoaiCompleteText` / `aoaiCompleteJson` set `max_completion_tokens` + temperature fallback (the fixed path).
   - `foundry-cs-client.chatCompletion` maps `params.maxTokens → max_completion_tokens` but has **no temperature fallback** (a reasoning-model deployment selected in `/api/foundry/chat` will hard-fail on a non-default temperature instead of retrying).
   - `copilot-router.classifyIntent` sends neither — relying on forced `tool_choice`.
   Four behaviors for one contract. Any new reasoning model (gpt-5.x, o-series) re-breaks whichever copy was missed.

5. **Retry / 429 / telemetry** — only the temperature-400 retry exists. **No 429 handling anywhere** (grep for `429|retry-after` in `lib/azure` hits unrelated clients — `fetch-with-timeout`, `monitor-client`, etc., never the AOAI path). At 60k users a single shared Standard deployment will throttle constantly with **no `retry-after-ms` honoring, no PTU→PAYG spillover, no per-domain budget**. Usage telemetry (`emitCopilotUsage`) exists but is only wired from the orchestrator; the 17 other call sites burn tokens **invisibly** — no cost attribution, the exact gap the cost-governance domain needs closed here.

**Net:** model drift, the absence of quota/cost controls, and the lack of routing all trace to the same root cause — there is no single chat client. This domain creates it.

### Confirmed call-site inventory (migration targets)
Library clients: `lib/azure/copilot-orchestrator.ts` (callAoai, aoaiCompleteText, aoaiCompleteJson), `lib/azure/copilot-router.ts`, `lib/azure/help-copilot-orchestrator.ts`, `lib/azure/ai-functions-client.ts`, `lib/azure/data-agent-client.ts`, `lib/azure/dataflow-engine-client.ts`, `lib/azure/foundry-cs-client.ts`, `lib/copilot/dax-tools.ts`, `lib/copilot/agent-config-tools.ts`, `lib/copilot/pipeline-tools.ts`, `lib/copilot/ops-tools.ts`.
BFF routes: `app/api/foundry/chat/route.ts`, `app/api/notebook/[id]/assist/route.ts`, `app/api/items/[type]/[id]/assist/route.ts`, `app/api/items/semantic-model/[id]/{describe-bulk,copilot-structure}/route.ts`, `app/api/items/kql-queryset/[id]/assist/route.ts`, `app/api/items/kql-database/[id]/assist/route.ts`, `app/api/items/dashboard/[id]/tile-query/route.ts`, `app/api/items/azure-sql-database/[id]/copilot/route.ts`, `app/api/governance/govern/copilot/route.ts`, `app/api/copilot/{complete,notebook-assist,sessions}/route.ts`.

---

## 2. Target architecture (in words)

Create **one module**: `lib/azure/aoai-chat-client.ts` — the single owner of every AOAI chat-completions interaction. The cross-item orchestrator becomes the **first consumer**, not the owner. Everything else migrates to it behind a feature flag.

The client exposes a small, opinionated surface:

```ts
// lib/azure/aoai-chat-client.ts
export interface ChatRequest {
  messages: ChatMessage[];
  tools?: unknown[];                 // OpenAI tools array (tool loop)
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  maxCompletionTokens?: number;      // default 2048; omit on the agent loop to let the model run
  temperature?: number;              // default 0.2; auto-dropped on reasoning-model 400
  reasoningEffort?: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'; // gpt-5.x passthrough
  responseFormat?: { type: 'json_object' } | { type: 'json_schema'; json_schema: unknown };
  // routing / governance
  purpose: ChatPurpose;              // 'agent'|'classify'|'sql'|'dax'|'ai-fn'|'help'|'tile'|'describe'|...
  tenantConfig?: TenantCopilotConfig | null;
  domainId?: string;                 // multi-domain budget + chargeback key
  userOid: string;                   // OBO + per-user budget + telemetry hash
  obo?: boolean;                     // opt-in delegated identity (default false = Console UAMI)
  sessionId?: string;
  signal?: AbortSignal;
}
export interface ChatResult { content: string; toolCalls?: ToolCall[]; usage: Usage; model: string; finishReason: string; }

export async function chat(req: ChatRequest): Promise<ChatResult>;          // non-streaming
export async function* chatStream(req: ChatRequest): AsyncIterable<ChatDelta>; // SSE deltas
export async function chatJson<T>(req: ChatRequest): Promise<T>;            // json_object + tolerant parse
```

Internally the client is a pipeline of **single-responsibility layers**, each independently testable and each a plug point for a *sibling* hardening domain:

```
chat()/chatStream()
  └─ resolveTarget()        ── tenant cfg → env → Foundry discovery (moved verbatim from orchestrator)
  └─ resolveCredential()    ── Console UAMI chain  |  OBO per-user (mcp-obo-token-store pattern)
  └─ resolveScope()         ── cogScope() ALWAYS (kills the hard-coded .com Gov bug)
  └─ admitRequest()         ── per-domain / per-user token budget gate  (cost-gov plug point)
  └─ route()                ── deployment selection + PTU→PAYG spillover  (quota/routing plug point)
  └─ semanticCacheLookup()  ── APIM llm-semantic-cache OR local embedding cache  (cost plug point)
  └─ buildBody()            ── THE model-param contract (one place)
  └─ send() + retryPolicy() ── temperature-400 fallback + 429 retry-after-ms + circuit-break
  └─ recordUsage()          ── x-ratelimit headers → budget ledger + emitCopilotUsage telemetry
  └─ semanticCacheStore()
```

**Key design decision — gateway-optional.** Microsoft's recommended enterprise pattern is an **API Management GenAI gateway** owning token-limit, semantic-cache, load-balancing, retry, and metric-emit policies (MS Learn: *AI gateway in Azure API Management*). Loom already deploys APIM. So the client supports **two backends selected by one env var `LOOM_AOAI_GATEWAY`**:
- `apim` → the client POSTs to the APIM GenAI gateway route; APIM owns `llm-token-limit`, `llm-semantic-cache-{store,lookup}`, backend-pool load-balancing + circuit-breaker, `retry`, and `llm-emit-token-metric`. The client still owns the param contract + OBO + the in-app budget ledger as defense-in-depth.
- `direct` (default for small tenants / Gov boundaries where the GenAI policies aren't enabled) → the client owns rate-limit/cache/routing **in-process** using the same algorithms (leaky-bucket token bucket per domain, `retry-after-ms` honoring, deployment spillover list).

This honors **no-vaporware** (both paths call a real backend), **day-one-on but cost-governed** (the gateway/budget layer is enabled by default with generous limits, tightenable per-domain), and **migration-safe** (flip `direct`↔`apim` per tenant with zero call-site changes).

---

## 3. The model-param contract (the one place, grounded in MS Learn)

`buildBody()` is the *only* function in the codebase allowed to assemble a chat-completions body. Rules, each citation-backed:

- **Always `max_completion_tokens`, never `max_tokens`.** `max_tokens` is deprecated and **rejected by o-series / gpt-5.x reasoning models**; `max_completion_tokens` is accepted by gpt-4o/4.1 on current api-versions → forward-compatible for every deployment (MS Learn: *Azure OpenAI Chat — Create chat completion*; *reasoning models — API & feature support*). On the **agent tool-loop** (`purpose:'agent'`) leave it unset or set high — the leaky-bucket PTU estimator under-counts when it's small, throttling concurrency (MS Learn: *provisioned-throughput — Key concepts*: "If `max_tokens` isn't specified the service estimates a value… For highest concurrency ensure `max_tokens` is as close as possible to the true generation size").
- **Temperature fallback.** Reasoning models reject `temperature`/`top_p`/`presence_penalty`/`frequency_penalty`/`logit_bias` (MS Learn: *reasoning models — Not Supported*). Keep the existing `isUnsupportedSamplingParam()` detector: send `temperature` first, on a matching 400 retry once without sampling params. Promote that helper into the client (it currently lives in the orchestrator).
- **`reasoning_effort` passthrough.** gpt-5.1+ defaults to `none`; pass through `low|medium|high|xhigh` when the caller asks (MS Learn: *NEW GPT-5 reasoning features*). Only on Chat-Completions-capable models — the client's model-capability map gates it.
- **Chat-Completions vs Responses API.** Newer flagship/codex variants are **Responses-API-only** (no Chat Completions). The client keeps a capability table keyed by deployment-family; when a deployment is Responses-only it routes to `/openai/responses` with `max_output_tokens` instead (MS Learn: *reasoning — `max_output_tokens` with the Responses API*). **Gov note:** the Responses API **is** available in Azure Government (MS Learn: *Microsoft Foundry in Azure Government → Azure OpenAI features: Responses API = Yes*), but **Model router = No** — so client-side routing (below) is mandatory in Gov, not optional.
- **`user` field.** Set `user = sha256(userOid)` for abuse monitoring without leaking the OID (MS Learn: chat-completion `user` param).

---

## 4. Quota, routing & cost at 60k (the layers that don't exist yet)

### 4.1 Retry + 429 (defense-in-depth, both backends)
`retryPolicy()` honors the real headers (MS Learn: *Manage quota — rate-limit response headers* + *provisioned-throughput — 429*):
- On **429** read `retry-after-ms` (fallback `retry-after` seconds), wait, retry up to N (default 3); on exhaustion either **spillover** (PTU→PAYG) or surface an honest 503 gate.
- Proactively read `x-ratelimit-remaining-tokens` / `x-ratelimit-remaining-requests` and, when near zero, pre-emptively route to the next deployment **before** eating a 429.
- Wrap in a **circuit-breaker**: after K consecutive 429s on a deployment, open the breaker for that deployment for a cool-down and prefer siblings (MS Learn: *GenAI gateway key considerations — circuit-breaker for request prioritization*).

### 4.2 Model routing / PTU spillover
`route()` selects among an ordered deployment list `LOOM_AOAI_DEPLOYMENTS` (JSON: `[{name, kind:'ptu'|'payg', region, tpm}]`). Strategy = **PTU first, spill to PAYG on 429/utilization>100%** (MS Learn: *GenAI gateway — Managing Spikes on PTUs with PAYG*). When `LOOM_AOAI_GATEWAY=apim`, this is delegated to APIM backend pools + `retry`; in `direct` mode the client iterates the list. A cheaper `routerDeployment` (already in `TenantCopilotConfig`) stays the classify path. **60k sizing:** AOAI quota is **regional**; a single Standard deployment in centralus caps total RPM. The design supports multiple deployments (and, when BCDR sibling-domain lands multi-region, multiple regions) behind the list — MS Learn shows multi-region ~doubles RPM headroom.

### 4.3 Per-domain budget + cost governance (`admitRequest` + `recordUsage`)
This is where the **multi-domain model** (`lib/azure/domain-registry.ts`, `domain-groups.ts`, `lib/auth/domain-role.ts`) plugs in:
- Each chat request carries `domainId` (resolved from the caller's Entra group claim via the existing `workspace-roles-client` domain-tier resolver).
- `admitRequest()` checks a **token-budget ledger in Cosmos** (`copilot-budgets` container, PK `/domainId`, autoscale RU) — per-domain TPM/daily-token ceilings, with per-user sub-limits. Over-budget → honest 429-style gate (`{ok:false, code:'budget_exceeded', remediation}`) rendered as a Fluent MessageBar, **never a silent drop**. Day-one-on means default ceilings are generous; admins tighten per-domain in the cost UI.
- `recordUsage()` writes the **real** `usage` token counts back to the ledger and emits `emitCopilotUsage` with `domainId` + chargeback tag (extends the existing App-Insights `copilot.usage` event already carrying `persona`/`boundary`). This finally attributes the 17 currently-invisible call sites. APIM mode additionally gets `llm-emit-token-metric` per-consumer metrics in Azure Monitor (MS Learn: *AI gateway — Observability*).

### 4.4 Semantic cache
`semanticCacheLookup/Store()`:
- `apim` mode → `llm-semantic-cache-lookup` / `-store` policies backed by **Azure Managed Redis** (RediSearch) (MS Learn: *Enable semantic caching for LLM APIs in APIM*).
- `direct` mode → embeddings (the already-resolved AOAI embedding deployment) + a Cosmos/Redis vector compare; cache hit returns the stored completion, skipping the model call. Cache is **keyed by `domainId`** so tenants never see each other's completions (data-sovereignty). Disabled by default for `purpose:'agent'` (tool side-effects must not be cached); enabled for `classify|sql|dax|describe` where prompts repeat.

---

## 5. Dual cloud — Commercial vs Azure Government

| Concern | Commercial | Azure Government (GCC-High / DoD IL4-5) |
|---|---|---|
| AOAI host suffix | `*.openai.azure.com` | `*.openai.azure.us` (already via `getOpenAiSuffix()`) |
| Token scope | `cognitiveservices.azure.com/.default` | `cognitiveservices.azure.us/.default` (already via `cogScope()` — **fix the 2 hard-coded sites**) |
| Entra authority | `login.microsoftonline.com` | `login.microsoftonline.us` (OBO must use the Gov authority — reuse `lib/auth/msal.ts` boundary logic) |
| Foundry portal | ai.azure.com | ai.azure.us / ai.azure.us/nextgen |
| Regions | centralus (+ multi-region future) | usgovarizona, usgovvirginia, **USGov DataZone** |
| Model router | Available | **NOT available** → client-side `route()` is mandatory |
| Responses API | Available | **Available** (so Responses-only models still work) |
| Fine-tuning / Agents / serverless / batch | Available | **NOT available** → keep the existing **MAF tier** (`orchestrateViaMaf`, VNet-internal Container App) as the Gov agent runtime; the new client backs its AOAI calls |
| Semantic cache (Managed Redis) | Available | Verify per region; if absent, `direct`-mode Cosmos vector cache is the OSS-style substitute |
| APIM GenAI policies | Available | APIM is in Gov; **gate `llm-*` policy enablement per boundary** — fall back to `direct` mode where unavailable (honest gate) |
| IL5 | n/a | AOAI + Cosmos + Redis **private-endpoint-only**, CMK, no public path; budgets/cache stay in-boundary |

`validateEndpointCloud()` (already in the orchestrator) moves into the client so **every** call site inherits the mismatch guard (Commercial endpoint in a Gov deployment → precise honest gate instead of opaque 401). The client reads `detectLoomCloud()` / `isGovCloud()` for all suffix/scope/authority choices — **zero new per-cloud branches at call sites**.

---

## 6. File-level build spec

**Create:**
- `lib/azure/aoai-chat-client.ts` — the client (sections 2-4). Re-exports `resolveAoaiTarget`, `NoAoaiDeploymentError`, `AoaiTarget` for back-compat so existing imports don't break during migration.
- `lib/azure/aoai-model-contract.ts` — `buildChatBody()`, `isUnsupportedSamplingParam()` (moved), the model-capability table (chat-completions vs responses, reasoning_effort support), api-version resolver. Pure, fully unit-tested — **no Azure SDK import** so the contract is testable without credentials.
- `lib/azure/aoai-routing.ts` — deployment list parse, PTU→PAYG spillover, circuit-breaker state (in-memory + optional Cosmos for multi-instance), `retry-after-ms` parser.
- `lib/azure/aoai-budget.ts` — Cosmos `copilot-budgets` ledger: `admit(domainId,userOid,estTokens)`, `record(domainId,userOid,usage)`, per-domain/per-user ceilings from tenant config.
- `lib/azure/aoai-semantic-cache.ts` — `direct`-mode embedding cache + `apim`-mode passthrough.
- `lib/azure/__tests__/aoai-model-contract.test.ts`, `aoai-routing.test.ts`, `aoai-budget.test.ts` — Vitest (pure-logic, runs despite the known render-test harness breakage).
- `lib/types/aoai-governance.ts` — `DomainBudget`, `DeploymentSpec`, `ChatPurpose` types.
- BFF: `app/api/admin/aoai-governance/route.ts` — GET/PUT per-domain budgets + deployment list (admin-gated).
- UI: `lib/admin/aoai-governance-panel.tsx` — Fluent v9 + Loom tokens Web-5.0 wizard surface under **Admin → Tenant settings → Copilot & Agents → Quota & Cost**: per-domain TPM/daily ceilings (sliders), deployment-pool table (PTU/PAYG, drag to reorder priority), semantic-cache toggle, live token-spend chart (reads the `copilot.usage` App-Insights metric). No free-form JSON (honors `no-freeform-config`).

**Edit (migrate, behind `LOOM_AOAI_CLIENT_V2`):**
- `lib/azure/copilot-orchestrator.ts` — `callAoai`, `aoaiCompleteText`, `aoaiCompleteJson` become thin wrappers calling `chat()/chatStream()/chatJson()`. Delete the duplicated credential/token/retry blocks. `emitCopilotUsage`/`resolveAoaiTarget` move to the client and are re-exported here for back-compat. **This is the reference migration** — do it first, prove parity, then fan out.
- `lib/azure/copilot-router.ts` — `classifyIntent` → `chat({purpose:'classify', toolChoice:{function:'route'}, tenantConfig})`. Drops its own credential/token.
- `lib/azure/help-copilot-orchestrator.ts` — drop the **hard-coded `.com` scope** (Gov bug), call the client.
- `lib/azure/ai-functions-client.ts` — same Gov-scope fix; call `chat({purpose:'ai-fn'})`.
- `lib/azure/data-agent-client.ts`, `dataflow-engine-client.ts`, `foundry-cs-client.ts` (add the missing temperature fallback for free), `lib/copilot/{dax,agent-config,pipeline,ops}-tools.ts` — migrate.
- BFF routes (section 1 list) — replace inline fetches with client calls; pass `domainId` + `userOid` from the session.

**Bicep / deploy:**
- `platform/fiab/bicep/modules/admin-plane/main.bicep` — add to the console app `env[]`: `LOOM_AOAI_CLIENT_V2`, `LOOM_AOAI_GATEWAY` (`direct`|`apim`), `LOOM_AOAI_DEPLOYMENTS` (JSON pool), `LOOM_AOAI_BUDGET_DEFAULT_TPM`, `LOOM_AOAI_SEMANTIC_CACHE`.
- New `platform/fiab/bicep/modules/admin-plane/aoai-gateway.bicep` (opt-in) — APIM GenAI API import over the AOAI backend pool + the `llm-token-limit`, `llm-semantic-cache-*`, `retry`, `llm-emit-token-metric` policies; Azure Managed Redis (external cache) with **private endpoint**; APIM managed identity granted **Cognitive Services OpenAI User** on every AOAI account (MS Learn: *GenAI gateway — managed identity auth*). Commercial + Gov param variants (`.bicepparam`); IL5 = private-only + CMK.
- Cosmos `copilot-budgets` container via the existing cosmos-client `createIfNotExists` step (PK `/domainId`, autoscale).
- Gov: ensure the MAF Container App env also receives `LOOM_AOAI_DEPLOYMENTS` so its UAMI uses the same routing against `*.openai.azure.us`.

---

## 7. Code vs tenant-admin action (honest gates + runbooks)

| Item | Code (Loom ships) | Tenant-admin / Azure action (runbook) |
|---|---|---|
| Param contract, retries, fallback, telemetry | ✅ entirely in the client | — |
| Per-domain budget ledger + UI | ✅ Cosmos + admin panel | Admin sets ceilings (defaults applied day-one) |
| `direct`-mode routing/cache | ✅ in-process | Operator populates `LOOM_AOAI_DEPLOYMENTS` |
| Multiple AOAI deployments (PTU + PAYG) | client routes across them | **Operator must create the deployments**; PTU needs **PTU quota** requested via aka.ms/oai/stuquotarequest (Commercial) / aka.ms/AOAIGovQuota (Gov) — honest gate names the link |
| APIM GenAI gateway + Managed Redis | bicep module | Operator opts in (`LOOM_AOAI_GATEWAY=apim`), deploys the module, approves the Redis/AOAI private endpoints |
| OBO per-user identity | ✅ client supports `obo:true` | Entra app reg + delegated `Cognitive Services User` consent (reuse the mcp-obo runbook) |
| Gov boundary | ✅ suffix/scope/authority auto | Operator sets `LOOM_CLOUD=GCC-High`; provisions AOAI in usgovarizona/virginia |

Any missing-infra state renders a Fluent `MessageBar intent="warning"` naming the exact env var / role / quota link — never a silent failure (no-vaporware).

---

## 8. Incremental, reversible migration plan

1. **Land the client + tests** (no call-site changes). `LOOM_AOAI_CLIENT_V2=false` everywhere → zero behavior change.
2. **Migrate the orchestrator's 3 functions** as the reference; gate each on the flag (`v2 ? chat() : legacyCallAoai()`). Roll to centralus, validate with the live Copilot. Flag default stays off.
3. **Fan out call sites** in small batches (per the rate-limit lesson in MEMORY — chunk-of-3, build-gate each). Fix the two Gov-scope bugs and the missing foundry-cs-client fallback in this wave.
4. **Flip `LOOM_AOAI_CLIENT_V2=true`** per tenant; the legacy branches remain dead-code-reversible for one release, then deleted.
5. **Enable budgets/routing/cache** incrementally: `direct` mode first (no new infra), then `apim` for large tenants.
6. **Gov rollout** last, validated against `*.openai.azure.us` with the MAF tier.

Every step is independently shippable and revertible by a single env flip — no big-bang.

---

## 9. Acceptance criteria

- One module owns 100% of chat-completions bodies; `grep -rn "chat/completions" lib app` returns **only** `aoai-chat-client.ts` + the APIM route (verification gate).
- No hard-coded `cognitiveservices.azure.com` scope remains (Gov-clean).
- A reasoning-model deployment (gpt-5.x / o-series) works on **every** migrated surface (contract test asserts `max_completion_tokens` + temperature drop).
- A forced 429 (load test) is honored via `retry-after-ms` and spills PTU→PAYG; no user-visible failure until budget/quota truly exhausted, then an honest gate.
- `copilot.usage` telemetry carries `domainId` for all ~18 surfaces; per-domain spend is visible in the admin panel.
- Real-data E2E receipt (per no-vaporware): a chat call hitting the live centralus AOAI through the client, with the response body + the App-Insights event, in the PR.
- Commercial **and** Gov param variants deploy from bicep clean.

---

## 10. Priority & sizing

- **P0:** create the client + contract module + migrate the orchestrator 3 functions + fix the 2 Gov-scope bugs + the foundry-cs-client missing fallback. (Stops drift + the latent Gov 401s.)
- **P1:** fan-out migration of the remaining ~15 sites; per-domain budget ledger + telemetry attribution; `direct`-mode 429/spillover. (Cost visibility + 60k throttle survival.)
- **P2:** APIM GenAI gateway bicep + semantic cache + admin Quota/Cost UI; Gov APIM-policy gating. (Managed-service polish + cost reduction.)

**60k math:** at ~18 surfaces × bursty interactive use, a single Standard deployment (regional TPM cap) will throttle. P1 in-app routing across ≥2 PAYG deployments roughly doubles RPM headroom (MS Learn multi-region table); P2 PTU gives latency-predictable floor with PAYG spillover for spikes. Budget ledger caps any one domain from starving the rest — the core multi-tenant-fairness requirement at the 60k upper bound.
