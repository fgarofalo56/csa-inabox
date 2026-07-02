# Appendix — Platform, Workspaces & ALM (`platform-alm`)
### Microsoft Fabric → CSA Loom parity deep-dive

> Scope: Workspaces (roles, settings, **workspace identity**), Folders + **Task flows**,
> **Domains** (data-mesh), **Capacities** (F-SKU model, pause/resume, bursting/smoothing,
> autoscale, surge protection, per-workspace assignment), **Deployment pipelines**,
> **Git integration / ALM**, item lifecycle, the **Monitoring hub**, and the
> **Capacity Metrics app**.
>
> Loom default per `no-fabric-dependency.md`: Cosmos-backed workspaces / domains /
> task-flows / pipelines, an **ACA + Synapse/ADX compute "capacity" model**, real
> **Azure DevOps / GitHub** Git, **bicep/ARM** deployment history, and the Loom
> admin plane. Microsoft Fabric / Power BI is **opt-in only** (an alternative tab),
> never on the default code path.

---

## 1. Fabric capability inventory (grounded in Microsoft Learn)

Each row: capability → how it actually works (architecture / item model / API) → Learn URL.

### 1.1 Workspaces

| # | Capability | How it works (architecture / API) | Learn |
|---|---|---|---|
| 1 | **Workspace as OneLake container** | A workspace is a logical entity grouping items; it sits on OneLake and divides the lake into independently-secured containers. Items live in exactly one workspace. | https://learn.microsoft.com/fabric/fundamentals/workspaces |
| 2 | **Create workspace** | `POST /v1/workspaces` (Fabric Core REST). Name, description, optional capacity assignment, optional domain. | https://learn.microsoft.com/fabric/fundamentals/create-workspaces |
| 3 | **Workspace roles (Admin / Member / Contributor / Viewer)** | Four roles, applied to all items in the workspace. Assignable to users, security groups, M365 groups, distribution lists, and Entra service principals. Highest role wins when in multiple groups. Admin: delete workspace, add admins, create identity, connect Git. Member: +share/reshare, add members. Contributor: write/delete items, run jobs. Viewer: read + TDS ReadData. | https://learn.microsoft.com/fabric/fundamentals/roles-workspaces |
| 4 | **Give access / manage access** | `POST /v1/workspaces/{id}/roleAssignments`. Manage-access panel lists principals + role; permission change applies on next login. | https://learn.microsoft.com/fabric/fundamentals/give-access-workspaces |
| 5 | **Workspace settings — General** | Name, description, contact list, license/capacity, domain, image. | https://learn.microsoft.com/fabric/fundamentals/workspaces#workspace-settings |
| 6 | **Contact list** | Specify users/groups who receive notification about workspace issues; default = creator. Surfaced in settings UI. | workspaces#workspace-settings |
| 7 | **M365 / SharePoint group** | Configure an M365 Group whose SharePoint doc library is available to workspace users. Permissions NOT auto-synced. | workspaces#workspace-settings |
| 8 | **License / capacity assignment** | A workspace runs on a capacity (Trial / F-SKU / P-SKU). Moving a workspace to another capacity is the scale-out isolation lever. | optimize-capacity (scale out) |
| 9 | **Pin / current workspace nav** | Pin favorites to the flyout; "current workspace" quick-nav from left rail. | workspaces |
| 10 | **OneLake / storage settings, Spark settings, data-model default storage** | Per-workspace Spark pool + environment defaults; default semantic-model storage format; OneLake region. | workspace-admin-settings |

### 1.2 Workspace identity

| # | Capability | How it works | Learn |
|---|---|---|---|
| 11 | **Workspace identity (auto-managed SP)** | An automatically-managed service principal + app registration created per workspace (`+ Workspace identity` in settings, admin-only, not in My Workspace). Name == workspace name. Fabric manages credentials (no leak). Independent lifecycle; deleted with the workspace; not restored on restore. Default of 10,000/tenant. | https://learn.microsoft.com/fabric/security/workspace-identity |
| 12 | **Trusted workspace access** | Identity authenticates to **firewall-enabled ADLS Gen2** via resource-instance/trusted-service rules — read/write OneLake shortcuts, AzCopy loads, pipelines, semantic models, Dataflows Gen2 without stored credentials. Grant the identity `Storage Blob Data Reader/Contributor` at account scope. | https://learn.microsoft.com/fabric/security/workspace-identity-authenticate |
| 13 | **Identity as connection auth method** | After creation, "Workspace identity" appears as an auth option in connection + shortcut experiences (Admin/Member/Contributor can configure). | workspace-identity-authenticate |
| 14 | **Admin / governance** | Fabric admins manage all identities on the **Fabric identities** admin tab; audit events in Purview (Created/Retrieved/Deleted Fabric Identity for Workspace); app visible in Entra Enterprise apps + App registrations. | workspace-identity#security |

### 1.3 Folders & Task flows

| # | Capability | How it works | Learn |
|---|---|---|---|
| 15 | **Folders** | Organize items in a workspace; nested hierarchy; folder hierarchy is carried during deployment-pipeline deploy and Git sync. | https://learn.microsoft.com/fabric/fundamentals/workspaces-folders |
| 16 | **Task flow** | A workspace canvas visualizing the flow of work: connected **tasks** with **connectors**, occupying the upper part of list view (resizable/hideable separator). Helps navigate + filter the item list. | https://learn.microsoft.com/fabric/fundamentals/task-flow-overview |
| 17 | **Task types (10)** | General, Get data, Mirror data, Store data, Prepare data, Analyze & train, Track data, Visualize data, Distribute data, Develop data. Each has **recommended item types**. | task-flow-overview#key-concepts |
| 18 | **Predesigned task flows** | Microsoft-provided end-to-end templates (industry best-practice); also a basic Power-BI-only default. Apply → overwrite or append. | https://learn.microsoft.com/fabric/fundamentals/task-flow-create |
| 19 | **Build / edit tasks** | Add task (Add dropdown), edit name/description, change task type, drag-arrange, connect with connector arrows (logical, not data). | https://learn.microsoft.com/fabric/fundamentals/task-flow-work-with |
| 20 | **Assign items to tasks** | `+ New item` (recommended/all types) or clip-icon assign existing. One item → one task (per canvas). Selecting a task filters the item list. | task-flow-work-with#assign-items |
| 21 | **Import / export task flow** | Export canvas to `.json`; import into other workspaces and customize. | task-flow-create#start-by-importing |
| 22 | **Multiple task-flow canvases** | A workspace can hold many canvases (selector menu: new/rename/delete/switch). An item can be on multiple tasks if those tasks are on *different* canvases. | https://learn.microsoft.com/fabric/fundamentals/task-flow-multiple-canvases |

### 1.4 Domains (data mesh)

| # | Capability | How it works | Learn |
|---|---|---|---|
| 23 | **Domain** | Logical grouping of all data relevant to a business area (data-mesh, decentralized). Workspaces associate to domains; items inherit a domain attribute (metadata) → OneLake-catalog filtering + federated governance. | https://learn.microsoft.com/fabric/governance/domains |
| 24 | **Subdomain** | Fine-tune grouping under a domain; general settings only; inherits parent admins. | domains#structure |
| 25 | **Domain roles** | Fabric admin (create/edit/delete, set admins), Domain admin (edit description/contributors/image/delegated settings, assign workspaces; can't delete/rename/add admins), Domain contributor (workspace admins authorized to assign their workspaces). | domains#key-concepts |
| 26 | **Domain settings (6 tabs)** | General (name/desc), Image (gallery/color), Admins, Contributors (everyone / specific / admins-only scope), Default domain, Delegated settings. | domains#configure-domain-settings |
| 27 | **Default domain** | Specify users/SGs → their unassigned + new workspaces auto-assign to the domain; existing assignments preserved; they become domain contributors. | domains#key-concepts |
| 28 | **Delegated settings** | Override tenant settings at domain level: default sensitivity label (MIP), certification/endorsement (enable, certifiers, doc URL). | domains#configure |
| 29 | **Assign workspaces** | By workspace name, by workspace admin, or by capacity; override warning if already assigned. REST: `POST /admin/domains/{id}/assignWorkspaces`. | domains#structure |
| 30 | **Domain image in OneLake catalog** | Image/color themes the catalog when the domain is selected. | domains#key-concepts |

### 1.5 Capacities

| # | Capability | How it works | Learn |
|---|---|---|---|
| 31 | **F-SKU capacity** | A pool of compute (Capacity Units, CUs) hosting workspaces. F2…F2048 Azure SKUs (pay-as-you-go or reserved). Separation of compute & storage. | https://learn.microsoft.com/fabric/enterprise/licenses |
| 32 | **Pause / resume** | Azure `…/capacities/{n}/suspend|resume/action` (RBAC: read/write/suspend/resume). Pausing settles cumulative overage as a billing event + stops throttling immediately; content unavailable while paused. Schedulable via Azure Automation runbook / Fabric CLI / REST. | https://learn.microsoft.com/fabric/enterprise/pause-resume |
| 33 | **Scale up / down (resize)** | Change SKU in Azure portal (Azure admin only); fast, short pause. Vertical scaling. | https://learn.microsoft.com/fabric/enterprise/scale-capacity |
| 34 | **Scale out (move workspace)** | Move a workspace to another capacity (Admin Portal / Capacity Settings) to isolate noisy neighbors / executive reporting; standby "rescue" capacity (kept paused). Horizontal scaling. | https://learn.microsoft.com/fabric/enterprise/optimize-capacity |
| 35 | **Bursting & smoothing** | Bursting completes CPU-intensive work fast without a higher SKU; smoothing spreads the *accounting* for consumed compute over up to 24h so a peak doesn't require a larger SKU. Independent of job execution. | https://learn.microsoft.com/fabric/enterprise/optimize-capacity |
| 36 | **Throttling policy** | When sustained demand exceeds SKU limit, interactive ops are delayed/rejected; in-flight ops always complete; capacities self-heal. Stop fast: increase SKU, pause/resume, capacity overage billing (3×). | https://learn.microsoft.com/fabric/enterprise/throttling |
| 37 | **Surge protection** | Per-capacity limit on total background-job compute → reduces interactive delays/rejections + faster recovery; rejects background jobs when active. | https://learn.microsoft.com/fabric/enterprise/surge-protection |
| 38 | **Autoscale billing for Spark** | F-SKU only; serverless pay-as-you-go for Spark — Spark jobs stop consuming shared capacity; capacity-admin sets max-CU slider (bounded by Azure quota). | https://learn.microsoft.com/fabric/data-engineering/configure-autoscale-billing |
| 39 | **Capacity overage billing** | Opt-in; lets ops proceed at 3× rate to avoid throttling. | throttling |
| 40 | **Capacity admin roles** | Capacity Admin / Capacity Contributor — manage compute/scaling separate from content access. | well-architected security |

### 1.6 Deployment pipelines (ALM)

| # | Capability | How it works | Learn |
|---|---|---|---|
| 41 | **Pipeline = 2–10 stages** | Default Dev/Test/Prod; stage count/names permanent after create; stages can be public. Each stage is paired with a workspace. | https://learn.microsoft.com/fabric/cicd/deployment-pipelines/intro-to-deployment-pipelines |
| 42 | **Assign workspace to stage** | A workspace belongs to one stage; assigning adds content. | https://learn.microsoft.com/fabric/cicd/deployment-pipelines/assign-pipeline |
| 43 | **Deploy (full / selective / backward)** | Clone content source→target; item-pairing by name+type+folder path; connections preserved; dependents must exist in target. Folder hierarchy applied automatically. Flat-list view crosses folders. | https://learn.microsoft.com/fabric/cicd/deployment-pipelines/deploy-content |
| 44 | **Deployment rules** | Per-stage data-source / parameter overrides (e.g. prod semantic model → prod DB). Owner-only; applied on deploy; "different" indicator until deployed. | https://learn.microsoft.com/fabric/cicd/deployment-pipelines/create-rules |
| 45 | **Compare stages** | Same / Different / Only-in-source / Not-in-source sync indicators. | understand-the-deployment-process |
| 46 | **Deployment history + operations** | Per-operation status/duration; REST `…/deploymentPipelines/{id}/operations`. | understand-the-deployment-process |
| 47 | **Pipeline automation (CI)** | Deployment Pipelines REST + the Azure DevOps `fabric-devops-pipelines` task drive deploys headless on Git push. | https://learn.microsoft.com/fabric/cicd/deployment-pipelines/pipeline-automation |
| 48 | **Pipeline permissions** | Pipeline admin vs workspace role matrix governs view/deploy/assign/rule actions. | understand-the-deployment-process#permissions |

### 1.7 Git integration / ALM

| # | Capability | How it works | Learn |
|---|---|---|---|
| 49 | **Connect workspace to Git** | Workspace settings → Git integration → Azure DevOps (OAuth2 or Service Principal) or GitHub (org/project/repo/branch/folder or repo URL/branch/folder). Admin-only to connect; one branch + one folder per workspace. Folder structure mirrors workspace. | https://learn.microsoft.com/fabric/cicd/git-integration/git-get-started |
| 50 | **Commit / update / status** | Source-control pane: per-item status (synced/uncommitted/incoming/conflict), commit selected, update (pull), built-in diff. REST: Connect / Initialize / Commit / Update / Status. | https://learn.microsoft.com/fabric/cicd/git-integration/git-automation |
| 51 | **Selective branching / switch branch** | Switch the connected branch per workspace (feature-branch flows); branched workspaces clearly indicated. | data-agent-source-control |
| 52 | **Branch out to new workspace** | Create a new workspace from a branch for isolated feature dev (requires Create-workspaces). | cicd-tutorial |
| 53 | **Service-principal Git** | ADO Git with SP for headless/CI. | git-integration-with-service-principal |

### 1.8 Monitoring & metrics

| # | Capability | How it works | Learn |
|---|---|---|---|
| 54 | **Monitoring hub** | Central per-experience activity feed (pipeline/job/refresh/Spark/warehouse-query runs): status, submitter, duration, filter/search; shows only items the user can view; per-run drilldown. | https://learn.microsoft.com/fabric/admin/monitoring-hub |
| 55 | **Capacity Metrics app** | Power BI app (capacity-admin install): Health, Compute (14-day ribbon/utilization/matrix of operations, interactive vs background, throttling), Storage (30-day, billable + soft-deleted), Timepoint (30-sec drill), Timepoint-summary, Timepoint-item-detail. | https://learn.microsoft.com/fabric/enterprise/metrics-app |
| 56 | **Admin monitoring workspace** | Feature-usage-and-adoption report + audit semantic model for org-wide insight. | https://learn.microsoft.com/fabric/admin/monitoring-workspace |
| 57 | **Capacity overview events (Real-Time hub)** | Live capacity state events (`Microsoft.Fabric.Capacity.Summary`) → Activator/Outlook alerts on throttling. | https://learn.microsoft.com/fabric/real-time-hub/explore-fabric-capacity-overview-events |

**Feature count: 57.**

---

## 2. Loom coverage map (built / stubbed / missing — honest)

Legend: ✅ built & real-backed · ⚠️ partial/stubbed · ❌ missing.

| Capability | Status | Loom surface / backend |
|---|---|---|
| Workspace CRUD + list | ✅ | `/admin/workspaces`, `app/api/workspaces` (Cosmos `workspaces` PK `/tenantId`) |
| Roles (Admin/Member/Contributor/Viewer) | ✅ | `…/[id]/role-assignments`, `…/permissions`, ManageAccessPane |
| Manage access (people/SG picker) | ✅ | `ManageAccessPane` embedded in settings |
| Workspace settings drawer | ✅ | `workspace-settings-drawer.tsx` — General/Permissions/Networking/Git/OneLake/Encryption/Spark/Sensitivity/Danger |
| Folders (CRUD, reparent, item-move) | ✅ | `…/[id]/folders` (Cosmos `folders`), `lib/panes/folders.tsx` |
| Task flows — canvas (nodes/edges/item-refs) | ✅ | `lib/panes/task-flows.tsx` (@xyflow/react), `taskflow-client` (Cosmos `task-flows`) |
| Task flows — **task types / recommended items** | ⚠️ | generic steps only; no 10-type taxonomy + recommended-item mapping |
| Task flows — **predesigned templates gallery** | ❌ | no Microsoft-style end-to-end starter templates |
| Task flows — **import/export JSON, multi-canvas** | ⚠️ | per-workspace flows exist; export/import + multi-canvas selector not surfaced |
| Domains (data-mesh, 6-tab settings) | ✅ | `/admin/domains`, `app/api/admin/domains` (Cosmos) + Purview collection mirror |
| Default domain / subdomains / delegated MIP + cert | ✅ | DomainSettingsPane + PATCH |
| Assign workspaces (name/admin, override warn) | ✅ | `…/domains/assign-workspaces` |
| Capacity inventory + per-resource utilization | ✅ | `/admin/capacity` + `…/capacity/utilization` (Azure Monitor metrics) + cost |
| Scale / pause / resume (Synapse pool, IR VMSS, ADX, APIM) | ✅ | `ScaleManagePanel` + `…/scaling/*` |
| **Capacity Metrics app parity (CU-by-item, throttling, smoothing, storage)** | ⚠️ | per-resource charts only; no unified compute/storage/timepoint model |
| **Surge protection + autoscale-billing config** | ❌ | no equivalent config surface for the ACA/Spark model |
| **Workspace → capacity assignment (real binding)** | ⚠️ | General tab "Capacity" is a **free-text Input** (label only; no real compute binding) |
| Deployment pipelines — Loom-native (stages/rules/compare/deploy/history) | ✅ | `/deployment-pipelines` → `…/deployment-pipelines/loom` (Cosmos) + provisioner promote |
| Deployment pipelines — ARM deployment history + operations | ✅ | `…/deployment-pipelines/arm` (real `Microsoft.Resources/deployments`) |
| Deployment pipelines — headless CI token | ✅ | `LOOM_CI_TOKEN` dual-auth |
| Deployment pipelines — Fabric REST (opt-in tab) | ✅ (opt-in) | `…/deployment-pipelines/route.ts` (gated) |
| Git integration — connect/commit/pull/status/resolve | ✅ | `…/git-integration/*` (ADO Repos / GitHub Git Data API; PAT in Key Vault) |
| Git — **branch out to new workspace** | ❌ | no clone-branch→new-Loom-workspace flow |
| Monitoring hub — Activities feed | ✅ | `lib/panes/monitor-hub.tsx` + `…/monitor/activities` (Log Analytics KQL) |
| Monitoring hub — alerts tab (scheduled-query rules) | ✅ | `…/monitor/alerts` |
| Monitoring hub — **per-run drilldown (pipeline activity graph / Spark app detail)** | ⚠️ | flat run list; no run-detail graph |
| **Workspace identity (per-workspace managed identity)** | ❌ | no Identity tab; no per-workspace UAMI + trusted-access grant |
| Workspace contact list | ❌ | not surfaced |

**Loom status for this domain: STRONG.** The core ALM spine (workspaces, roles, folders,
domains, deployment pipelines, Git, monitoring hub) is built and real-backed. Remaining
work is targeted: workspace identity, the capacity-metrics/autoscale layer, task-flow
richness, branch-out, and replacing the free-text capacity field with a real binding.

---

## 3. Gap build specs

Cross-cutting for every gap: **Azure-native default + OSS where needed**, **Commercial + Gov
(GCC/.us) variants**, **day-one ON** (provisioned + enabled at deploy, user can disable),
**Web-5.0 Fluent v9 + Loom-token UI** with wizards/dropdowns/canvas/Copilot (no freeform
config), and **real backend per control** (no vaporware).

---

### GAP 1 (P0/P1) — Workspace identity (per-workspace managed identity + trusted access)

**Why:** Fabric workspace identity is the auth backbone for trusted access to firewalled
ADLS and for credential-free connections. Loom has none — a true platform gap.

**Architecture (words):** On workspace create, the provisioner creates a **User-Assigned
Managed Identity** (`uami-loom-ws-<wsid>`) in the Loom admin/DLZ resource group (ARM
`Microsoft.ManagedIdentity/userAssignedIdentities`). The UAMI's principalId/clientId are
stored on the Cosmos workspace doc (`identity:{uamiResourceId, principalId, clientId,
state}`). A new **Identity** tab in the settings drawer shows the identity, lets a
workspace admin **grant it Storage Blob Data Reader/Contributor** on selectable Loom
storage accounts (real `Microsoft.Authorization/roleAssignments` via `az rest`/ARM), and
exposes it as a selectable **auth method** in the connection/shortcut editors (drop-in to
the existing `linked-service` / `lakehouse-shortcut` auth dropdown). Trusted access =
the UAMI is added to the storage account's **resource-instance / trusted-service** rules
(network ACL) so firewall-on storage stays reachable.

**UI spec:** Settings drawer → **Identity** tab. Empty state = `EmptyState` with
"Create workspace identity" CTA (admin-only; disabled with tooltip otherwise). Created
state = card with name, clientId (copy), principalId, state Badge (Active/Provisioning/
Failed), and an **Authorized resources** table (storage account, role, scope) with an
"+ Grant access" dialog (dropdowns: storage account → role → scope). Delete-identity
confirm dialog warns "items using this identity for trusted access will break."

**API spec (real backend):**
- `POST /api/workspaces/[id]/identity` → create UAMI (ARM PUT) → write Cosmos. Receipt: `{principalId, clientId}`.
- `GET /api/workspaces/[id]/identity` → identity + authorized resources (read role assignments).
- `POST /api/workspaces/[id]/identity/grants` `{storageAccountId, role, scope}` → role assignment (ARM) + add resource-instance rule. Receipt: assignment id.
- `DELETE /api/workspaces/[id]/identity` → delete UAMI + role assignments.

**Azure services:** UAMI, RBAC role assignments, Storage network rules. **Bicep:** extend
`landing-zone/main.bicep` to pre-create a per-workspace-identity pattern module + grant
the Console UAMI `Managed Identity Contributor` + `User Access Administrator` (scoped) so
the BFF can create child UAMIs and assign roles. Day-one: the **default workspace** ships
with its identity created and granted Blob Data Contributor on the DLZ lake.

**Commercial vs Gov:** Identical — UAMI + RBAC are first-class in Azure Government. Gov uses
`.us` ARM endpoints (already abstracted in `lib/azure`). No managed-service gap; no OSS
substitute needed. IL4/5: identities are tenant-scoped, private-network only.

**Acceptance:** With `LOOM_DEFAULT_FABRIC_WORKSPACE` unset, create a workspace → Identity
tab shows a real `clientId`; grant it Blob Data Reader on the lake → role-assignment id in
receipt; a shortcut created with "Workspace identity" auth reads from firewall-on ADLS.

---

### GAP 2 (P1) — Capacity Metrics app parity (compute/storage/timepoint, throttling, autoscale, surge)

**Why:** Loom has per-resource Azure Monitor charts but no unified "what is my capacity
doing" experience — the single most-used Fabric admin app. The ACA + Synapse/ADX compute
model has real equivalents.

**Architecture (words):** A new `/admin/capacity` **"Metrics"** sub-experience (tab beside
the existing inventory) with Fabric-parity pages, each fed by real Azure Monitor + Cost:
- **Health** — per-compute-resource (ACA env, Synapse pool, ADX cluster, Cosmos) status
  cards: utilization %, throttle/429 count, state. Source: `monitor-client.fetchMetrics`
  (CPU/memory/`cu_percentage` where present) + `…/monitor/metrics`.
- **Compute** — 14-day stacked utilization by workload (ACA app, Spark, SQL, ADX) — the
  CU-equivalent is **normalized vCPU-seconds** computed from each backend's native metric;
  ribbon + matrix-of-operations from Log Analytics run history (`ADFPipelineRun`,
  `SparkListenerApplication*`, `SynapseSqlPoolExecRequests`).
- **Storage** — 30-day ADLS + Cosmos + ADX storage (billable + soft-deleted) by workspace
  via Storage metrics + ADLS path roll-up.
- **Timepoint** — drill a 30-sec/1-min window → top operations by compute (Log Analytics).
- **Throttling/smoothing** — surface real **429 / throttle** events (ACA scale events, ADX
  `.show throttling`, Synapse queueing) as the smoothing/throttle analog.

**UI spec:** Pivot/TabList: Health · Compute · Storage · Timepoint. Cards (`shadow4`→
`shadow16`), `TileGrid`, `MetricChart` (already in repo), `LoomDataTable` matrix, date-
range Dropdown (14d/30d/custom), workspace + workload filters. Plus a **Capacity controls**
strip: **Pause/Resume** (existing `ScaleManagePanel`), **Scale SKU** dropdown, **Autoscale**
toggle + max-vCPU slider, **Surge protection** toggle + background-job cap slider.

**API spec:**
- `GET /api/admin/capacity/metrics?page=health|compute|storage|timepoint&range=…` → Azure Monitor + LA aggregates.
- `POST /api/admin/capacity/autoscale` `{resourceId, enabled, maxVcpu}` → set ACA `maxReplicas` / Synapse autoscale / ADX autoscale (real ARM).
- `POST /api/admin/capacity/surge` `{resourceId, enabled, backgroundCap}` → ACA KEDA / scheduler cap (Cosmos policy + enforcement hook).

**Azure services:** Azure Monitor metrics + Log Analytics, Cost Management, ACA/Synapse/ADX
ARM scale APIs. **Bicep:** diagnostic settings already wired (`monitoring.bicep`); add the
autoscale/surge policy Cosmos container. Day-one: metrics ON (LAW deployed), autoscale ON
with sane caps, surge protection OFF (opt-in).

**Commercial vs Gov:** Azure Monitor, Log Analytics, Cost, ACA, Synapse, ADX all exist in
Gov (`.us`). `Microsoft.Fabric/capacities` `cu_percentage` is Commercial/GCC-only — Gov
falls through to the normalized-vCPU model (the route already returns
`gate:'no_metrics_for_type'` for Fabric capacities in Gov). No OSS substitute required.

**Acceptance:** Metrics tab renders 14-day Compute chart from real LA data with Fabric
unset; toggling Autoscale changes ACA `maxReplicas` (verify via ARM read).

---

### GAP 3 (P1) — Task-flow richness (task types, recommended items, predesigned templates, import/export, multi-canvas)

**Why:** The canvas exists but lacks the Fabric task-type taxonomy, recommended-item
mapping, starter templates, JSON portability, and multiple canvases.

**Architecture (words):** Extend `taskflow-client` `TaskFlowStep` with `taskType`
(enum of the 10 Fabric types) + derive `recommendedItemTypes` from a static map keyed on
task type (reuse `lib/catalog/fabric-item-types`). Add a **predesigned-templates** module
(`lib/catalog/task-flow-templates.ts`) with ~6 Microsoft-style end-to-end flows
(Get→Store→Prepare→Analyze→Visualize, plus a Power-BI-only basic). Multi-canvas = the
existing per-workspace flows list becomes a **canvas selector** (new/rename/delete/switch).
Import/export = serialize/deserialize the Cosmos TaskFlow doc to `.json`.

**UI spec:** Canvas header gains: **task-type Dropdown** on each node (changes icon/accent
via `canvas-node-kit` `CATEGORY_ACCENT`); **Add task** menu grouped by task type;
**+ New item / clip-assign** shows recommended types first (toggle to all); **Browse
templates** dialog (card gallery) on empty canvas; **canvas selector** flyout; **Import /
Export** buttons (file picker / download). All Cosmos-backed; no Fabric.

**API spec:** reuse `…/workspaces/[id]/task-flows` (+ `[flowId]` PATCH for full-canvas
save). Add `?export=1` (GET → JSON) and `POST … {importJson}`. Recommended-item map +
templates are static (no new backend).

**Commercial vs Gov / day-one:** Pure Cosmos + static metadata — identical in both clouds,
ON by default. **Acceptance:** apply a predesigned template → tasks with correct types +
recommended items render; export → import into a second workspace round-trips.

---

### GAP 4 (P2) — Git "branch out to new workspace"

**Why:** Feature-branch isolation (Fabric's branch-out) has no Loom analog.

**Architecture (words):** "Branch out" = create a new Loom workspace (Cosmos), connect it
to a **new Git branch** (created off the source branch via ADO/GitHub ref API), then
**pull** the branch content into the new workspace (the existing git-integration pull
applies item definitions to Cosmos `state.content`). Reuses every existing client.

**UI spec:** Git tab → **Branch out to new workspace** button → dialog (new workspace name,
new branch name prefilled `feature/<user>-<slug>`). Receipt: new workspace id + branch +
applied item count. **API:** `POST /api/workspaces/[id]/git/branch-out`
`{newWorkspaceName, newBranch}` → create branch ref → create workspace → connect → pull.
**Backend:** ADO/GitHub ref API + Cosmos. Day-one ON; identical Commercial/Gov.
**Acceptance:** branch out → new workspace + branch exist; items present.

---

### GAP 5 (P2) — Workspace contact list + real capacity-assignment dropdown + per-run drilldown

Three small parity closures bundled:

1. **Contact list** — `contacts[]` on the workspace doc; General-tab people-picker
   (`PATCH /api/workspaces/[id]`); used by the existing notification path. Cosmos-only.
2. **Capacity assignment (fixes broken free-text field)** — replace the General-tab
   free-text **Capacity** `Input` with a **Dropdown** of real compute targets
   (`GET /api/admin/capacity` inventory: ACA env / Synapse pool / ADX cluster) and wire
   the selection to an actual binding (`workspace.capacityResourceId`) consumed by the
   provisioning engine to place compute. Honors `loom_no_freeform_config`.
3. **Per-run drilldown** — Monitor-hub row → detail drawer with the pipeline run's
   activity outcomes (ADF/Synapse `…/pipelineruns/{id}/queryActivityruns`) or Spark app
   detail (Spark history server / LA `SparkListener*`). Real REST; honest-gate when LA/
   history unavailable.

Commercial/Gov identical; day-one ON. **Acceptance:** capacity dropdown lists real
resources and persists a real `capacityResourceId`; run-detail drawer shows real activities.

---

## 4. Broken / half-baked found

| Feature | Symptom | Fix |
|---|---|---|
| Workspace settings → General **Capacity** | Free-text `Input` ("shared / F2 / F64…") saved as a label only — no real compute binding; violates `loom_no_freeform_config`. | Replace with a Dropdown of real capacity/compute resources (`GET /api/admin/capacity`) bound to `workspace.capacityResourceId` and consumed by the provisioner (GAP 5.2). |
| Workspace **identity** | No per-workspace managed identity anywhere → trusted access to firewall-on ADLS and credential-free connections impossible. | Build GAP 1 (UAMI per workspace + trusted-access grants + connection auth method). |

> Note: `app/api/deployment-pipelines/route.ts` calling Fabric REST is **not** a violation —
> it backs the explicitly opt-in "Fabric" tab; the Loom-native Cosmos pipeline
> (`…/deployment-pipelines/loom`) is the default surface and works with Fabric unset.

---

## 5. Suggested phase order

1. **Phase A (P0/P1):** GAP 1 Workspace identity + GAP 5.2 capacity-dropdown fix (the two real defects).
2. **Phase B (P1):** GAP 2 Capacity Metrics + autoscale/surge controls.
3. **Phase C (P1):** GAP 3 Task-flow richness.
4. **Phase D (P2):** GAP 4 branch-out + GAP 5.1/5.3 contact list & run drilldown.

Each phase ships with: bicep/role-grant updates, day-one-ON config, a parity doc refresh
under `docs/fiab/parity/`, and a real-data E2E receipt (Fabric workspace UNSET) per
`no-vaporware.md` + `ui-parity.md`.
