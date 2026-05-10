---
title: "Global Data Distribution Patterns"
description: "Patterns for distributing analytics data across multiple Azure regions and geographies."
tags:
  - architecture
  - hybrid-architectures
---
# 🌍 Global Data Distribution Patterns

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)
![Last Updated](https://img.shields.io/badge/Updated-2025-blue?style=flat-square)

Patterns for distributing analytics data across multiple Azure regions and geographies.

---

## 🎯 Overview

Global data distribution enables:

- **Low latency** access for users worldwide
- **Data residency** compliance (GDPR, data sovereignty)
- **Disaster recovery** with geo-redundancy
- **Load distribution** across regions

---

## 🏗️ Architecture Patterns

### Active-Passive Multi-Region

```mermaid
graph TB
    subgraph "Primary Region (East US)"
        P1[Data Lake Primary]
        P2[Synapse Primary]
        P3[Active Workloads]
    end

    subgraph "Secondary Region (West US)"
        S1[Data Lake Secondary]
        S2[Synapse Secondary]
        S3[Standby]
    end

    subgraph "Replication"
        R1[GRS Replication]
        R2[Data Factory Sync]
    end

    P1 --> R1
    R1 --> S1
    P2 --> R2
    R2 --> S2
```

### Active-Active Multi-Region

```mermaid
graph TB
    subgraph "Region: Europe"
        EU1[Data Lake EU]
        EU2[Synapse EU]
        EU3[EU Users]
    end

    subgraph "Region: North America"
        NA1[Data Lake NA]
        NA2[Synapse NA]
        NA3[NA Users]
    end

    subgraph "Region: Asia Pacific"
        AP1[Data Lake AP]
        AP2[Synapse AP]
        AP3[AP Users]
    end

    subgraph "Global Services"
        G1[Azure Front Door]
        G2[Cosmos DB Global]
        G3[Azure Purview]
    end

    EU3 --> G1
    NA3 --> G1
    AP3 --> G1
    G1 --> EU2
    G1 --> NA2
    G1 --> AP2
    G2 --> EU1
    G2 --> NA1
    G2 --> AP1
```

---

## 🔧 Implementation

### Geo-Replicated Storage

```bicep
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'datalakeglobal'
  location: 'eastus'
  sku: {
    name: 'Standard_GZRS'  // Geo-zone-redundant storage
  }
  kind: 'StorageV2'
  properties: {
    isHnsEnabled: true  // Enable hierarchical namespace for ADLS Gen2
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}
```

### Cross-Region Data Factory Pipeline

```json
{
    "name": "CrossRegionSync",
    "properties": {
        "activities": [
            {
                "name": "CopyToSecondaryRegion",
                "type": "Copy",
                "inputs": [
                    {
                        "referenceName": "PrimaryDataLake",
                        "type": "DatasetReference"
                    }
                ],
                "outputs": [
                    {
                        "referenceName": "SecondaryDataLake",
                        "type": "DatasetReference"
                    }
                ],
                "typeProperties": {
                    "source": {
                        "type": "ParquetSource"
                    },
                    "sink": {
                        "type": "ParquetSink"
                    },
                    "enableStaging": false
                }
            }
        ],
        "parameters": {
            "sourcePath": {
                "type": "string"
            },
            "sinkPath": {
                "type": "string"
            }
        }
    }
}
```

### Cosmos DB Multi-Region

```python
from azure.cosmos import CosmosClient

# Configure multi-region writes
client = CosmosClient(
    url="https://cosmos-global.documents.azure.com:443/",
    credential=credential,
    preferred_locations=["East US", "West Europe", "Southeast Asia"],
    enable_endpoint_discovery=True,
    multiple_write_locations=True
)

# Database operations automatically route to nearest region
database = client.get_database_client("analytics")
container = database.get_container_client("metrics")

# Writes go to nearest region, then replicate globally
container.upsert_item({
    "id": "metric-001",
    "region": "auto-detected",
    "value": 100,
    "timestamp": datetime.utcnow().isoformat()
})
```

---

## 🛡️ Data Residency Compliance

### Regional Data Boundaries

```python
def get_allowed_regions(data_classification: str, user_location: str) -> list:
    """Determine allowed Azure regions based on data classification and user location."""

    region_policies = {
        "pii_eu": ["westeurope", "northeurope", "francecentral", "germanywestcentral"],
        "pii_us": ["eastus", "westus2", "centralus"],
        "pii_apac": ["southeastasia", "australiaeast", "japaneast"],
        "public": ["*"],  # All regions allowed
        "confidential": ["eastus", "westeurope"]  # Restricted regions only
    }

    classification_key = f"{data_classification}_{user_location}"

    if classification_key in region_policies:
        return region_policies[classification_key]
    elif data_classification in region_policies:
        return region_policies[data_classification]
    else:
        return region_policies.get("public", ["eastus"])
```

### Geo-Fencing Queries

```sql
-- Synapse SQL view with region filtering
CREATE VIEW dbo.vw_regional_data AS
SELECT
    d.*,
    r.region_name,
    r.data_residency_zone
FROM dbo.data_records d
JOIN dbo.region_mapping r ON d.region_code = r.region_code
WHERE
    -- Apply geo-fencing based on user context
    r.data_residency_zone = SESSION_CONTEXT(N'user_zone')
    OR SESSION_CONTEXT(N'user_role') = 'GlobalAdmin';
```

---

## 📊 Latency Optimization

### Read Replica Strategy

```mermaid
graph LR
    subgraph "Write Region"
        W1[Primary Synapse]
    end

    subgraph "Read Replicas"
        R1[EU Replica]
        R2[NA Replica]
        R3[APAC Replica]
    end

    subgraph "Users"
        U1[EU Users] --> R1
        U2[NA Users] --> R2
        U3[APAC Users] --> R3
    end

    W1 --> R1
    W1 --> R2
    W1 --> R3
```

### CDN for Analytics Assets

```bicep
resource cdnProfile 'Microsoft.Cdn/profiles@2023-05-01' = {
  name: 'cdn-analytics-assets'
  location: 'global'
  sku: {
    name: 'Standard_Microsoft'
  }
}

resource cdnEndpoint 'Microsoft.Cdn/profiles/endpoints@2023-05-01' = {
  parent: cdnProfile
  name: 'analytics-reports'
  location: 'global'
  properties: {
    originHostHeader: 'datalakeglobal.blob.core.windows.net'
    origins: [
      {
        name: 'datalake-origin'
        properties: {
          hostName: 'datalakeglobal.blob.core.windows.net'
        }
      }
    ]
    isHttpAllowed: false
    isHttpsAllowed: true
  }
}
```

---

## 📚 Related Documentation

- [Hybrid Architectures Overview](README.md)
- [Disaster Recovery](../../05-best-practices/operational-excellence/reliability.md)
- [Network Security](../../05-best-practices/cross-cutting-concerns/networking/README.md)

---

*Last Updated: January 2025*
