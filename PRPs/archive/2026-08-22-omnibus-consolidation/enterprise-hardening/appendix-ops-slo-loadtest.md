# Appendix — Ops Maturity: SLOs, Load/Soak, Observability, Token UX, Startup Hardening

**Domain:** Production operational maturity for 100–60,000 users (ops-slo-loadtest)
**Scope:** CSA Loom `apps/fiab-console` on Azure Container Apps (centralus), Front Door, ACR, Cosmos, Synapse/ADLS/ADX/Databricks/AAS, AOAI, Azure Monitor/LAW/App Insights, Entra/MSAL.
**Cross-cutting rules honored:** no-vaporware, web3-ui, no-freeform-config, no-fabric-dependency, dual-cloud (Commercial + Azure Government GCC/GCC-High/DoD IL4-5).
**Sizing target for every design below:** 60k registered users. Planning assumption: 10% peak concurrency = **6,000 concurrent sessions**, ~1 interactive request / 10s / active session = **~600 RPS sustained**, **3–5× burst = ~3,000 RPS peak**. Copilot/AOAI: assume 3% of concurrent users in an active chat = ~180 concurrent streams at peak.

---

## 0. Current readiness (grounded in code)

| Capability | State | Evidence |
|---|---|---|
| Liveness/Readiness/Startup probes | **STRONG** | `platform/fiab/bicep/modules/admin-plane/app-deployments.bicep` L58-224 codifies the #1382 fix: Liveness (period 30s, fail 3, configurable `livenessInitialDelaySeconds`), Readiness (period 10s, fail 3, delay 5s), explicit Startup probe (period 2s, fail 30 ⇒ 60s grace), `timeoutSeconds=5`, right-sized `1.0cpu/2Gi`. HTTP probes hit `app.healthPath`. |
| Process-alive health endpoint | **STRONG** | `app/api/health/route.ts` — shallow 200, no downstream coupling (correct: a Cosmos blip must not cycle every replica). |
| Deep health endpoint | **ABSENT** | `app/api/health/route.ts` comment promises `/api/health/deep` — **route does not exist**. |
| Front Door health probe path | **WEAK** | `front-door.bicep` L159 `probePath: '/'` (full SSR render) instead of `/api/health`; 30s interval, sampleSize 4 / 3 successful. |
| App Insights / OTel | **PARTIAL** | `lib/telemetry/app-insights.ts` — `@azure/monitor-opentelemetry` behind opt-out gate + crash-guard + Live Metrics hard-disabled (#1382 SIGSEGV mitigation). Wired via `instrumentation.ts`. No custom spans / per-domain dimensions / RED metrics. |
| LAW + Sentinel + default alerts | **PARTIAL** | `monitoring.bicep` (LAW PerGB2018, 90d, 50GB cap, AI Sentinel rules), `monitoring-default-alerts.bicep` (3 LogAlerts: heartbeat-absence, 5xx-count>10, replica-restart>3). **Log-text heuristics, not metric SLIs**; no latency alert; no multi-burn-rate. |
| SLO/SLI / error budget | **ABSENT** | No SLI definitions, no availability/latency target, no error-budget burn. |
| Load + soak harness | **ABSENT** | No k6/JMeter/Azure Load Testing. Only functional Playwright UAT (`loom-uat`). No 60k profile. |
| Token-refresh UX | **WEAK (P0 bug)** | `app/auth/callback/route.ts:261` sets session `exp` from the MSAL **access-token** `expiresOn` (~1h). `lib/auth/session.ts:65` rejects when `payload.exp < now`. Cookie `Max-Age` is 8h but the **payload expires hourly** ⇒ users bounced to login ~hourly. No silent-refresh route. |
| Runtime rate-limit / quota | **ABSENT** | No middleware; AOAI 429 hand-rolled across ~18 clients. |
| Multi-region / BCDR | **ABSENT** | Single region centralus; FD single origin; Cosmos single write region; AZ-redundancy of the ACA env not asserted. |

---

## 1. SLOs / SLIs / Error budgets

### 1.1 SLI catalog (per surface, RED method)

Define SLIs as ratios over Log Analytics `AppRequests` (App Insights) + `ContainerAppConsoleLogs_CL`, sliced by `csa-loom.domain` (see §3.3). Every interactive surface gets its own latency SLI because a Copilot stream and a catalog list have different user expectations.

| SLI | Definition (good / valid) | Target (SLO, 28-day rolling) | Error budget |
|---|---|---|---|
| **Console availability** | non-5xx Front Door responses / total at `/` + `/api/**` | **99.9%** | 40m 19s / 28d |
| **Interactive BFF latency** (catalog, item-list, governance) | `AppRequests` where `Url !~ copilot|editors/load` with `DurationMs ≤ 800` / total | **p95 ≤ 800ms, 99%** | 1% slow budget |
| **Editor-load latency** (phase3/4 editors, report-designer) | editor-load requests `DurationMs ≤ 2500` | **p95 ≤ 2.5s, 95%** | 5% |
| **Copilot first-token latency** | SSE orchestrator TTFB `DurationMs ≤ 3000` | **p95 ≤ 3s, 95%** | 5% |
| **Auth success** | `/auth/callback` + `/api/auth/refresh` 2xx / total | **99.95%** | tight — auth failure = full outage UX |
| **Write durability** (Cosmos item/state writes) | BFF item/state writes returning ok / total | **99.95%** | |

### 1.2 Error-budget burn alerting (Google SRE multi-window multi-burn-rate)

Replace the crude count alerts with **metric-based** `scheduledQueryRules` over `AppRequests`. Two-window, two-burn-rate per SLO:
- **Fast burn**: 14.4× budget consumption over **1h** AND 5m short window ⇒ Sev1 page (consumes 2% of 28d budget in 1h).
- **Slow burn**: 6× over **6h** AND 30m short window ⇒ Sev2 ticket.

This is the canonical pattern and avoids both alert-fatigue (single short window) and slow detection (single long window).

### 1.3 Build spec (code Loom ships)

- **CREATE** `apps/fiab-console/lib/observability/slo-catalog.ts` — typed `SLODefinition[]` (id, surface, sliKql, objective, window, burnRates). Single source of truth consumed by the bicep generator and the `/monitor` SLO tab.
- **CREATE** `apps/fiab-console/lib/observability/slo-kql.ts` — pure functions emitting the LAW KQL for each SLI + burn-rate numerator/denominator (unit-testable, cloud-invariant).
- **CREATE** `apps/fiab-console/app/api/monitor/slo/route.ts` — BFF: runs the SLI KQL via the existing `monitor-client` (Console UAMI already has LAW Reader, `monitoring.bicep` L…`consoleLaReader`), returns `{ok,data:{slos:[{id,attainment,budgetRemaining,burnRate}]}}` with honest gate when LAW unconfigured.
- **CREATE** `apps/fiab-console/lib/components/monitor/slo-pane.tsx` — web3-ui SLO board: one `Card` per SLO (TileGrid), attainment ring (real geometry, not a bar), 28-day budget-remaining `Badge`, burn-rate sparkline; `EmptyState` when no data; styled MessageBar gate. **Wire into** `app/monitor/page.tsx` as a new "SLOs" tab.
- **CREATE** `platform/fiab/bicep/modules/admin-plane/monitoring-slo-alerts.bicep` — generates the fast/slow burn `scheduledQueryRules` (kind LogAlert) over `lawId`, wired to the existing `loom-default-alerts` action group. Day-one-on, `skipSloAlerts` opt-out. Replace nothing in `monitoring-default-alerts.bicep` (keep heartbeat as a coarse backstop); **add** the module call in `main.bicep` next to `monitoringDefaultAlerts`.

### 1.4 Commercial vs Gov
- KQL + scheduledQueryRules identical. Action-group **email/SMS** receivers in Gov route through Gov notification infra automatically (action groups are global but honor the Gov tenant). No endpoint literal in the SLO code.
- LAW `AppRequests` exists in both clouds. The only Gov caveat: `publicNetworkAccessForIngestion` may be forced `Disabled` (IL5) — then SLIs depend on the AMPLS path already documented in `monitoring.bicep`. Honest-gate the SLO pane when ingestion is private and no AMPLS is wired.

### 1.5 Code vs tenant-action
- **Code:** everything in §1.3.
- **Tenant-action (runbook):** operator confirms the action-group receivers (email distro / Teams webhook / PagerDuty). Document in `docs/fiab/runbooks/oncall.md` (§6).

---

## 2. Load + Soak test harness (60k profile)

### 2.1 Approach — Azure Load Testing (managed) + k6/Locust scripts, VNet-injected

Per MS Learn: Azure Load Testing runs JMeter or **Locust**; for private endpoints it must be **VNet-injected** (the Console is behind Front Door + private ACA ingress). RPS math from Learn: `RPS = VUs × (1/latency_s)`. For the **3,000 RPS peak** target at 800ms interactive latency: `VUs = 3000 × 0.8 = 2,400`. Locust/JMeter engines cap ~250 threads each ⇒ **~10 test-engine instances**. Soak: sustained **600 RPS for 2–4h** to surface leaks, Cosmos hot-partition drift, AOAI 429 accumulation, and the OTel layer’s memory behavior.

Prefer **k6** scripts (developer-friendly, scenario stages) executed both (a) locally/CI for smoke and (b) uploaded as **Locust**-equivalent or JMeter to Azure Load Testing for the high-scale VNet run. (Azure Load Testing natively supports JMeter + Locust; k6 is kept for the in-repo dev profile and can be wrapped or converted. Document both.)

### 2.2 Load profiles (stages)

| Profile | Shape | Purpose |
|---|---|---|
| `smoke` | 5 VUs, 1 min | CI gate, every PR |
| `baseline` | ramp 0→600 RPS over 5m, hold 10m | nightly; capture p95 baseline |
| `peak` | ramp to 3,000 RPS over 10m, hold 15m | pre-release; validates ACA scale-out + Cosmos RU + AOAI |
| `soak` | 600 RPS, hold 4h | weekly; leak/drift/429-accumulation |
| `spike` | 600→3,000 in 30s, 3 cycles | autoscaler reaction + cold-replica behavior |

Journeys (weighted): login+session-refresh (10%), catalog browse (35%), open item editor (25%), run an action/BFF write (15%), Copilot chat stream (10%), monitor/admin (5%). Each journey carries a **minted-session cookie** (reuse the `loom-uat` cookie-mint path) so it exercises real `getSession()` + Console UAMI backends, not just the login page.

### 2.3 Build spec
- **CREATE** `tests/load/` with `k6/journeys.js`, `k6/profiles/{smoke,baseline,peak,soak,spike}.js`, and a `locust/locustfile.py` mirror for the Azure Load Testing VNet run.
- **CREATE** `tests/load/README.md` — RPS math, how to mint a session cookie, how to read results.
- **CREATE** `platform/fiab/bicep/modules/admin-plane/load-testing.bicep` — `Microsoft.LoadTestService/loadTests` resource, **VNet-injected** into the hub VNet test subnet, CMK-enabled (Gov/IL5), Key Vault reference for the session secret, server-side metrics linked to the Console ACA + Cosmos + AOAI + LAW. Honest-gated `loadTestingEnabled` (default off — it costs; ops-only).
- **CREATE** `.github/workflows/load-smoke.yml` (k6 smoke on PR) and `load-nightly.yml` (baseline+soak via `az load test` against the VNet resource). Fail criteria: p95 thresholds from §1.1, error rate < 1%.
- **CREATE** `apps/fiab-console/app/admin/load-testing/page.tsx` + `app/api/admin/load-testing/runs/route.ts` — web3-ui pane to launch a profile and read the last run’s client+server metrics from the Load Testing data-plane REST (real backend; honest gate when `LOOM_LOAD_TEST_RESOURCE` unset). No-freeform: profiles are a dropdown, not a JMX textarea.

### 2.4 Commercial vs Gov
- Azure Load Testing **is available in Azure Government** but in a subset of regions — honest-gate by region; OSS substitute where absent: **self-hosted k6/Locust on an ACA Job** (reuse `gh-aca-runner` scale-to-zero pattern) inside the VNet. `load-testing.bicep` branches `useManagedLoadTest` vs `useAcaJobRunner`.
- Endpoints: data-plane host `*.loadtesting.azure.com` (Commercial) vs the Gov equivalent — resolve via the existing `cloud-endpoints.ts` so no literal lands in code.

### 2.5 Code vs tenant-action
- **Code:** scripts, bicep, workflows, admin pane.
- **Tenant-action:** approve the load-test resource cost + grant the test identity reader on the monitored resources; for VNet runs, confirm the test subnet + NSG. Runbook in `docs/fiab/runbooks/load-testing.md`.

---

## 3. Observability — distributed tracing, per-domain usage, crash-loop hardening

### 3.1 Distributed tracing + RED metrics (code Loom ships)

`@azure/monitor-opentelemetry` already auto-instruments incoming HTTP + fetch. Add **semantic dimensions** so traces/metrics are sliceable by domain, surface, and item type — without re-enabling the SIGSEGV-prone Live Metrics path.

- **EDIT** `lib/telemetry/app-insights.ts` — after `useAzureMonitor`, register a span processor that stamps every server span with `csa-loom.domain` (from the resolved domain-tier, §3.3), `csa-loom.surface`, `csa-loom.item_type`, `enduser.id` = oid hash (privacy: hash, never raw UPN). Keep Live Metrics disabled. Keep the crash-guard.
- **CREATE** `lib/telemetry/spans.ts` — tiny helper `withSpan(name, attrs, fn)` + `recordRed(surface, status, durationMs)` emitting an OTel histogram `loom.request.duration` and counter `loom.request.count{surface,domain,status}`. Used by hot BFF routes (catalog, item action, copilot) — additive, behind `isTelemetryEnabled()` so it’s a no-op when telemetry is off.
- **Sampling for 60k:** set OTel parent-based ratio sampling (e.g. 10% of traces, 100% of errors) via `OTEL_TRACES_SAMPLER_ARG` env so 3,000 RPS doesn’t blow the 50GB/day LAW cap. Add `loomTraceSampleRatio` param to `app-deployments.bicep`.

### 3.2 Crash-loop / startup hardening (extend the #1382 fix)

- The telemetry crash-guard is good. **Add** a `/api/health/deep` route (promised but missing): checks Cosmos reachability + LAW token acquisition with a 2s budget, returns 200 `{ok,checks}` always-200-for-liveness-semantics but body reflects degraded deps. Front Door + a synthetic availability test point here; the **Liveness/Readiness probes stay on shallow `/api/health`** (do NOT point liveness at deep — a Cosmos blip must not cycle replicas).
  - **CREATE** `apps/fiab-console/app/api/health/deep/route.ts`.
- **EDIT** `front-door.bicep` L159 `probePath: '/' → '/api/health'` (cheap, no SSR) and add a Front Door **availability** signal feeding the availability SLI.
- **Startup safety net:** wrap the OTel + pylsp init in `instrumentation.ts` so a telemetry init throw can never abort boot (crash-guard installed *before* the native SDK import — already done; assert with a test).
- **CREATE** `apps/fiab-console/lib/telemetry/__tests__/crash-guard.test.ts` — proves a synthetic `monitor-opentelemetry`-tagged `uncaughtException` is swallowed and a non-telemetry one re-throws.

### 3.3 Per-domain usage (multi-domain model already exists)

The repo has `lib/azure/{domain-registry,domain-groups,domain-hierarchy}.ts` + `lib/auth/domain-role.ts` + per-domain chargeback tags. Wire usage telemetry to it:
- **CREATE** `lib/observability/domain-usage.ts` — resolves the caller’s domain (Entra groups claim → `domain-role`), returns the `csa-loom.domain` dimension for §3.1.
- **CREATE** `app/api/monitor/domain-usage/route.ts` + a `/monitor` "By Domain" tab — KQL `summarize by csa-loom.domain` over `AppRequests`/`AppMetrics`: requests, p95, error rate, AOAI tokens, Cosmos RU. Real backend; backs the cost/chargeback story (§ cost-gov sibling).

### 3.4 Grafana (optional OSS, exists as RBAC only)
`grafana-rbac.bicep` grants exist but no dashboards. **CREATE** `platform/fiab/bicep/dashboards/loom-slo-dashboard.json` (Azure Managed Grafana model) + an Azure Monitor Workbook `platform/fiab/bicep/modules/admin-plane/monitoring-workbook.bicep` (the in-portal, Gov-safe default — Managed Grafana availability is thinner in Gov). Day-one workbook; Grafana opt-in.

### 3.5 Commercial vs Gov
- App Insights/OTel exporter targets `*.in.applicationinsights.azure.com` (Commercial) / `*.in.applicationinsights.azure.us` (Gov) — the connection string carries the right host; no code change.
- Azure Managed Grafana: limited Gov regions ⇒ Workbook is the Gov default; Grafana honest-gated.

---

## 4. Token-refresh UX (P0) + session hardening

### 4.1 Root cause (confirmed)
`app/auth/callback/route.ts:261`:
```ts
exp: Math.floor((result.expiresOn?.getTime() ?? Date.now() + 3600_000) / 1000)
```
The session-cookie **payload `exp` = the access-token expiry (~60 min)**. `lib/auth/session.ts:65` returns `null` when `payload.exp < now`, so the BFF treats the user as logged-out ~hourly even though `MAX_AGE_SECS` (cookie Max-Age) is 8h and MSAL still holds a valid **refresh token** in the confidential-client cache (keyed by `homeAccountId`). There is no `/api/auth/refresh`. This is the "sessions expired ~hourly during validation" symptom.

### 4.2 Design — decouple session lifetime from access-token lifetime + silent refresh

The BFF is a **confidential client**; per MSAL Learn, `acquireTokenSilent` transparently uses the cached refresh token (≈24h, sliding via re-issue) to mint fresh access tokens without user interaction. Loom should:

1. **Set the session `exp` to a SESSION lifetime (e.g. 8h), independent of the ~1h access token.** The access token is *not* in the cookie (claims only) — it is re-acquired on demand from the MSAL cache for OBO/downstream calls. So a 1h cookie exp is simply wrong; it should match `MAX_AGE_SECS`.
   - **EDIT** `app/auth/callback/route.ts` — set `exp: Math.floor(Date.now()/1000) + MAX_AGE_SECS` (sliding session), keep claims-only payload.
2. **Add a silent-refresh route** that re-mints the session cookie (sliding window) using the cached account, so a long-lived tab never bounces:
   - **CREATE** `app/api/auth/refresh/route.ts` — `getSession()` → if present and the MSAL cache still has the account (`getTokenCache().getAllAccounts()` by oid), re-issue the cookie with a fresh sliding `exp`; on cache-miss / refresh-token-expired, return `401 {ok:false, reauth:true}` so the client triggers an interactive top-level redirect (per Learn, refresh in a top-level frame because SPA refresh tokens / 3rd-party-cookie limits). Reuses `encodeSessionCookie` + the existing confidential client.
3. **Client-side proactive refresh + graceful 401 handling:**
   - **CREATE** `lib/auth/use-session-keepalive.ts` — a hook mounted in the app shell that calls `/api/auth/refresh` at ~50% of session lifetime and on tab `visibilitychange`/`focus`; on `{reauth:true}` it shows a web3-ui MessageBar "Your session is being renewed…" and does a full-page redirect to `/auth/login?returnTo=…` (top-level, not iframe).
   - **EDIT** `lib/client-fetch.ts` — on a `401 {error:'unauthenticated'}` from a first-party `/api` route, attempt **one** `/api/auth/refresh`; if it succeeds, retry the original request once; if it returns `reauth`, surface the renew banner. This converts the silent hourly logout into a transparent renewal.
4. **Optional longer SSO:** document the tenant-action to raise the **ID-token / session lifetime** via Entra Conditional Access **sign-in frequency** if the org wants > 8h before any interactive prompt (Learn: configurable token lifetimes). This is a tenant policy, not code.

### 4.3 Build spec summary
- EDIT `app/auth/callback/route.ts` (exp = sliding session).
- CREATE `app/api/auth/refresh/route.ts`.
- CREATE `lib/auth/use-session-keepalive.ts`; mount in the root `app/layout` client shell.
- EDIT `lib/client-fetch.ts` (401 → refresh → retry-once).
- CREATE tests: `lib/auth/__tests__/refresh.test.ts` (sliding exp; reauth on cache-miss).
- **Feature flag:** `LOOM_SESSION_SLIDING_ENABLED` (default on) — when off, behavior reverts to the current callback exp, making the change migration-safe/reversible. `LOOM_SESSION_MAX_AGE_SECS` to tune the 8h.

### 4.4 Commercial vs Gov
- Authority host already cloud-switched in `lib/auth/msal.ts` (`login.microsoftonline.us` for Gov). Refresh uses the same confidential client — no endpoint change. Conditional-Access sign-in-frequency is a Gov-tenant admin action documented in the runbook.

### 4.5 Code vs tenant-action
- **Code:** all of §4.3.
- **Tenant-action (optional):** Entra Conditional Access sign-in frequency + token-lifetime policy if > 8h interaction-free is desired. Runbook: `docs/fiab/runbooks/session-lifetime.md`.

---

## 5. Scale to 60k — ACA, Cosmos, AOAI, BCDR, rate-limit (ops slice)

### 5.1 Container Apps right-sizing (the binding constraint today)
Current: `minReplicas:2, maxReplicas:6`, scale rule `concurrentRequests:50` ⇒ **max 300 concurrent requests** — ~10× short of the 3,000 RPS peak.
- **EDIT** `app-deployments.bicep` console app: move to a **Dedicated workload profile** (D4/D8) for predictable latency; `maxReplicas` ≥ **60** (Next.js SSR ~50–100 RPS/replica at 1–2cpu); add a **CPU** scale rule alongside the http rule; raise `concurrentRequests` to ~100 with more replicas. Keep `minReplicas ≥ 2` (zone distribution).
- **Enable zone redundancy** on the ACA managed environment (Learn: set at env creation, immutable; requires `/27`+ subnet) — **EDIT** `container-platform.bicep` to set `zoneRedundant: true`. This is the cheapest 60k availability win.
- Parameterize all of the above (`consoleMaxReplicas`, `consoleScaleConcurrency`, `consoleWorkloadProfile`) so an operator dials cost vs capacity per environment (day-one-on but cost-governed).

### 5.2 Cosmos (workspace/item/state metadata) for 60k
- Per Learn: per **physical partition cap = 10,000 RU/s**; autoscale floor = `0.1 × Tmax`. At ~600 RPS of point reads (~1 RU) + writes (~5–10 RU) the steady RU is modest, but burst + hot-partition risk is real.
- **Partition-key hygiene:** ensure containers partition by `workspaceId`/`domainId` (high-cardinality), never a single global doc — a per-tenant singleton is a hot partition that caps at 10k RU/s regardless of provisioned RU.
- **Enable autoscale + dynamic (per-region-per-partition) autoscale** (`enablePerRegionPerPartitionAutoscale=true`, RP API 2024-11-15) on the Loom Cosmos account — **EDIT** `loom-console-cosmos.bicep`. Set container autoscale `Tmax` ~4,000–10,000 RU/s with **burst capacity** enabled for spikes.
- Add **Normalized RU Consumption** to the SLO/monitor pane (the correct scale signal per Learn, not ProvisionedThroughput).

### 5.3 AOAI for 60k (Copilot)
- ~180 concurrent streams at peak. Standard (PAYG) deployments throttle 429 before quota when traffic is bursty.
- **PTU + spillover** (Learn): provision a **Provisioned-Managed** deployment sized via the capacity calculator, with **spillover** to a Standard deployment so a 429/400-long-context/500 auto-routes — guaranteed latency for the base load, elastic burst on Standard. Honest-gated `LOOM_AOAI_PTU_ENABLED`.
- **Centralize 429 handling:** the `max_tokens→max_completion_tokens` bug lived in all 18 hand-rolled clients — same smell here. **CREATE** `lib/azure/aoai-call.ts` (single chat-completions wrapper: honors `retry-after-ms`, sets `max_completion_tokens` tight per Learn rate-limit best practice, surfaces `x-ratelimit-remaining-*` to telemetry, optional spillover-endpoint redirect) and **incrementally migrate** the 18 callers behind it (one PR each, no big-bang). Set `max_completion_tokens` as close to true generation size as possible — Learn notes loose values throttle prematurely and waste PTU utilization.

### 5.4 Runtime rate-limit / quota middleware (defense-in-depth)
No limiter exists. **CREATE** `apps/fiab-console/middleware.ts` (Next.js edge/runtime middleware) + `lib/ratelimit/limiter.ts` — per-`oid` + per-`domain` token bucket backed by Cosmos (or an in-env cache), returning `429` with `Retry-After` on abuse, and a **per-domain quota** (ties to the capacity SKU / chargeback model). Day-one-on with generous defaults; per-domain overrides via the admin pane (no-freeform: sliders/dropdowns). This protects AOAI + Cosmos from a single runaway domain at 60k.

### 5.5 BCDR (single-region today)
- **Active-passive** is the pragmatic first step (Learn multi-region pattern): second ACA env + Console revision in a paired region, **Front Door** multi-origin with health-probe failover (FD already fronts the Console — add a second origin + origin-group priority). Cosmos: add a **second read region** (and enable multi-region writes only if RPO=0 needed). ACR: **geo-replication** (Premium) or rely on default zone-redundancy.
- Reversible/incremental: ship the second region behind `LOOM_SECONDARY_REGION` param (empty = today’s single-region). Document RTO/RPO targets in the runbook.

### 5.6 Commercial vs Gov (scale slice)
- ACA zone redundancy, Cosmos autoscale, Front Door multi-origin, ACR geo-rep all exist in Gov. **PTU AOAI** availability varies by Gov region/model — honest-gate and fall back to Standard-with-spillover or a smaller PTU; never reach a Commercial AOAI host from Gov. Multi-region pairing must stay within the **authorization boundary** (GCC-High↔GCC-High, IL5↔IL5) — parameterize the paired region, validate against an allow-list of same-boundary regions.

---

## 6. Runbooks + on-call (tenant-action surface)

Create `docs/fiab/runbooks/`:
- `oncall.md` — sev matrix mapped to the §1.2 burn alerts; who-pages-whom; action-group receiver setup (tenant-action); dashboards/workbook links; the §1.1 SLO table as the source of truth.
- `crash-loop.md` — the #1382 playbook: read `ContainerAppSystemLogs_CL`, confirm telemetry-swallow vs real crash, roll back revision, the `/api/health/deep` triage, OOM → bump cpu/mem param.
- `token-refresh.md` — the §4 design, how to verify sliding session, Conditional-Access sign-in-frequency tenant-action.
- `load-testing.md` + `session-lifetime.md` + `bcdr-failover.md` (manual FD origin priority flip + Cosmos failover) + `cost-capacity.md` (dial ACA/Cosmos/PTU/quota per domain).

Each runbook ends with an **honest in-product gate** cross-ref: where the UI surfaces the missing tenant-action (e.g. SLO pane MessageBar when no action-group receiver; load pane gate when `LOOM_LOAD_TEST_RESOURCE` unset).

---

## 7. Acceptance criteria

1. **Token UX:** a session survives ≥ 8h of active use with zero interactive prompts; a 401 on any `/api` route transparently refreshes once and retries; reauth only when the refresh token is truly expired (top-level redirect, not iframe). Proven by a soak journey that idles 90 min then acts.
2. **SLOs:** `/monitor` SLO tab renders real attainment + budget-remaining from LAW; fast/slow burn alerts fire in a synthetic 5xx injection; zero ❌ in `docs/fiab/parity` for the monitor surface.
3. **Load/soak:** `peak` profile sustains 3,000 RPS with p95 within §1.1 and error rate < 1%; `soak` 4h shows flat memory + no RU/429 drift; results visible in the admin Load pane (real Azure Load Testing or ACA-job metrics).
4. **Startup:** `/api/health` shallow + `/api/health/deep` deep both exist; FD probes `/api/health`; crash-guard test green; cold-boot under the startup-probe grace.
5. **Scale:** ACA env zone-redundant, console `maxReplicas ≥ 60` + CPU rule; Cosmos dynamic-autoscale on with sane partition keys; AOAI PTU+spillover honest-gated; rate-limit middleware live.
6. **Dual-cloud:** every new endpoint resolved via `cloud-endpoints.ts`; Gov fall-backs (Workbook vs Grafana, ACA-job vs managed Load Testing, Standard+spillover vs PTU) honest-gated; same-boundary region allow-list enforced.
7. **Migration-safe:** every change behind a flag (`LOOM_SESSION_SLIDING_ENABLED`, `loadTestingEnabled`, `skipSloAlerts`, `LOOM_AOAI_PTU_ENABLED`, `LOOM_SECONDARY_REGION`, scale params) with a documented reversible default.

---

## 8. Priority

- **P0:** §4 token-refresh (the confirmed hourly-logout bug) — smallest change, largest UX impact; §3.2 `/api/health/deep` + FD probe path.
- **P1:** §1 SLOs + multi-burn alerting; §5.1 ACA right-size + zone redundancy; §5.3 AOAI central wrapper + 429; §3.1/3.3 tracing + per-domain usage.
- **P2:** §2 load/soak harness + admin pane; §5.2 Cosmos dynamic-autoscale; §5.4 rate-limit middleware; §5.5 BCDR active-passive; §3.4 Grafana/Workbook; §6 runbooks.

---

## Sources (MS Learn)
- Health probes in Azure Container Apps; Troubleshoot start failures; WAF service guide (probe defaults, slow-start grace).
- Reliability in Azure Container Apps (zone redundancy, active-active replicas, `/27` subnet, min replicas ≥ 2).
- Multi-region App Service / AKS active-active & active-passive with Front Door health-probe failover; ACR zone redundancy + geo-replication.
- MSAL.js / MSAL Node token lifetimes, `acquireTokenSilent`, refresh-token 24h SPA window, top-level-frame reauth, configurable token lifetimes; OAuth2 auth-code refresh.
- What is Azure Load Testing; Configure for high-scale load (RPS = VUs×1/latency; ≤250 threads/engine); VNet injection; JMeter/Locust; CMK.
- Azure OpenAI provisioned throughput, 429 + `retry-after-ms`, spillover traffic management, quota/rate-limit best practices (tight `max_tokens`).
- Cosmos DB autoscale limits (10k RU/s per partition, `0.1×Tmax` floor), dynamic (per-region-per-partition) autoscale `enablePerRegionPerPartitionAutoscale`, burst capacity, scaling best practices / hot partitions.
