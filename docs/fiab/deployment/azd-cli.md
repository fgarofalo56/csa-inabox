# From `azd` CLI

The power-user deployment path. Full Bicep visibility; per-boundary
parameter customization; suitable for production deploys.

## Why azd

- **Reproducible** — `azd up` re-runs are idempotent; what-if
  preview before every deploy
- **Per-environment** — `azd env new prod`, `azd env new staging`,
  `azd env new dev`
- **Bicep transparency** — every Azure resource visible in
  `platform/fiab/bicep/`; modify and re-deploy
- **CI/CD-friendly** — `azd provision` runs cleanly in GitHub
  Actions / Azure DevOps

## Prerequisites

| Item | Notes |
|---|---|
| `azd` CLI ≥ 1.10 | `azd version` |
| `az` CLI ≥ 2.60 | `az --version` |
| Bicep CLI (auto-installs) | `az bicep version` |
| Contributor + User Access Administrator on target sub | `az role assignment list --assignee <upn>` |
| Admin Entra group object ID (FiaB Admins) | See [Quickstart Step 2](quickstart.md) |

## Project layout

```
platform/fiab/
├── azd/
│   ├── azure.yaml          # azd project definition
│   └── infra → ../bicep    # symlink to Bicep modules
├── bicep/
│   ├── main.bicep          # top-level orchestrator
│   ├── params/
│   │   ├── commercial.bicepparam
│   │   ├── gcc.bicepparam
│   │   └── gcc-high.bicepparam
│   └── modules/
│       ├── admin-plane/    # DMZ-equivalent modules
│       ├── landing-zone/   # DLZ-per-domain modules
│       └── shared/         # ADX cluster, role definitions, tagging
```

## Per-environment flow

```bash
cd platform/fiab/azd

# New environment
azd env new prod-eastus2

# Edit env vars (azd writes to .azure/<env>/.env)
azd env set AZURE_LOCATION eastus2
azd env set CSA_LOOM_BOUNDARY Commercial
azd env set CSA_LOOM_DEPLOYMENT_MODE multi-sub
azd env set CSA_LOOM_CAPACITY_SKU F32
azd env set CSA_LOOM_ADMIN_GROUP_ID <group-guid>
azd env set CSA_LOOM_HUB_VNET_CIDR 10.0.0.0/16

# Multi-sub mode: also set DLZ subscription IDs
azd env set CSA_LOOM_DLZ_SUB_IDS "sub-b-id,sub-c-id,sub-d-id"

# Preview
azd provision --preview

# Deploy
azd up
```

## Multi-environment example

```bash
# Production in Commercial
azd env new prod-commercial
azd env set CSA_LOOM_BOUNDARY Commercial
azd env set CSA_LOOM_DEPLOYMENT_MODE multi-sub
azd up

# Staging in GCC-High
azd env new staging-gcch
azd env set AZURE_CLOUD AzureUSGovernment
az cloud set --name AzureUSGovernment
azd auth login
azd env set CSA_LOOM_BOUNDARY GCC-High
azd env set AZURE_LOCATION usgovvirginia
azd env set CSA_LOOM_OPENAI_LOCATION usgovvirginia
azd env set CSA_LOOM_EMBEDDINGS_LOCATION usgovarizona
azd env set CSA_LOOM_DEPLOYMENT_MODE multi-sub
azd up
```

## CI/CD with GitHub Actions

```yaml
# .github/workflows/deploy-fiab-commercial.yml (excerpt)
- uses: Azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

- uses: azure/setup-azd@v2
- name: Deploy FiaB
  run: |
    azd env new ${{ github.run_id }}
    azd env set CSA_LOOM_BOUNDARY Commercial
    azd env set CSA_LOOM_DEPLOYMENT_MODE single-sub
    azd env set CSA_LOOM_CAPACITY_SKU F8
    azd env set CSA_LOOM_ADMIN_GROUP_ID ${{ secrets.FIAB_ADMIN_GROUP_ID }}
    azd provision --no-prompt
```

The full nightly deploy validation workflows ship under
`.github/workflows/deploy-fiab-*.yml` (PRP-11).

## Bicep-only deploy (no azd)

For customers with their own pipeline:

```bash
az deployment sub create \
  --name csa-loom-$(date +%s) \
  --location eastus2 \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial.bicepparam \
  --parameters adminEntraGroupId=<group-guid>
```

## What-if + dry-run

```bash
# Bicep what-if (shows what would change)
az deployment sub what-if \
  --location eastus2 \
  --template-file platform/fiab/bicep/main.bicep \
  --parameters platform/fiab/bicep/params/commercial.bicepparam

# azd preview
azd provision --preview
```

## Outputs

`azd up` outputs:
- `consoleUrl` — the Loom Console URL
- `mcpServerUrl` — the self-hosted Azure MCP endpoint
- `adminPlaneHubVnetId` — for cross-VNet peering in multi-sub mode

## Tear down

```bash
azd down --purge --force
```

Removes all Loom RGs in the current env's sub. Storage accounts go
into soft-delete (30 days). To fully purge:
```bash
az storage account purge ...
az keyvault purge ...
```

## Troubleshooting

- [Deploy failure runbook](../runbooks/deploy-failure.md)
- [MCP troubleshooting](../runbooks/mcp-troubleshooting.md)
