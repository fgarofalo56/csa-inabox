# Appendix — Capacity + Cost Governance (`capacity-cost-governance`)

> Enterprise-hardening PRP appendix. Scope: make CSA Loom's "everything-on-day-one"
> principle **affordable and safe at 60,000 users** by adding a metering +
> per-domain cost-attribution layer, a Capacity-Metrics surface, enable-per-domain
> feature toggles, per-domain budgets with soft/hard enforcement, showback/chargeback
> reports, and the Web-5.0 admin UI — all Azure-native, dual-cloud (Commercial +
> Gov GCC/GCC-High/IL4-5), migration-safe behind feature flags, no-vaporware.
>
> Sibling appendices this one composes with (do not duplicate — reference):
> `appendix-rate-limiting-quota.md` (the runtime limiter middleware),
> `appendix-scale-aoai-ptu.md` (AOAI PTU sizing), `appendix-scale-cosmos-data-tier.md`
> (Cosmos autoscale/partitioning), `appendix-multi-domain-acl.md` (domain RBAC tiers),
> `appendix-obo-data-plane.md` (per-user identity). This appendix owns the **cost +
> capacity + per-domain-enablement** layer and the *policy* that drives the limiter.

---

## 1. Executive summary

Loom already has the raw plumbing for cost governance but **none of the policy
layer** that turns it into affordability at scale:

- **Real but coarse cost telemetry.** `lib/azure/cost-client.ts` runs real
  multi-subscription `Microsoft.CostManagement/query` calls (RG × Service ×
  Subscription × Resource × Location), a linear forecast, and lists
  `Microsoft.Consumption/budgets`. It does **not** group by the `loom-domain`
  chargeback tag, so there is no per-domain attribution today.
- **A real multi-domain model with chargeback fields already on disk.**
  `lib/azure/domain-registry.ts` stores, per domain, `capacitySku` (F2–F512),
  `costCenter`, `chargebackTag` (`loom-domain:<id>`), `subscriptionIds`, `dlzRg`,
  `adminGroupId`/`memberGroupId`. `DOMAIN_TAG_KEY = 'loom-domain'` is stamped on
  DLZ resources. This is the spine the whole cost-attribution layer hangs off.
- **A live Capacity page** (`app/admin/capacity/page.tsx` + `/api/admin/capacity/{cost,utilization,viz-config}`) shows per-resource cost + 24h
  Azure Monitor utilization. It has **no per-domain rollup, no AOAI/query/storage
  metering, no budgets-vs-actuals, no enforcement, no enable-per-domain toggles.**
- **No feature-flag / enablement infrastructure** exists (grep for
  `featureFlag`/`isEnabled` returns only incidental hits). "Everything-on-day-one"
  is currently literally everything-always-on with no per-domain off switch.
- **No runtime rate-limiter / quota middleware** exists (no `middleware.ts` at the
  app root; the only 429-handling is *client-side backoff* inside individual Azure
  clients). AOAI chat-completions are hand-rolled across ~18 routes/clients with no
  central metering or per-domain budget hook.
- **Dual-cloud resolver already present.** `lib/azure/cloud-endpoints.ts` resolves
  `AzureCloud | AzureUSGovernment | AzureDOD` hosts (`.usgovcloudapi.net`), and the
  cost client already uses `armBase()/armScope()` — so the attribution layer is
  Gov-ready by construction.

**The gap is the governance/policy layer, not the telemetry primitives.** This
appendix designs seven build-outs (P0–P2) that add: (G1) a per-domain
cost-attribution extension to the cost client + chargeback-tag query path; (G2) a
metering store + collectors (AOAI tokens, query DTU/RU, compute hours, storage GB)
keyed by domain/workspace; (G3) a Capacity-Metrics surface (compute/storage/AOAI/query
per domain); (G4) a per-domain feature-enablement registry + store (default-ON,
domain-admin can disable to save cost); (G5) per-domain budgets + soft/hard
enforcement (throttle → disable on breach) wired to the limiter; (G6)
showback/chargeback report export; (G7) the Web-5.0 admin UI + Copilot. All sized
for 60k users, dual-cloud, migration-safe behind `LOOM_COSTGOV_*` flags.

---

## 2. Grounding (Microsoft Learn — authoritative patterns)

| Pattern | What Learn says we must do | Applied here |
|---|---|---|
| **Cost allocation / chargeback** | Chargeback happens *outside* Azure billing; the supported mechanism is **resource tags + Cost Management Query API grouped by tag**; cost-allocation *rules* need EA/MCA billing-admin (a tenant action, not code). [allocate-costs], [understand-cost-mgt-data] | G1 groups the existing query by the `loom-domain` **TagKey** dimension — no billing-admin needed for *showback*; allocation *rules* are an optional tenant runbook. |
| **Foundry/AOAI project cost attribution** | Foundry auto-tags usage with a `project` tag; filter Cost Analysis by tag for per-project chargeback (Azure-direct/AOAI models only; preview). [foundry/manage-costs] | We mirror this: every AOAI call is attributed to a domain via our own metering (Cost Management lags 8–24h and can't see per-domain when one AOAI resource is shared). |
| **AOAI quota = TPM, rate-limit headers** | Quota is **per-region/per-model TPM**; deployments map TPM→RPM. Every response carries `x-ratelimit-remaining-{requests,tokens}` and `retry-after-ms`. Best practice: read remaining-tokens and **throttle proactively before 429**. [foundry/openai/quota] | G2 metering reads `x-ratelimit-*` + the `usage` block; G5 enforcement throttles a domain *before* it 429s, and pre-empts neighbours under a shared TPM pool. |
| **AOAI PTU** | PTU = reserved capacity (Global/DataZone/Regional Provisioned); sized from RPM + input/output token shapes + cache rate; reservations give term discount. [provisioned-throughput] | Capacity-Metrics surface shows PTU utilization per domain; cost model attributes the *fixed* PTU/reservation cost across domains by metered share. Detail in `appendix-scale-aoai-ptu.md`. |
| **Cosmos autoscale + partitioning** | Autoscale scales `0.1·Tmax ≤ T ≤ Tmax`; bill the hourly peak; **dynamic autoscale** scales per-partition to avoid hot-partition over-scale; pre-provision physical partitions for large ingest; choose a partition key for even RU/storage. [provision-throughput-autoscale], [scaling-provisioned-throughput-best-practices] | The new metering container uses autoscale + a `/tenantId` (or `/domainId`) partition key sized for 60k; high-volume token events go to **ADX**, not Cosmos (§4 G2). |
| **Budgets + automated enforcement** | `Microsoft.Consumption/budgets` evaluate **actual cost once/day**; thresholds (Actual or **Forecasted**) fire **Action Groups** → Logic App / Automation runbook to *take action* (the canonical pattern stops VMs at 80%/100%). Action groups supported at **subscription + RG scope only**. [cost-management-budget-scenario], [manage-automation] | G5: per-domain budget = a Consumption budget scoped to the domain's DLZ **RG** (or sub) + Action Group → Loom enforcement webhook. Because budgets lag a day, Loom *also* runs **near-real-time** enforcement off its own metering (the limiter), with the Azure budget as the authoritative backstop. |
| **Tag governance** | Use **Azure Policy** to enforce/inherit tags at scale; enable **tag inheritance** in Cost Management so RG/sub tags flow into cost data. [tag-policies], [enable-tag-inheritance] | Deploy bundles stamp `loom-domain` on every DLZ resource (already) + an Azure Policy `Modify`/`append` to backfill drift (tenant runbook). |

Gov caveats grounded below in §7.

---

## 3. Current-state readiness (file-level)

| Capability | State | Evidence |
|---|---|---|
| Multi-sub Cost Management query, forecast, budgets list | **Strong** | `lib/azure/cost-client.ts` (373 ln): `getLoomCostSummary`, `costQuery` w/ 429 backoff, `listBudgets`, per-sub error folding, `armBase()/armScope()` Gov-safe |
| Per-domain chargeback fields on the domain doc | **Strong** | `lib/azure/domain-registry.ts`: `capacitySku`, `costCenter`, `chargebackTag`, `DOMAIN_TAG_KEY='loom-domain'`, `domainChargebackTag()` |
| Chargeback tag stamped on DLZ resources | **Partial** | bundles set tags; `grep loom-domain platform/fiab/bicep` → main + admin-plane only; DLZ module stamps via `complianceTags` — needs explicit `loom-domain` wiring + drift policy |
| Capacity inventory + per-resource cost + utilization | **Strong (resource-level)** | `app/admin/capacity/page.tsx` (683 ln), `/api/admin/capacity/{cost,utilization,viz-config}` |
| Per-domain cost rollup / attribution | **Absent** | cost client groups by RG/Service/Sub/Resource/Location — never by tag/domain |
| AOAI / query / compute / storage metering keyed by domain | **Absent** | ~18 hand-rolled AOAI callers, none meter; no metering container |
| Feature-enablement (default-ON, per-domain off) | **Absent** | no flag infra; `envConfigContainer` (`env-config`, `/tenantId`) exists as a host |
| Per-domain budgets + soft/hard enforcement | **Absent** | only reads sub-level Consumption budgets read-only; no create, no enforcement |
| Runtime rate-limiter / quota middleware | **Absent** | no root `middleware.ts`; see `appendix-rate-limiting-quota.md` |
| Showback / chargeback report export | **Absent** | — |
| DLZ-pane RBAC gate (tenant/domain-admin) | **Strong** | `lib/auth/dlz-gate.ts`, `lib/auth/domain-role.ts` (`canAccessDlzPanes`, `administeredDomainIds`) |
| Dual-cloud host resolution | **Strong** | `lib/azure/cloud-endpoints.ts` |

**Overall readiness: partial** — excellent primitives, zero policy/governance layer.

---

## 4. Build-out design (per gap)

Naming: new flags `LOOM_COSTGOV_ENABLED`, `LOOM_COSTGOV_METERING_BACKEND`
(`cosmos`|`adx`), `LOOM_COSTGOV_ENFORCEMENT` (`off`|`soft`|`hard`),
`LOOM_DOMAIN_FEATURE_DEFAULT` (`on`). All default to the **safe, fully-on,
non-enforcing** state so existing deployments are unchanged until an admin opts in.

### G1 — Per-domain cost attribution (P0)

**Architecture.** Extend the cost client with a TagKey-grouped query so spend rolls
up by the `loom-domain` tag, then reconcile against the domain registry to produce a
`DomainCostSummary[]` (domain → MTD actual, forecast, by-service, budget %, costCenter).
Cost Management can group by `{ type:'TagKey', name:'loom-domain' }` and returns the
tag value per row — the same call shape already in `cost-client.ts`, one extra grouping.
Unallocated spend (resources missing the tag) is surfaced as an explicit
`__unallocated__` bucket (never hidden — drives the tag-drift remediation).

**Files**
- **EDIT** `lib/azure/cost-client.ts`: add `getDomainCostBreakdown(opts)` →
  reuses `costQuery`, adds a grouping `[{type:'Dimension',name:'ResourceGroupName'},{type:'TagKey',name:'loom-domain'}]`;
  map tag value → domainId; fold untagged into `__unallocated__`. Keep existing
  `getLoomCostSummary` untouched (additive, reversible).
- **NEW** `lib/azure/domain-cost-client.ts`: joins `getDomainCostBreakdown` with
  `loadOrSeedDomains` (registry) → `DomainCostSummary{ domainId, name, costCenter,
  capacitySku, mtd, forecast, byService, budgetAmount, budgetPctUsed, meteredShare }`.
  Also computes **fixed-cost allocation**: shared capacity (PTU reservation, F-SKU
  capacity, Front Door, admin-plane) split across domains by their metered share
  (from G2) — because a shared AOAI/Cosmos resource has *one* bill but N domains.
- **NEW** `app/api/admin/cost/domains/route.ts`: `GET` → `DomainCostSummary[]`;
  guarded by `getSession()` + `denyIfNoDlzAccess(s,'cost')`. Domain admins see only
  their `administeredDomainIds`; tenant admins see all.
- **NEW** `lib/azure/__tests__/domain-cost-client.test.ts`.

**Backend per control:** real `Microsoft.CostManagement/query` (TagKey grouping).
**Gate:** UAMI needs *Cost Management Reader* per sub (already the cost-tab gate);
in Gov where Cost Management is reduced, fall through to **metered** attribution
(G2) and badge "billing-derived attribution unavailable in this cloud; showing
metered estimate." **60k:** one query per sub per timeframe, cached 1h in
`envConfig`/memory (Cost Management QPU is ~12/10s — reuse the existing limiter).

### G2 — Metering + collectors (P0)

**Architecture.** A unit-of-consumption ledger keyed by `(tenantId, domainId,
workspaceId, meter, ts)`. Two backends behind `LOOM_COSTGOV_METERING_BACKEND`:
- **`cosmos` (default, ≤ small/medium):** new container `consumption-meters`,
  partition `/tenantId`, **autoscale** `Tmax` sized to peak (start 4000 RU/s,
  per Learn pre-provision for ingest), TTL 400 days. Pre-aggregated **hourly
  rollups** are written (not every event) to bound RU + storage at 60k.
- **`adx` (recommended at 60k):** raw high-frequency events (every AOAI call,
  every query) stream to an **ADX** table `ConsumptionEvents` (Loom already runs
  ADX/Kusto; `lib/azure/kusto-client.ts`). KQL does the per-domain/-workspace
  rollups for the surface. This avoids Cosmos RU pressure from token-level events.

**Collectors (instrument the real call sites — no mocks):**
- **AOAI tokens:** a thin wrapper `lib/azure/metering/aoai-meter.ts` that the
  ~18 hand-rolled callers call after each completion, recording `prompt_tokens`,
  `completion_tokens`, model, and the `x-ratelimit-remaining-tokens` header
  (proactive-throttle signal per Learn). Rather than touch 18 files in one PR
  (migration-safe), introduce a **single shared `chatComplete()` helper** in
  `lib/azure/foundry-cs-client.ts` and migrate callers incrementally behind
  `LOOM_COSTGOV_METER_AOAI`; the helper emits the meter event. (This also pays
  down the "18 hand-rolled clients" tech-debt noted in the PRP.)
- **Query (serverless SQL / ADX / Databricks SQL):** record bytes-scanned / RU /
  DBU from the result metadata the query clients already receive.
- **Compute (Spark/AML/dedicated pool):** poll `Microsoft.Synapse`/`Databricks`
  job metrics via the existing Monitor client → compute-hours per workspace.
- **Storage:** daily ADLS/Cosmos size via ARM/Monitor → GB-month per domain.

**Files**
- **NEW** `lib/azure/cosmos-client.ts` container reg `consumptionMetersContainer()`
  (`consumption-meters`, `/tenantId`, autoscale).
- **NEW** `lib/azure/metering/meter-store.ts` (write/rollup; backend switch),
  `lib/azure/metering/aoai-meter.ts`, `query-meter.ts`, `compute-meter.ts`,
  `storage-meter.ts`, `meter-types.ts`.
- **EDIT** `lib/azure/foundry-cs-client.ts` add `chatComplete()` shared helper +
  meter hook (flag-gated).
- **NEW** `app/api/admin/metering/rollup/route.ts` (token-gated internal cron
  target) + a scheduled trigger (ACA Job / cron) to write hourly rollups.
- **NEW** ADX table/function bicep (when `adx` backend) under
  `platform/fiab/bicep/modules/landing-zone/`.

**Why both Cost Management *and* metering:** Cost Management is the **authoritative
money** number but lags 8–24h and cannot see per-domain when one AOAI/Cosmos
resource is shared by many domains. Metering is **near-real-time + per-domain** but
is a *usage estimate* priced via the Price Sheet API. The surface shows both and
labels which is which (no-vaporware honesty). **60k:** ADX backend for raw events;
Cosmos only for hourly rollups.

### G3 — Capacity-Metrics surface (P1)

**Architecture.** A new `/admin/capacity` **Domains tab** (and a `/admin/cost`
landing) showing, per domain/workspace: compute-hours, storage GB, AOAI tokens (+
% of TPM/PTU), query units, MTD $ (billing) vs metered estimate, budget gauge,
capacity SKU. Cards + `LoomDataTable` + `MetricChart` reusing the existing Capacity
page primitives (web3-ui tokens, no raw grids). Drill: domain → workspaces → top
items.

**Files**
- **NEW** `app/admin/cost/page.tsx` (cost-governance landing: per-domain table,
  budget gauges, unallocated banner, showback export button).
- **EDIT** `app/admin/capacity/page.tsx`: add a "By domain" `TabList` view that
  calls `/api/admin/cost/domains` + `/api/admin/metering/summary`.
- **NEW** `app/api/admin/metering/summary/route.ts` → per-domain metered rollups
  (KQL or Cosmos rollup read), guarded by dlz-gate.
- **NEW** `lib/components/admin/domain-capacity-table.tsx`,
  `domain-budget-gauge.tsx` (Fluent v9 + Loom tokens; elevation, icons).

**Backend per control:** ARM + Monitor (existing) + metering store + cost client.
All real; Gov falls through to metered estimate + Managed Grafana embeds (the
Capacity page already does this; Power BI Embedded absent in Gov).

### G4 — Enable-per-domain feature toggles (P1)

**Architecture.** A **feature registry** (static catalog of toggleable Loom
features with a cost-class + a safe default = ON, honoring everything-on-day-one)
+ a **per-domain enablement store** (Cosmos doc, only stores *deviations* from
default, so the default-ON principle is preserved and a fresh tenant has nothing to
configure). A domain admin can **disable** a feature for their domain to save cost
(e.g. turn off PTU-backed Copilot, or auto-pause Spark). Enforcement reads the
effective flag at the BFF boundary.

**Defense-in-depth:** the toggle is checked **server-side** in the relevant BFF
route (e.g. AOAI route returns an honest gate when Copilot is disabled for the
caller's domain), never only hidden in the UI. The *native* cost lever (pausing the
actual Azure resource — Spark auto-pause, scale-to-0 ACA, PTU→PayGo) is applied by
an action, with the flag as the app-layer control plane.

**Files**
- **NEW** `lib/features/feature-registry.ts`: `FEATURES: {id, label, costClass:
  'aoai'|'compute'|'storage'|'query', defaultEnabled:true, nativeLever?: 'pause-spark'|'ptu-to-paygo'|'scale-to-zero'}[]`.
- **NEW** `lib/features/domain-features.ts`: `getEffectiveFeatures(tenantId,
  domainId)` — merge registry defaults with the per-domain deviations doc;
  `setDomainFeature(...)` (domain-admin authz).
- **NEW** container `domainFeatureFlagsContainer()` (`domain-feature-flags`,
  `/tenantId`).
- **NEW** `app/api/admin/domains/[id]/features/route.ts` (GET effective, PATCH a
  toggle; authz = tenant-admin OR domain-admin of `[id]`).
- **NEW** `lib/features/require-feature.ts`: `requireDomainFeature(session,
  featureId)` helper returning an honest 403 gate — call at the top of cost-bearing
  BFF routes (AOAI complete, Spark submit, etc.), flag-gated by `LOOM_COSTGOV_ENFORCEMENT!=off`.

**60k:** effective-flags doc is per-tenant (small), cached; lookups are O(1) map.

### G5 — Per-domain budgets + soft/hard enforcement (P0 policy, P1 hard)

**Architecture (two tiers, both real):**
1. **Authoritative Azure budget (backstop).** Create a `Microsoft.Consumption/budgets`
   scoped to the domain's DLZ **RG** (Action Groups are RG/sub-scope only per Learn),
   with **Forecasted** + **Actual** thresholds (e.g. 80% soft, 100% hard) → an
   **Action Group** webhook → `POST /api/internal/cost/budget-event` (token-gated).
2. **Near-real-time Loom enforcement (because budgets evaluate ~daily).** The
   metering store (G2) computes each domain's run-rate; when projected month-end
   crosses the domain budget, Loom flips an **enforcement state** per domain:
   - `soft` → the limiter (see `appendix-rate-limiting-quota.md`) tightens the
     domain's AOAI TPM / RPS allotment + raises a MessageBar; cost-class features
     keep working but throttled.
   - `hard` → `requireDomainFeature` returns an honest gate for the breaching
     cost-class (e.g. Copilot/Spark) and the native lever fires (PTU→PayGo cap,
     Spark auto-pause). Data reads/governance are never throttled — only the
     elastic cost drivers.

**Files**
- **NEW** `lib/azure/budget-client.ts`: `upsertDomainBudget(domain, amount,
  thresholds, actionGroupId)` → ARM `PUT .../Microsoft.Consumption/budgets/{name}`
  (api 2023-05-01); `listDomainBudgets`. (Extends the read-only `listBudgets` in
  cost-client.) UAMI needs *Cost Management Contributor* on the RG (tenant runbook).
- **NEW** `app/api/admin/domains/[id]/budget/route.ts` (GET/PUT, authz domain-admin).
- **NEW** `app/api/internal/cost/budget-event/route.ts` (token-gated Action Group
  webhook receiver → sets enforcement state).
- **NEW** `lib/cost/enforcement-engine.ts`: run-rate projection + state machine
  (`ok|soft|hard`), persisted to `domain-enforcement-state` container; the limiter +
  `requireDomainFeature` read it.
- **NEW** `lib/cost/enforcement-state.ts` + container `domainEnforcementContainer()`.
- **EDIT** the limiter middleware (owned by `appendix-rate-limiting-quota.md`) to
  consume per-domain enforcement state + budget allotment.
- **NEW** bicep: per-domain budget + Action Group + Logic App webhook bridge in the
  DLZ module (deployed by dlz-attach; flag-gated).

**Safety/migration:** `LOOM_COSTGOV_ENFORCEMENT=off` (default) = monitor-only
(states computed + shown, nothing throttled). `soft` then `hard` are opt-in steps.
Fully reversible — set back to `off`.

### G6 — Showback / chargeback reports (P1)

**Architecture.** Export `DomainCostSummary[]` (+ costCenter, capacitySku, budget,
metered share) to CSV/Parquet for the finance system, and a printable showback view.
Optionally write a monthly snapshot to ADLS Bronze for a Loom-native report
(no Power BI dependency — `report-designer` can read it).

**Files**
- **NEW** `app/api/admin/cost/export/route.ts` (CSV/Parquet; `?format=`).
- **NEW** `lib/cost/showback-report.ts` (builds the dataset, monthly snapshot to
  ADLS via `adls-client`).
- **EDIT** `app/admin/cost/page.tsx`: "Export showback" + "Schedule monthly
  snapshot" controls.

### G7 — Web-5.0 admin UI + Copilot (P1)

Per `web3-ui.md`/`ui-parity.md`/`no-freeform-config.md`: the budget + enablement
config is **wizard/dropdown/gauge driven**, never JSON. A **Cost Copilot** pane
(reuse `OpsCopilotPane` pattern) answers "why did Finance's Copilot spend triple
this week" / "which domain is closest to its budget" / "disable Spark in Sales to
save ~$X" with an approval diff before any toggle or budget change. SSE orchestrator
reusing the existing copilot route pattern; opt-in.

**Files:** `lib/components/admin/cost-copilot-pane.tsx`,
`app/api/admin/cost/copilot/route.ts` (SSE), wired into `/admin/cost`.

---

## 5. Bicep / deploy

1. **Chargeback tag wiring (P0):** ensure the DLZ module stamps
   `loom-domain: <id>` (not just `complianceTags`) on every resource it deploys —
   `platform/fiab/bicep/modules/landing-zone/main.bicep`. Add an **Azure Policy**
   (`Modify`/`append`) assignment to backfill drift on existing resources (tenant
   runbook; needs Policy Contributor).
2. **Metering store (P0):** Cosmos `consumption-meters` container (autoscale) via
   the cosmos init step; when `adx` backend, an ADX table + update policy + KQL
   functions in the DLZ module.
3. **Per-domain budgets (P0/P1):** `Microsoft.Consumption/budgets` (AVM
   `avm/res/consumption/budget/rg-scope`) + Action Group + Logic App webhook bridge,
   deployed per domain by dlz-attach; flag-gated.
4. **Env vars (P0):** add `LOOM_COSTGOV_ENABLED`, `LOOM_COSTGOV_METERING_BACKEND`,
   `LOOM_COSTGOV_ENFORCEMENT`, `LOOM_DOMAIN_FEATURE_DEFAULT`,
   `LOOM_COSTGOV_INTERNAL_TOKEN` to the `apps[]` env list in
   `platform/fiab/bicep/modules/admin-plane/main.bicep` (per no-vaporware bicep-sync).
5. **Role assignments (tenant action — see §6):** Cost Management Reader (showback)
   and Cost Management Contributor (create budgets) for the Console UAMI per sub/RG;
   Monitoring Reader (already used by capacity utilization).

Acceptance: `az deployment sub create -f platform/fiab/bicep/main.bicep -p
params/commercial-full.bicepparam` + bootstrap deploys the metering container + tags
+ (opt-in) budgets, and `/admin/cost` renders per-domain attribution with
`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET (no-fabric-dependency).

---

## 6. Code vs tenant-admin action (runbook)

| Action | Type | Runbook |
|---|---|---|
| Per-domain attribution query, metering, surface, toggles, enforcement engine, reports, UI | **CODE** | ships in Loom |
| Grant Console UAMI **Cost Management Reader** per sub | **TENANT** | `az role assignment create --assignee <uami> --role "Cost Management Reader" --scope /subscriptions/<sub>` — gate shows exact command |
| Grant Console UAMI **Cost Management Contributor** on DLZ RGs (to *create* budgets) | **TENANT** | scope = RG; honest gate in budget UI if absent |
| Cost-**allocation rules** (move shared cost across subs) | **TENANT (EA/MCA billing-admin)** | Learn [allocate-costs]; optional — showback works without it |
| AOAI **PTU quota / reservation** purchase + increase | **TENANT** | quota form (aka.ms/oai/stuquotarequest); detail in `appendix-scale-aoai-ptu.md` |
| Azure **Policy** to enforce `loom-domain` tag at scale | **TENANT (Policy Contributor)** | assign the Modify policy the bicep emits |
| Enable **tag inheritance** in Cost Management | **TENANT** | one toggle; improves attribution of RG/sub-level charges |

Every tenant action has an **honest in-product gate** (Fluent MessageBar naming the
exact role/command/form) per no-vaporware — never a blank cell.

---

## 7. Commercial vs Azure Government

- **Hosts:** all ARM/cost/monitor calls already go through `armBase()/armScope()`
  (`cloud-endpoints.ts`) → `management.usgovcloudapi.net` in Gov; AOAI/Cognitive on
  `*.openai.azure.us`; ADX on `*.kusto.usgovcloudapi.net`; Storage DFS on
  `*.dfs.core.usgovcloudapi.net`. Entra authority = `login.microsoftonline.us`.
- **Cost Management in Gov:** available but with **reduced offers/feature lag**;
  some dimensions/exports differ. Design: when a Gov cost query returns an offer-not-
  supported gate, the surface falls through to the **metered estimate** (G2) and
  badges it — attribution never goes blank.
- **Action Groups / Logic Apps in Gov:** available in GCC-High/IL5 but with the
  usual region constraints; the budget→webhook bridge uses the Gov endpoints. Where
  a Logic App connector is unavailable, substitute an **ACA Job** (OSS) polling the
  Budgets/Query API — same enforcement outcome, no managed-connector dependency.
- **Power BI Embedded** is absent in Gov (the Capacity page already swaps to
  **Managed Grafana** embeds); showback reports therefore render Loom-native /
  Grafana, never Power BI, in Gov.
- **IL4/5:** metering store + budgets are private-only (PE), CMK on the Cosmos/ADX
  accounts (inherit the DLZ CMK posture); no public Cost Management export egress —
  exports land in the in-VNet ADLS account.

---

## 8. Migration plan (incremental, reversible)

1. **Phase 0 (monitor-only, P0):** ship G1 (domain attribution) + G2 metering
   (Cosmos rollups) + read-only `/admin/cost`. `LOOM_COSTGOV_ENABLED=true`,
   `LOOM_COSTGOV_ENFORCEMENT=off`. Zero behavior change — pure visibility. Reversible
   by unsetting the flag.
2. **Phase 1 (toggles + budgets, P1):** G4 enablement registry (all default-ON, so
   no tenant sees a change) + G5 budget *creation* + enforcement engine in
   **monitor-only** (states computed + shown, nothing throttled). Domain admins can
   now *opt* to disable a feature.
3. **Phase 2 (soft enforcement, P1):** `LOOM_COSTGOV_ENFORCEMENT=soft` — limiter
   tightens allotments on breach; nothing hard-fails. Per-domain opt-in.
4. **Phase 3 (hard enforcement, P2):** `=hard` — honest-gate the breaching
   cost-class + native lever. Always reversible to `soft`/`off`.
5. **AOAI metering migration:** the shared `chatComplete()` helper is adopted by the
   ~18 callers **one PR at a time** behind `LOOM_COSTGOV_METER_AOAI`; until a caller
   migrates it simply isn't metered (no breakage). Doubles as the editor/client
   tech-debt paydown.

Each phase is a flag flip; no big-bang, every step reversible.

---

## 9. Acceptance criteria

- `/admin/cost` shows per-domain MTD **billing** cost (Cost Management, `loom-domain`
  TagKey) **and** near-real-time **metered** estimate, with an explicit
  `__unallocated__` bucket — real data, `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- AOAI token usage attributed per domain within minutes (metering), reconciled to
  Cost Management within 24h.
- A domain admin can disable a cost-class feature for their domain; the relevant BFF
  route returns an **honest server-side gate** (not just a hidden button) for that
  domain only.
- A per-domain budget can be created from the UI (wizard, no JSON); breaching it at
  `soft` throttles only that domain's elastic cost drivers; at `hard` gates them; data/governance unaffected.
- Showback CSV/Parquet exports with costCenter + capacitySku + budget columns.
- Gov: every surface renders real or honest-gated values (metered fallback where
  Cost Management/Power BI are reduced) — no blank cells.
- All enforcement reversible via `LOOM_COSTGOV_ENFORCEMENT=off`.
- Real-data E2E receipt in the PR (endpoint + first 300 chars + screenshot) per
  no-vaporware.

---

## 10. Priorities

- **P0:** G1 domain attribution; G2 metering (Cosmos rollups + AOAI meter via shared
  helper); chargeback-tag bicep wiring + UAMI Cost Management Reader gate; read-only
  `/admin/cost` (Phase 0).
- **P1:** G3 Capacity-Metrics domain surface; G4 enablement registry + per-domain
  toggles; G5 budget creation + enforcement engine (monitor → soft); G6 showback
  export; G7 Cost Copilot; ADX metering backend for 60k.
- **P2:** G5 hard enforcement + native levers (PTU→PayGo, Spark auto-pause);
  cost-allocation-rule integration; reservation/PTU amortized split; forecast-driven
  pre-emptive throttling.

---

## Sources (Microsoft Learn)

- Cost allocation / chargeback: learn.microsoft.com/azure/cost-management-billing/costs/allocate-costs
- Cost Management data, tags, retention: .../costs/understand-cost-mgt-data
- Cost Management automation (Query/Exports/Budgets/Alerts APIs): .../manage/cost-management-automation-scenarios
- Budgets + Action Group enforcement (stop-VM pattern): .../manage/cost-management-budget-scenario
- Automate budget creation / manage with automation: .../costs/manage-automation, .../automate/automate-budget-creation
- Consumption budgets ARM (2023-05-01) + AVM module: learn.microsoft.com/azure/templates/microsoft.consumption/2023-05-01/budgets
- Foundry/AOAI project-level cost attribution (project tag): learn.microsoft.com/azure/foundry/concepts/manage-costs
- AOAI quota (TPM/RPM) + rate-limit headers + proactive throttle: learn.microsoft.com/azure/foundry/openai/how-to/quota
- AOAI provisioned throughput (PTU) sizing + reservations: learn.microsoft.com/azure/ai-foundry/openai/how-to/provisioned-throughput-onboarding, .../concepts/provisioned-throughput
- Cosmos autoscale + dynamic autoscale: learn.microsoft.com/azure/cosmos-db/provision-throughput-autoscale
- Cosmos scaling/partitioning best practices: learn.microsoft.com/azure/cosmos-db/scaling-provisioned-throughput-best-practices
- Tag governance: enable-tag-inheritance, azure-resource-manager/management/tag-policies
- FinOps allocation framework: learn.microsoft.com/cloud-computing/finops/framework/understand/allocation
