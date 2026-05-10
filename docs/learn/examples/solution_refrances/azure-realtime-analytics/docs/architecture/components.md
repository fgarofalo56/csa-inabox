---
title: "Databricks Component Architecture"
tags:
  - examples
  - solution_refrances
  - azure-realtime-analytics
  - architecture
---
# 🔧 Databricks Component Architecture

## Table of Contents
- [Platform Overview](#platform-overview)
- [Control Plane Architecture](#control-plane-architecture)
- [Data Plane Architecture](#data-plane-architecture)
- [Compute Layer](#compute-layer)
- [Storage Integration](#storage-integration)
- [Security & Networking](#security--networking)
- [Runtime Components](#runtime-components)

## Platform Overview

Azure Databricks provides a unified analytics platform combining the power of Apache Spark with enterprise-grade security, reliability, and performance. The platform follows a **control plane** and **data plane** architecture pattern.

### Key Architecture Principles
1. **Separation of Concerns**: Control and data planes are isolated
2. **Enterprise Security**: VNet injection with private connectivity
3. **Auto-scaling**: Dynamic resource allocation based on workload
4. **Multi-tenancy**: Isolated workspaces with shared infrastructure
5. **Performance Optimization**: Photon engine and Delta Lake integration

## Control Plane Architecture

The **Control Plane** is managed by Microsoft and provides workspace management, security, and orchestration services.

### Core Control Plane Components

#### 1. **Workspace Management**
- **Notebooks & Jobs**: Development and scheduling interface
- **Clusters & Pools**: Compute resource management
- **User Interface**: Web-based development environment
- **REST APIs**: Programmatic access and automation

#### 2. **Unity Catalog Metastore**
- **Schema Management**: Centralized metadata catalog
- **Fine-grained Access Control**: Table/column level permissions
- **Data Lineage**: Automatic tracking of data dependencies
- **Cross-workspace Governance**: Unified data governance

```python
# Unity Catalog table creation
spark.sql("""
CREATE TABLE main.analytics.customer_events (
    event_id STRING,
    customer_id STRING,
    event_type STRING,
    timestamp TIMESTAMP,
    properties MAP<STRING, STRING>
) 
USING DELTA
LOCATION 'abfss://analytics@datalake.dfs.core.windows.net/gold/customer_events'
TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true'
)
""")
```

#### 3. **MLflow Server**
- **Model Registry**: Centralized model versioning
- **Experiment Tracking**: ML experiment management
- **Model Deployment**: Automated model serving
- **A/B Testing**: Model performance comparison

#### 4. **Security & Compliance**
- **Audit Logging**: Comprehensive activity tracking
- **RBAC & ACLs**: Role-based access control
- **Compliance**: SOC2, HIPAA, GDPR frameworks
- **Encryption**: Data encryption at rest and in transit

#### 5. **API Gateway**
- **REST APIs**: Programmatic workspace access
- **Authentication**: Azure AD integration
- **Rate Limiting**: API usage throttling
- **Monitoring**: API performance tracking

## Data Plane Architecture

The **Data Plane** runs in the customer's Azure subscription within a dedicated VNet, providing compute and storage resources.

### Data Plane Components

#### 1. **Compute Layer**
```text┌─────────────────────────────────────────────────────────────┐
│                    Compute Layer                            │
├─────────────────┬─────────────────┬─────────────────────────┤
│  Job Clusters   │ SQL Warehouses  │  Interactive Clusters   │
│                 │                 │                         │
│ • Auto-scaling  │ • Photon Engine │ • Shared Pools          │
│ • Spot Instance │ • Auto-suspend  │ • High Concurrency      │
│ • Cost Optimiz  │ • Serverless    │ • Development           │
└─────────────────┴─────────────────┴─────────────────────────┘
                           │
               ┌─────────────────────┐
               │   Cluster Manager   │
               │                     │
               │ • Spark Orchestr.   │
               │ • Resource Alloc.   │
               │ • Health Monitor.   │
               └─────────────────────┘
```

**Job Clusters**
- **Purpose**: Automated workloads and ETL jobs
- **Scaling**: Auto-scaling from 2-50 nodes
- **Cost**: Spot instances (70% usage for cost optimization)
- **Termination**: Auto-terminate after job completion

```yaml
# Job cluster configuration
job_cluster_config:
  cluster_name: "analytics-job-cluster"
  spark_version: "13.3.x-scala2.12"
  node_type_id: "Standard_DS4_v2"
  driver_node_type_id: "Standard_DS5_v2"
  autoscale:
    min_workers: 2
    max_workers: 50
  aws_attributes:
    availability: "SPOT_WITH_FALLBACK"
    spot_bid_price_percent: 50
  autotermination_minutes: 10
```

**SQL Warehouses**
- **Purpose**: Interactive analytics and BI workloads
- **Engine**: Photon-enabled for 3-5x performance
- **Scaling**: Serverless auto-scaling
- **Integration**: Direct Power BI connectivity

**Interactive Clusters**
- **Purpose**: Development and data exploration
- **Concurrency**: High concurrency mode for multiple users
- **Pools**: Instance pools for faster startup
- **Libraries**: Custom library management

#### 2. **Storage Layer**
```text┌─────────────────────────────────────────────────────────────┐
│                    Storage Layer                            │
├─────────────────┬─────────────────┬─────────────────────────┤
│   ADLS Gen2     │  Mount Points   │        DBFS             │
│                 │                 │                         │
│ • Delta Lake    │ • External      │ • Workspace Files       │
│ • Hierarchical  │   Storage       │ • Library Storage       │
│ • Multi-proto   │ • Credentials   │ • Temporary Data        │
│   Access        │   Management    │                         │
└─────────────────┴─────────────────┴─────────────────────────┘
```

**ADLS Gen2 Integration**
```python
# ADLS Gen2 mount configuration
configs = {
    "fs.azure.account.auth.type.yourstorageaccount.dfs.core.windows.net": "OAuth",
    "fs.azure.account.oauth.provider.type.yourstorageaccount.dfs.core.windows.net": 
        "org.apache.hadoop.fs.azurebfs.oauth2.ManagedIdentityTokenProvider",
    "fs.azure.account.oauth2.msi.tenant": "<tenant-id>",
    "fs.azure.account.oauth2.client.id": "<managed-identity-client-id>"
}

dbutils.fs.mount(
    source="abfss://analytics@yourstorageaccount.dfs.core.windows.net/",
    mount_point="/mnt/analytics",
    extra_configs=configs
)
```

#### 3. **Networking & Security**
```text┌─────────────────────────────────────────────────────────────┐
│                Networking & Security                        │
├─────────────────┬─────────────────┬─────────────────────────┤
│  VNet Injection │  Private Link   │    NSG Rules            │
│                 │                 │                         │
│ • Public Subnet │ • Service       │ • Firewall Rules        │
│ • Private Subnet│   Endpoints     │ • IP Whitelisting       │
│ • Custom Route  │ • Private       │ • Port Control          │
│                 │   Connectivity  │                         │
└─────────────────┴─────────────────┴─────────────────────────┘
                           │
               ┌─────────────────────┐
               │  Managed Identity   │
               │                     │
               │ • Azure AD Integr.  │
               │ • Service Auth.     │
               │ • No Credential     │
               │   Management        │
               └─────────────────────┘
```

**VNet Injection Configuration**
```json
{
  "vnetId": "/subscriptions/{subscription}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{vnet}",
  "publicSubnetName": "databricks-public",
  "privateSubnetName": "databricks-private",
  "enableNoPublicIp": true,
  "nsgAssociationId": {
    "publicSubnetNsgAssociationId": "/subscriptions/{subscription}/...nsg-public",
    "privateSubnetNsgAssociationId": "/subscriptions/{subscription}/...nsg-private"
  }
}
```

## Compute Layer

### Cluster Types & Use Cases

| Cluster Type | Use Case | Scaling | Cost Model | Best For |
|--------------|----------|---------|------------|----------|
| **Job Clusters** | Automated ETL, ML Training | 2-50 nodes | Spot instances | Production workloads |
| **Interactive** | Development, Analysis | Fixed size | On-demand | Data exploration |
| **SQL Warehouse** | BI queries, Analytics | Serverless | Per-query | Business users |
| **Instance Pools** | Faster startup | Pre-allocated | Reserved | Development |

### Performance Optimization

#### 1. **Auto-scaling Configuration**
```python
# Optimal auto-scaling settings
cluster_config = {
    "autoscale": {
        "min_workers": 2,
        "max_workers": 20
    },
    "spark_conf": {
        "spark.databricks.adaptive.enabled": "true",
        "spark.databricks.adaptive.coalescePartitions.enabled": "true",
        "spark.databricks.adaptive.skewJoin.enabled": "true",
        "spark.sql.adaptive.advisoryPartitionSizeInBytes": "128MB"
    }
}
```

#### 2. **Photon Engine**
- **Performance**: 3-5x faster for analytics workloads
- **Compatibility**: Compatible with existing Spark code
- **Cost**: Included with premium SKUs
- **Automatic**: No code changes required

#### 3. **Instance Pool Management**
```python
# Instance pool configuration
pool_config = {
    "instance_pool_name": "analytics-pool",
    "min_idle_instances": 0,
    "max_capacity": 50,
    "node_type_id": "Standard_DS4_v2",
    "idle_instance_autotermination_minutes": 60,
    "preloaded_spark_versions": ["13.3.x-scala2.12"]
}
```

## Storage Integration

### Delta Lake Optimization

#### 1. **Table Configuration**
```sql
-- Create optimized Delta table
CREATE TABLE analytics.customer_events (
    event_id STRING,
    customer_id STRING,
    event_timestamp TIMESTAMP,
    event_data MAP<STRING, STRING>
)
USING DELTA
LOCATION '/delta/gold/customer_events'
PARTITIONED BY (DATE(event_timestamp))
TBLPROPERTIES (
    'delta.autoOptimize.optimizeWrite' = 'true',
    'delta.autoOptimize.autoCompact' = 'true',
    'delta.logRetentionDuration' = 'interval 30 days',
    'delta.deletedFileRetentionDuration' = 'interval 7 days'
);
```

#### 2. **Performance Tuning**
```sql
-- Z-ORDER optimization for common queries
OPTIMIZE analytics.customer_events
ZORDER BY (customer_id, event_timestamp);

-- Vacuum old files
VACUUM analytics.customer_events RETAIN 168 HOURS;

-- Analyze table statistics
ANALYZE TABLE analytics.customer_events COMPUTE STATISTICS;
```

#### 3. **Schema Evolution**
```python
# Handle schema evolution gracefully
df_new_schema = spark.read.format("json").load("/source/new_events/")

df_new_schema.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .saveAsTable("analytics.customer_events")
```

## Security & Networking

### Network Security Implementation

#### 1. **Network Security Group Rules**
```json
{
  "securityRules": [
    {
      "name": "AllowDatabricksControlPlane",
      "priority": 100,
      "direction": "Outbound",
      "access": "Allow",
      "protocol": "Tcp",
      "sourcePortRange": "*",
      "destinationPortRanges": ["443", "8443-8451"],
      "destinationAddressPrefix": "AzureDatabricks"
    },
    {
      "name": "AllowWorkerCommunication", 
      "priority": 110,
      "direction": "Inbound",
      "access": "Allow",
      "protocol": "*",
      "sourceAddressPrefix": "VirtualNetwork",
      "destinationAddressPrefix": "VirtualNetwork"
    }
  ]
}
```

#### 2. **Private Endpoint Configuration**
```terraform
# Databricks workspace with private link
resource "azurerm_databricks_workspace" "analytics" {
  name                          = "databricks-analytics"
  resource_group_name          = var.resource_group_name
  location                     = var.location
  sku                          = "premium"
  public_network_access_enabled = false
  
  custom_parameters {
    no_public_ip                                         = true
    virtual_network_id                                   = var.vnet_id
    public_subnet_name                                   = "databricks-public"
    private_subnet_name                                  = "databricks-private"
    public_subnet_network_security_group_association_id  = var.public_nsg_id
    private_subnet_network_security_group_association_id = var.private_nsg_id
  }
}
```

#### 3. **Managed Identity Authentication**
```python
# Configure managed identity for storage access
spark.conf.set(
    "fs.azure.account.auth.type.yourstorageaccount.dfs.core.windows.net", 
    "OAuth"
)
spark.conf.set(
    "fs.azure.account.oauth.provider.type.yourstorageaccount.dfs.core.windows.net", 
    "org.apache.hadoop.fs.azurebfs.oauth2.ManagedIdentityTokenProvider"
)
spark.conf.set(
    "fs.azure.account.oauth2.msi.tenant", 
    "<tenant-id>"
)
```

## Runtime Components

### Spark Runtime Optimization

#### 1. **Core Runtime Components**
```text┌─────────────────────────────────────────────────────────────┐
│                Runtime Components                           │
├────────────┬────────────┬────────────┬────────────┬────────────┤
│ Spark Core │ Delta Lake │   Photon   │ML Libraries│GPU Support │
│            │            │            │            │            │
│ • v3.5.0   │ • v3.0     │ • Native   │ • MLlib    │ • RAPIDS   │
│ • Distrib. │ • ACID     │ • Vector.  │ • XGBoost  │ • CUDA     │
└────────────┴────────────┴────────────┴────────────┴────────────┘
                           │
           ┌────────────┬────────────┬────────────┬────────────┐
           │ Connectors │ Libraries  │Custom JARs │Init Scripts│
           │            │            │            │            │
           │ • JDBC     │ • PyPI     │ • Maven    │ • Setup    │
           │ • APIs     │ • Maven    │ • Custom   │ • Config   │
           └────────────┴────────────┴────────────┴────────────┘
```

#### 2. **Library Management**
```python
# Install libraries at cluster level
dbutils.library.installPyPI("azure-storage-blob", version="12.14.1")
dbutils.library.installPyPI("great-expectations", version="0.17.12")

# Restart Python to use new libraries
dbutils.library.restartPython()

# Verify installation
import azure.storage.blob as blob
import great_expectations as ge
print("Libraries loaded successfully")
```

#### 3. **Init Scripts**
```bash
#!/bin/bash
# Databricks init script for custom configuration

# Configure Azure CLI
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Install additional monitoring tools
sudo apt-get update
sudo apt-get install -y htop iotop

# Configure JVM settings
echo "-Djava.security.properties=/databricks/spark/conf/java.security.override" >> /databricks/spark/conf/spark-defaults.conf

# Set custom Spark configurations
echo "spark.sql.adaptive.skewJoin.enabled true" >> /databricks/spark/conf/spark-defaults.conf
echo "spark.databricks.delta.preview.enabled true" >> /databricks/spark/conf/spark-defaults.conf
```

### Platform Capabilities

| Capability | Specification | Notes |
|------------|---------------|--------|
| **Maximum Cluster Size** | 1000+ nodes | Enterprise tier |
| **Concurrent Users** | 1000+ | Per workspace |
| **Data Processing** | Petabyte scale | Delta Lake optimized |
| **Job Concurrency** | 10,000+ daily | Auto-scaling |
| **Notebook Collaboration** | Unlimited | Real-time collaboration |
| **API Throughput** | 10,000 req/sec | Rate limited |
| **Availability SLA** | 99.95% | Premium tier |
| **Multi-region** | Global deployment | Disaster recovery |

## Next Steps

1. **[Review Security Architecture](security.md)** - Zero-trust implementation details
2. **Deployment Guide** - Step-by-step setup
3. **Monitoring Setup** - Observability configuration
4. **Performance Tuning** - Optimization guide

---

**🎯 Key Takeaway**: The Databricks architecture provides enterprise-grade security, performance, and scalability through careful separation of control and data planes, with comprehensive networking and security controls.

**🔧 Implementation Ready**: Use the [deployment scripts](../../scripts/) to implement this architecture in your environment.
