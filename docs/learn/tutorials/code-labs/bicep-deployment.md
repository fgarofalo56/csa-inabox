# 🏗️ Infrastructure as Code with Bicep Lab

![Lab](https://img.shields.io/badge/Lab-Bicep_IaC-blue)
![Duration](https://img.shields.io/badge/Duration-3--4_hours-green)
![Level](https://img.shields.io/badge/Level-Intermediate-orange)
![Interactive](https://img.shields.io/badge/Format-Interactive-orange)

Master Infrastructure as Code using Azure Bicep. Learn to deploy, manage, and version control Azure Synapse Analytics infrastructure with declarative templates and best practices.

## 🎯 Learning Objectives

By completing this lab, you will be able to:

- ✅ **Write Bicep templates** for Azure Synapse and related services
- ✅ **Implement modular architecture** with reusable Bicep modules
- ✅ **Deploy complex environments** using parameter files and CI/CD
- ✅ **Manage infrastructure lifecycle** with versioning and updates
- ✅ **Apply security best practices** in IaC configurations
- ✅ **Troubleshoot deployment issues** and validate infrastructure

## ⏱️ Time Estimate: 3-4 hours

- **Bicep Basics**: 45 minutes
- **Synapse Infrastructure**: 90 minutes
- **Modular Design**: 60 minutes
- **CI/CD Integration**: 45 minutes

## 📋 Prerequisites

### **Knowledge Requirements**

- Understanding of Azure resource management
- Basic familiarity with JSON and ARM templates
- Knowledge of Azure Synapse components
- Experience with command-line tools

### **Technical Requirements**

```bash
# Install Azure CLI
az --version  # Should be 2.50.0 or higher

# Install Bicep CLI
az bicep install
az bicep version  # Should be 0.20.0 or higher

# Install VS Code with Bicep extension
code --install-extension ms-azuretools.vscode-bicep
```

## 🚀 Module 1: Bicep Fundamentals (45 minutes)

### **Exercise 1.1: Your First Bicep Template**

```bicep
// storage-account.bicep
@description('The name of the storage account')
param storageAccountName string

@description('The location for the storage account')
param location string = resourceGroup().location

@description('The SKU for the storage account')
@allowed([
  'Standard_LRS'
  'Standard_GRS'
  'Standard_RAGRS'
  'Premium_LRS'
])
param storageSku string = 'Standard_LRS'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: storageSku
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
output primaryEndpoints object = storageAccount.properties.primaryEndpoints
```

### **Deploy Your First Template**

```bash
# Create resource group
az group create \
  --name rg-bicep-lab \
  --location eastus

# Deploy template
az deployment group create \
  --resource-group rg-bicep-lab \
  --template-file storage-account.bicep \
  --parameters storageAccountName=stbiceplab$RANDOM

# Verify deployment
az storage account list \
  --resource-group rg-bicep-lab \
  --output table
```

### **Exercise 1.2: Using Parameters and Variables**

```bicep
// main.bicep
@description('Environment name')
@allowed([
  'dev'
  'test'
  'prod'
])
param environment string = 'dev'

@description('Application name')
@minLength(3)
@maxLength(10)
param appName string

@description('Location for all resources')
param location string = resourceGroup().location

// Variables for naming conventions
var resourcePrefix = '${appName}-${environment}'
var storageAccountName = toLower('st${appName}${environment}${uniqueString(resourceGroup().id)}')
var tags = {
  Environment: environment
  Application: appName
  ManagedBy: 'Bicep'
  DeploymentDate: utcNow('yyyy-MM-dd')
}

// Storage account for data lake
resource dataLakeStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: environment == 'prod' ? 'Standard_GRS' : 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    isHnsEnabled: true  // Enable hierarchical namespace for Data Lake
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// Create containers
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = [for containerName in ['raw', 'processed', 'curated']: {
  name: '${dataLakeStorage.name}/default/${containerName}'
  properties: {
    publicAccess: 'None'
  }
}]

output dataLakeId string = dataLakeStorage.id
output containerNames array = [for i in range(0, 3): containers[i].name]
```

## 🏛️ Module 2: Azure Synapse Infrastructure (90 minutes)

### **Exercise 2.1: Complete Synapse Workspace**

```bicep
// synapse-workspace.bicep
@description('Synapse workspace name')
param workspaceName string

@description('Location for all resources')
param location string = resourceGroup().location

@description('SQL Administrator username')
param sqlAdministratorLogin string

@description('SQL Administrator password')
@secure()
param sqlAdministratorPassword string

@description('Data Lake Storage account name')
param dataLakeStorageAccountName string

@description('Data Lake container name')
param dataLakeContainerName string = 'synapse'

// Get reference to existing storage account
resource dataLakeStorage 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: dataLakeStorageAccountName
}

// Synapse workspace
resource synapseWorkspace 'Microsoft.Synapse/workspaces@2021-06-01' = {
  name: workspaceName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    defaultDataLakeStorage: {
      accountUrl: dataLakeStorage.properties.primaryEndpoints.dfs
      filesystem: dataLakeContainerName
    }
    sqlAdministratorLogin: sqlAdministratorLogin
    sqlAdministratorLoginPassword: sqlAdministratorPassword
    publicNetworkAccess: 'Enabled'
    managedVirtualNetwork: 'default'
    managedVirtualNetworkSettings: {
      preventDataExfiltration: true
      allowedAadTenantIdsForLinking: []
    }
  }
}

// Firewall rules
resource firewallRules 'Microsoft.Synapse/workspaces/firewallRules@2021-06-01' = {
  parent: synapseWorkspace
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// Spark pool
resource sparkPool 'Microsoft.Synapse/workspaces/bigDataPools@2021-06-01' = {
  parent: synapseWorkspace
  name: 'sparkpool01'
  location: location
  properties: {
    nodeCount: 3
    nodeSizeFamily: 'MemoryOptimized'
    nodeSize: 'Small'
    autoScale: {
      enabled: true
      minNodeCount: 3
      maxNodeCount: 10
    }
    autoPause: {
      enabled: true
      delayInMinutes: 15
    }
    sparkVersion: '3.3'
    dynamicExecutorAllocation: {
      enabled: true
      minExecutors: 1
      maxExecutors: 10
    }
  }
}

// SQL Pool (Optional - uncomment if needed)
/*
resource sqlPool 'Microsoft.Synapse/workspaces/sqlPools@2021-06-01' = {
  parent: synapseWorkspace
  name: 'sqlpool01'
  location: location
  sku: {
    name: 'DW100c'
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: 263882790666240
    createMode: 'Default'
  }
}
*/

output workspaceId string = synapseWorkspace.id
output workspaceName string = synapseWorkspace.name
output sparkPoolId string = sparkPool.id
```

### **Exercise 2.2: Security and Networking**

```bicep
// synapse-security.bicep
param workspaceName string
param location string = resourceGroup().location
param vnetName string
param subnetName string
param keyVaultName string

// Virtual Network
resource vnet 'Microsoft.Network/virtualNetworks@2023-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/16'
      ]
    }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: '10.0.1.0/24'
          serviceEndpoints: [
            {
              service: 'Microsoft.Storage'
            }
            {
              service: 'Microsoft.KeyVault'
            }
            {
              service: 'Microsoft.Sql'
            }
          ]
        }
      }
    ]
  }
}

// Key Vault for secrets
resource keyVault 'Microsoft.KeyVault/vaults@2023-02-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [
        {
          id: vnet.properties.subnets[0].id
        }
      ]
    }
  }
}

// Private endpoint for Synapse
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-05-01' = {
  name: '${workspaceName}-pe'
  location: location
  properties: {
    subnet: {
      id: vnet.properties.subnets[0].id
    }
    privateLinkServiceConnections: [
      {
        name: '${workspaceName}-pe-connection'
        properties: {
          privateLinkServiceId: resourceId('Microsoft.Synapse/workspaces', workspaceName)
          groupIds: [
            'Sql'
            'Dev'
          ]
        }
      }
    ]
  }
}

// Role assignments for managed identity
resource synapseWorkspace 'Microsoft.Synapse/workspaces@2021-06-01' existing = {
  name: workspaceName
}

resource kvSecretUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, synapseWorkspace.id, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: synapseWorkspace.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output vnetId string = vnet.id
output keyVaultId string = keyVault.id
output privateEndpointId string = privateEndpoint.id
```

## 📦 Module 3: Modular Design (60 minutes)

### **Exercise 3.1: Create Reusable Modules**

```bicep
// modules/storage-account.bicep
@description('Storage account name')
param name string

@description('Location')
param location string = resourceGroup().location

@description('SKU')
param sku string = 'Standard_LRS'

@description('Enable hierarchical namespace')
param isDataLake bool = false

@description('Tags')
param tags object = {}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
  }
  kind: 'StorageV2'
  properties: {
    isHnsEnabled: isDataLake
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

output id string = storageAccount.id
output name string = storageAccount.name
output primaryEndpoints object = storageAccount.properties.primaryEndpoints
```

```bicep
// main-modular.bicep
@description('Environment name')
param environment string

@description('Application name')
param appName string

@description('Location')
param location string = resourceGroup().location

var resourcePrefix = '${appName}-${environment}'
var storageAccountName = toLower('st${appName}${environment}${uniqueString(resourceGroup().id)}')

// Use module for storage account
module dataLake './modules/storage-account.bicep' = {
  name: '${resourcePrefix}-datalake-deployment'
  params: {
    name: storageAccountName
    location: location
    sku: environment == 'prod' ? 'Standard_GRS' : 'Standard_LRS'
    isDataLake: true
    tags: {
      Environment: environment
      Application: appName
    }
  }
}

// Use module for Synapse workspace
module synapse './modules/synapse-workspace.bicep' = {
  name: '${resourcePrefix}-synapse-deployment'
  params: {
    workspaceName: '${resourcePrefix}-synapse'
    location: location
    dataLakeStorageAccountName: dataLake.outputs.name
    sqlAdministratorLogin: 'sqladmin'
    sqlAdministratorPassword: 'P@ssw0rd123!'  // Use Key Vault reference in production
  }
  dependsOn: [
    dataLake
  ]
}

output dataLakeId string = dataLake.outputs.id
output synapseWorkspaceId string = synapse.outputs.workspaceId
```

### **Exercise 3.2: Parameter Files**

```json
// parameters.dev.json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "environment": {
      "value": "dev"
    },
    "appName": {
      "value": "csa"
    },
    "location": {
      "value": "eastus"
    }
  }
}
```

```json
// parameters.prod.json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "environment": {
      "value": "prod"
    },
    "appName": {
      "value": "csa"
    },
    "location": {
      "value": "eastus2"
    }
  }
}
```

## 🔄 Module 4: CI/CD Integration (45 minutes)

### **Exercise 4.1: Azure DevOps Pipeline**

```yaml
# azure-pipelines.yml
trigger:
  branches:
    include:
      - main
      - develop
  paths:
    include:
      - infrastructure/**

variables:
  - group: bicep-deployment-variables
  - name: resourceGroupName
    value: 'rg-synapse-$(environment)'

stages:
  - stage: Validate
    displayName: 'Validate Bicep Templates'
    jobs:
      - job: ValidateJob
        displayName: 'Run Bicep Validation'
        pool:
          vmImage: 'ubuntu-latest'
        steps:
          - task: AzureCLI@2
            displayName: 'Build Bicep Files'
            inputs:
              azureSubscription: '$(azureServiceConnection)'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                az bicep build --file infrastructure/main.bicep

          - task: AzureCLI@2
            displayName: 'Validate ARM Template'
            inputs:
              azureSubscription: '$(azureServiceConnection)'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                az deployment group validate \
                  --resource-group $(resourceGroupName) \
                  --template-file infrastructure/main.bicep \
                  --parameters @infrastructure/parameters.$(environment).json

  - stage: Deploy
    displayName: 'Deploy Infrastructure'
    dependsOn: Validate
    condition: succeeded()
    jobs:
      - deployment: DeployJob
        displayName: 'Deploy Bicep Templates'
        environment: $(environment)
        pool:
          vmImage: 'ubuntu-latest'
        strategy:
          runOnce:
            deploy:
              steps:
                - checkout: self

                - task: AzureCLI@2
                  displayName: 'Create Resource Group'
                  inputs:
                    azureSubscription: '$(azureServiceConnection)'
                    scriptType: 'bash'
                    scriptLocation: 'inlineScript'
                    inlineScript: |
                      az group create \
                        --name $(resourceGroupName) \
                        --location $(location)

                - task: AzureCLI@2
                  displayName: 'Deploy Bicep Template'
                  inputs:
                    azureSubscription: '$(azureServiceConnection)'
                    scriptType: 'bash'
                    scriptLocation: 'inlineScript'
                    inlineScript: |
                      az deployment group create \
                        --resource-group $(resourceGroupName) \
                        --template-file infrastructure/main.bicep \
                        --parameters @infrastructure/parameters.$(environment).json \
                        --mode Incremental

                - task: AzureCLI@2
                  displayName: 'Run Post-Deployment Tests'
                  inputs:
                    azureSubscription: '$(azureServiceConnection)'
                    scriptType: 'bash'
                    scriptLocation: 'scriptPath'
                    scriptPath: 'scripts/test-deployment.sh'
```

### **Exercise 4.2: GitHub Actions Workflow**

```yaml
# .github/workflows/deploy-infrastructure.yml
name: Deploy Infrastructure

on:
  push:
    branches: [ main, develop ]
    paths:
      - 'infrastructure/**'
  pull_request:
    branches: [ main ]
    paths:
      - 'infrastructure/**'
  workflow_dispatch:

env:
  AZURE_RESOURCE_GROUP: rg-synapse-${{ github.ref_name }}
  LOCATION: eastus

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Azure Login
        uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Validate Bicep
        run: |
          az bicep build --file infrastructure/main.bicep

      - name: Validate ARM Template
        run: |
          az deployment group validate \
            --resource-group ${{ env.AZURE_RESOURCE_GROUP }} \
            --template-file infrastructure/main.bicep \
            --parameters @infrastructure/parameters.${{ github.ref_name }}.json

  deploy:
    needs: validate
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    environment: ${{ github.ref_name }}
    steps:
      - uses: actions/checkout@v3

      - name: Azure Login
        uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Create Resource Group
        run: |
          az group create \
            --name ${{ env.AZURE_RESOURCE_GROUP }} \
            --location ${{ env.LOCATION }}

      - name: Deploy Infrastructure
        run: |
          az deployment group create \
            --resource-group ${{ env.AZURE_RESOURCE_GROUP }} \
            --template-file infrastructure/main.bicep \
            --parameters @infrastructure/parameters.${{ github.ref_name }}.json \
            --mode Incremental

      - name: Run Tests
        run: |
          bash scripts/test-deployment.sh
```

## ✅ Challenge Projects

### **Challenge 1: Multi-Region Deployment**

```bicep
/*
Create a multi-region Synapse deployment:
1. Primary region with full infrastructure
2. Secondary region for disaster recovery
3. Azure Traffic Manager for failover
4. Geo-replicated storage
5. Automated failover procedures
*/
```

### **Challenge 2: Complete Analytics Platform**

```bicep
/*
Build a complete analytics platform:
1. Data ingestion (Event Hubs, IoT Hub)
2. Processing layer (Synapse, Databricks)
3. Storage layer (Data Lake, Cosmos DB)
4. Serving layer (Power BI, API Management)
5. Monitoring (Application Insights, Log Analytics)
*/
```

## 🎯 Best Practices

### **Security**

- Never commit secrets to source control
- Use Key Vault references for sensitive data
- Implement RBAC with least privilege
- Enable managed identities
- Configure private endpoints

### **Maintainability**

- Use meaningful names and descriptions
- Create reusable modules
- Version your templates
- Document parameters and outputs
- Follow naming conventions

### **Testing**

- Validate templates before deployment
- Use what-if deployments
- Test in non-production first
- Implement automated testing
- Monitor deployment results

## 📚 Additional Resources

- [Bicep Documentation](https://docs.microsoft.com/azure/azure-resource-manager/bicep/)
- [Azure Synapse IaC Samples](https://github.com/Azure/azure-synapse-analytics)
- [Bicep Best Practices](https://docs.microsoft.com/azure/azure-resource-manager/bicep/best-practices)

---

*Lab Version: 1.0*
*Last Updated: January 2025*
*Infrastructure as Code Excellence*
