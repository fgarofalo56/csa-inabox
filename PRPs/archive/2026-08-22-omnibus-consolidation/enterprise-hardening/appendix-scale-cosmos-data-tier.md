# Appendix — Scale: Cosmos + Metadata Data Tier (60k users)

**Domain:** `scale-cosmos-data-tier`
**Scale target:** 100 → 60,000 users, millions of items.
**Readiness:** WEAK (functional today at hundreds of users; hard architectural ceilings + cross-partition fan-out anti-patterns will not survive 60k).
**Dual cloud:** Commercial + Azure Government (GCC / GCC-High / DoD IL4-5).
**Cross-cutting rules honored:** `no-vaporware`, `web3-ui`, `no-freeform-config`, `no-fabric-dependency`, migration-safe (feature-flagged + reversible), day-one-on-but-cost-governed.

---

## 1. Executive summary

The Loom metadata tier is a single Cosmos DB (NoSQL/SQL API) account per DLZ, provisioned in **Serverless** capacity mode, holding ~60 lazily-created containers in the `loom` database. It works today, but five facts make it unfit for 60k users without change:

1. **The account is Serverless.** Per MS Learn, a serverless container caps at **5,000 RU/s per physical partition** and the account is **single-region, no autoscale, no geo, no SLA on throughput/latency** ([serverless-performance](https://learn.microsoft.com/azure/cosmos-db/serverless-performance), [throughput-serverless](https://learn.microsoft.com/azure/cosmos-db/throughput-serverless)). This is a hard ceiling that no code change can lift; it requires a capacity-mode migration to provisioned **autoscale** (each physical partition then supports **10,000 RU/s and 50 GB**).
2. **The `items` container is partitioned by `/workspaceId`.** A large shared/domain workspace concentrates millions of item docs + their RU into **one logical partition**, which caps at **20 GB and 10,000 RU/s** ([set-throughput comparison](https://learn.microsoft.com/azure/cosmos-db/set-throughput#comparison-of-models)). At 60k users this is a guaranteed hot partition for any enterprise-wide workspace.
3. **The hottest read paths are cross-partition fan-outs.** `loadOwnedItem`, `listOwnedItems`, `listAllOwnedItems`, `loadRecycledItem`, the search fallback, `applyLabelInheritance`, and the admin Workspaces list all issue `SELECT … FROM c` with **no partition-key predicate** against `items`/`workspaces`. Every single item-open is a full fan-out + N follow-up point-reads. RU and latency scale with **total container size**, not result size.
4. **Default indexing indexes everything,** including the large `state.content` blobs (report definitions, DAX, notebook cells, @xyflow canvas) stored on `items`. Write RU and index storage correlate directly to indexed-path count.
5. **Item state blobs risk the 2 MB doc cap.** Cosmos max item size is **2 MB** ([per-item-limits](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits) — note: the task brief said "20 MB"; the real per-document limit is **2 MB**, and the **20 GB** figure is the logical-partition cap). Report-designer / phase3 editor state can approach this.

The build-out is a phased, feature-flagged migration: (P0) stop the bleeding with query + index + TTL fixes that are pure code and reversible; (P1) migrate `items` to a **hierarchical partition key** `[/tenantId, /workspaceId, /id]` and flip the account to **provisioned autoscale**, online via the **change-feed copy** pattern behind `LOOM_ITEMS_BACKEND`; (P2) add a Web-5.0 capacity/cost cockpit, integrated cache, and a change-feed materialization function. Defensible isolation continues to lean on the app-layer tenant checks (single Console UAMI) but is hardened so tenant scoping is **structural** (tenantId is the first level of every hot container's key) rather than an afterthought.

---

## 2. Current-state assessment (file-level, grounded in code)

### 2.1 Capacity mode — Serverless (the ceiling)
`platform/fiab/bicep/modules/landing-zone/cosmos.bicep` line 66: `capacityMode: 'Serverless'`. Chosen (comment, lines 56-65) to dodge the **25-container shared-throughput cap** that produced live "collection count exceeded 25" 500s. Correct fix for the symptom, wrong for 60k: serverless cannot autoscale, cannot geo-replicate, caps at 5,000 RU/s/partition, and gives no throughput/latency SLA.

Consequence: the throughput-admin code in `apps/fiab-console/lib/azure/cosmos-client.ts` — `listContainerThroughput()` (lines 931-991) and `updateContainerThroughput()` (lines 998-1038) — calls `readOffer()` / `offer().replace()`, which **throw on serverless** (no offer object). So the entire `/admin` "Cosmos scaling" surface is a no-op against the live account. This is a `no-vaporware` defect today: a UI dial that cannot move the live system.

### 2.2 Partition-key map (from `cosmos-client.ts` `ensure()`, lines 414-705 + `cosmos.bicep`)
| Container | PK | Hot-partition risk at 60k |
|---|---|---|
| `workspaces` | `/tenantId` (value = **creator OID**, per-user) | Low cardinality risk is fine, but PK value is the *owner's* OID, not a real tenant — so cross-tenant/admin views must fan out (see 2.4). |
| `items` | `/workspaceId` | **HIGH** — millions of items in one shared/domain workspace = one 20 GB / 10k RU/s logical partition. |
| `audit-log` | `/itemId` | Unbounded growth, no TTL. |
| `copilot-sessions` | `/sessionId` | OK (TTL 28d). |
| `notifications`, `search-history`, `downloads` | `/userId` | Unbounded, no TTL. |
| `*-jobs` (`app-install-jobs`, `dataproduct-import-jobs`, `maintenance-jobs`) | `/tenantId` | Ephemeral rows, no TTL → grow forever. |
| ~50 others | `/tenantId`, `/workspaceId`, `/itemId`, `/scorecardId`, … | Mostly fine (point-read shaped). |

Key insight: **`workspaces.tenantId` = `session.claims.oid`** (the creator). Confirmed by `item-crud.ts` line 303 `ws.item(workspaceId, session.claims.oid)` and `cosmos.bicep` comment lines 134-140. There is no real shared-tenant GUID in the metadata partition scheme — multi-domain tenancy is layered on top via `workspace-roles` (PK `/workspaceId`, keyed by principalId) and `lib/azure/domain-*`. This is why admin/cross-domain views are forced to fan out.

### 2.3 Cross-partition fan-out anti-patterns (the RU killers)
All in `apps/fiab-console/app/api/items/_lib/item-crud.ts` unless noted:

- **`loadOwnedItem` (lines 192-218):** `SELECT * FROM c WHERE c.id=@id AND c.itemType=@t` on `items` — **no PK** → fan-out across **every** physical partition on **every item open**, then a point-read on `workspaces` to verify ownership. This is the single most-called hot path in the app.
- **`listOwnedItems` (221-246):** `SELECT * FROM c WHERE c.itemType=@t AND NOT_RECYCLED` — full container scan + an N-workspace ownership loop of point-reads.
- **`listAllOwnedItems` (254-276):** `SELECT * FROM c WHERE NOT_RECYCLED` — **entire `items` container** scan. Called by the Copilot `item_list` tool.
- **`applyLabelInheritance` (125-189):** one cross-partition `SELECT … WHERE c.id=@id` **per candidate source** on create.
- **`loadRecycledItem` (396-415):** cross-partition `SELECT … WHERE c.id=@id AND IS_DEFINED(c.state._recycled)`.
- **Search fallback** `app/api/search/items/route.ts` (lines 72-82): `SELECT TOP @top … FROM c WHERE CONTAINS(LOWER(c.displayName),@q)` on `items` — cross-partition `CONTAINS` scan (only used when AI Search is unset; the primary path is AI Search, which is correct).
- **Admin Workspaces** `app/api/admin/workspaces/route.ts`: documented cross-partition `SELECT * FROM c` on `workspaces` (cosmos.bicep lines 134-140) because tenantId = creator OID.

Per Learn, fan-out RU/latency scale with the number of physical partitions scanned, not the row count returned — so these get *worse* precisely as the system grows.

### 2.4 Indexing, item size, TTL, consistency, cache, change feed
- **Indexing:** `cosmos.bicep` lines 206-210 / 222-227 set `indexingMode: 'consistent', automatic: true` with **no `excludedPaths`** → every path of every `items` doc is indexed, including the large `state` subtree. Per [performance-tips indexing](https://learn.microsoft.com/azure/cosmos-db/performance-tips#indexing-policy), write RU and index storage correlate directly to indexed-path count.
- **Item size:** Big editor state (report-designer `lib/editors/report-designer.tsx` ~4.2k LOC of model; `phase3-editors.tsx` 18k LOC hosting ~20 editors) serializes into `item.state.content`. Approaching the **2 MB** cap risks hard write failures with no graceful path today.
- **TTL:** Only `copilot-sessions` (28 days, lines 432-447 incl. an idempotent replace-upgrade). `audit-log`, `notifications`, `search-history`, `downloads`, and the `*-jobs` containers have **no TTL** → unbounded storage growth (and on serverless, unbounded storage = rising minimum RU and the eventual 50 GB/partition split pressure).
- **Consistency:** account default **Session** (`cosmos.bicep` line 67) — correct default; keep.
- **Integrated cache:** none (no Dedicated Gateway provisioned). Read-heavy catalog/list traffic re-charges RU every call.
- **Change feed:** unused. Derived stores (AI Search mirror `upsertLoomDoc`, governance index, data-product index, posture aggregates) are updated **inline, best-effort, fire-and-forget** inside the write path (e.g. `item-crud.ts` lines 330-338). At 60k this both adds write latency and silently drops mirror updates on transient failure.

---

## 3. Target architecture (architecture-in-words)

### 3.1 Capacity mode: Serverless → Provisioned **autoscale**, **database-shared** with selective dedicated containers
Move the `loom` database to **provisioned autoscale**. Autoscale gives 10,000 RU/s + 50 GB per physical partition, geo-replication capability (P-tier BCDR), and an SLA. To keep the >25-container database affordable, use **autoscale shared throughput at the database level** (the original 25-container cap is what shared *manual* throughput hit; autoscale shared-throughput databases raise the floor by 1,000 RU/s per container beyond 25 — see [concepts-limits autoscale](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#limits-for-autoscale-provisioned-throughput)). The two genuinely hot containers — **`items`** and **`workspaces`** — get **dedicated container-level autoscale** so their RU is reserved and isolated; everything else shares the database pool.

Sizing model in §5. This is the one change that is **not** pure code: it is a control-plane migration (new account/database or in-place offer change) → a TENANT-ADMIN action with a runbook (§7), gated in-product by an honest MessageBar until done.

### 3.2 `items` partition key: `/workspaceId` → **hierarchical `[/tenantId, /workspaceId, /id]`**
Per [hierarchical-partition-keys](https://learn.microsoft.com/azure/cosmos-db/hierarchical-partition-keys) and [HPK unlimited scale](https://learn.microsoft.com/azure/cosmos-db/hierarchical-partition-keys-unlimited-scale):
- **Level 1 `/tenantId`** (the owner/domain partition) — high cardinality at 60k users/domains; makes tenant scoping **structural** (defense-in-depth: a query that forgets the tenant predicate can no longer leak across tenants because routing is by prefix).
- **Level 2 `/workspaceId`** — aligns with the dominant "all items in a workspace" query; efficiently prefix-routed.
- **Level 3 `/id`** — guarantees the `(tenantId, workspaceId)` prefix can **exceed 20 GB** (the id terminal level lifts the logical-partition cap), killing the big-shared-workspace hot partition.

Point reads become prefix-routed; `loadOwnedItem` becomes a single-partition read once the route passes `(tenantId, workspaceId)`. The JS SDK supports HPK at `@azure/cosmos` v4 (already the dependency).

### 3.3 Query rewrites (eliminate fan-out)
- `loadOwnedItem(itemId, itemType, tenantId, workspaceId)` — add `workspaceId` to the signature (callers already hold it from the route params) and do a **point read** `items.item(id, [tenantId, workspaceId])` (HPK partition value as array). Fall back to a tenant-scoped (level-1) query only when workspaceId is genuinely unknown — still single-tenant, never full fan-out.
- `listOwnedItems(itemType, tenantId)` — `SELECT * FROM c WHERE c.tenantId=@t AND c.itemType=@type AND NOT_RECYCLED`. With `/tenantId` as level-1, this is routed to one tenant's partitions (not the whole container) and **drops the N-workspace ownership loop** (ownership is now implied by the tenant prefix).
- `listAllOwnedItems(tenantId, workspaceId?)` — `WHERE c.tenantId=@t [AND c.workspaceId=@w]` — prefix-routed.
- `applyLabelInheritance` / `loadRecycledItem` — add the tenant predicate so they route to one tenant.
- Stamp **`tenantId` onto every `items` doc on write** (`createOwnedItem`, `updateOwnedItem`, `softDelete/restore`) so the level-1 key is always populated. This is the migration's load-bearing data change (backfilled by the change-feed copy, §6).

### 3.4 Large item state offload (2 MB guard)
Introduce a **state-offload helper** `lib/azure/item-state-blob.ts`: when a serialized `item.state` exceeds a threshold (default 1.5 MB, env `LOOM_ITEM_STATE_INLINE_MAX`), persist the blob to ADLS Gen2 (`loom-item-state` filesystem, path `{tenantId}/{workspaceId}/{itemId}.json`) and store a pointer `{ _stateRef: { container, path, etag, bytes } }` in Cosmos instead of the inline content. Reads transparently rehydrate. This keeps Cosmos docs small (cheap RU, fast index) and removes the 2 MB cliff. Gov: same pattern, Gov ADLS endpoint (`*.dfs.core.usgovcloudapi.net`).

### 3.5 Indexing policy (write-cost + storage)
Apply a custom policy to `items` (and `workspaces`): include root `/*`, **exclude `/state/*`** (the large content subtree) so it is stored but not indexed, while keeping the handful of queried state paths explicitly indexed (`/state/_recycled/?`, `/state/sensitivityLabel/?`, `/state/domain/?`, `/state/publishStatus/?`). Per [sample-indexing-policies](https://learn.microsoft.com/cosmos-db/sample-indexing-policies). This cuts write RU on every item save and shrinks index storage materially at millions of items.

### 3.6 TTL for ephemeral containers
Add `defaultTtl` to: `notifications` (90d), `search-history` (30d), `downloads` (7d), `app-install-jobs` / `dataproduct-import-jobs` / `maintenance-jobs` (14d), `audit-log` → **keep (compliance), instead tier to ADLS** via change feed (audit must be retained; don't TTL-delete — archive). TTL deletes are billed as background RU on serverless but are free-of-scaling on autoscale ([autoscale-faq TTL](https://learn.microsoft.com/azure/cosmos-db/autoscale-faq)).

### 3.7 Integrated cache (read-heavy lists)
Provision a **Dedicated Gateway** and route the catalog/list/Copilot read traffic through it with `ConsistencyLevel=Eventual` + `maxIntegratedCacheStaleness`, so repeated catalog reads are RU-free cache hits. Gov: Dedicated Gateway is available in Azure Government; confirm region availability in the runbook, fall back to app-tier Redis (already present for Activator) if absent.

### 3.8 Change-feed materialization (replace inline best-effort mirrors)
Stand up an Azure Function **change-feed processor** (`functions/loom-cosmos-projector`) on the `items` lease that maintains the AI Search / governance / data-product / posture derived stores **out of band**. Removes mirror work from the write path (lower write latency, higher reliability) and is also the engine for the **online migration copy** (§6) and the **audit→ADLS archive** (§3.6).

---

## 4. Build spec — exact files to create/edit

### 4.1 P0 — pure-code, reversible, ship first (no infra change)
1. **`apps/fiab-console/app/api/items/_lib/item-crud.ts`** — rewrite the fan-out queries to be tenant-scoped (add `c.tenantId=@t` predicate) and thread `workspaceId` into `loadOwnedItem`. Stamp `tenantId` on every write. Guard behind `LOOM_ITEMS_TENANT_SCOPED` (default off → on) so it is reversible.
2. **`apps/fiab-console/lib/azure/cosmos-client.ts`** — in `ensure()`, set custom `indexingPolicy` (excluded `/state/*`) on `createIfNotExists` for `items`/`workspaces`; add `defaultTtl` to the ephemeral containers (with the same idempotent `replace()` upgrade pattern already used for `copilot-sessions`, lines 440-447). Add a `LOOM_COSMOS_CAPACITY_MODE` probe so `listContainerThroughput()` returns an honest "serverless — no dial" state instead of throwing.
3. **`apps/fiab-console/lib/azure/item-state-blob.ts`** (new) — the 2 MB offload helper (§3.4), plus wire into `createOwnedItem` / `updateOwnedItem`.
4. **`apps/fiab-console/lib/azure/cosmos-data-client.ts`** — extend `partitionKeyHeader` / `getItem` / `upsertItem` to accept an **array** partition-key value (HPK), so the Data Explorer + CRUD paths work against hierarchical containers (Learn: HPK pk header is a JSON array of the level values).

### 4.2 P1 — partition migration + capacity flip (feature-flagged)
5. **`platform/fiab/bicep/modules/landing-zone/cosmos.bicep`** — parameterize `capacityMode` (`Serverless` | `Provisioned`); when Provisioned, set database-level `autoscaleSettings.maxThroughput` and dedicated container-level autoscale offers for `items` + `workspaces`; define `items-v2` with `partitionKey: { paths: ['/tenantId','/workspaceId','/id'], kind: 'MultiHash', version: 2 }`; add `excludedPaths`. Keep Serverless as the default param so existing small deployments are untouched.
6. **`apps/fiab-console/lib/azure/cosmos-client.ts`** — `itemsContainer()` resolves `items` vs `items-v2` by `LOOM_ITEMS_BACKEND` (`legacy` | `hpk`). All item CRUD goes through the resolver; the HPK path passes `[tenantId, workspaceId, id]`.
7. **`functions/loom-cosmos-projector/`** (new) — change-feed processor: (a) copy `items` → `items-v2` stamping `tenantId` (the online backfill); (b) maintain derived stores; (c) archive `audit-log` to ADLS. Bicep: `platform/fiab/bicep/modules/landing-zone/cosmos-projector-func.bicep` (Function on the in-VNet plan + lease container).
8. **`apps/fiab-console/app/api/admin/cosmos-migration/route.ts`** (new) — BFF to start/monitor/cut-over the copy (reads projector progress, flips `LOOM_ITEMS_BACKEND` via the existing `env-config` → ACA revision path).

### 4.3 P2 — cockpit + cache
9. **`apps/fiab-console/app/admin/scale/cosmos/page.tsx`** + **`lib/admin/cosmos-capacity.tsx`** (new) — Web-5.0 capacity/cost cockpit (§8).
10. **`platform/fiab/bicep/modules/landing-zone/cosmos-dedicated-gateway.bicep`** (new) — Dedicated Gateway + integrated-cache wiring; read routes opt in via `LOOM_COSMOS_CACHE=1`.

---

## 5. Read/write capacity model at 60k users

Assumptions (tunable; documented in the cockpit): 60,000 users, 20% daily-active = 12,000 DAU, peak concurrency ~5% of DAU = **600 concurrent**, ~6 metadata ops/min per active session at peak.

| Path | Ops/s @ peak | RU/op (point/scoped) | RU/op (today, fan-out) | RU/s target |
|---|---|---|---|---|
| Item open (`loadOwnedItem`) | ~60 | ~1 (point read, HPK) | ~50-500 (fan-out, grows) | ~60 |
| Workspace item list | ~20 | ~5-15 (tenant-scoped) | ~hundreds (scan) | ~300 |
| Item save (write, state offloaded) | ~15 | ~10-15 | ~25-40 (full index) | ~225 |
| Catalog/search (AI Search primary) | ~30 | ~0 Cosmos (cache/AISearch) | n/a | ~0-50 |
| Copilot `item_list` | ~5 | ~10 (tenant-scoped) | ~entire container | ~50 |
| Notifications/prefs/tabs (point) | ~40 | ~1 | ~1 | ~40 |
| Misc admin/governance | — | — | — | ~200 buffer |

**`items` dedicated autoscale: max 8,000–10,000 RU/s** (scales 800–10,000; floor billed = 10% = 800). **`workspaces` dedicated: max 4,000 RU/s.** **Shared database pool for the ~58 other containers: autoscale max 10,000–20,000 RU/s** (floor rises ~1,000 RU/s per container beyond 25 → with ~60 containers the shared-DB minimum-max is ~35,000; this is the strongest argument for moving the long tail of tiny containers into **fewer, type-discriminated containers** — a P2 consolidation, noted as a follow-up). Headroom: autoscale absorbs the 600-concurrent peak and idles to 10% off-peak, which is the cost-governed posture. Contrast: **serverless physically cannot exceed 5,000 RU/s per partition** and has no burst SLA — so the same load today risks 429s with no dial.

Cost note: autoscale bills the highest RU/s reached each hour (min 10% of max). Off-peak the metadata tier idles cheap; the cockpit surfaces the projected monthly RU-hours per container so an operator can cap per-domain (§8). Storage: millions of small docs (state offloaded to ADLS) ≈ low tens of GB → trivial vs ADLS data plane.

---

## 6. Migration plan — online, feature-flagged, reversible

**Principle:** never a big-bang; `items` (legacy `/workspaceId`) and `items-v2` (HPK) coexist; cut-over is an env flip; rollback is the reverse flip.

1. **Deploy `items-v2`** (HPK) alongside `items` (P1 bicep). No reads/writes yet. `LOOM_ITEMS_BACKEND=legacy`.
2. **Dual-write** (flag `LOOM_ITEMS_DUAL_WRITE=1`): every create/update/delete writes both containers, stamping `tenantId` (resolved from the parent workspace's owner OID) on the v2 doc. Reads still legacy.
3. **Backfill** via `loom-cosmos-projector` change-feed copy from `items` → `items-v2`, stamping `tenantId`, offloading any >1.5 MB state to ADLS. Idempotent (upsert by id); resumable via lease checkpoints. Monitor progress in the migration route (§4.2 #8).
4. **Shadow-read verify:** sample N reads against both, diff, log mismatches. Gate cut-over on zero diffs for a soak window.
5. **Cut-over:** flip `LOOM_ITEMS_BACKEND=hpk` (ACA revision via `env-config`). Reads now HPK/point. Keep dual-write on for the rollback window.
6. **Decommission:** after soak, disable dual-write, retain `items` read-only for the retention window, then delete.
7. **Capacity flip** is independent and can precede or follow: change the account/database offer from Serverless to Provisioned autoscale. In-place offer change is **not supported Serverless↔Provisioned** — so this is a **side-by-side new account** + the same change-feed copy across accounts, or a fresh DLZ. Documented as the §7 runbook; the in-product gate names it.

Every step is reversible by flag until decommission. No user-visible downtime (dual-write + shadow-read).

---

## 7. Code vs tenant-admin action (runbooks + honest gates)

| Action | Type | How |
|---|---|---|
| Tenant-scoped queries, indexing policy, TTL, state offload, HPK CRUD | **CODE** | P0/P1 PRs above; ship behind flags. |
| Define `items-v2` HPK container, autoscale offers | **CODE (bicep)** | `cosmos.bicep` param; deployed by the pipeline. |
| Change-feed projector Function | **CODE (bicep + func)** | new module. |
| **Serverless → Provisioned autoscale capacity flip** | **TENANT-ADMIN** | Not an in-place change. Runbook: provision a new Provisioned-autoscale account (or DLZ), run the cross-account change-feed copy, repoint `LOOM_COSMOS_ENDPOINT`/`LOOM_COSMOS_ACCOUNT`, verify, delete old. Honest gate: `/admin/scale/cosmos` shows a `warning` MessageBar — "This deployment is Serverless (5,000 RU/s/partition ceiling). To scale past ~hundreds of concurrent users, migrate to Provisioned autoscale — see runbook" — with the bicep param to set. |
| Grant Console UAMI **Cosmos DB Built-in Data Contributor** on any new account | **TENANT-ADMIN** | Already scripted: `scripts/csa-loom/grant-navigator-rbac.sh`; bicep `sqlRoleAssignments` (cosmos.bicep lines 308-316). |
| Dedicated Gateway provisioning | **TENANT-ADMIN (cost)** | bicep deploys it; operator opts in via `LOOM_COSMOS_CACHE=1` because it bills per-node-hour. |
| Multi-region / BCDR enablement | **TENANT-ADMIN** | Only possible after the Provisioned flip (serverless is single-region by definition). |

---

## 8. Web-5.0 capacity/cost cockpit (`/admin/scale/cosmos`)

No-freeform-config: a **wizard + dials + charts**, not a JSON box. Fluent v9 + Loom tokens, `PageShell`, `TileGrid`, `EmptyState`. Cards:
- **Capacity mode** card: badge (Serverless / Provisioned-autoscale), the honest gate MessageBar when serverless, "Plan migration" CTA → the §6 wizard.
- **Per-container throughput** grid: container, PK, mode, current/max RU/s, **dial** (autoscale max) — but **disabled with an honest tooltip on serverless** (fixes the current vaporware where the dial silently no-ops). Real backend = `updateContainerThroughput`.
- **Hot-partition radar:** reads the `PartitionKeyStatistics` / `PartitionKeyRUConsumption` diagnostic categories already enabled (`cosmos.bicep` lines 269-270) to flag any logical partition nearing 20 GB / 10k RU/s — i.e. the big-shared-workspace warning, live.
- **Cost projection:** RU-hours × region price → projected monthly $, with a **per-domain cap** control (cost-governed day-one): an operator enables Loom for all domains but sets an RU ceiling per domain (enforced via per-domain dedicated containers or the chargeback tags already in `lib/azure/domain-*`).
- **Migration wizard:** the §6 steps as a guided flow with live projector progress + shadow-diff count + the cut-over toggle.

---

## 9. Commercial vs Government

| Concern | Commercial | Azure Government |
|---|---|---|
| Cosmos data endpoint | `https://<acct>.documents.azure.com` | `https://<acct>.documents.azure.us` — already handled: `cosmos-data-client.ts` derives the suffix via `getCosmosSuffix()` (`lib/azure/cloud-endpoints.ts`); `LOOM_COSMOS_ACCOUNT_ENDPOINT` pin available. |
| ADLS state-offload endpoint | `*.dfs.core.windows.net` | `*.dfs.core.usgovcloudapi.net` (via cloud-endpoints resolver). |
| Entra authority (UAMI token) | `login.microsoftonline.com` | `login.microsoftonline.us` — MSAL/identity already cloud-aware in `lib/auth/msal.ts`. |
| Network posture | PE + `publicNetworkAccess: Disabled` (already set, line 72) | **IL4/5: private-only mandatory** (already satisfied) + **CMK**: add `keyVaultKeyUri` to the account for customer-managed keys; KV must be Gov, private-endpoint'd. |
| Dedicated Gateway / integrated cache | GA | Verify region availability in the runbook; fall back to app-tier Redis (already deployed for Activator) where absent. |
| Autoscale / multi-region | GA | GA in Gov regions (USGov Virginia/Arizona, DoD) — confirm pairing for BCDR. |
| Continuous backup | `Continuous7Days` (line 78) | Same; for IL5 confirm in-region restore. |

No OSS substitute is required for the core store (Cosmos is GA in all target clouds). The only OSS fallback is **Redis** for the integrated-cache role if Dedicated Gateway is unavailable in a given Gov region.

---

## 10. Acceptance criteria

1. **No fan-out on the hot path:** `loadOwnedItem` is a single-partition point read (verified via `x-ms-request-charge` ≈ 1 RU and `PartitionKeyRangeId` count = 1 in diagnostics). `listOwnedItems`/`listAllOwnedItems` route to a single tenant prefix.
2. **HPK live:** `items-v2` exists with `[/tenantId,/workspaceId,/id]`; a `(tenantId,workspaceId)` prefix exceeds 20 GB without write failure in a load test.
3. **Capacity:** account is Provisioned autoscale; `items` sustains the §5 600-concurrent peak with <1% 429 and p99 < 30 ms writes / < 10 ms point reads.
4. **Index:** `items` `state/*` excluded; measured write-RU drop on a large-state save vs baseline.
5. **2 MB guard:** a >2 MB state save succeeds via ADLS offload; rehydrate round-trips byte-identical.
6. **TTL:** ephemeral containers expire on schedule; `audit-log` archived to ADLS, not deleted.
7. **Migration:** dual-write + change-feed backfill + shadow-read zero-diff soak, then flag cut-over, then flag rollback — all with no user-visible errors.
8. **Honest gate:** on a serverless deployment, `/admin/scale/cosmos` shows the warning MessageBar with the exact runbook + bicep param; the throughput dial is disabled with a truthful tooltip (no silent no-op).
9. **Gov:** the whole path passes against a Gov endpoint (`.documents.azure.us`, `login.microsoftonline.us`) with CMK + private-only.
10. **No-vaporware receipt:** real `x-ms-request-charge` bodies + diagnostic screenshots in the PR, with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset (no Fabric dependency anywhere in this tier).

---

## 11. Priority

- **P0 (this PRP):** tenant-scoped query rewrites + `tenantId` stamping (flagged), custom indexing policy, ephemeral TTL, 2 MB state-offload, honest serverless throughput-admin gate. Pure code, reversible, large immediate RU/latency win.
- **P1:** `items-v2` HPK container + autoscale bicep param + change-feed projector + dual-write/backfill/cut-over migration + the capacity-flip runbook/gate.
- **P2:** capacity/cost cockpit, integrated cache (Dedicated Gateway / Redis fallback), change-feed materialization replacing inline mirrors, long-tail container consolidation, multi-region BCDR (depends on the Provisioned flip).
