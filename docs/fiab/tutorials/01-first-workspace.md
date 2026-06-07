# Tutorial 01 — First workspace

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


Create your first CSA Loom workspace via the Console. **~5 minutes.**

!!! note "How navigation actually works"
    Loom's left nav has **top-level surfaces** (Home, Workspaces, Browse, OneLake
    catalog, Unified catalog, Lineage, API marketplace, Governance, Monitor,
    Real-Time hub, Data agents, Copilot, Workload hub, Connections, Deployment,
    Admin portal, Setup wizard). A **workspace** is a container of items shown as
    a **flat tree**; you create items inside it with **“+ New item”**, and each
    opens its editor at `/items/<type>/<id>`. There is **no per-workspace
    left-rail of service panes** — pick the item type in the “+ New item” dialog.

## Prerequisites

- Loom deployed (see [Quick Start](../deployment/quickstart.md))
- You can create workspaces (member of the Loom admins Entra group)
- Console URL open in your browser

## Steps

### 1. Open Workspaces

Click **Workspaces** in the left nav. You'll see any existing workspaces as
tiles/rows.

### 2. Create a workspace

Click **+ New workspace** (top-right). The dialog captures:

- **Name**: `tutorial-demo`
- **Description**: `My first CSA Loom workspace`
- **Capacity**: leave the default (Loom-native; no Fabric capacity required)
- **Domain**: pick a domain or leave unassigned

Click **Create**. The workspace is a Cosmos-backed container that owns items —
it's created immediately (no multi-minute resource provisioning; the Azure
backends are already deployed by the DLZ and shared).

### 3. Open the workspace

Click the new workspace to open its item tree (empty to start) at
`/workspaces/<id>`.

### 4. Add your first item

Click **+ New item**, choose a type (e.g. **Lakehouse**, **Notebook**,
**Warehouse**, **KQL Database**, **Data agent**…), name it, and Create. It opens
in its editor at `/items/<type>/<id>`. Repeat to add more — they appear in the
workspace tree.

### 5. (Optional) Delete the workspace

From the Workspaces list, use the workspace's row action to delete it (removes
the Cosmos record + its items; the shared Azure backends remain).

## What's next

- [Tutorial 02 — First lakehouse + Delta tables](02-first-lakehouse.md)
- Read [Workspace RBAC](../governance/workspace-rbac.md) to understand
  how to share the workspace with team members

## Troubleshooting

If workspace creation fails:
- Check Console "Monitoring → Deploy history" for the error
- Most common: capacity quota exceeded — pick smaller SKU or request
  quota
- See [Deploy failure runbook](../runbooks/deploy-failure.md)
