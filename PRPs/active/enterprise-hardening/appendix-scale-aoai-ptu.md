# Appendix — Scale: AOAI PTU + AI Cost (`scale-aoai-ptu`)

**Domain owner:** Enterprise-hardening PRP (task #45)
**Scope:** Size CSA Loom's Azure OpenAI (AOAI) tier for 100 → 60,000 Copilot users, governed for cost, dual-cloud (Commercial + Azure Government GCC/GCC-High/DoD), day-one-on but capacity/cost-governed, migration-safe behind feature flags.
**Cross-cutting rules honored:** `no-vaporware`, `web3-ui`, `no-freeform-config`, `no-fabric-dependency`, `ui-parity`.

---

## 0. TL;DR — the gap and the shape of the fix

CSA Loom today calls AOAI `chat/completions` from **27 hand-rolled callers** (`grep -rln "chat/completions" lib app` = 27 files), each acquiring its own token via `cogScope()` and hitting `${endpoint}/openai/deployments/${deployment}/chat/completions`. The **only** shared resolution logic is `resolveAoaiTarget()` in `lib/azure/copilot-orchestrator.ts` (endpoint + deployment + apiVersion). There is:

- **No PTU.** The bicep default model is `gpt-4o-mini` / `GlobalStandard` at **10 (thousand TPM) capacity** (`platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep`, `defaultChatModelCapacity int = 10`). 10K TPM serves ~tens of concurrent users, not 60k.
- **No spillover** (PTU→PayGo overflow).
- **No model routing** beyond the docs-vs-build *intent* classifier in `copilot-router.ts` — every request, simple or hard, hits the one `copilotChatDeployment`.
- **No per-domain / per-user token quota or budget.** "No runtime rate-limiter/quota middleware found" — confirmed; there is no `middleware.ts` in `apps/fiab-console`.
- **No semantic cache, no batching.**

The fix is a **single AOAI gateway chokepoint** (`lib/azure/aoai-gateway.ts`) that all 27 callers migrate to behind a flag, plus an **APIM GenAI gateway** in front of AOAI (token-limit + quota + semantic-cache), plus **PTU + spillover bicep**, plus a **Cosmos-backed token-budget ledger** keyed by domain+user for defense-in-depth and chargeback. Gov gets app-layer substitutes for the three Gov-missing features (Model Router, Batch, and — at GA — Spillover).

**Readiness: WEAK.** The consolidation seam (`resolveAoaiTarget`), the multi-domain model (`domain-registry.ts`), chargeback tags, the cost client (`lib/azure/cost-client.ts`), and an APIM editor surface (`lib/editors/apim-editors.tsx`, `lib/components/admin/apim-policies-pane.tsx`) all exist — but nothing ties AOAI throughput, routing, quota, or cost to them.

---

## 1. Sizing AOAI for 60,000 users (the math)

### 1.1 Workload model
Assume the 60k-user upper bound, enterprise Copilot usage:
- Concurrency: ~3% of named users active in any minute at peak = **1,800 concurrent**; ~0.5–1% issuing an inference call in a given second.
- Per call shape (Loom Copilot orchestrator): prompt ~2.5K tokens (system + tool schemas + RAG grounding), completion ~700 tokens → ~3.2K tokens/call effective.
- Peak calls/min ≈ 1,800 active × ~2 calls/min = **3,600 calls/min** → **~11.5M tokens/min** aggregate at the busy-minute peak; sustained business-hours mean ≈ 25–35% of that (~3–4M TPM).

### 1.2 PTU vs PayGo split
- **PTU (reserved floor)** sized to the **sustained business-hours mean** (predictable, latency-sensitive Copilot): use the **Foundry Capacity Calculator** (Foundry portal → Quota → Provisioned tab) with the call shape above. Rule of thumb for gpt-4o-class: ~1 PTU ≈ a few thousand TPM of mixed in/out depending on output ratio — **do not hard-code**; the calculator is authoritative and must be re-run per model/version/region. Plan a **base reservation of ~300–600 PTU** for the 60k tier as the starting hypothesis, then **benchmark with real traffic before purchasing the Azure Reservation** (Learn: "always purchase a reservation *after* deployments are created").
- **PayGo (Standard) spillover** absorbs the bursty peak above the PTU floor (the 11.5M-TPM busy minutes) at per-token rates, so you reserve for the mean, not the peak.
- **PTU deployment type:** **GlobalProvisionedManaged** (Commercial, highest availability) or **DataZoneProvisionedManaged** where US data-zone residency is required. **Gov: `ProvisionedManaged` (regional) is the only PTU type that lists gpt-4o** in usgovvirginia/usgovarizona (Learn "Foundry Models sold by Azure in Azure Government" provisioned table) — Global PTU and Global Standard are **not** in Gov.

### 1.3 Utilization & 429 contract
PTU deployments return **HTTP 429** with `retry-after`/`retry-after-ms` at 100% `Provisioned-managed utilization V2`. The gateway must treat 429 as a *traffic-management signal*, not an error → spillover or routed retry. Target steady-state PTU utilization **70–85%** (headroom for bursts), alert at 90%.

---

## 2. Architecture (in words)

### 2.1 Three enforcement layers (defense in depth)
1. **APIM GenAI gateway (network boundary, primary enforcement).** All AOAI data-plane traffic from the BFF routes through an APIM instance fronting the AOAI endpoint. APIM applies, in order: `llm-token-limit` (TPM ceiling per counter-key = domain or user oid), `quota-by-key` (daily/monthly token quota per domain), `llm-semantic-cache-lookup`/`store` (Redis-backed), `retry` with exponential backoff for 429, and managed-identity auth to the AOAI backend ("Azure AI Service User" / "Cognitive Services OpenAI User"). This is the **native, infra-level boundary** that holds even if app code is bypassed.
2. **AOAI gateway module (app boundary, routing + budget + telemetry).** `lib/azure/aoai-gateway.ts` — the single function `aoaiChat()` every caller uses. It does model **routing** (cheap vs frontier), reads/writes the **Cosmos token-budget ledger** keyed `(domainId, userOid)`, stamps **chargeback dimensions** onto each call, sets the **spillover header**, and emits usage telemetry to Azure Monitor. This is **defense-in-depth + cost attribution**, never the sole boundary.
3. **Per-source TPM on the deployment (last-resort backstop).** A TPM cap set directly on each Standard deployment (bicep) so a runaway never drains the whole regional quota.

### 2.2 Why a chokepoint (not 27 edits forever)
The 27 callers already share `resolveAoaiTarget()`. We extend that seam into a full `aoaiChat({messages, tools, tool_choice, complexity, userOid, domainId, signal})` that returns the parsed completion **plus** usage. Callers migrate **incrementally behind `LOOM_AOAI_GATEWAY=on`** (default off → on per environment). When off, `aoaiChat()` is a thin passthrough to the existing direct-fetch behavior, so the change is reversible and never a big-bang. The `max_tokens→max_completion_tokens` bug (which existed in all 18/27 hand-rolled callers, ref task #36 commit `38e6d5db`) is exactly the class of defect a chokepoint eliminates permanently.

### 2.3 Model routing (cheap vs frontier)
- **Commercial:** prefer the **AOAI Model Router** deployment (a single deployment that auto-selects model by prompt) where available; otherwise an app-layer router in `aoaiChat()` — a `complexity` hint from the caller (e.g. inline-complete = cheap, cross-item orchestrator plan step = frontier) plus the existing `tool_choice` classifier pattern from `copilot-router.ts` picks between `cheapDeployment` (gpt-4o-mini / gpt-4.1-mini) and `frontierDeployment` (gpt-4o / gpt-4.1 / gpt-5.1).
- **Gov:** **Model Router is `No` in Azure Government** (Learn "Microsoft Foundry in Azure Government" feature table). Gov **must** use the app-layer router — the heuristic + classifier path, never the managed router. This is a hard dual-cloud branch.

### 2.4 Semantic cache, batching
- **Semantic cache:** APIM `llm-semantic-cache-lookup/store` backed by **Azure Managed Redis** (RediSearch). High-hit surfaces: help/docs Copilot, `describe-bulk`, inline-complete. Similarity threshold ~0.05, partitioned by domainId so one domain can't read another's cached completions (CLS for the cache).
- **Batching:** the **Batch API** (50% cheaper, async) for bulk non-interactive jobs — `semantic-model/[id]/describe-bulk`, evaluations. **Gov: Batch is NOT supported** (Learn Gov feature table: "Batch Deployments — Not currently supported"). Gov substitute = app-layer concurrency-limited queue (p-limit over the Standard deployment) in `aoai-gateway.ts`.

---

## 3. File-level build spec

### 3.1 New code (Loom ships)
| File | Purpose |
|------|---------|
| `apps/fiab-console/lib/azure/aoai-gateway.ts` | **The chokepoint.** `aoaiChat()` + `aoaiChatStream()`; routing (cheap/frontier), budget check, spillover header `x-ms-spillover-deployment`, usage capture, retry-on-429. Wraps `resolveAoaiTarget()`. Flag `LOOM_AOAI_GATEWAY`. |
| `apps/fiab-console/lib/azure/aoai-token-budget.ts` | Cosmos ledger client: `checkAndReserve(domainId,userOid,estTokens)` → `{allowed, remaining, reason}`; `recordUsage(...)` post-call from `usage.total_tokens`. Container `aoaiUsage`, partition key `/domainId`, autoscale RU. Sliding-window (minute) + rolling (day/month) counters. |
| `apps/fiab-console/lib/azure/aoai-routing.ts` | Pure `pickDeployment(complexity, tenantConfig, cloud)` → deployment name; unit-testable; Gov branch forces app-layer (no Model Router). |
| `apps/fiab-console/app/api/admin/ai-capacity/route.ts` | BFF: GET live PTU utilization (Azure Monitor `Provisioned-managed utilization V2`), deployment list + SKUs, per-domain token spend (from ledger), reservation status. POST: update tenant AOAI capacity config (Cosmos). Real backend per `no-vaporware`. |
| `apps/fiab-console/app/api/admin/ai-capacity/domains/[id]/budget/route.ts` | GET/PUT per-domain token budget + enable flag. |
| `apps/fiab-console/lib/components/admin/ai-capacity-pane.tsx` | **Web-5.0 UI** (Fluent v9 + Loom tokens, `TileGrid`, `EmptyState`): PTU utilization gauge, spillover %, per-domain spend cards, budget wizard (sliders/dropdowns — **no free-form JSON** per `no-freeform-config`), reservation-status MessageBar honest-gate. |
| `apps/fiab-console/lib/copilot/capacity-tools.ts` | Copilot build-assist tools: "size my PTU for N users", "show domains over budget", "enable spillover" — calls the BFF, never fakes numbers. |

### 3.2 Edits (extend existing seams)
| File | Edit |
|------|------|
| `lib/azure/copilot-orchestrator.ts` | Export `aoaiChat` usage from `resolveAoaiTarget`; orchestrator's own chat call goes through the gateway when flag on. |
| `lib/azure/copilot-router.ts` | `classifyIntent` already a "cheap router" call — route it to `pickDeployment('cheap')`; keep graceful build-fallback. |
| `lib/types/copilot-config.ts` | Add `cheapDeployment?`, `frontierDeployment?`, `spilloverDeployment?`, `modelRouterDeployment?`, `semanticCacheEnabled?` to `TenantCopilotConfig`. |
| `lib/types/tenant-settings.ts` | Add `ai.capacity.*` toggles (scopable to `domain`): `ai.capacity.perDomainBudget` (numericParam tokens/day), `ai.capacity.spillover`, `ai.capacity.semanticCache`, `ai.capacity.modelRouting`. Reuse existing `ToggleScope='domain'`. |
| The 27 `chat/completions` callers | Migrate to `aoaiChat()` in waves (see §6). Behind the flag, mechanical. |
| `platform/fiab/bicep/modules/admin-plane/ai-foundry.bicep` | Parameterize for PTU (below). |
| `platform/fiab/bicep/modules/admin-plane/main.bicep` | Pass new params; add APIM GenAI gateway module ref + env vars to the `apps[]` list (`LOOM_AOAI_GATEWAY`, `LOOM_AOAI_APIM_ENDPOINT`, `LOOM_AOAI_CHEAP_DEPLOYMENT`, `LOOM_AOAI_FRONTIER_DEPLOYMENT`, `LOOM_AOAI_SPILLOVER_DEPLOYMENT`). |

### 3.3 Bicep — PTU + spillover deployments
In `ai-foundry.bicep`, add alongside `defaultChatDeployment`:

```bicep
@description('Provision a PTU (provisioned-managed) chat deployment for predictable Copilot load. Commercial: GlobalProvisionedManaged/DataZoneProvisionedManaged; Gov: ProvisionedManaged (regional) only.')
param deployPtuChat bool = false
@description('PTU deployment SKU name. Commercial=GlobalProvisionedManaged | DataZoneProvisionedManaged; Gov=ProvisionedManaged.')
param ptuChatSkuName string = 'GlobalProvisionedManaged'
@description('PTU count (capacity). MUST come from the Foundry Capacity Calculator + benchmark. 0 disables.')
@minValue(0)
param ptuChatCapacity int = 0
@description('Frontier model for the PTU deployment (gpt-4o is the only gpt-4o-class model with Gov PTU).')
param ptuChatModelName string = 'gpt-4o'
param ptuChatModelVersion string = '2024-11-20'

resource ptuChatDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = if (deployPtuChat && ptuChatCapacity > 0) {
  parent: aiServices
  name: 'gpt-4o-ptu'
  sku: { name: ptuChatSkuName, capacity: ptuChatCapacity }
  properties: {
    model: { format: 'OpenAI', name: ptuChatModelName, version: ptuChatModelVersion }
    // Commercial-only: auto-spill to the Standard deployment on 429/400/500/503.
    // Gov: leave unset (Spillover is Preview, gov support not GA) → app-layer fallback in aoai-gateway.ts.
    spilloverDeploymentName: (deploySpilloverStandard && !isGov) ? spilloverStandardDeployment.name : null
  }
}

@description('Standard (PayGo) deployment used as the spillover target / app-layer overflow.')
param deploySpilloverStandard bool = false
resource spilloverStandardDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = if (deploySpilloverStandard) {
  parent: aiServices
  name: 'gpt-4o-paygo-spillover'
  sku: { name: isGov ? 'Standard' : 'GlobalStandard', capacity: spilloverCapacityTpm }
  properties: { model: { format: 'OpenAI', name: 'gpt-4o', version: '2024-11-20' } }
}
```
Note: `spilloverDeploymentName` requires the standard deployment in the **same** AOAI resource and the **same data-processing level** as the PTU deployment (Learn spillover prerequisites). The bicep `model.version` and SKU couplings above respect the Gov provisioned table (gpt-4o only).

Also raise `defaultChatModelCapacity` guidance: the 10K-TPM default is a *day-one smoke* value; the per-domain enable layer (below) is what keeps 60k affordable — not a single fat Standard deployment.

---

## 4. Dual-cloud matrix (Commercial vs Government)

| Capability | Commercial | Azure Government (GCC-High / IL5 / DoD) |
|---|---|---|
| AOAI data-plane host | `*.openai.azure.com` | `*.openai.azure.us` (already handled by `getOpenAiSuffix()` in `cloud-endpoints.ts`) |
| Token audience (`cogScope()`) | `cognitiveservices.azure.com/.default` | `cognitiveservices.azure.us/.default` (already branched) |
| Entra authority | `login.microsoftonline.com` | `login.microsoftonline.us` |
| Foundry portal (runbook links) | `ai.azure.com` | `ai.azure.us` / `aoai.azure.us` / `portal.azure.us` |
| PTU deployment type | GlobalProvisionedManaged / DataZoneProvisionedManaged | **ProvisionedManaged (regional) only**, gpt-4o only, usgovvirginia/usgovarizona |
| **Model Router** | Available (managed) | **NOT available** → app-layer router in `aoai-routing.ts` is mandatory |
| **Spillover** | GA-ish (Preview→use it) | Preview / not GA in Gov → **app-layer 429-retry-to-Standard** in `aoai-gateway.ts` |
| **Batch API** | Available (50% cheaper async) | **NOT supported** → app-layer p-limit queue |
| Semantic-cache Redis | Azure Managed Redis (RediSearch) | Azure Cache for Redis Enterprise where available; **OSS substitute**: Redis Stack on ACA/AKS in-VNet if Managed Redis absent in region |
| Networking | Private Endpoint optional | **Private-only + CMK** (IL5): AOAI behind PE, APIM internal VNet, NSP; CMK enabled even though Gov AOAI stores no data at rest today (future-proof per Learn Gov data-storage note) |
| Abuse monitoring | Default | Reduced in Gov; content filters still default-on; modified filters via `aka.ms/AOAIGovModifyContentFilter` |

All cloud branches key off the **existing** `isGovCloud()` / `LOOM_CLOUD` plumbing — no new cloud-detection logic.

---

## 5. Code vs Tenant-Admin action (runbook)

**Loom ships (code):** `aoai-gateway.ts`, routing, token-budget ledger, the admin BFF + Web-5.0 pane, the Copilot capacity tools, bicep params, APIM policy templates, the app-layer Gov substitutes (router/spillover/batch), and the honest in-product gates.

**Tenant admin / operator must do (runbook — surfaced as an in-product `MessageBar intent="warning"` gate per `no-vaporware`):**
1. **Request PTU quota** in the target region (Foundry portal → Quotas → "Request Quota"). Gov: submit at `aka.ms/AOAIGovQuota`. *Gate text:* "PTU quota not yet granted in <region>. Request it, then set `ptuChatCapacity`."
2. **Create the PTU deployment FIRST, then purchase the Azure Reservation** (Learn best practice) — Reservation purchase needs **Owner or Reservation Purchaser** role, *different* from deployment roles. Reservations are non-interchangeable across Global/DataZone/Regional. *Gate:* "PTU deployed but no Reservation — running at hourly rate."
3. **Run the Capacity Calculator + benchmark** with real traffic before committing reservation size.
4. **Deploy/scope APIM** in front of AOAI; grant APIM managed identity **Cognitive Services OpenAI User** on the AOAI account.
5. **Provision the semantic-cache Redis** (or approve the OSS Redis Stack ACA app in Gov).
6. **Grant the Console UAMI** Monitoring Reader on the AOAI resource so the capacity pane can read `Provisioned-managed utilization V2`.

Each is an **honest Azure/admin gate**, never a Fabric dependency — consistent with `no-fabric-dependency`.

---

## 6. Migration plan (incremental, reversible)

- **Phase 0 (flag off, no behavior change):** land `aoai-gateway.ts` as a passthrough; add `LOOM_AOAI_GATEWAY=off` to env. Ship ledger + admin pane read-only (observe-only, no enforcement). *Reversible: delete the flag.*
- **Phase 1 (routing, soft):** flag on in one environment; route `copilot-router.classifyIntent` + inline-complete to `cheapDeployment`. Measure cost delta. Budget ledger in **shadow mode** (record, don't block).
- **Phase 2 (APIM front door):** point BFF AOAI calls at `LOOM_AOAI_APIM_ENDPOINT`; enable `llm-token-limit` + semantic-cache in **log-only** then enforcing. Keep direct-AOAI as fallback env.
- **Phase 3 (PTU + spillover):** deploy PTU (`deployPtuChat=true`), enable spillover (Commercial) / app-layer fallback (Gov). Cut over the frontier deployment to PTU.
- **Phase 4 (enforce budgets per-domain):** flip ledger to enforcing; per-domain enable + budgets via the wizard. Day-one-on preserved — every domain starts enabled with a generous default budget; admins *tighten*, they don't *unlock*.

Every phase is gated by one flag/param and reverts cleanly. Migrate the 27 callers in waves grouped by surface (foundry/* routes, items/* assist routes, copilot/* routes) — each wave is an independent PR with a real-data E2E receipt.

---

## 7. Acceptance criteria (per `no-vaporware`)

1. With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, Copilot answers on the Azure-native PTU+spillover path — receipt shows `x-ms-deployment-name` (PTU) and, under load, `x-ms-spillover-from-deployment` (PayGo).
2. Admin capacity pane shows **real** `Provisioned-managed utilization V2` from Azure Monitor and **real** per-domain token spend from the ledger (no mock arrays).
3. A domain exceeding its daily token budget gets a Fluent `MessageBar` (CLS-safe, no other domain's data) and a 429-style honest block — not a crash.
4. Gov build: no call to a Model Router deployment, no Batch API call, no `spilloverDeploymentName` set; app-layer substitutes verified active via unit tests in `aoai-routing.test.ts`.
5. `az deployment sub create` with `deployPtuChat=true ptuChatCapacity=<calc>` produces a working PTU deployment + spillover Standard in one shot (bicep-synced).
6. Cost delta measured: cheap-routing + semantic cache reduce total tokens ≥30% on the help/inline surfaces.

---

## 8. Sources (MS Learn)

- What is provisioned throughput / PTU + deployment types — learn.microsoft.com/azure/foundry/openai/concepts/provisioned-throughput
- PTU billing, reservations, sizing (purchase after deploy; non-interchangeable) — .../openai/concepts/provisioned-throughput-billing; .../how-to/provisioned-throughput-onboarding; .../how-to/provisioned-throughput-sizing
- Operate provisioned deployments / 429 + utilization + capacity calculator — .../openai/how-to/provisioned-get-started
- Spillover (preview; prerequisites; headers; per-request `x-ms-spillover-deployment`) — .../openai/how-to/spillover-traffic-management
- AI gateway in APIM (token limit, quota, semantic cache, scaling) — learn.microsoft.com/azure/api-management/genai-gateway-capabilities; llm-token-limit-policy; llm-semantic-cache-store/lookup-policy; azure-openai-enable-semantic-caching
- GenAI gateway reference architecture (APIM + AOAI, retries, MI auth) — learn.microsoft.com/ai/playbook/solutions/genai-gateway/reference-architectures/apim-based
- Azure OpenAI / Foundry in Azure Government (endpoints, Model Router=No, Batch=No, regions, CMK, provisioned gpt-4o only) — learn.microsoft.com/azure/ai-foundry/openai/azure-government; .../azure/foundry/concepts/foundry-azure-government; .../foundry/foundry-models/concepts/models-sold-directly-by-azure-gov
