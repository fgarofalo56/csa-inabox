---
title: "Workspace Setup Implementation Script"
tags:
  - multimedia
  - video
  - scripts
  - implementation
---
# Workspace Setup Implementation Script

![Status: Draft](https://img.shields.io/badge/Status-Draft-yellow)
![Duration: 12 minutes](https://img.shields.io/badge/Duration-12%20minutes-blue)

## Overview

Step-by-step implementation script for setting up an Azure Synapse Analytics workspace from scratch, including resource provisioning, configuration, and security setup.

## Implementation Steps

### Prerequisites
- Azure subscription
- Contributor role on resource group
- Azure CLI or PowerShell installed

### Step 1: Resource Group Creation

```bash
az group create \
  --name synapse-prod-rg \
  --location eastus2
```

### Step 2: Storage Account

```bash
az storage account create \
  --name synapsestorageprod \
  --resource-group synapse-prod-rg \
  --location eastus2 \
  --sku Standard_LRS \
  --kind StorageV2 \
  --enable-hierarchical-namespace true
```

### Step 3: Synapse Workspace

```bash
az synapse workspace create \
  --name synapse-prod-workspace \
  --resource-group synapse-prod-rg \
  --storage-account synapsestorageprod \
  --file-system defaultfs \
  --sql-admin-login-user sqladmin \
  --sql-admin-login-password <strong-password> \
  --location eastus2
```

### Step 4: Configure Firewall

```bash
az synapse workspace firewall-rule create \
  --name AllowAll \
  --workspace-name synapse-prod-workspace \
  --resource-group synapse-prod-rg \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 255.255.255.255
```

### Step 5: Create SQL Pool

```bash
az synapse sql pool create \
  --name DW \
  --workspace-name synapse-prod-workspace \
  --resource-group synapse-prod-rg \
  --performance-level DW100c
```

### Step 6: Create Spark Pool

```bash
az synapse spark pool create \
  --name sparkpool \
  --workspace-name synapse-prod-workspace \
  --resource-group synapse-prod-rg \
  --node-count 3 \
  --node-size Small \
  --spark-version 3.3
```

## Configuration Checklist

- [ ] Managed identity enabled
- [ ] Private endpoints configured
- [ ] Azure AD authentication set up
- [ ] RBAC roles assigned
- [ ] Diagnostic settings enabled
- [ ] Git integration configured

## Related Resources

- [Synapse Fundamentals](../../synapse-fundamentals.md)

---

*Last Updated: January 2025*
