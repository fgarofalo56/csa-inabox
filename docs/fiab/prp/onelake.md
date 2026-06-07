# PRP — OneLake at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › OneLake (the unified data-lake catalog + storage foundation).
> **Parity target:** Microsoft Fabric **OneLake** — the single tenant-wide
> logical data lake: storage foundation (ADLS Gen2-backed namespace), item
> registry, DFS/Blob/ABFS endpoints, shortcuts, storage tiers + lifecycle
> management, the **OneLake catalog** ("Explore / Govern / Secure" surfaces),
> endorsement + sensitivity + lineage metadata, and the OneLake data-plane
> APIs/SDKs.
> **Hard rule:** Per `.claude/rules/no-fabric-dependency.md`, **every feature in
> this PRP must be 100% functional on Azure-native backends by default, with a
> real Microsoft Fabric capacity / workspace / Power BI tenant UNSET.** Fabric
> is opt-in only. There is **no `onelake.dfs.fabric.microsoft.com` /
> `api.fabric.microsoft.com` / `api.powerbi.com` on the default code path.**
> Per `.claude/rules/no-vaporware.md`, **no stubs, no mock arrays, no
> `return []` placeholders** — each task lands real backend calls or an honest
> infra-gate `MessageBar intent="warning"` that names the exact env var / role /
> resource to provision.
> Per `.claude/rules/ui-parity.md`, each surface gets a parity doc at
> `docs/fiab/parity/onelake*.md` and must match the source UI one-for-one
> (theme differs, functionality does not).
> Per `.claude/rules/loom-no-freeform-config.md`, all config is
> dropdowns/wizards/WYSIWYG — never a raw JSON textarea (the one exception is a
> 1:1 ADF/Synapse expression builder, not relevant here).

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What OneLake is

OneLake is Microsoft Fabric's **single, tenant-wide, logical data lake** — one
per tenant, auto-provisioned, never deletable, never duplicated. It is built on
**ADLS Gen2** with a hierarchical namespace `Tenant > Workspaces (containers) >
Items (folders) > sub-folders/files`. Every Fabric item (lakehouse, warehouse,
KQL DB, mirrored DB, SQL DB, semantic model) writes its data **automatically**
into OneLake; all tabular data is stored as **Delta Parquet** by default. Spark,
T-SQL, Analysis Services, KQL, and Power BI Direct Lake all read **the same
physical copy**. OneLake exposes DFS, Blob, and ABFS endpoints, a Shortcuts
system (internal + external to S3/GCS/ADLS/Dataverse), **storage tiers**
(Hot/Cool/Cold, preview) with **lifecycle management** rules, and the **OneLake
catalog** UI with **Explore / Govern / Secure** tabs surfacing endorsement,
sensitivity labels, lineage, and item discovery.

### 1.2 The Azure reality: there is no global OneLake namespace

Azure has **no single tenant-wide lake**. CSA Loom rebuilds OneLake's
*experience* as a **namespace abstraction over one-or-more ADLS Gen2 accounts**
plus a **Cosmos DB item registry** and a **catalog/governance overlay**
(Databricks Unity Catalog where available, Microsoft Purview Data Map
elsewhere). All "OneLake virtual path" display strings
(`<workspace>/<item>.<type>/Tables/...`) are translated to/from real ABFS
(`abfss://<container>@<account>.dfs.<suffix>/...`). Loom owns the catalog; Azure
owns the bytes.

### 1.3 Azure-native + OSS backing services

| Concern | Azure-native DEFAULT | OSS component | Loom client / module |
|---|---|---|---|
| Byte store (the lake) | **ADLS Gen2 (hierarchical namespace)** + Delta Parquet | Delta Lake OSS | `lib/azure/adls-client.ts` |
| Item registry (the "catalog index") | **Cosmos DB** (`items` + `workspaces` containers) | — | `lib/azure/cosmos-client.ts`, `lib/azure/cosmos-data-client.ts` |
| Unified metadata / multi-engine catalog | **Databricks Unity Catalog** (Comm/GCC) | Apache Hive Metastore / **Unity Catalog OSS** | `lib/azure/unity-catalog-client.ts` |
| Governance / lineage / classifications | **Microsoft Purview Data Map (classic)** | **Apache Atlas** (on AKS, IL5) | `lib/azure/purview-client.ts` |
| Sensitivity labels | **Microsoft Purview Information Protection (MIP)** | — | `lib/azure/purview-client.ts` (label read) |
| Storage tiers + lifecycle | **ADLS Gen2 access tiers (Hot/Cool/Cold) + Lifecycle Management policy** | — | `lib/azure/adls-client.ts` (extend) |
| Shortcuts (internal/external) | Loom shortcut metadata → ADLS / S3 / GCS / Dataverse passthrough; KV secretRef | — | `lib/azure/shortcut-*` (extend), `keyvault-client` |
| Endpoints (DFS/Blob/ABFS) | ADLS Gen2 native `dfs`/`blob` endpoints; Loom translation layer | — | `lib/azure/onelake-path.ts` (new) |
| Identity / RBAC | **Entra ID + Azure RBAC** (Storage Blob Data roles) + Cosmos data-plane RBAC + UC grants | — | `arm`/`rbac` helpers |
| Secrets | **Azure Key Vault** (secretRef) | — | `keyvault-client` |

### 1.4 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High / IL4 | DoD IL5 | Endpoint difference |
|---|---|---|---|---|---|
| ADLS Gen2 (HNS) | GA | GA | GA | GA (FedRAMP High) | `dfs.core.windows.net` vs `dfs.core.usgovcloudapi.net` |
| Cosmos DB | GA | GA | GA | GA | `documents.azure.com` vs `documents.azure.us` |
| Databricks Unity Catalog | GA | GA | ⚠️ not GA in usgovaz — **Purview primary** | ⚠️ not GA — **Atlas-on-AKS primary** | `azuredatabricks.net` vs `databricks.azure.us` |
| Purview Data Map (classic) | GA | GA | GA | ⚠️ verify region — Atlas fallback | `purview.azure.com` vs `purview.azure.us` |
| Key Vault | GA | GA | GA | GA | `vault.azure.net` vs `vault.usgovcloudapi.net` |

**Implication for code:** every host must be resolved through the existing
cloud-endpoint resolution used by `adls-client` / `cosmos-client` (the same
`.dfs.<suffix>` / `documents.azure.<suffix>` switch). **No host literal may be
hard-coded.** Each new client/path helper a task below adds MUST route through
that resolver and be covered by a cloud-matrix unit test asserting the
Commercial vs Gov suffix.

### 1.5 Item-type topology in Loom

```
OneLake (logical, Loom-owned)
 ├─ workspace (Cosmos `workspaces` doc)            ← maps to ADLS container(s)
 │   └─ item (Cosmos `items` doc, itemType=…)      ← maps to ADLS folder <item>.<type>
 │        ├─ Tables/   (managed Delta)             ← UC table / Purview entity / _delta_log
 │        └─ Files/    (unmanaged)                 ← ADLS paths
 ├─ shortcut (item metadata)                       ← ADLS/S3/GCS/Dataverse passthrough
 ├─ storage tier + lifecycle policy (per workspace)← ADLS access tier + LM rules
 └─ catalog overlay (endorsement, label, lineage)  ← Cosmos metadata + Purview/UC
```

---

## 2. Feature-by-feature parity table

Legend — **Status:** ✅ built · ⚠️ honest-gate (renders, partial backend, MessageBar) · 🔶 stub · ❌ missing.
Current status reflects the 2026-06-06 audit (`/onelake` page = grade **B / ~75%**).

| # | Fabric OneLake feature | Azure-native backend | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| F1 | Catalog **Explore** tab — item grid | Cosmos `items` query (`/api/items/by-type`) | `/onelake` 3-col grid: search, type-chips, scope toggle, workspace sidebar, tile/list views, details pane | all clouds | ✅ built | none (verify live data) |
| F2 | Item card — **endorsement** badge (Promoted/Certified) | Cosmos item `endorsement` field; admin set | Promoted/Certified chip on each card + details | all | ❌ missing (read, not rendered) | **T1** endorsement badge + admin set flow |
| F3 | Item card — **sensitivity label** chip | Purview MIP label (read) on item metadata | Label chip on card (currently details-only) | Comm/GCC; gate elsewhere | ⚠️ partial | **T2** label chip on card + label set |
| F4 | Item card — **owner** + **domain** | Cosmos `createdBy` + workspace/domain | Owner avatar+name + domain badge on card | all | ⚠️ partial | **T1** (folded in) |
| F5 | Item card — **overflow menu** ("Get URL" / Copy OneLake path / View lineage / Open) | `onelake-path` translation; lineage client | Per-card overflow menu w/ working actions | all | ❌ missing | **T3** OneLake path/URL + overflow |
| F6 | Catalog **Govern** tab | Purview Data Map + Cosmos metadata aggregation | Govern view: governance score, label coverage, sensitivity rollup, items needing attention | Comm/GCC/GCC-H; Atlas IL5 | ❌ missing | **T8** Govern tab |
| F7 | Catalog **Secure** tab | Azure RBAC + UC grants + ADLS ACL rollup | Secure view: who-has-access matrix, role assignment summary, OneLake security roles | all | ❌ missing | **T9** Secure tab |
| F8 | **OneLake path / URI** model (DFS/Blob/ABFS/GUID) | Loom translation over ADLS account+container+path | "Properties" panel shows DFS, Blob, ABFS, GUID forms w/ copy buttons | all | ❌ missing | **T3** path model + copy |
| F9 | **Shortcuts** — internal (lakehouse→lakehouse) | ADLS passthrough RBAC over container(s) | Shortcut wizard, list, edit, delete, test, broken-status | all | ⚠️ partial (Data Eng PRP) | **T4** internal shortcut CRUD + status |
| F10 | **Shortcuts** — external (S3/GCS/ADLS/Dataverse) | cross-cloud connector + KV secretRef | Source picker (ADLS/S3/GCS/Dataverse), creds via KV, browse remote, create | all (cross-cloud) | 🔶 stub | **T5** external shortcut connectors |
| F11 | **Storage tiers** (Hot/Cool/Cold, preview) | ADLS Set Blob Tier / Copy Blob | Tier column + per-file/folder "Change tier" dialog (early-deletion warning) | all | ❌ missing | **T6** tier mgmt |
| F12 | **Lifecycle management** rules (≤10/workspace) | ADLS Lifecycle Management policy (JSON) | Rules grid: Add/Edit/Delete/Pause/Reactivate, condition+action pickers, templates | all | ❌ missing | **T7** lifecycle rules editor |
| F13 | **Item registry / discovery** across types | Cosmos cross-partition query | type-chips for lakehouse/warehouse/kql-db/eventhouse/mirrored-db/sql-db/semantic-model | all | ✅ built | verify all 7 types render |
| F14 | **Lineage** (item-to-item) | UC lineage API / Purview Atlas relationships | Lineage drawer from card/details; upstream/downstream graph | Comm/GCC (UC), GCC-H (Purview), IL5 (Atlas) | ⚠️ partial | **T10** lineage drawer |
| F15 | **Data-plane access** (read item folders) | ADLS list/get; UC table list | Item "Browse" → Tables (Delta tree) + Files (folder tree) | all | ✅ built (Tables tab) | Files tab parity (**T3**) |
| F16 | **OneLake SDK / endpoint surfacing** | n/a (display only) | "Connect" panel: ABFS path, .NET/Python/AzCopy snippets, BlobFuse2 mount cmd | all | ❌ missing | **T3** (Connect snippets) |
| F17 | **Workspace ↔ container mapping** admin | Cosmos workspace doc + ADLS container | Workspace settings → storage account/container binding (dropdown) | all | ⚠️ honest-gate | **T7** (folded: workspace storage settings) |
| F18 | **Soft delete / restore** of items | ADLS soft delete + Cosmos `state` | Recycle view: deleted items, restore, purge | all | ❌ missing | **T11** soft-delete/restore |
| F19 | **OneLake file explorer (Windows)** parity | n/a (desktop tool) | honest-gate: doc card "Use Azure Storage Explorer / `azcopy`; ABFS path copyable" | all | ❌ missing | **T3** (documented gate) |
| F20 | **Direct Lake / multi-engine read** note | Synapse Serverless + UC + ADX read same Delta | honest doc panel: "same physical Delta read by Synapse SQL, Spark, ADX" — no Power BI dep | all | ❌ missing | **T8** (doc panel in Govern) |

---

## 3. Azure / OSS services — full feature set + native UI surfaces to rebuild 1:1

For each backing service the team must **inventory the real UI first** (per
`ui-parity.md`, grounded in MS Learn via `microsoft_docs_search` /
`microsoft_docs_fetch`), then build it one-for-one.

### 3.1 ADLS Gen2 (the byte store)
- **Capabilities to surface:** filesystem (container) CRUD; directory
  create/rename/delete (atomic w/ HNS); file Put Block / Flush / Get; List
  Paths (recursive, paged); **access tiers** (Set Blob Tier Hot/Cool/Cold, Copy
  Blob to tier); **Lifecycle Management** policy (≤10 rules; conditions
  `daysAfterModificationGreaterThan` / `daysAfterCreationGreaterThan` /
  `daysAfterLastAccessTimeGreaterThan`; actions `tierToCool` / `tierToCold` /
  `enableAutoTierToHotFromCool` / `delete`; pause/reactivate/template); ACL
  (POSIX, recursive, default-ACL inherit) + Azure RBAC (Storage Blob Data
  Owner/Contributor/Reader/Delegator); soft delete + versioning + change feed;
  diagnostic settings → Log Analytics; private endpoints + firewall.
- **Existing Loom client:** `lib/azure/adls-client.ts` already implements
  `listContainers`, `listPaths`, `getMetadata`, `uploadFile`, `downloadFile`,
  `deletePath`, `createDirectory`, `pathToHttpsUrl`, `getAcl`/`setAcl`,
  `listKnownBlobDataRoles`, `listContainerRoleAssignments`, `grantContainerRole`,
  `revokeContainerRoleAssignment`. **Tasks below extend it — do not re-create.**
- **Native portal UI to rebuild 1:1:** Storage Account → **Storage browser**
  (tree browse, upload/download, properties, **change tier**, ACL, delete,
  move), **Lifecycle management** blade (rules grid + condition/action pickers +
  templates), **Access Control (IAM)** blade (role assignments), **Networking**
  blade, **Encryption** blade.

### 3.2 Cosmos DB (item registry)
- **Capabilities:** DB+container creation (PK `/workspaceId`), CRUD/upsert,
  SQL-API query (single + cross-partition), TTL, autoscale RU/s,
  **data-plane RBAC** (no master key).
- **Existing client:** `lib/azure/cosmos-client.ts` (`itemsContainer()`,
  `workspacesContainer()`) and `lib/azure/cosmos-data-client.ts` (AAD data-plane,
  `CosmosDataPlaneRbacError` honest-gate). **Reuse — do not re-create.**
- **Native UI to rebuild 1:1:** Cosmos **Data Explorer** is *not* a Loom
  surface; Loom surfaces item docs through the OneLake catalog grid. The
  data-plane RBAC honest-gate must remain.

### 3.3 Databricks Unity Catalog (metadata/lineage — Comm/GCC)
- **Capabilities:** metastore discovery; catalog/schema/table/volume CRUD;
  permission list/update (REST PATCH); SQL GRANT/REVOKE; **table lineage** API;
  federated search across workspaces (`LOOM_DATABRICKS_HOSTNAMES`).
- **Existing client:** `lib/azure/unity-catalog-client.ts` (547 lines — all of
  the above plus `UnityCatalogNotConfiguredError` honest-gate). **Reuse.**
- **Native UI to rebuild 1:1:** Databricks **Catalog Explorer** lineage graph
  (upstream/downstream nodes, hop expansion) → Loom lineage drawer (T10).

### 3.4 Microsoft Purview Data Map (governance — GCC-H/IL4; Atlas for IL5)
- **Capabilities:** Atlas 2.2 entity CRUD; classifications; lineage
  relationships; discovery query API; data-plane role gate.
- **Existing client:** `lib/azure/purview-client.ts` (`PurviewNotConfiguredError`
  classic-only honest-gate). **Reuse.**
- **Bicep:** `platform/fiab/bicep/modules/admin-plane/catalog.bicep` already
  dispatches Purview (classic Data Map) vs Apache-Atlas-on-AKS per boundary +
  grants Data Curator. **Extend, don't re-create.**
- **Native UI to rebuild 1:1:** Purview governance domain / health → Loom
  **Govern** tab (T8): governance score, label coverage, classification
  rollup.

### 3.5 Azure Key Vault (shortcut secrets)
- **Capabilities:** secretRef for external shortcut creds (S3 access key, GCS
  service-account JSON, ADLS SAS). Reuse existing `keyvault-client`. Never store
  a credential in Cosmos or in the item doc — only a `secretRef`.

---

## 4. TASK LIST (sequenced, zero-stub)

> Every task is **done only when**: (a) real Azure backend is called on the
> default path (Fabric UNSET) or an honest-gate MessageBar names the exact
> missing env/role/resource; (b) `tsc` clean; (c) vitest green; (d) real-data
> E2E receipt captured against live Commercial; (e) parity doc updated; (f)
> bicep/env synced if infra/env added; (g) UAT click-through passes. No mock
> arrays, no `return []`, no `useState(MOCK_DATA)`, no dead buttons, no empty
> tabs.

Each task names the **exact files**, the **backend/REST**, the
**bicep/portability** work, the **UI**, and the **acceptance criteria**.

---

### T1 — Item card: endorsement badge + owner avatar + domain badge
- **Goal:** Bring catalog cards to OneLake parity for endorsement, owner, and
  domain (currently read but not rendered).
- **Files:**
  - `apps/fiab-console/app/onelake/page.tsx` (card render in `ItemTile` usage)
  - `apps/fiab-console/lib/components/ui/item-tile.tsx` (add `endorsement`,
    `owner`, `domain` props + Fluent `Badge`/`Avatar`)
  - `apps/fiab-console/app/api/items/by-type/route.ts` (project
    `c.endorsement`, `c.sensitivityLabel`, `c.createdBy`, workspace `domain`)
- **Backend/REST:** extend the existing Cosmos `SELECT` projection in
  `by-type/route.ts`; join workspace doc for `domain`/displayName via
  `workspacesContainer()`. No new service.
- **Bicep/portability:** none (Cosmos field projection only). Cloud-agnostic.
- **UI:** Fluent v9 `Badge` (Certified=brand filled, Promoted=outline),
  `Avatar` with initials, domain `Badge` subtle. Loom tokens; tooltip on each.
- **Acceptance:** card for a Certified item shows the chip; owner avatar
  resolves to `createdBy`; domain badge shows workspace domain; details pane
  unchanged; no item without endorsement renders an empty chip (conditional).

### T2 — Sensitivity label chip on card + set-label action
- **Goal:** Surface Purview MIP sensitivity label on the card and let an owner
  set it.
- **Files:**
  - `item-tile.tsx` (label chip), `onelake/page.tsx`
  - `apps/fiab-console/lib/azure/purview-client.ts` (reuse label read; add
    `listSensitivityLabels()` if absent)
  - `apps/fiab-console/app/api/items/[type]/[id]/sensitivity/route.ts` (new:
    GET available labels, PUT set label → write to Cosmos item + Purview entity)
- **Backend/REST:** read labels from Purview MIP; persist selected label to the
  Cosmos item doc and (when Purview configured) tag the Atlas entity. Honest-gate
  `PurviewNotConfiguredError` → MessageBar naming `LOOM_PURVIEW_ACCOUNT`.
- **Bicep/portability:** Purview classic Data Map already in `catalog.bicep`;
  GCC-H uses Purview, IL5 falls to Atlas (label store = Cosmos only, MessageBar
  notes MIP unavailable). Verify suffix resolution.
- **UI:** label chip on card; "Set sensitivity" in details pane = dropdown of
  labels (no freeform). Confirmation toast.
- **Acceptance:** setting a label writes Cosmos + Purview (verified by re-GET);
  card chip updates; missing Purview shows the named MessageBar, not a crash.

### T3 — OneLake path/URI model + card overflow menu + Connect snippets
- **Goal:** OneLake's DFS/Blob/ABFS/GUID URI model + "Get URL" / "Copy path"
  parity, plus the "Connect" panel with SDK snippets.
- **Files:**
  - `apps/fiab-console/lib/azure/onelake-path.ts` (new: translate Loom
    `{account,container,itemPath}` ↔ DFS/Blob/ABFS/GUID forms via the same
    cloud-suffix resolver `adls-client` uses)
  - `item-tile.tsx` (Fluent `Menu` overflow: Open, Copy OneLake path, Get URL
    (DFS), View lineage, Properties)
  - `apps/fiab-console/lib/components/onelake/properties-panel.tsx` (new:
    DFS/Blob/ABFS/GUID rows w/ copy buttons; Connect tab w/ .NET / Python /
    AzCopy / BlobFuse2 snippets)
  - unit test `onelake-path.test.ts`
- **Backend/REST:** pure translation; account/container resolved from the item's
  Cosmos doc (`storageAccount`,`container`,`rootPath`). No network call.
- **Bicep/portability:** **cloud-matrix unit test required** — assert
  `dfs.core.windows.net` (Commercial) vs `dfs.core.usgovcloudapi.net` (Gov)
  selected by the resolver; never hard-code.
- **UI:** overflow menu actions all functional (clipboard write); Properties
  panel shows 4 URI forms; Connect snippets are correct + copyable; F19 desktop
  gate is a doc card pointing to Storage Explorer/azcopy with the ABFS path.
- **Acceptance:** "Copy OneLake path" puts the correct ABFS string on the
  clipboard for both Commercial and Gov; snippets compile/run shape-wise;
  cloud-matrix test green.

### T4 — Internal shortcuts: CRUD + test + broken-status
- **Goal:** Lakehouse→lakehouse (internal) shortcut parity on ADLS passthrough.
- **Files:**
  - `apps/fiab-console/lib/azure/shortcut-client.ts` (new or extend if present)
  - `apps/fiab-console/app/api/items/[type]/[id]/shortcuts/route.ts` (GET list,
    POST create), `.../shortcuts/[name]/route.ts` (DELETE, PATCH), `.../test`
  - `apps/fiab-console/lib/components/onelake/shortcut-wizard.tsx` (new)
- **Backend/REST:** shortcut = metadata in the item's Cosmos doc + an ADLS
  passthrough validation (`getMetadata` on the target container/path to confirm
  reachability and RBAC). "Test" = live ADLS HEAD; "broken" when target missing
  or 403.
- **Bicep/portability:** none new; relies on ADLS RBAC already granted.
- **UI:** wizard (source item picker → Tables/Files path browse → name),
  list grid with status pill (OK / Broken), edit, delete, Test button.
- **Acceptance:** create points at a real lakehouse path; Test returns live OK;
  deleting a target flips status to Broken on next Test; no mock list.

### T5 — External shortcuts: S3 / GCS / ADLS / Dataverse connectors
- **Goal:** External-source shortcut parity with creds via Key Vault.
- **Files:**
  - `shortcut-client.ts` (add connectors), `keyvault-client` (secretRef)
  - `app/api/items/[type]/[id]/shortcuts/route.ts` (external branch)
  - `shortcut-wizard.tsx` (source-type step: ADLS Gen2 / Amazon S3 / Google
    Cloud Storage / Dataverse)
- **Backend/REST:** per source, validate connectivity with the real SDK
  (S3 ListObjects head, GCS list, ADLS getMetadata, Dataverse table read);
  store creds **only** as KV `secretRef`. Honest-gate when KV not configured
  (name `LOOM_SHORTCUT_KEYVAULT`).
- **Bicep/portability:** add KV access policy / RBAC for the Console UAMI in the
  KV bicep module if not present; cross-cloud S3/GCS reachable from all Azure
  clouds (egress note for Gov).
- **UI:** source-type cards w/ logos, creds form (key/secret or SA JSON or SAS),
  "Browse remote" tree, name. No freeform JSON.
- **Acceptance:** an S3 shortcut created with a real bucket lists remote objects
  in the browse tree; creds land in KV (verified by secret name, never echoed);
  Test returns live OK.

### T6 — Storage tiers (Hot/Cool/Cold) management
- **Goal:** OneLake storage-tier (preview) parity.
- **Files:**
  - `apps/fiab-console/lib/azure/adls-client.ts` (add `setBlobTier`,
    `getBlobTier`, `copyBlobToTier`)
  - `app/api/onelake/tier/route.ts` (new: GET tier of path, PUT change tier)
  - `apps/fiab-console/lib/components/onelake/tier-dialog.tsx` (new)
  - Files-tab/details: add **Tier** column
- **Backend/REST:** Azure Blob `Set Blob Tier` (Hot→Cool/Cold) and `Copy Blob`
  (Cool/Cold→Hot, to avoid early-deletion penalty) via `@azure/storage-blob`.
- **Bicep/portability:** access tiers GA in all four clouds; no infra. Note
  early-deletion penalties (Cool 30d, Cold 90d) in UI copy.
- **UI:** Tier column with chip; "Change tier" dialog (radio Hot/Cool/Cold +
  early-deletion warning MessageBar when downgrading). Confirmation toast.
- **Acceptance:** changing a real file Hot→Cool reflects on re-GET; Cold→Hot
  uses Copy Blob; warning shown; no mock tier.

### T7 — Lifecycle management rules editor + workspace storage binding
- **Goal:** OneLake Lifecycle Management (≤10 rules/workspace) + workspace↔
  storage-account binding parity.
- **Files:**
  - `adls-client.ts` (add `getLifecyclePolicy`, `setLifecyclePolicy`)
  - `app/api/onelake/lifecycle/route.ts` (GET/PUT policy for a workspace's
    storage account)
  - `apps/fiab-console/lib/components/onelake/lifecycle-rules.tsx` (new)
  - workspace settings page: storage-account/container binding dropdown
- **Backend/REST:** ADLS Lifecycle Management policy (Storage Account
  management-plane via ARM). Enforce ≤10 rules.
- **Bicep/portability:** the Console UAMI needs **Storage Account Contributor**
  (mgmt-plane) on bound accounts to set policy — add the role assignment to the
  storage bicep module; honest-gate MessageBar naming that role if absent.
  GA all clouds.
- **UI:** rules grid (Add / Edit / Delete / Pause / Reactivate / Create from
  template); rule editor = scope (whole-WS or path prefix), status
  (Active/Inactive), condition picker (`daysAfter*GreaterThan`), action picker
  (`tierToCool`/`tierToCold`/`enableAutoTierToHotFromCool`/`delete`). All
  dropdowns/wizard — **no JSON textarea**.
- **Acceptance:** adding a rule writes the live ADLS policy (verified by re-GET);
  pause flips `status:Disabled`; >10 rules blocked with inline error; missing
  role shows named MessageBar.

### T8 — Catalog **Govern** tab
- **Goal:** OneLake catalog Govern surface.
- **Files:**
  - `apps/fiab-console/app/onelake/page.tsx` (add Govern tab/pivot)
  - `apps/fiab-console/lib/components/onelake/govern-view.tsx` (new)
  - `app/api/onelake/governance/route.ts` (new: aggregate label coverage,
    classification rollup, endorsement counts, items-needing-attention)
- **Backend/REST:** aggregate Cosmos item metadata + Purview classifications
  (reuse `purview-client`); compute governance score (% labeled, % endorsed, %
  with owner). Honest-gate when Purview unset (Cosmos-only metrics + MessageBar).
- **Bicep/portability:** reuse `catalog.bicep` (Purview classic / Atlas IL5).
- **UI:** score cards, label-coverage donut, classification table, "items
  needing attention" list (deep-link to item). Include F20 doc panel:
  "same physical Delta read by Synapse SQL, Spark, ADX — no Power BI required."
- **Acceptance:** metrics computed from real Cosmos+Purview data; deep-links
  work; Purview-unset path shows Cosmos metrics + the named MessageBar.

### T9 — Catalog **Secure** tab
- **Goal:** OneLake catalog Secure surface (access matrix).
- **Files:**
  - `onelake/page.tsx` (Secure tab), `lib/components/onelake/secure-view.tsx`
  - `app/api/onelake/security/route.ts` (new: roll up Azure RBAC role
    assignments on bound storage + UC grants + ADLS container ACL)
- **Backend/REST:** reuse `adls-client.listContainerRoleAssignments` + UC
  `listPermissions`; present a who-has-access matrix per item/workspace.
- **Bicep/portability:** no new infra; UC path Comm/GCC, ACL/RBAC all clouds.
- **UI:** principal × access-level matrix; role-assignment summary; "OneLake
  security roles" panel; link to grant flow (ADLS `grantContainerRole`).
- **Acceptance:** matrix reflects live RBAC + ACL; granting a role updates the
  matrix on refresh; no mock principals.

### T10 — Lineage drawer (item-to-item)
- **Goal:** OneLake lineage parity from card/details.
- **Files:**
  - `lib/components/onelake/lineage-drawer.tsx` (new)
  - `app/api/items/[type]/[id]/lineage/route.ts` (new)
  - reuse `unity-catalog-client.getTableLineage` + `purview-client` relationships
- **Backend/REST:** UC lineage (Comm/GCC), Purview Atlas relationships
  (GCC-H), Atlas-on-AKS (IL5). Honest-gate when none configured.
- **Bicep/portability:** reuse `catalog.bicep`; per-boundary backend select.
- **UI:** drawer with upstream/downstream node graph (reuse the React-Flow
  canvas already in the repo), hop expansion, click-to-open node.
- **Acceptance:** a real lineage edge renders for a table with known upstream;
  unconfigured backend shows named MessageBar, not empty graph.

### T11 — Soft-delete / restore (Recycle view)
- **Goal:** OneLake item soft-delete + restore parity.
- **Files:**
  - `app/onelake/page.tsx` (Recycle entry), `lib/components/onelake/recycle-view.tsx`
  - `app/api/onelake/recycle/route.ts` (GET deleted, POST restore, DELETE purge)
- **Backend/REST:** item `state:'deleted'` in Cosmos + ADLS **soft delete**
  (blob soft-delete) for the item folder; restore = un-delete blobs + Cosmos
  `state:'active'`; purge = hard delete.
- **Bicep/portability:** enable blob soft-delete (retention days) on bound
  storage in the storage bicep module; GA all clouds.
- **UI:** deleted-items grid w/ deleted-on, deleted-by, days-remaining; Restore
  + Purge buttons w/ confirm.
- **Acceptance:** delete moves an item to Recycle (ADLS folder soft-deleted);
  Restore brings it back live; Purge removes it; retention window shown.

---

## 5. Per-task Claude Code dev-loop

Run this loop **for every task T1–T11**. Do not advance until the gate passes.

1. **Code.** Implement the task's files. Reuse existing clients
   (`adls-client`, `cosmos-client`, `cosmos-data-client`, `unity-catalog-client`,
   `purview-client`, `keyvault-client`) — never re-create. Route every host
   through the cloud-suffix resolver. No mock arrays, no `return []`, no
   `useState(MOCK_DATA)`, no dead buttons, no empty tabs. Fluent v9 + Loom
   tokens; dropdowns/wizards only (no JSON textarea).
2. **Validate / test.**
   - `pnpm -C apps/fiab-console exec tsc --noEmit` → zero errors.
   - `pnpm -C apps/fiab-console exec vitest run <task test files>` → green,
     including the **cloud-matrix unit test** (Commercial vs Gov suffix) for any
     path/endpoint code.
   - `pnpm -C apps/fiab-console build` (Next build must succeed — it is the gate
     per the CI-gaps note).
   - **Real-data E2E** against live Commercial with `LOOM_DEFAULT_FABRIC_WORKSPACE`
     **UNSET**: mint a session cookie, hit the new `/api/...` route, capture the
     real response body (first 300 chars) showing real Azure data **or** the
     honest-gate MessageBar payload naming the exact env/role/resource.
3. **Docs.** Update the parity doc `docs/fiab/parity/onelake.md` (and
   `docs/fiab/parity-gap/page-onelake.md`) — flip the task's rows from ❌/🔶/⚠️
   to ✅ or honest-gate ⚠️ with the backend named. Update any affected
   `docs/fiab/workloads/onelake-parity.md` content. Docs are source-of-truth
   (BLOCKING) — no feature lands without its doc edit.
4. **UAT.** Browser walk (Playwright or Chrome MCP): click **every** new
   control and confirm it does what its label says against the live backend —
   per the no-scaffold rule, DOM strings ≠ parity. Capture a screenshot or
   Playwright trace. Confirm keyboard navigation + readable layout (no overlaps).
5. **Iterate** until 1–4 all pass, then open the PR with the real-data E2E
   receipt + screenshot + bicep diff (if any) in the body. Fix review findings;
   re-run the loop.

---

## 6. Experience Definition of Done (whole OneLake experience)

OneLake is **done (grade A / A+)** only when **all** of the following hold with
`LOOM_DEFAULT_FABRIC_WORKSPACE` **UNSET** and no Fabric/Power BI tenant present:

- **Fabric-free:** zero hits for `onelake.dfs.fabric.microsoft.com` /
  `api.fabric.microsoft.com` / `api.powerbi.com` on any default code path
  (`grep` per `no-fabric-dependency.md` returns nothing outside opt-in
  branches); no `fabricWorkspaceId` read without an Azure fallback in the same
  function.
- **No vaporware:** zero `return []` / `return {}` / `useState([{` /
  `MOCK_/SAMPLE_/TODO` in `app/onelake`, `app/api/onelake`,
  `app/api/items/by-type`, and the new OneLake components; every control calls a
  real backend or shows an honest-gate MessageBar naming the exact missing
  env/role/resource.
- **Parity table fully green:** every row in §2 is ✅ built or ⚠️ honest-gate —
  **zero ❌, zero 🔶, zero stub banners.** Endorsement, sensitivity, owner,
  domain, overflow/Get-URL, Govern, Secure, tiers, lifecycle, shortcuts
  (internal+external), lineage, soft-delete all functional.
- **All 4 clouds:** every path/endpoint resolves the correct suffix
  (`dfs.core.windows.net` vs `dfs.core.usgovcloudapi.net`, `documents.azure.com`
  vs `documents.azure.us`); cloud-matrix unit tests green; GCC-H/IL5 governance
  falls to Purview/Atlas with honest gates where UC is unavailable.
- **Bicep-synced:** every new env var added to the `apps[]` env list in
  `admin-plane/main.bicep`; every new role (Storage Account Contributor for
  lifecycle, blob soft-delete config, KV access for shortcut secrets) added to
  the relevant bicep module; `az deployment sub create -f
  platform/fiab/bicep/main.bicep` + bootstrap reproduces the feature set.
- **Tested + documented:** vitest + a Playwright UAT spec cover the OneLake
  catalog (Explore/Govern/Secure, shortcuts, tiers, lifecycle, lineage);
  `docs/fiab/parity/onelake.md` shows every inventory row built ✅ or honest-gate
  ⚠️; a Learn popup explains the experience.
- **Receipts attached:** each merged PR carries a real-data E2E receipt
  (endpoint + real response first 300 chars), a browser screenshot/trace, and a
  bicep diff for any infra change. Reviewers reject any PR missing the receipt.

When all of the above hold, update `docs/fiab/prp/README.md` to set OneLake's
grade and add it to the per-experience index with its task count (11).
