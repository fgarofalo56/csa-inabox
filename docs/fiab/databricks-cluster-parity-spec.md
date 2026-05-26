# Loom Databricks Cluster Editor — Parity build spec

> Reference: Azure Databricks **Compute** UI (`adb-<id>.azuredatabricks.net/compute`). Covers all-purpose (interactive) and job clusters. SQL Warehouses are a separate compute primitive (see `databricks-sql-warehouse-parity-spec.md`).

## Why this exists

Loom ships `DatabricksClusterEditor` plus `/api/items/databricks-cluster/**`. Today it lists clusters (`listClusters`), reads (`getCluster`), creates (`createCluster`), starts / stops / restarts (`startCluster` / `terminateCluster` / `restartCluster`), permanently deletes (`permanentDeleteCluster`), lists node types and Spark versions (`listNodeTypes` / `listSparkVersions`), and lists events (`listClusterEvents`). That's **A-grade** — real Databricks clusters end-to-end, no mocks. Polish gaps are around editing existing clusters in place, init scripts, libraries, policies, and pool selection.

## Databricks Compute UX inventory (Compute UI)

### Compute list page

| Region | Elements |
|---|---|
| **Tabs** | All-purpose compute · Job compute · Pools · Cluster policies · SQL Warehouses |
| **Header** | Create compute button · Filter (state / access mode / runtime / creator) · Search |
| **Table** | Name · State (Running / Pending / Terminated / Restarting / Error) · Driver type · Workers · DBR version · Access mode · Creator · Spend per hour · Tags |

### Compute create / edit page

| Section | Fields |
|---|---|
| **Identity** | Cluster name · Tags (key/value) |
| **Policy** | Cluster policy dropdown (Personal Compute / Shared / Admin-defined) — policy may lock fields |
| **Access mode** | Single user (dedicated) · Standard (shared) · No isolation shared (legacy) |
| **Runtime** | Databricks Runtime version (LTS / standard / ML / GPU / Photon) · Use Photon Acceleration toggle |
| **Worker type** | Node type picker (Memory / Compute / Storage / GPU optimized) · Min/Max workers OR fixed count |
| **Driver type** | Node type (same family as worker by default) · Same as worker toggle |
| **Autoscaling** | Enable autoscaling toggle · Min workers · Max workers · On-demand vs spot mix |
| **Auto termination** | Minutes of inactivity before terminate (default 60) |
| **Advanced — Performance** | Spot instance · Availability (On-demand and spot fall-back) · Photon · Local disk encryption |
| **Advanced — Tags** | Custom tags |
| **Advanced — Spark** | Spark config (key/value pairs) · Environment variables |
| **Advanced — Logging** | Cluster log delivery (DBFS / S3 / Volume) |
| **Advanced — Init scripts** | List of init scripts (Workspace / Volume / DBFS / cloud storage) — run in order |
| **Libraries** | PyPI / Maven / CRAN / DBFS jar / Volume wheel — installed at cluster start |
| **Permissions** | Can Attach / Can Restart / Can Manage |

### Cluster detail page tabs

- **Configuration** — read-only summary of the spec
- **Notebooks** — currently attached notebooks
- **Libraries** — install / uninstall list with status
- **Event log** — start, resize, restart, terminate events with reason codes
- **Spark UI** — link to driver Spark UI
- **Driver logs** — stdout, stderr, log4j
- **Metrics** — Ganglia (legacy) / Datadog-style charts: CPU / memory / disk / network / GC / executor count over time
- **Apps** — workspace web apps attached

### State transitions

`PENDING` → `RUNNING` → `RESTARTING` / `RESIZING` → `TERMINATING` → `TERMINATED` → (`PERMANENTLY_DELETED` after explicit delete). Non-terminal failure: `ERROR`.

### Policies (admin gate)

Cluster policies are JSON templates that constrain `node_type_id`, `spark_version`, `autoscale.max_workers`, etc. Policies are how admins keep costs in check. UI: dropdown at the top of the create form; selecting a policy locks fields the policy fixes.

---

## What Loom has today (wired)

| Capability | Backend | UI |
|---|---|---|
| List clusters | `GET /api/items/databricks-cluster` → `listClusters()` → `/api/2.0/clusters/list` | Left panel |
| Read cluster | `GET /api/items/databricks-cluster/[id]?clusterId=` → `getCluster()` → `/api/2.0/clusters/get` | Form populates |
| Create cluster | `POST /api/items/databricks-cluster` → `createCluster()` → `/api/2.0/clusters/create` | "Create" button (when no clusterId) |
| Start | `POST …/state?clusterId=` action=start → `startCluster()` → `/api/2.0/clusters/start` (idempotent on `already started`) | Start button |
| Stop (terminate) | action=stop → `terminateCluster()` → `/api/2.0/clusters/delete` (terminate, not destroy) | Stop button |
| Restart | action=restart → `restartCluster()` → `/api/2.0/clusters/restart` | Restart button |
| Permanent delete | `DELETE …?clusterId=&permanent=true` → `permanentDeleteCluster()` → `/api/2.0/clusters/permanent-delete` | Delete (with confirm) |
| Pick node type | `GET /api/items/databricks-cluster/options` → `listNodeTypes()` → `/api/2.0/clusters/list-node-types` | Dropdown |
| Pick Spark version | same options route → `listSparkVersions()` → `/api/2.0/clusters/spark-versions` | Dropdown |
| Autoscale toggle | UI switch → spec emits `autoscale: {min,max}` or `num_workers` | Switch + 2 inputs |
| Auto-termination | UI input → `autotermination_minutes` | Input |
| Event log | `GET …/events?clusterId=&limit=50` → `listClusterEvents()` → `/api/2.0/clusters/events` | Table at bottom |

Status: **A-grade**. Real Databricks clusters. No mocks. Documented limitation in the editor UI: **edit-after-create is not wired** — users must delete + recreate to change spec. That's the biggest polish gap.

## Gaps for parity (polish)

1. **Edit existing cluster** — `editCluster()` is implemented in `databricks-client.ts` (`POST /api/2.0/clusters/edit`) but the editor doesn't call it. Today the save button says "Save (recreate to change spec)". Fix: when `clusterId` is set, call `editCluster(clusterId, spec)`; for fields locked while running, show a "Restart required" hint.
2. **Driver node type** — currently driver inherits worker `node_type_id`. Add a "Driver type" picker (default same as worker, override allowed).
3. **Access mode** — `data_security_mode` field (SINGLE_USER / USER_ISOLATION / LEGACY_SINGLE_USER / NONE). Today the spec is sent without it; cluster gets the workspace default. Add a radio.
4. **Photon toggle** — when the picked Spark version supports Photon, show a "Use Photon" checkbox (sets `runtime_engine: PHOTON`).
5. **Init scripts** — `init_scripts: [{ workspace: { destination } } | { volumes: { destination } } | { dbfs: { destination } } | { s3: { destination, region } }]`. Add a table editor.
6. **Libraries** — separate `POST /api/2.0/libraries/install` + `uninstall` + `GET /api/2.0/libraries/cluster-status?cluster_id=`. Add a Libraries tab with PyPI / Maven / Volume wheel options.
7. **Cluster policies** — `GET /api/2.0/policies/clusters/list` for the dropdown; selecting a policy applies its `policy_id` to the spec and reads `definition` to lock fields. Without a policy, normal user without admin role gets `unrestricted` or `personal compute`.
8. **Tags** — `custom_tags: { key: value }` editor. Cost-allocation lives here.
9. **Spark config / env vars** — `spark_conf: { key: value }` + `spark_env_vars: { key: value }` textarea pairs.
10. **Cluster log delivery** — `cluster_log_conf: { dbfs: { destination } | volumes: { destination } | s3: {...} }`.
11. **Spot vs on-demand mix** — `azure_attributes: { availability: SPOT_WITH_FALLBACK_AZURE | ON_DEMAND_AZURE | SPOT_AZURE, first_on_demand: N, spot_bid_max_price: M }`.
12. **Pools** — `instance_pool_id` to attach to a pool (faster cold-start). Need `GET /api/2.0/instance-pools/list` for the picker.
13. **Permissions** — `GET /api/2.0/permissions/clusters/<id>` GET + PATCH (Can Attach / Can Restart / Can Manage).
14. **Metrics tab** — pull `/api/2.0/clusters/metrics-snapshot` (cluster manager metrics) for CPU/mem charts, or wire to Azure Monitor for the workspace.
15. **Real-time state poll** — UI doesn't auto-refresh state during PENDING/RESTARTING. Add a 5s poll while non-terminal.

## Backend mapping

- List: `GET /api/2.0/clusters/list` (wired)
- Get: `GET /api/2.0/clusters/get?cluster_id=` (wired)
- Create: `POST /api/2.0/clusters/create` (wired)
- Edit: `POST /api/2.0/clusters/edit` (client method exists, **not wired in editor**)
- Start: `POST /api/2.0/clusters/start` (wired)
- Restart: `POST /api/2.0/clusters/restart` (wired)
- Terminate: `POST /api/2.0/clusters/delete` (wired — note: this is "terminate" not destroy)
- Permanent delete: `POST /api/2.0/clusters/permanent-delete` (wired)
- Resize: `POST /api/2.0/clusters/resize` (not yet exposed)
- Events: `POST /api/2.0/clusters/events` (wired)
- Node types: `GET /api/2.0/clusters/list-node-types` (wired)
- Spark versions: `GET /api/2.0/clusters/spark-versions` (wired)
- **NEW** Policies: `GET /api/2.0/policies/clusters/list`
- **NEW** Pools: `GET /api/2.0/instance-pools/list`
- **NEW** Libraries: `GET /api/2.0/libraries/cluster-status` · `POST /install` · `POST /uninstall`
- **NEW** Permissions: `GET /api/2.0/permissions/clusters/<id>` · `PATCH` same

## Required Azure resources

- **Azure Databricks workspace** (existing)
- **UAMI as workspace user with cluster-create permission** (already granted)
- **Sufficient core quota** in the deployment subscription — cluster create fails with `QuotaExceeded` if the VM family hasn't been pre-approved. Document in the editor as a MessageBar when the create API returns 400 with that code.
- **No new Bicep needed**, but consider adding a default unrestricted cluster policy via `Microsoft.Databricks/workspaces/...` if customer needs guardrails.

## Estimated effort

| Gap | Hours |
|---|---|
| Wire `editCluster` (lift the "recreate to change spec" limitation) | 1.5 |
| Driver type + access mode + Photon | 1.5 |
| Init scripts editor (table + path picker) | 2 |
| Libraries tab (PyPI / Maven / Volume) | 3 |
| Cluster policies dropdown + field-locking | 2.5 |
| Tags + Spark conf + env vars + log delivery | 2 |
| Spot / on-demand / pool attachment | 2 |
| Permissions panel | 1.5 |
| Metrics tab (Azure Monitor link + snapshot) | 2 |
| Auto-refresh state poll | 0.5 |
| **Total** | **~18.5 hrs** (2-3 focused sessions) |
