# CSA-in-a-Box — Terraform / OpenTofu IaC

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** DevOps Engineers

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Module Patterns](#module-patterns)
- [Environment Configuration](#environment-configuration)
- [State Management](#state-management)
- [CI/CD Integration](#cicd-integration)
- [Comparison with Bicep Path](#comparison-with-bicep-path)
- [Migration Guide (Bicep → Terraform)](#migration-guide-bicep--terraform)
- [OpenTofu Compatibility](#opentofu-compatibility)

Terraform alternative to the Bicep IaC at `deploy/bicep/`. Deploys the **Data Landing Zone (DLZ)** and **Data Management Landing Zone (DMLZ)** for the Cloud Scale Analytics platform.

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Terraform / OpenTofu | >= 1.6 | Infrastructure provisioning |
| Azure CLI | >= 2.50 | Authentication & state storage setup |
| azurerm provider | ~> 4.0 | Azure Resource Manager |

**Authentication:** Use `az login` or a service principal with `ARM_*` environment variables.

## Quick Start

### 1. Create State Storage

```bash
# Create resource group and storage for Terraform state
az group create -n rg-terraform-state -l eastus2
az storage account create -n stterraformstate -g rg-terraform-state \
  -l eastus2 --sku Standard_LRS
az storage container create -n tfstate --account-name stterraformstate
```

### 2. Deploy DMLZ (Data Management Landing Zone)

```bash
cd deploy/terraform/dmlz

terraform init \
  -backend-config="resource_group_name=rg-terraform-state" \
  -backend-config="storage_account_name=stterraformstate" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=csa-inabox/dmlz/terraform.tfstate"

terraform plan \
  -var="subscription_id=<YOUR_SUBSCRIPTION_ID>" \
  -var="location=eastus2" \
  -var-file="../environments/dev.tfvars" \
  -out=dmlz.tfplan

terraform apply dmlz.tfplan
```

### 3. Deploy DLZ (Data Landing Zone)

```bash
cd deploy/terraform/dlz

terraform init \
  -backend-config="resource_group_name=rg-terraform-state" \
  -backend-config="storage_account_name=stterraformstate" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=csa-inabox/dlz/terraform.tfstate"

# Wire DMLZ outputs → DLZ inputs
terraform plan \
  -var="subscription_id=<YOUR_SUBSCRIPTION_ID>" \
  -var="location=eastus2" \
  -var-file="../environments/dev.tfvars" \
  -var="log_analytics_workspace_id=<FROM_DMLZ_OUTPUT>" \
  -var="private_endpoint_subnet_id=<FROM_DMLZ_OUTPUT>" \
  -out=dlz.tfplan

terraform apply dlz.tfplan
```

## Architecture

```text
deploy/terraform/
├── versions.tf            # Root provider version constraints
├── modules/               # Reusable modules (one per Azure service)
│   ├── storage/           # Data Lake Gen2 + lifecycle + blob properties
│   ├── cosmosdb/          # Cosmos DB SQL API with geo-replication
│   ├── eventhubs/         # Event Hubs namespace + hubs + consumer groups
│   ├── keyvault/          # Key Vault with RBAC, soft-delete, purge protection
│   ├── databricks/        # Databricks Premium with VNet injection
│   ├── synapse/           # Synapse Analytics with managed VNet
│   ├── datafactory/       # Data Factory with managed VNet + auto-resolve IR
│   ├── machinelearning/   # AML workspace with managed network
│   ├── dataexplorer/      # Kusto cluster + databases
│   ├── functions/         # Function App (Linux/Windows) + App Service Plan
│   ├── streamanalytics/   # Stream Analytics jobs
│   ├── monitoring/        # Log Analytics + Application Insights
│   ├── networking/        # VNets, subnets, NSGs, peering, private DNS
│   ├── security/          # CMK identity + Key Vault key + RBAC
│   └── governance/        # Purview + Kafka integration
├── dlz/                   # DLZ orchestrator (calls all data service modules)
├── dmlz/                  # DMLZ orchestrator (networking, monitoring, governance)
└── environments/          # Per-environment variable files
    ├── dev.tfvars         # Development (small SKUs, no CMK, no locks)
    ├── prod.tfvars        # Production (large SKUs, CMK, locks, geo-redundant)
    └── template.tfvars    # Annotated template with all variables
```

### Module Dependency Flow

```text
DMLZ (deploy first)
├── networking    → VNets, subnets, private DNS zones
├── monitoring    → Log Analytics workspace
├── keyvault      → Key Vault for secrets & CMK keys
├── security      → CMK identity + encryption key
├── governance    → Purview catalog
└── databricks    → Governance/Unity Catalog workspace

DLZ (deploy second, consumes DMLZ outputs)
├── storage       → Data Lake Gen2 (raw/curated/workspace)
├── cosmosdb      → Operational data store
├── synapse       → SQL analytics (references storage)
├── databricks    → Compute workspace
├── datafactory   → ETL/ELT orchestration
├── eventhubs     → Event ingestion
├── dataexplorer  → Real-time analytics
├── machinelearning → ML workspaces (references storage, KV, AppInsights)
├── functions     → Serverless compute
├── streamanalytics → Stream processing
└── monitoring    → Application Insights
```

## Module Patterns

Every module follows these consistent patterns, mirroring the Bicep modules:

| Pattern | Implementation |
|---------|---------------|
| **Private Endpoints** | `azurerm_private_endpoint` with `dynamic "private_dns_zone_group"` |
| **Diagnostic Settings** | `azurerm_monitor_diagnostic_setting` conditional on `log_analytics_workspace_id` |
| **Resource Locks** | `azurerm_management_lock` (CanNotDelete) conditional on `enable_resource_lock` |
| **CMK Encryption** | `dynamic` blocks + conditional `identity_ids` for UserAssigned |
| **Managed Identity** | SystemAssigned default; SystemAssigned+UserAssigned when CMK enabled |
| **Tags Propagation** | Tags variable on every module, merged at orchestrator level |

### Bicep → Terraform Variable Mapping

| Bicep Parameter | Terraform Variable | Type |
|----------------|-------------------|------|
| `parEnableCmk` | `enable_cmk` | `bool` |
| `enableResourceLock` | `enable_resource_lock` | `bool` |
| `logAnalyticsWorkspaceId` | `log_analytics_workspace_id` | `string` |
| `parCmkKeyVaultUri` | `cmk_key_vault_key_id` | `string` |
| `parCmkIdentityId` | `cmk_identity_id` | `string` |
| `privateEndpointSubnets` | `private_endpoints` | `list(object)` |
| `privateDnsZoneId` | `private_dns_zone_id` | `string` |

## Environment Configuration

### Development (`dev.tfvars`)
- **SKUs:** Smallest available (Dev SKU for ADX, Y1 for Functions)
- **CMK:** Disabled
- **Resource Locks:** Disabled
- **Storage:** LRS replication
- **Modules:** Only core services (storage, cosmos, monitoring)

### Production (`prod.tfvars`)
- **SKUs:** Production-grade
- **CMK:** Enabled (requires DMLZ security module)
- **Resource Locks:** Enabled on all resources
- **Storage:** RAGZRS (read-access geo-zone-redundant)
- **Modules:** All services enabled

### Custom Environment
```bash
cp environments/template.tfvars environments/staging.tfvars
# Edit staging.tfvars with your values
terraform plan -var-file="../environments/staging.tfvars"
```

## State Management

State is stored in Azure Blob Storage with the following layout:

| Landing Zone | State Key |
|-------------|-----------|
| DMLZ | `csa-inabox/dmlz/terraform.tfstate` |
| DLZ | `csa-inabox/dlz/terraform.tfstate` |

### State Locking

Azure Blob Storage provides automatic state locking via blob leases. No additional configuration needed.

### State Migration from Bicep

If migrating from existing Bicep deployments:

```bash
# Import existing resources into Terraform state
terraform import 'module.storage[0].azurerm_storage_account.this' \
  /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<name>

# Repeat for each resource, then plan to verify no changes
terraform plan -var-file="../environments/prod.tfvars"
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Terraform DLZ
on:
  push:
    branches: [main]
    paths: ['deploy/terraform/**']

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.6.0
      - name: Terraform Init
        working-directory: deploy/terraform/dlz
        run: terraform init -backend-config=...
        env:
          ARM_CLIENT_ID: ${{ secrets.ARM_CLIENT_ID }}
          ARM_CLIENT_SECRET: ${{ secrets.ARM_CLIENT_SECRET }}
          ARM_SUBSCRIPTION_ID: ${{ secrets.ARM_SUBSCRIPTION_ID }}
          ARM_TENANT_ID: ${{ secrets.ARM_TENANT_ID }}
      - name: Terraform Plan
        working-directory: deploy/terraform/dlz
        run: terraform plan -var-file="../environments/prod.tfvars" -out=plan.tfplan
```

### Azure DevOps

```yaml
trigger:
  paths:
    include:
      - deploy/terraform/*

pool:
  vmImage: ubuntu-latest

steps:
  - task: TerraformInstaller@1
    inputs:
      terraformVersion: '1.6.0'
  - task: TerraformTaskV4@4
    inputs:
      command: init
      workingDirectory: deploy/terraform/dlz
      backendServiceArm: 'AzureServiceConnection'
      backendAzureRmResourceGroupName: 'rg-terraform-state'
      backendAzureRmStorageAccountName: 'stterraformstate'
      backendAzureRmContainerName: 'tfstate'
      backendAzureRmKey: 'csa-inabox/dlz/terraform.tfstate'
```

## Comparison with Bicep Path

| Aspect | Bicep (`deploy/bicep/`) | Terraform (`deploy/terraform/`) |
|--------|------------------------|--------------------------------|
| State | ARM deployment history | Azure Blob Storage |
| Modules | Per-service `.bicep` files | Per-service `main.tf`/`variables.tf`/`outputs.tf` |
| Conditionals | `if (bool(...))` | `count` / `for_each` / `dynamic` blocks |
| Parameters | `.bicepparam` / JSON | `.tfvars` files |
| Type System | Object params | Typed `variable` blocks with validation |
| Scope | Subscription-scoped deployments | Provider-scoped with explicit RG creation |
| Secrets | Key Vault references in params | `sensitive = true` + external secret stores |
| CMK Pattern | Conditional `encryption` blocks | `dynamic` blocks with `for_each = var.enable_cmk ? [1] : []` |

## Migration Guide (Bicep → Terraform)

### Step 1: Deploy Terraform State Storage
Create the storage account for Terraform state (see Quick Start above).

### Step 2: Import Existing Resources
For each resource deployed by Bicep, import it into Terraform state:

```bash
# List existing resources
az resource list -g rg-dlz-dev-storage-eastus2 --query "[].id" -o tsv

# Import each resource
terraform import 'module.storage[0].azurerm_storage_account.this' <resource-id>
```

### Step 3: Verify with Plan
Run `terraform plan` to ensure Terraform sees no drift from the imported state.

### Step 4: Switch Deployment Pipeline
Update your CI/CD pipeline to use Terraform commands instead of `az deployment sub create`.

### Step 5: Decommission Bicep Deployments
After verifying Terraform manages all resources correctly, archive the Bicep deployment history.

## OpenTofu Compatibility

This codebase is fully compatible with [OpenTofu](https://opentofu.org/) >= 1.6. Replace `terraform` with `tofu` in all commands:

```bash
tofu init
tofu plan -var-file="../environments/dev.tfvars"
tofu apply
```

---

## Related Documentation

- [IaC & CI/CD Best Practices](../../docs/IaC-CICD-Best-Practices.md) - Deployment pipeline guidance
- [Government Deployment Templates](../bicep/gov/README.md) - Azure Government deployment path
- [Architecture Overview](../../docs/ARCHITECTURE.md) - Platform architecture reference
