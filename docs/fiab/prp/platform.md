# PRP — Platform & Admin at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › **Platform & Admin** — the Fabric **Admin
> portal** (gear → Governance and insights), every workspace-management surface
> (create/settings/roles/folders/task-flows), tenant settings, capacity & compute
> management, Git integration (source control), Spark/compute config, advanced
> networking, customer-managed keys, audit logs, domains, users & licenses,
> usage metrics, and feature usage & adoption.
> **Parity target:** Microsoft Fabric's Platform & Admin surfaces — Admin portal
> left-nav (12 sections), Workspace create wizard + Settings panels (General,
> License, M365/SharePoint, Azure connections, OneLake storage, CMK, Git, Spark
> compute, Jobs, Advanced networking), Workspace roles + Manage Access, folders &
> task flows, tenant settings (~100+ toggles, 15 categories, per-group scoping),
> capacity settings (view/scale/pause/resume/reassign), users (M365 link),
> domains, audit logs (Purview), refresh summary, embed codes, organizational
> visuals, Azure connections, and the feature usage & adoption report.
> **Hard rule — no Fabric dependency.** Per `.claude/rules/no-fabric-dependency.md`,
> **every feature here must be 100% functional on an Azure-native backend by
> default, with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET and no real Fabric capacity
> or Power BI workspace.** Fabric Admin / Power BI Admin endpoints
> (`api.fabric.microsoft.com`, `api.powerbi.com`) are **opt-in only**, selected
> per-feature via `LOOM_<FEATURE>_BACKEND=fabric` **and** a bound
> workspace/capacity. If either is absent, Loom silently uses the Azure-native
> path — **no gate, no "bind a Fabric workspace" error on the default path.**
> **Hard rule — no vaporware.** Per `.claude/rules/no-vaporware.md`, **no stubs,
> no EmptyState-with-promotional-copy, no `return []`, no `useState(MOCK_DATA)`,
> no dead buttons.** Each task lands a real backend call (ARM / Cosmos / Graph /
> Monitor / Key Vault / DevOps REST) **or** an honest infra-gate Fluent
> `MessageBar intent="warning"` naming the exact env var / role / resource — and
> the full UI surface still renders.
> **Hard rule — UI parity.** Per `.claude/rules/ui-parity.md`, every surface gets
> a parity doc under `docs/fiab/parity/` and must match the source Azure/Fabric UI
> one-for-one (theme differs, functionality does not). DOM strings ≠ parity — the
> validator clicks every control.
> **No freeform config.** Per `loom_no_freeform_config`, all configuration is
> dropdowns / wizards / WYSIWYG / pickers / toggles. No JSON textareas for admin
> config.

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What this experience is

Microsoft Fabric's **Platform & Admin** experience is the tenant- and
workspace-management plane: the Admin portal (12 left-nav sections), the entire
workspace lifecycle (create wizard, settings panels, roles, folders, task
flows), capacity & compute management, tenant-wide feature governance, source
control (Git integration), Spark/compute configuration, advanced networking,
customer-managed-key encryption, audit, users/licenses, domains, and usage &
adoption analytics.

CSA Loom rebuilds all of it 1:1 behind **one identical UI with two backends per
feature**, isolated behind server-side store interfaces so the React surface
never branches on backend:

- **Default (all four clouds): Azure-native.** Workspaces, workspace roles,
  folders, task flows, tenant settings, domains, embed codes, and org visuals
  live in **Azure Cosmos DB** (the Loom control-plane store). The *actual*
  enforcement and inventory come from real Azure: **Azure Resource Manager**
  (capacity inventory across Synapse/ADX/Databricks/VMSS/Cosmos/APIM/AKS),
  **Microsoft Entra ID / Graph** (users, groups, SPNs, role assignments,
  Conditional Access), **Azure RBAC** role assignments on backing resources
  (workspace roles ⇄ RBAC), **Azure Monitor / Log Analytics** (refresh summary,
  usage metrics, diagnostics), **Azure Key Vault** (CMK, secrets), **Azure
  DevOps / GitHub REST** (Git integration), **Azure Databricks / ADX / Synapse
  ARM** (Spark & scale-and-manage compute), **Azure VNet + Private Endpoints +
  Firewall/NSG** (advanced networking), **Microsoft Purview Audit REST** + Log
  Analytics (audit logs), and **Azure Cost Management + Azure Monitor Metrics**
  (capacity cost/utilization). **This path works with no Fabric, no Power BI
  workspace, no F/P SKU capacity.**
- **Opt-in (Commercial + Gov where the host exists, per-feature):** Fabric Admin
  REST (`/v1/admin/tenantsettings`, `/v1/admin/workspaces`, `/v1/admin/capacities`,
  `/v1/admin/domains`, `/v1/admin/activityevents`) and Power BI Admin. Selected
  only via `LOOM_<FEATURE>_BACKEND=fabric` + a bound workspace/capacity. The same
  Loom UI calls these instead of the Azure-native adapter.

### 1.2 Azure-native + OSS backing services

| Admin/Platform concern | Azure-native DEFAULT | Opt-in alternative | OSS component | Loom client / module |
|---|---|---|---|---|
| Admin-portal shell + role gate | **Microsoft Entra** role check (`LOOM_TENANT_ADMIN_OID`/`_GROUP_ID`) + MSAL BFF | Fabric admin-role check | — | `lib/auth/msal.ts`, `AdminShell` |
| Tenant settings | **Cosmos `loom-tenant-settings`** + per-toggle audit | Fabric `/v1/admin/tenantsettings` | — | `tenant-settings-client`, `cosmos-client` |
| Tenant-setting fast fan-out (optional) | **Azure App Configuration** feature flags | — | — | new `appconfig-client` |
| Capacity inventory | **Azure Resource Manager** resource enumeration | Fabric `/v1/admin/capacities` | — | `azure-arm-client` |
| Capacity scale (ADX) | **ADX ARM** SKU change | Fabric capacity resize | — | `kusto-arm-client` |
| Capacity scale (Synapse pool) | **Synapse ARM** pause/resume/scale dedicated pool | — | — | `synapse-pool-arm` |
| Capacity scale (Databricks) | **Databricks REST/ARM** cluster + pool resize | — | — | new `databricks-scale-client` |
| Capacity scale (SHIR) | **Azure VMSS ARM** start (4 nodes) / stop (0) | — | — | `synapse-dev-client` (IR), new `vmss-scale-client` |
| Capacity scale (Container Apps/AKS) | **ARM** containerapp replica / AKS node-pool scale | — | — | new `compute-scale-client` |
| Capacity cost | **Azure Cost Management** `Microsoft.CostManagement/query` | — | — | new `cost-client` |
| Capacity utilization | **Azure Monitor Metrics** (`Microsoft.Insights/metrics`) | Fabric Capacity Metrics app | Grafana (OSS render) | `monitor-client` |
| Workspaces (list/govern) | **Cosmos `loom-workspaces`** + ARM backing-RG link | Fabric `/v1/admin/workspaces` | — | `workspaces-client`, `cosmos-client` |
| Workspace create wizard | **Cosmos** workspace doc + capacity bind + RG provision | Fabric create workspace | — | `workspaces-client`, `install/provisioners` |
| Workspace roles + Manage Access | **Cosmos `workspace-roles`** ⇄ **Azure RBAC** on backing RG | Fabric `roleAssignments` | — | `workspace-roles-client`, `access-policy-client` |
| Folders & task flows | **Cosmos `workspace-folders` / `task-flows`** | Fabric folders / task flows | — | new `folders-client`, `taskflow-client` |
| Identity pickers (users/groups/SPN) | **Microsoft Graph** `/users`,`/groups`,`/servicePrincipals` | same | — | `graph-identity-client` |
| Users & licenses | **Microsoft Graph** users + `assignedLicenses` + Loom role roll-up | M365 admin link | — | `graph-identity-client`, `workspace-roles-client` |
| Domains | **Cosmos `governance-domains`** mirrored to classic Purview collections | Fabric `/v1/admin/domains` | — | `domains-client`, `purview-client` |
| Audit logs | **Microsoft Purview Audit REST** (`/audit/query`) + **Log Analytics** KQL | M365 Unified Audit | — | `purview-client`, `monitor-client` |
| Refresh summary | **Azure Monitor / Log Analytics** (pipeline + dataflow runs) + Cosmos | Fabric refresh summary | — | `monitor-client`, `cosmos-client` |
| Usage metrics & adoption | **Log Analytics** Loom-app telemetry + Cosmos activity | Fabric feature usage report | Grafana/Superset (OSS) | `monitor-client`, new `usage-client` |
| Git integration (source control) | **Azure DevOps REST** + **GitHub REST** (commit/pull workspace item JSON) | Fabric Git integration | — | new `git-integration-client` |
| Spark/compute config | **Azure Databricks** pools/runtimes/libraries + Cosmos defaults | Fabric Spark pools | — | `databricks-scale-client`, new `spark-config-client` |
| Customer-managed keys (CMK) | **Azure Key Vault** key + storage/Cosmos CMK binding (ARM) | Fabric workspace CMK | — | `kv-secrets-client`, new `cmk-client` |
| Advanced networking | **Azure VNet / Private Endpoints / Private DNS / Firewall / NSG** (ARM) | Fabric private links | — | new `networking-client`, `azure-arm-client` |
| Embed codes | **Cosmos `embed-codes`** + signed Loom embed URL | Power BI publish-to-web | — | new `embed-codes-client` |
| Organizational visuals | **Cosmos `org-visuals`** + Blob-stored bundles | Fabric org visuals | — | new `org-visuals-client`, `adls-client`/blob |
| Azure connections (gateway) | **Cosmos `azure-connections`** ⇄ ADLS/Log Analytics bind (ARM) | Fabric Azure connections | — | new `azure-connections-client` |
| Tenant config secrets | **Azure Key Vault** secretRef | — | — | `kv-secrets-client` |
| Background refresh jobs | **Azure Functions** (timer + on-demand) writing Cosmos aggregates | Fabric auto-refresh | — | (functions app) |

### 1.3 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High | DoD IL5/IL6 | Endpoint / caveat |
|---|---|---|---|---|---|
| **Cosmos DB control-plane (DEFAULT)** | GA | GA | GA | GA (FedRAMP High) | `documents.azure.com` ⇄ `documents.azure.us`; all control state lives here |
| **Azure Resource Manager (capacity inventory/scale)** | GA | GA | GA | GA | `management.azure.com` ⇄ `management.usgovcloudapi.net` |
| **Microsoft Entra / Graph (identity, users, RBAC)** | GA | GA | GA | GA | `graph.microsoft.com` ⇄ `graph.microsoft.us` (Gov) / `dod-graph.microsoft.us` (DoD); login `login.microsoftonline.com` ⇄ `login.microsoftonline.us` |
| **Azure RBAC enforcement (workspace roles)** | GA | GA | GA | GA | ARM suffix split as above |
| Azure Monitor / Log Analytics (refresh/usage/audit) | GA | GA | GA | GA | `api.loganalytics.io` ⇄ `api.loganalytics.us` |
| Azure Key Vault (CMK, secrets) | GA | GA | GA | GA | `vault.azure.net` ⇄ `vault.usgovcloudapi.net` |
| Azure Databricks (Spark/scale) | GA | GA | GA | GA | per-workspace host; ARM control plane sovereign |
| Azure Data Explorer ARM (KQL scale) | GA | GA | GA | GA | `kusto.windows.net` ⇄ `kusto.usgovcloudapi.net` |
| Synapse ARM (warehouse scale) | GA | GA | GA | GA | sovereign ARM suffix |
| Azure VMSS ARM (SHIR scale) | GA | GA | GA | GA | sovereign ARM suffix |
| Microsoft Purview Audit (audit logs) | GA | GA | GA | GA | metadata-policy roles; `purview.azure.com` ⇄ `purview.azure.us` |
| Azure Cost Management (capacity cost) | GA | GA | GA | GA (limited; verify per workload) | `management.*` |
| **Azure DevOps (Git integration)** | GA | GA | GA | GA | `dev.azure.com`; **the only Git provider at GCC-High/IL5** |
| **GitHub (Git integration)** | GA | GA | ❌ blocked | ❌ blocked | GitHub.com unreachable in High/IL5 → ADO-only there |
| **Container Apps (Console host)** | GA | GA | ❌ → AKS | ❌ → AKS | High/IL5 host the Console on AKS |
| Azure Kubernetes Service (Console host High/IL5) | GA | GA | GA | GA | — |
| Azure App Configuration (feature flags) | GA | GA | GA | GA | `azconfig.io` ⇄ `azconfig.azure.us` |
| **Fabric Admin / Power BI Admin (OPT-IN)** | GA | GA `powerbigov.us` | GA `high.powerbigov.us` | GA `mil.powerbigov.us` | opt-in only; never on the default path |

**Console hosting rule:** Commercial/GCC host the Loom Console on **Azure
Container Apps**; GCC-High/IL5 host on **AKS** (Container Apps not at IL4+). The
admin UI is identical; only the deploy target changes (bicep param
`LOOM_CONSOLE_HOST=containerapps|aks`).

---

## 2. Feature-by-feature parity table

Status legend: ✅ built & real • ⚠️ honest-gate (renders, names env/role/resource)
• 🔶 stub (renders, does nothing — **forbidden at DoD**) • ❌ missing.
Current status reflects the June-2026 audit; "Target" is the DoD state.

| # | Fabric feature | Azure-native backend | Current Loom status | Work needed |
|---|---|---|---|---|
| F1 | Admin-portal shell + role gate + 12-section left-nav | Entra role check + MSAL BFF | ✅ shell (C — EmptyState landing) | Real section landing tiles w/ live counts |
| F2 | Tenant settings (toggles, search, save, audit) | Cosmos + per-toggle audit | ✅ B (15 cats, ~50 toggles) | Add per-toggle "Apply to" security-group scoping; numeric param fields; expand toward full category coverage |
| F3 | Capacity settings — inventory | ARM enumeration | ✅ B | Capacity-type grouping, per-resource detail pane |
| F4 | Capacity settings — scale/pause/resume | ADX/Synapse/Databricks/VMSS/ContainerApps ARM | ✅ B+ (scaling page, 8 routes) | Inline actions from capacity page; designate-Copilot-capacity equivalent |
| F5 | Capacity settings — cost + utilization | Cost Management + Monitor Metrics | ⚠️ honest-gate (deferred v3.5) | Build cost + CU%/DBU/CPU columns + sparklines |
| F6 | Workspaces — list & govern (all workspaces) | Cosmos `loom-workspaces` + ARM link | 🔶 STUB (UI doesn't fetch) | Wire UI → `/api/admin/workspaces`; states, capacity, item-count, owners |
| F7 | Workspace create wizard | Cosmos doc + capacity bind + RG provision | ❌ | Multi-step wizard: name/desc, contact list, license mode, capacity, advanced |
| F8 | Workspace Settings — General/License/M365/OneLake-storage | Cosmos + ARM + Graph | ❌ | Settings flyout with all panels |
| F9 | Workspace roles + Manage Access | Cosmos `workspace-roles` ⇄ Azure RBAC | partial (permissions page exists) | Per-workspace role grid (Admin/Member/Contributor/Viewer) + identity picker → real RBAC |
| F10 | Folders within workspace | Cosmos `workspace-folders` | ❌ | Nested folder CRUD + drag-move items |
| F11 | Task flows | Cosmos `task-flows` | ❌ | Visual step-sequence canvas + item attach |
| F12 | Git integration (source control) | Azure DevOps + GitHub REST | ❌ | Connect/sync/branch/disconnect; commit workspace item JSON; status |
| F13 | Spark compute config (pools/runtime/env/jobs) | Databricks pools + Cosmos defaults | partial (scaling has databricks) | Starter vs custom pool, node family/size/autoscale, runtime, environment, jobs (timeout/admission) |
| F14 | Customer-managed keys (CMK) | Key Vault key + storage/Cosmos CMK bind | ❌ | KV key picker + bind wizard + status |
| F15 | Advanced networking (inbound/outbound/IP firewall) | VNet/PE/Private DNS/Firewall/NSG (ARM) | 🔶 STUB (network page empty) | Inbound PL protection, outbound rules, IP firewall, trusted instances |
| F16 | Azure connections (ADLS / Log Analytics) | Cosmos + ARM bind | ❌ | Connect ADLS Gen2 + Log Analytics for dataflow/query-log export |
| F17 | Users & licenses | Graph users + `assignedLicenses` + role roll-up | 🔶 STUB | Real user grid, license roll-up, per-user workspace roles, M365 deep-link |
| F18 | Domains (create/manage logical groupings) | Cosmos + Purview collections mirror | 🔶 STUB (dead "Add domain") | Wire to `/api/admin/domains`; image gallery, subdomains, assign workspaces |
| F19 | Audit logs | Purview Audit REST + Log Analytics | 🔶 STUB (route exists, UI doesn't fetch) | Wire UI → `/api/admin/audit-logs`; filters, time range, export |
| F20 | Refresh summary | Monitor/Log Analytics + Cosmos | ❌ | Scheduled-refresh table: item, last run, status, next run, duration |
| F21 | Usage metrics & feature adoption | Log Analytics telemetry + Cosmos | 🔶 STUB ("(preview)" body claims) | Real usage report: actives, top items, adoption, drill-through |
| F22 | Embed codes | Cosmos `embed-codes` + signed URL | ❌ | List/create/revoke embed codes for reports |
| F23 | Organizational visuals | Cosmos `org-visuals` + Blob bundles | ❌ | Upload/manage/enable custom visuals tenant-wide |

---

## 3. Azure / OSS service feature sets + native UI surfaces to rebuild 1:1

For each backing service, the **full feature set** Loom must surface and the
**native UI** it mirrors. Inventory grounded per `ui-parity.md` (Microsoft Learn
+ live portal), not memory.

### 3.1 Azure Resource Manager (capacity inventory & scale)
- **Full surface:** list resources by type/RG/region/SKU/provisioning-state;
  read SKU & kind; ARM operations — ADX `clusters/{n}` PATCH SKU; Synapse
  `sqlPools/{n}` pause/resume + DWU scale; Databricks cluster/pool resize;
  VMSS scale (0↔4); Container Apps replica scale; AKS node-pool scale.
- **Native UI mirrored:** Azure portal "All resources" grid + each resource's
  **Scale** blade + **Overview** (provisioning state, SKU pill).
- **Rebuild:** Capacity page grid (already B) + per-resource **Scale & Manage**
  detail pane with the resource-appropriate scale control (slider/dropdown for
  SKU, pause/resume toggle, node-count stepper).

### 3.2 Microsoft Entra ID / Graph (identity, users, roles)
- **Full surface:** `/users` (search, `assignedLicenses`, `accountEnabled`,
  `userType`), `/groups` (+ transitive members), `/servicePrincipals`,
  `roleManagement` (directory roles), app role assignments.
- **Native UI mirrored:** Entra portal **Users** blade (grid + license column +
  detail), **Groups**, M365 admin center license roll-up.
- **Rebuild:** Users & licenses page — searchable user grid, license-SKU
  roll-up cards, per-user Loom-workspace-role expansion, "Open in M365 admin"
  deep-link, identity picker shared with workspace roles.

### 3.3 Azure Cosmos DB (control-plane store)
- **Full surface:** containers `loom-tenant-settings`, `loom-workspaces`,
  `workspace-roles`, `workspace-folders`, `task-flows`, `governance-domains`,
  `embed-codes`, `org-visuals`, `azure-connections`, `auditLog` partitioned reads.
- **Native UI mirrored:** N/A (Loom control store) — but the Cosmos-backed
  surfaces mirror Fabric portal grids/flyouts.
- **Rebuild:** `createIfNotExists` for every new container (bicep/cosmos init);
  optimistic ETag concurrency on settings/roles saves.

### 3.4 Azure DevOps + GitHub REST (Git integration)
- **Full surface:** ADO — list orgs/projects/repos/branches; create branch;
  commit (push file tree); read commit/sync status; OAuth2 + SPN auth. GitHub —
  repo URL/branch/folder; fine-grained or classic PAT; same commit/sync.
- **Native UI mirrored:** Fabric **Workspace settings › Git integration** panel
  (provider radio, org/project/repo/branch/folder dropdowns, Connect & sync,
  current-branch chip, last-sync time, Disconnect).
- **Rebuild:** exact panel; provider radio gated by cloud (GitHub hidden at
  GCC-High/IL5 with honest note); commit serializes each workspace item to JSON.

### 3.5 Azure Monitor / Log Analytics (refresh, usage, audit, utilization)
- **Full surface:** KQL queries over Loom-app + diagnostic tables; Metrics REST
  for CU%/DBU/CPU; pipeline/dataflow run history; activity events.
- **Native UI mirrored:** Fabric **Refresh summary**, **Usage metrics report**,
  **Feature usage & adoption** report, Capacity Metrics app charts.
- **Rebuild:** refresh-summary table, usage report (charts via Power BI Embedded
  Commercial / Managed Grafana Gov), adoption tiles, utilization sparklines.

### 3.6 Azure Key Vault (CMK + secrets)
- **Full surface:** list keys, key versions, create/import key, soft-delete;
  bind key to storage account / Cosmos CMK (ARM `encryption.keyVaultProperties`).
- **Native UI mirrored:** Fabric **Workspace settings › Customer-managed keys
  (preview)** + Azure KV keys blade.
- **Rebuild:** KV picker (vault → key → version), bind wizard, rotation/status
  display, honest-gate if no UAMI KV-Crypto-User role.

### 3.7 Azure VNet / Private Endpoints / Firewall / NSG (advanced networking)
- **Full surface:** inbound private-link access protection, outbound access rules
  (PE/VNet), IP firewall allow-ranges, trusted resource instances, private DNS.
- **Native UI mirrored:** Fabric **Workspace settings › Advanced networking** +
  Azure Private Link / Firewall blades.
- **Rebuild:** inbound-protection toggle, outbound-rule grid, IP-range editor,
  trusted-instance picker — each writing real ARM network resources.

### 3.8 Microsoft Purview Audit + classic Data Map (audit, domains)
- **Full surface:** Audit query REST (`/audit/query` with filters: time range,
  user, activity, item); classic collections (mirror domains).
- **Native UI mirrored:** Fabric **Admin portal › Audit logs** (→ Purview
  compliance) + **Domains**.
- **Rebuild:** audit grid with filters + export; domains page wired to existing
  `/api/admin/domains`.

### 3.9 OSS render (Gov chart fallback)
- **Azure Managed Grafana** (GA all clouds) renders usage/utilization charts
  where Power BI Embedded is unavailable (GCC/High/IL5). Apache Superset is the
  pure-OSS alternative for air-gapped previews.

---

## 4. Sequenced task list (implementation-ready, no stubs/mocks)

Each task: **Goal • Files • Backend/REST • Bicep/portability • UI • Acceptance**.
Reuse existing clients (`azure-arm-client`, `cosmos-client`, `graph-identity-client`,
`monitor-client`, `kv-secrets-client`, `purview-client`, `workspace-roles-client`,
`access-policy-client`, `kusto-arm-client`, `synapse-dev-client`,
`synapse-pool-arm`, `domains-client`) before writing new ones.

### Task 0 — Shared cloud-endpoints resolver + Cosmos container init (foundation)
- **Goal:** one resolver for ARM/Graph/Monitor/KV/Cost/DevOps endpoints across
  all 4 clouds; `createIfNotExists` for every new admin container.
- **Files:** edit/extend `lib/azure/cloud-endpoints.ts` (add ARM, Cost Mgmt,
  DevOps, App Config getters); `lib/clients/cosmos-client.ts` (add containers
  `loom-workspaces`, `workspace-folders`, `task-flows`, `embed-codes`,
  `org-visuals`, `azure-connections`).
- **Backend/REST:** none (pure resolver + Cosmos init).
- **Bicep/portability:** add containers to cosmos init step; add `LOOM_CLOUD`
  param wiring (`AzureCloud|AzureUSGovernment`).
- **UI:** none.
- **Acceptance:** `vitest` covers all 4 clouds for each getter; `createIfNotExists`
  is idempotent against live Cosmos; tsc + build green.

### Task 1 — Admin shell landing tiles + 12-section nav (F1)
- **Goal:** replace EmptyState landing with real section tiles showing live counts.
- **Files:** edit `app/admin/page.tsx`; create `lib/panes/admin-overview.tsx`;
  route `app/api/admin/overview/route.ts`.
- **Backend/REST:** aggregate live counts — workspaces (Cosmos), capacities
  (ARM), users (Graph `$count`), domains (Cosmos), open audit items
  (Log Analytics).
- **Bicep/portability:** none new.
- **UI:** 12 section tiles (Fluent `Card` grid) each with icon, name, live count
  badge, route link; role-gated server-side.
- **Acceptance:** every tile shows a **real** count from its backend (no
  hardcoded numbers); clicking routes to the section; honest-gate per tile whose
  source is absent. tsc+build+vitest green; E2E receipt.

### Task 2 — Tenant settings: scoping + numeric params (F2 completion)
- **Goal:** add per-toggle "Apply to" security-group scoping + numeric param fields.
- **Files:** edit `app/admin/tenant-settings/page.tsx`,
  `app/api/admin/tenant-settings/route.ts`; reuse `graph-identity-client`.
- **Backend/REST:** persist `appliesTo: {mode, groupIds[]}` per toggle + numeric
  values to Cosmos; audit emission unchanged.
- **Bicep/portability:** none new.
- **UI:** per-toggle "Apply to" picker (Entire org / Specific groups / Except
  groups) with Graph group multi-select; numeric `SpinButton` for int params.
- **Acceptance:** scoping persists + reflects on reload; group picker returns
  live Graph groups; numeric save round-trips; audit logs the change.

### Task 3 — Capacity detail pane: Scale & Manage (F3 + F4 inline)
- **Goal:** per-resource detail pane with real scale/pause/resume actions wired
  from the capacity grid.
- **Files:** edit `app/admin/capacity/page.tsx`; create
  `lib/panes/scale-manage.tsx`; reuse `app/api/admin/scaling/*` (8 routes).
- **Backend/REST:** ADX SKU PATCH, Synapse pool pause/resume + DWU, Databricks
  resize, VMSS 0↔4, Container Apps/AKS scale — all live ARM.
- **Bicep/portability:** ensure Console UAMI has Contributor (or scoped
  scale roles) on target RGs (per `csa_loom_navigators_live_green`).
- **UI:** detail Drawer per row: resource-appropriate control (SKU dropdown,
  pause/resume Switch, node stepper), confirm dialog, live provisioning-state poll.
- **Acceptance:** scaling a **real** ADX cluster / pausing a **real** Synapse pool
  succeeds and reflects new state on poll; honest-gate if UAMI lacks the role.

### Task 4 — Capacity cost + utilization (F5)
- **Goal:** lift the deferred gate — real cost + utilization columns/charts.
- **Files:** create `lib/clients/cost-client.ts`; edit `app/admin/capacity/page.tsx`;
  reuse `monitor-client`; routes `app/api/admin/capacity/{cost,utilization}/route.ts`.
- **Backend/REST:** `Microsoft.CostManagement/query` (monthly per-resource);
  `Microsoft.Insights/metrics` (CU%/DBU/CPU/request-rate per resource type).
- **Bicep/portability:** UAMI needs Cost Management Reader + Monitoring Reader;
  Gov Cost Mgmt limited → honest-gate where unavailable.
- **UI:** cost column ($/mo) + utilization sparkline per row; detail-pane chart
  (Power BI Embedded Commercial / Managed Grafana Gov).
- **Acceptance:** cost reflects **real** billing data; utilization reflects **real**
  Monitor metrics; Gov fallback renders Grafana or honest-gate, never blank.

### Task 5 — Workspaces list & govern (F6)
- **Goal:** wire the workspaces UI to real data (no stub).
- **Files:** edit `app/admin/workspaces/page.tsx`; ensure
  `lib/clients/workspaces-client.ts`; route `app/api/admin/workspaces/route.ts`.
- **Backend/REST:** Cosmos `loom-workspaces` list + per-workspace item count, owner,
  state, capacity binding; ARM link to backing RG.
- **Bicep/portability:** Cosmos container (Task 0).
- **UI:** `LoomDataTable` — name, state badge, capacity, item count, owners,
  last-modified; search + filter; row → workspace settings flyout (Task 6).
- **Acceptance:** grid shows **real** workspaces from Cosmos with live item counts;
  states accurate; no `return []`.

### Task 6 — Workspace create wizard + Settings flyout (F7 + F8)
- **Goal:** full create wizard + settings panels.
- **Files:** create `lib/wizards/workspace-create.tsx`, `lib/panes/workspace-settings.tsx`;
  routes `app/api/admin/workspaces/route.ts` (POST), `/{id}/route.ts` (PATCH).
- **Backend/REST:** create → Cosmos doc + capacity bind + (optional) backing-RG
  provision; settings → General/License/M365-SharePoint/OneLake-storage panels read
  real ARM/Graph/Cosmos.
- **Bicep/portability:** provisioner falls through to Azure-native (no Fabric gate).
- **UI:** multi-step wizard (name/desc → contact list (Graph picker) → license mode
  → capacity → advanced); settings flyout tabs matching Fabric panels.
- **Acceptance:** creating a workspace persists + binds a **real** capacity;
  OneLake-storage tab shows **real** ADLS usage; M365 tab links a **real** group.

### Task 7 — Workspace roles + Manage Access (F9)
- **Goal:** per-workspace role grid writing real Azure RBAC.
- **Files:** edit `app/admin/permissions/page.tsx` (or new
  `lib/panes/workspace-access.tsx`); reuse `workspace-roles-client`,
  `access-policy-client`, `graph-identity-client`.
- **Backend/REST:** add role → Cosmos `workspace-roles` row + **real** Azure RBAC
  assignment on backing RG/resources (Admin→Owner, Member→Contributor, etc.).
- **Bicep/portability:** UAMI needs RBAC-Administrator (constrained) — already
  granted per `csa_loom_governance_buildassist`.
- **UI:** role grid (Admin/Member/Contributor/Viewer) + identity picker; remove/edit.
- **Acceptance:** adding a **real** group as Member creates the Cosmos row **and**
  a verifiable RBAC assignment; removing revokes it.

### Task 8 — Folders & task flows (F10 + F11)
- **Goal:** nested folder hierarchy + visual task-flow canvas.
- **Files:** create `lib/clients/folders-client.ts`, `lib/clients/taskflow-client.ts`,
  `lib/panes/{folders,task-flows}.tsx`; routes `app/api/admin/workspaces/{id}/{folders,task-flows}/*`.
- **Backend/REST:** Cosmos `workspace-folders` (parent/child) + `task-flows`
  (step sequence + item refs); move-item updates folder ref.
- **Bicep/portability:** Cosmos containers (Task 0).
- **UI:** folders — tree + create/rename/move (drag); task flows — step canvas
  (reuse `@xyflow/react` per `csa_loom_reactflow_canvas`) + attach items.
- **Acceptance:** creating/moving folders persists; task-flow steps persist + link
  **real** items; canvas drag works.

### Task 9 — Git integration / source control (F12)
- **Goal:** connect/sync/branch/disconnect against real ADO + GitHub.
- **Files:** create `lib/clients/git-integration-client.ts`,
  `lib/panes/git-integration.tsx`; routes `app/api/admin/workspaces/{id}/git/*`.
- **Backend/REST:** ADO REST (list org/project/repo/branch, create branch,
  push file tree, status); GitHub REST (repo/branch/folder, commit, status);
  commit serializes each workspace item to JSON.
- **Bicep/portability:** secrets (PAT/SPN) in Key Vault secretRef; **GitHub hidden
  at GCC-High/IL5** (provider radio shows ADO-only + honest note).
- **UI:** Fabric Git panel — provider radio, org/project/repo/branch/folder
  dropdowns, Connect & sync, current-branch chip, last-sync, Disconnect.
- **Acceptance:** connecting a **real** ADO repo + sync commits workspace item
  JSON to a **real** branch; status reflects real commit; disconnect clears bind.

### Task 10 — Spark / compute configuration (F13)
- **Goal:** full Spark compute config (pools/runtime/environment/jobs).
- **Files:** create `lib/clients/spark-config-client.ts`,
  `lib/panes/spark-compute.tsx`; reuse `databricks-scale-client`; routes
  `app/api/admin/workspaces/{id}/spark/*`.
- **Backend/REST:** Databricks pools (starter vs custom: node family/size,
  autoscale min/max, dynamic executors), runtime versions, environment libraries,
  jobs (session timeout, optimistic admission, reserve-cores) → Cosmos defaults +
  Databricks REST.
- **Bicep/portability:** Databricks workspace host + token in KV.
- **UI:** Fabric Spark-settings tabs (Pool / Environment / Jobs) with the exact
  controls (no JSON).
- **Acceptance:** creating a **real** custom pool succeeds; runtime/env/jobs persist
  and apply to a **real** Databricks session; honest-gate if no Databricks host.

### Task 11 — Customer-managed keys (F14)
- **Goal:** KV-backed workspace encryption bind.
- **Files:** create `lib/clients/cmk-client.ts`, `lib/panes/cmk.tsx`; reuse
  `kv-secrets-client`; route `app/api/admin/workspaces/{id}/cmk/route.ts`.
- **Backend/REST:** list KV keys/versions; bind via ARM
  `encryption.keyVaultProperties` on backing storage/Cosmos; status/rotation.
- **Bicep/portability:** UAMI needs Key Vault Crypto User + storage CMK role.
- **UI:** vault → key → version picker, bind wizard, status/rotation display.
- **Acceptance:** binding a **real** KV key sets CMK on a **real** storage account;
  status reflects live key; honest-gate if role missing.

### Task 12 — Advanced networking (F15)
- **Goal:** inbound protection, outbound rules, IP firewall, trusted instances.
- **Files:** create `lib/clients/networking-client.ts`, `lib/panes/networking.tsx`;
  reuse `azure-arm-client`; routes `app/api/admin/workspaces/{id}/networking/*`.
- **Backend/REST:** VNet/Private Endpoint/Private DNS create; Firewall/NSG IP
  rules; trusted-instance allowlist — all live ARM.
- **Bicep/portability:** UAMI Network Contributor on networking RG.
- **UI:** inbound-protection Switch, outbound-rule grid (add PE/VNet),
  IP-range editor, trusted-instance picker.
- **Acceptance:** adding an IP firewall range writes a **real** NSG/Firewall rule;
  inbound protection creates a **real** private endpoint; honest-gate if role missing.

### Task 13 — Azure connections (F16)
- **Goal:** connect ADLS Gen2 + Log Analytics for dataflow/query-log export.
- **Files:** create `lib/clients/azure-connections-client.ts`,
  `lib/panes/azure-connections.tsx`; route `app/api/admin/workspaces/{id}/connections/*`.
- **Backend/REST:** bind ADLS Gen2 account (dataflow staging) + Log Analytics
  workspace (query-log export) via ARM + Cosmos `azure-connections`.
- **Bicep/portability:** UAMI Storage Blob Data Contributor + Log Analytics
  Contributor.
- **UI:** ADLS picker + Log Analytics picker, connect/disconnect, status.
- **Acceptance:** connecting a **real** ADLS account enables real dataflow staging;
  connecting Log Analytics streams real query logs; honest-gate if role missing.

### Task 14 — Users & licenses (F17)
- **Goal:** real user grid + license roll-up + per-user workspace roles.
- **Files:** edit `app/admin/users/page.tsx`; route `app/api/admin/users/route.ts`;
  reuse `graph-identity-client`, `workspace-roles-client`.
- **Backend/REST:** Graph `/users` (search, `assignedLicenses`, `accountEnabled`);
  license SKU roll-up; per-user Loom workspace-role expansion from Cosmos.
- **Bicep/portability:** UAMI Graph `Directory.Read.All`, `User.Read.All`.
- **UI:** searchable user grid, license-SKU roll-up cards, per-user role expansion,
  "Open in M365 admin" deep-link.
- **Acceptance:** grid shows **real** users + **real** license assignments; role
  expansion shows real Cosmos roles; no stub body copy.

### Task 15 — Domains (F18)
- **Goal:** wire domains UI to real backend (no dead button).
- **Files:** edit `app/admin/domains/page.tsx`; reuse `domains-client`
  + existing `app/api/admin/domains/route.ts`.
- **Backend/REST:** Cosmos `governance-domains` CRUD + classic Purview collection
  mirror; subdomains; assign workspaces; image gallery (Blob).
- **Bicep/portability:** Purview classic Data Map collection-admin role.
- **UI:** domain list, create/edit (name/desc/image/contributors), subdomains,
  assign-workspaces picker, image gallery.
- **Acceptance:** create/edit/delete persists to Cosmos + mirrors a **real**
  Purview collection; "Add domain" button works; assign-workspaces persists.

### Task 16 — Audit logs (F19)
- **Goal:** wire audit UI to real Purview Audit + Log Analytics.
- **Files:** edit `app/admin/audit-logs/page.tsx`; reuse `purview-client`,
  `monitor-client` + existing `app/api/admin/audit-logs/route.ts`.
- **Backend/REST:** Purview `/audit/query` (filters: time/user/activity/item) +
  Log Analytics KQL for Loom-app events.
- **Bicep/portability:** UAMI Purview audit-read role.
- **UI:** audit grid w/ time-range picker, user/activity/item filters, export CSV.
- **Acceptance:** grid shows **real** audit events; filters apply live; export
  downloads real rows; honest-gate if Purview audit unavailable.

### Task 17 — Refresh summary (F20)
- **Goal:** scheduled-refresh overview from real run history.
- **Files:** create `lib/panes/refresh-summary.tsx`; reuse `monitor-client`;
  route `app/api/admin/refresh-summary/route.ts`.
- **Backend/REST:** Log Analytics KQL over pipeline/dataflow run tables + Cosmos
  schedule metadata.
- **Bicep/portability:** UAMI Monitoring Reader.
- **UI:** table — item, last run, status badge, next run, duration; filter by
  workspace/status.
- **Acceptance:** table shows **real** run history with accurate statuses; next-run
  reflects real schedules; honest-gate if Log Analytics absent.

### Task 18 — Usage metrics & feature adoption (F21)
- **Goal:** real usage report (no preview-body stub).
- **Files:** create `lib/clients/usage-client.ts`, edit `app/admin/usage/page.tsx`;
  reuse `monitor-client`; route `app/api/admin/usage/route.ts`.
- **Backend/REST:** Log Analytics Loom-app telemetry (active users, top items,
  adoption by feature) + Cosmos activity aggregates.
- **Bicep/portability:** UAMI Monitoring Reader; charts via Power BI Embedded
  (Commercial) / Managed Grafana (Gov).
- **UI:** active-users trend, top-items table, adoption-by-feature chart,
  drill-through filters.
- **Acceptance:** every metric is **real** Log Analytics/Cosmos data; drill-through
  filters live; Gov renders Grafana, never the old promotional EmptyState.

### Task 19 — Embed codes + organizational visuals (F22 + F23)
- **Goal:** embed-code lifecycle + tenant-wide custom visuals.
- **Files:** create `lib/clients/{embed-codes,org-visuals}-client.ts`,
  `lib/panes/{embed-codes,org-visuals}.tsx`; routes
  `app/api/admin/{embed-codes,org-visuals}/*`.
- **Backend/REST:** embed codes → Cosmos `embed-codes` + signed Loom embed URL,
  create/revoke; org visuals → Blob-stored bundles + Cosmos `org-visuals`
  enable/disable.
- **Bicep/portability:** Blob container for visual bundles; Storage Blob Data
  Contributor.
- **UI:** embed-codes list (report, status, created-by, revoke); org-visuals
  upload + enable toggle + version.
- **Acceptance:** creating an embed code yields a **real** working signed URL;
  uploading a visual stores a **real** bundle + enables it tenant-wide.

### Task 20 — Parity docs + whole-experience DoD
- **Goal:** one parity doc per surface; whole-experience scorecard update.
- **Files:** create `docs/fiab/parity/{admin-shell,tenant-settings,capacity,workspaces,workspace-create,workspace-roles,folders-taskflows,git-integration,spark-compute,cmk,networking,azure-connections,users-licenses,domains,audit-logs,refresh-summary,usage-adoption,embed-codes,org-visuals}.md`.
- **Acceptance:** each parity doc has inventory + Loom coverage (✅/⚠️ only, zero ❌)
  + backend-per-control; `MASTER-SCORECARD.md` updated.

---

## 5. Claude Code DEV-LOOP per task

Run this loop **per numbered task**; do not advance until the task's acceptance
criteria pass with real data and zero stubs.

1. **Coding agent** — implement the task's files. Use existing clients
   (`azure-arm-client`, `cosmos-client`, `graph-identity-client`, `monitor-client`,
   `kv-secrets-client`, `purview-client`, `workspace-roles-client`,
   `access-policy-client`, `kusto-arm-client`, `synapse-dev-client`,
   `synapse-pool-arm`, `domains-client`) before writing new ones. Default path =
   Azure-native; Fabric/PBI adapters are opt-in behind `LOOM_<FEATURE>_BACKEND` +
   bound resource. **No `return []`, no `useState(MOCK_*)`, no EmptyState with
   promotional body copy, no dead buttons.** Where infra is absent, render an
   honest `MessageBar intent="warning"` naming the exact env var / role / resource
   and link the bicep module. All admin config = dropdowns/wizards/pickers/toggles
   (no JSON textareas).
2. **Validation / test agent** —
   - `pnpm --filter fiab-console exec tsc --noEmit` (zero errors).
   - `pnpm --filter fiab-console build` (`next build` must pass — per
     `csa_loom_ci_gaps`, build-breaks have reached deploy before).
   - `pnpm --filter fiab-console vitest run <touched specs>` (add a spec per new
     client/route; env `node` for route tests, `jsdom` for component tests — per
     `fiab_console_vitest_harness_broken`, set env + setupFiles).
   - **Real-data E2E:** mint a session cookie, hit the new endpoint, capture the
     first 300 chars of the **real** response, and Playwright-click every new
     control. Confirm Azure backend reason:"live" (or the honest-gate MessageBar).
     Run with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.
   - On failure: revert task status to "doing", hand the failing assertion +
     response body back to the coding agent; iterate.
3. **Docs agent** — update the task's `docs/fiab/parity/<slug>.md` (inventory +
   coverage + backend-per-control), update any affected `docs/fiab/*`, and the
   Learn popup for the surface. Per `docs_source_of_truth`, docs ship with the
   feature, not after. Per `no_questions_in_product`, no clarifying-question or
   side-convo text in the UI/docs.
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

The Platform & Admin experience is **done** when **all** hold:

1. **Every row F1–F23** in §2 is **✅ built** or **⚠️ honest-gate** — **zero 🔶
   stubs, zero ❌ missing.** No EmptyState-with-promotional-copy, no static cards,
   no `useState(MOCK_*)`, no `return []`, no dead buttons (grep per `no-vaporware`
   returns nothing in `app/admin`, `lib/panes`, admin `lib/clients`).
2. **Default path is Azure-native and Fabric-free.** Every admin surface installs
   and functions with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, no Power BI workspace,
   no F/P capacity. Grep per `no-fabric-dependency` finds no default-path Fabric
   gate and no `api.fabric.microsoft.com` / `api.powerbi.com` on a non-opt-in code
   path; every `fabricWorkspaceId` read has an Azure fallback in the same function.
3. **Real backends, verified.** Workspaces/roles/folders/task-flows/domains/
   embed-codes/org-visuals/tenant-settings persist to Cosmos; workspace roles +
   CMK + networking + connections write **real** Azure RBAC / Key Vault / VNet /
   ARM; capacity scale executes **real** ARM ops; cost/utilization/refresh/usage/
   audit read **real** Cost Management / Monitor / Purview; Git integration commits
   to a **real** ADO/GitHub repo; users & licenses read **real** Graph. Each has a
   real-data E2E receipt in its PR.
4. **All 4 clouds.** Endpoints resolve via the cloud resolver for Commercial /
   GCC / GCC-High / IL5; Console hosts on Container Apps (Commercial/GCC) or AKS
   (High/IL5); GitHub-Git and Power BI Embedded fall back correctly in Gov
   (ADO-only Git, Managed Grafana charts) — no blank surfaces.
5. **UI parity proven.** Every surface has a `docs/fiab/parity/<slug>.md` with
   zero ❌ and a passing UAT side-by-side; `MASTER-SCORECARD.md` shows every
   admin surface at **≥ B** (target A/A+), graded by click-every-control, not DOM
   strings.
6. **Bicep-synced.** Every new container, env var, role assignment, and resource
   is in `platform/fiab/bicep/**` and deploys from scratch via
   `az deployment sub create` + the post-deploy bootstrap — no drift between
   running console and bicep (per `no-vaporware` bicep-sync rule).
