# 📦 Tutorial 3: Data Lake Setup and Configuration

![Tutorial](https://img.shields.io/badge/Tutorial-03_Data_Lake_Setup-blue)
![Duration](https://img.shields.io/badge/Duration-20_minutes-green)
![Level](https://img.shields.io/badge/Level-Beginner-brightgreen)

__Design and implement a scalable Data Lake structure using Azure Data Lake Storage Gen2. Learn best practices for organizing data, configuring linked services, and setting up access controls for analytics workloads.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Design folder structures__ following data lakehouse best practices
- ✅ __Create and configure__ Azure Data Lake Storage Gen2 containers
- ✅ __Set up linked services__ to connect Synapse with data sources
- ✅ __Configure access policies__ using RBAC and ACLs
- ✅ __Implement storage tiers__ for cost-optimized data management

## ⏱️ Time Estimate: 20 minutes

- __Storage Structure Design__: 5 minutes
- __Container Creation__: 5 minutes
- __Linked Services__: 5 minutes
- __Access Configuration__: 5 minutes

## 📋 Prerequisites

### __Required Resources__

- [ ] __Completed Tutorial 2__: Synapse workspace configured and accessible
- [ ] __Storage account__: ADLS Gen2 account with hierarchical namespace
- [ ] __Synapse workspace__: With managed identity enabled
- [ ] __Configuration files__: `naming-convention.json` and `workspace-configuration.md`

### __Required Permissions__

- [ ] __Storage Blob Data Contributor__ on storage account
- [ ] __Synapse Contributor__ role in workspace
- [ ] __Ability to create__ linked services

## 🏗️ Step 1: Design Data Lake Structure

### __1.1 Data Lake Architecture Pattern__

Implement the medallion architecture for data organization:

```
synapse-data/                    # Default container from Tutorial 2
├── raw/                         # Bronze layer - ingested data
│   ├── sales/
│   │   ├── year=2024/
│   │   │   └── month=01/
│   │   │       └── data.parquet
│   ├── customers/
│   └── products/
├── curated/                     # Silver layer - validated and cleaned
│   ├── sales/
│   ├── customers/
│   └── products/
├── enriched/                    # Gold layer - business-ready aggregates
│   ├── customer_360/
│   ├── sales_metrics/
│   └── product_analytics/
├── staging/                     # Temporary processing area
└── archive/                     # Historical data retention
```

### __1.2 Define Folder Structure__

Create structure definition for automation:

```powershell
# Load naming convention
$naming = Get-Content "naming-convention.json" | ConvertFrom-Json

# Define data lake structure
$dataLakeStructure = @{
    'RootContainer' = 'synapse-data'
    'Layers' = @(
        @{
            'Name' = 'raw'
            'Description' = 'Bronze layer - ingested raw data'
            'Folders' = @('sales', 'customers', 'products', 'transactions')
        },
        @{
            'Name' = 'curated'
            'Description' = 'Silver layer - cleaned and validated data'
            'Folders' = @('sales', 'customers', 'products', 'transactions')
        },
        @{
            'Name' = 'enriched'
            'Description' = 'Gold layer - business aggregates'
            'Folders' = @('customer_360', 'sales_metrics', 'product_analytics')
        },
        @{
            'Name' = 'staging'
            'Description' = 'Temporary processing workspace'
            'Folders' = @()
        },
        @{
            'Name' = 'archive'
            'Description' = 'Historical data retention'
            'Folders' = @()
        }
    )
}

# Save structure definition
$dataLakeStructure | ConvertTo-Json -Depth 4 | Out-File "data-lake-structure.json" -Encoding UTF8
Write-Host "✅ Data lake structure defined and saved" -ForegroundColor Green
```

### __1.3 Naming Conventions__

Establish consistent naming patterns:

```powershell
$namingStandards = @"
# Data Lake Naming Standards

## File Naming
- **Format**: `{source}_{entity}_{date}_{version}.{format}`
- **Example**: `salesforce_customers_20240115_v1.parquet`

## Folder Naming
- **Partitions**: Use Hive-style partitioning
  - Format: `column=value`
  - Example: `year=2024/month=01/day=15`

- **Layers**: Use singular lowercase names
  - Bronze: `raw/`
  - Silver: `curated/`
  - Gold: `enriched/`

## Container Naming
- **Pattern**: `{purpose}-{environment}`
- **Examples**:
  - `synapse-data` (default workspace data)
  - `external-sources` (external data sources)
  - `archive-historical` (long-term retention)
"@

$namingStandards | Out-File "data-lake-naming-standards.md" -Encoding UTF8
Write-Host "✅ Naming standards documented" -ForegroundColor Green
```

## 📁 Step 2: Create Storage Containers

### __2.1 Create Additional Containers__

Set up containers for different data purposes:

```powershell
# Get storage account key for container operations
$storageKey = az storage account keys list \
  --account-name $naming.StorageAccount \
  --resource-group $naming.ResourceGroupName \
  --query "[0].value" \
  --output tsv

# Note: synapse-data container already exists from Tutorial 2

# Create external sources container
az storage fs create \
  --name "external-sources" \
  --account-name $naming.StorageAccount \
  --account-key $storageKey

Write-Host "✅ Container created: external-sources" -ForegroundColor Green

# Create archive container with Cool access tier
az storage fs create \
  --name "archive-historical" \
  --account-name $naming.StorageAccount \
  --account-key $storageKey

Write-Host "✅ Container created: archive-historical" -ForegroundColor Green

# List all containers
Write-Host "`n📦 Storage Containers:" -ForegroundColor Cyan
az storage fs list \
  --account-name $naming.StorageAccount \
  --account-key $storageKey \
  --output table
```

### __2.2 Create Folder Structure__

Build the medallion architecture folders:

```powershell
# Function to create directory structure
function New-DataLakeDirectory {
    param(
        [string]$Container,
        [string]$Path,
        [string]$StorageAccount,
        [string]$StorageKey
    )

    az storage fs directory create \
        --file-system $Container \
        --name $Path \
        --account-name $StorageAccount \
        --account-key $StorageKey \
        --output none
}

Write-Host "🏗️ Creating data lake folder structure..." -ForegroundColor Cyan

# Create layers in synapse-data container
$layers = @('raw', 'curated', 'enriched', 'staging', 'archive')
foreach ($layer in $layers) {
    New-DataLakeDirectory -Container "synapse-data" -Path $layer `
        -StorageAccount $naming.StorageAccount -StorageKey $storageKey
    Write-Host "  ✅ Created: /$layer" -ForegroundColor Green
}

# Create entity folders in each layer (except staging and archive)
$entities = @('sales', 'customers', 'products', 'transactions')
foreach ($entity in $entities) {
    # Raw layer
    New-DataLakeDirectory -Container "synapse-data" -Path "raw/$entity" `
        -StorageAccount $naming.StorageAccount -StorageKey $storageKey

    # Curated layer
    New-DataLakeDirectory -Container "synapse-data" -Path "curated/$entity" `
        -StorageAccount $naming.StorageAccount -StorageKey $storageKey

    Write-Host "  ✅ Created entity folders: $entity" -ForegroundColor Green
}

# Create gold layer aggregates
$aggregates = @('customer_360', 'sales_metrics', 'product_analytics')
foreach ($aggregate in $aggregates) {
    New-DataLakeDirectory -Container "synapse-data" -Path "enriched/$aggregate" `
        -StorageAccount $naming.StorageAccount -StorageKey $storageKey
    Write-Host "  ✅ Created aggregate folder: $aggregate" -ForegroundColor Green
}

Write-Host "`n✅ Data lake folder structure created successfully" -ForegroundColor Green
```

### __2.3 Verify Structure__

Confirm folder hierarchy is correct:

```powershell
# List directory structure
Write-Host "`n📂 Data Lake Directory Structure:" -ForegroundColor Cyan

az storage fs directory list \
  --file-system "synapse-data" \
  --account-name $naming.StorageAccount \
  --account-key $storageKey \
  --output table | Select-Object -First 20

Write-Host "`n💡 Tip: Explore full structure in Azure Storage Explorer or Synapse Studio" -ForegroundColor Yellow
```

## 🔗 Step 3: Configure Linked Services

### __3.1 Understand Linked Services__

Linked services define connections to data sources:

| Service Type | Use Case | Authentication |
|--------------|----------|----------------|
| __Azure Data Lake Storage Gen2__ | Primary data lake | Managed Identity |
| __Azure Blob Storage__ | External data sources | Account Key or Managed Identity |
| __Azure SQL Database__ | Relational data sources | SQL Auth or Managed Identity |
| __Azure Key Vault__ | Secrets management | Managed Identity |
| __REST API__ | External APIs | Various methods |

### __3.2 Create ADLS Gen2 Linked Service__

Configure linked service using managed identity:

```powershell
# Create linked service JSON definition
$linkedServiceDef = @"
{
  "name": "AzureDataLakeStorage_Default",
  "properties": {
    "type": "AzureBlobFS",
    "typeProperties": {
      "url": "https://$($naming.StorageAccount).dfs.core.windows.net"
    },
    "connectVia": {
      "referenceName": "AutoResolveIntegrationRuntime",
      "type": "IntegrationRuntimeReference"
    },
    "annotations": []
  }
}
"@

$linkedServiceDef | Out-File "linkedservice-adls.json" -Encoding UTF8

# Create linked service using Synapse CLI
az synapse linked-service create \
  --workspace-name $naming.SynapseWorkspace \
  --name "AzureDataLakeStorage_Default" \
  --file linkedservice-adls.json

Write-Host "✅ ADLS Gen2 linked service created" -ForegroundColor Green
```

> __💡 Note__: The default linked service to the workspace storage account is automatically created. This step demonstrates how to create additional linked services.

### __3.3 Create Linked Service in Synapse Studio__

For visual configuration:

```markdown
**Configuration Steps in Synapse Studio**:

1. **Navigate to Manage Hub**:
   - Open Synapse Studio
   - Click Manage icon in left navigation
   - Select "Linked services"

2. **Create New Linked Service**:
   - Click "+ New" button
   - Search for "Azure Data Lake Storage Gen2"
   - Click tile to select

3. **Configure Connection**:
   - Name: `AzureDataLakeStorage_External`
   - Account selection method: `From Azure subscription`
   - Subscription: Select your subscription
   - Storage account name: Select storage account
   - Authentication: `Managed Identity`
   - Test connection: Click "Test connection"

4. **Save and Publish**:
   - Click "Create" to save
   - Click "Publish all" to deploy

**Screenshot Description**: Linked service configuration panel showing:
- Name field with "AzureDataLakeStorage_External"
- Azure subscription dropdown with active subscription selected
- Storage account dropdown with ADLS Gen2 account
- Authentication type set to "Managed Identity"
- "Test connection" button with green success indicator
- "Create" and "Cancel" buttons at bottom
```

### __3.4 Create Azure Key Vault Linked Service__

Set up secure credential storage:

```powershell
# First, create a Key Vault if not exists
$keyVaultName = $naming.KeyVault

# Check if Key Vault exists
$kvExists = az keyvault show --name $keyVaultName --resource-group $naming.ResourceGroupName 2>$null

if (-not $kvExists) {
    # Create Key Vault
    az keyvault create \
      --name $keyVaultName \
      --resource-group $naming.ResourceGroupName \
      --location $naming.Location \
      --enable-soft-delete true \
      --retention-days 90 \
      --tags Project=SynapseTutorial Environment=Learning

    Write-Host "✅ Key Vault created: $keyVaultName" -ForegroundColor Green

    # Grant workspace managed identity access to Key Vault
    $workspaceMI = az synapse workspace show \
      --name $naming.SynapseWorkspace \
      --resource-group $naming.ResourceGroupName \
      --query identity.principalId \
      --output tsv

    az keyvault set-policy \
      --name $keyVaultName \
      --object-id $workspaceMI \
      --secret-permissions get list

    Write-Host "✅ Key Vault access granted to workspace managed identity" -ForegroundColor Green
} else {
    Write-Host "✅ Key Vault already exists: $keyVaultName" -ForegroundColor Green
}

# Create Key Vault linked service definition
$kvLinkedServiceDef = @"
{
  "name": "AzureKeyVault_Credentials",
  "properties": {
    "type": "AzureKeyVault",
    "typeProperties": {
      "baseUrl": "https://$keyVaultName.vault.azure.net/"
    },
    "annotations": []
  }
}
"@

$kvLinkedServiceDef | Out-File "linkedservice-keyvault.json" -Encoding UTF8

# Create linked service
az synapse linked-service create \
  --workspace-name $naming.SynapseWorkspace \
  --name "AzureKeyVault_Credentials" \
  --file linkedservice-keyvault.json

Write-Host "✅ Key Vault linked service created" -ForegroundColor Green
```

### __3.5 Verify Linked Services__

List all configured linked services:

```powershell
Write-Host "`n🔗 Configured Linked Services:" -ForegroundColor Cyan
az synapse linked-service list \
  --workspace-name $naming.SynapseWorkspace \
  --output table

# Test linked service connectivity
Write-Host "`n🧪 Testing Linked Service Connectivity..." -ForegroundColor Cyan
Write-Host "  Open Synapse Studio → Manage → Linked services" -ForegroundColor Yellow
Write-Host "  Click on each linked service" -ForegroundColor Yellow
Write-Host "  Click 'Test connection' button" -ForegroundColor Yellow
Write-Host "  Verify 'Connection successful' message" -ForegroundColor Yellow
```

## 🔐 Step 4: Configure Access Controls

### __4.1 Implement RBAC for Containers__

Set up role-based access control:

```powershell
Write-Host "🔐 Configuring Container Access Controls..." -ForegroundColor Cyan

# Get current user and workspace managed identity
$currentUser = az ad signed-in-user show --query id -o tsv
$workspaceMI = az synapse workspace show \
  --name $naming.SynapseWorkspace \
  --resource-group $naming.ResourceGroupName \
  --query identity.principalId \
  --output tsv

# Storage account scope for role assignments
$storageScope = "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$($naming.ResourceGroupName)/providers/Microsoft.Storage/storageAccounts/$($naming.StorageAccount)"

# Assign Storage Blob Data Contributor to current user (if not already assigned)
az role assignment create \
  --role "Storage Blob Data Contributor" \
  --assignee $currentUser \
  --scope $storageScope \
  2>$null

Write-Host "✅ Current user granted Storage Blob Data Contributor" -ForegroundColor Green

# Verify managed identity has access (should be assigned in Tutorial 2)
$miRoleAssignment = az role assignment list \
  --assignee $workspaceMI \
  --scope $storageScope \
  --role "Storage Blob Data Contributor" \
  --output tsv

if ($miRoleAssignment) {
    Write-Host "✅ Workspace managed identity has Storage Blob Data Contributor" -ForegroundColor Green
} else {
    Write-Host "⚠️ Assigning Storage Blob Data Contributor to workspace managed identity" -ForegroundColor Yellow
    az role assignment create \
      --role "Storage Blob Data Contributor" \
      --assignee $workspaceMI \
      --scope $storageScope
}
```

### __4.2 Configure ACLs for Fine-Grained Control__

Set up folder-level permissions:

```powershell
# Note: ACL configuration requires storage account key or user delegation SAS

Write-Host "`n🔒 Configuring Folder ACLs..." -ForegroundColor Cyan

# Set ACLs on raw folder (read/write for workspace MI)
az storage fs access set \
  --acl "user::rwx,user:${workspaceMI}:rwx,group::r-x,other::---" \
  --path "raw" \
  --file-system "synapse-data" \
  --account-name $naming.StorageAccount \
  --auth-mode login

Write-Host "✅ ACLs configured for /raw folder" -ForegroundColor Green

# Set ACLs on curated folder
az storage fs access set \
  --acl "user::rwx,user:${workspaceMI}:rwx,group::r-x,other::---" \
  --path "curated" \
  --file-system "synapse-data" \
  --account-name $naming.StorageAccount \
  --auth-mode login

Write-Host "✅ ACLs configured for /curated folder" -ForegroundColor Green

# Set ACLs on enriched folder (read-only for broader access)
az storage fs access set \
  --acl "user::rwx,user:${workspaceMI}:r-x,group::r-x,other::---" \
  --path "enriched" \
  --file-system "synapse-data" \
  --account-name $naming.StorageAccount \
  --auth-mode login

Write-Host "✅ ACLs configured for /enriched folder (read-only)" -ForegroundColor Green
```

### __4.3 Document Access Policy__

Create access control documentation:

```powershell
$accessPolicy = @"
# Data Lake Access Control Policy

## RBAC Assignments (Storage Account Level)

| Principal | Role | Scope | Justification |
|-----------|------|-------|---------------|
| Current User | Storage Blob Data Contributor | Storage Account | Development and testing |
| Workspace Managed Identity | Storage Blob Data Contributor | Storage Account | Spark/SQL access to all data |

## ACL Configuration (Folder Level)

### Raw Layer (`/raw`)
- **Purpose**: Ingested raw data storage
- **Access**: Read/Write for workspace MI, Read for group
- **ACL**: `user::rwx,user:{MI}:rwx,group::r-x,other::---`

### Curated Layer (`/curated`)
- **Purpose**: Cleaned and validated data
- **Access**: Read/Write for workspace MI, Read for group
- **ACL**: `user::rwx,user:{MI}:rwx,group::r-x,other::---`

### Enriched Layer (`/enriched`)
- **Purpose**: Business-ready aggregated data
- **Access**: Read-only for workspace MI and group
- **ACL**: `user::rwx,user:{MI}:r-x,group::r-x,other::---`

## Best Practices

1. **Principle of Least Privilege**: Grant minimum required permissions
2. **Use Managed Identity**: Prefer MI over keys/SAS for service authentication
3. **Segregate by Layer**: Different access levels per medallion layer
4. **Audit Regularly**: Review access logs and role assignments quarterly
5. **Document Changes**: Maintain changelog of access modifications
"@

$accessPolicy | Out-File "data-lake-access-policy.md" -Encoding UTF8
Write-Host "✅ Access control policy documented" -ForegroundColor Green
```

## 💾 Step 5: Configure Storage Tiers and Lifecycle

### __5.1 Understand Storage Tiers__

Storage tier selection impacts cost and performance:

| Tier | Use Case | Cost | Access Latency |
|------|----------|------|----------------|
| __Hot__ | Frequently accessed data (< 30 days) | High storage, low access | Milliseconds |
| __Cool__ | Infrequently accessed (30-90 days) | Medium storage, medium access | Milliseconds |
| __Archive__ | Rarely accessed (> 90 days) | Low storage, high access | Hours |

### __5.2 Set Up Lifecycle Management__

Configure automatic data tiering:

```powershell
# Create lifecycle management policy
$lifecyclePolicy = @"
{
  "rules": [
    {
      "enabled": true,
      "name": "MoveRawToCool",
      "type": "Lifecycle",
      "definition": {
        "actions": {
          "baseBlob": {
            "tierToCool": {
              "daysAfterModificationGreaterThan": 30
            }
          }
        },
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["synapse-data/raw/"]
        }
      }
    },
    {
      "enabled": true,
      "name": "ArchiveOldData",
      "type": "Lifecycle",
      "definition": {
        "actions": {
          "baseBlob": {
            "tierToArchive": {
              "daysAfterModificationGreaterThan": 90
            }
          }
        },
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["synapse-data/archive/"]
        }
      }
    },
    {
      "enabled": true,
      "name": "DeleteStagingData",
      "type": "Lifecycle",
      "definition": {
        "actions": {
          "baseBlob": {
            "delete": {
              "daysAfterModificationGreaterThan": 7
            }
          }
        },
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["synapse-data/staging/"]
        }
      }
    }
  ]
}
"@

$lifecyclePolicy | Out-File "lifecycle-policy.json" -Encoding UTF8

# Apply lifecycle management policy
az storage account management-policy create \
  --account-name $naming.StorageAccount \
  --resource-group $naming.ResourceGroupName \
  --policy @lifecycle-policy.json

Write-Host "✅ Lifecycle management policy configured" -ForegroundColor Green
```

### __5.3 Enable Soft Delete__

Configure data protection:

```powershell
# Enable soft delete for blobs (7-day retention)
az storage account blob-service-properties update \
  --account-name $naming.StorageAccount \
  --resource-group $naming.ResourceGroupName \
  --enable-delete-retention true \
  --delete-retention-days 7

# Enable soft delete for containers (7-day retention)
az storage account blob-service-properties update \
  --account-name $naming.StorageAccount \
  --resource-group $naming.ResourceGroupName \
  --enable-container-delete-retention true \
  --container-delete-retention-days 7

Write-Host "✅ Soft delete enabled (7-day retention)" -ForegroundColor Green
```

## ✅ Step 6: Verification and Testing

### __6.1 Validate Storage Structure__

Verify folder hierarchy and permissions:

```powershell
Write-Host "`n🔍 Validating Data Lake Configuration..." -ForegroundColor Cyan

# Test 1: List containers
Write-Host "`n📦 Containers:" -ForegroundColor Yellow
az storage fs list \
  --account-name $naming.StorageAccount \
  --auth-mode login \
  --output table

# Test 2: List root directories in synapse-data
Write-Host "`n📂 Root Directories in synapse-data:" -ForegroundColor Yellow
az storage fs directory list \
  --file-system "synapse-data" \
  --account-name $naming.StorageAccount \
  --auth-mode login \
  --output table

# Test 3: Verify ACLs
Write-Host "`n🔒 ACL Configuration for /raw:" -ForegroundColor Yellow
az storage fs access show \
  --path "raw" \
  --file-system "synapse-data" \
  --account-name $naming.StorageAccount \
  --auth-mode login
```

### __6.2 Test Data Upload__

Upload sample file to verify write access:

```powershell
# Create sample data file
$sampleData = @"
id,name,category,price
1,Product A,Electronics,99.99
2,Product B,Furniture,249.50
3,Product C,Electronics,149.99
"@

$sampleData | Out-File "sample-products.csv" -Encoding UTF8

# Upload to raw layer
az storage fs file upload \
  --file-system "synapse-data" \
  --path "raw/products/sample-products.csv" \
  --source "sample-products.csv" \
  --account-name $naming.StorageAccount \
  --auth-mode login \
  --overwrite

Write-Host "✅ Sample data uploaded to /raw/products/" -ForegroundColor Green

# Verify file exists
az storage fs file show \
  --file-system "synapse-data" \
  --path "raw/products/sample-products.csv" \
  --account-name $naming.StorageAccount \
  --auth-mode login \
  --query "{Name:name, Size:properties.contentLength, LastModified:properties.lastModified}" \
  --output table
```

### __6.3 Test Access from Synapse Studio__

```markdown
**Validation Steps in Synapse Studio**:

1. **Navigate to Data Hub**:
   - Open Synapse Studio
   - Click Data icon in left navigation
   - Expand "Linked" section

2. **Browse Storage Structure**:
   - Expand "Azure Data Lake Storage Gen2"
   - Expand your storage account
   - Expand "synapse-data" container
   - Verify folder structure: raw, curated, enriched, staging, archive

3. **View Sample File**:
   - Navigate to `raw → products → sample-products.csv`
   - Right-click file → "Preview"
   - Verify file contents display correctly

4. **Test Write Access**:
   - Right-click "staging" folder
   - Select "New SQL script" → "Select TOP 100 rows"
   - Verify query editor opens (confirms read access)

**Screenshot Description**: Synapse Studio Data hub showing:
- Left panel: Expanded storage hierarchy with all folders visible
- Middle panel: File list in raw/products showing sample-products.csv
- Right panel: File preview displaying CSV contents with headers and rows
```

## 📊 Step 7: Monitor Storage Usage

### __7.1 View Storage Metrics__

Check storage consumption and transaction costs:

```powershell
Write-Host "`n📊 Storage Account Metrics:" -ForegroundColor Cyan

# Get storage account usage
$storageUsage = az storage account show \
  --name $naming.StorageAccount \
  --resource-group $naming.ResourceGroupName \
  --query "{Name:name, Tier:accessTier, ProvisioningState:provisioningState}" \
  --output json | ConvertFrom-Json

Write-Host "  Account: $($storageUsage.Name)" -ForegroundColor White
Write-Host "  Tier: $($storageUsage.Tier)" -ForegroundColor White
Write-Host "  State: $($storageUsage.ProvisioningState)" -ForegroundColor White

# Get capacity used (requires Azure Monitor)
Write-Host "`n💾 Storage Capacity:" -ForegroundColor Cyan
az monitor metrics list \
  --resource "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$($naming.ResourceGroupName)/providers/Microsoft.Storage/storageAccounts/$($naming.StorageAccount)" \
  --metric "UsedCapacity" \
  --output table
```

### __7.2 Set Up Cost Alerts__

Configure budget alerts for storage costs:

```powershell
# Create storage-specific budget alert
az consumption budget create \
  --budget-name "storage-tutorial-budget" \
  --amount 50 \
  --time-grain Monthly \
  --start-date "$(Get-Date -Format 'yyyy-MM-01')" \
  --end-date "$(Get-Date -Year $((Get-Date).Year + 1) -Format 'yyyy-MM-01')" \
  --resource-group-filter $naming.ResourceGroupName

Write-Host "✅ Storage budget alert configured ($50/month)" -ForegroundColor Green
```

## 🎯 Step 8: Documentation and Best Practices

### __8.1 Create Operations Runbook__

Document data lake operations:

```powershell
$operationsRunbook = @"
# Data Lake Operations Runbook

## Daily Operations

### Data Ingestion
\`\`\`powershell
# Upload files to raw layer
az storage fs file upload \
  --file-system "synapse-data" \
  --path "raw/{entity}/{filename}" \
  --source "{local-file}" \
  --account-name "$($naming.StorageAccount)" \
  --auth-mode login
\`\`\`

### Data Quality Checks
- Verify file upload completion
- Check file sizes against expected ranges
- Validate file formats and schemas

## Weekly Operations

### Storage Cleanup
\`\`\`powershell
# Remove old staging files (> 7 days)
# Note: Automated via lifecycle policy
\`\`\`

### Access Review
- Review role assignments
- Audit access logs
- Remove unnecessary permissions

## Monthly Operations

### Cost Review
- Analyze storage tier distribution
- Review lifecycle policy effectiveness
- Identify optimization opportunities

### Capacity Planning
- Monitor storage growth trends
- Forecast capacity needs
- Plan for scaling

## Incident Response

### Access Denied Errors
1. Verify RBAC role assignments
2. Check ACL permissions
3. Confirm managed identity configuration
4. Review firewall rules

### Data Loss Prevention
1. Check soft delete enabled
2. Verify backup retention settings
3. Test restore procedures
4. Document recovery steps
"@

$operationsRunbook | Out-File "data-lake-operations-runbook.md" -Encoding UTF8
Write-Host "✅ Operations runbook created" -ForegroundColor Green
```

### __8.2 Save Configuration Summary__

```powershell
$configSummary = @"
# Data Lake Configuration Summary
Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

## Storage Account
- **Name**: $($naming.StorageAccount)
- **Resource Group**: $($naming.ResourceGroupName)
- **Location**: $($naming.LocationName)
- **Type**: Azure Data Lake Storage Gen2
- **Hierarchical Namespace**: Enabled

## Containers
1. **synapse-data** (Default workspace data)
   - Tier: Hot
   - Purpose: Main analytics data lake

2. **external-sources** (External data)
   - Tier: Hot
   - Purpose: Data from external systems

3. **archive-historical** (Historical data)
   - Tier: Cool
   - Purpose: Long-term data retention

## Folder Structure (Medallion Architecture)
- **/raw** - Bronze layer (ingested data)
- **/curated** - Silver layer (cleaned data)
- **/enriched** - Gold layer (business aggregates)
- **/staging** - Temporary processing
- **/archive** - Historical retention

## Linked Services
- AzureDataLakeStorage_Default (Managed Identity)
- AzureKeyVault_Credentials (Managed Identity)

## Access Control
- **RBAC**: Storage Blob Data Contributor (User + Workspace MI)
- **ACLs**: Configured per layer with appropriate permissions
- **Soft Delete**: Enabled (7-day retention)

## Lifecycle Management
- Raw data → Cool tier after 30 days
- Archive data → Archive tier after 90 days
- Staging data → Deleted after 7 days

## Next Steps
- Tutorial 4: Batch data ingestion
- Tutorial 5: Streaming data ingestion
- Tutorial 6: Spark pool configuration
"@

$configSummary | Out-File "data-lake-configuration-summary.md" -Encoding UTF8
Write-Host "✅ Configuration summary saved" -ForegroundColor Green
```

## ✅ Checkpoint Validation

Before proceeding to the next tutorial, verify your setup:

### __Validation Checklist__

- [ ] __Storage structure created__ with raw, curated, enriched, staging, archive folders
- [ ] __Multiple containers configured__ for different purposes
- [ ] __Linked services created__ and tested successfully
- [ ] __Access controls configured__ with RBAC and ACLs
- [ ] __Lifecycle management policies__ applied for cost optimization
- [ ] __Sample data uploaded__ and accessible from Synapse Studio
- [ ] __Soft delete enabled__ for data protection
- [ ] __Documentation created__ for operations and configuration

### __Quick Validation Script__

```powershell
Write-Host "🔍 Validating Data Lake Configuration..." -ForegroundColor Cyan

$validationPassed = $true

# Check containers exist
$containers = az storage fs list --account-name $naming.StorageAccount --auth-mode login --output json | ConvertFrom-Json
$requiredContainers = @("synapse-data", "external-sources", "archive-historical")
foreach ($container in $requiredContainers) {
    if ($containers.name -contains $container) {
        Write-Host "✅ Container exists: $container" -ForegroundColor Green
    } else {
        Write-Host "❌ Container missing: $container" -ForegroundColor Red
        $validationPassed = $false
    }
}

# Check folders exist
$folders = az storage fs directory list --file-system "synapse-data" --account-name $naming.StorageAccount --auth-mode login --output json | ConvertFrom-Json
$requiredFolders = @("raw", "curated", "enriched", "staging", "archive")
foreach ($folder in $requiredFolders) {
    if ($folders.name -contains $folder) {
        Write-Host "✅ Folder exists: /$folder" -ForegroundColor Green
    } else {
        Write-Host "❌ Folder missing: /$folder" -ForegroundColor Red
        $validationPassed = $false
    }
}

# Check linked services
$linkedServices = az synapse linked-service list --workspace-name $naming.SynapseWorkspace --output json | ConvertFrom-Json
if ($linkedServices.Count -ge 2) {
    Write-Host "✅ Linked services configured ($($linkedServices.Count) services)" -ForegroundColor Green
} else {
    Write-Host "⚠️ Expected at least 2 linked services" -ForegroundColor Yellow
}

# Final result
if ($validationPassed) {
    Write-Host "`n✅ All validations passed! Ready for Tutorial 4." -ForegroundColor Green
} else {
    Write-Host "`n❌ Some validations failed. Please review and fix issues." -ForegroundColor Red
}
```

## 🎉 Congratulations

You've successfully set up a production-ready Data Lake with:

- ✅ __Medallion architecture__ implemented for data quality progression
- ✅ __Multiple containers__ for different data purposes
- ✅ __Secure access controls__ using RBAC and ACLs
- ✅ __Cost-optimized storage__ with lifecycle management policies
- ✅ __Linked services__ for seamless Synapse integration

## 🚀 What's Next?

__Continue to Tutorial 4__: [Batch Data Ingestion](04-batch-ingestion.md)

In the next tutorial, you'll:

- Create data ingestion pipelines using Copy Activity
- Configure data flows for transformation
- Implement error handling and logging
- Schedule automated data loads

## 💡 Troubleshooting

### __Common Issues and Solutions__

__Issue__: Cannot create folders in storage account

```powershell
# Verify authentication mode
az storage fs directory create \
  --file-system "synapse-data" \
  --name "test-folder" \
  --account-name $naming.StorageAccount \
  --auth-mode login  # Use login instead of account key
```

__Issue__: Linked service test connection fails

```powershell
# Verify managed identity has Storage Blob Data Contributor role
$workspaceMI = az synapse workspace show --name $naming.SynapseWorkspace --resource-group $naming.ResourceGroupName --query identity.principalId -o tsv
az role assignment create \
  --role "Storage Blob Data Contributor" \
  --assignee $workspaceMI \
  --scope "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$($naming.ResourceGroupName)/providers/Microsoft.Storage/storageAccounts/$($naming.StorageAccount)"
# Wait 5-10 minutes for propagation
```

__Issue__: Cannot access storage from Synapse Studio

```powershell
# Verify firewall rules allow Synapse workspace
az synapse workspace firewall-rule list --workspace-name $naming.SynapseWorkspace --resource-group $naming.ResourceGroupName
# Ensure "AllowAllAzureIPs" rule exists (start: 0.0.0.0, end: 0.0.0.0)
```

---

__Tutorial Progress__: 3 of 14 completed
__Next__: [04. Batch Data Ingestion →](04-batch-ingestion.md)
__Time Investment__: 20 minutes ✅

*A well-organized Data Lake is the foundation of successful analytics. Invest time in proper structure and governance.*
