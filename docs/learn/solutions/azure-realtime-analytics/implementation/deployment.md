---
title: "Deployment Guide"
tags:
  - solutions
  - azure-realtime-analytics
  - implementation
---
# 🚀 Deployment Guide

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


---

## 📋 Overview

This guide provides step-by-step instructions for deploying the Azure Real-Time Analytics platform infrastructure using Infrastructure as Code (IaC) with Terraform or Azure Bicep.

## 📑 Table of Contents

- [Prerequisites](#prerequisites)
- [Environment Setup](#environment-setup)
- [Infrastructure Deployment](#infrastructure-deployment)
- [Configuration](#configuration)
- [Validation](#validation)
- [Troubleshooting](#troubleshooting)

---

## ✅ Prerequisites

### Required Tools

```bash
# Check Azure CLI version (2.50+ required)
az --version

# Check Terraform version (1.5+ required)
terraform --version

# Check Databricks CLI
databricks --version

# Check Power BI CLI
pbicli --version
```

### Required Permissions

```yaml
Azure Permissions:
  - Subscription: Owner or Contributor + User Access Administrator
  - Resource Groups: Create and manage
  - Role Assignments: Create custom roles
  - Policy Assignments: Apply governance policies

Service Principals:
  - Terraform Service Principal with Contributor role
  - Databricks Service Principal for automation
  - Power BI Service Principal for Direct Lake
```

### Azure Subscription Setup

```bash
# Login to Azure
az login

# Set default subscription
az account set --subscription "Your-Subscription-Name"

# Create service principal for Terraform
az ad sp create-for-rbac \
  --name "sp-terraform-realtime-analytics" \
  --role Contributor \
  --scopes /subscriptions/$(az account show --query id -o tsv)
```

---

## 🛠️ Environment Setup

### 1. Clone Repository

```bash
# Clone the infrastructure repository
git clone https://github.com/your-org/azure-realtime-analytics-infra.git
cd azure-realtime-analytics-infra

# Initialize git submodules if any
git submodule update --init --recursive
```

### 2. Configure Environment Variables

```bash
# Create .env file from template
cp .env.template .env

# Edit .env with your values
cat > .env << EOF
# Azure Configuration
AZURE_SUBSCRIPTION_ID=your-subscription-id
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-service-principal-id
AZURE_CLIENT_SECRET=your-service-principal-secret

# Deployment Configuration
ENVIRONMENT=dev
LOCATION=eastus2
RESOURCE_GROUP_NAME=rg-realtime-analytics-dev

# Databricks Configuration
DATABRICKS_WORKSPACE_NAME=dbw-realtime-analytics-dev
DATABRICKS_PRICING_TIER=premium

# Storage Configuration
STORAGE_ACCOUNT_NAME=strtimeanalyticsdev
STORAGE_REPLICATION=ZRS

# Network Configuration
VNET_ADDRESS_SPACE=10.0.0.0/16
DATABRICKS_PUBLIC_SUBNET=10.0.1.0/24
DATABRICKS_PRIVATE_SUBNET=10.0.2.0/24
EOF

# Source environment variables
source .env
```

### 3. Initialize Terraform

```bash
# Navigate to Terraform directory
cd infrastructure/terraform

# Initialize Terraform
terraform init

# Create workspace for environment
terraform workspace new dev
terraform workspace select dev

# Validate configuration
terraform validate
```

---

## 🏗️ Infrastructure Deployment

### Phase 1: Core Infrastructure

```bash
# Deploy core infrastructure
terraform apply -target=module.core -var-file=environments/dev.tfvars

# Resources created:
# - Resource Groups
# - Virtual Networks
# - Network Security Groups
# - Key Vault
# - Log Analytics Workspace
```

### Phase 2: Storage Layer

```bash
# Deploy storage resources
terraform apply -target=module.storage -var-file=environments/dev.tfvars

# Resources created:
# - ADLS Gen2 Storage Account
# - Bronze, Silver, Gold containers
# - Private endpoints
# - Lifecycle policies
```

### Phase 3: Databricks Platform

```bash
# Deploy Databricks workspace
terraform apply -target=module.databricks -var-file=environments/dev.tfvars

# Resources created:
# - Databricks workspace
# - VNet injection
# - Unity Catalog metastore
# - Initial clusters
```

### Phase 4: Streaming Infrastructure

```bash
# Deploy streaming components
terraform apply -target=module.streaming -var-file=environments/dev.tfvars

# Resources created:
# - Event Hubs namespace
# - Kafka connectors
# - Stream Analytics jobs
# - Function Apps
```

### Phase 5: Analytics Layer

```bash
# Deploy analytics components
terraform apply -target=module.analytics -var-file=environments/dev.tfvars

# Resources created:
# - Power BI Premium capacity
# - Azure OpenAI instance
# - API Management
# - Application Insights
```

### Complete Deployment

```bash
# Deploy all resources
terraform apply -var-file=environments/dev.tfvars

# Review plan before applying
terraform plan -var-file=environments/dev.tfvars -out=tfplan
terraform apply tfplan
```

---

## ⚙️ Configuration

### 1. Databricks Configuration

```python
# databricks_setup.py
import os
from databricks.sdk import WorkspaceClient

# Initialize client
w = WorkspaceClient(
    host=os.environ['DATABRICKS_HOST'],
    token=os.environ['DATABRICKS_TOKEN']
)

# Create catalogs
w.catalogs.create(
    name='realtime_analytics',
    comment='Real-time analytics catalog'
)

# Create schemas
for schema in ['bronze', 'silver', 'gold']:
    w.schemas.create(
        name=schema,
        catalog_name='realtime_analytics',
        comment=f'{schema.capitalize()} layer schema'
    )

# Configure cluster policies
cluster_policy = {
    "spark_version": {"type": "fixed", "value": "13.3.x-scala2.12"},
    "node_type_id": {"type": "allowlist", "values": ["Standard_D16s_v3", "Standard_D32s_v3"]},
    "autoscale": {"type": "fixed", "value": {"min_workers": 2, "max_workers": 50}},
    "autotermination_minutes": {"type": "range", "minValue": 10, "maxValue": 120}
}

w.cluster_policies.create(
    name='streaming-cluster-policy',
    definition=cluster_policy
)
```

### 2. Storage Configuration

```bash
# Configure storage lifecycle policies
az storage management-policy create \
  --account-name $STORAGE_ACCOUNT_NAME \
  --resource-group $RESOURCE_GROUP_NAME \
  --policy @storage-lifecycle-policy.json

# Set up private endpoints
az network private-endpoint create \
  --name pe-storage-blob \
  --resource-group $RESOURCE_GROUP_NAME \
  --vnet-name vnet-realtime-analytics \
  --subnet pe-subnet \
  --private-connection-resource-id $(az storage account show -n $STORAGE_ACCOUNT_NAME -g $RESOURCE_GROUP_NAME --query id -o tsv) \
  --group-id blob \
  --connection-name storage-blob-connection
```

### 3. Kafka Configuration

```yaml
# kafka-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-config
data:
  bootstrap.servers: "pkc-xxxxx.eastus2.azure.confluent.cloud:9092"
  security.protocol: "SASL_SSL"
  sasl.mechanism: "PLAIN"
  schema.registry.url: "https://psrc-xxxxx.us-east-2.aws.confluent.cloud"
  
  topics:
    - name: events
      partitions: 20
      replication: 3
      retention.ms: 604800000  # 7 days
      
    - name: metrics
      partitions: 10
      replication: 3
      retention.ms: 259200000  # 3 days
```

### 4. Power BI Configuration

```powershell
# Configure Power BI Premium workspace
Install-Module -Name MicrosoftPowerBIMgmt

# Connect to Power BI
Connect-PowerBIServiceAccount

# Create workspace
New-PowerBIWorkspace `
  -Name "RealTimeAnalytics" `
  -Description "Real-time analytics workspace"

# Assign to Premium capacity
Set-PowerBIWorkspace `
  -Id $workspaceId `
  -CapacityId $capacityId

# Configure Direct Lake
$datasetConfig = @{
    "mode" = "DirectLake"
    "datasources" = @(
        @{
            "datasourceType" = "AnalysisServices"
            "connectionDetails" = @{
                "server" = "powerbi://api.powerbi.com/v1.0/myorg/RealTimeAnalytics"
                "database" = "gold"
            }
        }
    )
}
```

---

## ✅ Validation

### Infrastructure Validation Script

```bash
#!/bin/bash
# validate_deployment.sh

echo "🔍 Validating Azure Real-Time Analytics Deployment..."

# Check resource groups
echo "Checking resource groups..."
az group show --name $RESOURCE_GROUP_NAME > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ Resource group exists"
else
    echo "❌ Resource group not found"
    exit 1
fi

# Check Databricks workspace
echo "Checking Databricks workspace..."
az databricks workspace show \
  --name $DATABRICKS_WORKSPACE_NAME \
  --resource-group $RESOURCE_GROUP_NAME > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ Databricks workspace exists"
else
    echo "❌ Databricks workspace not found"
    exit 1
fi

# Check storage account
echo "Checking storage account..."
az storage account show \
  --name $STORAGE_ACCOUNT_NAME \
  --resource-group $RESOURCE_GROUP_NAME > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ Storage account exists"
else
    echo "❌ Storage account not found"
    exit 1
fi

# Test connectivity
echo "Testing Databricks connectivity..."
databricks workspace list > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ Databricks CLI connected"
else
    echo "❌ Databricks CLI connection failed"
    exit 1
fi

echo "✨ Deployment validation completed successfully!"
```

### Health Check Dashboard

```python
# health_check.py
import requests
import json
from datetime import datetime

def check_service_health(service_name, endpoint, expected_status=200):
    """Check if a service is healthy."""
    try:
        response = requests.get(endpoint, timeout=5)
        is_healthy = response.status_code == expected_status
        return {
            "service": service_name,
            "status": "healthy" if is_healthy else "unhealthy",
            "response_time": response.elapsed.total_seconds(),
            "status_code": response.status_code,
            "timestamp": datetime.utcnow().isoformat()
        }
    except Exception as e:
        return {
            "service": service_name,
            "status": "error",
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat()
        }

# Check all services
services = [
    ("Databricks", f"https://{os.environ['DATABRICKS_HOST']}/api/2.0/clusters/list"),
    ("Storage", f"https://{os.environ['STORAGE_ACCOUNT_NAME']}.blob.core.windows.net/"),
    ("Event Hubs", f"https://{os.environ['EVENT_HUBS_NAMESPACE']}.servicebus.windows.net/"),
    ("Power BI", "https://api.powerbi.com/v1.0/myorg/groups")
]

health_results = []
for service_name, endpoint in services:
    result = check_service_health(service_name, endpoint)
    health_results.append(result)
    print(f"{result['service']}: {result['status']}")

# Save results
with open('health_check_results.json', 'w') as f:
    json.dump(health_results, f, indent=2)
```

---

## 🚨 Troubleshooting

### Common Issues and Solutions

| Issue | Symptoms | Solution |
|-------|----------|----------|
| **Terraform state lock** | "Error acquiring the state lock" | Run `terraform force-unlock <lock-id>` |
| **Insufficient quota** | "OperationNotAllowed" errors | Request quota increase in Azure portal |
| **VNet peering failed** | Databricks unreachable | Verify address spaces don't overlap |
| **Storage access denied** | 403 errors on containers | Check firewall rules and private endpoints |
| **Cluster startup fails** | "Cluster terminated" | Review driver logs in Databricks |

### Rollback Procedure

```bash
# Create backup of current state
terraform state pull > terraform.tfstate.backup

# Rollback to previous version
terraform destroy -target=module.affected_module -var-file=environments/dev.tfvars

# Restore from backup if needed
terraform state push terraform.tfstate.backup
```

### Support Escalation

1. **Level 1**: Check deployment logs and health dashboard
2. **Level 2**: Review Azure Monitor alerts and diagnostics
3. **Level 3**: Contact platform team: platform@company.com
4. **Level 4**: Open Azure support ticket (if critical)

---

## 📊 Post-Deployment Checklist

- [ ] All Terraform resources successfully deployed
- [ ] Network connectivity validated
- [ ] Security policies applied
- [ ] Databricks workspace accessible
- [ ] Storage containers created with correct permissions
- [ ] Kafka/Event Hubs topics configured
- [ ] Power BI workspace connected
- [ ] Monitoring and alerts configured
- [ ] Backup strategy implemented
- [ ] Documentation updated

---

## 📚 Next Steps

1. **[Configure Databricks](./databricks-setup.md)** - Set up workspaces and clusters
2. **[Implement Stream Processing](./stream-processing.md)** - Deploy streaming pipelines
3. **[Setup Monitoring](../operations/monitoring.md)** - Configure observability
4. **[Run Performance Tests](../operations/performance.md)** - Validate system performance

---

**Last Updated:** January 29, 2025  
**Version:** 1.0.0  
**Maintainer:** Platform Engineering Team