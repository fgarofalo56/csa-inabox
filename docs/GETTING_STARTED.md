# Getting Started with CSA-in-a-Box

## Prerequisites

### Azure Requirements
- **4 Azure Subscriptions**: Management, Connectivity, Data Management (DMLZ), Data Landing Zone (DLZ)
- **Azure AD Tenant** with Global Admin or Privileged Role Admin access
- **Contributor** role on all 4 subscriptions
- **Microsoft.Purview**, **Microsoft.Databricks**, **Microsoft.Synapse** resource providers registered

### Local Tools
| Tool | Version | Install |
|------|---------|---------|
| Azure CLI | >= 2.50 | `winget install Microsoft.AzureCLI` |
| Bicep CLI | >= 0.25 | `az bicep install` |
| PowerShell | >= 7.3 | `winget install Microsoft.PowerShell` |
| Python | >= 3.10 | `winget install Python.Python.3.11` |
| Git | >= 2.40 | `winget install Git.Git` |
| dbt | >= 1.7 | `pip install dbt-databricks` |

### Azure RBAC Permissions
The deploying identity needs:
- **Owner** on Management subscription (for policy assignments)
- **Contributor** on all other subscriptions
- **User Access Administrator** for RBAC assignments

## Quick Start (30 minutes)

### Step 1: Clone and Setup
```bash
git clone https://github.com/your-org/csa-inabox.git
cd csa-inabox
make setup  # or `make setup-win` on Windows
```

### Step 2: Configure Parameters

Copy the example parameter files for your environment:
```bash
# Data Management Landing Zone
cp deploy/bicep/DMLZ/params.dev.json deploy/bicep/DMLZ/params.YOUR_ENV.json

# Data Landing Zone
cp deploy/bicep/DLZ/params.dev.json deploy/bicep/DLZ/params.YOUR_ENV.json
```

Edit each file and fill in your Azure-specific values:
- Subscription IDs
- VNet/Subnet resource IDs
- Private DNS Zone configuration
- Storage account names (must be globally unique)

### Step 3: Deploy Azure Landing Zone (Foundation)
```bash
az login
az account set --subscription YOUR_MGMT_SUBSCRIPTION_ID

az deployment sub create \
  --location eastus \
  --template-file "deploy/bicep/LandingZone - ALZ/main.bicep" \
  --parameters "deploy/bicep/LandingZone - ALZ/params.YOUR_ENV.json"
```

### Step 4: Deploy Data Management Landing Zone
```bash
az account set --subscription YOUR_DMLZ_SUBSCRIPTION_ID

az deployment sub create \
  --location eastus \
  --template-file deploy/bicep/DMLZ/main.bicep \
  --parameters deploy/bicep/DMLZ/params.YOUR_ENV.json
```

### Step 5: Deploy Data Landing Zone
```bash
az account set --subscription YOUR_DLZ_SUBSCRIPTION_ID

az deployment sub create \
  --location eastus \
  --template-file deploy/bicep/DLZ/main.bicep \
  --parameters deploy/bicep/DLZ/params.YOUR_ENV.json
```

### Step 6: Verify Deployment
```bash
# Check resource groups were created
az group list --query "[?tags.Project=='CSA-in-a-Box']" -o table

# Verify Databricks workspace
az databricks workspace list -o table

# Verify storage accounts
az storage account list --query "[?tags.Project]" -o table
```

## Deployment Order

```
1. Landing Zone (ALZ)     → Management + Connectivity subscriptions
       ↓
2. DMLZ                   → Data Management subscription (Purview, Key Vault)
       ↓
3. DLZ                    → Data Landing Zone subscription (per domain)
```

**Important**: Each layer depends on the previous one. Deploy in order.

## Common Issues

| Error | Cause | Fix |
|-------|-------|-----|
| `PrivateDnsZone not found` | DNS zones not deployed | Deploy ALZ first, or create DNS zones manually |
| `SubnetNotFound` | VNet/Subnet doesn't exist | Create VNet infrastructure before DLZ |
| `QuotaExceeded` | Region capacity limit | Try a different region or request quota increase |
| `RoleAssignmentExists` | Re-running deployment | Safe to ignore — assignment already exists |
| `AuthorizationFailed` | Insufficient permissions | Verify you have Contributor on the target subscription |

## Next Steps

1. **Configure dbt**: Edit `domains/shared/dbt/profiles.yml` with your Databricks connection
2. **Set up ADF pipelines**: Import pipeline definitions from `domains/shared/pipelines/adf/`
3. **Apply RBAC**: Run `governance/rbac/apply-rbac.ps1` to set up access control
4. **Data Quality**: Configure `governance/dataquality/quality-rules.yaml` for your tables
