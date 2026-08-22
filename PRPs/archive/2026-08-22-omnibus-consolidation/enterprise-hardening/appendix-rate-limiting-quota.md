# Enterprise-Hardening Appendix — Runtime Rate-Limiting / Quota / Fair-Use

**Domain:** `rate-limiting-quota` · **App:** `apps/fiab-console` (Next.js BFF on Azure Container Apps)
**Scale target:** 100 → 60,000 users · **Clouds:** Commercial + Azure Government (GCC / GCC-High / IL4-5)
**Readiness verdict:** **ABSENT** — there is **no runtime rate-limiter, quota engine, or fair-use middleware anywhere in the BFF.** Front Door WAF exists but carries **no** rate-limit rule. AOAI is hand-rolled across ~18 call sites with **zero** token accounting. This is the single largest availability + cost-runaway gap for a 60k-user regulated tenant.

---

## 1. Current-state assessment (grounded in the code)

| Area | Observed fact (file) | Implication |
|---|---|---|
| Edge / WAF | `front-door.bicep` provisions **Front Door Premium** + WAF (`Microsoft_DefaultRuleSet 2.1` + `Microsoft_BotManagerRuleSet`), `requestBodyCheck: Disabled`, one custom **Allow** rule for git paths. **No `RateLimitRule`.** | Brute-force / credential-stuffing / API-abuse / L7-DoS reach the origin unthrottled. The cheapest, highest-leverage win is one WAF rate-limit custom rule. |
| App middleware | **No `apps/fiab-console/middleware.ts` exists.** All **1,118** `app/api/**/route.ts` handlers gate auth ad-hoc via `getSession()` (e.g. `app/api/foundry/chat/route.ts`). No shared request wrapper, no limiter. | There is no chokepoint today; we must add one. Two insertion points: a Node-runtime `middleware.ts` (global) and a `withRateLimit()` route helper (fine-grained, migration-safe). |
| Distributed counter | No Redis in the **console** path. `lib/azure/cosmos-client.ts` is the only shared state store (Console UAMI, `mk()` lazy `createIfNotExists`, ~60 containers). A **deploy-planner** `redis.bicep` template exists (`main.bicep` `redisEnabled`, default `false`) but it is a *catalog* item, **not wired to the console**. | We need a real distributed counter. Cosmos on the hot path self-throttles (429 at RU limit — see `optimize-cost-throughput`). Redis is the correct hot-path store; Cosmos becomes the durable reconciliation/chargeback tier. |
| AOAI accounting | AOAI chat-completions is hand-rolled in ~18 routes/clients (`foundry-cs-client.ts`, `copilot-orchestrator.ts`, `data-agent-client.ts`, `help-copilot-orchestrator.ts`, `ai-functions-client.ts`, plus per-item `assist`/`copilot` routes). `app/api/foundry/chat/route.ts` passes `maxTokens` straight through. **No TPM/RPM budget, no `usage` capture, no `x-ratelimit-*` / `retry-after-ms` handling.** | A single noisy domain can exhaust shared AOAI TPM and 429 every other domain. Token-budget enforcement + a shared AOAI fetch chokepoint are required. |
| Identity / scope keys | `lib/auth/session.ts` — AES-256-GCM cookie carrying `claims` (`oid`, `upn`, `groups`, `tid`), 8h. **Decoded with Node `crypto` → NOT edge-runtime safe.** | The limiter must run in **Node runtime** to read the session. Drives the choice of a Node `middleware.ts` and/or route helpers (both Node). |
| Multi-domain model | `lib/azure/domain-registry.ts` (`DomainItem`: `capacitySku` F2–F512, `costCenter`, `chargebackTag`, `adminGroupId`/`memberGroupId`, `subscriptionIds`), `lib/auth/domain-role.ts` (tiers: `tenant-admin` → `domain-admin` → `domain-contributor`, Entra-group resolution with Graph overage fallback). | A real per-domain config + RBAC surface already exists. Rate-limit policy attaches cleanly to `DomainItem` and reuses `resolveDomainTier()` for admin gating. Capacity SKU is the natural cost-governed default-tier key. |
| Cosmos throughput admin | `cosmos-client.ts` already has `listContainerThroughput()` / `updateContainerThroughput()` (manual/autoscale/serverless). `/admin/capacity/page.tsx` renders live ARM inventory + cost + Monitor charts. | Reuse the AdminShell/TileGrid/MetricChart patterns + the throughput admin plumbing for the new `/admin/rate-limits` surface. |
| Runtime topology | ACA, single region `centralus`, Front Door Premium → Private Link → internal ACA ingress. HTTP concurrency scale rule (KEDA) ⇒ **multiple replicas**. | An in-process counter is wrong across replicas (each replica sees only its own traffic). Confirms the need for a **shared** (Redis) counter; in-memory is only a degraded fallback. |

**Conclusion:** every primitive we need to *attach to* exists (domain registry, tiers, capacity SKUs, chargeback tags, Cosmos admin, Front Door WAF, AdminShell UI kit). What is missing is the entire enforcement layer. We build it as an additive, feature-flagged module — no rewrite of the 1,118 routes.

---

## 2. Target architecture (in words)

Three enforcement tiers, defense-in-depth, each independently shippable:

**Tier 1 — Edge (Front Door WAF custom RateLimitRule).** Per-**socket-IP** coarse cap at the global edge, before traffic reaches ACA. Blocks volumetric abuse, credential stuffing, and accidental client storms. Two rules: a broad `/*` cap (5-minute window, recommended per `application-ddos-protection`) and a tighter cap on expensive paths (`/api/*/copilot`, `/api/*/assist`, `/api/foundry/chat`, `/api/*/export`). This is the only tier that protects *unauthenticated* surfaces and is pure infra (no app risk). Grounded in `waf-front-door-rate-limit` / `waf-front-door-rate-limit-configure`. **Limitation:** WAF groups by IP only — it cannot see user/domain identity, so it is a blunt safety net, not fair-use. In Gov where AFD Std/Premium rate-limit is constrained, use **Application Gateway WAF v2** RateLimit custom rules (`rate-limiting-configure`) — `app-gateway.bicep` already exists.

**Tier 2 — App middleware / route guard (per-user / per-workspace / per-domain).** The fair-use core. For each authenticated request the BFF resolves the caller's **scope keys** (`tenantId`, `oid`, active `workspaceId`, resolved `domainId`, `tier`) and a **route class** (read / write / query / copilot / export / provision), then evaluates a **token-bucket** (smooth) + **sliding-window** (burst) limiter in **Redis** via an atomic Lua script. On breach it returns **HTTP 429** with `Retry-After` (seconds) + `RateLimit-*` headers (draft-IETF style) + a structured body `{ ok:false, error:'rate_limited', scope, retryAfterMs, limit, remaining }`. Also enforces **concurrent-request / concurrent-query** ceilings (a Redis counter incremented on entry, decremented in `finally`). Multi-replica-safe because the counter is shared.

**Tier 3 — Resource-call accounting + durable quota (AOAI tokens, export rows, provision ops).** A thin chokepoint wraps the expensive backends. For **AOAI**: pre-call we charge an *estimate* (`prompt_tokens_est + max_tokens`) against the domain's TPM bucket (mirrors how AOAI itself estimates — `quota#understanding-rate-limits`); post-call we reconcile with the real `response.usage.total_tokens` and surface upstream `x-ratelimit-remaining-*` / honor `retry-after-ms`. For **exports** we charge `rowCount`; for **provision ops** we charge 1 against a daily ceiling. Hot-path counters live in Redis; **durable monthly counters** (for quota + chargeback) live in a new Cosmos container, incremented atomically off the hot path.

**Distributed counter substrate.** **Azure Managed Redis** (Commercial) / **Azure Cache for Redis** (Gov), **Entra-auth only** (Console UAMI granted the Redis *Data Owner* access policy — no keys), TLS 1.2+, **private endpoint** (IL4/5 private-only), optional **CMK**. The token bucket is one `EVALSHA` round trip (~sub-ms). Keyspace is bounded by *active* scope keys with TTL = window, so even 60k users cost a few hundred MB.

**Graceful degradation.** If Redis is unreachable, the guard runs a **per-replica in-memory approximate limiter** and emits a `ratelimit_degraded` telemetry event. Default posture is **fail-open** for read/query/copilot (availability > perfect fairness) and **fail-closed** for **provision** and **export** (cost/safety-critical). Posture is per-class and configurable. When `LOOM_RATELIMIT_REDIS_HOST` is unset the whole tier is a no-op + an honest `/admin/rate-limits` MessageBar naming the env var and the bicep module — never a blank or broken surface (`no-vaporware.md`).

**Cost-governed, day-one-on.** Limits stay *enabled by default* but are **derived from the domain's capacity SKU** (F2…F512) so a small domain can't run up a 60k-user bill, and an admin can raise a specific domain's ceiling per the chargeback budget. This preserves "everything on, user can disable" while adding the affordability layer.

```
Client ─▶ Front Door Premium (WAF: managed DRS + BotManager + NEW RateLimitRule/IP)
            │  (Private Link)
            ▼
        ACA ingress ─▶ Next middleware.ts (Node) ──▶ withRateLimit() route guard
                                  │                         │
                                  │   resolve scope+class   │ EVALSHA token-bucket
                                  ▼                         ▼
                         lib/ratelimit/policy.ts     Azure Managed Redis (Entra-auth, PE)
                                  │                         │ (hot path: ~sub-ms)
                                  ▼                         ▼
                       AOAI/export/provision        Cosmos rate-quota (durable monthly + chargeback)
                       chokepoint accounting         + Log Analytics (429 + degrade telemetry)
```

---

## 3. File-level build spec (CODE Loom ships)

### 3.1 New module `apps/fiab-console/lib/ratelimit/`

- **`redis-client.ts`** — Managed-Redis singleton. `ioredis` (TLS) with an Entra **token provider** using the same `credential()` chain as `cosmos-client.ts` (`AcaManagedIdentityCredential` → `ManagedIdentityCredential({clientId: LOOM_UAMI_CLIENT_ID})` → `DefaultAzureCredential`); scope `https://redis.azure.com/.default`. Host from `LOOM_RATELIMIT_REDIS_HOST`. **Cloud-aware:** accept full host (`*.redis.cache.windows.net` Commercial / `*.redis.cache.usgovcloudapi.net` Gov / Managed Redis `*.<region>.redis.azure.net`). Token auto-refresh (re-AUTH on expiry), `enableOfflineQueue:false`, connect timeout, lazy connect. Export `getRedis()` and `isRedisHealthy()`.
- **`token-bucket.lua`** + **`token-bucket.ts`** — atomic limiter. Lua does: read bucket `{tokens, ts}`, refill `tokens = min(burst, tokens + (now-ts)*ratePerMs)`, if `tokens >= weight` decrement+allow else deny; set key TTL = window. Returns `{allowed, remaining, resetMs, retryAfterMs}`. A second script `sliding-window.lua` (sorted-set ZADD/ZREMRANGEBYSCORE/ZCARD) for strict RPM. Concurrency helper `acquire()/release()` via `INCR`/`DECR` with a safety TTL.
- **`limits-config.ts`** — types + defaults. `RouteClass = 'read'|'write'|'query'|'copilot'|'export'|'provision'`. `ScopeLevel = 'user'|'workspace'|'domain'|'tenant'`. `LimitSpec { rpm, burst, concurrent, aoaiTpm, exportRowsPerDay, provisionOpsPerDay }`. **`DEFAULTS_BY_CAPACITY: Record<CapacitySku, LimitSpec>`** (table below). `ENABLED_CLASSES`, `FAIL_POSTURE: Record<RouteClass,'open'|'closed'>`.
- **`policy.ts`** — `resolveScope(session, req)` → `{ tenantId, oid, workspaceId, domainId, tier }` (domain via `loadOrSeedDomains` + `resolveDomainTier`; workspace from path/`x-loom-workspace` header). `effectiveLimits(scope)` merges: capacity-SKU default ← tenant override ← per-domain override ← per-user override. `classifyRoute(pathname, method)` → `RouteClass`.
- **`guard.ts`** — `withRateLimit(req, {class, weight?, scopeLevels?}, handler)` and a bare `enforce(req, opts): Promise<NextResponse|null>` (null = allowed). Builds keys `rl:{level}:{class}:{id}:{windowBucket}`, evaluates buckets for each scope level (user → workspace → domain → tenant), returns the **first** breach as 429 with `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`. Emits `ratelimit_block` telemetry. Respects `LOOM_RATELIMIT_MODE` (`off|observe|enforce`).
- **`aoai-accounting.ts`** — `chargeAoai(scope, estTokens)` (pre) + `reconcileAoai(scope, actualTokens, upstreamHeaders)` (post). Charges the domain TPM bucket; if upstream returns 429, parse `retry-after-ms` and propagate. `estimatePromptTokens(messages)` (chars/4 heuristic + `max_tokens`).
- **`aoai-fetch.ts`** — **shared AOAI chokepoint**. One `aoaiChatCompletion(deployment, messages, opts, scope)` that all clients migrate onto incrementally. Wraps the existing data-plane call, injects accounting, normalizes `max_completion_tokens`, captures `usage`. Behind `LOOM_RATELIMIT_AOAI_CHOKEPOINT=1`.
- **`cosmos-quota.ts`** — durable counters. `incrQuota(scopeKey, class, amount)` via Cosmos **Patch** atomic `incr` on doc `quota:{period}:{tenantId}:{domainId}` (PK `/scopeKey`, scopeKey = `${tenantId}:${domainId}` to **avoid a hot single-tenant partition** at 60k). `readQuota(scopeKey, period)`. Period = `YYYY-MM` (monthly) + `YYYY-MM-DD` (daily). Off hot path (fire-and-forget with retry).
- **`telemetry.ts`** — `emit(event, dims)` → structured log line (picked up by Log Analytics / App Insights) with `tenantId/domainId/class/scopeLevel/decision`. Counters for the `/admin/rate-limits/usage` query.

### 3.2 Edge insertion — `apps/fiab-console/middleware.ts` (NEW)

Node-runtime middleware (`export const config = { matcher: ['/api/:path*'], runtime: 'nodejs' }`; exclude `/api/health`, `/api/version`, `/api/auth/*`). Decodes the session cookie (Node crypto OK), runs `enforce()` for a **coarse per-user RPM** guard only (cheap, global). Fine-grained per-class/per-resource limits stay in the route helper so they can be rolled out path-by-path. If Node middleware is not desired initially, ship the helper alone — middleware is additive.

### 3.3 Route adoption (incremental, flagged)

Wrap the **hot/expensive** routes first via `withRateLimit`:
- `app/api/foundry/chat/route.ts`, `app/api/copilot/**`, `app/api/items/*/[id]/{assist,copilot,tile-query,describe-bulk}/route.ts` → class `copilot`.
- `app/api/**/export/**`, report/paginated export routes → class `export` (weight = rows).
- `app/api/apps/[id]/install`, provisioner-invoking routes → class `provision` (fail-closed).
- generic `app/api/items/**` GET → `read`, mutating → `write`/`query`.
No bulk edit of 1,118 routes — an allowlist env (`LOOM_RATELIMIT_ENFORCE_ROUTES`) plus the global middleware covers the long tail.

### 3.4 Cosmos wiring — edit `lib/azure/cosmos-client.ts`

Add two containers in `ensure()` via `mk()`:
- `rate-limit-config` PK `/tenantId` (durable desired limit config; Redis is the cache).
- `rate-quota` PK `/scopeKey` (monthly/daily durable counters + chargeback).
Add accessors `rateLimitConfigContainer()` / `rateQuotaContainer()` and both ids to `KNOWN_CONTAINER_IDS` so they show in the throughput admin.

### 3.5 API routes (NEW)

- `app/api/admin/rate-limits/route.ts` — `GET` effective config (capacity defaults + overrides) for tenant + each domain; `PUT` upsert tenant/per-domain/per-user overrides. Gated: `isTenantAdminTier` for tenant scope, `resolveDomainTier === 'domain-admin'` for that domain's override (reuse `domain-role.ts`). Writes `rate-limit-config` + busts the Redis config cache.
- `app/api/admin/rate-limits/usage/route.ts` — `GET` live usage (Redis bucket reads) + 429 stats (Log Analytics query via existing `monitor-client.ts`), per domain/class.
- `app/api/me/quota/route.ts` — `GET` the caller's own remaining tokens/rows/ops vs limits (drives the in-product banner).

### 3.6 Web-5.0 UI (NEW, Loom design tokens — `web3-ui.md`)

- `app/admin/rate-limits/page.tsx` — `AdminShell` + `TileGrid` of **per-domain cards** (icon chip from `domain-registry`, capacity-SKU badge, chargeback tag), each opening a Drawer **wizard**: sliders/Spinbuttons (bound to `tokens.spacing*`, no raw px) for RPM / concurrent / AOAI TPM / export rows / provision ops, with the capacity-SKU default shown as the baseline and a "reset to default" affordance. Live usage gauges via `MetricChart`. Honest MessageBar gate when Redis unset. **No free-form/JSON** config (`loom_no_freeform_config`) — all dropdowns/sliders.
- `lib/components/ratelimit/quota-banner.tsx` — Fluent `MessageBar intent="warning"` shown near/over quota: "Your domain has used 92% of its monthly Copilot token budget (raise it in Admin → Rate limits, or it resets on <date>)." Reads `/api/me/quota`.
- `lib/copilot/ratelimit-tools.ts` — Ops-Copilot tool so an admin can say "raise Finance domain Copilot tokens to 2M/month" → calls the PUT route (tier-gated).

### 3.7 Bicep (admin-plane)

- **`platform/fiab/bicep/modules/admin-plane/redis-ratelimit.bicep` (NEW)** — `Microsoft.Cache/redis` (Commercial: Managed Redis *Balanced* or Standard `C1`; Gov: `Premium P1` since Managed-Redis-Enterprise is **not** in Gov), `minimumTlsVersion:'1.2'`, `publicNetworkAccess:'Disabled'`, **Entra auth** `redisConfiguration: { 'aad-enabled':'true' }`, an **access policy assignment** granting the Console UAMI `Data Owner`, a **private endpoint** into the admin-plane VNet + private DNS, optional CMK for IL5. Outputs `redisHostName`.
- **Edit `admin-plane/main.bicep`** — instantiate `redis-ratelimit` when `rateLimitEnabled`; add env vars to the `loom-console` container app: `LOOM_RATELIMIT_ENABLED`, `LOOM_RATELIMIT_MODE`, `LOOM_RATELIMIT_REDIS_HOST`, `LOOM_RATELIMIT_AOAI_CHOKEPOINT`, `LOOM_RATELIMIT_ENFORCE_ROUTES` (per `no-vaporware.md` bicep-sync env rule).
- **Edit `admin-plane/front-door.bicep`** — add `customRules` `RateLimitRule`s **before** managed rules: priority 50 broad `/*` cap (`rateLimitDurationInMinutes:5`, `rateLimitThreshold` tuned via the Log-Analytics threshold query in `application-ddos-protection`), priority 60 tighter cap on `RequestUri Contains /copilot|/assist|/foundry/chat|/export`, grouped by socket IP, `action:'Block'`. Keep the existing git Allow rule at priority 100.
- **Edit `platform/fiab/bicep/main.bicep`** + `params/{commercial-full,gcc-high,il5}.bicepparam` — `rateLimitEnabled`, Redis SKU/family, FD-vs-AppGW rate-limit selector.

### 3.8 Default limits by capacity SKU (cost-governed, day-one-on)

Starting defaults (admin-tunable); sized so a 60k-user F512 domain has headroom while an F2 dev domain can't run away. Per **domain**, per **minute** unless noted.

| Capacity | user RPM | user concurrent | domain AOAI TPM | domain copilot tok/mo | export rows/day | provision ops/day |
|---|---|---|---|---|---|---|
| F2 | 60 | 4 | 20k | 2M | 100k | 20 |
| F4 | 120 | 6 | 40k | 5M | 250k | 40 |
| F8 | 240 | 8 | 80k | 10M | 500k | 80 |
| F32 | 480 | 12 | 200k | 40M | 2M | 200 |
| F64 | 600 | 16 | 400k | 80M | 5M | 400 |
| F128 | 900 | 24 | 800k | 160M | 10M | 800 |
| F512 | 1500 | 32 | 2M | 600M | 50M | 2000 |

---

## 4. Commercial vs Azure Government

| Concern | Commercial | Azure Government (GCC / GCC-High / IL4-5) |
|---|---|---|
| Redis host | `*.redis.cache.windows.net` or Managed Redis `*.redis.azure.net` | `*.redis.cache.usgovcloudapi.net` (`cache-planning-faq`). **Managed Redis Enterprise tier is Public-only** → use **Premium P-family classic** (geo-replication available on Premium). |
| Redis auth | Entra token scope `https://redis.azure.com/.default` | same; UAMI under Gov Entra. |
| Entra authority | `login.microsoftonline.com` | `login.microsoftonline.us` (`authentication-national-cloud`). Already handled by `lib/auth/msal.ts` cloud config. |
| AOAI | global/data-zone, raise TPM in portal / `aka.ms/oai/stuquotarequest` | `usgovvirginia` / `usgovarizona`, `ai.azure.us`, quota via **`aka.ms/AOAIGovQuota`** (`openai/azure-government`). Model router unavailable → simpler routing. |
| Cosmos | `documents.azure.com` | `documents.azure.us` (`compare-azure-government`). |
| Edge rate-limit | **Front Door Premium WAF RateLimitRule** | If AFD Std/Premium WAF rate-limit is constrained in the target Gov region, enforce at **Application Gateway WAF v2** (`rate-limiting-configure`) — `app-gateway.bicep` already present. App-tier (Tier 2/3) is identical. |
| IL4/5 | PE optional | **PE mandatory** (publicNetworkAccess Disabled) on Redis + Cosmos; **CMK**; no public counter store; all telemetry to in-boundary Log Analytics. |

All cloud suffixes resolve from the existing cloud-endpoints resolver — **no hard-coded `.com`** in the new module (the resolver pattern is already used across `lib/azure`).

---

## 5. CODE vs TENANT-ADMIN action

**CODE (Loom ships):** the `lib/ratelimit/*` module, `middleware.ts`, route guards, the 3 API routes, the `/admin/rate-limits` UI + Copilot tool, the 2 Cosmos containers, `redis-ratelimit.bicep` + main/front-door/params edits, defaults, telemetry, tests.

**TENANT-ADMIN / Azure action (runbook — honest in-product gate when unmet):**
1. **Deploy Redis** — set `rateLimitEnabled=true` (cost decision: ~$ for Standard/Premium). Until then the tier is a no-op + MessageBar.
2. **Approve Redis private endpoint** (IL4/5) — one-time portal approve (same pattern as the FD→ACA PE auto-approve script; we provide an equivalent `deploymentScript`).
3. **Grant Console UAMI the Redis `Data Owner` access policy** — done by bicep; runbook covers the manual fallback.
4. **AOAI quota is an Azure ceiling Loom cannot raise** — operator requests TPM via portal / `aka.ms/AOAIGovQuota`, sets per-deployment TPM, and (for predictable 60k load) considers **PTU**. Loom's per-domain TPM budgets must sum to ≤ the deployment TPM; the UI warns if over-subscribed.
5. **Front Door WAF rate-limit thresholds** — operator tunes via the Log-Analytics threshold query before flipping to Block (we ship the query).

---

## 6. Incremental, reversible migration (feature-flagged)

| Phase | Action | Flag / rollback |
|---|---|---|
| 0 | Ship module + Redis + containers + UI in **observe** mode — count + log, never 429. Validate counters vs reality. | `LOOM_RATELIMIT_MODE=observe`; rollback `=off`. |
| 1 | Enable **Front Door WAF** rate-limit rule in **Detection**, tune threshold from logs, then **Prevention**. Pure infra, independent of app. | Remove the `RateLimitRule` from `front-door.bicep`. |
| 2 | Enforce **per-user RPM + concurrent** on the hot copilot/export routes via the allowlist. | `LOOM_RATELIMIT_MODE=enforce` + `LOOM_RATELIMIT_ENFORCE_ROUTES` allowlist; drop routes to revert. |
| 3 | Turn on the **AOAI chokepoint** (observe → enforce TPM per domain). | `LOOM_RATELIMIT_AOAI_CHOKEPOINT=1`; unset to revert (clients keep their direct path). |
| 4 | GA **durable monthly quotas + chargeback + admin UI**; enable Node `middleware.ts` global guard. | Disable middleware matcher; quotas degrade to observe. |

Default posture is **fail-open** (availability first) for read/query/copilot and **fail-closed** for provision/export, so a Redis outage never bricks the console. Every phase is independently revertible; nothing is a big-bang and no identity model changes.

---

## 7. Scale to 60,000 users — sizing

- **Redis ops:** 1 `EVALSHA` per guarded request. Peak ~5k RPS for 60k users ⇒ well under a Standard/Premium cache's >100k ops/s. Use a connection pool + pipelining; keys carry TTL = window so the keyspace is bounded by *active* scope keys (~hundreds of MB worst case).
- **Cosmos quota container:** **never on the hot path.** PK `/scopeKey` = `${tenantId}:${domainId}` (not `/tenantId`) to avoid a single hot logical partition / the 10k-RU & 20-GB per-partition ceiling for a 60k-user single-domain tenant (`partitioning#physical-partitions`). Atomic Patch `incr`, autoscale RU. Hot reads come from Redis.
- **ACA replicas:** counter is shared, so HTTP-concurrency autoscaling is correct; the limiter is replica-count-independent. Concurrency ceilings prevent a single user from pinning all replicas.
- **AOAI:** per-domain TPM budgets sum to ≤ deployment TPM; PTU recommended for predictable 60k latency (`provisioned-get-started`). Honor upstream `retry-after-ms` to ride out shared-pool dips.

---

## 8. Acceptance criteria (no-vaporware receipts)

1. **429 + Retry-After:** drive a guarded route over its RPM with a minted-session cookie ⇒ real `429`, `Retry-After`, `RateLimit-*` headers, structured body. Paste first 300 chars in the PR.
2. **Distributed:** two ACA replicas share one Redis bucket — limit holds across replicas (not 2×).
3. **Per-domain config:** `/admin/rate-limits` saves a Finance override to Cosmos `rate-limit-config`; a Finance user is throttled at the new ceiling; Sales is unaffected.
4. **AOAI accounting:** a Copilot call records `usage.total_tokens` into the domain TPM bucket + monthly `rate-quota`; over-budget ⇒ honest gate, not a silent stall.
5. **Graceful degradation:** kill Redis ⇒ read/copilot stay up (fail-open + `ratelimit_degraded` log), provision fails closed.
6. **Gov variant:** same flow against a Gov-suffix Redis host + Entra `.us` authority; AFD-or-AppGW rate-limit rule verified.
7. **Observability:** `/admin/rate-limits/usage` shows real 429 counts from Log Analytics + live Redis bucket levels.
8. **Day-one-on + cost-governed:** fresh deploy with `rateLimitEnabled=true` has working defaults by capacity SKU; with it `false`, the console runs with an honest MessageBar (no broken surface).

---

## 9. Priority

- **P0:** Front Door WAF RateLimitRule (Tier 1) + per-user RPM/concurrent guard on copilot/export/provision routes (Tier 2 hot subset) + Redis substrate + observe→enforce. Highest availability + cost-runaway protection for the least code.
- **P1:** AOAI token accounting chokepoint + per-domain TPM budgets + `/admin/rate-limits` UI + durable monthly quota/chargeback.
- **P2:** Node global `middleware.ts`, Ops-Copilot rate-limit tool, per-user overrides, AppGW-WAF Gov path, CMK/PE hardening polish.

**Sources:** `waf-front-door-rate-limit`, `waf-front-door-rate-limit-configure`, `application-ddos-protection`, `rate-limiting-configure` (AppGW), `cosmos-db/rate-limiting-requests`, `cosmos-db/optimize-cost-throughput`, `cosmos-db/partitioning`, `foundry/openai/how-to/quota` (TPM/RPM, `x-ratelimit-*`, `retry-after-ms`), `openai/provisioned-get-started` (PTU/429), `openai/azure-government`, `azure-cache-for-redis/cache-overview` + `cache-planning-faq` (Gov suffix), `entra/msidweb token-cache` (Redis Entra-auth), `container-apps/scale-app` (HTTP concurrency/KEDA), `compare-azure-government-global-azure`, `authentication-national-cloud`.
