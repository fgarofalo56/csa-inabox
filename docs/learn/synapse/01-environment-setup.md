# Synapse Environment Setup

> **[Home](../README.md)** | **[Synapse](README.md)** | **Environment Setup**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Level](https://img.shields.io/badge/Level-Beginner-green?style=flat-square)

Step-by-step guide to setting up an Azure Synapse Analytics environment.

---

## Prerequisites

- Azure subscription with Contributor access
- Azure CLI installed
- Basic familiarity with Azure Portal

---

## Step 1: Create Resource Group

```bash
# Set variables
RESOURCE_GROUP="rg-synapse-demo"
LOCATION="eastus"

# Create resource group
az group create \
    --name $RESOURCE_GROUP \
    --location $LOCATION
```

---

## Step 2: Create Storage Account

```bash
STORAGE_ACCOUNT="stsynapsedemo$(date +%s)"

# Create ADLS Gen2 storage account
az storage account create \
    --name $STORAGE_ACCOUNT \
    --resource-group $RESOURCE_GROUP \
    --location $LOCATION \
    --sku Standard_LRS \
    --kind StorageV2 \
    --enable-hierarchical-namespace true

# Create file system (container)
az storage fs create \
    --name "synapse" \
    --account-name $STORAGE_ACCOUNT
```

---

## Step 3: Create Synapse Workspace

```bash
SYNAPSE_WORKSPACE="syn-demo-ws"
SQL_ADMIN_USER="sqladmin"
SQL_ADMIN_PASSWORD="YourSecurePassword123!"

# Create Synapse workspace
az synapse workspace create \
    --name $SYNAPSE_WORKSPACE \
    --resource-group $RESOURCE_GROUP \
    --location $LOCATION \
    --storage-account $STORAGE_ACCOUNT \
    --file-system "synapse" \
    --sql-admin-login-user $SQL_ADMIN_USER \
    --sql-admin-login-password $SQL_ADMIN_PASSWORD

# Allow Azure services
az synapse workspace firewall-rule create \
    --name "AllowAllAzureIps" \
    --workspace-name $SYNAPSE_WORKSPACE \
    --resource-group $RESOURCE_GROUP \
    --start-ip-address 0.0.0.0 \
    --end-ip-address 0.0.0.0
```

---

## Step 4: Create Spark Pool

```bash
# Create Spark pool
az synapse spark pool create \
    --name "sparkpool" \
    --workspace-name $SYNAPSE_WORKSPACE \
    --resource-group $RESOURCE_GROUP \
    --spark-version "3.3" \
    --node-count 3 \
    --node-size "Small" \
    --enable-auto-pause true \
    --auto-pause-delay 15
```

---

## Step 5: Verify Setup

```bash
# List workspace details
az synapse workspace show \
    --name $SYNAPSE_WORKSPACE \
    --resource-group $RESOURCE_GROUP

# Get connection endpoints
az synapse workspace show \
    --name $SYNAPSE_WORKSPACE \
    --resource-group $RESOURCE_GROUP \
    --query "connectivityEndpoints"
```

---

## Step 6: Access Synapse Studio

1. Navigate to Azure Portal
2. Open your Synapse workspace
3. Click "Open Synapse Studio"
4. Begin exploring!

---

## Next Steps

- [Create your first notebook](02-first-notebook.md)
- [Set up data connections](03-data-connections.md)
- [Create a pipeline](04-first-pipeline.md)

---

## Related Documentation

- [Synapse Overview](../02-services/analytics-compute/azure-synapse/README.md)
- [Spark Pool Configuration](../02-services/analytics-compute/azure-synapse/spark-pools/README.md)
- [Best Practices](../best-practices/README.md)

---

*Last Updated: January 2025*
