# Appendix — Scale: Query Concurrency + Caching (`scale-query-caching`)

**Enterprise-hardening PRP · Domain owner deliverable · Target scale 100 → 60,000 users**
**Cross-cutting rules honored:** `no-vaporware.md`, `web3-ui.md`, `loom_no_freeform_config`, `no-fabric-dependency.md`, dual-cloud (Commercial + Azure Government GCC/GCC-High/IL4-5).

---

## 0. Executive summary

At 60k users the failure mode is a **live-DirectQuery storm**: every report visual, every `/query`
call, and every Copilot grounding hits Synapse Serverless / Dedicated / ADX / AAS directly. Those
engines have hard concurrency ceilings (Synapse Dedicated tops out at **128 concurrent queries** at
DW6000c+; ADX default is **Cores-Per-Node × 10**; AAS is bounded by QPU per tier). Loom today has
**no result cache, no admission control / rate-limiter, and no per-user/per-domain query budget** —
there is no `middleware.ts` in `apps/fiab-console`, no Redis client anywhere in `lib`, and the
data plane runs on a single shared Console UAMI (`uamiArmCredential`). The only relevant scale
asset already built is the **materialized-lake-view engine** (`lib/azure/materialized-lake-view-engine.ts`,
Synapse Spark → Delta) and the ADX **capacity-policy** read/patch surface in `lib/azure/kusto-client.ts`.

This appendix designs five build-outs, in priority order:

| # | Gap | Priority | Code vs Tenant |
|---|-----|----------|----------------|
| G1 | RLS-aware result cache (Redis cache-aside, keyed on `queryHash + RLS principal set + dataset version`) for `/query` + report visuals | **P0** | Both (code + provision Redis) |
| G2 | Query concurrency governor: admission queue + per-engine concurrency caps + per-user/per-domain budget + per-query timeout/row budget + backpressure 429 (the missing `middleware.ts`) | **P0** | Code |
| G3 | Source-side concurrency controls wired through Loom: ADX request-rate-limit-policy (per-principal) + weak consistency + query-results-cache; Synapse Dedicated workload groups; Serverless daily cost limit; AAS scale-out replicas | **P0** | Both (code + tenant capacity decisions) |
| G4 | Materialized-lake-view (W2 Import) as the **default** storage mode for shared dashboards + hot-report pre-warming | **P1** | Code |
| G5 | Cost-governed capacity layer: per-domain query budget UI (Web-5.0 wizard), chargeback wiring, Cosmos integrated cache for the metadata plane | **P1** | Both |

Every design ships an **Azure-native default** (no Fabric on the default path) and an **honest
Fluent MessageBar gate** when the backing infra is absent, per `no-vaporware.md`.

---

## 1. Grounding (MS Learn — authoritative)

**Caching pattern.** Cache-Aside + per-key TTL + `volatile-lru` eviction + Circuit-Breaker fallback
to the source store; never make the cache the system of record; the app must keep working if the
cache is down. (Caching guidance, Cache-Aside pattern, Circuit-Breaker pattern.)

**Redis service choice + DUAL CLOUD (critical).**
- **Azure Cache for Redis** is being retired — *new cache creation unavailable starting April 2026*;
  the go-forward managed service is **Azure Managed Redis (AMR)**.
- **AMR Enterprise / Enterprise Flash tiers are Public-cloud only.**
- **Azure Government** has **Azure Cache for Redis Basic/Standard/Premium** (`*.redis.cache.usgovcloudapi.net`),
  Private Link GA in all Government regions. China = `*.redis.cache.chinacloudapi.cn`.
- ⇒ **Commercial path = Azure Managed Redis; Gov path = Azure Cache for Redis Premium** (Private
  Endpoint, Entra auth, `publicNetworkAccess=Disabled`, CMK on Premium). This split must be a first-class
  branch in bicep + the client.

**Cosmos integrated cache** (metadata plane only): requires a **dedicated gateway** (endpoint host
`sqlx.cosmos.azure.com`, gateway connection mode), `MaxIntegratedCacheStaleness` default 5 min (up to
10 yr), requires **session or eventual** consistency, item-cache + query-cache share LRU capacity,
cache hits cost **0 RU**, provision **≥3 nodes** for the SLA. Metrics: `IntegratedCacheItemHitRate`,
`IntegratedCacheQueryHitRate`, `IntegratedCacheEvictedEntriesSize`. NoSQL API only.

**Synapse Dedicated SQL pool concurrency** (hard ceiling): max concurrent queries scales with SKU —
DW100c=4, DW500c=20, DW1000c=32, DW2000c=48, DW3000c=64, DW6000c–DW30000c=**128**. Queries beyond the
free concurrency slots **queue** by importance then FIFO. Resource classes (`staticrc10..80`,
`smallrc/mediumrc/largerc/xlargerc`) trade memory-per-query against concurrency. **Workload groups**
(`CREATE WORKLOAD GROUP`, `REQUEST_MIN_RESOURCE_GRANT_PERCENT` / cap / importance) supersede slots and
are the correct isolation primitive for "interactive vs. refresh vs. Copilot" lanes.

**Synapse Serverless SQL**: resources are auto-managed (no resource classes); the only governor is
**cost control** — daily/weekly/monthly TB limits via portal or `sp_set_data_processed_limit` T-SQL.
Per-query row/data budget is enforced app-side (TOP / row caps) since the engine self-manages.

**ADX / Kusto concurrency**:
- Default request concurrency = `Cores-Per-Node × 10` (e.g. D14_v2 16 vCore ⇒ 160).
- **Request rate limit policy** on a **workload group**: `LimitKind: ConcurrentRequests`,
  `Scope: WorkloadGroup | Principal` — e.g. *25 concurrent per principal*, *50 requests/principal/hour*.
  This is the native per-user governor.
- **Query consistency**: `Strong` (default, admin-node bottleneck) vs **`Weak`** (query-heads scale
  horizontally, 1–2 min staleness) vs `WeakAffinitizedByQuery/Database`. Weak consistency is the
  primary high-concurrency lever; set via `QueryConsistencyPolicy` or per-request `queryconsistency`.
- **Query results cache** (`query_results_cache_max_age`, `set` statement, policy `CachedResultsMaxAge`):
  serves identical dashboard queries from cache with near-zero CPU — first-class for shared dashboards.
- `.show capacity` = live slot utilization (already surfaced in `kusto-client.ts`).

**AAS (semantic model) concurrency**: **scale-out query replicas** — up to **7 additional (8 total)**
in a query pool, optionally separating the processing server (`:rw` management name) from the query
pool. Watch **QPU** and **Query pool job queue length** metrics; replicas billed at server rate.
Standard tier only. Read-only replicas guarantee query/processing isolation.

---

## 2. Current Loom readiness (file-level assessment)

| Capability | State | Evidence |
|---|---|---|
| Result cache (Redis / any) | **ABSENT** | No `redis`/`StackExchange`/`IntegratedCache` usage in `lib`/`app`; only `lib/components/deploy-planner/*` reference Redis as a *catalog item*. |
| Global rate-limiter / admission control | **ABSENT** | No `apps/fiab-console/middleware.ts`. `grep rate-limit\|throttle\|quota` finds only client-side and unrelated hits. |
| Per-user/per-domain query budget | **ABSENT** | No `queryBudget`/`per-user-quota` store. |
| ADX capacity policy | **PARTIAL** | `lib/azure/kusto-client.ts` L964-1073: `showClusterCapacityPolicy`, `showCapacity`, `alterMergeCapacityPolicy` (allow-listed components). **No** request-rate-limit policy, **no** query-consistency, **no** query-results-cache. |
| ADX query route surface | PRESENT | `app/api/adx/{policies,materialized-views,rls,tables,...}` + `_shared.ts` (error/validName helpers only — no central execute wrapper). |
| Synapse workload groups / serverless cost control | **ABSENT** | `synapse-serverless-sql-editor.tsx` exists but no `CREATE WORKLOAD GROUP` / `sp_set_data_processed_limit` client. |
| AAS scale-out | **ABSENT** | `aas-server-client.ts` has no scale-out/replica/queryPool code. |
| Materialized lake view (W2 Import) | **PRESENT (engine), not default** | `lib/azure/materialized-lake-view-engine.ts` (Spark→Delta refresh). Not wired as the *default* storage mode for shared dashboards; no pre-warm scheduler. |
| Cosmos throughput scaling | PRESENT | `lib/azure/cosmos-account-client.ts` reads `manual/autoscale/serverless` throughput; no integrated cache / dedicated gateway. |
| Multi-domain model | **STRONG** | `lib/azure/{domain-registry,domain-groups,domain-hierarchy}.ts`, `lib/auth/{domain-role,workspace-role}.ts`, capacity SKUs F2–F512, chargeback tag `loom-domain`. **The budget/quota anchor.** |
| Dual-cloud endpoint resolver | STRONG | `lib/azure/cloud-endpoints.ts` maps ARM/KV/SB/ADLS/ADX/Search/Graph/PBI to `.usgovcloudapi.net`/`.microsoft.us`. **No Redis suffix helper yet.** |
| Identity | Single shared UAMI | `arm-credential.ts` (`uamiArmCredential`); OBO only in `lib/azure/mcp-obo-token-store.ts`, `pbi-user-token-store.ts`, `lib/auth/msal.ts`. RLS rests on app checks + `SESSION_CONTEXT('loom_user')`. **⇒ the cache MUST key on the RLS principal set, not the UAMI.** |

**Readiness verdict: `weak`.** The expensive primitive (MLV engine) exists; the entire
caching + admission-control + per-user-governor layer is greenfield.

---

## 3. Architecture (in words)

### 3.1 The request path after this work

```
Browser visual / /query
   │
   ▼
middleware.ts ──(G2)── admission: resolve session → domain tier → per-user & per-domain
   │                    token bucket (Redis INCR) → if over budget: 429 + Retry-After + MessageBar
   │                    else acquire concurrency lease (per engine lane)
   ▼
route handler → cachedExecute()  ──(G1)── build cacheKey = sha256(engine|datasetId|datasetVersion|
   │                                        normalizedQuery|rlsPrincipalDigest); GET from Redis
   │                                        ├─ HIT  → return cached rows (0 backend cost)
   │                                        └─ MISS → engineExecute() with source-side governors (G3)
   ▼                                                  → SET Redis (TTL by staleness class) → return
engine clients (kusto-client / synapse-sql-client / aas-client / adls+serverless)
   with: ADX weak-consistency + results-cache + per-principal rate policy;
         Synapse Dedicated workload-group lane; Serverless row budget; AAS query-pool replica.
```

### 3.2 The RLS-safety invariant (defensible security)

The cache key **must** include a deterministic digest of the caller's *effective row-security
identity*, never just the query text. Because Loom's data plane uses one shared Console UAMI, the
boundary is enforced two ways and the cache must respect both:

1. **Source-side (primary boundary):** ADX RLS (`app/api/adx/rls`), AAS OLS/RLS roles
   (`aas-roles.ts`), and Synapse `SESSION_CONTEXT('loom_user')` predicate functions filter rows
   *before* they leave the engine. The cache stores the **already-filtered** result for *that
   identity*.
2. **App-side (defense in depth):** the cache key digest is computed from the resolved principal:
   `loom_user` + the sorted set of the caller's domain/security-group IDs (from the Entra `groups`
   claim via `domain-groups.ts` / `workspace-role.ts`). Two users with **different** group sets get
   **different** keys → user A's filtered rows are physically unreachable under user B's key.

A "no-RLS / public dataset" fast-path is allowed only when the dataset is explicitly tagged
`rls:none` in its item doc; otherwise the principal digest is mandatory. A dataset whose RLS roles
change bumps `datasetVersion` (stored on the item doc), invalidating all of its cached entries.

### 3.3 Staleness classes (TTL policy, no free-form)

A fixed enum (dropdown in the editor, never a free-text TTL — `loom_no_freeform_config`):

| Class | TTL | Use |
|---|---|---|
| `realtime` | 0 (bypass) | alerting / Activator-style |
| `interactive` | 30 s | default for live visuals |
| `dashboard` | 5 min | shared dashboards (matches ADX results-cache + Cosmos default) |
| `report` | 60 min | scheduled / Import-mode reports |
| `reference` | 24 h | dimension/lookup datasets |

Invalidation: (a) TTL expiry; (b) `datasetVersion` bump on refresh/schema/RLS change (write-through
`DEL pattern` via Redis `SCAN`+`UNLINK` of `loom:rc:{datasetId}:*`); (c) manual "Clear cache" admin action.

---

## 4. Build-out per gap

### G1 — RLS-aware result cache (P0)

**New files**
- `lib/azure/result-cache-client.ts` — Redis connection (lazy singleton `ConnectionMultiplexer`-equiv
  via `ioredis`), Entra-auth (Managed Identity token as password for AMR; Premium-Gov uses Entra too),
  `get/set/delByDataset`, circuit-breaker (on connect failure → `degraded` mode, all calls fall through
  to source per Cache-Aside/Circuit-Breaker). Honest gate `CosmosConfigGate`-style when
  `LOOM_RESULT_CACHE_HOST` unset.
- `lib/query/cache-key.ts` — `buildCacheKey({engine, datasetId, datasetVersion, normalizedQuery, principalDigest})`
  using `crypto.createHash('sha256')`; `principalDigest(session)` reads `loom_user` + sorted group IDs.
- `lib/query/cached-execute.ts` — `cachedExecute(req, fn)`: key → GET → HIT return / MISS run `fn` →
  SET with staleness TTL → return; records hit/miss to `monitor-client`.
- `lib/azure/redis-endpoint.ts` — dual-cloud host suffix: Commercial AMR `*.<region>.redis.azure.net`
  / `*.redisenterprise.cache.azure.net`; **Gov** `*.redis.cache.usgovcloudapi.net`. Mirrors the pattern
  in `cloud-endpoints.ts` (add `redisHostSuffix()` there too).

**Edits (wire cache into hot read paths — incremental, one route at a time behind the flag)**
- `app/api/adx/_shared.ts` — add `executeAdxQuery()` central wrapper that calls `cachedExecute`.
- `app/api/items/synapse-serverless-sql-pool/[id]/.../route.ts` preview/query handlers.
- `app/api/sqldb/preview/route.ts` and the report visual data route (`app/api/items/report/.../query`).
- `lib/azure/aas-client.ts` DAX execute path (cache DAX result sets per role).

**Feature flag:** `LOOM_RESULT_CACHE=on|off` (default `off` until Redis provisioned; `cachedExecute`
is a pass-through when off → zero behavior change, fully reversible).

**Env:** `LOOM_RESULT_CACHE_HOST`, `LOOM_RESULT_CACHE_PORT` (6380/10000), `LOOM_RESULT_CACHE_SKU`,
`LOOM_RESULT_CACHE_TTL_DEFAULT` (enum name, not seconds).

### G2 — Query concurrency governor / admission control (P0)

**New files**
- `apps/fiab-console/middleware.ts` — Next.js middleware matching `/api/(adx|sqldb|items|adf|copilot)/:path*`.
  Resolves session (reuse `lib/auth/session.ts#getSession`), computes per-user + per-domain token-bucket
  keys, calls the governor; on deny returns `429` JSON `{ok:false,error,retryAfterMs}` + `Retry-After`
  header. **This is the file Loom is missing today.**
- `lib/query/concurrency-governor.ts` — Redis-backed sliding-window + token bucket (`INCR`+`EXPIRE`,
  atomic Lua), **per-engine lane caps** sized under the MS Learn ceilings:
  `adx`, `synapse-dedicated`, `synapse-serverless`, `aas`, `copilot-grounding`. Lane caps come from
  the bound domain's capacity SKU (F2…F512 → derived concurrency budget).
- `lib/query/query-budget-store.ts` — Cosmos `tenant-settings` doc `query-budget:<tenantId>` (partition
  `/tenantId`), per-domain + per-tier defaults; read-through cached. Mirrors `domain-registry.ts` shape.
- `lib/query/row-budget.ts` — per-query `TOP`/`maxrows`/`timeout` injection per engine (Serverless row cap,
  ADX `set truncationmaxrecords`, Synapse `QUERY_GOVERNOR_COST_LIMIT` / statement timeout).

**Backpressure UX (Web-5.0):** `lib/components/query/ThrottleBanner.tsx` — Fluent `MessageBar`
`intent="warning"`: "You've hit your interactive-query budget (N/min for the *Marketing* domain).
Retrying in 12 s — or open this as an Import-mode report." Wired into the query hooks so every visual
degrades gracefully, never a raw 429 to the user.

**Flag:** `LOOM_QUERY_GOVERNOR=enforce|observe|off`. Ship in **`observe`** first (logs would-deny,
never blocks) → validate against real traffic → flip to `enforce`. Fully reversible.

### G3 — Source-side concurrency controls (P0)

**ADX — extend `lib/azure/kusto-client.ts`** (capacity policy already there):
- `getRequestRateLimitPolicy()/setRequestRateLimitPolicy()` — `.alter-merge workload_group default policy request_rate_limit`
  with `Scope:Principal, MaxConcurrentRequests` + per-principal hourly via `ResourceUtilization`/sliding-window policy.
- `getQueryConsistencyPolicy()/setWeakConsistency()` — set `QueryConsistencyPolicy.QueryConsistency=Weak`
  (or per-request `queryconsistency=weak` in client request properties for dashboard reads).
- `setResultsCacheMaxAge(ageEnum)` — emit `set query_results_cache_max_age = time(...)` on dashboard reads.

**Synapse Dedicated — new `lib/azure/synapse-workload-group-client.ts`:**
`CREATE/ALTER WORKLOAD GROUP` + `CREATE WORKLOAD CLASSIFIER` for three lanes
(`loom_interactive` high importance + small grant, `loom_refresh` low importance, `loom_copilot` capped),
classifying by the SQL login Loom connects as. Sized from `memory-concurrency-limits` table per DWU.

**Synapse Serverless — new `lib/azure/synapse-serverless-cost-client.ts`:**
`sp_set_data_processed_limit` daily/weekly/monthly TB caps (mirrors portal cost control), surfaced
read/write in `synapse-serverless-sql-editor.tsx`.

**AAS — new `lib/azure/aas-scaleout-client.ts`:** REST `PATCH …/scale` to set `capacity` (replica count
0–7) + `separateProcessingAndQuerying`; read QPU / `Query pool job queue length` from `monitor-client.ts`.

**Tenant-action vs code:** the *clients are code Loom ships*; the **decision** of how high to set
ADX `MaxConcurrentRequests`, which DWU to run, and how many AAS replicas (cost) is a **capacity choice**
surfaced in the admin UI and documented as a runbook (§7). Setting an ADX policy needs
`AllDatabasesAdmin`; setting Synapse workload groups needs `db_owner`/`CONTROL` — both honest gates.

### G4 — Materialized-lake-view as default for shared dashboards + pre-warming (P1)

- **Edit `lib/azure/materialized-lake-view-engine.ts` + report/dataset item doc**: add `storageMode`
  enum `directQuery | import(MLV) | hybrid`, **default `import` for any dataset marked `shared:true`**
  (a shared dashboard reads the materialized Delta via Serverless `OPENROWSET`, not live DirectQuery).
- **New `lib/query/cache-warmer.ts`** + internal route `app/api/internal/cache/prewarm/route.ts`
  (token-gated, like `register-domain`): a scheduled job (ACA Job / cron) that re-runs the top-N hot
  reports per domain (ranked from `monitor-client` query telemetry) just after each MLV refresh, so the
  first real user hits a warm Redis + warm ADX results-cache.
- **Web-5.0:** a "Storage mode" segmented control + "Pre-warm schedule" wizard step in the report/dataset
  editor (dropdowns only).

### G5 — Cost-governed capacity + per-domain budget UI + Cosmos integrated cache (P1)

- **`lib/components/admin/QueryBudgetWizard.tsx`** (`/admin/cost-governor`): per-domain sliders bound to
  capacity SKU, writing `query-budget-store`. Reads chargeback via the `loom-domain` tag (already in
  `domain-registry.ts`) so each domain's query spend is attributable.
- **Cosmos integrated cache (metadata plane):** provision a **dedicated gateway** (≥3 nodes) on the
  metadata Cosmos account; point `cosmos-client.ts` at `sqlx.cosmos.azure.com` with gateway mode +
  session consistency + `MaxIntegratedCacheStaleness` 5 min. Cuts RU storms from 60k users reading
  workspace/item docs. Flag `LOOM_COSMOS_DEDICATED_GATEWAY=on`. (Code = 1-line endpoint + consistency
  swap; the gateway itself is a provisioned resource = tenant/bicep.)

---

## 5. Bicep / deploy

**New `platform/fiab/bicep/modules/shared/result-cache.bicep`** (dual-cloud branch):
```bicep
@allowed(['amr','acr-premium'])           // amr=Commercial, acr-premium=Gov
param cacheKind string
param isGov bool
// Commercial → Microsoft.Cache/redisEnterprise (AMR), Balanced/MemoryOptimized SKU
// Gov        → Microsoft.Cache/redis, Premium P1+, publicNetworkAccess:'Disabled'
// Both: Private Endpoint into the admin-plane VNet, Entra auth, diagnostic-settings.bicep, CMK (Gov)
```
- Wire into `landing-zone/main.bicep` (per-DLZ optional) **and** `admin-plane/main.bicep` (shared cache),
  add `LOOM_RESULT_CACHE_HOST/PORT/SKU` + `LOOM_RESULT_CACHE`, `LOOM_QUERY_GOVERNOR` to the `apps[]` env
  list (per `no-vaporware.md` bicep-sync requirement).
- **Cosmos dedicated gateway**: add `dedicatedGatewayRequests`/`DedicatedGateway` sub-resource to the
  Cosmos module (Commercial + Gov both GA).
- **ACA**: bump min replicas / concurrency on the console app to absorb the governor's queue; add the
  `cache-warmer` ACA Job (scale-to-zero, KEDA cron).
- Reuse `shared/diagnostic-settings.bicep` to ship Redis + governor metrics to Log Analytics.

**Gov specifics:** Redis host `*.redis.cache.usgovcloudapi.net`; AMR Enterprise **not available** → Gov
**must** use `acr-premium`; IL4/5 → Private-Endpoint-only + CMK + no public network. OSS substitute if a
managed cache is disallowed in a sovereign enclave: **self-hosted Redis/KeyDB on AKS** behind the same
`result-cache-client` interface (the client targets a host:port + token, so the substitution is config-only).

---

## 6. Commercial vs Gov matrix

| Concern | Commercial | Azure Government (GCC-High / IL4-5) |
|---|---|---|
| Result cache service | Azure Managed Redis (Enterprise) | Azure Cache for Redis **Premium** (`*.redis.cache.usgovcloudapi.net`) or AKS Redis/KeyDB (OSS) |
| Redis auth | Entra (MI token as password) | Entra (sovereign authority `login.microsoftonline.us`) |
| Network | Private Endpoint | Private-Endpoint-only, `publicNetworkAccess=Disabled`, CMK |
| Cosmos integrated cache | dedicated gateway GA | dedicated gateway GA (all Gov regions) |
| ADX host | `*.kusto.windows.net` | `*.kusto.usgovcloudapi.net` (already in `cloud-endpoints.ts`) |
| AAS | scale-out replicas | same (Gov regions USGov Virginia/Arizona) |
| Entra authority | `login.microsoftonline.com` | `login.microsoftonline.us` |

---

## 7. Code vs Tenant-admin runbook

**Code Loom ships:** all clients, `middleware.ts`, governor, cache, key-derivation, UI, bicep modules,
flags.

**Tenant-admin / Azure actions (honest in-product gates + runbook):**
1. **Provision Redis** (or approve the bicep) → set `LOOM_RESULT_CACHE_HOST` → gate clears.
2. **Grant the Console UAMI** `Redis Cache Contributor` + data-plane access policy (or AKS secret).
3. **ADX**: grant UAMI `AllDatabasesAdmin` to let Loom set request-rate-limit / consistency policies
   (else the editor shows a gate: "ADX policy change needs AllDatabasesAdmin").
4. **Synapse Dedicated**: `db_owner` to create workload groups; choose DWU (capacity/cost decision).
5. **Synapse Serverless**: set the daily TB cost limit (Loom surfaces the control; admin picks the number).
6. **AAS**: choose replica count (cost) — Loom sets it; admin owns the $$ decision.
7. **Cosmos dedicated gateway**: provision ≥3 nodes; flip `LOOM_COSMOS_DEDICATED_GATEWAY=on`.

Each gated UI follows `no-vaporware.md`: full surface renders + a `MessageBar intent="warning"` naming
the exact env var / role / resource + a link to the bicep module.

---

## 8. Migration plan (incremental, reversible)

1. **Phase 0 — observe.** Ship governor in `observe`, cache `off`. Add metrics. Zero user impact.
2. **Phase 1 — cache read-through** on one route (ADX dashboard reads) with `LOOM_RESULT_CACHE=on`,
   TTL `dashboard`. Validate RLS-key isolation with two users in different domains (see §9).
3. **Phase 2 — fan out** cache to Serverless/SQL/AAS routes, one at a time.
4. **Phase 3 — governor `enforce`** per-domain, starting with the largest domain; per-user budgets.
5. **Phase 4 — source policies**: ADX weak-consistency + results-cache + per-principal limits; Synapse
   workload groups; AAS scale-out for the hottest model.
6. **Phase 5 — MLV default** for `shared:true` datasets + pre-warmer.
7. **Phase 6 — Cosmos integrated cache** for the metadata plane.

Every phase is a flag flip; rollback = flip back (cache pass-through, governor `observe`).

---

## 9. Acceptance criteria

- **RLS isolation (must-pass):** User A (domain X) and User B (domain Y) issue the *same* query text
  against an RLS dataset; A's cached rows are never returned to B (different `principalDigest` keys).
  Verified live via Playwright with two minted sessions; receipt in PR (per `no-scaffold`).
- **Cache hit:** repeated dashboard query returns from Redis (backend RU/slot = 0; `IntegratedCache*HitRate`
  or Redis hit logged); p95 latency drops materially.
- **Backpressure:** synthetic 200-concurrent-user load on one engine → governor returns 429 +
  `Retry-After`, ThrottleBanner shows, no source-engine throttle error reaches the user, no 5xx.
- **Source ceilings respected:** ADX `.show capacity` and Synapse `sys.dm_pdw_exec_requests` show queued
  (not failed) queries under load; AAS Query-pool-job-queue stays bounded after scale-out.
- **Invalidation:** dataset refresh bumps `datasetVersion`; stale entries gone within one TTL.
- **Dual-cloud:** the same E2E passes with `LOOM_CLOUD=AzureUSGovernment` against `*.usgovcloudapi.net`.
- **Day-one-on, cost-governed:** every engine works with no extra config (cache `off` = pass-through);
  enabling the cache/governor is per-domain and never blocks a feature.
- **No-fabric:** all paths Azure-native; `grep api.fabric/onelake` on these files = 0.

---

## 10. Exact file inventory

**Create:** `apps/fiab-console/middleware.ts`; `lib/azure/result-cache-client.ts`;
`lib/azure/redis-endpoint.ts`; `lib/azure/synapse-workload-group-client.ts`;
`lib/azure/synapse-serverless-cost-client.ts`; `lib/azure/aas-scaleout-client.ts`;
`lib/query/{cache-key,cached-execute,concurrency-governor,query-budget-store,row-budget,cache-warmer}.ts`;
`lib/components/query/ThrottleBanner.tsx`; `lib/components/admin/QueryBudgetWizard.tsx`;
`app/api/internal/cache/prewarm/route.ts`; `app/admin/cost-governor/page.tsx`;
`platform/fiab/bicep/modules/shared/result-cache.bicep`; `docs/fiab/parity/scale-query-caching.md`.

**Edit:** `lib/azure/kusto-client.ts` (+rate-limit/consistency/results-cache);
`lib/azure/cloud-endpoints.ts` (+`redisHostSuffix`); `lib/azure/cosmos-client.ts` (dedicated gateway);
`lib/azure/materialized-lake-view-engine.ts` (+`storageMode` default import for shared);
`app/api/adx/_shared.ts` (+`executeAdxQuery`); `app/api/sqldb/preview/route.ts`;
`lib/editors/synapse-serverless-sql-editor.tsx` (cost-limit control);
`platform/fiab/bicep/modules/{admin-plane,landing-zone}/main.bicep` (env + module wire).
