# Quick Start (60 minutes)

The fastest happy path: from `git clone` to a working CSA Loom
Console URL in Azure Commercial in 60 minutes.

For Gov boundaries, see [GCC-High deployment](gcc-high.md) instead.

## Prerequisites (5 min)

| Item | How to verify |
|---|---|
| Azure subscription with Contributor + User Access Administrator | `az account show` + `az role assignment list --assignee <upn>` |
| Microsoft Entra tenant + admin to create Entra groups | `az ad signed-in-user show` |
| `az` CLI ≥ 2.60 | `az --version` |
| `azd` CLI ≥ 1.10 | `azd version` |
| Bicep CLI (auto-installs via az) | `az bicep version` |
| Available `/16` IP range (default `10.0.0.0/16` for hub) | check existing VNets |
| Power BI Premium P1 or F-SKU capacity in your tenant | Power BI admin portal |
| Quota for Databricks Premium workspace in your region | `az vm list-usage --location eastus2` |

## Step 1 — Clone + authenticate (5 min)

```bash
git clone https://github.com/fgarofalo56/csa-inabox.git
cd csa-inabox/platform/fiab

az login
azd auth login
az account set --subscription <YOUR-SUBSCRIPTION-ID>
```

## Step 2 — Create the Entra group for Loom Admins (5 min)

```bash
az ad group create \
  --display-name "Loom Admins" \
  --mail-nickname "fiab-admins"

# Add yourself
GROUP_ID=$(az ad group show --group "Loom Admins" --query id -o tsv)
USER_ID=$(az ad signed-in-user show --query id -o tsv)
az ad group member add --group $GROUP_ID --member-id $USER_ID
```

Note the group object ID — you'll provide it as a deploy parameter.

## Step 3 — Initialize azd project (5 min)

```bash
azd init -t .
```

Prompts:
- Environment name: `csa-loom-quickstart`
- Region: `eastus2`
- Boundary: `Commercial`
- Deployment mode: `single-sub` (Admin Plane + 1 DLZ in same sub)
- Capacity SKU: `F8` (small production)
- Admin Entra group ID: `<paste from Step 2>`
- Hub VNet CIDR: `10.0.0.0/16` (default)

## Step 4 — Deploy (40 min)

```bash
azd up
```

This runs:
1. Bicep what-if (preview changes)
2. Confirms with you ("yes" to deploy)
3. Provisions Admin Plane (~35 min): hub VNet + Private DNS zones +
   ACR + Container Apps Env + Console + MCP + Copilot + Catalog +
   AI Foundry + AI Search + Monitoring + Key Vault
4. Provisions first DLZ (~15 min in single-sub mode): spoke VNet +
   Databricks workspace + Synapse Serverless + ADX database + ADLS
   accounts + Power BI workspace + parity services
5. Outputs the Loom Console URL

## Step 5 — Verify Console (5 min)

Open the Console URL in your browser. Sign in with your Entra
identity. You should see:
- Workspaces pane with 0 workspaces (you're about to create the first
  one)
- Catalog pane (empty)
- Monitoring Hub with health green
- Setup Wizard route available at `/setup` for adding more DLZs

## What's next

1. **Create your first workspace** —
   [Tutorial 01 — First workspace](../tutorials/01-first-workspace.md)
2. **Ingest your first dataset** —
   [Tutorial 02 — First lakehouse](../tutorials/02-first-lakehouse.md)
3. **Tour the Console panes** —
   [Loom Console overview](../console/index.md)

## Troubleshooting

If deploy fails at any step:
- [Deploy failure runbook](../runbooks/deploy-failure.md)
- `azd show` to view deploy state
- `az deployment sub list --query "[?starts_with(name, 'csa-loom')]"`
  to see ARM deployments

## Cost

Quickstart F8 deployment costs ~$3-5K/month of underlying Azure
consumption. CSA Loom IP itself is free in v1.

To pause overnight:
```bash
# Pause Databricks cluster (saves ~70% DBU)
# Pause ADX cluster
# (Console "Admin → Capacity" pane has one-click pause)
```

To tear down:
```bash
azd down --purge --force
```
