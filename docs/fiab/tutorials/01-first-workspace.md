# Tutorial 01 — First workspace

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


Create your first CSA Loom workspace via the Console. **15 minutes.**

## Prerequisites

- Loom deployed (see [Quick Start](../deployment/quickstart.md))
- You are a member of the `Loom Admins` Entra group OR have
  `Workspace Creator` role
- Console URL open in your browser

## Steps

### 1. Navigate to Workspaces pane

Click **Workspaces** in the left rail. You should see the auto-created
`default-workspace` from initial deploy.

### 2. Create a new workspace

Click **+ New Workspace** in the top-right.

Fill the form:
- **Name**: `tutorial-demo`
- **Description**: `My first CSA Loom workspace`
- **Domain**: Select an existing domain or `<unassigned>`
- **Primary use case**: `Data Engineering` (drives default settings)
- **Admin Entra group**: pick the group whose members should admin
  this workspace (you can use `Loom Admins` for the tutorial)
- **Capacity allocation**: `Small (F2-equivalent)` for the tutorial

Click **Create**.

### 3. Watch the deploy

Console shows a progress modal:
- ADLS Gen2 container provisioned (~30 s)
- Databricks workspace permissions assigned (~60 s)
- Power BI workspace created via REST (~60 s)
- ADX database added to shared cluster (~30 s)
- Synapse Serverless database created (~30 s)
- UC catalog (or Hive schema in Gov) created (~30 s)
- Purview collection registered (~60 s)

Total: ~5 minutes.

### 4. Verify the workspace

Once green, click **Open** to navigate into the workspace home.

You should see:
- 0 lakehouses, 0 warehouses, 0 notebooks, 0 semantic models, 0 KQL
  DBs, 0 activator rules, 0 data agents (you're about to create some)
- Member list with you as Admin
- Recent activity feed showing the creation event

### 5. Explore the panes

Click each pane in the workspace's left rail:
- **Lakehouse** — should be empty (Files + Tables)
- **Warehouse** — empty SQL editor; schema explorer shows the new
  database
- **Notebook** — empty (no notebooks yet)
- **KQL** — empty database in the shared ADX cluster
- **Catalog** — shows the workspace's catalog tags

### 6. Cleanup (optional)

To delete the workspace:
- Workspace home → **Settings → Delete workspace**
- Type the workspace name to confirm
- Console removes the RG + all child resources

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
