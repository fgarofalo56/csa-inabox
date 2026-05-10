---
title: "Azure Data Factory Environment Setup"
description: "__Create and configure your Azure Data Factory instance with proper security, networking, and governance settings for production-ready data integration.__"
tags:
  - tutorials
  - data-factory
---
# 🚀 Azure Data Factory Environment Setup

![Tutorial](https://img.shields.io/badge/Tutorial-Environment_Setup-blue)
![Duration](https://img.shields.io/badge/Duration-20_minutes-green)
![Level](https://img.shields.io/badge/Level-Beginner-brightgreen)

__Create and configure your Azure Data Factory instance with proper security, networking, and governance settings for production-ready data integration.__

## 📋 Table of Contents

- [Prerequisites](#prerequisites)
- [Create Data Factory Instance](#create-data-factory-instance)
- [Configure Security](#configure-security)
- [Set Up Networking](#set-up-networking)
- [Configure Git Integration](#configure-git-integration)
- [Install Development Tools](#install-development-tools)
- [Validation](#validation)
- [Next Steps](#next-steps)

## ✅ Prerequisites

Before creating your Data Factory instance, ensure you have:

- [ ] Azure subscription with appropriate permissions
- [ ] Resource group for Data Factory resources
- [ ] Azure CLI or PowerShell installed locally
- [ ] Basic understanding of Azure networking concepts
- [ ] Completed [Module 01: Fundamentals](01-fundamentals.md)

### Required Azure Permissions

| Resource | Required Role | Purpose |
|----------|--------------|---------|
| __Subscription__ | Contributor or Owner | Create resources |
| __Resource Group__ | Contributor | Deploy ADF and dependencies |
| __Azure AD__ | Application Administrator | Create service principals |
| __Key Vault__ | Key Vault Administrator | Manage secrets |

## 🏗️ Create Data Factory Instance

### Option 1: Azure Portal

#### Step 1: Navigate to Data Factory

1. Sign in to [Azure Portal](https://portal.azure.com)
2. Click __Create a resource__
3. Search for "Data Factory"
4. Click __Create__

#### Step 2: Configure Basics

```text
Project Details:
├── Subscription: [Your Subscription]
├── Resource Group: rg-adf-tutorial-dev
├── Region: East US 2

Instance Details:
├── Name: adf-tutorial-dev-001
├── Version: V2
└── Enable public network access: Yes (for now)
```

![Complexity](https://img.shields.io/badge/Complexity-Basic-green)

> **💡 Tip:** Use a naming convention that includes environment, purpose, and instance number.

#### Step 3: Configure Git Configuration (Optional for now)

- Skip Git configuration initially
- We'll configure this in a later step

#### Step 4: Configure Networking

For this tutorial:

- __Enable public access__: Yes
- __Managed Virtual Network__: Disabled (we'll enable later)

> **⚠️ Warning:** In production, always use private endpoints and managed virtual networks.

#### Step 5: Review and Create

1. Review all settings
2. Click __Create__
3. Wait for deployment (2-3 minutes)

### Option 2: Azure CLI

```bash
# Set variables
SUBSCRIPTION_ID="your-subscription-id"
RESOURCE_GROUP="rg-adf-tutorial-dev"
LOCATION="eastus2"
ADF_NAME="adf-tutorial-dev-001"

# Login to Azure
az login

# Set subscription
az account set --subscription $SUBSCRIPTION_ID

# Create resource group
az group create \
  --name $RESOURCE_GROUP \
  --location $LOCATION

# Create Data Factory
az datafactory create \
  --resource-group $RESOURCE_GROUP \
  --factory-name $ADF_NAME \
  --location $LOCATION

# Verify creation
az datafactory show \
  --resource-group $RESOURCE_GROUP \
  --factory-name $ADF_NAME \
  --output table
```

### Option 3: PowerShell

```powershell
# Set variables
$SubscriptionId = "your-subscription-id"
$ResourceGroupName = "rg-adf-tutorial-dev"
$Location = "East US 2"
$DataFactoryName = "adf-tutorial-dev-001"

# Connect to Azure
Connect-AzAccount

# Set subscription context
Set-AzContext -SubscriptionId $SubscriptionId

# Create resource group
New-AzResourceGroup `
  -Name $ResourceGroupName `
  -Location $Location

# Create Data Factory
Set-AzDataFactoryV2 `
  -ResourceGroupName $ResourceGroupName `
  -Location $Location `
  -Name $DataFactoryName

# Verify creation
Get-AzDataFactoryV2 `
  -ResourceGroupName $ResourceGroupName `
  -Name $DataFactoryName
```

### Option 4: ARM Template

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "dataFactoryName": {
      "type": "string",
      "defaultValue": "adf-tutorial-dev-001",
      "metadata": {
        "description": "Name of the Data Factory"
      }
    },
    "location": {
      "type": "string",
      "defaultValue": "[resourceGroup().location]",
      "metadata": {
        "description": "Location for all resources"
      }
    }
  },
  "resources": [
    {
      "type": "Microsoft.DataFactory/factories",
      "apiVersion": "2018-06-01",
      "name": "[parameters('dataFactoryName')]",
      "location": "[parameters('location')]",
      "identity": {
        "type": "SystemAssigned"
      },
      "properties": {
        "publicNetworkAccess": "Enabled"
      }
    }
  ],
  "outputs": {
    "dataFactoryId": {
      "type": "string",
      "value": "[resourceId('Microsoft.DataFactory/factories', parameters('dataFactoryName'))]"
    },
    "dataFactoryIdentityPrincipalId": {
      "type": "string",
      "value": "[reference(resourceId('Microsoft.DataFactory/factories', parameters('dataFactoryName')), '2018-06-01', 'Full').identity.principalId]"
    }
  }
}
```

Deploy the template:

```bash
az deployment group create \
  --resource-group rg-adf-tutorial-dev \
  --template-file adf-template.json \
  --parameters dataFactoryName=adf-tutorial-dev-001
```

## 🔒 Configure Security

### Enable System-Assigned Managed Identity

Managed identities provide automatic credential management for Azure resources.

#### Azure Portal Method

1. Navigate to your Data Factory
2. Click __Managed Identity__ under __Settings__
3. Note the __Object (principal) ID__ for later use
4. Status should show __Enabled__

#### Azure CLI Method

```bash
# Enable system-assigned managed identity
az datafactory update \
  --resource-group $RESOURCE_GROUP \
  --factory-name $ADF_NAME \
  --set identity.type=SystemAssigned

# Get the managed identity principal ID
PRINCIPAL_ID=$(az datafactory show \
  --resource-group $RESOURCE_GROUP \
  --factory-name $ADF_NAME \
  --query identity.principalId \
  --output tsv)

echo "Managed Identity Principal ID: $PRINCIPAL_ID"
```

### Create Azure Key Vault

Store secrets and connection strings securely.

```bash
# Set Key Vault name
KEY_VAULT_NAME="kv-adf-tutorial-dev"

# Create Key Vault
az keyvault create \
  --name $KEY_VAULT_NAME \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --enable-rbac-authorization true

# Grant ADF managed identity access to Key Vault
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee $PRINCIPAL_ID \
  --scope $(az keyvault show --name $KEY_VAULT_NAME --query id --output tsv)
```

### Configure Access Policies

```bash
# Add access policy for your user account
USER_OBJECT_ID=$(az ad signed-in-user show --query id --output tsv)

az keyvault set-policy \
  --name $KEY_VAULT_NAME \
  --object-id $USER_OBJECT_ID \
  --secret-permissions get list set delete
```

### Store Sample Secrets

```bash
# Store sample database connection string
az keyvault secret set \
  --vault-name $KEY_VAULT_NAME \
  --name "sql-connection-string" \
  --value "Server=tcp:myserver.database.windows.net,1433;Database=mydb;"

# Store sample API key
az keyvault secret set \
  --vault-name $KEY_VAULT_NAME \
  --name "api-key" \
  --value "sample-api-key-value"
```

## 🌐 Set Up Networking

### Configure Public Network Access

For development environments:

```bash
# Enable public network access
az datafactory update \
  --resource-group $RESOURCE_GROUP \
  --factory-name $ADF_NAME \
  --public-network-access Enabled
```

### Configure Firewall Rules (Optional)

Restrict access to specific IP addresses:

```bash
# Add firewall rule for your IP
YOUR_IP=$(curl -s ifconfig.me)

az datafactory update \
  --resource-group $RESOURCE_GROUP \
  --factory-name $ADF_NAME \
  --set publicNetworkAccess=Enabled \
  --set restrictInboundNetworkAccess=Enabled \
  --set allowedIpRanges="[\"$YOUR_IP/32\"]"
```

### Enable Managed Virtual Network (Production)

For production environments, enable managed virtual network:

1. Navigate to Data Factory in Azure Portal
2. Click __Managed Virtual Network__ under __Manage__
3. Click __Enable__
4. Configure private endpoints for data sources

## 🔧 Configure Git Integration

### Azure DevOps Repository

#### Prerequisites

- Azure DevOps organization
- Project with Git repository
- Personal Access Token (PAT)

#### Configuration Steps

1. In Azure Portal, navigate to your Data Factory
2. Click __Author & Monitor__ to open ADF Studio
3. Click __Set up code repository__
4. Select __Azure DevOps Git__
5. Configure settings:

```text
Azure DevOps Git Configuration:
├── Repository type: Azure DevOps Git
├── Azure DevOps organization: your-org
├── Project name: adf-tutorial
├── Repository name: adf-tutorial-repo
├── Collaboration branch: main
├── Publish branch: adf_publish
├── Root folder: /
└── Import existing resources: Yes
```

### GitHub Repository

#### Configuration Steps

1. Navigate to ADF Studio
2. Click __Set up code repository__
3. Select __GitHub__
4. Configure settings:

```text
GitHub Configuration:
├── Repository type: GitHub
├── GitHub account: your-account
├── Repository name: adf-tutorial
├── Collaboration branch: main
├── Publish branch: adf_publish
└── Root folder: /
```

> **💡 Tip:** Use separate branches for dev, test, and production environments.

## 🛠️ Install Development Tools

### Azure Data Factory Extension for VS Code

```bash
# Install VS Code extension
code --install-extension ms-azuretools.vscode-azuredatafactory
```

Features:

- Syntax highlighting for ADF JSON
- IntelliSense for ADF properties
- Validation of pipeline definitions
- Integration with Azure DevOps

### Azure PowerShell Module

```powershell
# Install Az.DataFactory module
Install-Module -Name Az.DataFactory -Scope CurrentUser -Force

# Verify installation
Get-Module -Name Az.DataFactory -ListAvailable
```

### Azure CLI Data Factory Extension

```bash
# Azure CLI already includes Data Factory commands
# Verify installation
az datafactory --help
```

## ✅ Validation

### Verify Data Factory Deployment

```bash
# Check Data Factory status
az datafactory show \
  --resource-group $RESOURCE_GROUP \
  --factory-name $ADF_NAME \
  --output table

# List all Data Factories in resource group
az datafactory list \
  --resource-group $RESOURCE_GROUP \
  --output table
```

Expected output:

```text
Name                  Location    ResourceGroup         ProvisioningState
--------------------  ----------  --------------------  -------------------
adf-tutorial-dev-001  eastus2     rg-adf-tutorial-dev   Succeeded
```

### Test Key Vault Integration

```bash
# Verify Key Vault access from ADF managed identity
az keyvault secret show \
  --vault-name $KEY_VAULT_NAME \
  --name "sql-connection-string" \
  --output table
```

### Access ADF Studio

1. Navigate to your Data Factory in Azure Portal
2. Click __Author & Monitor__
3. Verify you can access the ADF Studio interface
4. Check that __Author__, __Monitor__, and __Manage__ tabs are accessible

### Create Test Pipeline

Create a simple pipeline to verify everything works:

1. In ADF Studio, click __Author__ (pencil icon)
2. Click __+__ and select __Pipeline__
3. Name it "TestPipeline"
4. Drag a __Wait__ activity to the canvas
5. Configure wait duration: 5 seconds
6. Click __Debug__ to test
7. Verify the pipeline runs successfully

## 🎯 Configuration Checklist

Before proceeding to the next module:

- [ ] Data Factory instance created and accessible
- [ ] Managed identity enabled
- [ ] Azure Key Vault configured with access granted
- [ ] Networking configured appropriately
- [ ] Git integration configured (optional but recommended)
- [ ] Development tools installed
- [ ] Test pipeline created and executed successfully
- [ ] ADF Studio accessible and responsive

## 📊 Resource Summary

After completing this module, you should have:

| Resource | Purpose | Configuration |
|----------|---------|---------------|
| __Data Factory__ | Core orchestration service | System-assigned identity enabled |
| __Key Vault__ | Secrets management | RBAC-based access control |
| __Managed Identity__ | Authentication to Azure services | Key Vault access granted |
| __Git Repository__ | Source control | Collaboration and publish branches |
| __Development Tools__ | Local development | VS Code extension, PowerShell module |

## 🚨 Troubleshooting

### Issue: Cannot Access ADF Studio

__Symptoms__: Error when clicking "Author & Monitor"

__Solutions__:

```bash
# Verify you have proper role assignments
az role assignment list \
  --assignee $(az ad signed-in-user show --query id --output tsv) \
  --scope $(az datafactory show \
    --resource-group $RESOURCE_GROUP \
    --factory-name $ADF_NAME \
    --query id --output tsv)

# Grant Data Factory Contributor role if missing
az role assignment create \
  --role "Data Factory Contributor" \
  --assignee $(az ad signed-in-user show --query id --output tsv) \
  --scope $(az datafactory show \
    --resource-group $RESOURCE_GROUP \
    --factory-name $ADF_NAME \
    --query id --output tsv)
```

### Issue: Managed Identity Not Working

__Symptoms__: Cannot access Key Vault from ADF

__Solutions__:

```bash
# Verify managed identity is enabled
az datafactory show \
  --resource-group $RESOURCE_GROUP \
  --factory-name $ADF_NAME \
  --query identity

# Re-grant Key Vault access
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee $(az datafactory show \
    --resource-group $RESOURCE_GROUP \
    --factory-name $ADF_NAME \
    --query identity.principalId --output tsv) \
  --scope $(az keyvault show \
    --name $KEY_VAULT_NAME \
    --query id --output tsv)
```

## 📚 Additional Resources

- [Azure Data Factory Pricing](https://azure.microsoft.com/pricing/details/data-factory/)
- [ADF Security Best Practices](https://docs.microsoft.com/azure/data-factory/data-factory-security-considerations)
- [Managed Identity Documentation](https://docs.microsoft.com/azure/active-directory/managed-identities-azure-resources/)
- [Azure Key Vault Integration](https://docs.microsoft.com/azure/data-factory/store-credentials-in-key-vault)

## 🚀 Next Steps

Environment setup complete! Continue to:

__→ [03. Integration Runtime Configuration](03-integration-runtime.md)__ - Set up compute infrastructure for data movement

---

__Module Progress__: 2 of 18 complete

*Tutorial Version: 1.0*
*Last Updated: January 2025*
