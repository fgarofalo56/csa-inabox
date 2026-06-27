# CSA Loom — Enterprise-Hardening PRP — Phased Roadmap (Kickoff-Ready)

Companion to [`README.md`](./README.md). Each phase is **independently kick-offable** once its
dependencies are green, and sequenced by dependency: **refactor foundation → security → scale →
BCDR/cost → ops**. Every phase below states scope, source appendices, exact Loom files, Azure +
bicep, Commercial AND Gov, migration/feature-flag plan, Web-5.0 UI, the code-vs-tenant split with
runbook pointers, real-data E2E acceptance, and a one-line "kick off with."

**Cross-cutting law (all phases):** dual cloud (Commercial + Gov `.us`/`.usgovcloudapi.net`, Gov Entra
authority, IL4/5 private-only + CMK, OSS substitutes where Gov lacks a managed service); native
per-user/per-domain enforcement first, app-layer as defense-in-depth; size for 60k; day-one-on but
cost-governed; observe→shadow→enforce flags, fully reversible; no-vaporware / Web-5.0 /
no-freeform-config / no-fabric-dependency. See README §3–§4.

---

## Phase 0 — Refactor foundation + P0 ops fixes (UNBLOCKS EVERYTHING)

**Why first:** the 18k-line editor monoliths and ~18 duplicated AOAI callers are the top
merge-contention surfaces; consolidating them gives every later workstream one place to add
cache/budget/quota and kills the systemic `max_completion_tokens` + Gov-scope-401 bugs. The two P0 ops
bugs (token-refresh, missing deep health) are tiny and bite immediately at scale.

**Draws from:** appendix-refactor-aoai-consolidation, appendix-refactor-editor-split,
appendix-refactor-itemtype-framework (de-dup + naming only), appendix-ops-slo-loadtest (P0 items).

**Files — create:**
`lib/azure/aoai-chat-client.ts`, `lib/azure/aoai-model-contract.ts`,
`lib/azure/__tests__/aoai-model-contract.test.ts`, `lib/azure/aoai-routing.ts`,
`lib/azure/rls-compiler.ts`, `lib/editors/phase3/_shared/{kql-format.ts,kql-visuals.tsx,kql-results.tsx,workspace-hooks.tsx,index.ts}`,
`lib/editors/phase3/{eventhouse,kql-database,kql-queryset,kql-dashboard,eventstream,activator,warehouse,semantic-model,report,paginated-report,dashboard,scorecard,datamart}-editor.tsx`,
`app/api/auth/refresh/route.ts`, `lib/auth/use-session-keepalive.ts`,
`app/api/health/deep/route.ts`, `lib/catalog/adapters/fabric-adapter.ts`,
`scripts/csa-loom/register-loom-typedefs.sh`.

**Files — edit:**
`lib/azure/copilot-orchestrator.ts` (callAoai/aoaiCompleteText/aoaiCompleteJson → wrappers; `orchestrateViaMaf` stays for Gov), `lib/azure/copilot-router.ts`, `lib/azure/foundry-cs-client.ts` (temp-400 fallback), `lib/azure/ai-functions-client.ts` + `lib/azure/help-copilot-orchestrator.ts` (`cogScope()` not literal — fixes Gov 401), `lib/azure/rls-predicate.ts` + `lib/azure/kusto-rls-predicate.ts` (become validators), `app/api/items/semantic-model/[id]/roles/route.ts` + `app/api/items/[type]/[id]/security-roles/route.ts`, `lib/editors/phase3-editors.tsx` (barrel → delete), `lib/editors/registry.ts`, `app/auth/callback/route.ts` + `lib/auth/session.ts` (sliding 8h `exp`), `lib/client-fetch.ts` (401→refresh→retry-once), `platform/fiab/bicep/modules/admin-plane/front-door.bicep` (probePath `/`→`/api/health`), `package.json` (madge circular-dep guard).

**Azure / bicep / deploy:** none net-new infra (source refactor); only the Front Door `probePath`
edit + optional `LOOM_AOAI_DEPLOYMENTS` env scaffold in `admin-plane/main.bicep`.

**Commercial AND Gov:** AOAI client uses `cogScope()`/`getOpenAiSuffix()`/`detectLoomCloud()` so
suffix+scope+authority auto-switch `.com`/`.us`; Responses API available in Gov but **Model Router is
not** → app-layer routing mandatory; editor split carries existing `kusto.windows.net` vs
`kusto.usgovcloudapi.net` and opt-in PBI/Fabric host branching verbatim; build green + browser smoke
once per cloud image.

**Migration / flags:** AOAI client behind `LOOM_AOAI_CLIENT_V2`/`LOOM_AOAI_GATEWAY` (passthrough when
off; migrate orchestrator's 3 fns first as reference, then callers in chunks-of-3); editor split via
re-export barrel (per-editor PR smallest-first, `git revert <sha>` = instant revert); `rls-compiler`
is an invisible internal move (no flag); sliding session behind `LOOM_SESSION_SLIDING_ENABLED`
(default on, off = current behavior).

**Web-5.0 UI:** none net-new; refactor preserves every editor surface byte-for-byte (parity guard).

**Code vs tenant-action:** all CODE. Runbook pointer: `register-loom-typedefs.sh` is the only
operator artifact (idempotent Atlas typedef POST, opt-in Fabric branch only, honest gate).

**Real-data E2E acceptance:** (a) orchestrator chat + a migrated caller return identical bodies with
flag on/off, Commercial and Gov; `max_completion_tokens` present on agent tool-loop. (b) Open each
moved editor → lazy chunk loads → its primary backend action returns real data. (c)
`tsc --noEmit` + `next build` + `madge` green. (d) Session survives >1h idle then a real backend call
(no re-login); `/api/health/deep` returns 200 with degraded body on a forced Cosmos blip.

**Kick off with:** "Create `lib/azure/aoai-chat-client.ts` + `aoai-model-contract.ts`, migrate the 3
orchestrator fns behind `LOOM_AOAI_CLIENT_V2`, and prove byte-identical parity Commercial+Gov — per
appendix-refactor-aoai-consolidation."

---

## Phase 1 — Security foundation (OBO data-plane + multi-domain ACL + item manifest)

**Why second:** defensible per-user identity + a real authorization decision are prerequisites for
caching keyed on principal, per-domain budgets, audit, and source-enforced RLS/CLS. Built on Phase 0's
clean base.

**Draws from:** appendix-obo-data-plane, appendix-multi-domain-acl, appendix-refactor-itemtype-framework
(manifest registry + per-item RBAC/cost/cloud descriptor).

**Files — create:**
`lib/azure/data-access-mode.ts`, `lib/azure/adls-user-client.ts`, `lib/azure/storage-user-token-store.ts`,
`lib/azure/kusto-user-token-store.ts`, `lib/azure/user-pool-registry.ts`, `lib/azure/domain-credential.ts`,
`lib/auth/pdp/{resource-ref,evaluate,context-loader,authorize}.ts`, `lib/auth/pdp/__tests__/evaluate.test.ts`,
`middleware.ts` (defense-in-depth edge), `lib/azure/onelake-rls-reconciler.ts`,
`lib/azure/protection-policy-client.ts`, `lib/azure/protection-policy-reconciler.ts`,
`lib/azure/workspace-identity-client.ts`, `lib/azure/managed-pe-client.ts`, `lib/azure/access-audit-client.ts`,
`lib/items/manifest/{types,registry,derive,compat}.ts`, `lib/items/manifest/domains/*.ts`,
`lib/items/provisioner-factories.ts`, `lib/items/manifest/__tests__/manifest.invariants.test.ts`,
`app/admin/access-audit/page.tsx` + `app/api/admin/access-audit/route.ts`,
`app/api/items/[type]/[id]/onelake-security/[role]/rls/route.ts` + `.../cls/route.ts`,
`app/api/items/[type]/[id]/endorse/route.ts`.

**Files — edit:**
`app/api/items/report/[id]/query/route.ts` (accessMode==='user' branch — the brief's first migration
target), `lib/azure/report-model-resolver.ts`, `lib/azure/{kusto-client,aas-client,aas-xmla,synapse-sql-client,cosmos-client}.ts`,
`lib/azure/mcp-obo-token-store.ts` + `lib/auth/msal.ts` (capture storage/kusto/aas audiences at login),
`lib/auth/domain-role.ts`, `lib/azure/onelake-security-rules.ts`, `lib/panes/onelake-security-tab.tsx`,
`lib/panes/networking.tsx`, `lib/azure/label-protection.ts`, `lib/types/workspace.ts`,
`lib/editors/phase3-editors.tsx` (endorse badge) + `lib/editors/registry.ts`,
`app/api/items/[type]/[id]/permissions/route.ts`.

**Azure / bicep / deploy:**
`platform/fiab/bicep/modules/landing-zone/{workspace-identity,managed-private-endpoint}.bicep` (new),
`platform/fiab/bicep/modules/landing-zone/main.bicep` (per-domain UAMI module + orchestrator wiring),
`platform/fiab/bicep/modules/admin-plane/synapse-storage-rbac.bicep` (protection-policy grants),
`platform/fiab/bicep/modules/admin-plane/main.bicep` (OBO flags env). Azure services: Synapse
serverless+dedicated, ADLS Gen2/Delta, ADX/Kusto, AAS XMLA, per-workspace + per-domain UAMI, Storage
resource-instance rules, managed VNet + private endpoints, Log Analytics, ACA Jobs (reconcilers).

**Commercial AND Gov:** Gov audiences `database.usgovcloudapi.net`, `storage.azure.us` /
`dfs.core.usgovcloudapi.net`, `kusto.usgovcloudapi.net`; Entra `login.microsoftonline.us`.
**Protection-policy default = `sovereign-rbac`** (pure ADLS RBAC + DENY-by-omission + ADX RLS, NO
Purview) — the **only** mode in GCC-High/IL5 where Purview protection policy + Graph rights filter
degrade; item-stored label replaces Graph `usageRightsInfo`. Storage resource-instance rule is ARM-only
per Learn. IL5 = private-only + CMK + mandatory managed PE.

**Migration / flags:** `LOOM_OBO_DATA_PLANE=off|shadow|on` (service branch unchanged → default
byte-identical; shadow logs would-have-403 for consent-coverage); `LOOM_PDP_ENFORCE=shadow|enforce`
(logs PDP-vs-legacy divergence, flip per-domain); protection reconciler shadow→converge
(`LOOM_PROTECTION_POLICY_MODE`); `LOOM_PER_WORKSPACE_IDENTITY` for NEW workspaces only (shared-UAMI
fallback, batch backfill); `LOOM_ITEM_MANIFEST_REGISTRY` (OFF=legacy source, ON=manifest projection,
dual-mode CI proves deep-equal before flip). Per-user pools: LRU with `LOOM_MAX_USER_POOLS` cap + idle
eviction + per-replica `LOOM_MAX_CONCURRENT_USER_QUERIES` semaphore (honest 429).

**Web-5.0 UI:** Row/Column-security WYSIWYG sub-dialogs in the OneLake security pane (no JSON);
Access-audit Governance page (filter + CSV export routed through `label-protection.checkExport`);
Promote/Certify badge + dialog (Certify gated on domain `certifierGroupId`); managed-PE self-service
card in networking pane — all Fluent v9 + Loom tokens.

**Code vs tenant-action:** CODE = all clients, PDP, reconcilers, manifest, UI. TENANT-ACTION
(runbook + honest gate): delegated `user_impersonation` consent + Entra-group→source GRANT mapping via
new `scripts/csa-loom/grant-storage-delegated-permission.sh` + `grant-adx-delegated-permission.sh`
(extend the `grant-sql-delegated-permission.sh` pattern) and `docs/fiab/v3-tenant-bootstrap.md`;
foreign-sub managed-PE approval. In-product consent-coverage tile fed by shadow-mode logs.

**Real-data E2E acceptance:** with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — (a) a report run as user A
returns A's RLS-filtered rows from Synapse/ADX/AAS, user B different rows, receipt echoes
`accessMode`+`executedBy`; token-miss → honest 403. (b) PDP `evaluate()` unit suite green
(grant/deny precedence, OneLake UNION-of-roles/INTERSECTION-within-role, RLS/CLS/export obligations).
(c) OneLake RLS/CLS reconciler materializes a Synapse `SECURITY POLICY` + ADX `row_level_security` and
a real query reflects it. (d) Manifest invariants test bars `backend==='fabric'` default + missing
editor export + Gov-allowed Fabric. Commercial and Gov both.

**Kick off with:** "Add the `accessMode==='user'` branch to the report `/query` route + create
`data-access-mode.ts` and `storage-user-token-store.ts` behind `LOOM_OBO_DATA_PLANE=shadow`, with
Gov audiences — per appendix-obo-data-plane."

---

## Phase 2 — Scale tier (Cosmos + query caching/governor + AOAI PTU + rate-limiting)

**Why third:** the metadata, query, AI, and ingress tiers all buckle below 60k. Built on the Phase-0
AOAI chokepoint + Phase-1 per-user identity (cache keys + budgets need the real principal). The four
sub-streams (2A–2D) share the Redis + Cosmos substrate and can run in parallel once 2A's Cosmos
provisioned account + 2D's Redis are stood up.

**Draws from:** appendix-scale-cosmos-data-tier, appendix-scale-query-caching, appendix-scale-aoai-ptu,
appendix-rate-limiting-quota.

### 2A — Cosmos data tier
**Files:** `platform/fiab/bicep/modules/landing-zone/{cosmos,cosmos-projector-func,cosmos-dedicated-gateway}.bicep`,
`apps/fiab-console/lib/azure/{cosmos-client,cosmos-data-client}.ts`,
`apps/fiab-console/app/api/items/_lib/item-crud.ts`, `app/api/search/items/route.ts`,
`apps/fiab-console/lib/azure/item-state-blob.ts` (new), `functions/loom-cosmos-projector/`,
`app/admin/scale/cosmos/page.tsx` + `lib/admin/cosmos-capacity.tsx` + `app/api/admin/cosmos-migration/route.ts`.
**Work:** Serverless→Provisioned-autoscale **side-by-side** new account (in-place unsupported) +
cross-account change-feed copy + flag-gated `LOOM_COSMOS_ENDPOINT` repoint; `items` PK →
hierarchical `[/tenantId,/workspaceId,/id]` via `items-v2` dual-write + change-feed backfill +
shadow-read verify + `LOOM_ITEMS_BACKEND` cut-over; add `c.tenantId=@t` predicate to all hot
cross-partition reads (`LOOM_ITEMS_TENANT_SCOPED`); custom indexing policy (exclude `/state/*`); TTL
on notifications/search-history/downloads/jobs (audit → change-feed archive to ADLS, never TTL);
state>1.5MB → ADLS offload + `{_stateRef}` pointer; **honest serverless gate** on the throughput dial
(fixes the silent no-op no-vaporware defect); change-feed projector replaces inline fire-and-forget;
optional dedicated-gateway integrated cache.

### 2B — Query concurrency + caching
**Files:** `lib/azure/{result-cache-client,redis-endpoint}.ts`, `lib/query/{cache-key,cached-execute,concurrency-governor,query-budget-store,row-budget}.ts`,
`lib/components/query/ThrottleBanner.tsx`, `app/api/adx/_shared.ts` + sqldb/preview + serverless + aas DAX paths,
`lib/azure/{kusto-client,synapse-workload-group-client,synapse-serverless-cost-client,aas-scaleout-client}.ts`,
`lib/azure/materialized-lake-view-engine.ts` + `lib/query/cache-warmer.ts` + `app/api/internal/cache/prewarm/route.ts`,
`platform/fiab/bicep/modules/shared/result-cache.bicep`, `middleware.ts` (shared with 2D).
**Work:** RLS-aware result cache keyed on `sha256(engine|datasetId|datasetVersion|normalizedQuery|principalDigest)`
(principalDigest = loom_user + sorted domain/group IDs — never serves A's rows under B's key) + staleness-class
TTL + datasetVersion invalidation + circuit-breaker; token-bucket admission control per-user/per-domain with
per-engine lanes under Learn ceilings (Synapse 128, ADX cores×10, AAS QPU) + 429 + Retry-After + ThrottleBanner;
source-side native controls (ADX request-rate-limit-policy + weak consistency + results-cache, Synapse dedicated
workload groups, serverless daily TB cost limit, AAS scale-out replicas); materialized-lake-view as **default**
storage mode for shared dashboards + pre-warm scheduler.

### 2C — AOAI PTU + AI cost
**Files:** `lib/azure/{aoai-gateway,aoai-routing,aoai-token-budget}.ts` (gateway extends Phase-0 client),
`platform/fiab/bicep/modules/admin-plane/{ai-foundry,main}.bicep`, `lib/types/{copilot-config,tenant-settings}.ts`,
`app/api/admin/ai-capacity/route.ts` + `lib/components/admin/ai-capacity-pane.tsx` + `lib/copilot/capacity-tools.ts`.
**Work:** PTU deployment (Commercial GlobalProvisionedManaged any model / Gov ProvisionedManaged gpt-4o
regional usgovvirginia|arizona) sized via Foundry Capacity Calculator (base 300–600 PTU, PayGo peak) +
Standard spillover (native Commercial / app-layer 429-retry Gov); model routing cheap↔frontier (managed
Model Router Commercial / app-layer mandatory Gov); per-domain/per-user token budget (APIM GenAI gateway
`llm-token-limit`+`quota-by-key` native boundary + Cosmos ledger defense-in-depth); semantic cache
(`llm-semantic-cache` on Managed Redis Commercial / OSS Redis Stack on ACA Gov) + Batch (Commercial /
p-limit queue Gov).

### 2D — Rate-limiting / quota
**Files:** `lib/ratelimit/{redis-client,token-bucket,policy,guard,limits-config,cosmos-quota,aoai-fetch,aoai-accounting}.ts`,
`middleware.ts`, `app/admin/rate-limits/page.tsx` + `app/api/admin/rate-limits/route.ts` + `.../usage/route.ts`
+ `app/api/me/quota/route.ts` + `lib/components/ratelimit/quota-banner.tsx`,
`platform/fiab/bicep/modules/admin-plane/{redis-ratelimit,front-door}.bicep` + `cosmos-client.ts` (new
`rate-limit-config` + `rate-quota` containers, PK `/scopeKey`=tenant:domain).
**Work:** three-tier defense-in-depth (Front Door/AppGW WAF per-IP RateLimitRule → app guard
per-user/workspace/domain via Redis token-bucket+sliding-window → resource accounting); shared
`aoaiChatCompletion()` chokepoint charging est tokens pre-call + reconciling `usage` post-call + honoring
`retry-after-ms`; Node runtime middleware (session cookie is AES-256-GCM, not edge-safe).

**Commercial AND Gov (whole phase):** Cosmos provisioned-autoscale + multi-region GA both clouds (Gov
CMK + private-only IL4/5); **Redis** — Commercial Azure Managed Redis Enterprise / Gov Azure Cache for
Redis **Premium classic** `*.redis.cache.usgovcloudapi.net` (Managed-Redis-Enterprise is Public-only) +
PE + CMK, or **OSS Redis/KeyDB on AKS** where managed cache is disallowed; AOAI Gov
usgovvirginia/arizona, no Model Router/native-spillover/Batch → app-layer substitutes; ADX/Synapse/AAS
Gov hosts via `cloud-endpoints.ts`; Front Door rate-limit may be constrained in Gov → AppGW WAF v2
fallback (`app-gateway.bicep` exists).

**Migration / flags:** `LOOM_COSMOS_HA_MIGRATION` off→shadow→cutover; `LOOM_ITEMS_BACKEND` /
`LOOM_ITEMS_TENANT_SCOPED`; `LOOM_RESULT_CACHE=off` default pass-through (one route at a time);
`LOOM_QUERY_GOVERNOR=observe→enforce` per-domain; `LOOM_AOAI_GATEWAY` passthrough; budgets observe→shadow→enforce;
`LOOM_RATELIMIT_MODE=observe→enforce` (fail-open reads / fail-closed provision+export; ships no-op with honest
MessageBar until `LOOM_RATELIMIT_REDIS_HOST` set). All reversible.

**Web-5.0 UI:** Cosmos capacity/cost cockpit (dials/charts + hot-partition radar + migration wizard),
storage-mode segmented control + pre-warm wizard, QueryBudget wizard (`/admin/cost-governor`), AI-capacity
pane (live PTU utilization + per-domain spend + budget sliders), rate-limits wizard (`/admin/rate-limits`
per-domain cards + capacity-SKU F2–F512 defaults) + quota-banner — all Fluent v9, no free-form JSON.

**Code vs tenant-action:** CODE = all clients, middleware, caches, UI, bicep. TENANT-ACTION (runbook +
gate): PTU/provisioned-managed quota request (`aka.ms/oai/stuquotarequest` / `aka.ms/AOAIGovQuota`);
capacity-ceiling numbers (PTU count, DWU, ADX cores, AAS replicas, daily TB cap) are tenant cost decisions
behind honest gates (AllDatabasesAdmin/db_owner); Redis/Cosmos-gateway provisioning; WAF rule is bicep but
threshold tuned from Log Analytics in Detection before Prevention.

**Real-data E2E acceptance:** (a) Cosmos hot reads carry a PK predicate (no fan-out), throughput dial works
on the provisioned account, `items-v2` shadow-read matches; the dial shows the honest gate on a serverless
account. (b) Identical query by users A and B returns correctly-filtered rows and never crosses cache keys;
governor sheds load with 429+Retry-After at the lane ceiling. (c) PTU deployment serves chat; forced 429
spills to Standard (Commercial native / Gov app-layer); per-domain budget exhaustion → honest MessageBar.
(d) Burst past a domain's RPM → 429 + `RateLimit-*` headers; AOAI chokepoint normalizes
`max_completion_tokens` + honors `retry-after-ms`. Commercial and Gov.

**Kick off with:** "Stand up the Provisioned-autoscale Cosmos account + Redis (`redis-ratelimit.bicep`),
then land `result-cache-client.ts` + `concurrency-governor.ts` + `middleware.ts` behind
`LOOM_RESULT_CACHE=off` / `LOOM_QUERY_GOVERNOR=observe` — per appendix-scale-cosmos-data-tier + appendix-scale-query-caching."

---

## Phase 3 — Resilience & economics (BCDR multi-region + capacity/cost-governance)

**Why fourth:** BCDR reuses the Phase-2 Cosmos-provisioned account (Serverless can't geo-replicate) and
cost-governance reuses the Phase-2 metering substrate + `loom-domain` chargeback tag. Both are
multi-region/economic layers over a now-scalable base.

**Draws from:** appendix-bcdr-multi-region, appendix-capacity-cost-governance.

### 3A — BCDR multi-region
**Files:** `platform/fiab/bicep/modules/landing-zone/cosmos.bicep` + `admin-plane/loom-console-cosmos.bicep`
+ `bicep/main.bicep`, `lib/azure/{cosmos-client,cosmos-failover-client,storage-failover-client,kusto-arm-client}.ts`,
`lib/migrations/cosmos-serverless-to-autoscale.ts`, `admin-plane/aca-console-secondary.bicep` +
`front-door.bicep` + `app/api/health/deep/route.ts` (Phase-0 deep probe drives FD failover),
`landing-zone/adx-secondary.bicep` + ADLS module (GZRS/GRS+CMK), `lib/azure/domain-registry.ts` +
`lib/azure/azure-regions.ts` + `lib/editors/{dr-residency-wizard,dr-dashboard}.tsx` +
`app/admin/bcdr/page.tsx` + `app/api/admin/domains/[id]/dr/route.ts` + `app/api/admin/bcdr/drill/route.ts`,
`admin-plane/registry.bicep` (ACR geo-replication) + KV module (soft-delete/purge assertion),
`docs/fiab/bcdr/{failover-runbook,rto-rpo-targets}.md`.
**Work:** Cosmos paired read region + PPAF (RTO<3min, RPO=0); multi-region ACA warm-standby + FD
multi-origin priority failover on the deep probe (<90s); ADLS GZRS/GRS+CMK + ADX active-passive 2nd
cluster (Gold/Platinum) or continuous-export→GRS recovery (Silver) + Synapse geo-backup; data-residency-per-domain
(`cloud`/`residencyGeo`/`secondaryRegion`/`drClass` + `assertResidency` + bicep `@allowed`); RTO/RPO table
+ reversible drill tooling (Cosmos manual failover+auto-failback, storage account-failover) gated by
domain-admin RBAC + type-to-confirm.

### 3B — Capacity / cost governance
**Files:** `lib/azure/{cost-client,domain-cost-client,budget-client,metering/*}.ts`,
`lib/cost/{enforcement-engine,enforcement-state,showback-report}.ts`,
`lib/features/{feature-registry,domain-features,require-feature}.ts`, `lib/azure/cosmos-client.ts`
(consumption-meters + domain-feature-flags containers, autoscale `/tenantId`),
`app/admin/cost/page.tsx` + `app/admin/capacity/page.tsx` (By-domain tab) +
`app/api/admin/{cost/domains,metering/{rollup,summary},cost/export,cost/copilot,domains/[id]/{features,budget}}/route.ts`
+ `app/api/internal/cost/budget-event/route.ts`, `lib/components/admin/{domain-capacity-table,domain-budget-gauge,cost-copilot-pane}.tsx`,
`platform/fiab/bicep/modules/landing-zone/main.bicep` (stamp `loom-domain:<id>` on every resource) +
`admin-plane/main.bicep` (LOOM_COSTGOV_* env).
**Work:** per-domain cost attribution (Cost Management `TagKey:loom-domain` grouping + `__unallocated__`
+ fixed-cost split); unit-of-consumption metering ledger (AOAI tokens/query-units/compute-hours/storage-GB,
Cosmos rollups default / ADX raw at 60k); enable-per-domain feature toggles (store only deviations from
default-ON); per-domain Azure Consumption budgets + near-real-time soft/hard enforcement engine
(data/governance never throttled); showback/chargeback CSV/Parquet + ADLS Bronze snapshot →
Loom-native report; Cost Copilot (SSE + approval-diff before any mutation).

**Commercial AND Gov:** same-cloud region pairs only (centralus→geo pair; usgovvirginia→usgovtexas;
usdodeast→usdodcentral); Cosmos `documents.azure.us`; FD Premium `*.azurefd.us`; **GZRS needs AZ — only
usgovvirginia has AZs in Gov** (else GRS); EH data geo-replication is Premium/Dedicated, may be absent in
Gov → geo-DR(metadata)+dual-ingest or OSS Kafka MirrorMaker; ACR geo-replication + KV soft-delete/purge GA
in Gov+DoD (CMK keys in-boundary IL5); Cost Management reduced in Gov → fall through to metered estimate +
badge it; Gov render = Loom-native / Managed Grafana, never Power BI Embedded; probe PPAF availability in
DoD → honest gate.

**Migration / flags:** `LOOM_COSMOS_HA_MIGRATION` off→shadow→cutover→done (reversible until done);
`consoleDrClass`/`storageRedundancy`/`secondaryRegion` params (Bronze default = today single-region);
`LOOM_COSTGOV_ENABLED` (additive, `getLoomCostSummary` untouched); `LOOM_COSTGOV_METERING_BACKEND`
(cosmos|adx); AOAI metering per-caller behind `LOOM_COSTGOV_METER_AOAI`; `LOOM_DOMAIN_FEATURE_DEFAULT`
(all default-ON → no tenant change); `LOOM_COSTGOV_ENFORCEMENT` off→soft→hard. Purge-protection is
irreversible → operator-confirmed in the wizard.

**Web-5.0 UI:** DR+residency wizard + DR posture dashboard (TileGrid, DR class / target RTO-RPO / write
region / last-sync RPO, type-to-confirm drills); `/admin/cost` landing + Capacity By-domain tab (budget
gauges, billing-vs-metered, drill domain→workspace→item); Cost Copilot pane — all Fluent v9, dropdowns/sliders/gauges,
no JSON.

**Code vs tenant-action:** CODE = clients, engines, UI, bicep, migration. TENANT-ACTION (runbook + gate):
UAMI Cost Management Reader per sub; Azure Policy `Modify` tag-backfill assignment (Policy Contributor); KV
purge-protection enablement; PPAF/region-pair availability confirmation in DoD; action-group receiver setup;
foreign-sub PE approval. Runbooks: `docs/fiab/bcdr/failover-runbook.md`, `rto-rpo-targets.md`, plus the
cost-governance section of `v3-tenant-bootstrap.md`.

**Real-data E2E acceptance:** (a) Cosmos manual-failover drill flips write region and auto-fails-back, audit
records it; FD fails over to the 2nd ACA origin on a forced deep-probe failure (<90s). (b) A USGov domain is
**rejected** from a Commercial secondary region at both API (`assertResidency`) and bicep (`@allowed`). (c)
`/admin/cost` shows real per-domain spend grouped by `loom-domain` tag with an `__unallocated__` bucket; a
domain crossing its budget enters soft then hard state and throttles only elastic drivers; showback export
opens as a real CSV. Commercial and Gov.

**Kick off with:** "Migrate `cosmos.bicep` + `loom-console-cosmos.bicep` Serverless→Autoscale with a paired
read region + PPAF behind `LOOM_COSMOS_HA_MIGRATION=shadow`, and add the per-domain DR/residency wizard — per
appendix-bcdr-multi-region."

---

## Phase 4 — Ops maturity (SLOs, load/soak, observability, right-sizing, runbooks)

**Why last:** SLOs/load-tests/observability validate and protect everything below; right-sizing tunes the
now-complete stack to the 60k profile. Depends on Phase-0 deep health + Phase-2 PTU/rate-limit + Phase-3
multi-region being in place.

**Draws from:** appendix-ops-slo-loadtest (remaining items after Phase-0 P0s).

**Files — create:**
`lib/observability/{slo-catalog,slo-kql,domain-usage}.ts`, `app/api/monitor/slo/route.ts` +
`lib/components/monitor/slo-pane.tsx` + `app/monitor/page.tsx` (edit),
`platform/fiab/bicep/modules/admin-plane/{monitoring-slo-alerts,monitoring-workbook}.bicep` +
`bicep/dashboards/loom-slo-dashboard.json`, `lib/telemetry/spans.ts` +
`lib/telemetry/__tests__/crash-guard.test.ts`, `app/api/monitor/domain-usage/route.ts`,
`tests/load/k6/journeys.js` + `tests/load/k6/profiles/*` + `tests/load/locust/locustfile.py`,
`platform/fiab/bicep/modules/admin-plane/load-testing.bicep` + `.github/workflows/{load-smoke,load-nightly}.yml`,
`app/admin/load-testing/page.tsx` + `app/api/admin/load-testing/runs/route.ts`,
`docs/fiab/runbooks/{oncall,crash-loop,token-refresh,load-testing,bcdr-failover,cost-capacity}.md`.

**Files — edit:**
`lib/telemetry/app-insights.ts` (span processor + sampling), `platform/fiab/bicep/modules/admin-plane/{app-deployments,container-platform}.bicep`
(ACA right-size: dedicated D4/D8 profile, maxReplicas≥60, CPU+http scale rules, zone redundancy),
`lib/azure/aoai-call.ts` (already centralized in Phase 0 — surface `x-ratelimit-remaining-*` to telemetry),
`platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep` + `lib/azure/cosmos-account-client.ts`
(per-region-per-partition autoscale + burst, Normalized RU signal).

**Work:** SLI catalog (availability 99.9%, interactive p95≤800ms, editor-load p95≤2.5s, copilot TTFB
p95≤3s, auth 99.95%, write 99.95%) over `AppRequests` sliced by domain + Google multi-window
multi-burn-rate alerts (14.4×/1h fast, 6×/6h slow) wired to the existing `loom-default-alerts` action
group; load/soak harness (Azure Load Testing VNet-injected+CMK / OSS k6+Locust on scale-to-zero ACA Job
fallback) with profiles smoke/baseline(600)/peak(3000 RPS≈2400 VUs)/soak(4h)/spike, minted-session
journeys hitting real backends, fail criteria from the SLO table; observability (custom spans stamping
`csa-loom.{domain,surface,item_type}` + hashed `enduser.id` never raw UPN, RED metrics, parent-based
ratio sampling 10% traces/100% errors to respect 50GB/day cap, per-domain usage tab, day-one Workbook +
opt-in Grafana); ACA + AOAI + Cosmos right-sizing; full runbook/on-call set.

**Commercial AND Gov:** KQL + scheduledQueryRules identical; **Azure Load Testing only in a subset of Gov
regions** → OSS k6/Locust on ACA Job fallback (reuse `gh-aca-runner`); **Managed Grafana thin in Gov** →
Workbook is the Gov default; exporter host (`azure.com`/`azure.us`) carried by the App Insights connection
string; IL5 ingestion-private depends on AMPLS (honest gate); same-boundary region pairs.

**Migration / flags:** `skipSloAlerts` opt-out (keep heartbeat alerts as coarse backstop);
`loadTestingEnabled` honest-gate (default off, ops-only, costs); telemetry behind `isTelemetryEnabled`;
all ACA replica/concurrency/profile values parameterized for per-env cost dial; right-sizing reversible
via params.

**Web-5.0 UI:** SLO board (`/monitor` web3 pane — burn-rate gauges, per-SLI status, per-domain slice);
load-testing admin page (run history + profile picker, honest-gate when disabled); per-domain usage tab —
all Fluent v9 + Loom tokens.

**Code vs tenant-action:** CODE = SLO catalog/KQL/alerts bicep, spans, load scripts, dashboards, ACA/Cosmos
right-size params, runbooks. TENANT-ACTION (runbook + gate): action-group receiver setup (PagerDuty/Teams/
email), Entra Conditional Access sign-in-frequency, AMPLS for IL5 private ingestion, Load Testing region
availability confirmation. Runbooks map a Sev matrix to the burn alerts and cross-ref each in-product gate.

**Real-data E2E acceptance:** (a) SLO pane renders live burn-rate from real `AppRequests`; a synthetic
latency breach fires the fast-burn alert to the action group. (b) A baseline(600) load run completes against
real backends and the dashboard shows RED metrics per domain; soak(4h) holds SLOs with no replica
crash-loop. (c) ACA scales past 300 concurrent under load (maxReplicas≥60); Normalized RU stays under
autoscale ceiling. Commercial and Gov.

**Kick off with:** "Create `lib/observability/slo-catalog.ts` + `slo-kql.ts` + `monitoring-slo-alerts.bicep`
with multi-burn-rate rules on the existing action group, and the `/monitor` SLO board — per
appendix-ops-slo-loadtest."

---

## Dependency graph (one glance)

```
Phase 0  Refactor foundation + P0 ops  ── unblocks ──┐
   │ (AOAI client, editor split, rls-compiler,        │
   │  token-refresh, deep health)                     │
   ▼                                                   │
Phase 1  Security foundation                           │
   │ (OBO data-plane, PDP/ACL, item manifest)          │
   ▼                                                   │
Phase 2  Scale tier  ◄── needs per-user identity ──────┘
   │ 2A Cosmos · 2B query cache/governor ·
   │ 2C AOAI PTU · 2D rate-limiting  (parallel)
   ▼
Phase 3  Resilience & economics
   │ 3A BCDR (reuses 2A Cosmos provisioned) ·
   │ 3B cost-gov (reuses 2 metering substrate)
   ▼
Phase 4  Ops maturity
     (SLOs/load/observability/right-size/runbooks)
```

Each phase is independently kick-offable once the phase above it is green; 2A–2D and 3A/3B parallelize
internally.
