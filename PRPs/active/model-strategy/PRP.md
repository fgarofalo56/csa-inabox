# PRP — Best-LLM-per-Task, Day-One, Cloud-Aware Model Strategy + APIM AI-Gateway

**Status:** SHIPPED (2026-07-12) — Waves M1–M6 landed as PRs #1903–#1914: AIF-12
tier router wired day-one (`lib/foundry/model-tier-router.ts`), cloud-aware
model-availability matrix (`lib/foundry/model-availability-matrix.ts`) with
deploy-time best-available resolution + Gov APIM-policy auto-fallback (#1912),
APIM AI-gateway opt-in, GPT-5.x support, and the embeddings / Help-Copilot-Gov
correctness bugs fixed. Runbook: `docs/fiab/model-strategy.md`.
**Created:** 2026-07-11 · **Owner:** autonomous build program
**Related rules:** `no-fabric-dependency.md`, `no-vaporware.md`, `ui-parity.md`,
`ux-baseline.md`, `web3-ui.md`, `loom_default_on_opt_out` (memory),
`no_scaffold_claims` (memory)
**Memory:** `csa_loom_model_strategy_prp.md` (to be written on first wave land)
**Scope (historical):** originally planning-only. **As of 2026-07-12 the Design/Waves
below are DELIVERED** (Waves M1–M6, PRs #1903–#1914) — the sections are retained as the
as-built specification, not forward work.

---

## 1. Goal (operator intent, 2026-07-11)

> Ship Loom with the **BEST LLMs per task** for every Copilot and Data-Agent. Wire
> the model choice into the **core / day-one deploy** — not an admin afterthought.
> Make it **cloud-aware**: every deployed cloud (Commercial, GCC, GCC-High, DoD)
> always lands a **supported** model, resolved at deploy time, with graceful
> fallback — never a hard-coded model that 404s in Gov. Configure every task for
> **maximum token usage** (high TPM + high `max_completion_tokens` where the task
> warrants it). Decide **APIM-vs-direct** for the Foundry / AI endpoints. Deliver a
> **"super-hero-level"** Copilot/agent experience out of the box.

### What "done" means

1. A fresh `az deployment` in **any** cloud/region stands up the best supported
   model set for that boundary, with the **AIF-12 tier router populated in core
   config** so every Copilot/agent already rides the right model for its task —
   zero admin action required (default-ON / opt-out per `loom_default_on_opt_out`).
2. **No model 404s in Gov.** Model names are resolved against the live
   model-availability surface at deploy time; if the frontier model is unavailable
   the deploy falls back to the best supported version and records which model it
   picked (honest, per `no-vaporware.md`).
3. AOAI traffic routes through an **APIM AI-gateway where the LLM policies are
   supported**, with **automatic direct-with-managed-identity fallback** where they
   are not (Gov). Both paths call a **real** model — no mocks.
4. The two known correctness bugs (§3d) are fixed so embeddings and the Help
   Copilot work in every cloud.

---

## 2. Latest-model catalog + per-cloud availability matrix

### 2a. Model catalog (verified web, July 2026)

| Family | Members | Class | Key params | Notes |
|--------|---------|-------|------------|-------|
| GPT-5.x frontier | **GPT-5.6** (frontier; now the MS365 Copilot preferred model), GPT-5.5, GPT-5.2, GPT-5.1, GPT-5 | Reasoning | `reasoning_effort`, `verbosity`, `max_completion_tokens` | GPT-5.x are **reasoning** models — use `reasoning_effort` (minimal→high) + `verbosity`, NOT `temperature`. |
| GPT-5 chat | **gpt-5-chat** | Interactive (low-latency) | `max_completion_tokens`, `verbosity` | Chat-tuned, snappy; ideal for interactive Copilots. |
| o-series | o-series reasoning models | Reasoning | `reasoning_effort` | Legacy reasoning path; GPT-5.x supersedes for most tasks. |
| GPT-4.1 family | gpt-4.1, gpt-4.1-mini, gpt-4.1-nano | General / mini | `temperature`, `max_tokens` | Broadly available incl. Gov; the current Gov chat default. |
| gpt-4o family | gpt-4o (2024-11-20), gpt-4o-mini (2024-07-18) | General / mini | `temperature`, `max_tokens` | Today's Loom default deployment (to be upgraded). |
| Embeddings | **text-embedding-3-large**, text-embedding-3-small, text-embedding-ada-002 (v2) | Embedding | — | 3-large is the target; ada-002 is what bicep deploys today (bug, §3d). |
| Moderation | **Azure AI Content Safety** | Guardrail | — | Not an LLM; the moderation path (prompt shields + content filters). |

**Reasoning-model params (grounding):**
`learn.microsoft.com/azure/foundry/openai/how-to/reasoning` — GPT-5.x + o-series
take `reasoning_effort` and `verbosity`; they use `max_completion_tokens` (which
counts reasoning tokens) rather than `max_tokens`, and reject `temperature`/`top_p`.
This is why the "max token usage" design (§4a) must set `max_completion_tokens`
per task-class and budget for reasoning-token overhead.

### 2b. Per-cloud availability matrix (the "resolve-best-at-deploy + fallback" rule)

Availability is **region + version specific**. Gov **lags** Commercial. The deploy
MUST resolve the best supported model per cloud/region via the model-availability
API and fall back gracefully — never hard-code a model that 404s in a boundary.

| Cloud / boundary | Frontier chat (best→fallback) | Interactive chat | Mini/high-volume | Embeddings | Content Safety |
|------------------|-------------------------------|------------------|------------------|------------|----------------|
| **Commercial** | GPT-5.6 → GPT-5.5 → GPT-5.2 → gpt-4.1 | gpt-5-chat → GPT-5.6 | gpt-4.1-mini → gpt-4o-mini | text-embedding-3-large | Yes |
| **GCC** | best of {GPT-5.x present} → gpt-4.1 | gpt-5-chat (if present) → gpt-4.1 | gpt-4.1-mini → gpt-4o-mini | 3-large → 3-small → ada-002 | Yes |
| **GCC-High** | GPT-5 / GPT-5.1 / gpt-5-chat → **gpt-4.1** (current Gov default) | gpt-5-chat (if present) → gpt-4.1 | gpt-4.1-mini | 3-large → ada-002 | Confirm per region |
| **DoD** | best supported (GPT-5.2 reached US Gov Secret/TS) → gpt-4.1 | gpt-5-chat (if present) → gpt-4.1 | gpt-4.1-mini | 3-large → ada-002 | Confirm per region |

**Key facts driving the matrix:**
- **Commercial** gets **GPT-5.6** (frontier, MS365-Copilot-preferred, in Azure Foundry).
- **Azure Gov LAGS.** Foundry-in-Gov currently lists **gpt-5 / gpt-5.1 / gpt-5-chat /
  gpt-4.1**. **GPT-5.2** reached **US Gov Secret / Top Secret**. **No GPT-5.6 in Gov yet.**
- Therefore the resolver must **never** pin GPT-5.6 for a Gov boundary; it resolves the
  best of the models actually present in that cloud/region and records the pick.

**Sources:**
`learn.microsoft.com/azure/foundry/openai/how-to/reasoning`,
`.../foundry-models/concepts/models-sold-directly-by-azure`,
`.../models-sold-directly-by-azure-gov`,
`.../models-sold-directly-by-azure-region-availability`.

### 2c. Resolve-best-at-deploy + fallback rule (normative)

```
BEST[cloud, region, task-class] =
  first model in the task-class preference list (2b)
  that the model-availability API reports as deployable in (cloud, region)
  at a GA (or explicitly-allowed preview) version;
  else fall back to the next in the list;
  else the last-resort floor (gpt-4.1 for chat, ada-002 for embeddings);
  record the chosen (model, version, sku) in the deploy receipt.
```

No boundary is allowed to emit a deployment for a model the availability surface
does not list. A fallback is a normal outcome, logged — never an error.

---

## 3. Current Loom wiring (code-map — grounded, read-only confirmed)

### 3a. Resolver + unified client
- Single resolver `resolveAoaiTarget()` —
  `apps/fiab-console/lib/azure/copilot-orchestrator.ts:253-326`. Precedence:
  **tenant-cfg → env (`LOOM_AOAI_ENDPOINT` + `LOOM_AOAI_DEPLOYMENT`) → Foundry
  discovery → hard-coded `gpt-4o`** (line 316 fallback string).
- Unified client `lib/azure/aoai-chat-client.ts` — `aoaiChat` / `aoaiJson` /
  `aoaiRaw` / `aoaiEmbed` / `aoaiStream`. **Default cap 2048 `max_completion_tokens`.**
  Cut-over flag `LOOM_AOAI_CLIENT_V2`. Shares credential + `cogScope()` token via
  `aoaiToken()` (`copilot-orchestrator.ts:330`).

### 3b. AIF-12 tier router — ALREADY EXISTS (this is the lever)
- `lib/foundry/model-tier-router.ts` — `classifyTaskClass(prompt)` →
  `taskClass ∈ {lightweight, general, reasoning}` → `tier ∈ {mini, standard,
  strong}` → deployment swap. Applied in `aoai-chat-client.ts:81-93`.
- **Default-ON but a NO-OP** until an admin wires `modelTiers.{mini,standard,strong}`
  + `modelTierTaskMap` in tenant cfg (`tierPolicyFromConfig`,
  `model-tier-router.ts:198-211`; `enabled` defaults true,
  `model-tier-router.ts:199`). With no tier deployments configured every turn rides
  the resolved base — safe, but **no best-per-task differentiation**.
- **Therefore "best-per-task" = POPULATE this policy in CORE config** (not net-new
  plumbing). The classifier, selector, honest fallback (desired→standard→base,
  `selectTier`, `model-tier-router.ts:156-177`) and per-call override already exist.

### 3c. Bicep model deployments (default-on)
- `platform/fiab/bicep/modules/ai/foundry-project.bicep` — defaults:
  chat = **`gpt-4o` `2024-11-20` `GlobalStandard` @10K TPM** (`:62,65,68,72`);
  embed = **`text-embedding-ada-002` v2 `GlobalStandard` @10K** (`:76-89`);
  completion = **`gpt-4o-mini` `2024-07-18`** optional (`:100-113`, empty ⇒ ghost
  text falls back to chat).
- Fallback shared hub: `admin-plane/ai-foundry.bicep`.
- Per-cloud model flip: `admin-plane/main.bicep:2144-2155` (Gov → `gpt-4.1` Standard).
- Gov params: `params/gcc-high.bicepparam`.

### 3d. APIM — NO AI gateway today (greenfield)
- All AOAI is **DIRECT** to `*.openai.azure.{com,us}`. `admin-plane/apim.bicep`
  currently exposes only a **sample-mock** API. No `llm-token-limit`, no LLM
  load-balancer/backend pool, no semantic cache, no circuit breaker.

### 3e. Per-feature differentiation today
- **EVERY** chat/agent feature shares the single `LOOM_AOAI_DEPLOYMENT`. Only
  **embeddings** (`aoaiEmbed`) and **inline-completion** (optional deployment)
  differ. **No best-per-task differentiation** exists at runtime.

### 3f. Two correctness bugs (must-fix)
1. **Embed default mismatch.** `aoai-chat-client.ts:368` defaults the embed
   deployment to **`text-embedding-3-large`**, but bicep deploys **`ada-002`**
   (`foundry-project.bicep:76`). Result: an unset `LOOM_AOAI_EMBED_DEPLOYMENT`
   asks for a model that isn't deployed → 404 (the client's honest 404 gate fires,
   but embeddings are broken by default). **Fix path: upgrade bicep to deploy
   `text-embedding-3-large`** so code + infra agree on the better model (§4a/§4e).
2. **Hard-coded Commercial scope in Help Copilot.**
   `help-copilot-orchestrator.ts:61` hard-codes
   `https://cognitiveservices.azure.com/.default` → **401 in Gov** (Gov needs the
   `.us` audience). **Fix path: use `cogScope()`** (the cloud-aware scope helper the
   main orchestrator already uses, `copilot-orchestrator.ts:331`).

---

## 4. Design (planning — no code in this PRP)

### 4a. Upgrade bicep model deployments + high TPM + per-task-class max tokens
- **Model upgrade (Commercial default):** chat `gpt-4o` → the best supported chat
  model from §2b (GPT-5.6 in Commercial), interactive `gpt-5-chat`, mini
  `gpt-4.1-mini`/`gpt-4o-mini`, embeddings `ada-002` → **`text-embedding-3-large`**
  (also fixes bug 1). Add a **strong/reasoning** deployment so the tier router's
  `strong` tier has a real target.
- **High TPM:** raise `chatModelCapacity` / `embedModelCapacity` from 10 to the
  per-task ceiling the region allows (Global-Standard first; PTU is the open
  operator question, §7). Capacity is resolved per cloud/region so Gov quota limits
  are respected.
- **Max token usage per task-class:** replace the flat 2048 `max_completion_tokens`
  cap with a **task-class budget** (e.g. reasoning/Data-Agent = large, interactive
  Copilot = medium, high-volume/mini = small), accounting for GPT-5.x
  reasoning-token overhead (§2a). Set `reasoning_effort` per task-class (high for
  planners/build-assist, minimal/low for lightweight turns).
- **Deliverable:** new/updated params in `foundry-project.bicep` +
  `admin-plane/main.bicep` per-cloud flip, wired to the resolver (§4c). *(Built in a
  later PR — this PRP does not touch bicep.)*

### 4b. POPULATE the AIF-12 tier router in CORE / day-one config
- Seed `modelTiers.{mini,standard,strong}` and `modelTierTaskMap` in the **default
  tenant Copilot config** at provision time (deploy-time bootstrap writes the three
  deployment names that §4a actually created into core config), so the router is
  **active on day one**, not a no-op awaiting admin setup.
- Keep it **default-ON / opt-out**: admin can retune the task→tier map and per-tier
  deployments, but the shipped defaults already give best-per-task routing.
- Map (default): `lightweight → mini`, `general → standard`, `reasoning → strong`
  (already the `DEFAULT_TASK_TIER_MAP`, `model-tier-router.ts:72-76`) — the change is
  **populating real deployment names**, not new routing code.

### 4c. Cloud-aware model resolution at deploy (availability check + fallback)
- A deploy-time step resolves `BEST[cloud, region, task-class]` (§2c) against the
  model-availability surface, then feeds the resolved (model, version, sku) into the
  bicep params (§4a) AND the core tier config (§4b). The result is recorded in the
  deploy receipt (which model each tier got, and any fallback taken).
- The runtime resolver `resolveAoaiTarget()` (§3a) is unchanged in precedence but now
  reads deployments that are **guaranteed to exist in the boundary** — the hard-coded
  `gpt-4o` last-resort (`copilot-orchestrator.ts:316`) stays only as a floor.

### 4d. APIM AI-gateway (Microsoft-recommended) + route client + Gov fallback
- **Decision: route AOAI through the APIM GenAI gateway where the LLM policies are
  supported; automatic direct-with-MI fallback where they are not.**
  Grounding: `learn.microsoft.com/azure/api-management/genai-gateway-capabilities`.
- Capabilities to wire (later PR): token-based rate limiting per consumer
  (`llm-token-limit`), **priority load-balancing** (PTU backend → S0/Global-Standard
  fallback), **circuit breaker** honoring `Retry-After` on 429, **semantic caching**,
  **managed-identity** auth to the backend, optional **Content Safety** policy on the
  request path (ties to the moderation task, §5).
- **Caveats baked into the design:**
  - Circuit-breaking needs **APIM Standard/Premium** — Loom already deploys APIM, so
    the tier requirement is met; confirm the running SKU per cloud.
  - **LLM policies must be confirmed available in Gov APIM.** If a policy is absent in
    a Gov region, the client uses **direct-with-managed-identity** automatically (no
    gateway) — same real backend, no feature regression.
- **Client change (later PR):** the unified client points at the APIM gateway base
  URL when `LOOM_AOAI_GATEWAY=apim` (and it's reachable), else direct. Managed
  identity is used on both paths. No mock path.

### 4e. Fix the two bugs (§3f)
- **Bug 1:** upgrade bicep embed deployment to `text-embedding-3-large` (aligns with
  the code default at `aoai-chat-client.ts:368`); keep the honest 404 gate.
- **Bug 2:** replace the hard-coded scope at `help-copilot-orchestrator.ts:61` with
  `cogScope()` so the Help Copilot authenticates in Gov.

*(All of the above are described here as the plan; the edits land in Waves M1–M5.)*

---

## 5. Per-task → model mapping (the "best LLM per task" table)

| Task / surface | Task class | Commercial model | Gov model (resolved) | Tier | Token posture |
|----------------|------------|------------------|----------------------|------|---------------|
| Data-Agents / planners / build-assist / multi-step design | reasoning | **GPT-5.6** `reasoning_effort=high` | GPT-5.1 → GPT-5.2 → gpt-4.1 | strong | large `max_completion_tokens`, high TPM |
| Interactive Copilots (chat panes, per-surface Copilot) | general | **GPT-5.6** / **gpt-5-chat** | gpt-5-chat → gpt-4.1 | standard | medium tokens, low latency |
| Lightweight turns (greetings, short lookups, classification) | lightweight | **gpt-4.1-mini** / gpt-4o-mini | gpt-4.1-mini | mini | small tokens, high volume/cheap |
| High-volume background (labeling, enrichment, RAG pre-pass) | lightweight/general | mini tier | gpt-4.1-mini | mini | small tokens |
| Embeddings (RAG index, semantic search) | — | **text-embedding-3-large** | 3-large → 3-small → ada-002 | n/a | high TPM |
| Moderation / guardrails | — | **Azure AI Content Safety** (prompt shields + filters) | Content Safety (confirm region) | n/a | on request path (via APIM policy or direct) |

The mapping is realized by (a) the deployments §4a creates and (b) the tier config
§4b populates. The classifier already buckets prompts into these classes
(`classifyTaskClass`, `model-tier-router.ts:108-121`); high-effort reasoning turns and
code/query blocks route to `strong` automatically.

---

## 6. Implementation waves

Each wave is its own PR with a **real-data E2E receipt** (`no-vaporware.md`):
a real model call, the real model/version returned, real TPM observed, live in a
deployed boundary. No wave is "done" on DOM/log strings alone (`no_scaffold_claims`).

**M1 — Bug fixes + embed upgrade.**
Fix bug 2 (`help-copilot-orchestrator.ts:61` → `cogScope()`); upgrade the bicep embed
deployment to `text-embedding-3-large` (fixes bug 1). Receipt: Help Copilot answers in
a Gov-scoped token context (no 401); `aoaiEmbed` returns a 3-large vector against the
live deployment (real dimensions, real latency).

**M2 — Model-deployment upgrade + TPM.**
Upgrade `foundry-project.bicep` chat/interactive/mini/strong deployments to the best
Commercial models (§4a); raise TPM ceilings; set per-task-class `max_completion_tokens`
+ `reasoning_effort`. Receipt: a live chat call returns the upgraded frontier model id;
`x-ratelimit` headers show the raised TPM; a reasoning turn shows reasoning tokens
counted.

**M3 — Tier-router CORE wiring.**
Populate `modelTiers.{mini,standard,strong}` + `modelTierTaskMap` in the default tenant
Copilot config at provision time (§4b). Receipt: with NO admin action, a lightweight
prompt lands on the mini deployment and a reasoning prompt lands on strong (router
`routed:true`), verified via the transparency chip + the model id in the response.

**M4 — APIM AI-gateway.**
Add the GenAI gateway to `admin-plane/apim.bicep` (backend pool, `llm-token-limit`,
priority LB, circuit breaker, semantic cache, MI auth, optional Content Safety); route
the unified client through it behind `LOOM_AOAI_GATEWAY=apim` with automatic direct-MI
fallback (§4d). Receipt: a chat call traverses APIM (gateway trace), token-limit policy
enforced, 429 circuit-breaker + Retry-After honored, semantic cache hit on a repeat.

**M5 — Cloud matrix + deploy-time resolution.**
Deploy-time best-model resolution against the availability API with fallback + receipt
(§4c); per-cloud flip in `admin-plane/main.bicep`; confirm Gov APIM LLM-policy presence
and the direct-MI fallback. Receipt: a Gov (or Gov-simulated) deploy resolves the best
**supported** model (never GPT-5.6), records the pick, and the Copilot answers over it.

**M6 — Docs + tests.**
`docs/fiab/model-strategy.md` (catalog, matrix, per-task table, APIM decision,
operator runbook); parity/UX notes for any admin surface touched; unit tests for the
resolver preference/fallback + tier population; env-sync + bicep-sync CI. Receipt:
docs published, tests green, `pnpm uat` covers the tier-transparency surface.

---

## 7. Operator asks / open decisions

- **PTU vs Global-Standard on the hot path (OPEN — operator decides).** Default in this
  plan is **all Global-Standard**. Priority load-balancing (§4d) is designed so a **PTU
  reserved-capacity backend** can be added as the primary with Global-Standard as the
  spillover **if** the operator wants reserved capacity on the Data-Agent/Copilot hot
  path. Needs: which surfaces get PTU, and the committed PTU units per region.
- **Gov AOAI provisioning.** Confirm which GPT-5.x models are actually deployable in the
  target Gov region(s) and whether **Azure AI Content Safety** + **APIM LLM policies**
  are present there. If APIM LLM policies are absent, M5 uses the direct-MI fallback —
  confirm that is acceptable for the Gov boundary.
- **TPM quota headroom** per cloud/region for the raised capacities (§4a) — may need a
  quota increase request before M2/M5 land in some regions.

## 8. Non-goals (v1)

- **No new inference runtime** — Azure OpenAI / Foundry models only; no self-hosted /
  OSS model serving in this initiative (that is a separate track).
- **No hard Fabric / Power BI dependency** introduced — model strategy is entirely
  Azure-native (`no-fabric-dependency.md`).
- **No learned/LLM-based task classifier** — the deterministic `classifyTaskClass`
  heuristic (`model-tier-router.ts`) is sufficient for v1; the forced-`tool_choice`
  learned router (CTS-16 P3) is out of scope here.
- **No per-user model billing/chargeback UI** in this PRP (chargeback exists elsewhere;
  this initiative only ensures the right model rides each task).
- **No prompt-content redesign** — this is model selection + gateway + token posture,
  not a prompt-engineering pass of every agent.
