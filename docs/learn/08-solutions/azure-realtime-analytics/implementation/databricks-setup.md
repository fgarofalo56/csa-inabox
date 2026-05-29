---
title: "Databricks Workspace Setup"
tags:
  - solutions
  - azure-realtime-analytics
  - implementation
---
# Databricks Workspace Setup

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

![Databricks](https://img.shields.io/badge/Databricks-FF3621?style=flat-square&logo=databricks&logoColor=white)
![Status](https://img.shields.io/badge/Status-Production_Ready-brightgreen?style=flat-square)

## Overview

Step-by-step guide for configuring an Azure Databricks workspace for the real-time analytics platform with Unity Catalog, cluster policies, and security best practices.

## Prerequisites

- Azure subscription with Databricks access
- Resource group created
- Virtual network configured
- Azure AD tenant access

---

## Workspace Creation

### Create Databricks Workspace

```bash
# Create Databricks workspace with VNet injection
az databricks workspace create \
  --resource-group analytics-rg \
  --name databricks-analytics-prod \
  --location eastus \
  --sku premium \
  --managed-resource-group databricks-managed-rg \
  --vnet analytics-spoke-vnet \
  --public-subnet databricks-public \
  --private-subnet databricks-private \
  --prepare-encryption \
  --no-wait

# Enable Unity Catalog
az databricks workspace update \
  --resource-group analytics-rg \
  --name databricks-analytics-prod \
  --enable-no-public-ip true \
  --public-network-access Disabled
```

---

## Unity Catalog Configuration

### Create Metastore

```python
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()

# Create metastore
metastore = w.metastores.create(
    name="analytics_metastore",
    storage_root="abfss://unity-catalog@analyticsstorage.dfs.core.windows.net/",
    region="eastus"
)

# Assign metastore to workspace
w.metastores.assign(
    workspace_id="<workspace-id>",
    metastore_id=metastore.metastore_id,
    default_catalog_name="realtime_analytics"
)
```

### Create Catalog and Schemas

```sql
-- Create catalog
CREATE CATALOG IF NOT EXISTS realtime_analytics;

-- Create schemas
CREATE SCHEMA IF NOT EXISTS realtime_analytics.bronze;
CREATE SCHEMA IF NOT EXISTS realtime_analytics.silver;
CREATE SCHEMA IF NOT EXISTS realtime_analytics.gold;

-- Grant permissions
GRANT USE CATALOG ON CATALOG realtime_analytics TO `data-engineers`;
GRANT ALL PRIVILEGES ON SCHEMA realtime_analytics.bronze TO `data-engineers`;
```

---

## Cluster Configuration

### Create Job Cluster Policy

```json
{
  "cluster_type": {
    "type": "fixed",
    "value": "job"
  },
  "spark_version": {
    "type": "regex",
    "pattern": "13\.3\..*-scala.*"
  },
  "node_type_id": {
    "type": "allowlist",
    "values": ["Standard_DS3_v2", "Standard_DS4_v2"]
  },
  "autoscale": {
    "min_workers": {
      "type": "range",
      "minValue": 2,
      "maxValue": 4
    },
    "max_workers": {
      "type": "range",
      "minValue": 8,
      "maxValue": 50
    }
  }
}
```

### Create Interactive Cluster

```python
cluster_config = {
    "cluster_name": "shared-analytics-cluster",
    "spark_version": "13.3.x-scala2.12",
    "node_type_id": "Standard_DS3_v2",
    "autoscale": {
        "min_workers": 2,
        "max_workers": 10
    },
    "spark_conf": {
        "spark.databricks.delta.preview.enabled": "true",
        "spark.databricks.delta.autoCompact.enabled": "true"
    },
    "data_security_mode": "USER_ISOLATION"
}

from databricks.sdk import WorkspaceClient
w = WorkspaceClient()
cluster = w.clusters.create(**cluster_config)
```

---

## Access Control

### Configure SCIM Provisioning

1. Navigate to Azure AD > Enterprise Applications > Databricks
2. Enable automatic provisioning
3. Configure attribute mappings
4. Start provisioning

### Grant Table Permissions

```sql
-- Grant access to data engineers
GRANT USE CATALOG, USE SCHEMA, SELECT, MODIFY 
ON SCHEMA realtime_analytics.silver 
TO `data-engineers`;

-- Grant read-only to analysts
GRANT USE CATALOG, USE SCHEMA, SELECT 
ON SCHEMA realtime_analytics.gold 
TO `analysts`;
```

---

## Storage Configuration

### Mount ADLS Gen2

```python
# Configure storage access using service principal
configs = {
    "fs.azure.account.auth.type": "OAuth",
    "fs.azure.account.oauth.provider.type": "org.apache.hadoop.fs.azurebfs.oauth2.ClientCredsTokenProvider",
    "fs.azure.account.oauth2.client.id": dbutils.secrets.get("kv-secrets", "sp-client-id"),
    "fs.azure.account.oauth2.client.secret": dbutils.secrets.get("kv-secrets", "sp-client-secret"),
    "fs.azure.account.oauth2.client.endpoint": f"https://login.microsoftonline.com/{tenant_id}/oauth2/token"
}

# Mount storage
dbutils.fs.mount(
    source="abfss://data@analyticsstorage.dfs.core.windows.net/",
    mount_point="/mnt/data",
    extra_configs=configs
)
```

---

## Related Documentation

- [Stream Processing Setup](stream-processing.md)
- [Network Setup](network-setup.md)
- [Security Setup](security-setup.md)

---

**Last Updated:** January 2025
**Version:** 1.0.0
**Status:** Production Ready
