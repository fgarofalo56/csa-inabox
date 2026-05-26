# Loom Compute Editor — Foundry-parity spec

> Captured 2026-05-26 by catalog agent `foundry-parity-2026-05-26`. Sources: Microsoft Learn — [What are compute targets in Azure Machine Learning?](https://learn.microsoft.com/azure/machine-learning/concept-compute-target?view=azureml-api-2), [What is an Azure Machine Learning compute instance?](https://learn.microsoft.com/azure/machine-learning/concept-compute-instance?view=azureml-api-2), [Create an Azure Machine Learning compute instance](https://learn.microsoft.com/azure/machine-learning/how-to-create-compute-instance?view=azureml-api-2), [Create an Azure Machine Learning compute cluster](https://learn.microsoft.com/azure/machine-learning/how-to-create-attach-compute-cluster?view=azureml-api-2), [Manage an Azure Machine Learning compute instance](https://learn.microsoft.com/azure/machine-learning/how-to-manage-compute-instance?view=azureml-api-2), [Manage and optimize Azure ML costs](https://learn.microsoft.com/azure/machine-learning/how-to-manage-optimize-cost?view=azureml-api-2). Cross-checked against existing Loom editor at `apps/fiab-console/lib/editors/foundry-sub-editors.tsx::ComputeEditor` and the foundry client at `apps/fiab-console/lib/azure/foundry-client.ts::listComputes/getCompute/createCompute/startCompute/stopCompute/deleteCompute`.

## What it is

An **AI Foundry compute** is the underlying VM (or pool of VMs) that runs training jobs, fine-tuning, prompt-flow runtimes, batch inference, and online model deployments. Three kinds matter:

- **Compute instance (`ComputeInstance`)** — single-node managed workstation for one user: Jupyter / JupyterLab / VS Code, terminal, a job queue, can act as the prompt-flow runtime. 120 GB OS disk, configurable idle shutdown, optional SSH, optional schedule
- **Compute cluster (`AmlCompute`)** — managed multi-node CPU/GPU cluster that autoscales between min and max nodes for jobs. Supports **Dedicated** vs **Low priority** (spot), idle-time-before-scale-down, no public IP, VNet integration, optional SSH
- **Serverless compute** — implicit pool managed by Azure: no resource to create; jobs declare `compute: serverless` and a `job_tier: Spot|Dedicated`. Auto-provisioned per job

Computes can also include **attached compute** (HDInsight, Databricks, Synapse Spark, Azure Arc-enabled Kubernetes) and **inference cluster (AKS)** for managed online endpoints; both are out of scope for the v2.5 wave.

## UI components

### Page chrome
- Title bar: workspace name + breadcrumb to hub
- Right-side actions: **Refresh**, **+ New**
- Top tab strip (the Foundry portal Compute hub has these tabs): **Compute instances**, **Compute clusters**, **Serverless instances**, **Inference clusters**, **Attached compute**

### Compute instances tab
- Grid columns: **Name**, **State** (Running / Stopped / Starting / Stopping / Creating / Failed), **VM size** (e.g. STANDARD_DS3_v2), **Application URI** (Jupyter/JupyterLab/VS Code/RStudio/Terminal — quick-launch icons), **Created by**, **Created on**, **Idle time**, **Last operation**
- Per-row actions: **Start**, **Stop**, **Restart**, **Delete**, **Connect via SSH** (shows connection string if SSH enabled at create), **Open in Jupyter**, **Open in JupyterLab**, **Open in VS Code (Web/Desktop)**, **Terminal**, **Manage applications** (custom apps mounted on the instance), **Edit schedule**, **Edit idle-shutdown**
- Detail pane: **Overview** (image version, GPU/CPU type, OS, disk, network, IP, identity), **Details** (full ARM props), **Applications** (custom app list), **Schedules** (cron-style auto-start/stop), **Idle shutdown** config

#### Create instance wizard
- **Basics**: Compute name (3-24 chars, unique-in-region), location, VM type (CPU/GPU), VM size searchable list (with quota indicator and price per hour)
- **Advanced**:
  - **Enable SSH access** (cannot be changed later) → SSH public-key source (Generate new pair / Use existing in Azure / Provide RSA PEM)
  - **Virtual network**: Azure VNet OR Foundry managed network OR No VNet
  - **No public IP** toggle (when in VNet)
  - **Assign managed identity** (System-assigned or User-assigned; UAMI picker)
- **Schedule auto-start / auto-stop**: cron expression, timezone, recurrence
- **Idle shutdown**: enable toggle + minutes (15 min - 3 days). Note: "compute instance is considered inactive when no Jupyter kernel sessions, no terminals, no AML runs, no VS Code connections, no custom apps running"
- **Setup script** (optional): blob URI or inline script run on create
- **Assign to another user** (Create on behalf of) — admin-only flow
- **Custom applications**: add Docker-image-based custom apps with port/endpoint config (RStudio Server, custom Streamlit, etc.)

### Compute clusters tab
- Grid columns: **Name**, **State** (Resizing / Steady / Running / Failed), **VM size**, **Priority** (Dedicated / LowPriority), **Min nodes / Max nodes**, **Current nodes** (running / idle), **Idle seconds before scale down**, **Created on**
- Per-row actions: **Edit min/max**, **Resize**, **Delete**, **Nodes** (drill into per-node state + SSH connection string)
- **Nodes** detail: node ID, state, IP, port, **Connection string** (e.g. `ssh -p 50000 azureuser@cluster-node-ip`)

#### Create cluster wizard
- **Basics**: location, VM type (CPU/GPU), VM priority (Dedicated / Low priority), VM size
- **Advanced**: name (3-24 chars), min nodes (default 0), max nodes, idle seconds before scale-down (default 120), **Enable SSH** + key source (same as instance), **Advanced** networking (Azure VNet / managed network / No public IP), **Assign managed identity**

### Serverless instances tab
- For projects that opt in to serverless: shows ephemeral instances spun up by submitted jobs. Read-only: job ID, VM size, status, started, ended. No create flow (managed by Azure)

### Inference clusters tab
- Lists attached AKS clusters used as inference targets for online endpoints. Out of scope for v2.5

### Attached compute tab
- Read-only list of HDInsight/Databricks/Synapse Spark/Arc-K8s attached resources. Out of scope for v2.5

## What Loom has

The current Loom `ComputeEditor` (`apps/fiab-console/lib/editors/foundry-sub-editors.tsx` lines 555–654) is wired live to the hub workspace via the BFF route `GET /api/items/compute` and `POST /api/items/compute` and `POST /api/items/compute/[name]/{start|stop}`. The foundry-client functions are `listComputes`, `getCompute`, `createCompute`, `startCompute`, `stopCompute`, `deleteCompute`.

- New-mode shows a single-form **+ New compute** card: Name, Type (AmlCompute or ComputeInstance), VM size (free-text), Min nodes / Max nodes (clusters only)
- List view shows a flat table: Name, Type, VM, State + Start/Stop buttons per row
- Detail-mode shows: Type, VM, State, Location + Start / Stop / Reload buttons
- No SSH key handling, no managed-identity assignment, no idle-shutdown setting, no schedule, no VNet/managed-network options, no setup script, no custom-app config, no priority (Dedicated/Low) selector, no per-node drill-down, no quota/price hints, no Open-in-Jupyter/VSCode/Terminal links, no serverless tab, no inference-cluster tab, no attached-compute tab
- Cluster create defaults `nodeIdleTimeBeforeScaleDown: 'PT15M'` and `vmPriority: 'Dedicated'` — no UI to override

## Gaps for parity

1. **Tab structure** — flat list today; Foundry portal splits Instances / Clusters / Serverless / Inference / Attached. Need a top-level tab strip
2. **VM size picker** — current input is free-text. Need a searchable picker that calls `GET {workspace}/vmSizes` and shows family, vCPU, RAM, GPU, regional availability, quota balance, price/hour
3. **SSH key handling** — Foundry create flow offers: generate new pair (download .pem), use existing stored key, paste RSA public key. Loom has none. Cannot be added after create
4. **Idle shutdown config** — preview feature, single textbox in Foundry; missing in Loom. Critical for cost-control rule compliance
5. **Schedule auto-start/auto-stop** — cron-style schedule with timezone; missing. Same reason
6. **VNet / managed-network / No-public-IP** — security-critical for the FedCiv deployment; missing
7. **Identity assignment** — System or User-assigned managed identity; missing
8. **Setup script** — blob URI or inline; missing
9. **Custom applications** (instance only) — port/endpoint/Docker config for RStudio etc; missing
10. **VM priority** (cluster) — Dedicated / Low priority (Spot) selector; current code hard-codes Dedicated
11. **Per-node detail / SSH connection string** — clusters expose `GET {workspace}/computes/{name}/nodes` with per-node state + connection string; missing
12. **Application URIs** — Foundry surfaces quick-launch buttons for Jupyter / JupyterLab / VS Code Web / VS Code Desktop / RStudio / Terminal on running instances. We have `properties.applicationSharingPolicy` and `properties.applications` data but render nothing
13. **Quota / price indicators** — region quota balance and $/hour estimates next to each VM size; missing
14. **Resize cluster** — change min/max while running via `PATCH {workspace}/computes/{name}`; missing
15. **Create-on-behalf-of** — admin flow to create an instance assigned to another user; missing
16. **Serverless tab** — read-only inventory of serverless instances; missing
17. **VM type retirement warnings** — Foundry shows "this SKU retired on X" badges for NC/NCv2/NCv3/ND/NV/Av1/HB; missing

## Backend mapping

All compute lifecycle is ARM under the workspace (hub for shared compute, or project for project-scoped). API version: 2024-10-01 (with `2024-10-01-preview` for newer features like idle-shutdown).

| Loom surface | Backend call |
|---|---|
| List computes | `GET {workspace}/computes?api-version=2024-10-01` (already wired) |
| Get compute | `GET {workspace}/computes/{name}` (already wired) |
| Create instance | `PUT {workspace}/computes/{name}` with body `{location, properties: {computeType: "ComputeInstance", properties: {vmSize, sshSettings, idleTimeBeforeShutdown, schedules, subnet, enableNodePublicIp, computeInstanceAuthorizationType, personalComputeInstanceSettings, customServices, setupScripts}}}` |
| Create cluster | `PUT {workspace}/computes/{name}` with body `{location, properties: {computeType: "AmlCompute", properties: {vmSize, vmPriority, scaleSettings: {minNodeCount, maxNodeCount, nodeIdleTimeBeforeScaleDown}, subnet, remoteLoginPortPublicAccess, enableNodePublicIp, isolatedNetwork, userAccountCredentials}}}` |
| Start / Stop / Restart | `POST {workspace}/computes/{name}/{start|stop|restart}` (start/stop already wired) |
| Delete | `DELETE {workspace}/computes/{name}` (already wired) |
| Resize cluster | `POST {workspace}/computes/{name}/resize` with `{scaleSettings: {...}}` |
| List nodes | `POST {workspace}/computes/{name}/listNodes` (returns per-node IP + port + state) |
| List VM sizes | `GET https://management.azure.com/subscriptions/{sub}/providers/Microsoft.MachineLearningServices/locations/{loc}/vmSizes?api-version=2024-10-01` |
| Quota | `GET .../locations/{loc}/quotas?api-version=2024-10-01` |
| Generate SSH key pair | client-side (Web Crypto SubtleCrypto / Node `crypto.generateKeyPairSync('ed25519')`) — public key flows into the create body |

The existing client already implements basic create/start/stop/delete. New helpers required: `listVmSizes(location)`, `listQuotas(location)`, `listClusterNodes(name)`, `resizeCluster(name, min, max)`, `updateIdleShutdown(name, minutes)`, `updateSchedule(name, cron)`, and a richer `createCompute` that accepts the full advanced-settings body.

## Required Azure resources

- **Hub workspace** (already provisioned)
- **VM quota** in the hub region (eastus2) for the VM families exposed in the picker. If quota is zero for a family, the picker MUST gray it out with a Fluent `MessageBar intent="warning"` ("No quota for STANDARD_NC family in eastus2 — request increase here")
- **Storage Blob Data Contributor** role on the hub's storage account, assigned to the **compute's** managed identity (when idle-shutdown is enabled with a managed-identity-bound workspace, this is required per docs)
- **Virtual network** + subnet (optional) — only needed when network isolation is on. Bicep needs a `vnet.bicep` module that the editor's create flow can reference
- **SSH allowlist** — Azure policy may forbid SSH-on-creation; surface honestly with a MessageBar if `Microsoft.Authorization/policyAssignments` indicates the policy is in place
- **Bicep** — extend `platform/fiab/bicep/modules/foundry/compute.bicep` to support full instance + cluster shape (idle-shutdown, schedules, subnet, identity, custom apps)

## Estimated effort

**3 focused sessions** to reach grade B (production-grade — works, looks good, real data, real backend):

- **Session N+1 (~2.5 hrs):** Tab structure (Instances / Clusters / Serverless), VM size searchable picker (with `listVmSizes` + quota indicator), full advanced-settings panel (SSH key gen, idle-shutdown, schedule, VNet, identity), VM priority (Dedicated/LowPriority) for clusters
- **Session N+2 (~2 hrs):** Per-node detail with SSH connection string, Resize cluster, Edit idle-shutdown / Edit schedule on existing instance, Application URI quick-launch icons (Jupyter / JupyterLab / VS Code Web / Terminal)
- **Session N+3 (~2 hrs):** Setup script + custom applications config, Create-on-behalf-of, Serverless instances inventory, VM-retirement warning badges

A fourth session lands grade A+ (tests + bicep): Vitest unit tests on the cron-expression validator and the SSH-key-pair generation, a Playwright walk covering create-instance → wait-for-running → open-in-jupyter → idle-shutdown, and bicep extensions covering all advanced-settings fields.
