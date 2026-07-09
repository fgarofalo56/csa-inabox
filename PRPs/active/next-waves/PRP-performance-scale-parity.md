# PRP — Performance, Scale & Reliability parity (benchmark-driven, honest non-goals)

> **Title:** Performance, scale & reliability parity — outcome-equivalent, benchmark-driven
> **Date:** 2026-07-09
> **Status:** proposed
> **Owner:** Loom Performance / Scale / Reliability Architect
> **Sources consulted:** direct code review of `apps/fiab-console/lib/azure/**`
> (`synapse-livy-client.ts`, `spark-session-pool.ts`, `fetch-with-timeout.ts`,
> `aoai-chat-client.ts`, `kusto-client.ts`, `aas-client.ts`, `query-result-cache.ts`,
> `cosmos-client.ts`, `capacity-guardrails.ts`, `auth/msal.ts`) with file:line evidence
> per item; `platform/fiab/bicep/modules/**` (admin-plane `main.bicep`, `app-deployments.bicep`,
> landing-zone `cosmos.bicep` / `storage.bicep`, `loom-console-cosmos.bicep`);
> `docs/fiab/operations/disaster-recovery.md`; the sibling `WAVES.md` backlog
> (BR-CONTROLPLANE-DR / BR-BLUEGREEN / SVC-11 — **referenced, not duplicated here**);
> and Microsoft Learn Fabric performance benchmarks (starter pools, Native Execution
> Engine TPC-DS SF1000, Direct Lake framing + V-Order, Warehouse CU smoothing/bursting,
> Real-Time Intelligence end-to-end latency) — full citations inline per item.
> **Governing rules (die-hard, non-negotiable):** `.claude/rules/no-fabric-dependency.md`
> (Azure-native is the DEFAULT; Fabric/Power BI are opt-in only, never a gate),
> `.claude/rules/no-vaporware.md` (real backend + measured receipt per merge — a benchmark
> number IS the receipt for this pillar), `.claude/rules/ui-parity.md`,
> `loom_no_freeform_config`, `loom_design_standards`. Dual-cloud (Commercial + Government)
> mandatory for every item. Default-ON / opt-out posture per WAVES.md global principle.

---

## 1. Executive summary

Loom already **trails Fabric on every headline latency benchmark by design, and is honest
about it** — the gap lives in the platform's own code comments and DR doc, not papered over.
That honesty is the strategic asset this pillar builds on. We do **not** chase mechanism
parity with proprietary Fabric internals (OneLake substrate, the Direct Lake VertiPaq engine,
CU smoothing, hyperscale multi-tenancy). We chase **outcome equivalence** — the numbers a user
feels — on an Azure-native/OSS backend, and we prove every claim with a **repeatable benchmark
harness** rather than a marketing adjective. Under `no-vaporware.md`, for this pillar **the
measured benchmark number is the receipt**.

The honest starting posture, code-grounded:

- **Notebook / Spark cold start.** The Azure-native default (`LOOM_NOTEBOOK_BACKEND` →
  Synapse Livy, `synapse-livy-client.ts` `createLivySession()`) pays a **2-4 minute cold
  start** on a resting pool (per the explicit comment header in `spark-session-pool.ts`
  lines 4-11) vs Fabric starter pools' **~5-10s** pre-warmed attach
  (https://learn.microsoft.com/en-us/fabric/data-engineering/configure-starter-pools).
  A warm-pool accelerator (`spark-session-pool.ts`) already exists to close this — but it
  ships **DEFAULT OFF** (`LOOM_SPARK_POOL_ENABLED` unset → disabled, lines 29-30/140-145) and
  is **per-ACA-replica with no shared cross-replica lease store** (its own "Scope note",
  lines 45-48). So out of the box every notebook run pays full cold start.
- **Semantic-model / report query.** `aas-client.ts` states outright (line 885) that *"True
  Direct Lake sub-second freshness requires a Fabric F-SKU (unavailable in Gov)."* The
  Azure-native default is AAS/Power-BI Import or DirectQuery over Synapse Serverless, with an
  always-on in-process TTL/LRU **query result cache** (`query-result-cache.ts`, self-described
  as *"the pragmatic 80% of Fabric Direct Lake… without a Fabric capacity"*) and an optional
  Cosmos cross-replica tier. We explicitly do **not** claim Direct-Lake-equivalent p99.
- **RTI / KQL dashboard.** Tiles poll ADX directly per refresh (`kusto-client.ts`
  `POST /v1/rest/query`, `MAX_ROWS 5000`) — architecturally parity-shaped with Fabric's own
  poll-based Real-Time Dashboard refresh, but with one extra hop (browser → Next.js BFF → ADX).
- **Copilot turn.** `fetch-with-timeout.ts` sets a **120s** hard ceiling (`LLM_FETCH_TIMEOUT_MS`)
  for an AOAI turn / tool-loop, but there is **no p50/p95 SLO defined anywhere in code** —
  only the outer abort deadline.

On **scale**, the ceilings are real and mostly deliberate: Cosmos runs **Serverless**
(`cosmos.bicep` capacityMode, lines 55-65) *specifically to dodge the 25-container
shared-throughput cap* that was throwing live 500s — the trade-off is a **5,000 RU/s per
physical partition** ceiling with **no latency SLA** and no autoscale headroom
(https://learn.microsoft.com/en-us/azure/cosmos-db/serverless-performance). ACA `loom-console`
sits at **minReplicas 2 / maxReplicas 6** with a **50-concurrent-request-per-replica** default
scale trigger (`admin-plane/main.bicep` 2522-2523, `app-deployments.bicep` 218-226) — **~300
concurrent in-flight requests** before backpressure — and Front Door session affinity is **OFF**
(requiring the Cosmos-backed MSAL cache in `auth/msal.ts` 40-67 to keep multi-replica silent
refresh correct). ADX is a **single shared cluster** (`adx-csa-loom-shared`) with a **5,000-row**
hard cap per query.

On **reliability**, the platform is honestly documented as **single-region with zone
redundancy only**: ZRS lake + Cosmos Continuous7Days PITR + stateless redeploy-from-Git are
**real and wired** (`disaster-recovery.md`), but control-plane **multi-region active-passive
(BR-CONTROLPLANE-DR, Wave 18)** and **blue-green console rolls (BR-BLUEGREEN, Wave 15)** are
**tracked backlog, not shipped**, and there are **no formal SLOs and no load-test artifacts**
anywhere in the repo. Reliability today is probe-based health + a concurrency scale threshold —
not a measured, target-backed SLO.

**The strategic bet:** ship the **benchmark harness first** (P0 foundation — it makes every
later item's acceptance a measured delta instead of a vibe), then a **speed-closures wave**
(warm pools, cache tuning, tile parallelization, TTI splitting), then **interleave scale and
reliability closures with the existing Waves 15-18** (reference BR-CONTROLPLANE-DR /
BR-BLUEGREEN / SVC-11 — this PRP wires the harness, SLOs, autoscale posture, and load tests
*around* them, it does not rebuild them). A standalone **Honest Non-Goals** section (§4) names
exactly what we do **not** chase mechanism-parity on and the outcome-equivalent each maps to,
so the plan never gaslights.

Every backend named below is Azure-native or OSS-on-Azure. Nothing here reaches
`api.fabric.microsoft.com` / `api.powerbi.com` on any default path. Warm-pool / autoscale /
DR features follow the WAVES.md **default-ON, cost-bounded-by-scale-to-zero** posture — the
one exception being that a real Fabric F-SKU backend stays strictly opt-in.

---

## 2. Work items

| # | Item | Category | State | Priority | Effort |
|---|------|----------|-------|----------|--------|
| PSR-1 | Benchmark harness — repeatable perf suite + `/admin/performance` page + persisted trend | Foundation | MISSING | **P0** | L |
| PSR-2 | Perf gate in CI + per-roll benchmark receipt (regression budget) | Foundation | MISSING | **P0** | M |
| PSR-3 | Warm Spark session pool — DEFAULT ON + cross-replica shared lease store | Speed | PARTIAL | **P0** | L |
| PSR-4 | Databricks serverless / AML compute-instance warm fast-path | Speed | PARTIAL | P1 | M |
| PSR-5 | AAS warm-cache + result-cache tuning (Direct-Lake outcome-equivalent) | Speed | PARTIAL | P1 | M |
| PSR-6 | ADX result-cache + client cache headers + row-cap paging | Speed | PARTIAL | P1 | M |
| PSR-7 | Dashboard tile parallelization + skeletons + stale-while-revalidate | Speed | PARTIAL | P1 | S |
| PSR-8 | Copilot turn latency SLO + streaming-first budget + router tuning | Speed | PARTIAL | P2 | M |
| PSR-9 | Next.js route-level code-splitting / TTI budget for heavy editors | Speed | PARTIAL | P1 | L |
| PSR-10 | Cosmos RU / partition posture — autoscale advisory + cross-partition audit | Scale | PARTIAL | P1 | L |
| PSR-11 | ACA autoscale rules — HTTP concurrency tuning + KEDA per-workload rules | Scale | PARTIAL | P1 | M |
| PSR-12 | Front Door caching rules for static + immutable assets | Scale | MISSING | P2 | S |
| PSR-13 | Session-store hardening + silent-refresh latency budget | Scale | PARTIAL | P2 | S |
| PSR-14 | Concurrent-user load tests (Azure Load Testing / k6) — ties to SVC-11 | Scale | MISSING | P1 | L |
| PSR-15 | Quota preflight advisor — estate quota checks with honest surfacing | Scale | PARTIAL | P1 | M |
| PSR-16 | SLO definitions + burn-rate alerts on the estate's own Loom (dogfood) | Reliability | MISSING | P1 | M |
| PSR-17 | Synthetic probes — UAT harness as a continuous canary | Reliability | PARTIAL | P1 | M |
| PSR-18 | Blue-green console rolls — reference BR-BLUEGREEN (Wave 15) + perf-gate the health check | Reliability | REF | P2 | — |
| PSR-19 | Control-plane DR active-passive — reference BR-CONTROLPLANE-DR (Wave 18) + RTO/RPO drill | Reliability | REF | P2 | — |
| PSR-20 | Chaos experiments — reference SVC-11 (Chaos Studio) + benchmark-under-fault | Reliability | REF | P3 | — |

**Suggested wave grouping** (each wave independently shippable + build-gated; the three
REF items deliberately do not duplicate their owning wave — they add the harness/SLO/drill
glue around it):

- **Wave PSR-A — Benchmark harness (P0 foundation, next-UX-wave companion):** PSR-1, PSR-2.
  Ships the measurement substrate + CI gate first so every subsequent item's acceptance is a
  measured delta. Do first, before any speed work.
- **Wave PSR-B — Speed closures (its own wave):** PSR-3, PSR-4, PSR-5, PSR-6, PSR-7, PSR-8,
  PSR-9. Each acceptance = a PSR-1 benchmark delta vs the pre-change baseline.
- **Wave PSR-C — Scale closures (interleave with Waves 15-16):** PSR-10, PSR-11, PSR-12,
  PSR-13, PSR-14, PSR-15.
- **Wave PSR-D — Reliability (interleave with Waves 15-18):** PSR-16, PSR-17, and the three
  REF items PSR-18/19/20 that ride BR-BLUEGREEN / BR-CONTROLPLANE-DR / SVC-11.

---

## 3. Work items in detail

Every admin UI surface must be **Fluent v9 + Loom tokens**, use **charts (not JSON dumps)**
for trend data, and follow the no-freeform-config rule. Every new Azure resource / env var /
role / Cosmos container is **bicep-synced** per `no-vaporware.md`. Every acceptance receipt is
a **real measured number from a deployed console with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset**,
compared against the stated Fabric bar as an *outcome-equivalence* target (not a
mechanism-parity claim).

---

### PSR-1 — Benchmark harness: repeatable perf suite + `/admin/performance` page + persisted trend — **P0 · L**

**Capability.** A single repeatable performance suite (scripts + an admin page) that measures,
persists, and trends the numbers users feel, so every other item in this PRP has an objective
acceptance. Measured metrics: **Spark session-attach time per backend** (Synapse Livy cold /
warm-hit, Databricks), **notebook cell round-trip**, **warehouse query p50/p95** (Synapse
Serverless + dedicated pool), **ADX query p50/p95**, **dashboard tile TTI**, **Copilot turn
latency** (first-token + full-turn), and **page TTI for the top-10 surfaces** (home, catalog,
each heavy editor). Results persisted and trended; run per roll.

**Source grounding.** Fabric publishes concrete bars we measure *against* (as outcome targets,
not mechanism copies): starter-pool ~5-10s attach
(https://learn.microsoft.com/en-us/fabric/data-engineering/configure-starter-pools),
Native Execution Engine up-to-6x / ~83%-cost TPC-DS SF1000
(https://learn.microsoft.com/en-us/fabric/data-engineering/native-execution-engine-overview),
Direct Lake sub-second over billion-row tables
(https://learn.microsoft.com/en-us/fabric/fundamentals/direct-lake-overview),
RTI 2-30s end-to-end. There is no equivalent Loom measurement artifact today.

**Current Loom state — MISSING.** No SLO doc, no k6/Locust/artillery config, no perf page.
Latency knowledge lives only in scattered code comments (`spark-session-pool.ts` 4-11,
`aas-client.ts` 885, `fetch-with-timeout.ts` `LLM_FETCH_TIMEOUT_MS`). Nothing measures or trends.

**Azure-first / OSS build.**
- *Harness scripts:* a `scripts/csa-loom/perf/` suite (Node/TS, reusing the existing
  minted-session-cookie probe pattern from the UAT harness) that drives each real backend
  endpoint N times, records p50/p95/p99 + cold-vs-warm, and writes a run document.
- *Backend:* results persisted to a new Cosmos container `perf-benchmarks` via
  `createIfNotExists` (no new resource type), keyed `{runId, gitSha, rev, metric, backend,
  p50, p95, p99, coldMs, warmMs, ts}`. Optional export of the same rows to the existing Log
  Analytics workspace (a `LoomPerf_CL` DCR table) so trends can be queried in KQL alongside
  platform telemetry.
- *UI:* a new `/admin/performance` page (Fluent v9 + Loom tokens) with per-metric trend charts
  (sparkline + p50/p95 bands, using the shipped chart components — no JSON dump), a
  Fabric-bar reference line per metric (the outcome-equivalence target), and a "Run benchmark
  now" action (tenant-admin-gated) that fires the suite against the live estate.
- *Bicep:* `perf-benchmarks` Cosmos container init; optional `LoomPerf_CL` DCR/table module in
  `platform/fiab/bicep/modules/admin-plane/`; no new resource type otherwise.
- *Gov:* Cosmos + Log Analytics are day-one in Gov → identical behavior; honest MessageBar if
  the optional DCR table is not provisioned.

**Acceptance (measured receipt).** On a deployed console (`LOOM_DEFAULT_FABRIC_WORKSPACE`
unset), "Run benchmark now" executes all metrics against real backends, writes a run doc to
`perf-benchmarks`, and `/admin/performance` renders trend charts with the current p50/p95 per
metric and the Fabric reference line. A second run appended shows a two-point trend. Receipt =
the first full run's JSON (first 300 chars) + a screenshot of the perf page.

---

### PSR-2 — Perf gate in CI + per-roll benchmark receipt (regression budget) — **P0 · M**

**Capability.** A CI/roll gate that runs the PSR-1 suite (against a deployed preview or the
post-roll estate), compares each metric to the trailing baseline, and **fails / warns on a
regression beyond a per-metric budget** — turning "the benchmark number is the receipt" into
an enforced contract rather than a manual habit.

**Source grounding.** `no-vaporware.md` "Validation per merge" requires a real-data E2E receipt
per PR; this item makes the perf number a first-class, machine-checked receipt. Complements the
existing `pnpm uat` deep-functional gate.

**Current Loom state — MISSING.** No perf regression gate exists; the only per-roll gates are
the build/tsc marker and the UAT harness.

**Azure-first / OSS build.**
- *CI:* a workflow step (post-roll, in-VNet like the UAT job) that invokes the PSR-1 suite,
  pulls the trailing-N baseline from `perf-benchmarks`, and computes per-metric deltas.
- *Budget:* a checked-in `perf-budgets.json` (per-metric p95 ceiling + max allowed regression
  %). Breach → the step reports a red check with the offending metric + delta; a documented
  admin override label allows a justified regression (e.g. a deliberate cold-start trade).
- *Backend:* reads/writes the same `perf-benchmarks` container; no new resource.
- *Gov:* runs in the Gov CI lane against the Gov estate.

**Acceptance (measured receipt).** A PR that intentionally regresses one metric (e.g. disables
the warm pool) turns the perf gate red with the exact metric + delta; a clean roll turns it
green and posts the per-roll benchmark table into the roll receipt. Receipt = both CI check
outputs.

---

### PSR-3 — Warm Spark session pool: DEFAULT ON + cross-replica shared lease store — **P0 · L**

**Capability.** Make Fabric-starter-pool-*feel* the default: a warm Synapse Livy (and
Databricks all-purpose) session pool that keeps N idle sessions on standby so notebook/Spark
attach is **instant on a warm hit and <20s on a cold Synapse miss** instead of the 2-4 min
cold start — and make the warm capacity **shared across ACA replicas** so the hit rate holds at
`maxReplicas`.

**Source grounding.** Fabric starter pools attach in ~5-10s from pre-warmed standby capacity
(https://learn.microsoft.com/en-us/fabric/data-engineering/configure-starter-pools;
https://learn.microsoft.com/en-us/fabric/data-engineering/spark-compute). Loom's own
`spark-session-pool.ts` header (lines 4-11) documents the 2-4 min Synapse cold start this
closes.

**Current Loom state — PARTIAL.** `spark-session-pool.ts` already implements the lease/return
model (`acquireWarmSession` / `releaseSession`) refilled by a 30s sweeper (`SWEEP_INTERVAL_MS`),
but it ships **DEFAULT OFF** (`LOOM_SPARK_POOL_ENABLED` unset → disabled, lines 29-30/140-145),
and is **per-process/per-ACA-replica** with **no shared cross-replica lease store** (its own
"Scope note", lines 45-48). At `maxReplicas 6` the console-wide warm ceiling is only
`6 × LOOM_SPARK_POOL_MAX(3) = 18` uncoordinated sessions with no even-hit guarantee.

**Azure-first / OSS build.**
- *Default flip:* invert the default to **ON** per the WAVES.md default-ON posture, with the
  min/max (`LOOM_SPARK_POOL_MIN/MAX`) and an idle-stop timer as the cost bound (resting cost
  bounded by the pool min + Synapse pool auto-pause), and an admin per-tenant kill switch — not
  an opt-in gate.
- *Cross-replica lease store:* move the warm-session registry from in-process memory to a
  shared **Cosmos `spark-warm-leases` container** (lease doc per session with TTL + owner
  replica id + state), so any replica can claim a warm session another replica warmed. The 30s
  sweeper reconciles leases and refills to `MIN` globally rather than per-replica.
- *Bicep:* `spark-warm-leases` Cosmos container init; Synapse pool auto-pause confirmed in the
  pool bicep so resting cost stays ~$0; no new resource type.
- *Gov:* Synapse Spark + Cosmos are day-one in Gov → identical; Databricks warm path stays
  opt-in (first-party alternate backend).

**Acceptance (measured receipt).** With the pool default-ON, PSR-1 shows notebook **warm-hit
attach ≤ ~3s** and **cold Synapse attach < 20s** (vs the documented 2-4 min baseline captured
in the same table); a session warmed on replica A is acquired by a request routed to replica B
(lease doc transfer proven in the `spark-warm-leases` container); idle-stop returns resting
cost to ~$0. Receipt = the before/after PSR-1 attach rows + the cross-replica lease doc.

---

### PSR-4 — Databricks serverless / AML compute-instance warm fast-path — **P1 · M**

**Capability.** Extend the warm-start outcome to the two other compute backends that pay a
cold penalty: **Databricks** (prefer serverless / keep a small warmed all-purpose cluster where
serverless is unavailable) and **AML compute instances** for notebook/AML runs (per-user warm
CI with an idle timer), so those backends also hit the sub-20s attach target.

**Source grounding.** Same Fabric starter-pool bar (~5-10s). Loom already proved the AML
per-user CI pattern (memory `csa_loom_aml_zerogate_enablement`: create CI on the Foundry hub,
`LOOM_AML_*`, idle PT30M) and the warm-Spark pattern from PSR-3.

**Current Loom state — PARTIAL.** The warm-pool foundation supports a Databricks kind, and AML
CI warm-start exists as an enablement pattern, but neither is wired as a default warm fast-path
measured by the harness.

**Azure-first / OSS build.** Reuse PSR-3's lease store for the Databricks warm kind; prefer
Databricks **serverless** compute when the workspace exposes it (no warm-keep cost). For AML,
default the per-user CI to warm-with-idle-stop (`LOOM_AML_*`, idle PT30M) with an admin kill
switch. Databricks stays an **opt-in alternate backend**; the AML path is Azure-native default.
Bicep: AML idle-shutdown default confirmed; no new resource type. Gov: AML + Synapse day-one;
Databricks opt-in.

**Acceptance (measured receipt).** PSR-1 shows Databricks-backed and AML-backed notebook attach
under the same sub-20s target on a warm hit; idle-stop proven to return resting cost to ~$0.
Receipt = the PSR-1 rows for both backends.

---

### PSR-5 — AAS warm-cache + result-cache tuning (Direct-Lake outcome-equivalent) — **P1 · M**

**Capability.** Push semantic-model / report query latency toward the Direct-Lake *outcome*
(interactive sub-second on repeat visuals) on the Azure-native default, by (a) keeping the AAS
model warm/primed and (b) tuning the existing always-on result cache for higher hit rates —
**without** claiming the Direct Lake *mechanism* (see §4 non-goals).

**Source grounding.** Direct Lake delivers Import-mode sub-second query via VertiPaq framing +
V-Order (https://learn.microsoft.com/en-us/fabric/fundamentals/direct-lake-overview) — the
hardest Fabric bar and one we target by outcome, not mechanism. `aas-client.ts:885` states the
F-SKU dependency; `query-result-cache.ts` is the honest "pragmatic 80%" mitigation.

**Current Loom state — PARTIAL.** `query-result-cache.ts` is an always-on in-process TTL/LRU
cache keyed `{modelId, compiledSQL, storageMode, freshnessToken}` with an optional Cosmos
cross-replica tier (`LOOM_QUERY_CACHE_COSMOS_CONTAINER`); an opt-in Direct-Lake-shim
(`LOOM_DIRECT_LAKE_SHIM_ENABLED`) approximates freshness via scheduled enhanced-refresh. No
model-warm/prime step and no cache-hit-rate telemetry.

**Azure-first / OSS build.** Add a model-warm step (scheduled enhanced-refresh / keep-alive
query on the AAS model so first-visit cold VertiScan is avoided); enable the Cosmos
cross-replica cache tier by default (so a visual cached by one replica is a Map read on another);
emit cache-hit-rate + p50/p95 to PSR-1. Direct-Lake-shim and any Power BI/AAS-XMLA path stay
opt-in per `no-fabric-dependency.md`. Bicep: cache container + scheduled-refresh timer; no new
resource type. Gov: AAS-native default; Direct Lake honestly gated as F-SKU-unavailable.

**Acceptance (measured receipt).** PSR-1 shows repeat-visual p50 **sub-second** on a cached
model with a reported cache-hit-rate; first-visit p95 improved by the warm/prime step vs the
uncached baseline. The perf page states plainly this is result-cache outcome-equivalence, not
Direct Lake. Receipt = the semantic-query PSR-1 rows + hit-rate.

---

### PSR-6 — ADX result-cache + client cache headers + row-cap paging — **P1 · M**

**Capability.** Cut repeat KQL query latency and honestly handle large result sets: enable
ADX server-side query-results cache, add client cache headers on the BFF tile route, and add
server-side paging/aggregation guidance so the 5,000-row cap is a deliberate contract, not a
silent truncation.

**Source grounding.** ADX supports a native query-results cache (`set query_results_cache_max_age`).
`kusto-client.ts` issues a live `POST /v1/rest/query` per tile with `MAX_ROWS 5000` (line 31)
and no server-side result cache in that client.

**Current Loom state — PARTIAL.** Live per-tile ADX round-trips, no results cache, hard 5,000-row
cap with no paging affordance.

**Azure-first / OSS build.** Set `query_results_cache_max_age` on cacheable dashboard/tile
queries in `kusto-client.ts`; add `Cache-Control`/ETag on the tile BFF route for the tile's
`autoRefreshMs` window; add a server-side paging/aggregate path (and an honest MessageBar) when
a result would exceed `MAX_ROWS`. No new resource. Gov: ADX day-one → identical.

**Acceptance (measured receipt).** PSR-1 shows repeat-tile KQL p50 materially lower with the
results cache warm; a >5,000-row query pages or aggregates instead of silently truncating (with
the honest MessageBar). Receipt = ADX PSR-1 rows before/after cache + the paging walk.

---

### PSR-7 — Dashboard tile parallelization + skeletons + stale-while-revalidate — **P1 · S**

**Capability.** Make dashboard TTI feel Fabric-RTD-class: fetch all tiles in parallel, render
Fluent skeletons immediately, and show last-good data while refreshing (stale-while-revalidate)
so a refresh never blanks the board.

**Source grounding.** Fabric's own Real-Time Dashboard uses poll-based refresh; Loom's tile
path is parity-shaped but adds a BFF hop, so parallelization + SWR recover the perceived TTI.

**Current Loom state — PARTIAL.** `kql-dashboard-editor.tsx` polls tiles on `autoRefreshMs`; no
guaranteed parallel fan-out, skeletons, or stale-while-revalidate.

**Azure-first / OSS build.** Fan tile fetches out concurrently (bounded), render Fluent
skeletons per tile on first paint, keep last-good tile data during refresh. Pure client +
BFF change; reuses PSR-6's cache headers. No backend/bicep. Cloud-agnostic.

**Acceptance (measured receipt).** PSR-1 dashboard-tile-TTI improves vs the sequential baseline;
a refresh shows skeletons then swaps in data with no blank flash. Receipt = tile-TTI PSR-1 rows
+ a Playwright trace of the skeleton→data transition.

---

### PSR-8 — Copilot turn latency SLO + streaming-first budget + router tuning — **P2 · M**

**Capability.** Give the Copilot turn a real latency contract: define **first-token** and
**full-turn** p50/p95 SLOs, ensure streaming-first so first token is fast even when the tool
loop is long, and tune the model router (already shipped) so cheap/fast models serve simple
turns.

**Source grounding.** `fetch-with-timeout.ts` sets a 120s outer ceiling (`LLM_FETCH_TIMEOUT_MS`)
but no p50/p95 SLO exists anywhere. AOAI streaming makes first-token latency the felt metric.

**Current Loom state — PARTIAL.** Streaming-first and a router exist (memory
`csa_loom_ui_aplus_sweep`); no measured turn SLO, no per-turn latency telemetry feeding a target.

**Azure-first / OSS build.** Instrument `aoai-chat-client.ts` to emit first-token + full-turn
latency + tool-count to PSR-1; define first-token p95 and full-turn p95 SLOs; tune the router
thresholds so simple turns take the fast model. No new resource. Gov: AOAI day-one.

**Acceptance (measured receipt).** PSR-1 reports Copilot first-token and full-turn p50/p95
against the defined SLO; a simple turn routes to the fast model (proven in the transparency
badge). Receipt = the Copilot PSR-1 rows + SLO doc entry.

---

### PSR-9 — Next.js route-level code-splitting / TTI budget for heavy editors — **P1 · L**

**Capability.** Cut initial page TTI for the heaviest surfaces (report designer 3,900+ lines,
notebook editor 2,937 lines, pipeline canvas, MCP catalog 2,298 lines) via route-level
code-splitting / dynamic import of heavy sub-trees, with a per-surface TTI budget enforced by
PSR-1's top-10-surface metric.

**Source grounding.** Web-vitals TTI is the felt "does the app feel fast" metric; the heavy
editors are known large bundles from prior sweeps.

**Current Loom state — PARTIAL.** Editors are feature-complete but monolithic; no measured
per-surface TTI budget, no systematic dynamic-import boundary on the heaviest sub-trees.

**Azure-first / OSS build.** Introduce `next/dynamic` boundaries around heavy, below-the-fold
sub-trees (designer panels, Monaco, canvas MiniMap/inspectors), lazy-load on interaction;
measure the top-10 surface TTI in PSR-1 and set a budget in PSR-2. Pure client/bundler change;
no backend/bicep. Cloud-agnostic.

**Acceptance (measured receipt).** PSR-1 top-10-surface TTI improves for the heavy editors vs
baseline and each stays under its PSR-2 budget; full functionality preserved (per `ui-parity.md`
— no capability removed to shrink the bundle). Receipt = the per-surface TTI rows before/after.

---

### PSR-10 — Cosmos RU / partition posture: autoscale advisory + cross-partition audit — **P1 · L**

**Capability.** Turn the Cosmos scale ceiling from an invisible cliff into a managed,
surfaced posture: audit the hottest containers for **cross-partition query patterns** (the
class that burns RU and hits the 5,000 RU/s-per-partition Serverless ceiling), and give admins
an **honest advisory** on when/whether to migrate a container off Serverless to
provisioned-autoscale.

**Source grounding.** Serverless caps at **5,000 RU/s per physical partition** with no
predictable throughput/latency (https://learn.microsoft.com/en-us/azure/cosmos-db/serverless-performance;
https://learn.microsoft.com/en-us/azure/cosmos-db/concepts-limits). `cosmos.bicep` (55-65) chose
Serverless deliberately to dodge the 25-container shared-throughput cap; migrating off is a real
trade-off, not a flag (`disaster-recovery.md` ~136-138).

**Current Loom state — PARTIAL.** Serverless is wired and honest; there is no partition-key
audit, no hot-partition telemetry, and no advisory on the autoscale trade.

**Azure-first / OSS build.** A read-only audit job (`cosmos-client.ts`) that samples per-query
RU charge + partition-key distribution across the busiest containers, flags cross-partition /
hot-partition patterns, and surfaces a per-container advisory on `/admin/performance`
("container X is cross-partitioning on query Y; consider partition-key Z **or** migrate to
provisioned-autoscale"). **Advisory only** — it does not silently flip capacity mode (that's an
operator decision with a real trade-off). Emit hot-partition + RU stats to PSR-1. Bicep: none
new (read-only). Gov: Cosmos day-one.

**Acceptance (measured receipt).** `/admin/performance` shows the RU/partition audit for the
top containers with at least one actionable advisory; a deliberately cross-partition query is
flagged. Receipt = the audit output + the advisory card screenshot.

---

### PSR-11 — ACA autoscale rules: HTTP concurrency tuning + KEDA per-workload rules — **P1 · M**

**Capability.** Right-size the ACA autoscale posture per workload instead of the one-size 50-
concurrent-request default: tune the HTTP concurrency threshold and `maxReplicas` for the
console, and add **KEDA** scalers (queue-length / CPU / custom-metric) for the satellite apps
whose load is not HTTP-concurrency-shaped (runners, orchestrators).

**Source grounding.** `admin-plane/main.bicep` (2522-2523) pins console min2/max6; the shared
default rule (`app-deployments.bicep` 218-226) triggers at `concurrentRequests:'50'` — a
console ceiling of ~300 concurrent requests before queue/503; satellite apps are capped 1-4
(some scale-to-zero). KEDA is the ACA-native autoscale mechanism.

**Current Loom state — PARTIAL.** One shared HTTP concurrency rule + fixed replica bounds;
no KEDA scalers on the queue/CPU-shaped satellites; no load-derived tuning.

**Azure-first / OSS build.** From PSR-14 load-test data, tune the console HTTP concurrency
threshold + `maxReplicas`; add KEDA scale rules (Service Bus queue length for runner/orchestrator
apps, CPU for compute-bound apps) via `app-deployments.bicep`; keep scale-to-zero defaults so
resting cost stays ~$0 (default-ON, cost-bounded posture). Bicep: scaleRules per app; no new
resource type. Gov: ACA + KEDA day-one.

**Acceptance (measured receipt).** PSR-14 load test shows the tuned console sustaining its
target concurrent-user load without 503s at the new threshold; a queue-backed satellite scales
out on Service Bus depth and back to zero when drained. Receipt = the load-test result + the
KEDA scale event.

---

### PSR-12 — Front Door caching rules for static + immutable assets — **P2 · S**

**Capability.** Offload static / immutable asset delivery to Front Door's edge cache so the
ACA origin serves fewer byte-pushing requests, improving both page TTI and origin headroom.

**Source grounding.** Front Door fronts `loom-console` (`msal.ts` 40-67); static Next.js build
assets are immutable-hashed and edge-cacheable; session affinity stays OFF (dynamic routes
uncached).

**Current Loom state — MISSING.** No Front Door caching rules found for static assets; all
requests hit the ACA origin.

**Azure-first / OSS build.** Add Front Door rules-engine rules caching `/_next/static/*` and
other immutable assets (long TTL, respecting hashed filenames), explicitly **not** caching
authenticated dynamic routes (affinity stays off). Bicep: Front Door rules-engine rule in the
admin-plane module. Gov: Front Door day-one in Gov.

**Acceptance (measured receipt).** PSR-1 top-10 TTI improves for cache-eligible assets (edge HIT
observed); dynamic authenticated routes remain uncached (no stale-session leakage). Receipt =
the FD cache-HIT header + the TTI delta.

---

### PSR-13 — Session-store hardening + silent-refresh latency budget — **P2 · S**

**Capability.** Keep the multi-replica session/refresh path correct *and* fast: confirm the
Cosmos-backed MSAL cache is the single source, and put a latency budget on the extra Cosmos
round-trip that every silent-refresh/OBO call pays because affinity is off.

**Source grounding.** `auth/msal.ts` (40-67): min2/max6 behind Front Door, affinity **OFF**,
so silent-refresh round-robins to a random replica; the shipped fix is a Cosmos-backed MSAL
`ICachePlugin` (per-user AES-256-GCM doc) so any replica finds the account — trading one Cosmos
round-trip for cross-replica correctness.

**Current Loom state — PARTIAL.** The Cosmos-backed cache is correct but its added latency is
unmeasured and unbudgeted.

**Azure-first / OSS build.** Emit silent-refresh / OBO latency (including the Cosmos read) to
PSR-1; set a p95 budget in PSR-2; add a short in-memory per-replica LRU in front of the Cosmos
cache (correctness-preserving: Cosmos remains source of truth, LRU is a same-replica fast path)
to shave the common re-hit. No new resource. Gov: Cosmos + MSAL day-one.

**Acceptance (measured receipt).** PSR-1 reports silent-refresh p95 under budget with the LRU
fast-path; correctness preserved (a refresh on a cold replica still resolves via Cosmos).
Receipt = the refresh-latency PSR-1 rows.

---

### PSR-14 — Concurrent-user load tests (Azure Load Testing / k6) — ties to SVC-11 — **P1 · L**

**Capability.** Validate the scale ceilings under real concurrent load: an **Azure Load Testing**
(k6/JMeter) suite that ramps concurrent users against the deployed console + key backends,
proving (or disproving) the ~300-concurrent-request ACA ceiling and feeding PSR-11's autoscale
tuning. Ties to SVC-11 (Chaos Studio reliability panel).

**Source grounding.** No k6/Locust/artillery config exists in the repo today — reliability is
probe + concurrency-threshold, never a measured load test. The ACA ceiling (~300 concurrent
requests) is asserted from bicep, never validated under load.

**Current Loom state — MISSING.** No load-test artifact anywhere.

**Azure-first / OSS build.** An Azure Load Testing config (k6 scripts, minted-session auth)
committed under `scripts/csa-loom/perf/load/`; a workflow that runs a ramp profile against a
non-prod estate and records results into `perf-benchmarks`; surfaced on `/admin/performance` as
a "load test" trend. Bicep: an optional Azure Load Testing resource module (honest-gated if not
provisioned). Gov: Azure Load Testing availability honestly gated per region; k6 scripts are
cloud-agnostic and runnable from the in-VNet CI lane as a fallback.

**Acceptance (measured receipt).** A ramp to the target concurrent-user count runs against the
console; the result documents the actual sustained concurrency + error onset point, feeding
PSR-11. Receipt = the load-test summary (throughput, p95, error rate, breakpoint).

---

### PSR-15 — Quota preflight advisor: estate quota checks with honest surfacing — **P1 · M**

**Capability.** Before a deploy/provision that could hit a subscription quota wall (the class
that produced the DMLZ VM-quota=0 block in memory `csa_loom_multisub_deploy_hardening`), run a
**quota preflight** across the estate's relevant quotas (vCores per VM family, ADX cluster SKU,
Synapse DWU, Cosmos, public IPs, etc.) and surface an **honest advisory** — not a silent failure
mid-deploy.

**Source grounding.** Azure Quotas / Usages REST exposes current-vs-limit per quota. Memory
`csa_loom_multisub_deploy_hardening` records a live provision blocked on DMLZ VM quota=0 — a
preflight would have surfaced it up front.

**Current Loom state — PARTIAL.** Some deploy preflight exists (topology what-if), but no
systematic per-quota advisor that reads live usage and warns before the wall.

**Azure-first / OSS build.** A preflight step (reusing the deploy/setup-orchestrator path) that
queries the Quotas API for the resource families a given deploy/provision will consume, compares
to the plan, and renders a Fluent MessageBar advisory (per `no-vaporware.md`: names the exact
quota + region + current/limit + the "request quota increase" link) when headroom is
insufficient — surfaced in the deploy planner and `/admin/performance`. Read-only; no new
resource. Gov: Quotas API day-one in Gov.

**Acceptance (measured receipt).** Against an estate with a deliberately low quota, the preflight
flags the exact quota + region + current/limit before deploy and links the increase request; an
estate with headroom passes clean. Receipt = the advisory output for both cases.

---

### PSR-16 — SLO definitions + burn-rate alerts on the estate's own Loom (dogfood) — **P1 · M**

**Capability.** Define **formal SLOs** (availability + latency, per the PSR-1 metrics) for the
Console and its critical backends, and wire **multi-window burn-rate alerts** on the estate's
own Loom telemetry — dogfooding the SLO discipline the platform lacks today.

**Source grounding.** `disaster-recovery.md` documents probe-based health + scale thresholds
but **no formal SLOs** — the repo has none. Azure Monitor supports multi-window burn-rate alert
rules over the existing Log Analytics workspace.

**Current Loom state — MISSING.** No SLO doc, no burn-rate alerts.

**Azure-first / OSS build.** A checked-in `docs/fiab/operations/slo.md` defining availability +
latency SLOs (grounded in PSR-1's measured baselines); Azure Monitor scheduled-query burn-rate
alert rules (fast + slow window) over `LoomPerf_CL` / platform telemetry, routing to the
existing alert channel; an SLO/error-budget panel on `/admin/performance`. Bicep: the alert
rules in the admin-plane module. Gov: Azure Monitor day-one.

**Acceptance (measured receipt).** The SLO doc lists each SLO + target derived from a real PSR-1
baseline; a deliberately induced latency breach fires the fast-window burn-rate alert; the
error-budget panel renders remaining budget. Receipt = the alert firing + the panel screenshot.

---

### PSR-17 — Synthetic probes: the UAT harness as a continuous canary — **P1 · M**

**Capability.** Promote the existing in-VNet Playwright **UAT harness** from a per-roll gate to
a **continuous synthetic canary** that runs on a schedule against the live estate, feeding
availability + key-flow latency into the SLOs (PSR-16) and alerting on failure — real synthetic
monitoring, not just a release gate.

**Source grounding.** Memory `csa_loom_uat_harness`: the loom-uat full-visual Playwright job is
the deep-functional E2E path (tracker #1549). Turning it into a scheduled canary is the standard
synthetic-monitoring pattern.

**Current Loom state — PARTIAL.** The UAT harness runs per-roll (and on demand) but is not a
scheduled continuous canary feeding SLOs/alerts.

**Azure-first / OSS build.** A scheduled trigger (ACA Job / cron) running a **canary subset** of
the UAT specs (login + top-10 surface load + one write per critical item) every N minutes against
the live estate; results emitted to `perf-benchmarks` / `LoomPerf_CL` and wired into the PSR-16
burn-rate alerts; surfaced on `/admin/performance` as an uptime/canary strip. Bicep: the
scheduled ACA Job. Gov: ACA Jobs day-one.

**Acceptance (measured receipt).** The canary runs on schedule, posts pass/latency per cycle,
and a deliberately broken surface trips the canary → burn-rate alert. Receipt = two consecutive
canary cycle records + the induced-failure alert.

---

### PSR-18 — Blue-green console rolls — **reference BR-BLUEGREEN (Wave 15)** + perf-gate the health check — **P2 · REF**

**Capability.** Blue-green / canary release for the Console's own ACA image (traffic-split +
health-gate + automated rollback-on-error-rate). **This item does not rebuild BR-BLUEGREEN** —
it references the Wave-15 breadth item and adds the perf/canary glue: gate the traffic-shift on
PSR-17's canary + PSR-16's error-budget so a bad image is caught before full cutover.

**Source grounding.** `WAVES.md` line 370, Wave 15: BR-BLUEGREEN (traffic-split + health-gate)
is tracked, not shipped — today an image roll is a direct in-place PATCH per `app-deployments.bicep`
with only the Startup probe as a gate (no canary weight, no automated rollback).

**Current Loom state — REF (owned by BR-BLUEGREEN).** No blue-green today.

**Build (glue only).** When BR-BLUEGREEN lands, wire the canary-weight cutover to require a
green PSR-17 canary + non-breaching PSR-16 error budget at each traffic step; auto-rollback on
breach. No duplicate infra; references the BR-BLUEGREEN module.

**Acceptance (measured receipt).** A deliberately bad image held at low canary weight trips the
PSR-17 canary and auto-rolls-back before full cutover; a good image promotes through the weights.
Receipt = the canary-gated rollback event. **(Gated on BR-BLUEGREEN shipping first.)**

---

### PSR-19 — Control-plane DR active-passive — **reference BR-CONTROLPLANE-DR (Wave 18)** + RTO/RPO drill — **P2 · REF**

**Capability.** Control-plane multi-region active-passive (Cosmos multi-write + secondary ACA
behind Front Door + failover runbook). **This item does not rebuild BR-CONTROLPLANE-DR** — it
references the Wave-18 breadth item and adds the **measured RTO/RPO failover drill** that proves
the runbook, feeding the honest DR table in `disaster-recovery.md`.

**Source grounding.** `WAVES.md` lines 366/374, Wave 18: BR-CONTROLPLANE-DR is tracked, not
shipped; `disaster-recovery.md` (19-21, 146-157) documents single-region + zone-redundancy only,
region loss "Hours, and gated on opt-ins", and the multi-region trade-off requires migrating
Cosmos off Serverless. No turnkey secondary-region path today.

**Current Loom state — REF (owned by BR-CONTROLPLANE-DR).** Single-region + ZRS/PITR only.

**Build (drill glue only).** When BR-CONTROLPLANE-DR lands, add a scripted failover drill
(promote secondary, measure actual RTO/RPO, fail back) and record the measured numbers into
`disaster-recovery.md`'s RTO/RPO table — replacing the current "Hours, gated on opt-ins" prose
with a measured value. No duplicate infra.

**Acceptance (measured receipt).** A drill fails over to the secondary region, the measured RTO/RPO
is recorded in the DR doc, and fail-back is clean. Receipt = the drill's measured RTO/RPO.
**(Gated on BR-CONTROLPLANE-DR shipping first.)**

---

### PSR-20 — Chaos experiments — **reference SVC-11 (Chaos Studio)** + benchmark-under-fault — **P3 · REF**

**Capability.** Fault-injection experiments (replica kill, dependency latency, region blip) via
Azure Chaos Studio. **This item does not rebuild SVC-11** — it references the Wave-17 Chaos
Studio panel and adds **benchmark-under-fault**: run the PSR-1 suite while a chaos experiment is
active to prove the SLOs (PSR-16) and autoscale (PSR-11) hold under fault.

**Source grounding.** `WAVES.md` line 353, Wave 17: SVC-11 Chaos Studio reliability panel is
tracked. No chaos or fault-injection today.

**Current Loom state — REF (owned by SVC-11).** No chaos experiments today.

**Build (fault-benchmark glue only).** When SVC-11 lands, add a "benchmark under fault" mode that
runs PSR-1 concurrently with a chaos experiment and asserts the error budget + p95 stay within
SLO (or documents the honest degradation). No duplicate infra.

**Acceptance (measured receipt).** With a replica-kill experiment active, PSR-1 runs and the
console stays within (or documents its deviation from) the PSR-16 SLO. Receipt = the
under-fault PSR-1 run + the chaos experiment record. **(Gated on SVC-11 shipping first.)**

---

## 4. Honest non-goals (mechanism-parity we deliberately do NOT chase)

Per the anti-gaslighting posture of `no-vaporware.md`, this pillar is explicit about the Fabric
mechanisms we will **not** reproduce, and the **outcome-equivalent** each maps to. Claiming any
of these mechanisms would be a violation; claiming the outcome-equivalent (with a benchmark
receipt) is the honest target.

| Fabric mechanism (NOT chased) | Why not | Outcome-equivalent we DO ship (with benchmark) |
|-------------------------------|---------|-----------------------------------------------|
| **OneLake substrate** (single tenant-wide storage namespace, shortcuts) | Proprietary Fabric storage fabric; not a sovereign-cloud primitive | **ADLS Gen2 + Delta** as the lake, with Loom-native catalog/lineage over it (per `no-fabric-dependency.md`). Outcome: one governed lake surface; benchmark = lake read/write p50/p95. |
| **Direct Lake engine internals** (VertiPaq in-memory framing + V-Order over OneLake) | Requires a Fabric F-SKU (`aas-client.ts:885`; unavailable in Gov) | **AAS/Serverless + always-on result cache + model-warm** (PSR-5). Outcome: sub-second repeat-visual latency; benchmark = semantic-query p50 cached. **We never claim the Direct Lake mechanism.** |
| **CU smoothing / bursting** (24h background, 5-64min interactive smoothing windows) | Fabric capacity-metering primitive with no Azure-native equivalent | **Admission control + spend caps** (`capacity-guardrails.ts`) + KEDA autoscale (PSR-11) + scale-to-zero cost bounding. Outcome: bounded spend + graceful backpressure; benchmark = load-test breakpoint (PSR-14). |
| **Hyperscale multi-tenancy** (Fabric's shared-capacity SaaS fabric) | Loom is a per-estate deployment, not a shared multi-tenant SaaS | **Per-estate ACA + Cosmos with measured single-estate ceilings** honestly surfaced (PSR-10/11/14). Outcome: known, surfaced ceilings per estate — not an infinite shared pool. |
| **Native Execution Engine** (Gluten/Velox C++ vectorization, up-to-6x TPC-DS) | Fabric-Spark-specific runtime; not portable to Synapse Spark | **Photon opt-in on Databricks (FGC-09, referenced) + Synapse tuning**; Azure-native default stays open-source Spark. Outcome: honestly-gated acceleration where a first-party engine is bound; benchmark = Spark query p50 per backend. |

**The rule this section encodes:** where a mechanism is proprietary, we ship the **number**, not
the **mechanism** — and we say so on `/admin/performance` next to the benchmark. If we can't hit
the outcome, the perf page shows the honest gap (Fabric reference line vs measured), never a
fabricated parity claim.

---

## 5. Cross-references (do not duplicate)

- **BR-BLUEGREEN** (WAVES.md Wave 15) — owned there; PSR-18 adds only the canary/error-budget gate.
- **BR-CONTROLPLANE-DR** (WAVES.md Wave 18) — owned there; PSR-19 adds only the measured RTO/RPO drill.
- **SVC-11 Chaos Studio** (WAVES.md Wave 17) — owned there; PSR-20 adds only benchmark-under-fault.
- **FGC-09** (Native Execution Engine honest-gate + Photon opt-in) / **FGC-10** (high-concurrency
  Spark session pooling) — WAVES.md Wave 17; PSR-3/PSR-4 are the **default-ON + cross-replica**
  companions and the harness that measures them. Coordinate, do not fork.
- **FGC-28** chargeback / **W14** FinOps what-if / **CTS-17** AI spend burn-rate — the cost side
  of the same capacity story; PSR-10/11 surface the perf/scale side on the same `/admin` area.
- **PR #1549** loom-uat harness — PSR-17 promotes it to a continuous canary; reuse, don't rebuild.

---

## 6. Operator actions (new)

- **Cosmos containers** via `createIfNotExists` (no new resource type): `perf-benchmarks`,
  `spark-warm-leases`.
- **Optional Log Analytics DCR + custom table** `LoomPerf_CL` (PSR-1/16/17) — honest-gated to a
  Cosmos-only trend if not provisioned.
- **Azure Monitor** scheduled-query burn-rate alert rules (PSR-16) + the alert action group.
- **Azure Load Testing** resource (PSR-14) — optional; k6 scripts run from the in-VNet CI lane as
  a fallback where Azure Load Testing is not GA in a Gov region (honest-gated).
- **Scheduled ACA Job** for the PSR-17 synthetic canary.
- **Synapse Spark pool auto-pause** confirmed and **AML CI idle-shutdown** default (PSR-3/4) so
  warm-default resting cost stays ~$0.
- **Front Door rules-engine** static-asset caching rule (PSR-12).
- The three REF items (PSR-18/19/20) carry **no new infra** — they ride BR-BLUEGREEN /
  BR-CONTROLPLANE-DR / SVC-11 respectively.

---

## 7. Definition of done (per item)

1. A **measured benchmark receipt** from PSR-1 on a deployed console with
   `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**, showing the before/after delta for the metric the
   item targets (a number, not an adjective).
2. The Fabric outcome-target reference line rendered next to the metric on `/admin/performance`,
   with the honest gap shown where we don't hit it (never a fabricated parity claim).
3. **Bicep-synced** — any new container/table/alert/resource/env var deployed from scratch per
   `no-vaporware.md`.
4. **Dual-cloud** — the same behavior (or an honest region-availability gate) in Commercial and
   Government.
5. **Default-ON, cost-bounded** — warm/autoscale features default on with scale-to-zero / idle-stop
   as the cost bound and an admin kill switch, per the WAVES.md global principle (Fabric F-SKU
   backend the sole opt-in exception).
