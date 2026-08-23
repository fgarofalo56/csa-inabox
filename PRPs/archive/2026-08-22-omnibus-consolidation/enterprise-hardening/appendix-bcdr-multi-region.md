# Appendix — BCDR / Multi-Region for CSA Loom (100→60,000 users, Commercial + Gov)

Domain: `bcdr-multi-region`
Scale target: size every design for the **60k upper bound**.
Cross-cutting rules honored: `no-fabric-dependency`, `no-vaporware`, `web3-ui`,
`no-freeform-config`, dual-cloud (Commercial + Azure Government GCC/GCC-High/IL4-5/DoD).

This is a **design + build spec**. No code was edited producing this doc. Every
item is tagged **CODE** (Loom can ship it) or **TENANT-ACTION** (operator/Azure
admin must do it; Loom surfaces an honest in-product gate + a runbook).

---

## 0. Executive summary — current readiness = WEAK (single-region by construction)

CSA Loom today is a **single-region** platform (`centralus` live). Every stateful
backend is provisioned single-region with **no secondary, no geo-replication, no
failover, and no documented runbook**. The grounding confirms:

- **Cosmos (Console metadata + DLZ state)** — `platform/fiab/bicep/modules/landing-zone/cosmos.bicep`
  and `.../admin-plane/loom-console-cosmos.bicep` provision **Serverless** accounts
  with **exactly one** `locations[]` entry, `enableAutomaticFailover: false`,
  `publicNetworkAccess: Disabled`, `disableLocalAuth: true`, and
  `backupPolicy.type = Continuous` (`Continuous7Days`). **Serverless mandates a
  single write region** — so the *current* Console metadata store **cannot** be
  geo-replicated without a capacity-mode change. This is the single biggest BCDR
  blocker.
- **Front Door** — `platform/fiab/bicep/modules/admin-plane/front-door.bicep` is
  Premium with **one** origin group (`aca-console`) holding **one** origin
  (`aca-console-origin`) via Private Link into **one** ACA environment, health
  probe `GET /` every 30s. Multi-origin failover is *almost free* here — the
  origin group already has `loadBalancingSettings` (sampleSize 4 / 3 required) —
  but there is no second origin and no second region.
- **ACA** — single environment, single region. ACA is a **single-region service**
  (MS Learn: "If the region becomes unavailable, your environment and apps are
  also unavailable"). No second environment exists.
- **ACR** — `registry.bicep` is **Premium** (good: Premium supports geo-replication)
  but has **no `replications` child resource**.
- **ADLS / Synapse / ADX** — DLZ storage redundancy is not pinned for geo; ADX has
  **no automatic regional failover** (MS Learn) and no second cluster.
- **Domain model** — `lib/azure/domain-registry.ts` `DomainItem` already carries a
  `location?` field (the DLZ region) but has **no `secondaryRegion`, no
  `residency`/`cloud` pin, no `failoverState`** — so data-residency-per-domain and
  per-domain DR posture are unmodeled.
- **Region knowledge** — `lib/azure/azure-regions.ts` has the boundary→region enum
  (`AZURE_PUBLIC_REGIONS`, `AZURE_USGOV_REGIONS`, `AZURE_USDOD_REGIONS`,
  `regionsForBoundary`, `defaultRegion`) and *documents* paired regions in a
  comment, but exposes **no `pairedRegion()` helper**.
- **No RTO/RPO target table, no failover runbook, no DR drill tooling** anywhere.

Readiness: **weak**. Nothing here is vaporware-shaped (the single-region build is
honest), but the platform has **zero regional-outage survivability** today.

---

## 1. Authoritative Microsoft Learn patterns (grounding)

| Capability | Pattern (MS Learn) | RTO / RPO | Notes for Loom |
|---|---|---|---|
| Cosmos single-write + read regions | Add read regions; SDK `PreferredLocations` auto-routes reads; **service-managed failover** promotes a read region on write-region outage | RTO ~ minutes (account-level 15–30m historically) / RPO ≈ 0 for Session within region, possible small loss cross-region | Requires **provisioned/autoscale** (NOT serverless) for >1 region |
| Cosmos **PPAF** (per-partition automatic failover) | Per-partition failover, SDK upgrade only | **RTO < 3 min @P99**, **RPO = 0** for Global Strong | "Active-active resiliency with a single writer" — best cost/safety for Console metadata |
| Cosmos **multi-write** | All regions writable; hub region arbitrates conflicts; **no Strong consistency** | RTO ≈ 0 / RPO ≈ 0 but **write conflicts** | 2× RU cost ($0.016 vs $0.008/100 RU/hr); use only if active-active writes truly needed |
| ACA multi-region | Deploy an env **per region**; front with **Front Door** (or Traffic Manager); replicate images via **ACR geo-replication**; replicate data externally | Depends on data tier | ACA itself has **no** built-in backup/cross-region |
| Front Door multi-origin failover | Multiple origins w/ `priority`; health probes detect bad origin, reroute; on **total** probe failure → round-robin all | Failover ~ probe interval × samples | Loom already uses priority-based origin group; add 2nd-region origin at `priority: 2` |
| ADLS / Storage GRS/GZRS | Auto async replication to **paired region** | **RPO ~15 min**; account failover is customer-initiated | Use **GZRS** where AZs exist (e.g. `usgovvirginia`), else **GRS** |
| ADX BCDR | **No automatic regional failover**; deploy 2nd cluster in paired region (active-active / hot-standby / on-demand), dual-ingest via Event Hubs, or continuous-export+external-tables | active-active RPO 0 / RTO 0; on-demand RPO/RTO highest | ZRS + AZ for intra-region; multi-cluster for inter-region |
| Event Hubs geo-DR | Geo-DR replicates **metadata only**; **geo-replication** (Premium/Dedicated) replicates metadata **and data** | — | For eventstream parity item |
| Key Vault | Contents auto-replicated to paired region (read-only failover); **purge protection + soft delete** required for true recovery | RPO ≈ 0 | TENANT-ACTION to enable purge protection |
| ACR geo-replication | `replications` child resource; **Premium only** | RPO ≈ minutes | Loom ACR is already Premium |
| Gov region pairs | `usgovvirginia`↔`usgovtexas`, `usgovarizona`↔`usgovtexas`; DoD `usdodeast`↔`usdodcentral`; **only `usgovvirginia` has AZs** | — | Same-geography pairs satisfy data-residency |

Sources are listed at the end of this appendix.

---

## 2. Target architecture (words)

**Two-tier resiliency model, configurable per deployment and per domain:**

- **Tier-0 control plane (the Console)** = Active/Passive across a region pair.
  - **Region A (primary)** runs the live admin-plane ACA env + DLZ(s).
  - **Region B (paired)** runs a **warm-standby** admin-plane ACA env (min replicas
    0 or 1) pointed at the **same geo-replicated Cosmos** account.
  - **Front Door** holds both ACA origins in one origin group: A at `priority:1`,
    B at `priority:2`. Health probe on a real **`/api/health/deep`** endpoint (not
    `/`) that checks Cosmos reachability. On A failure FD reroutes to B in
    ~probe-interval × required-samples (target < 90s).
- **Tier-1 data plane (per-domain DLZ)** = residency-pinned, with a **per-tier DR
  class** the operator chooses per domain (Platinum active-active / Gold
  active-passive / Silver backup-restore / Bronze single-region).

**Cosmos** is migrated from **Serverless → Autoscale (provisioned)** so a second
region can be added, then **PPAF enabled** (RTO<3min, RPO=0, single-writer, no
conflict tax). Multi-write remains an explicit opt-in for a domain that needs
active-active writes.

**Storage/ADLS** moves to **GZRS** (AZ regions) / **GRS** (non-AZ) with
customer-managed-key (CMK) where IL4/5 requires it; account-failover is a
runbook step.

**ADX / Synapse** follow the MS active-passive pattern: a paired-region cluster +
dual-ingest (Event Hubs) for Platinum/Gold domains; continuous-export →
GRS storage + on-demand recovery cluster for Silver.

**Data-residency-per-domain**: each `DomainItem` gains `cloud` (Commercial |
USGov | USDoD), a hard `residencyGeo`, and `secondaryRegion` constrained to the
**same geography/cloud** as `location` (a Gov domain can *only* fail over to a Gov
paired region — enforced in code, not just UI).

Everything stays **day-one-on but cost-governed**: DR class defaults to **Bronze**
(single region, the cheapest, what exists today) and the operator *promotes* a
domain to Gold/Platinum per cost appetite — no big-bang spend at 60k.

---

## 3. Gap-by-gap build spec

### GAP B1 — Cosmos geo-replication + PPAF for Console metadata `[P0]`

**Problem.** Console metadata Cosmos is **Serverless** → single-region by Azure
rule. A regional outage = total Console data-plane loss with only the 7-day
continuous backup (restore is hours, cross-region restore must target the paired
region). At 60k users the metadata store (workspaces/items/configs/copilot
sessions) is the system of record and must survive a region loss with RPO≈0.

**Design.**
1. **Capacity-mode migration (TENANT-ACTION + CODE).** Serverless cannot be
   converted in place to multi-region. Loom ships a **side-by-side migration**:
   provision a new **Autoscale** account `cosmos-loom-<domain>-ha-<uniq>`, run an
   online container-copy (Cosmos data-migration / change-feed copy) behind a
   feature flag, cut `LOOM_COSMOS_ENDPOINT` over, decommission the serverless
   account. This is reversible (flag points back at serverless until cutover
   verified). **Why autoscale not serverless:** multi-region + PPAF require
   provisioned/autoscale throughput; autoscale keeps the cost-governed,
   scale-to-floor behavior serverless gave us.
2. **Add the paired read region + PPAF (CODE, bicep).** Add a second
   `locations[]` entry at `failoverPriority:1`, set `enableAutomaticFailover:true`,
   and enable **PPAF** (`enablePerPartitionAutomaticFailover: true`). Keep
   `disableLocalAuth:true`, PE-only, `Continuous7Days`.
3. **SDK routing (CODE).** `lib/azure/cosmos-client.ts` already builds a
   `CosmosClient`; add `connectionPolicy: { preferredLocations: [primary, secondary] }`
   so reads auto-home and PPAF redirects writes transparently after the SDK
   upgrade. No per-query change needed.

**Exact files.**
- EDIT `platform/fiab/bicep/modules/landing-zone/cosmos.bicep` — add
  `param secondaryRegion string = ''`, `param drClass string = 'bronze'`; switch
  `capacityMode` to `'Provisioned'` when `drClass != 'bronze'` (keep Serverless for
  Bronze); build `locations` array conditionally (1 entry Bronze, 2 entries
  Gold/Platinum); set `enableAutomaticFailover` / `enablePerPartitionAutomaticFailover`.
- EDIT `platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep` — same.
- EDIT `platform/fiab/bicep/main.bicep` — thread `secondaryRegion` (computed from a
  new `pairedRegion()`) + `consoleDrClass` param down to both modules.
- NEW `apps/fiab-console/lib/azure/cosmos-failover-client.ts` — ARM wrappers for
  `listFailoverPriorities`, `failoverPriorityChange` (manual failover drill),
  `getAccountInfo().writeLocations`, surfaced to the UI/runbook.
- EDIT `apps/fiab-console/lib/azure/cosmos-client.ts` — add `preferredLocations`.
- NEW `apps/fiab-console/lib/migrations/cosmos-serverless-to-autoscale.ts` — the
  online copy + cutover state machine (flag `LOOM_COSMOS_HA_MIGRATION`).

**Commercial vs Gov.** Endpoint suffix already handled in `main.bicep`
(`cosmosDocSuffix = azure.us` for GCC-High/IL5). Region pair must be **same cloud**:
Commercial `centralus`→pair; Gov `usgovvirginia`→`usgovtexas`. **DoD**: only
`usdodeast`/`usdodcentral` — PPAF availability must be probed at deploy (honest gate
if unavailable). CMK for IL5 via the existing Key Vault.

**Code vs tenant-action.** Bicep + SDK = CODE. The **capacity-mode migration cutover**
is a CODE-driven but operator-**initiated** action (it moves the production system of
record) → in-product **"Enable multi-region HA"** wizard step + runbook §6.1.

**Cost @60k.** Autoscale floor ≈ serverless cost at low load; 2-region single-write
= **2× provisioned RU** (read region billed). PPAF adds no write-multiplier (unlike
multi-write's 2×). Gate behind DR class so only promoted domains pay.

---

### GAP B2 — Multi-region ACA + Front Door multi-origin failover `[P0]`

**Problem.** One ACA env, one FD origin. Region loss = console down.

**Design.**
1. **Second ACA environment (CODE, bicep)** in the paired region, same image (pulled
   from geo-replicated ACR, GAP B5), `minReplicas: 0` for warm-standby (cost) or
   `1` for hot. Env points at the **same** geo-replicated Cosmos + DLZ coordinates.
2. **Add 2nd FD origin (CODE, bicep)** in the existing `aca-console` origin group at
   `priority: 2` (primary stays `priority: 1`). FD's priority routing sends all
   traffic to priority-1 while healthy, fails to priority-2 automatically. The
   origin group's `loadBalancingSettings` already exist.
3. **Real health probe (CODE).** Replace `probePath: '/'` with
   `probePath: '/api/health/deep'`, `probeProtocol: Https`, interval 15s. New route
   checks Cosmos + a canary DLZ read and returns 200 only if writable-path is live —
   so FD fails over on a *dependency* outage, not just an ACA crash.

**Exact files.**
- NEW `platform/fiab/bicep/modules/admin-plane/aca-console-secondary.bicep` (or
  parameterize the existing ACA env module with a `region` + `role: 'secondary'`).
- EDIT `platform/fiab/bicep/modules/admin-plane/front-door.bicep` — add
  `param secondaryConsoleFqdn string = ''` and a second
  `Microsoft.Cdn/.../origins` resource (`aca-console-origin-secondary`,
  `priority: 2`) + its own `sharedPrivateLinkResource` into the 2nd CAE; update
  `healthProbeSettings.probePath` to `/api/health/deep`.
- NEW `apps/fiab-console/app/api/health/deep/route.ts` — deep health (Cosmos ping +
  region echo), no auth, fast-timeout, returns `{ok, region, cosmos, writable}`.
- EDIT `platform/fiab/bicep/main.bicep` — wire `frontDoorEnabled` path to pass the
  secondary FQDN; gate the whole secondary on `consoleDrClass in (gold,platinum)`.

**Commercial vs Gov.** Front Door **Premium is available in Azure Government**;
endpoint host is `*.azurefd.us` in Gov. WAF managed-rule set + the existing custom
rules carry over. The PE-approval deployment script (already present) runs in each
region. DoD: confirm FD availability per region at deploy → honest gate.

**Code vs tenant-action.** Almost all CODE. **First-time PE approval** is auto-scripted
(existing `approvePeScript`) but the staging-storage policy caveat already documented
means an operator may need to approve manually in locked subs → runbook §6.2.

**Cost @60k.** Warm standby (`minReplicas:0`) ≈ near-zero compute until failover;
FD already deployed (~$330/mo base). Second region scales on demand at cutover.

---

### GAP B3 — ADLS / Synapse / ADX regional redundancy `[P1]`

**Problem.** DLZ storage redundancy not pinned for geo; ADX/Synapse single-region;
ADX has no auto failover.

**Design (per DR class).**
- **ADLS Gen2 / Delta** — set `sku` to **GZRS** in AZ regions (`usgovvirginia`,
  most Commercial), **GRS** elsewhere (`usgovtexas`/`usgovarizona`, DoD). Enable CMK
  (IL5). Account-failover is operator-initiated (runbook). RPO ~15 min.
- **ADX/Kusto** — Gold/Platinum: 2nd cluster in paired region + **dual-ingest via
  Event Hubs** (each region's cluster consumes its own EH, checkpointing catches up
  a recovered cluster). Silver: **continuous-export → GRS storage** + on-demand
  recovery cluster (lowest cost). Use **optimized autoscale** on the secondary to
  ~halve cost. Intra-region: select **Availability zones** at cluster create + ZRS.
- **Synapse** — dedicated SQL pool: **geo-backup** (default) + restore to paired
  region; serverless SQL is stateless (re-point at replicated lake). ADF/Synapse
  pipelines are IaC — redeploy in region B from bicep.

**Exact files.**
- EDIT the DLZ storage bicep (the ADLS module under
  `platform/fiab/bicep/modules/landing-zone/`) — add `param storageRedundancy`
  (`GZRS`/`GRS`/`ZRS`/`LRS`) defaulted by `drClass` + AZ-availability of the region.
- NEW `platform/fiab/bicep/modules/landing-zone/adx-secondary.bicep` — paired-region
  Kusto cluster + EH consumer group (Gold/Platinum only).
- NEW `apps/fiab-console/lib/azure/storage-failover-client.ts` — ARM
  `storageAccounts/failover` wrapper + last-sync-time read (RPO surfacing).
- EDIT `apps/fiab-console/lib/azure/kusto-arm-client.ts` (existing) — add
  list-clusters-by-domain + secondary status for the DR dashboard.

**Commercial vs Gov.** GZRS requires AZ regions — only `usgovvirginia` in Gov has
AZs, so `usgovtexas`/`usgovarizona`/DoD fall to **GRS**. Event Hubs **geo-replication**
(data) is Premium/Dedicated and **may be absent in some Gov regions** → fall back to
geo-DR (metadata) + dual-ingest, with an OSS substitute (Kafka MirrorMaker on the
existing AKS/ACA) where managed geo-replication is unavailable. Honest gate names the
exact unavailable service.

**Code vs tenant-action.** Bicep = CODE. **Storage account-failover** and **ADX
cluster start (on-demand recovery)** are operator-initiated → runbook §6.3/§6.4.

---

### GAP B4 — Data-residency-per-domain (domain pinned to region/cloud) `[P1]`

**Problem.** `DomainItem.location` exists but there is no residency boundary, no
secondary region, no cloud pin. A multi-domain regulated enterprise needs e.g.
"HR domain stays in `usgovvirginia`, never replicates outside USGov geography."

**Design.** Extend the domain model + enforce in code (defense-in-depth: app-layer
check **and** bicep constraint), surfaced via a Web-5.0 wizard (no free-form).

**Exact files.**
- EDIT `apps/fiab-console/lib/azure/domain-registry.ts` `DomainItem`:
  add `cloud?: 'Commercial' | 'USGov' | 'USDoD'`, `residencyGeo?: string`
  (e.g. `US`, `USGov`), `secondaryRegion?: string`, `drClass?: 'bronze'|'silver'|'gold'|'platinum'`,
  `failoverState?: 'primary'|'failed-over'|'failing-back'`. Add a validator
  `assertResidency(domain)` that rejects a `secondaryRegion` whose geography/cloud
  differs from `location` (a Gov domain can only pair to a Gov paired region).
- NEW `apps/fiab-console/lib/azure/azure-regions.ts` helper **`pairedRegion(name)`**
  returning the MS-documented pair (`centralus`→`eastus2`-class within geo;
  `usgovvirginia`→`usgovtexas`; `usgovarizona`→`usgovtexas`; `usdodeast`→`usdodcentral`),
  with a closed map (no free-form). This is the single source of truth bicep + UI use.
- NEW `apps/fiab-console/lib/editors/dr-residency-wizard.tsx` — Fluent v9 + Loom
  tokens wizard: pick DR class (cards w/ RTO/RPO/cost badges), pick secondary region
  (dropdown **constrained to the paired region in the same cloud** via `pairedRegion`),
  CMK toggle for IL5. Reuses `PageShell`/`TileGrid`/`EmptyState` per web3-ui.
- NEW `apps/fiab-console/app/api/admin/domains/[id]/dr/route.ts` — GET/PUT the DR +
  residency config (validates with `assertResidency`, writes to the domains doc).
- EDIT `platform/fiab/bicep/main.bicep` — per-domain DLZ loop already iterates
  `dlzDomainNames`; thread each domain's `secondaryRegion` + `drClass` + `cloud` into
  the DLZ module so residency is enforced at provision time, not just UI.

**Commercial vs Gov.** The `cloud` pin is the enforcement primitive: a `USGov` domain
deploying into Commercial regions is rejected at both the API validator and bicep
`@allowed`. Entra authority differs (`login.microsoftonline.us`) — already handled in
`lib/auth/msal.ts`; the DR config inherits the deployment boundary.

**Defensible security.** Residency enforcement is **native** (bicep `@allowed` +
ARM region constraint) with the app-layer `assertResidency` as defense-in-depth —
never the sole boundary. Per-domain Entra-group RBAC (existing `adminGroupId`/
`memberGroupId`) continues to gate who can change DR posture.

**Cost @60k.** Default **Bronze** (single region) = today's cost; promotion to
Gold/Platinum is explicit + per-domain, so a 200-domain / 60k-user tenant only pays
DR cost on the domains that require it.

---

### GAP B5 — ACR geo-replication + Key Vault DR posture `[P2]`

**Problem.** ACR Premium has no `replications`; second-region ACA can't pull images
fast on failover. Key Vault DR posture (purge protection) unverified.

**Design.**
- **ACR (CODE, bicep).** Add a `Microsoft.ContainerRegistry/registries/replications`
  child for the paired region. Premium already in place — this is a one-resource add.
- **Key Vault (CODE + TENANT-ACTION).** Ensure `enableSoftDelete` + `enablePurgeProtection`
  on every KV (contents auto-replicate to paired region read-only). Purge protection is
  irreversible → operator-confirmed in the wizard.

**Exact files.**
- EDIT `platform/fiab/bicep/modules/admin-plane/registry.bicep` — add `param replicaRegion string = ''`
  + conditional `replications` resource.
- EDIT the KV module(s) under `platform/fiab/bicep/modules/**` — assert
  `enablePurgeProtection: true` when `drClass != 'bronze'`.

**Commercial vs Gov.** ACR geo-replication GA in Gov; KV soft-delete/purge GA in Gov +
DoD. CMK keys for IL5 stay in-boundary.

---

### GAP B6 — RTO/RPO target table, failover runbook, DR-drill tooling `[P1]`

**Problem.** No documented targets, no runbook, no drill mechanism. MS Learn is
explicit: paired regions alone do **not** give failover — you must own the plan +
**test** it (Cosmos manual-failover drill, storage account-failover drill).

**Design.**
- **RTO/RPO target table** (§5 below) shipped in-product as a read-only DR dashboard
  card per domain (current write region, last-sync time / RPO, DR class, target RTO).
- **Failover runbook** (§6 below) shipped as `docs/fiab/bcdr/failover-runbook.md` +
  surfaced in the DR dashboard "Run a drill" panel.
- **Drill tooling (CODE).** `cosmos-failover-client.ts` (B1) exposes a **manual
  failover** button (priority change) for DR drills; `storage-failover-client.ts`
  exposes account-failover; both gated behind a domain-admin RBAC check + a
  type-the-domain-name confirm (no accidental prod failover).

**Exact files.**
- NEW `docs/fiab/bcdr/failover-runbook.md`, `docs/fiab/bcdr/rto-rpo-targets.md`.
- NEW `apps/fiab-console/lib/editors/dr-dashboard.tsx` + `app/admin/bcdr/page.tsx` —
  Web-5.0 DR posture dashboard (TileGrid of domains, per-domain DR class/RTO/RPO/
  write-region/last-sync, "Run drill" + "Initiate failover" actions).
- NEW `apps/fiab-console/app/api/admin/bcdr/drill/route.ts` — executes a scoped,
  reversible drill (manual failover + auto-failback), records to an audit container.

**Commercial vs Gov.** Identical; drill actions hit the boundary's ARM endpoint
(`management.usgovcloudapi.net` in Gov — already resolved by the cloud-endpoints
detection).

---

## 4. Feature-flagged, migration-safe rollout

| Flag | Default | Effect |
|---|---|---|
| `LOOM_BCDR_ENABLED` | `false` | Master switch; surfaces DR dashboard + per-domain DR class |
| `LOOM_COSMOS_HA_MIGRATION` | `off` | `off`→`shadow`(dual-write/verify)→`cutover`→`done`; reversible until `done` |
| `LOOM_CONSOLE_DR_CLASS` | `bronze` | `gold`/`platinum` provisions 2nd ACA env + FD origin |
| per-domain `drClass` | `bronze` | promotes a single domain's DLZ to geo |

Every change is **additive bicep + a flag** — no big-bang. Bronze == today's
single-region build, so an existing deployment is unaffected until an operator opts
a domain (or the console) up a DR tier.

---

## 5. RTO / RPO target table (per DR class / tier)

| Tier | Backends | Topology | RTO target | RPO target | Rel. cost |
|---|---|---|---|---|---|
| **Platinum** | Console + critical domain | Cosmos multi-region + PPAF (or multi-write); ACA hot 2-region; ADX active-active; ADLS GZRS | **< 5 min** | **≈ 0** | Highest |
| **Gold** | Important domain | Cosmos 2-region + PPAF; ACA warm standby; ADX active-passive (dual-ingest); ADLS GZRS/GRS | **< 30 min** | **< 5 min** | High |
| **Silver** | Standard domain | Cosmos single-region + Continuous backup (cross-region restore); ADLS GRS; ADX on-demand recovery cluster | **2–4 hr** | **< 1 hr** | Medium |
| **Bronze** *(today)* | Dev / non-critical | Single region; Continuous7Days backup only | **Best-effort (hours+)** | **< 7 days (backup)** | Lowest |

---

## 6. Failover runbook (operator, in-product + docs)

**6.1 Cosmos region failover (Gold/Platinum).** If PPAF is on, failover is automatic
(RTO<3min). For a **drill** or manual failover: DR dashboard → domain → "Initiate
failover" → type domain name → calls `failoverPriorityChange` promoting the paired
region. Verify via `getAccountInfo().writeLocations`. Fail back after region recovery
(automatic with PPAF; manual = re-promote primary).

**6.2 Console (ACA) failover.** Automatic via Front Door priority routing once the
deep health probe fails on region A. Manual override: disable origin A in FD. First
deploy: approve the FD→ACA Private Link connection (auto-scripted; manual fallback in
locked subs: ACA env → Networking → Private endpoint connections → Approve).

**6.3 ADLS account failover.** DR dashboard surfaces **last-sync-time** (RPO). To fail
over: confirm acceptable data loss vs last-sync, call `storageAccounts/failover`. Note:
post-failover the account becomes LRS — re-enable GRS/GZRS as a follow-up.

**6.4 ADX recovery.** Active-passive: secondary already ingesting → repoint queries
(Loom does this via the BCDR query client). On-demand: start the recovery cluster
(`az kusto cluster start`), apply DDL/policies from source control, ingest from the
GRS export with `kustoCreationTime`.

**6.5 Gov specifics.** All ARM calls target `management.usgovcloudapi.net`; Entra
authority `login.microsoftonline.us`; endpoints `*.azure.us` / `*.usgovcloudapi.net`.
DoD: confirm each service's regional availability before promoting a domain above
Bronze (honest gate blocks promotion if a backend is unavailable in the DoD pair).

---

## 7. Commercial vs Government summary

| Concern | Commercial | Azure Government |
|---|---|---|
| Region pairs | per `regions-list` (e.g. `centralus`↔`eastus2`-geo) | `usgovvirginia`↔`usgovtexas`; `usgovarizona`↔`usgovtexas`; DoD `usdodeast`↔`usdodcentral` |
| AZ availability | most regions | **only `usgovvirginia`** (else GRS not GZRS) |
| ARM / Entra / hosts | `management.azure.com` / `login.microsoftonline.com` / `*.azure.com` | `management.usgovcloudapi.net` / `login.microsoftonline.us` / `*.azure.us` |
| Front Door | Premium `*.azurefd.net` | Premium `*.azurefd.us` |
| Event Hubs geo-replication (data) | Premium/Dedicated GA | may be **absent** in some Gov regions → geo-DR (metadata) + dual-ingest, or OSS Kafka MirrorMaker substitute |
| CMK / IL5 | optional | **required** IL5 — keys in-boundary KV, purge protection on |
| Cosmos suffix | `documents.azure.com` | `documents.azure.us` (already in `main.bicep`) |

---

## 8. Acceptance criteria

1. With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET (no-fabric rule), a Gold-class domain
   provisions a 2-region Cosmos (autoscale + PPAF), GZRS/GRS ADLS, and a paired-region
   ADX cluster — all Azure-native, real backend in the receipt.
2. Killing region A's ACA env causes Front Door to serve the console from region B in
   **< 90s** (deep-probe-driven), verified by browser walk.
3. Cosmos manual-failover **drill** from the DR dashboard promotes the paired region
   and `getAccountInfo().writeLocations` reflects it; auto-failback restores primary.
4. A `USGov` domain **cannot** select a Commercial secondary region (rejected at both
   the API validator and bicep `@allowed`) — residency enforced natively.
5. DR dashboard shows per-domain DR class, target RTO/RPO, current write region, and
   last-sync (RPO) — all real ARM reads, no mock data.
6. Bronze (default) deployment is byte-for-byte today's single-region behavior (no
   regression, no forced spend).
7. Commercial **and** Gov variants both deploy from bicep + the bootstrap workflow.

---

## 9. Sources (Microsoft Learn)

- Distribute data globally with Azure Cosmos DB — `learn.microsoft.com/azure/cosmos-db/distribute-data-globally`
- Reliability in Azure Cosmos DB — `learn.microsoft.com/azure/reliability/reliability-cosmos-db`
- Per-partition automatic failover (PPAF) — `learn.microsoft.com/azure/cosmos-db/per-partition-automatic-failover`
- Configure multi-region writes — `learn.microsoft.com/azure/cosmos-db/how-to-multi-master`
- Understand your Cosmos DB bill (geo-replication pricing) — `learn.microsoft.com/azure/cosmos-db/understand-your-bill`
- Reliability in Azure Container Apps — `learn.microsoft.com/azure/reliability/reliability-container-apps`
- Secure your Azure Container Apps deployment (backup/recovery) — `learn.microsoft.com/azure/container-apps/secure-deployment`
- Front Door health probes — `learn.microsoft.com/azure/frontdoor/health-probes`
- Monitor Azure Front Door — `learn.microsoft.com/azure/frontdoor/monitor-front-door`
- Multi-region App Service for DR (active-active pattern) — `learn.microsoft.com/azure/architecture/web-apps/guides/multi-region-app-service/multi-region-app-service`
- Azure region pairs / nonpaired regions — `learn.microsoft.com/azure/reliability/regions-paired`
- What is Azure Government? (region list + pairs) — `learn.microsoft.com/azure/azure-government/documentation-government-welcome`
- Azure Government connect (region programmatic names, DoD) — `learn.microsoft.com/azure/azure-government/documentation-government-get-started-connect-with-ps`
- Azure sovereign clouds — data controls / residency — `learn.microsoft.com/azure/azure-sovereign-clouds/data-controls`
- ADX BCDR overview — `learn.microsoft.com/azure/data-explorer/business-continuity-overview`
- Create ADX BCDR solutions — `learn.microsoft.com/azure/data-explorer/business-continuity-create-solution`
- DR architecture for an Azure data platform — `learn.microsoft.com/azure/architecture/data-guide/disaster-recovery/dr-for-azure-data-platform-architecture`
- Storage redundancy (GRS/GZRS, RPO ~15min) — `learn.microsoft.com/azure/storage/common/storage-redundancy`
- Multi-region deployments in Azure AI Search — `learn.microsoft.com/azure/search/search-multi-region`

---

## 10. Grounded Loom code references

- `apps/fiab-console/lib/azure/cosmos-account-client.ts` — account info, throughput,
  autoscale/manual migration helpers (no region/failover surface today).
- `apps/fiab-console/lib/azure/cosmos-client.ts` — `CosmosClient` builder (add
  `preferredLocations`).
- `apps/fiab-console/lib/azure/azure-regions.ts` — boundary region enums +
  `regionsForBoundary`/`defaultRegion` (add `pairedRegion`).
- `apps/fiab-console/lib/azure/domain-registry.ts` — `DomainItem` (add `cloud`,
  `residencyGeo`, `secondaryRegion`, `drClass`, `failoverState`; add `assertResidency`).
- `platform/fiab/bicep/modules/landing-zone/cosmos.bicep` — Serverless single-region
  (the B1 blocker).
- `platform/fiab/bicep/modules/admin-plane/loom-console-cosmos.bicep` — Console
  metadata Cosmos.
- `platform/fiab/bicep/modules/admin-plane/front-door.bicep` — single-origin FD
  (add 2nd origin + deep probe).
- `platform/fiab/bicep/modules/admin-plane/registry.bicep` — Premium ACR (add
  `replications`).
- `platform/fiab/bicep/main.bicep` — per-domain DLZ loop + Gov suffix logic (thread
  `secondaryRegion`/`drClass`/`cloud`).
