# compute — parity with Azure AI Foundry / Azure ML **compute**

> **Foundry-scoped sub-object, exposed as a standalone editor.** `slug: compute`,
> `displayName: "Foundry compute"`, `restType: FoundryCompute`, category
> **Azure AI Foundry**. Editor: `ComputeEditor` in
> `apps/fiab-console/lib/editors/foundry-sub-editors.tsx`. Compute targets are
> managed *inside* the [`ai-foundry-hub`](./ai-foundry-hub.md) workspace (the
> hub's **Computes** tab lists them read-only; this editor is the full
> create/start/stop/scale surface). One-for-one target: the Azure ML / Foundry
> **Compute** blade.

**Catalog description:** "AML compute instances + clusters. Create, start, stop,
scale, delete. Used by prompt flows, evaluations, training jobs."

**No-Fabric note:** compute is `Microsoft.MachineLearningServices/workspaces/{ws}/computes`
— pure Azure ML. No Fabric dependency. When the workspace can't be resolved the
BFF raises `NotDeployedError` → 503 honest-gate MessageBar.

Source UI: **Azure ML studio / Azure AI Foundry — Compute** (`https://ai.azure.com/compute` · `https://ml.azure.com`)
- Compute targets overview: <https://learn.microsoft.com/azure/machine-learning/concept-compute-target>
- Compute instance: <https://learn.microsoft.com/azure/machine-learning/concept-compute-instance>
- Create compute cluster: <https://learn.microsoft.com/azure/machine-learning/how-to-create-attach-compute-cluster>
- Foundry compute: <https://learn.microsoft.com/azure/ai-foundry/how-to/create-manage-compute>
- Compute REST (`Compute - Create Or Update` / `Start` / `Stop`): <https://learn.microsoft.com/rest/api/azureml/compute>

## Azure ML / Foundry compute — feature inventory

| # | Capability | Notes |
|---|-----------|-------|
| 1 | **Compute instance** — single-node dev box: name, VM size, region | `ComputeInstance` |
| 2 | **Compute cluster** — autoscaling training pool: name, VM size, min/max nodes, idle-seconds-before-scaledown, tier (dedicated/low-priority) | `AmlCompute` |
| 3 | **List / details** — name, type, VM size, state, node counts, provisioning state | list blade |
| 4 | **Start / Stop / Restart** a compute instance (power state) | Start/Stop REST |
| 5 | **Resize / re-scale** cluster min/max nodes | update REST |
| 6 | **Delete** compute | delete REST |
| 7 | **Applications** — Jupyter/JupyterLab/VS Code/terminal on an instance; SSH; schedules; idle shutdown | instance apps |
| 8 | **Kubernetes / Attached compute** — attach AKS or external compute | attach |
| 9 | Assigned-to / identity, VNet/no-public-IP, monitoring | advanced |

## Loom coverage

Backend via `foundry-client.ts` → the AML workspace target (`resolve-aml-target`:
`LOOM_AML_WORKSPACE` → … → `LOOM_FOUNDRY_NAME`), ARM
`…/workspaces/{ws}/computes`. BFF: `/api/items/compute` (GET list / POST create),
`/api/items/compute/[id]` (GET detail), `/api/items/compute/[id]/{start|stop}` (POST).

| # | Capability | Status | Detail |
|---|-----------|--------|--------|
| 1 | Create Compute instance | built ✅ | New-compute form: **Type=ComputeInstance** + name + VM size |
| 2 | Create Compute cluster | built ✅ | **Type=AmlCompute** + name + VM size + **min / max nodes** |
| 3 | List / details | built ✅ | table (name / type / VM / state) + per-compute detail view (type, VM, state, location); `EmptyState`/`ErrorBar` honest states |
| 4 | Start / Stop | built ✅ | per-row + detail **Start**/**Stop** → `/{action}` route; polling refresh after action |
| 5 | Resize / re-scale cluster | honest-gate ⚠️ | min/max are set at create; there is no post-create resize control in this editor yet |
| 6 | Delete | MISSING ❌ | no delete action wired in the editor (list + power only) |
| 7 | Applications (Jupyter/VS Code/SSH/idle-shutdown/schedules) | honest-gate ⚠️ | ribbon deep-links to `https://ai.azure.com/compute`; app-launch / idle-shutdown / schedule panels ❌ not re-hosted |
| 8 | Kubernetes / attached compute | MISSING ❌ | only AmlCompute + ComputeInstance offered |
| 9 | Identity / VNet / monitoring | MISSING ❌ | not in the create form |

## Backend per control

| Loom control | Route | Azure backend |
|--------------|-------|---------------|
| List computes | `GET /api/items/compute` → `listComputes()` | ARM `GET …/workspaces/{ws}/computes` |
| Create compute | `POST /api/items/compute` → `createCompute()` | ARM `PUT …/computes/{name}` (AmlCompute / ComputeInstance) |
| Compute detail | `GET /api/items/compute/{id}` | ARM `GET …/computes/{name}` |
| Start / Stop | `POST /api/items/compute/{id}/{start\|stop}` | ARM `POST …/computes/{name}/start`\|`/stop` |
| Unwired workspace | — | `NotDeployedError` → 503 honest MessageBar |

**Grade: B−.** The core lifecycle — create instance **and** cluster (with
min/max nodes), list, detail, Start/Stop on real Azure ML compute REST — is
functional with honest gates. Gaps vs. the full Azure blade: post-create
**resize**, **delete**, the **Applications** launch surface (Jupyter/VS Code/SSH/
idle-shutdown/schedules), **attached/Kubernetes** compute, and advanced
identity/VNet options.
