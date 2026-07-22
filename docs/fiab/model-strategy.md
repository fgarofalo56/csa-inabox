# CSA Loom model strategy — operator + developer runbook

**Best LLM per task, cloud-aware, day-one.** This runbook documents what the
model-strategy program (waves **M1–M5**) shipped: how Loom picks the right Azure
OpenAI model for each Copilot / Data-Agent, how it stays supported in every cloud
(Commercial through DoD) without ever 404-ing, how the deployed model set and
token budgets are configured, and how the optional APIM AI-gateway is turned on.

It grounds every claim in the merged code and bicep — file paths are given so you
can verify. Nothing here is aspirational; where a capability is opt-in or has a
caveat, that is called out.

> Source of record: `PRPs/completed/model-strategy/PRP.md` (the plan) and the merged
> PRs #1906 (M1–M3), #1909 (M4), and #1912 (M5 — cloud matrix + runtime fallback).

---

## 1. Overview

Loom runs the **best LLM per task** for every Copilot and Data-Agent, wired into
the **core / day-one deploy** — not an admin afterthought — and it is
**cloud-aware**: every deployed boundary (Commercial, GCC, GCC-High, DoD) always
lands a *supported* model, resolved at runtime with graceful fallback, never a
hard-coded model that 404s in Gov.

Three pieces make this work:

- **One resolver** — `resolveAoaiTarget()`
  (`apps/fiab-console/lib/azure/copilot-orchestrator.ts`). Precedence:
  tenant admin config → `LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT` env →
  Foundry hub discovery → a `gpt-4o` last-resort floor. It is cloud-correct: it
  validates the endpoint suffix (`.com` vs `.us`) and mints the bearer token for
  the right audience via `cogScope()`.
- **One unified client** — `aoai-chat-client.ts` (`aoaiChat` / `aoaiChatJson` /
  `aoaiChatRaw` / `aoaiEmbed` / `aoaiChatStream`). It is the single consolidation
  target for the ~18 call sites that used to roll their own AOAI fetch, so a fix
  to the model contract, token budget, or transport happens in exactly one place.
- **The AIF-12 tier router** — `lib/foundry/model-tier-router.ts`. It classifies
  each turn into a **task class** (`lightweight` / `general` / `reasoning`), maps
  that to a **tier** (`mini` / `standard` / `strong`), and swaps only the
  deployment segment of the resolved target. As of **M3** this router is
  **populated from env by default** (`LOOM_AOAI_MINI_DEPLOYMENT` /
  `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_STRONG_DEPLOYMENT`), so best-per-task routing
  is **active day-one with zero admin action** — default-ON / opt-out. When no
  tier deployments are configured it degrades to a safe no-op (every turn rides
  the resolved base), never a surprise swap.

The design is entirely **Azure-native** — no Fabric / Power BI model dependency
(`no-fabric-dependency.md`) — and every path calls a **real** model, never a mock
(`no-vaporware.md`).

---

## 2. Per-task → model mapping

The tier router maps task classes to tiers with this default (in
`DEFAULT_TASK_TIER_MAP`, `model-tier-router.ts`), which an admin can retune under
**Admin → Copilot & Agents → Model tiers**:

| Task class | Signals (deterministic classifier) | Tier | Deployment slot |
|------------|-------------------------------------|------|-----------------|
| `lightweight` | short (< 140 char) greeting / lookup / "what is", no code | **mini** | `LOOM_AOAI_MINI_DEPLOYMENT` |
| `general` | most chat + build requests (the default bucket) | **standard** | chat deployment (`LOOM_AOAI_DEPLOYMENT`) |
| `reasoning` | design / debug / analysis keywords, a code/query block, tools + long prompt, or > 600 chars | **strong** | `LOOM_AOAI_STRONG_DEPLOYMENT` |

The classifier (`classifyTaskClass`, `model-tier-router.ts`) is a deterministic,
explainable heuristic — no LLM round-trip. `selectTier` honestly falls back
`desired → standard → base` when a tier has no configured deployment, and reports
the tier actually ridden (so the transparency chip never claims a tier the turn
did not use).

**Which surface uses which tier**

- **Interactive Copilots** (chat panes, per-surface Copilot) → most turns classify
  as `general` → **standard** (low-latency chat model).
- **Data-Agents / planners / build-assist / multi-step design** → classify as
  `reasoning` (keywords, tool use, long context, code blocks) → **strong**.
- **Lightweight turns** (greetings, short lookups, classification, RAG pre-pass) →
  **mini**.
- **Embeddings** (RAG index, semantic search) are a separate path — `aoaiEmbed`,
  not the chat tier router — and use the embeddings deployment (§4).

Callers may force a tier per call (`tier`) or pin a pre-resolved `target`
(the per-call override always wins and skips the router — `applyTierRouting`,
`aoai-chat-client.ts`).

---

## 3. Per-cloud model matrix (M5)

Model availability is **region + version specific**, and Azure Government **lags**
Commercial. M5 added `lib/foundry/model-availability-matrix.ts` — a pure,
Learn-grounded, per-`(cloud, region)` **ordered preference chain** (best → floor)
per task key, plus a runtime layer that degrades a configured-but-undeployed model
down to one that is actually deployed. **No boundary ever pins a model it cannot
serve.**

### 3a. Preference chains (`CLOUD_PREFERENCES`)

| Cloud | chat (interactive) | mini | strong (reasoning) | embed |
|-------|--------------------|------|--------------------|-------|
| **Commercial** | gpt-5-chat → gpt-5.6 → gpt-4.1 → gpt-4o | gpt-4.1-mini → gpt-4o-mini | **gpt-5.6** → gpt-5.5 → gpt-5.2 → gpt-4.1 | **text-embedding-3-large** → 3-small → ada-002 |
| **GCC** | gpt-5-chat → gpt-4.1 → gpt-4o | gpt-4.1-mini → gpt-4o-mini | gpt-5.1 → gpt-5 → gpt-4.1 | 3-large → 3-small → ada-002 |
| **GCC-High** | gpt-5-chat → gpt-4.1 | gpt-4.1-mini | gpt-5.1 → gpt-5 → gpt-4.1 | 3-large → ada-002 |
| **DoD** | gpt-5-chat → gpt-4.1 | gpt-4.1-mini | **gpt-5.2** → gpt-5.1 → gpt-5 → gpt-4.1 | 3-large → ada-002 |

Key facts encoded here (PRP §2b):

- **Commercial** gets the frontier **GPT-5.6** (the MS365-Copilot-preferred model)
  on the strong tier.
- **No GPT-5.6 in Gov** — Gov chains never pin it. Foundry-in-Gov currently lists
  gpt-5 / gpt-5.1 / gpt-5-chat / gpt-4.1; **GPT-5.2** reached US Gov Secret / Top
  Secret, so it heads the **DoD** strong chain.
- Where `text-embedding-3-large` is absent in a Gov region, embeddings degrade to
  **ada-002**.
- Every chain is floor-terminated (`MODEL_FLOOR`): chat/mini/strong end at
  `gpt-4.1`, embed ends at `text-embedding-ada-002` — models every enumerated
  boundary can serve.

### 3b. Region override — `usgovarizona`

Availability is region-specific, so `REGION_OVERRIDES` pins a leaner chain for
`usgovarizona` (a smaller Foundry footprint than the primary `usgovvirginia`):
strong = `gpt-5 → gpt-4.1`, embed = `ada-002 → text-embedding-3-large`. Any task
key not overridden inherits the cloud default. These are conservative defaults;
the runtime check always has the final say against what is truly deployed.

### 3c. Runtime fallback — `ensureDeploymentAvailable` (degrade, never 404)

`bestModelsFor(cloud, region)` returns the head of each chain (what a clean deploy
would *attempt*). At runtime, `ensureDeploymentAvailable(configured, available,
cloud, region, key)`:

1. If the configured deployment is actually present (matched by deployment **name**
   *or* underlying **modelName**) → use it unchanged (happy path).
2. Else walk the preference chain and return the **first chain model that is
   deployed**, recording the fallback + a reason for the receipt.
3. Else — nothing in the chain is deployed → return an **honest signal**
   (`available:false`, reason set) and leave the configured value untouched so the
   caller's existing 404/503 gate fires. **It never invents a model.**

The wiring lives in `lib/foundry/model-availability-runtime.ts`, which is **cached
and non-blocking**: it fetches the account's live deployment list (reusing
`foundry-cs-client.listModelDeployments`) into a TTL cache refreshed in the
background. `applyAvailabilityFallback(target)` is **synchronous** and adds zero
latency to the hot path — the first (cold) call returns the target unchanged and
kicks off a background refresh, so there is no new 404 surface and a refresh
failure can never take a Copilot down. It is wired into `resolveAoaiTarget`, which
M5 split into a raw resolver (`resolveAoaiTargetRaw`) plus the availability
wrapper. Opt-out with `LOOM_AOAI_AVAILABILITY_CHECK=false`.

---

## 4. Deployed model deployments + capacity (M1–M2)

The dedicated Foundry Agent Service account the Console BFF targets is deployed by
`platform/fiab/bicep/modules/ai/foundry-project.bicep`. It creates four model
deployment slots (plus an optional fifth), each the target of a tier:

| Slot | Env var | Default model | Version | SKU | Capacity (TPM) |
|------|---------|---------------|---------|-----|----------------|
| **chat** (standard tier) | `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_CHAT_DEPLOYMENT` | `gpt-4.1` | 2025-04-14 | GlobalStandard | **50K** |
| **mini** (mini tier) | `LOOM_AOAI_MINI_DEPLOYMENT` | `gpt-4.1-mini` | 2025-04-14 | GlobalStandard | **50K** |
| **strong** (reasoning tier) | `LOOM_AOAI_STRONG_DEPLOYMENT` | `gpt-4.1` | 2025-04-14 | GlobalStandard | **50K** |
| **embed** | `LOOM_AOAI_EMBED_DEPLOYMENT` | `text-embedding-3-large` | 1 | GlobalStandard | 10K |
| **completion** (optional) | `LOOM_AOAI_COMPLETION_DEPLOYMENT` | `gpt-4o-mini` (empty ⇒ ghost text uses chat) | 2024-07-18 | GlobalStandard | 10K |

Notes:

- Model **names and versions are parameterized** with **GA-safe defaults**
  (`gpt-4.1` / `gpt-4.1-mini` — both GA in Commercial *and* Azure Government
  Standard). Never hard-coded to a model that could 404. Operators **raise** them
  to `gpt-5.x` / `gpt-5.6` where regionally available via the `*ModelName` /
  `*ModelVersion` params (or the admin-plane boundary overrides, §8).
- TPM defaults were raised from the legacy 10K to **50K** on chat/mini/strong so
  the tier router's turns have headroom. Capacity is per-param and tuned per
  quota.
- The `strong` slot defaults to `gpt-4.1` today so the tier router's strong tier
  has a real target; raise it to a stronger reasoning model where available (the
  router falls back to standard/chat when strong is unset).

### Tier-scaled `max_completion_tokens`

The unified client replaces a flat token cap with a **tier-scaled** default
(`defaultMaxCompletionTokens`, `aoai-chat-client.ts`), so reasoning answers are not
truncated by the AOAI `max_completion_tokens` gotcha:

| Tier | Default `max_completion_tokens` | Override env |
|------|---------------------------------|--------------|
| mini | **2048** | `LOOM_AOAI_MAX_COMPLETION_TOKENS_MINI` |
| standard | **4096** | `LOOM_AOAI_MAX_COMPLETION_TOKENS_STANDARD` |
| strong | **8192** | `LOOM_AOAI_MAX_COMPLETION_TOKENS_STRONG` |

An explicit `maxCompletionTokens` on a call always wins. The client always emits
`max_completion_tokens` (never `max_tokens`) and retries once without
`temperature` on the "model only supports the default temperature" 400.

---

## 5. APIM AI-gateway (M4, opt-in)

By **default AOAI is DIRECT** to the `*.openai.azure.{com,us}` endpoint —
byte-identical to before M4. M4 added an **opt-in** APIM GenAI gateway; enabling it
makes **no live change** until both the flag and the bicep param are set.

### How to enable

1. **Author the gateway (bicep):** set `aoaiApimGatewayEnabled = true` (default
   `false`) in `platform/fiab/bicep/modules/admin-plane/apim.bicep`, with at least
   one backend endpoint (`aoaiBackendEndpoints`). In `admin-plane/main.bicep` this
   is driven by `loomBackends.aoaiGateway == 'apim'`.
2. **Point the console at it (env):** `LOOM_AOAI_VIA_APIM=true` plus
   `LOOM_AOAI_APIM_URL=<gateway URL>` (emitted automatically when the gateway was
   actually authored). Routing decision lives in
   `lib/azure/aoai-apim-gateway.ts` (`resolveAoaiCallTarget`) — pure and
   network-free: it routes via APIM only when the flag is on, the URL is set, and
   the gateway is deemed available.
3. **One-time grant:** grant the APIM system-assigned managed identity **Cognitive
   Services OpenAI User** on the AOAI account. The gateway's
   `authentication-managed-identity` policy re-auths to the backend with that
   identity (no keys). The APIM MI principal is exported as
   `apimManagedIdentityPrincipalId`.

### Policies wired (Commercial / GCC)

- **`llm-token-limit`** — per-consumer tokens-per-minute ceiling (counts
  prompt + completion), emitting `x-loom-remaining-tokens` /
  `x-loom-consumed-tokens` and honoring `Retry-After`.
- **Priority load-balanced backend pool** — the first endpoint is priority 1
  (primary — e.g. a PTU backend), the rest priority 2 (Global-Standard spillover).
- **Circuit breaker** — a backend property (not a policy) that trips on 429/5xx
  and honors `Retry-After`; authored in **all** boundaries.
- **Semantic cache** (`llm-semantic-cache-lookup` / `-store`) — **opt-in on top**
  (`aoaiSemanticCacheEnabled`); requires an external Redis on the APIM instance +
  an embeddings backend.

### Automatic direct-with-MI fallback in Gov

The LLM policies (`llm-token-limit`, `llm-semantic-cache-*`) are **not GA in
sovereign** APIM, so they are **not authored** in GCC-High / IL5
(`aoaiLlmPoliciesSupported = !isSovereign` in the bicep). M5 mirrors that guard in
code: `apimLlmPoliciesSupported(cloud)` returns `true` only for Commercial / GCC,
and `resolveAoaiCallTarget` consults it (via `detectLoomCloud`), so a Gov deploy
that inherited `LOOM_AOAI_VIA_APIM=true` **auto-uses direct-with-managed-identity**
— same real backend, no feature regression. This is belt-and-suspenders with the
runtime transport fallback in the client: `withApimFallback` (`aoai-chat-client.ts`)
retries **once** against the direct endpoint on a genuine gateway **transport**
failure (it does *not* retry a real API error such as a 400/404/5xx from the
model). The circuit-breaker + priority pool (backend properties) still apply in
Gov.

---

## 6. Environment variable reference

| Env var | Default | Purpose |
|---------|---------|---------|
| `LOOM_AOAI_ENDPOINT` | — | AOAI account endpoint (resolver step 2). Cloud-validated (`.com` vs `.us`). |
| `LOOM_AOAI_DEPLOYMENT` / `LOOM_AOAI_CHAT_DEPLOYMENT` | `chat` | Chat / **standard**-tier deployment name. |
| `LOOM_AOAI_MINI_DEPLOYMENT` | `mini` | **Mini**-tier deployment (lightweight turns). Day-one tier source (M3). |
| `LOOM_AOAI_STRONG_DEPLOYMENT` | `strong` | **Strong**-tier deployment (reasoning turns). Day-one tier source (M3). |
| `LOOM_AOAI_EMBED_DEPLOYMENT` | `text-embedding-3-large` | Embeddings deployment for `aoaiEmbed`. |
| `LOOM_AOAI_COMPLETION_DEPLOYMENT` | — (empty ⇒ chat) | Optional ghost-text / inline-completion deployment. |
| `LOOM_AOAI_API_VERSION` | `2024-10-21` | AOAI data-plane api-version. |
| `LOOM_AOAI_MAX_COMPLETION_TOKENS_MINI` | 2048 | Override the mini-tier token cap. |
| `LOOM_AOAI_MAX_COMPLETION_TOKENS_STANDARD` | 4096 | Override the standard-tier token cap. |
| `LOOM_AOAI_MAX_COMPLETION_TOKENS_STRONG` | 8192 | Override the strong-tier token cap. |
| `LOOM_AOAI_VIA_APIM` | `false` | Route AOAI through the APIM gateway (M4, opt-in). |
| `LOOM_AOAI_APIM_URL` | — | APIM gateway base URL (used only when `VIA_APIM=true`). |
| `LOOM_AOAI_APIM_SUBSCRIPTION_KEY` | — | Optional `Ocp-Apim-Subscription-Key`; MI bearer suffices for the internal-VNet gateway. |
| `LOOM_AOAI_AVAILABILITY_CHECK` | `true` (on) | Kill switch for the M5 degrade-to-deployed runtime swap. |
| `LOOM_AOAI_AVAILABILITY_TTL_MS` | 300000 (5 min) | TTL for the live-deployment-list cache (M5). |
| `LOOM_AOAI_SUB` / `LOOM_FOUNDRY_SUB` / `LOOM_SUBSCRIPTION_ID` | — | Subscription for the live deployment read (M5); absent ⇒ availability check is skipped. |
| `LOOM_AOAI_CLIENT_V2` | — | Cut-over flag routing the orchestrator's legacy `callAoai`/`aoaiComplete*` through the unified client. |
| `LOOM_MODEL_TIER_ROUTING_ENABLED` | `true` (on) | WS-1.1 deployment-wide kill switch. Set `false` to opt out of tier routing entirely (every turn rides the resolved default) — the ONLY way tiering becomes a no-op besides the tenant `modelTierRoutingEnabled:false`. |

Admin tenant Copilot config (Admin → Copilot & Agents → Model tiers) **overrides**
the env defaults: `modelTierRoutingEnabled` (default-ON), `modelTiers.{mini,
standard,strong}`, and `modelTierTaskMap`.

### WS-1.1 — wired on the shared call path + gate + trace attribute

- **Shared-client wiring.** The unified `aoai-chat-client` (`aoaiChat` /
  `aoaiChatJson` / `aoaiChatRaw` / `aoaiChatStream`) now consults
  `routeTurnTier()` on EVERY call, so all copilot / agent / data-agent turns are
  tier-aware — not just the streaming orchestrator. The auto path is
  **escalate-only**: a hint-less turn only upshifts to the strong (reasoning)
  deployment when it classifies hard AND a strong deployment is configured; a
  lightweight turn is never silently downshifted to mini. So the ~18 existing
  callers stay byte-identical unless a reasoning deployment is wired and the turn
  is hard.
- **Per-cloud reasoning binding.** `bestReasoningModelFor(cloud, region)` /
  `defaultTierModelsFor(...)` bind the 3-tier default to the strongest model the
  boundary can serve (Commercial `gpt-5.6`; Gov `gpt-5.2`/`gpt-5.1`/`gpt-5`;
  floor `gpt-4.1`) — Gov-correct on `*.openai.azure.us`, no Fabric.
- **Honest gate + Fix-it.** `svc-model-reasoning-tier` (registry + `/admin/gates`)
  is `optionalDefault`: unset ⇒ the router rides the single default deployment
  for every turn (fully functional), and the Fix-it resource-picker lists the
  account's live AOAI deployments so an admin can bind the reasoning + mini tiers.
- **Trace attribute.** The orchestrator emits `modelTier` (the honestly-ridden
  tier, always present) + `taskClass` on the SSE `final` step — the durable
  attribution a browser E2E reads on every copilot turn — alongside `routedTier`
  (present only on an active deployment swap; drives the transparency chip).

---

## 7. The two bugs fixed in M1

1. **Embeddings default mismatch.** `aoaiEmbed` defaults to
   `text-embedding-3-large`, but bicep used to deploy `ada-002` — so an unset
   `LOOM_AOAI_EMBED_DEPLOYMENT` asked for a model that wasn't deployed (404, broken
   embeddings by default). **Fix:** the Commercial `foundry-project.bicep` embed
   slot now deploys **`text-embedding-3-large`** so code and infra agree on the
   better model. (Gov keeps `ada-002` where 3-large is absent — §8.)
2. **Gov 401 from a hard-coded Cognitive Services scope.** Two call sites minted
   the bearer token against the hard-coded Commercial audience
   `https://cognitiveservices.azure.com/.default`, which **401s in Gov** (Gov needs
   the `.us` audience). **Fix:** both now use the cloud-aware **`cogScope()`**
   helper — `help-copilot-orchestrator.ts` (Help Copilot) and `foundry-client.ts`
   `contentSafetyToken()` (Content Safety / moderation).

---

## 8. Operator actions

- **PTU vs Global-Standard (default: Global-Standard).** Every deployment slot
  ships **GlobalStandard**. The APIM priority load-balanced pool (§5) is designed
  so a **PTU reserved-capacity backend** can be added as the priority-1 primary
  with Global-Standard as priority-2 spillover — *if* you want reserved capacity on
  the Data-Agent / Copilot hot path. Decide which surfaces get PTU and the
  committed units per region; no PTU is required for day-one.
- **Raise models where regionally available.** To move Commercial off the GA-safe
  `gpt-4.1` defaults to `gpt-5.6` / `gpt-5.x`, set the `chatModelName` /
  `strongModelName` / `*ModelVersion` params on `foundry-project.bicep` (or the
  admin-plane boundary overrides). Confirm the model + version is GA (or an allowed
  preview) in the target region first; the M5 runtime fallback protects you if a
  raised model isn't actually deployed.
- **Gov AOAI provisioning.** The admin-plane per-cloud flip
  (`admin-plane/main.bicep`) already picks Gov-available slots for GCC-High / IL5:
  chat/completion/mini stay on the GA `gpt-4.1` / `gpt-4.1-mini`, embeddings flip to
  **`text-embedding-ada-002` v2** (universally Gov-available), and the SKU flips
  from GlobalStandard to **Standard** where GlobalStandard is unavailable. Confirm
  which `gpt-5.x` models are deployable in your target Gov region(s), and whether
  Azure AI Content Safety + APIM LLM policies are present — if the LLM policies are
  absent, the console uses the direct-with-MI path automatically (§5).

---

## Verification (per `no-vaporware.md`)

Each wave landed with a real-data E2E receipt: a real model call, the real
model/version returned, real TPM headers, live in a deployed boundary. To confirm
in your deployment: hit a Copilot with a lightweight prompt and a reasoning prompt
and check the model id / transparency chip differs (tier routing, M3); call
`aoaiEmbed` and confirm a 3-large vector (M1); and, in a Gov (or Gov-simulated)
deploy, confirm the resolver lands a supported model and never GPT-5.6 (M5).

---

*This runbook is the M6 deliverable of the model-strategy PRP; M1–M6 complete.*
