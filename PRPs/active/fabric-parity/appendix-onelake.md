# Appendix — OneLake & Unified Storage: Fabric → CSA Loom parity (deep dive)

**Domain:** OneLake (the OneDrive-for-data) — the single logical lake, workspaces-as-containers,
item folders, Delta/Parquet/Iceberg table format, shortcuts, OneLake catalog (explore/govern/secure),
OneLake security (RBAC/RLS/CLS/folder roles), lifecycle + storage tiers, recycle/soft-delete,
table maintenance/V-Order, schemas, the ADLS-Gen2-DFS endpoint, file explorer, diagnostics, SAS.

**Loom Azure-native default (per `no-fabric-dependency.md`):** ADLS Gen2 (HNS) + Delta Lake + a
Loom catalog over it. Compute parity via Synapse Serverless / Databricks SQL Warehouse / ADX.
Control plane = ARM (`managementPolicies`, diagnostic-settings, RBAC) + DFS data-plane (ACLs, SAS,
soft-delete). Cosmos holds item/registry/role metadata. **Fabric / OneLake / Power BI REST is
opt-in only**, never on the default path.

**Verdict:** `loomStatus = strong`. OneLake is one of the most complete domains in Loom — the
hierarchy, lakehouse Files/Tables, all shortcut source types, OneLake security (roles + RLS + CLS),
the three catalog tabs, lifecycle/tiers, recycle/soft-delete, table maintenance, schemas, time
travel, item-size, and Iceberg virtualization are **built against real Azure backends**. Remaining
gaps are 2× P1 (short-lived access tokens surface; data-plane access-diagnostics explorer) and
5× P2 (shortcut caching, shortcut transformations, on-prem-gateway shortcuts, unified file-explorer/
connect-helper, OneLake→event triggers).

---

## 1. Capability inventory (grounded in Microsoft Learn)

Architecture notes capture how each capability actually works (data/compute/control flow + the item
model + the APIs). Learn URLs are the grounding sources.

### A. The lake itself — hierarchy, item model, endpoint

| # | Fabric capability | How it actually works | Learn |
|---|---|---|---|
| A1 | **Single logical lake, one per tenant** | OneLake is auto-provisioned, built on ADLS Gen2; tenant = root, workspaces = containers, items = folders. No infra to provision; can't create/delete OneLake. | `onelake/onelake-overview` |
| A2 | **Workspaces-as-containers / items-as-folders** | Workspace maps to an ADLS *container*; each data item (lakehouse/warehouse/eventhouse) is a top-level *managed folder* (`MyLH.lakehouse/`). | `fundamentals/microsoft-fabric-overview#onelake-the-unification-of-lakehouses` |
| A3 | **Managed item folders (`Files/` + `Tables/`)** | Two physical roots provisioned per lakehouse. Item folder + first-level (`Files`,`Tables`) are Fabric-managed: read-only over ADLS/Blob APIs (no create/rename/delete); CRUD allowed *inside*. | `onelake/onelake-api-parity#managed-onelake-folders`; `onelake/onelake-medallion-lakehouse-architecture` |
| A4 | **ADLS-Gen2 / Blob DFS endpoint** | `https://onelake.dfs.fabric.microsoft.com/<ws>/<item>.<type>/<path>` (+ GUID form, + `abfs[s]://` driver). Account=`onelake`, container=workspace, path starts at item. | `onelake/onelake-access-api#uri-syntax` |
| A5 | **ADLS-Gen2 API parity (read/write/manage)** | Same DFS+Blob REST/SDKs as ADLS; HEAD-only at container/account; `x-ms-acl` returns Fabric perms as POSIX rwx; `$superuser` owner. Delta-RS / object_store / Storage Explorer / azcopy / Databricks all work. | `onelake/onelake-api-parity` |
| A6 | **Delta Parquet table format (default)** | Delta is the default managed-table format; ACID over Parquet; all engines read in place — "one copy of data." | `onelake/onelake-medallion-lakehouse-architecture#delta-lake-storage` |
| A7 | **Iceberg ⇄ Delta metadata virtualization** | Virtual metadata auto-generated so Iceberg reads as Delta and Delta reads as Iceberg (Snowflake/Trino). Write Iceberg directly or shortcut to external Iceberg. | `onelake/onelake-overview#one-copy-of-data`; `onelake/onelake-iceberg-tables` |
| A8 | **Item OneLake integration (auto folder creation)** | A workload manifest with `CreateOneLakeFoldersOnArtifactCreation=true` makes Fabric create `<ws>/<item>/Files`+`/Tables` on item create. | `workload-development-kit/fabric-data-plane#onelake-integration` |

### B. Shortcuts (zero-copy virtual references)

| # | Fabric capability | How it actually works | Learn |
|---|---|---|---|
| B1 | **What a shortcut is** | A symbolic-link object: *shortcut path* (where it appears) → *target path* (where data lives). Appears as a folder; independent of target; delete shortcut ≠ delete target; moving target breaks it. | `onelake/onelake-shortcuts` |
| B2 | **Internal OneLake shortcuts** | Reference another Fabric item (lakehouse/warehouse/KQL/mirrored/SQL/semantic-model), same or cross workspace, types need not match. Auth = **passthrough** (calling user's identity must have read on target). | `onelake/onelake-shortcuts#types-of-shortcuts` |
| B3 | **External shortcuts** (ADLS, Blob, S3, S3-compatible, GCS, Dataverse, OneDrive/SharePoint, Iceberg) | Use a **cloud connection** with stored credentials (delegated). Binding the connection = a permission-checked "bind" op. | `data-engineering/lakehouse-shortcuts#supported-shortcut-sources` |
| B4 | **On-prem / network-restricted shortcuts (OPDG)** | On-premises data gateway agent bridges to S3-compatible on-prem or VPC-firewalled S3/GCS; can combine with Entra service-principal auth for S3. | `onelake/create-on-premises-shortcut` |
| B5 | **Shortcut caching** | Cross-cloud (S3/GCS/S3-compat/OPDG) reads cached per-workspace; retention 1–28 days, reset on access; files >1 GB not cached; "Reset cache" button; reduces egress. | `onelake/onelake-shortcuts#caching` |
| B6 | **Shortcut transformations** | On-read transforms — format conversion, PII removal — applied as data flows through the shortcut, producing virtual views without copies. | `onelake/onelake-overview#one-copy-of-data` |
| B7 | **Shortcut security model** | Passthrough (SSO) vs delegated; OneLake security flows across internal shortcuts; external-shortcut access requires Fabric Read on the host item + connection authz AND OneLake authz (AND-semantics). | `onelake/security/data-access-control-model#shortcuts` |
| B8 | **Consumption everywhere** | Spark (`Tables/MyShortcut` managed table), SQL endpoint, RTI `external_table()`, AAS Direct Lake, non-Fabric via DFS API. List Shortcuts REST returns path+targetType+target. | `onelake/onelake-shortcuts#where-can-i-access-shortcuts`; `rest/api/fabric/core/onelake-shortcuts/list-shortcuts` |

### C. OneLake security (data-plane RBAC / RLS / CLS)

| # | Fabric capability | How it actually works | Learn |
|---|---|---|---|
| C1 | **OneLake security roles** | Data-plane model. Role = Data (folders/tables) + Permission (Read/ReadWrite) + Members + Constraints (RLS/CLS). Enforced consistently across every engine. `DefaultReader` role exists per lakehouse. Admin/Member/Contributor bypass roles. | `onelake/security/get-started-security#onelake-security` |
| C2 | **Create/manage role wizard** | "Manage OneLake security" → New → name (alphanumeric, ≤128) → Grant Read[/ReadWrite] → All data or Selected data (expand Tables/Files, check) → per-table Data access (RLS/CLS) → Members. | `onelake/security/create-manage-roles` |
| C3 | **Row-level security (RLS)** | SQL `WHERE`-clause predicate per role on Delta tables; case-insensitive collation; only on tabular data. Invalid syntax → 0 rows. | `onelake/security/row-level-security` |
| C4 | **Column-level security (CLS)** | Hide columns; hidden = no access; metadata may still leak in some cases. | `onelake/security/column-level-security` |
| C5 | **Multi-role evaluation (effective role)** | Roles UNION (least-restrictive) across objects; within a role OLS∩CLS∩RLS; RLS across roles OR-combined; RLS+CLS must be same single role. | `onelake/security/data-access-control-model#evaluating-multiple-onelake-security-roles` |
| C6 | **Hierarchy levels (workspace/item/folder)** | Control plane (workspace roles, item share) vs data plane (OneLake security). Permissions inherit from parent; folder-level grants recurse. | `onelake/security/get-started-security` |
| C7 | **Authorized-engine / 3rd-party enforcement** | External engines register, pull policy + precomputed effective access via OneLake APIs, enforce table/RLS/CLS at query time. | `onelake/security/onelake-security-integrations-overview` |
| C8 | **Least-privilege & write perms** | Share item vs workspace role; ReadWrite OneLake-security perm for granular writes by viewers; SubscribeOneLakeEvents perm. | `onelake/security/best-practices-secure-data-in-onelake` |

### D. OneLake catalog (discover + govern + secure)

| # | Fabric capability | How it actually works | Learn |
|---|---|---|---|
| D1 | **Explore tab** | Item list + in-context details; filter by domain/workspace/item-type/endorsement/keyword; item details tabs (Overview, Tables schema, lineage); embedded in Teams/Excel/Copilot Studio; Catalog Search REST. | `governance/onelake-catalog-overview`; `governance/onelake-catalog-explore`; `governance/onelake-catalog-item-details` |
| D2 | **Govern tab** | Insights (data-estate inventory, sensitivity-label coverage, DLP, freshness, endorsement/description coverage) + recommended actions + Copilot drill-through. Admin = tenant-wide; owner = My items. | `governance/onelake-catalog-govern` |
| D3 | **Secure tab** | Unified view of workspace roles + OneLake security roles across items; audit/create/edit/delete roles from one place. | `governance/secure-your-data` |
| D4 | **Endorsement / tags / sensitivity / lineage / usage** | Promote/Certify, tags, MIP labels, lineage scan, usage metrics enrich each item. | `governance/onelake-catalog-item-details` |

### E. Lifecycle, tiers, recycle, item-size, DR, diagnostics

| # | Fabric capability | How it actually works | Learn |
|---|---|---|---|
| E1 | **Lifecycle management** | ≤10 rules/workspace JSON policy; Scope (whole/prefix) + Condition (daysAfter Modification/Creation/LastAccess) + Action (TierToCool/Cold, enableAutoTierToHotFromCool, delete); Export/Import Policy API; same structure as Azure Storage `managementPolicies`. | `onelake/onelake-lifecycle-management` |
| E2 | **Storage tiers (hot/cool/cold)** | Block-blob tiering; cool min 30-day, cold min 90-day retention; early-movement fees; viewable in Capacity Metrics. | `onelake/onelake-storage-tiers` |
| E3 | **Recycle bin / soft delete** | Workspace recycle bin (7-day, tenant-config) for items; ADLS Gen2 file soft-delete (7-day) for data; list + restore + purge. | `onelake/onelake-disaster-recovery#soft-delete-for-onelake-files`; `onelake/soft-delete` |
| E4 | **Item storage size** | Per-item OneLake storage usage (live + system/metadata + soft-deleted billed bytes), on-demand refresh. | `onelake/onelake-consumption` |
| E5 | **Disaster recovery / redundancy** | ZRS where available else LRS; opt-in BCDR geo-replication to paired region; failover via global endpoint; lifecycle policy export/import for recovery workspace. | `onelake/onelake-disaster-recovery` |
| E6 | **OneLake diagnostics** | Workspace-level diagnostics stream data-access events (UI/API/engine/cross-workspace-shortcut) as logs into a lakehouse; EUII toggle. | `onelake/onelake-diagnostics-overview` |

### F. Table maintenance & format

| # | Fabric capability | How it actually works | Learn |
|---|---|---|---|
| F1 | **OPTIMIZE (bin-compaction)** | Spark SQL `OPTIMIZE schema.table` consolidates small files; portal "Maintenance" dialog / REST / Lakehouse Maintenance pipeline activity. | `data-engineering/lakehouse-table-maintenance`; `fundamentals/table-maintenance-optimization` |
| F2 | **V-Order** | Write-time Parquet optimization (~15% slower writes, up to 50% better compression, faster reads); `OPTIMIZE … VORDER` or table property. | `data-engineering/delta-optimization-and-v-order` |
| F3 | **Z-Order** | `OPTIMIZE … ZORDER BY (cols)` co-locates values for data-skipping. | `fundamentals/table-maintenance-optimization#optimize-command` |
| F4 | **VACUUM** | Removes tombstoned files older than retention (default 7 days; <7 rejected unless override). Affects time-travel. | `data-engineering/lakehouse-table-maintenance#run-table-maintenance-from-lakehouse` |
| F5 | **Auto-compaction / optimize-write** | Table props `delta.autoOptimize.autoCompact` / `optimizeWrite`; pre/post-write compaction. | `data-engineering/table-compaction` |
| F6 | **Table Maintenance REST + pipeline activity** | Async job (`run-on-demand-table-maintenance`) + poll; Lakehouse Maintenance activity (OPTIMIZE+VORDER, VACUUM) chainable in pipelines. | `data-engineering/lakehouse-api#run-table-maintenance-on-a-delta-table`; `data-factory/lakehouse-maintenance-activity` |
| F7 | **Lakehouse schemas** | Schema-enabled lakehouse → `Tables/<schema>/<table>`; schema namespaces in SQL endpoint & shortcuts. | `data-engineering/lakehouse-schemas` |
| F8 | **Time travel / table history** | Delta version history + restore to version/timestamp. | `data-engineering/lakehouse-and-delta-tables` |

### G. Access, sync, sharing

| # | Fabric capability | How it actually works | Learn |
|---|---|---|---|
| G1 | **OneLake file explorer (Windows)** | OneDrive-style Windows sync app; placeholders (no auto-download); drag-drop upload; `Sync from OneLake`; `%USERPROFILE%\OneLake - Microsoft\`. Tenant-setting gated. | `onelake/onelake-file-explorer` |
| G2 | **Azure Storage Explorer / azcopy / Databricks / Synapse / Foundry** | Connect via ADLS Gen2 DFS URL; azcopy can't move whole items (managed); tenant setting "apps external to Fabric." | `onelake/onelake-azure-storage-explorer`; `onelake/onelake-azcopy` |
| G3 | **User-delegated SAS (short-lived)** | Entra-based, ≤1-hour OneLake SAS from a user delegation key; least-priv; tenant settings "Use/Authenticate short-lived user-delegated SAS." | `onelake/onelake-shared-access-signature-overview`; `admin/service-admin-portal-onelake` |
| G4 | **External data sharing (cross-tenant in-place)** | Shares OneLake folders/tables across Entra tenants in-place (read-only) by creating a shortcut back to source in the consumer tenant; 90-day accept; revocable. | `governance/external-data-sharing-overview`; `governance/external-data-sharing-create` |
| G5 | **OneLake events / Reflex triggers** | `SubscribeOneLakeEvents` perm; file/item events drive Activator/automation. | `onelake/security/best-practices-secure-data-in-onelake` |

**featureCount ≈ 46** discrete capabilities across A–G.

---

## 2. Loom coverage map (built ✅ / stubbed ⚠️ / missing ❌)

Grounded in the actual code in `apps/fiab-console`.

| Area | Capability | Loom status | Evidence |
|---|---|---|---|
| A1–A3 | Lake hierarchy, managed Files/Tables | ✅ built | `lib/install/provisioners/lakehouse.ts` (ADLS DLZ bronze/silver/gold default; Fabric opt-in), `lakehouse-editor.tsx` |
| A4–A5 | DFS endpoint + ADLS API parity | ✅ built | `lib/azure/adls-client.ts`, `onelake-path.ts`, `lakehouse-abfss.ts`, `/api/onelake/paths`, `/api/items/lakehouse/[id]/abfss` |
| A6 | Delta default format | ✅ built | `delta-schema.ts`, `delta-schema-parse.ts`, provisioner seeds CSV→Delta |
| A7 | Iceberg ⇄ Delta virtualization | ✅ built (Delta→Iceberg via UniForm); ⚠️ Iceberg→Delta read partial | `docs/fiab/parity/lakehouse-iceberg-endpoint.md`; UniForm `enableIcebergCompatV2` via Databricks SQL Warehouse |
| B1–B3 | Shortcuts (internal, ADLS, S3, GCS, Dataverse, SharePoint, delta-sharing) | ✅ built | `lib/azure/lakehouse-shortcuts.ts`, `shortcut-client.ts`, `shortcut-engines.ts`, `lib/components/onelake/shortcut-wizard.tsx`, `lakehouse-shortcut-editor.tsx`, `/api/items/lakehouse-shortcut` |
| B4 | On-prem-gateway shortcuts (OPDG) | ❌ missing | no SHIR/gateway routing for shortcut targets |
| B5 | Shortcut caching (cross-cloud egress) | ❌ missing | `lakehouse-shortcuts.ts` has no cache/TTL field or backend |
| B6 | Shortcut transformations (format/PII on read) | ❌ missing | shortcuts are pure zero-copy pointers |
| B7–B8 | Shortcut security + consumption (Spark/SQL/UC external tables) | ✅ built | `shortcut-engines.ts` derives Synapse Serverless + Databricks UC external tables; OneLake security ACL flow |
| C1–C6 | OneLake security roles + RLS + CLS + folder roles | ✅ built | `lib/azure/onelake-security-client.ts` (ADLS POSIX ACLs recursive), `onelake-security-rules.ts`, `lib/editors/components/onelake-security-tab.tsx`, `lib/panes/onelake-security-tab.tsx` (RLS predicate editor), `/api/onelake/security` |
| C7 | Authorized-engine model | ✅ covered intrinsically | ADLS POSIX ACLs are natively enforced by every engine (Synapse/Spark/SFTP) — no separate policy-export needed |
| D1 | Catalog Explore | ✅ built | `lib/azure/onelake-catalog-client.ts`, `governance-catalog-index.ts`, `/api/catalog/*`, `/api/onelake/catalog`; `docs/fiab/parity/onelake-catalog-explore.md` |
| D2 | Catalog Govern | ✅ built | `/api/onelake/governance`, `/api/admin/governance-catalog`; `onelake-catalog-govern.md` |
| D3 | Catalog Secure | ✅ built | `onelake-catalog-secure.md`, unified roles view |
| D4 | Endorsement/tags/sensitivity/lineage | ✅ built | governance-catalog + MIP labels (`/api/admin/security/mip`), lineage |
| E1–E2 | Lifecycle + tiers | ✅ built | `lib/components/onelake/lifecycle-rules.tsx`, `lib/azure/lifecycle-policy-shapes.ts`, `adls-client` get/setLifecyclePolicy, `/api/onelake/lifecycle`, `/api/onelake/tier`; `onelake-lifecycle.md` |
| E3 | Recycle / soft-delete | ✅ built | `/api/onelake/recycle`, `/api/onelake/[itemId]` softDelete; `onelake-recycle.md` |
| E4 | Item storage size | ✅ built | `/api/onelake/storage` (live + metadata + soft-deleted walk); `onelake-item-size.md` |
| E5 | Disaster recovery / redundancy | ✅ built (infra) | ADLS ZRS/LRS + bicep; soft-delete restore |
| E6 | OneLake **access** diagnostics (who-accessed-what) | ❌ missing | `/api/monitor/diagnostics` only audits diag-setting *coverage* to LAW; no data-plane StorageRead/Write/Delete access-events explorer |
| F1–F6 | Table maintenance (OPTIMIZE/V-Order/Z-Order/VACUUM, auto-compact) | ✅ built | `lib/azure/delta-maintenance.ts`, `lib/editors/components/delta-maintenance-dialog.tsx`, `lakehouse-spark-conf.ts` |
| F7 | Schemas | ✅ built | `lib/azure/lakehouse-schemas.ts`; `lakehouse-schemas.md` |
| F8 | Time travel / history | ✅ built | `/api/lakehouse/history`, history tab in `lakehouse-editor.tsx`; `lakehouse-table-history.md` |
| G1–G2 | File explorer / connect tools | ⚠️ partial | per-item web browser built; **no unified cross-workspace OneLake data-hub** + **no Storage-Explorer/azcopy/rclone connect-helper / desktop sync** |
| G3 | Short-lived user-delegated SAS | ⚠️ stubbed | client helper exists (`adls-client.ts` getUserDelegationKey + generateBlobSASQueryParameters) but **no external-access-token UI/BFF surface + no tenant toggle** |
| G4 | External cross-tenant in-place sharing | ✅ built | Delta Sharing (OSS protocol) = Azure-native in-place cross-org share; `delta_sharing` shortcut type + Loom Marketplace bidirectional Delta Sharing (PR #1578) |
| G5 | OneLake → event triggers | ⚠️ partial | Event Grid topic + Activator (Azure Monitor) editors exist; **ADLS Blob-created/deleted → activator wiring not surfaced for lakehouse files** |

---

## 3. Build-out specs for gaps (P1 first)

Cross-cutting for every spec: **no hard Fabric dependency** (Azure-native default + OSS where
needed), **dual cloud** (Commercial + Gov/GCC, `.us` endpoints, IL4/5, private-only), **day-one ON**
(deployed + enabled by bicep, user can disable), **Web-5.0 UX** (wizards/dropdowns/canvas/Copilot,
no freeform config), **real backend per control** (no mocks/dead buttons).

---

### GAP-1 (P1) — OneLake short-lived access tokens (user-delegated SAS) external-app surface

**Symptom today:** `adls-client.ts` already mints a user-delegation SAS, but there is no UI/BFF to
let an admin hand an external app a scoped, time-bound (≤1 h) token, and no tenant on/off toggle.
Fabric's "short-lived user-delegated SAS" tenant settings + per-item token issuance is unmatched.

**Architecture (words):** Lakehouse editor → new **"External access" tab** → user picks scope
(item / folder / table prefix), permission (Read / ReadWrite / List), and lifetime (5 min–60 min
dropdown). BFF calls `BlobServiceClient.getUserDelegationKey(start, expiry)` (Console UAMI needs
**Storage Blob Delegator**), then `generateBlobSASQueryParameters` scoped to the chosen path → returns
a single-use HTTPS URL + `abfss` form + an azcopy/curl snippet. Every issuance is audited to Cosmos
(`onelake-access-tokens`: issuer, scope, perms, expiry, hash) and to Log Analytics. A tenant toggle
(`LOOM_ONELAKE_SAS_ENABLED`, default ON) governs availability; a max-lifetime guard (60 min) is
enforced server-side.

**UI spec (Web-5.0):** Fluent v9 panel — scope picker = cascading dropdowns (Item → Folder tree →
optional table); permission = SegmentedControl (Read / ReadWrite / List); lifetime = dropdown
(5/15/30/60 min); **Generate** primary button → result card with copy buttons (HTTPS URL, abfss,
azcopy cmd) + countdown badge to expiry + "Revoke posture" note (SAS can't be revoked early → warn).
A table of recent issuances (issuer, scope, expiry, status) under the form. Honest-gate MessageBar if
Console UAMI lacks Storage Blob Delegator (names role GUID `db58b8e5-c6ad-4a2a-8342-4190687cbf4a`).

**API spec:**
- `POST /api/onelake/access-token` `{ itemId, path, perms, lifetimeMinutes }` → `{ ok, url, abfss, azcopy, expiresOn }`
- `GET /api/onelake/access-token?itemId` → recent issuances (audit list).

**Azure services:** ADLS Gen2 (user delegation key + SAS), Cosmos (audit), Log Analytics (audit sink),
ARM RBAC (Storage Blob Delegator).

**Bicep / deploy:** extend `landing-zone/storage-*-rbac.bicep` to grant Console UAMI **Storage Blob
Delegator** day-one; add `onelake-access-tokens` Cosmos container to the init step; env
`LOOM_ONELAKE_SAS_ENABLED=true`, `LOOM_ONELAKE_SAS_MAX_MINUTES=60` in `admin-plane/main.bicep`.

**Commercial vs Gov:** identical; Gov resolves `*.dfs.core.usgovcloudapi.net` via `cloud-endpoints.ts`;
Storage Blob Delegator GUID is global. No managed-service substitution needed (pure ADLS data-plane).

**Day-one:** ON by default; admin can disable per-tenant via toggle. Bicep grants the role at deploy.

**Acceptance:** with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset, generate a 15-min Read token on a gold
table, `azcopy list` the URL succeeds, a second attempt after expiry returns AuthenticationFailed;
issuance appears in the audit grid and in Log Analytics.

---

### GAP-2 (P1) — OneLake access diagnostics explorer (data-plane who-accessed-what)

**Symptom today:** `/api/monitor/diagnostics` audits whether resources route logs to LAW, but there
is no surface to *query* OneLake data-plane access events (who read/wrote/deleted which path, when,
how) — Fabric's OneLake diagnostics streams these to a lakehouse.

**Architecture (words):** Day-one bicep enables an ADLS Gen2 **diagnostic setting** with
`StorageRead`/`StorageWrite`/`StorageDelete` categories → Log Analytics (and optionally a
`diagnostics` lakehouse container as the OSS/lakehouse parity sink). A new **"Access diagnostics"**
sub-tab (lakehouse editor + admin Monitor) runs KQL against LAW `StorageBlobLogs` filtered to the
item's ADLS prefix → grid of {time, callerIpAddress, identity (objectId/UPN), operationName,
uri, statusCode, requestBodySize}. EUII redaction toggle controls whether identity/IP columns render
(parity with Fabric's EUII setting) — enforced server-side by projecting/omitting those columns.

**UI spec:** time-range dropdown (1h/24h/7d/30d), operation filter (Read/Write/Delete/All), identity
search box, EUII toggle (admin-only). Results in `LoomDataTable` with typed icons; a small bar chart
of operations/hour above the grid (real `data-visualization` chart, not placeholder). Empty/honest-gate
MessageBar when LAW or diag-setting is missing, naming the bicep module.

**API spec:** `GET /api/onelake/diagnostics?itemId&range&op&identity` → `{ ok, rows, summary }` (KQL
to LAW via `monitor-client`); `POST /api/onelake/diagnostics/enable` `{ itemId }` → enable the ADLS
diag-setting if drifted.

**Azure services:** ADLS Gen2 diagnostic settings, Log Analytics (Kusto query), optional lakehouse sink.

**Bicep / deploy:** extend `modules/shared/diagnostic-settings.bicep` to attach Storage
`StorageRead/Write/Delete` categories to the DLZ storage account → LAW, day-one. Env already present
(`LOOM_LOG_ANALYTICS_RESOURCE_ID`).

**Commercial vs Gov:** identical; Gov LAW + Kusto over `*.loganalytics.us`. IL5: keep the lakehouse
sink option for air-gapped review where LAW egress is restricted.

**Day-one:** diag-setting ON at deploy; the explorer reads live. EUII off by default in Gov.

**Acceptance:** read a file via the lakehouse browser, then within minutes the access-diagnostics grid
shows the `ReadFile` event with the caller identity (EUII on) and 200 status; toggling EUII off hides
identity/IP columns server-side.

---

### GAP-3 (P2) — Shortcut caching (cross-cloud egress reduction)

**Architecture:** add `cache: { enabled, retentionDays(1–28) }` to `LakehouseShortcut` for
S3/GCS/S3-compat/OPDG targets. Backend = a scheduled **Synapse/Databricks copy** (or ADF Copy) that
materializes accessed external partitions into an ADLS `__cache/<shortcutId>/` prefix with a
last-access stamp; reads resolve to cache when fresh (mtime check vs source ETag), else re-fetch +
refresh; a "Reset cache" action purges the prefix; files >1 GB bypass cache (parity).
**UI:** in the shortcut wizard, a "Caching" step (toggle + retention SpinButton 1–28) shown only for
external cross-cloud sources; shortcut row shows cache size + "Reset cache" button.
**API:** `PATCH /api/items/lakehouse-shortcut` `{ cache }`; `POST …/cache/reset`.
**Bicep:** reuse DLZ ADLS; optional ADF/Synapse already deployed. **Gov:** same; egress savings most
relevant for cross-cloud to AWS GovCloud/GCP. **Day-one:** caching default OFF per shortcut (it's a
cost/correctness tradeoff) but the *capability* is enabled and one-click-on.
**Acceptance:** create an S3 shortcut with 7-day cache, first read populates `__cache/`, second read
served from cache (verified by S3 access-log delta = 0), Reset clears it.

---

### GAP-4 (P2) — Shortcut transformations (on-read format-convert / PII redaction)

**Architecture:** when creating a shortcut, optionally attach a **transform** = a generated Synapse
Serverless / Databricks **view** over the target that (a) converts CSV/JSON→Delta/Parquet projection,
or (b) applies PII redaction (column masking via SQL `HASHBYTES`/`LEFT('***')`, or regex redaction in
a Spark view). The shortcut's `Tables/<name>` entry resolves to the *view*, not the raw target —
zero data copy, transform-on-read.
**UI:** wizard "Transform (optional)" step — dropdowns: Output format (As-is / Parquet / Delta),
PII columns multiselect → masking strategy (Hash / Partial / Null), grounded in detected schema (no
freeform). Live preview grid of masked output before save.
**API:** `POST /api/items/lakehouse-shortcut` accepts `transform`; `shortcut-engines.ts` emits the
view DDL. **Gov:** identical (Synapse/Databricks both available; OSS Spark on AKS as IL5 substitute).
**Day-one:** capability enabled; transforms opt-in per shortcut. **Acceptance:** a CSV S3 shortcut
with SSN column masked Partial renders `***-**-1234` in the lakehouse preview while source is
untouched.

---

### GAP-5 (P2) — On-premises / network-restricted shortcuts via gateway

**Architecture:** route S3-compatible-on-prem / VPC-firewalled S3/GCS shortcut traffic through Loom's
existing **self-hosted IR / data gateway** (per `csa_loom_data_integration_infra`) instead of a public
egress. The shortcut stores `gatewayId`; `shortcut-engines.ts` builds the external-table connection
to flow through the SHIR/gateway endpoint (scale-to-0 when idle).
**UI:** wizard adds "Connect via gateway" dropdown (None / <registered gateways>) for on-prem/VPC
sources; honest-gate MessageBar with the gateway-install link if none registered.
**API:** reuse `/api/items/lakehouse-shortcut` with `gatewayId`. **Bicep:** SHIR/gateway already in
DLZ. **Gov:** SHIR runs in-VNet; IL5-friendly (no public egress). **Day-one:** gateway deployed
scale-to-0; capability on, specific gateway opt-in. **Acceptance:** an on-prem MinIO bucket shortcut
resolves + lists through the gateway with no public route.

---

### GAP-6 (P2) — Unified OneLake file explorer hub + connect-helper

**Architecture:** a new **"OneLake" data-hub page** that browses *all* lakehouses/items across
workspaces in one tree (not per-item), backed by the catalog + adls-client recursive list — the web
parity for OneLake file explorer's unified node. Plus a **"Connect"** flyout that emits ready-to-paste
**Azure Storage Explorer** URL, **azcopy** login+copy commands, **rclone** config, and a
**Databricks/Synapse** abfss snippet for the selected item — the Azure-native answer to the Windows
desktop sync app (true OS-level placeholder sync is out of scope; rclone mount is the OSS substitute
and is documented in the Connect flyout).
**UI:** left tree (Workspace → Item → Files/Tables), right details + breadcrumb; top-right "Connect"
SplitButton with per-tool tabs. Reuses `lakehouse-editor` browse primitives.
**API:** `GET /api/onelake/hub` (cross-item tree from catalog), reuse `/api/onelake/paths`.
**Gov:** Connect snippets use `.us` hosts. **Day-one:** ON. **Acceptance:** hub shows two lakehouses'
Files side by side; the azcopy snippet from Connect successfully lists the item.

---

### GAP-7 (P2) — OneLake → event triggers (ADLS Blob events → Activator)

**Architecture:** wire ADLS Gen2 **Event Grid** system topic (`Microsoft.Storage.BlobCreated` /
`BlobDeleted`) on the DLZ storage account → an Event Grid subscription that drives the existing
**Activator (Azure Monitor / Logic App)** editor, so "a file landed in `Files/landing`" can trigger a
pipeline/notebook. This is the `SubscribeOneLakeEvents` parity.
**UI:** in the Activator/Event-Grid editor, add a "OneLake file event" source dropdown (Item → folder
prefix → event type) → action picker (run pipeline / notebook / webhook). All dropdowns, no freeform.
**API:** `POST /api/items/event-grid-topic` extended with storage-event source; reuse activator route.
**Bicep:** add Event Grid system topic + subscription on the DLZ storage account (day-one, disabled
subscription until a rule is created). **Gov:** Event Grid GA in Gov; `.us` endpoints. **Day-one:**
system topic deployed; subscriptions created on demand. **Acceptance:** upload to `landing/` fires the
BlobCreated event and the bound activator runs the target pipeline (run id in receipt).

---

## 4. Roadmap summary (condensed — full detail above)

| ID | Gap | Priority | Status today | Effort |
|---|---|---|---|---|
| GAP-1 | Short-lived user-delegated SAS external-access surface | P1 | stubbed (client helper only) | M |
| GAP-2 | OneLake access-diagnostics explorer (who-accessed-what) | P1 | missing | M |
| GAP-3 | Shortcut caching (cross-cloud egress) | P2 | missing | M |
| GAP-4 | Shortcut transformations (format / PII on read) | P2 | missing | M |
| GAP-5 | On-prem / network-restricted shortcuts via gateway | P2 | partial | S–M |
| GAP-6 | Unified OneLake file-explorer hub + connect-helper | P2 | partial | M |
| GAP-7 | OneLake → event triggers (ADLS Event Grid → Activator) | P2 | partial | S–M |
| ICE | Iceberg→Delta read (inbound virtualization) completeness | P2 | partial | S |

Everything else in the OneLake domain (hierarchy, Files/Tables, DFS endpoint + ADLS parity, Delta,
all shortcut source types, OneLake security roles + RLS + CLS, the three catalog tabs,
lifecycle/tiers, recycle/soft-delete, item-size, table maintenance + V-Order/Z-Order/VACUUM, schemas,
time travel, cross-tenant Delta Sharing) is **built against real Azure backends** with parity docs.

## 5. Sources (Microsoft Learn)

- onelake/onelake-overview · onelake/onelake-access-api · onelake/onelake-api-parity
- onelake/onelake-shortcuts · data-engineering/lakehouse-shortcuts · onelake/create-on-premises-shortcut
- onelake/security/get-started-security · …/data-access-control-model · …/create-manage-roles · …/row-level-security · …/column-level-security · …/best-practices-secure-data-in-onelake · …/onelake-security-integrations-overview
- governance/onelake-catalog-overview · …/onelake-catalog-explore · …/onelake-catalog-govern · …/secure-your-data · …/onelake-catalog-item-details
- governance/external-data-sharing-overview · …/external-data-sharing-create
- onelake/onelake-lifecycle-management · onelake/onelake-storage-tiers · onelake/onelake-disaster-recovery · onelake/soft-delete · onelake/onelake-consumption · onelake/onelake-diagnostics-overview
- data-engineering/lakehouse-table-maintenance · …/delta-optimization-and-v-order · …/table-compaction · …/lakehouse-api · …/lakehouse-schemas · fundamentals/table-maintenance-optimization · data-factory/lakehouse-maintenance-activity
- onelake/onelake-iceberg-tables · onelake/onelake-file-explorer · onelake/onelake-azure-storage-explorer · onelake/onelake-azcopy · onelake/onelake-shared-access-signature-overview · admin/service-admin-portal-onelake
- fundamentals/direct-lake-overview · …/direct-lake-how-it-works · enterprise/powerbi/onelake-integration-overview
