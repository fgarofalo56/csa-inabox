# PRP — Governance & Security at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › **Governance & Security** — the OneLake
> Catalog (Explore + Govern), Fabric Domains, workspace/item access management,
> OneLake security (folder/table RBAC, RLS, CLS), SQL granular security, and the
> full Microsoft Information Protection (MIP) sensitivity-label + Purview DLP
> lifecycle.
> **Parity target:** Microsoft Fabric's governance & security surfaces — OneLake
> Catalog Explore/Govern tabs, Admin-portal Domains, Workspace roles + Manage
> Access, item-level sharing + Manage Permissions, OneLake Security roles, SQL
> analytics endpoint / Warehouse T-SQL granular security, sensitivity labels
> (manual / default / mandatory / inheritance / batch / export protection /
> protected labels / label-based access control) and Purview DLP policies.
> **Hard rule — no Fabric dependency.** Per `.claude/rules/no-fabric-dependency.md`,
> **every feature here must be 100% functional on an Azure-native backend by
> default, with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET and no real Fabric capacity
> or Power BI workspace.** Fabric Admin / Power BI Admin / Purview **Unified
> Catalog** (`purview.microsoft.com`, `/datagovernance/*`) endpoints are
> **opt-in only**, selected per-feature via `LOOM_<FEATURE>_BACKEND=fabric` (or
> `=purview-unified`) **and** a bound workspace/account. If either is absent,
> Loom silently uses the Azure-native path — **no gate, no "bind a Fabric
> workspace" error on the default path.**
> **Hard rule — no vaporware.** Per `.claude/rules/no-vaporware.md`, **no stubs,
> no `return []`, no `useState(MOCK_DATA)`, no static cards.** Each task lands a
> real backend call (Azure REST / Cosmos / Graph / Storage RBAC / TDS) **or** an
> honest infra-gate Fluent `MessageBar intent="warning"` naming the exact env
> var / role / resource — and the full UI surface still renders.
> **Hard rule — UI parity.** Per `.claude/rules/ui-parity.md`, every surface gets
> a parity doc under `docs/fiab/parity/` and must match the source Azure/Fabric
> UI one-for-one (theme differs, functionality does not). DOM strings ≠ parity —
> the validator clicks every control.
> **No freeform config.** Per `loom_no_freeform_config`, all configuration is
> dropdowns / wizards / WYSIWYG / pickers. The **only** allowed text editor is a
> 1:1 T-SQL / WHERE-predicate authoring surface (Monaco) for SQL granular
> security, matching the native SQL editor.

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What this experience is

Microsoft Fabric's Governance & Security experience is the union of three
historically separate planes, presented as one:

1. **OneLake Catalog** — the tenant-wide discovery surface (Explore tab) plus a
   governance-posture dashboard (Govern tab) with Admin and Data-Owner views.
2. **Access & tenancy** — Admin-portal **Domains** (logical data-mesh grouping),
   **Workspace roles** (Admin/Member/Contributor/Viewer) + Manage Access,
   **item-level sharing** + Manage Permissions, and **OneLake Security**
   (folder/table RBAC, RLS, CLS) inside lakehouse/mirrored items, plus **SQL
   granular security** (T-SQL GRANT / RLS policy / dynamic data masking) on the
   SQL analytics endpoint and Warehouse.
3. **Protection** — the full **MIP sensitivity-label** lifecycle (manual,
   default, mandatory, inheritance, batch, export protection, protected labels,
   label-based access control) and **Purview DLP** policies + policy tips.

CSA Loom rebuilds all of it 1:1 behind **one identical UI with two backends per
feature**, isolated behind server-side store interfaces so the React surface
never branches on backend:

- **Default (all four clouds): Azure-native.** Domains, workspace roles, item
  permissions, OneLake security, posture metrics, and the catalog all live in
  **Azure Cosmos DB** (the Loom control-plane store), with the *actual* access
  enforced by **Azure RBAC role assignments** on the backing **ADLS Gen2 /
  Synapse** resources, **ACL-based folder/table grants** on ADLS, **T-SQL**
  executed against **Synapse / Azure SQL** for SQL granular security, **Microsoft
  Graph** for identity pickers + DLP/MIP read, **Microsoft Purview classic Data
  Map** for the physical asset/label graph, **Azure AI Search** for catalog
  discovery, **Azure Monitor / Log Analytics** for tenant-wide posture metrics,
  and **Azure OpenAI (GPT-4o)** for the Govern-tab Copilot. **This path works
  with no Fabric, no Power BI workspace, no Unified Catalog account.**
- **Opt-in (Commercial, per-feature):** Fabric Admin REST
  (`/v1/admin/domains`, workspace `roleAssignments`, item `securityRoles`,
  `/share`), Power BI Admin label APIs, and Purview Unified Catalog
  (`/datagovernance/*`). Selected only via `LOOM_<FEATURE>_BACKEND` + a bound
  workspace/account. The exact same Loom UI calls these instead of the
  Azure-native adapter.

### 1.2 Azure-native + OSS backing services

| Governance concern | Azure-native DEFAULT | Opt-in alternative | OSS component | Loom client / module |
|---|---|---|---|---|
| Catalog discovery (Explore) | **Azure AI Search** index `loom-governance-items` over **Cosmos `governance-items`** | Fabric REST Catalog Search | Elasticsearch (concept) | `aisearch-client`, `cosmos-client`, `onelake-catalog-client` |
| Posture metrics (Govern) | **Azure Monitor / Log Analytics** KQL + **Cosmos** aggregates | Fabric Admin Monitoring workspace | dbt (freshness pipeline) | `monitor-client`, `cosmos-client` |
| Posture chart render | **Power BI Embedded** (Commercial) / **Azure Managed Grafana** (Gov) | Fabric semantic model | Apache Superset / Grafana (OSS) | `powerbi-client`, new `grafana-embed` |
| Govern-tab Copilot | **Azure OpenAI GPT-4o** (RAG over chart data) | Fabric Copilot | — | `foundry-client`, `copilot-orchestrator` |
| Domains / subdomains | **Cosmos `governance-domains`** mirrored to classic Purview **collections** | Fabric Admin `/v1/admin/domains` | — | `purview-client`, `cosmos-client`, new `domains-client` |
| Domain image gallery | **Azure Blob Storage** curated container `domain-images` | Fabric hosted gallery | — | `adls-client` / blob |
| Workspace roles + Manage Access | **Cosmos `workspace-roles`** ⇄ **Azure RBAC** on backing RG/resources | Fabric `/v1/workspaces/{id}/roleAssignments` | — | new `workspace-roles-client`, `access-policy-client` |
| Identity pickers (users/groups/SPN) | **Microsoft Graph** `/users`,`/groups`,`/servicePrincipals` | same | — | new `graph-identity-client` |
| Item-level permissions + sharing | **Cosmos `item-permissions`** ⇄ **Azure RBAC / ADLS ACL** on the backing data | Fabric item `/share`, `/permissions` | — | new `item-permissions-client` |
| OneLake security (folder/table RBAC) | **ADLS Gen2 POSIX ACLs + RBAC** on Delta folders/tables (+ Synapse table registration) | Fabric `/lakehouses/{id}/securityRoles` | Apache Ranger (concept) | `adls-client`, new `onelake-security-client` |
| OneLake RLS (WHERE predicate) | **Synapse/SQL view + `SECURITY POLICY`** over the Delta table | Fabric OneLake RLS | — | `synapse-sql-client`, `onelake-security-client` |
| OneLake CLS (hidden columns) | **Synapse/SQL `GRANT/DENY` on columns** + masked view | Fabric OneLake CLS | — | `synapse-sql-client` |
| SQL granular security (T-SQL) | **Synapse / Azure SQL TDS**: GRANT, RLS `CREATE FUNCTION`+`SECURITY POLICY`, Dynamic Data Masking | Fabric Warehouse TDS | — | `synapse-sql-client`, `azure-sql-client`, `sql-objects-client` |
| Sensitivity labels (read taxonomy) | **Microsoft Graph** Information Protection (`/security/informationProtection/sensitivityLabels`) | Power BI labels API | — | `mip-graph-client` |
| Apply / batch label | **Cosmos label-assignment** + classic **Purview** label on asset (+ Graph `setLabels` opt-in) | Power BI Admin `setLabels` | — | `mip-graph-client`, `purview-client` |
| DLP policies + tips | **Microsoft Graph / Purview DLP** read (`dlp-graph-client`) + Cosmos policy cache | Purview DLP for Fabric | — | `dlp-graph-client` |
| Label-based access control / protected labels | **AIP/MIP protection (Graph)** + RBAC enforcement on backing store | Power BI protection policies | — | `mip-graph-client`, `access-policy-client` |
| Audit trail (domain/permission CRUD) | **Microsoft Purview Audit REST** (`/audit/query`) + **Log Analytics** | M365 Unified Audit | — | `purview-client`, `monitor-client` |
| Posture refresh jobs | **Azure Functions** (timer + on-demand) writing Cosmos aggregates | Fabric auto-refresh | — | (functions app) |
| Secrets | **Azure Key Vault** secretRef | — | — | `kv-secrets-client` |

### 1.3 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High | DoD IL5/IL6 | Endpoint / caveat |
|---|---|---|---|---|---|
| **Cosmos DB control-plane (DEFAULT)** | GA | GA | GA | GA (FedRAMP High) | `documents.azure.com` ⇄ `documents.azure.us`; covers **every** cloud — this is why control state lives in Cosmos |
| **Azure RBAC / ADLS ACL enforcement** | GA | GA | GA | GA | ARM mgmt suffix split (`management.azure.com` ⇄ `management.usgovcloudapi.net`) |
| Azure AI Search (Explore) | GA | GA | GA | GA | `search.windows.net` ⇄ `search.azure.us` (USGov Virginia/Arizona) |
| Microsoft Graph (identity, MIP/DLP read) | GA | GA | GA | GA | `graph.microsoft.com` ⇄ `graph.microsoft.us` (Gov) / `dod-graph.microsoft.us` (DoD) |
| Synapse / Azure SQL TDS (SQL security) | GA | GA | GA | GA | `database.windows.net` ⇄ `database.usgovcloudapi.net` |
| Azure Monitor / Log Analytics (posture) | GA | GA | GA | GA | `api.loganalytics.io` ⇄ `api.loganalytics.us` |
| Classic Purview Data Map (labels/audit) | GA | GA | GA | GA | metadata-policy roles, not ARM RBAC |
| Azure OpenAI (Govern Copilot) | GA | GA (USGov) | GA (USGov) | **IL5-approved**, verify per workload | `openai.azure.com` ⇄ `openai.azure.us` |
| **Power BI Embedded (chart render)** | GA | ❌ use **Managed Grafana** | ❌ use **Managed Grafana** | ❌ use **Managed Grafana** | not in Gov portal — Gov path renders via Azure Managed Grafana |
| Azure Blob (domain gallery) | GA | GA | GA | GA | `blob.core.windows.net` ⇄ `blob.core.usgovcloudapi.net` |
| **Fabric Admin / Power BI Admin (OPT-IN)** | GA | GA `powerbigov.us` | GA `high.powerbigov.us` | GA `mil.powerbigov.us` | opt-in only; never on the default path |
| **MIP / DLP labels** | GA | GA | GA per plan | **partial in DoD** — fallback: Azure Policy + Purview DoD-tenant classification | label taxonomy available; DoD DLP gap is honest-gated |
| **Purview Unified Catalog (OPT-IN)** | GA | ❌ | ❌ | ❌ | `purview.microsoft.com`; Commercial-only, opt-in only |

**Implication for code (critical):** the **Cosmos + Azure-RBAC + Synapse-TDS +
Graph** stack is the default in **all four clouds** and the only thing assumable.
Fabric Admin / Power BI Admin / Unified Catalog are **opt-in, Commercial-leaning**
and never gate the default path. **No host may be hard-coded** — every client must
resolve its suffix through a shared `cloud-endpoints` helper. (Audit finding: no
central `cloud-endpoints.ts` exists yet — suffixes are resolved ad-hoc per client.
**Task 0 below creates it** so all governance clients share one resolver across
the four clouds.)

### 1.4 Surface topology in Loom

```
/governance
 ├─ /catalog            Explore tab  ← AI Search over Cosmos governance-items  (BUILT — upgrade)
 ├─ /govern             Govern tab   ← Monitor/Log Analytics + Cosmos + PBI-Embedded/Grafana + AOAI Copilot
 │    ├─ ?view=admin    Admin view
 │    └─ ?view=owner    Data-owner view (owner={me})
 ├─ /domains            Domains      ← Cosmos governance-domains ⇄ Purview collections (DEFAULT) | Fabric Admin (opt-in)
 ├─ /sensitivity        MIP labels   ← Graph IP taxonomy + Cosmos assignment + Purview label (BUILT manual — extend)
 └─ /policies           DLP          ← dlp-graph-client + Cosmos policy cache (read built — extend to tips)
workspace / item context (per item editor):
 ├─ Manage Access pane  Workspace roles ← Cosmos workspace-roles ⇄ Azure RBAC
 ├─ Share dialog        Item sharing    ← Cosmos item-permissions ⇄ RBAC/ACL
 ├─ Manage Permissions  Item perms page ← same
 └─ Security tab        OneLake sec     ← ADLS ACL + Synapse view/policy (RLS/CLS) ; SQL Security wizard (T-SQL)
```

---

## 2. Feature-by-feature parity table

Legend — **Status today** (from audit): ✅ built · ⚠️ honest-gate (renders,
partial backend, MessageBar) · 🔶 stub (renders, no API wiring) · ❌ missing.

| # | Fabric feature | Azure-native backend (DEFAULT) | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| F1 | OneLake Catalog — Explore tab | AI Search index over Cosmos `governance-items`; Graph for access filtering | `/governance/catalog` table: Name/Type/Owner/Refreshed/Location/Endorsement/Sensitivity; domain selector; faceted filters; per-row overflow (lineage/permissions/share/external-share); "Request access" for discoverable | All 4 | ✅ built | Replace static domain selector with live domains; upgrade substring search → AI Search facets; add discoverable-item flag + Request-Access CTA |
| F2 | OneLake Catalog — Govern (Admin view) | Monitor/Log Analytics KQL + Cosmos aggregates + Graph DLP/MIP + PBI-Embedded/Grafana + AOAI | `/governance/govern?view=admin` 3 sub-tabs (Manage estate / Protect-secure-comply / Discover-trust-reuse); summary tiles; "View more" → embedded report; recommended-action cards; domain scope; Copilot | All 4 (Grafana in Gov) | 🔶 stub (static cards) | Build 3 sub-tabs on real KQL/Graph/Cosmos; trigger-scan button; embedded report; action cards from Cosmos; AOAI Copilot |
| F3 | OneLake Catalog — Govern (Data-owner view) | Same, server-filtered `owner={me}` from Entra token; Azure Function refresh on open | `/governance/govern?view=owner` smaller cards: label coverage, curation state, inventory; owner-scoped action cards; Copilot | All 4 | ❌ missing | Build owner-scoped variant; populate ownership in Cosmos via scanner enrichment; on-open Function refresh |
| F4 | Fabric Domains (CRUD, assign, delegated settings, image gallery) | Cosmos `governance-domains` ⇄ Purview collections; Blob gallery; Graph groups; Purview Audit | `/governance/domains` Tab + side-pane (General/Image/Admins/Contributors/Default/Delegated) + create dialog + assign-workspaces pane (by name/admin/capacity) | All 4 (Fabric opt-in) | ⚠️ honest-gate (Purview read only) | Wire full Cosmos CRUD + Purview-collection mirror; Blob image gallery; workspace assignment; delegated settings (cert + default label); audit trail; Fabric Admin adapter opt-in |
| F5 | Workspace Roles & Access Management | Cosmos `workspace-roles` ⇄ Azure RBAC on backing resources; Graph identity search | "Manage Access" side-pane: add user/group/SPN, role dropdown (Admin/Member/Contributor/Viewer), remove; nested-group resolution to highest role | All 4 (Fabric opt-in) | ❌ missing | Build pane; `workspace-roles-client` (GET/POST/DELETE Cosmos + RBAC); Graph picker; nested-group resolver |
| F6 | Item-Level Permissions & Sharing | Cosmos `item-permissions` ⇄ RBAC/ADLS ACL on backing data | Share dialog (multi-step: recipient search + permission checkboxes: Read/Edit/Reshare/ReadData/ReadAll-SQL/ReadAll-Spark/Execute/Build) + Manage Permissions page (list/add/remove, DLP badges) | All 4 (Fabric opt-in) | ⚠️ honest-gate (DLP read only) | Build Share dialog + Manage Permissions page; `item-permissions-client`; revoke-on-next-signin note; DLP restrict-access reflection |
| F7 | OneLake Security (folder/table RBAC roles) | ADLS Gen2 ACL+RBAC on Delta folders/tables; Synapse table registration | Security tab in Lakehouse/Mirrored-Catalog/Mirrored-DB editor: role cards, create-role wizard (pick folders/tables + members), DefaultReader/DefaultReadWriter warning | All 4 (Fabric opt-in) | 🔶 stub (client only) | Build Security tab + role wizard; `onelake-security-client` over ADLS ACL; default-role warnings |
| F8 | OneLake Row-Level Security (WHERE predicate) | Synapse/SQL view + `CREATE SECURITY POLICY` over Delta table | RLS sub-section in Security tab: WHERE editor (Monaco, 1000-char, regex-validated), "Test predicate" button, OR-union note, Preview badge | All 4 | 🔶 stub | Build RLS editor; generate+execute SECURITY POLICY via `synapse-sql-client`; test-predicate runs SELECT |
| F9 | OneLake Column-Level Security (hidden columns) | Synapse/SQL `GRANT/DENY` on columns + masked view | CLS sub-section: multi-select column picker, hidden list, role-conflict warning, deny-semantic note | All 4 | 🔶 stub | Build CLS editor; column GRANT/DENY generation; conflict detection |
| F10 | SQL analytics endpoint — User's-identity mode | Synapse/SQL connection mode (delegated vs caller token); Cosmos accessMode flag | "Data access mode" section: Delegated/User's-identity radios, one-time confirmation dialog | All 4 | 🔶 stub | Build section; PATCH accessMode in Cosmos; switch connection auth in `synapse-sql-client` |
| F11 | Warehouse / SQL endpoint — SQL granular security (T-SQL) | Synapse/Azure SQL TDS: object GRANT, column GRANT, RLS function+policy, DDM | "SQL Security" side panel + Monaco T-SQL editor; wizards: Object GRANT, Column GRANT, Row-level policy, Dynamic Data Masking; Entra-auth only | All 4 | ✅ built | Done: `lib/panes/sql-security-panel.tsx` + `lib/sql/tsql-builders.ts` + `app/api/items/[type]/[id]/sql-security/route.ts`; 4 wizards generate+preview+execute real T-SQL over TDS (Entra-only); EXECUTE-AS verify; RLS honest-gated on Serverless. Parity: `docs/fiab/parity/sql-security.md` |
| F12 | Sensitivity labels — manual labeling | Graph IP taxonomy; Cosmos assignment + Purview label on asset | Label flyout on item header (PATCH label); greyed labels per policy; descriptions | All 4 | ✅ built (API) | Wire flyout on item header; apply via PATCH; policy-greyed labels; descriptions |
| F13 | Sensitivity labels — default labeling (tenant + domain) | Cosmos tenant/domain default-label config; applied on create | Admin tenant settings: enable toggle + label picker; Domain → Delegated → default-label dropdown | All 4 | 🔶 placeholder | Build tenant + domain default-label config; apply on item creation |
| F14 | Sensitivity labels — mandatory labeling | Cosmos policy flag; intercept save flow | Tenant settings "Require label" toggle + "Power BI only" info card; intercept save | All 4 | 🔶 placeholder | Build toggle; enforce at item-save; info card |
| F15 | Sensitivity labels — downstream inheritance | Azure Function polling lineage; Cosmos propagation state | Lineage-view propagation-status indicator | All 4 | 🔶 placeholder | Function polls lineage every N min; indicator; document rules |
| F16 | Sensitivity labels — inheritance on creation | Read source item label; pre-populate | Creation dialog: pre-populated read-only label + override | All 4 | 🔶 placeholder | Read source label; pre-populate; allow override; refresh |
| F17 | Sensitivity labels — inheritance from data sources | Read upstream label; semantic-model field | Read-only "Sensitivity label source" field | All 4 | 🔶 placeholder | Add field; document PBI semantic models only |
| F18 | Sensitivity labels — programmatic / batch | Cosmos batch job + Purview label loop (Power BI Admin `setLabels` opt-in) | Admin batch-labeling page: multi-select items + label picker + Apply-to-selection + results | All 4 | ❌ missing | Build batch page; bulk apply via Purview/Cosmos; results grid |
| F19 | Sensitivity labels — export path protection | Check label + publishing policy; AIP encryption step | Export flow: encryption-info step; warn/block unsupported (CSV/TXT) | All 4 | 🔶 placeholder | Check label+policy in export; encryption step; block unsupported |
| F20 | Protected labels (publishing policies) | Graph protection config read; RBAC rights check | Read protected-label + rights tier; check rights before "Change label"; deep-link Purview | All 4 (config in Purview) | ⚠️ honest-gate | Read protection from Graph; show tier; gate change-label; deep-link |
| F21 | Protection policies — label-based access control | AIP/MIP protection + RBAC enforcement on backing store | Label drives access; enforced via RBAC on ADLS/SQL | All 4 | 🔶 placeholder | Map label → RBAC grants/denies; enforce on backing store |
| F22 | DLP policies + policy tips | `dlp-graph-client` read + Cosmos cache; restrict-access reflection | `/governance/policies`: policy list, violations, last-scan, trigger-scan; policy tips on items | All 4 (DoD partial) | ⚠️ honest-gate | Extend to tips + trigger-scan + restrict-access propagation; DoD honest-gate |

---

## 3. Azure / OSS service feature sets + native UI surfaces to rebuild 1:1

For each backing service, the **full capability set** Loom must expose and the
**native UI surface** it mirrors. Per `ui-parity.md`, inventory the real UI
first (ground in Microsoft Learn), then build every row.

### 3.1 Azure Cosmos DB (control-plane store)
- **Capabilities:** partitioned containers, point read/write, SQL query,
  optimistic concurrency (ETag), TTL, change feed (drives AI Search indexing &
  Function refresh).
- **Containers this experience adds:** `governance-items`, `governance-domains`,
  `workspace-roles`, `item-permissions`, `label-assignments`, `dlp-policy-cache`,
  `posture-aggregates`, `recommended-actions`, `audit-events`.
- **Native UI mirrored:** none directly — Cosmos is the store behind every
  governance surface. Use `cosmos-client` `createIfNotExists` per `no-vaporware`
  bicep-sync rule.

### 3.2 Azure RBAC + ADLS Gen2 ACLs (enforcement plane)
- **Capabilities:** role assignments at subscription/RG/resource scope; ADLS
  POSIX ACLs (read/execute on folders, read on files) + default ACLs; managed
  identity grants.
- **Native UI mirrored:** Azure portal **Access control (IAM)** blade (role
  assignment add/remove, condition builder) and Storage **Manage ACL** dialog.
  Loom's Manage-Access / Share / Security tab surfaces map 1:1 to these.

### 3.3 Synapse Serverless/Dedicated SQL + Azure SQL (TDS)
- **Capabilities:** `GRANT/DENY/REVOKE` (object + column), `CREATE FUNCTION`
  (inline TVF predicate) + `CREATE SECURITY POLICY` (RLS), Dynamic Data Masking
  (`ADD MASKED WITH`), views, Entra-only auth.
- **Native UI mirrored:** the **SQL editor / query window** (Monaco) plus
  SSMS-style **Security** node wizards (RLS, DDM). Loom's SQL Security panel +
  RLS/CLS sub-sections rebuild these.

### 3.4 Microsoft Graph (identity + MIP/DLP)
- **Capabilities:** `/users`, `/groups`, `/servicePrincipals` search + transitive
  membership; `/security/informationProtection/sensitivityLabels` (taxonomy +
  parent/child + protection); DLP policy + evaluation read.
- **Native UI mirrored:** Entra **people picker**; Purview compliance portal
  **label taxonomy**; DLP **policy list**. Loom's identity pickers + label flyout
  + DLP page rebuild these.

### 3.5 Microsoft Purview classic Data Map (labels/lineage/audit/collections)
- **Capabilities:** Atlas entities + classifications + label assignment;
  collections (mirror domains); lineage graph; Audit REST `/audit/query`.
- **Native UI mirrored:** Purview governance portal **Data Map**, **Collections**,
  **Lineage**, **Audit**. Loom domains ⇄ collections; lineage view; audit viewer.

### 3.6 Azure Monitor / Log Analytics (posture metrics)
- **Capabilities:** KQL over activity/usage logs; aggregations; on-demand query.
- **Native UI mirrored:** Fabric **Admin Monitoring workspace** report. Loom
  Govern tab recomputes via KQL + Cosmos aggregates (the gap noted in the parity
  map — replicated via Azure Functions, equivalent but operationally maintained).

### 3.7 Power BI Embedded / Azure Managed Grafana (chart render)
- **Capabilities:** embed token; report render; (Grafana) dashboards + panels over
  Log Analytics/ADX datasources.
- **Native UI mirrored:** Govern-tab "View more" → full report. Commercial =
  Power BI Embedded; **GCC/GCC-High/DoD = Azure Managed Grafana** (PBI Embedded
  not in Gov portals).

### 3.8 Azure OpenAI (Govern Copilot)
- **Capabilities:** GPT-4o chat; RAG over chart/aggregate JSON; function-calling.
- **Native UI mirrored:** Fabric Copilot "ask about this chart". Loom routes the
  chart's aggregate JSON as RAG context.

### 3.9 Azure Blob Storage (domain image gallery)
- **Capabilities:** container + blob listing; SAS/managed-identity read.
- **Native UI mirrored:** Fabric domain **Image** picker (Microsoft-hosted
  gallery) → Loom-hosted `domain-images` container.

### 3.10 OSS (concept-level alternatives)
- **Apache Ranger** — folder/table policy model reference for OneLake security.
- **Apache Superset / Grafana** — chart render alternative if no PBI Embedded.
- **Elasticsearch** — AI Search alternative for catalog facets.

---

## 4. Sequenced task list (implementation-ready, no stubs/mocks)

Each task: **goal · files · backend/REST · bicep/portability · UI · acceptance
(real data, zero stub)**. Tasks are ordered by dependency. Paths are relative to
repo root; `lib` = `apps/fiab-console/lib`, `app` = `apps/fiab-console/app`.

> **Global acceptance gate (applies to every task):** verified with
> `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, against a real Azure backend, with a
> minted-session cookie. Receipt = endpoint hit + first 300 chars of real
> response + browser screenshot/Playwright trace. No `return []`, no
> `useState(MOCK_*)`, no static cards. `next build` + `tsc --noEmit` + `vitest`
> green. Bicep diff attached if infra changed.

### Task 0 — Shared cloud-endpoints resolver (foundation)
- **Goal:** one resolver so every governance client picks the right host across
  Commercial/GCC/GCC-High/DoD; no hard-coded suffixes.
- **Files:** create `lib/azure/cloud-endpoints.ts` (exports `getArmHost`,
  `getCosmosSuffix`, `getSearchSuffix`, `getGraphHost`, `getSqlSuffix`,
  `getLogAnalyticsHost`, `getBlobSuffix`, `getOpenAiSuffix`, `getPbiGovHost`),
  driven by `LOOM_CLOUD` env (`commercial|gcc|gcchigh|dod`).
- **Backend/REST:** none (pure config).
- **Bicep:** add `LOOM_CLOUD` to `apps[]` env in `admin-plane/main.bicep`.
- **UI:** none.
- **Acceptance:** `vitest` covers all 4 clouds for each getter; refactor at least
  `cosmos-client`, `aisearch-client`, `mip-graph-client`, `dlp-graph-client`,
  `synapse-sql-client` to call it; no string `.azure.us`/`usgovcloudapi`/`powerbigov`
  left outside this module (grep clean).

### Task 1 — Identity picker client (Graph)
- **Goal:** reusable user/group/SPN search with transitive membership.
- **Files:** create `lib/azure/graph-identity-client.ts`; create
  `lib/components/ui/identity-picker.tsx`; route `app/api/governance/identities/search/route.ts`.
- **Backend/REST:** Graph `GET /users`, `/groups`, `/servicePrincipals` (`$search`),
  `GET /groups/{id}/transitiveMembers` for nested-group resolution. Host via Task 0.
- **Bicep:** ensure console UAMI has Graph `User.Read.All`, `Group.Read.All`,
  `Application.Read.All` (add to admin-plane role grants).
- **UI:** Fluent combobox with avatars, type chips (User/Group/SPN), debounce.
- **Acceptance:** typing a real UPN returns live Graph results; group expands to
  transitive members; honest-gate MessageBar if Graph scopes missing (names the
  exact grant).

### Task 2 — Catalog Explore upgrade (F1)
- **Goal:** live domain selector + AI Search facets + discoverable items.
- **Files:** edit `app/governance/catalog/page.tsx`,
  `lib/azure/onelake-catalog-client.ts`, `lib/azure/aisearch-client.ts`;
  route `app/api/governance/catalog/route.ts`; index def in
  `lib/azure/search-field-shapes.ts`.
- **Backend/REST:** AI Search `POST /indexes/loom-governance-items/docs/search`
  with `facets`; Cosmos change-feed → AI Search indexer; domain list from Task 4
  client; Graph access filter.
- **Bicep:** create AI Search index `loom-governance-items` (deploymentScript or
  `createIfNotExists`); add `LOOM_AI_SEARCH_SERVICE` if absent.
- **UI:** replace static domain dropdown with live domains; left facet panel
  (type/endorsement/sensitivity/tags/domain); discoverable rows show
  "Request access" CTA.
- **Acceptance:** facets reflect real counts; domain scope filters live; a
  Promoted/Certified item the caller can't open still appears with Request-Access;
  no substring-only fallback.

### Task 3 — Domains client + mirror (F4 backend)
- **Goal:** real domain CRUD on Cosmos, mirrored to Purview collections; Fabric
  Admin adapter opt-in.
- **Files:** create `lib/azure/domains-client.ts` (interface `DomainStore`,
  adapters `cosmosDomainStore`, `fabricAdminDomainStore`); edit `purview-client.ts`
  (collection mirror already exists ~`:949`); routes
  `app/api/governance/domains/route.ts`, `.../[domainId]/route.ts`,
  `.../[domainId]/assignWorkspaces/route.ts`.
- **Backend/REST:** **DEFAULT** Cosmos `governance-domains` CRUD + Purview
  collection upsert; **OPT-IN** Fabric Admin `POST/PATCH/DELETE /v1/admin/domains`,
  `POST /v1/admin/domains/{id}/assignWorkspaces` (selected by
  `LOOM_DOMAINS_BACKEND=fabric`). Audit via Purview `/audit/query`.
- **Bicep:** Cosmos `governance-domains` container; Blob `domain-images` container
  + seed approved gallery images; grant UAMI Storage Blob Data Reader on it.
- **UI:** none (client/routes only).
- **Acceptance:** create/edit/delete a domain persists in Cosmos and creates a
  Purview collection (reason:"live"); assign-workspaces writes membership; audit
  event recorded; works with no Fabric workspace.

### Task 4 — Domains UI (F4 surface)
- **Goal:** Tab + side-pane + dialog parity with Fabric Admin Domains.
- **Files:** create `app/governance/domains/page.tsx`,
  `lib/panes/domain-settings-pane.tsx`, `lib/components/domain-image-gallery.tsx`.
- **Backend/REST:** Task 3 routes; Task 1 picker for Admins/Contributors;
  MIP taxonomy (Task 12) for delegated default label; Blob gallery list.
- **Bicep:** none beyond Task 3.
- **UI:** domains list (overflow → Settings / Delete); create dialog; side-pane
  tabs General/Image/Admins/Contributors/Default-domain/Delegated; assign-pane
  (by name / admin / capacity) with override warning.
- **Acceptance:** every side-pane tab functional against live backend; image
  picker shows real Blob gallery; delegated default-label persists; parity doc
  `docs/fiab/parity/domains.md` shows zero ❌.

### Task 5 — Workspace roles & Manage Access (F5)
- **Goal:** workspace RBAC pane on Cosmos ⇄ Azure RBAC.
- **Files:** create `lib/azure/workspace-roles-client.ts`,
  `lib/panes/manage-access-pane.tsx`; routes
  `app/api/workspaces/[id]/role-assignments/route.ts`, `.../[principalId]/route.ts`.
- **Backend/REST:** **DEFAULT** Cosmos `workspace-roles` + Azure RBAC role
  assignment on the workspace's backing RG/resources (`access-policy-client`);
  **OPT-IN** Fabric `GET/POST/DELETE /v1/workspaces/{id}/roleAssignments`. Nested
  group → highest role via Task 1 transitive resolver.
- **Bicep:** ensure console UAMI has Role Based Access Control Administrator
  (constrained) — already granted per `csa_loom_governance_buildassist`; verify.
- **UI:** Manage Access pane: add identity, role dropdown
  (Admin/Member/Contributor/Viewer), change role, remove; ReadAll vs ReadData note.
- **Acceptance:** adding a real group with Member creates the Cosmos row + RBAC
  assignment; nested group resolves to highest role; remove revokes; honest-gate
  if RBAC-admin missing.

### Task 6 — Item permissions & sharing (F6)
- **Goal:** Share dialog + Manage Permissions page on Cosmos ⇄ RBAC/ACL.
- **Files:** create `lib/azure/item-permissions-client.ts`,
  `lib/dialogs/share-item-dialog.tsx`, `app/items/[type]/[id]/permissions/page.tsx`;
  routes `app/api/items/[type]/[id]/share/route.ts`,
  `.../permissions/route.ts`.
- **Backend/REST:** **DEFAULT** Cosmos `item-permissions` + RBAC/ADLS-ACL on the
  backing data per permission (Read→ACL read; ReadAll-SQL→SQL GRANT;
  ReadAll-Spark→OneLake ACL; Build→semantic-model RBAC); **OPT-IN** Fabric item
  `/share`, `/permissions`. Reflect DLP restrict-access (Task 22).
- **Bicep:** none beyond existing RBAC grants.
- **UI:** multi-step Share dialog (recipient search → permission checkboxes:
  Read/Edit/Reshare/ReadData/ReadAll-SQL/ReadAll-Spark/SubscribeOneLakeEvents/
  Execute/Build); Manage Permissions page (list/add/remove, DLP badges,
  revoke-on-next-signin note).
- **Acceptance:** sharing Read to a real user creates Cosmos row + ACL grant;
  Manage Permissions lists live rows; DLP-restricted items show badge; no stub list.

### Task 7 — OneLake Security tab + role wizard (F7)
- **Goal:** folder/table RBAC roles inside lakehouse/mirrored items.
- **Files:** create `lib/azure/onelake-security-client.ts`,
  `lib/panes/onelake-security-tab.tsx`; route
  `app/api/items/[type]/[id]/security-roles/route.ts`.
- **Backend/REST:** **DEFAULT** ADLS Gen2 ACL+RBAC on Delta folders/tables via
  `adls-client` (+ Synapse table registration); virtualized membership from
  Cosmos; **OPT-IN** Fabric `GET/POST /lakehouses/{id}/securityRoles`.
- **Bicep:** none.
- **UI:** Security tab (Lakehouse/Mirrored-Catalog/Mirrored-DB): role cards,
  create-role wizard (pick folders/tables + members via Task 1),
  DefaultReader/DefaultReadWriter warning.
- **Acceptance:** creating a role grants real ADLS ACLs on the chosen folders;
  members enumerated; default-role warning shown; verified by reading back ACLs.

### Task 8 — OneLake RLS editor (F8)
- **Goal:** WHERE-predicate row-level security on the item's tables.
- **Files:** edit `lib/panes/onelake-security-tab.tsx` (RLS sub-section);
  extend `lib/azure/synapse-sql-client.ts`.
- **Backend/REST:** generate + execute `CREATE FUNCTION` (inline TVF) +
  `CREATE SECURITY POLICY` over the Delta-backed Synapse view; "Test predicate"
  runs `SELECT` with the predicate.
- **Bicep:** none.
- **UI:** Monaco WHERE editor (1000-char limit, regex validation), Test-predicate
  button, OR-union explanatory note, Preview badge.
- **Acceptance:** saving a predicate creates a real security policy; test returns
  filtered live rows; invalid predicate blocked with precise error.

### Task 9 — OneLake CLS editor (F9)
- **Goal:** hidden-column security per role.
- **Files:** edit `lib/panes/onelake-security-tab.tsx` (CLS sub-section);
  `synapse-sql-client.ts`.
- **Backend/REST:** column `GRANT/DENY` + masked view generation.
- **UI:** column multi-select picker, hidden-columns list, role-conflict warning,
  deny-semantic note.
- **Acceptance:** hiding a column produces real DENY; querying as that role omits
  the column; conflict detection fires on overlap.

### Task 10 — SQL endpoint data-access mode (F10)
- **Goal:** delegated vs user's-identity connection mode.
- **Files:** create `lib/panes/sql-access-mode-section.tsx`; route
  `app/api/items/[type]/[id]/access-mode/route.ts`; edit `synapse-sql-client.ts`.
- **Backend/REST:** PATCH accessMode in Cosmos; `synapse-sql-client` honors mode
  (service identity vs caller token) on connect.
- **UI:** Delegated / User's-identity radios + one-time confirmation dialog.
- **Acceptance:** switching to user's-identity makes a real query run under the
  caller's token; persisted; confirmation explains one-time nature.

### Task 11 — SQL granular security wizards (F11) — ✅ SHIPPED
- **Goal:** T-SQL object/column GRANT, RLS, DDM on Warehouse/SQL endpoint.
- **Files:** create `lib/panes/sql-security-panel.tsx`,
  `lib/sql/tsql-builders.ts`; reuse `lib/azure/sql-objects-client.ts`,
  `synapse-sql-client.ts`; route `app/api/items/[type]/[id]/sql-security/route.ts`.
- **Backend/REST:** execute generated T-SQL via TDS (Entra auth only): object
  `GRANT`, column `GRANT`, RLS `CREATE FUNCTION`+`SECURITY POLICY`, DDM
  `ALTER COLUMN ADD MASKED`.
- **UI:** Monaco T-SQL editor + 4 wizards (Object GRANT / Column GRANT /
  Row-level policy / Dynamic Data Masking) each with a preview-SQL pane before run.
- **Acceptance:** each wizard executes real T-SQL and the effect is verifiable
  (e.g., masked column returns masked value for the test principal); Entra-only.
- **Delivered:** `lib/sql/tsql-builders.ts` (pure, injection-safe builders + 23
  unit tests) → `app/api/items/[type]/[id]/sql-security/route.ts`
  (GET catalog state; POST preview/execute/verify; dispatches Synapse
  Dedicated/Serverless + Azure SQL; RLS honest-gated on Serverless) →
  `lib/panes/sql-security-panel.tsx` (4 wizards + Current-security tab + Monaco
  preview pane + EXECUTE-AS verify). Mounted in the Azure SQL editor ("SQL
  security" tab) and Synapse Dedicated/Serverless editors (ribbon → dialog).
  db_owner bootstrap: `platform/fiab/bootstrap/sql-security-bootstrap.sql`.
  Parity doc: `docs/fiab/parity/sql-security.md`. Capability:
  `service.sql-security`.

### Task 12 — Sensitivity-label flyout (F12) + taxonomy
- **Goal:** wire manual labeling to the item header.
- **Files:** create `lib/components/label-flyout.tsx`; edit item header
  component; reuse `lib/azure/mip-graph-client.ts`; route
  `app/api/items/[type]/[id]/sensitivity-label/route.ts`.
- **Backend/REST:** Graph IP taxonomy (built); apply via Cosmos `label-assignments`
  + Purview label on asset; greyed labels per policy; descriptions.
- **UI:** label flyout on header, greyed disallowed labels, tooltips.
- **Acceptance:** applying a label persists + reflects in catalog; policy-blocked
  labels greyed with reason; no mock taxonomy.

### Task 13 — Default + mandatory labeling (F13, F14)
- **Goal:** tenant/domain default label + mandatory enforcement.
- **Files:** edit tenant-settings page (or create
  `app/admin/tenant-settings/sensitivity/page.tsx`); edit domain delegated tab
  (Task 4); enforcement hook in item-create flow.
- **Backend/REST:** Cosmos config docs; apply default on create; block save if
  mandatory and unlabeled.
- **UI:** enable toggle + label picker (tenant), default-label dropdown (domain),
  "Require label" toggle + "Power BI only" info card.
- **Acceptance:** new item gets default label; mandatory blocks unlabeled save
  with MessageBar; verified live.

### Task 14 — Label inheritance + propagation (F15, F16, F17)
- **Goal:** inheritance on creation, from sources, and downstream propagation.
- **Files:** edit creation dialogs (pre-populate); semantic-model detail field;
  Lineage view indicator; create Azure Function `label-propagation`.
- **Backend/REST:** read source label; Function polls lineage every N min and
  writes Cosmos propagation state.
- **UI:** pre-populated read-only label + override on create;
  "Sensitivity label source" field; lineage propagation-status indicator.
- **Acceptance:** child inherits parent label on create; lineage shows real
  propagation state; documented rules.

### Task 15 — Batch labeling (F18)
- **Goal:** admin bulk-apply labels.
- **Files:** create `app/admin/batch-labeling/page.tsx`; route
  `app/api/admin/batch-labeling/route.ts`.
- **Backend/REST:** bulk loop over Cosmos `label-assignments` + Purview label
  (opt-in Power BI Admin `setLabels`); results per item.
- **UI:** multi-select items, label picker, Apply-to-selection, results grid.
- **Acceptance:** selecting 10 real items + applying writes 10 live label
  assignments; results show success/failure per item; no fake success.

### Task 16 — Export protection + protected/label-based access (F19, F20, F21)
- **Goal:** export encryption enforcement, protected-label gating, label→RBAC.
- **Files:** edit export flow; create `lib/azure/label-protection.ts`.
- **Backend/REST:** read protection config via Graph; check rights before
  change-label; map protected label → RBAC grants/denies on backing store.
- **UI:** export encryption-info step (warn/block CSV/TXT); protected-label tier
  badge; deep-link Purview for config.
- **Acceptance:** exporting a protected item to CSV is blocked with reason; a user
  lacking rights cannot change a protected label; label change adjusts real RBAC.

### Task 17 — Govern tab: Admin view (F2)
- **Goal:** 3 real sub-tabs of posture insights + Copilot + embedded report.
- **Files:** create `app/governance/govern/page.tsx`,
  `lib/panes/govern-admin.tsx`, `lib/azure/posture-client.ts`; routes under
  `app/api/governance/govern/*`; Azure Function `posture-refresh`.
- **Backend/REST:** Sub-tab 1 — Fabric/inventory from Cosmos + capacity/domain;
  feature usage from Log Analytics KQL. Sub-tab 2 — Graph IP coverage % +
  `dlp-graph-client` violations/last-scan + trigger-scan (Purview scanner).
  Sub-tab 3 — freshness/description/endorsement from Cosmos; sharing from Audit.
  Copilot via Azure OpenAI (chart JSON as RAG). "View more" → Power BI Embedded
  (Commercial) / Managed Grafana (Gov).
- **Bicep:** Cosmos `posture-aggregates`, `recommended-actions`; Function timer;
  PBI Embedded capacity OR Managed Grafana (Gov); `LOOM_AOAI_*` env;
  Log Analytics workspace id env.
- **UI:** 3 sub-tabs, summary tiles, recommended-action cards (insight/impact/
  remediation from Cosmos), domain scope, "Ask about this chart" input, Refresh.
- **Acceptance:** each tile shows real aggregates; trigger-scan starts a real
  Purview scan; Copilot answers from live chart data; "View more" renders a real
  embedded report; honest-gate (named env) where a metric source is absent.

### Task 18 — Govern tab: Data-owner view (F3)
- **Goal:** owner-scoped posture variant.
- **Files:** edit `app/governance/govern/page.tsx` (`?view=owner`); create
  `lib/panes/govern-owner.tsx`; extend `posture-refresh` Function for on-open.
- **Backend/REST:** all queries add `owner={me}` from Entra token; on tab-open
  Function refreshes that user's Cosmos cache.
- **UI:** smaller cards (label coverage, curation, inventory), owner-scoped action
  cards, Copilot.
- **Acceptance:** view shows only the signed-in user's items; refresh on open
  works within cold-start budget; no cross-owner leakage.

### Task 19 — DLP policies + tips (F22)
- **Goal:** full DLP surface + policy tips + restrict-access propagation.
- **Files:** edit `app/governance/policies/page.tsx`,
  `lib/azure/dlp-graph-client.ts`; route `app/api/governance/dlp/*`.
- **Backend/REST:** DLP read (built) → add violations list, last-scan, trigger-scan;
  restrict-access action removes access for non-exempt users (RBAC/ACL revoke +
  Cosmos `item-permissions` update); policy tips shown on items.
- **Bicep:** ensure UAMI has Purview DLP read + scanner trigger roles.
- **UI:** policy list, violations, last-scan, trigger-scan; per-item policy tip
  badge; DoD honest-gate MessageBar (DLP partial).
- **Acceptance:** real policies + violations render; trigger-scan starts a real
  scan; restrict-access revokes real access; DoD shows honest fallback note.

### Task 20 — Parity docs + DoD
- **Goal:** one parity doc per surface; whole-experience DoD.
- **Files:** create `docs/fiab/parity/{onelake-catalog-explore,onelake-catalog-govern,domains,workspace-access,item-sharing,onelake-security,sql-security,sensitivity-labels,dlp}.md`.
- **Acceptance:** each parity doc has inventory + Loom coverage (✅/⚠️ only, zero
  ❌) + backend-per-control; `MASTER-SCORECARD.md` updated.

---

## 5. Claude Code DEV-LOOP per task

Run this loop **per numbered task**; do not advance until the task's acceptance
criteria pass with real data and zero stubs.

1. **Coding agent** — implement the task's files. Use existing clients
   (`cosmos-client`, `adls-client`, `synapse-sql-client`, `mip-graph-client`,
   `dlp-graph-client`, `aisearch-client`, `purview-client`, `access-policy-client`)
   before writing new ones. Default path = Azure-native; Fabric/PBI/Unified
   adapters are opt-in behind `LOOM_<FEATURE>_BACKEND` + bound resource. No
   `return []`, no `useState(MOCK_*)`, no static cards. Where infra is absent,
   render an honest `MessageBar intent="warning"` naming the exact env var / role
   / resource and link the bicep module.
2. **Validation / test agent** —
   - `pnpm --filter fiab-console exec tsc --noEmit` (zero errors).
   - `pnpm --filter fiab-console build` (`next build` must pass — per
     `csa_loom_ci_gaps`, build-breaks have reached deploy before).
   - `pnpm --filter fiab-console vitest run <touched specs>` (add a spec per new
     client/route; env `node` for route tests, `jsdom` for component tests).
   - **Real-data E2E:** mint a session cookie, hit the new endpoint, capture the
     first 300 chars of the **real** response, and Playwright-click every new
     control. Confirm Azure backend reason:"live" (or the honest-gate MessageBar).
     Run with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.
   - On failure: revert task status to "doing", hand the failing assertion +
     response body back to the coding agent; iterate.
3. **Docs agent** — update the task's `docs/fiab/parity/<slug>.md` (inventory +
   coverage + backend-per-control), update any affected `docs/fiab/*`, and the
   Learn popup for the surface. Per `docs_source_of_truth`, docs ship with the
   feature, not after.
4. **UAT agent** — live side-by-side vs the real Azure/Fabric UI (per
   `no_scaffold_claims` + `parity_validation_standard`): screenshot the source
   UI, screenshot Loom, click every control, confirm same workflow/outcome. DOM
   strings ≠ parity. Grade the surface (target B/A/A+). If < B or any ❌ in the
   parity doc, loop back to step 1.

**Loop exit:** tsc + build + vitest green **and** real-data E2E receipt attached
**and** parity doc shows zero ❌ **and** UAT grade ≥ B. Then mark the task done
and open the PR with the receipt in the body (reviewers reject any PR without it).

**Orchestration note:** isolate parallel tasks in worktrees (`EnterWorktree`) to
avoid the pnpm node_modules corruption documented in
`fiab_console_pnpm_worktree_gotcha`; never run parallel `pnpm install` against the
shared `node_modules`.

---

## 6. Definition of done (whole experience)

The Governance & Security experience is **done** when **all** hold:

1. **Every row F1–F22** in §2 is **✅ built** or **⚠️ honest-gate** — **zero 🔶
   stubs, zero ❌ missing.** No static cards, no `useState(MOCK_*)`, no
   `return []` (grep per `no-vaporware` returns nothing in
   `app/governance`, `lib/panes`, `lib/azure` governance clients).
2. **Default path is Azure-native and Fabric-free.** Every surface installs and
   functions with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, no Power BI workspace,
   no Unified Catalog account. Grep per `no-fabric-dependency` finds no default-path
   Fabric gate and no `api.fabric.microsoft.com` / `api.powerbi.com` /
   `onelake.dfs.fabric` on a non-opt-in code path; every `fabricWorkspaceId` read
   has an Azure fallback in the same function.
3. **Real backends, verified.** Domains persist to Cosmos + mirror to Purview
   collections; workspace/item access writes real Azure RBAC/ACL; OneLake
   security writes real ADLS ACLs and Synapse security policies; SQL wizards
   execute real T-SQL; labels persist via Graph/Purview; DLP reads + triggers real
   scans; posture tiles compute from real Log Analytics/Graph/Cosmos. Each has a
   real-data E2E receipt.
4. **All four clouds.** Every host resolves through `cloud-endpoints.ts` (Task 0);
   Commercial/GCC/GCC-High/DoD verified or honestly gated (PBI Embedded→Managed
   Grafana in Gov; DoD DLP fallback noted; Unified Catalog Commercial-opt-in only).
5. **Bicep-synced.** Every new Cosmos container, AI Search index, Blob container,
   Azure Function, env var, and role grant is in
   `platform/fiab/bicep/**` and wired into the orchestrator; a clean
   `az deployment sub create` + bootstrap reproduces the full feature set.
6. **UI parity proven.** A parity doc exists per surface with zero ❌ and
   backend-per-control; `MASTER-SCORECARD.md` updated; every surface UAT-graded
   ≥ B via live side-by-side click-through (not DOM strings).
7. **Docs current.** `docs/fiab/*` and per-surface Learn popups reflect the
   shipped behavior; no clarifying-question artifacts leaked into product UI
   (per `no_questions_in_product`).
8. **Quality gates green.** `tsc --noEmit`, `next build`, and `vitest` pass in CI;
   the fiab-console build is a required check.
