---
title: "Azure Purview"
description: "Unified data governance solution for discovering, classifying, and managing data across your enterprise."
tags:
  - services
  - data-governance
  - purview
---
# 🔍 Azure Purview

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)
![Last Updated](https://img.shields.io/badge/Updated-2025-blue?style=flat-square)

Unified data governance solution for discovering, classifying, and managing data across your enterprise.

---

## 🎯 Overview

Azure Purview (now Microsoft Purview) provides comprehensive data governance capabilities including:

- **Data Catalog**: Centralized metadata repository
- **Data Map**: Visual representation of your data estate
- **Data Lineage**: Track data flow from source to consumption
- **Data Classification**: Automatic sensitive data detection
- **Access Policies**: Centralized data access management

---

## 📚 Documentation

| Topic | Description |
|-------|-------------|
| [Data Lineage](lineage.md) | End-to-end lineage tracking |
| [Classification Guide](classifications.md) | Sensitive data detection |
| [Integration Setup](integration.md) | Connect data sources |

---

## 🏗️ Architecture

```mermaid
graph TB
    subgraph "Data Sources"
        S1[Azure SQL]
        S2[Data Lake]
        S3[Synapse]
        S4[Databricks]
    end

    subgraph "Microsoft Purview"
        P1[Data Map]
        P2[Data Catalog]
        P3[Lineage Graph]
        P4[Classifications]
    end

    subgraph "Consumers"
        C1[Data Scientists]
        C2[Analysts]
        C3[Governance Team]
    end

    S1 --> P1
    S2 --> P1
    S3 --> P1
    S4 --> P1

    P1 --> P2
    P1 --> P3
    P2 --> P4

    P2 --> C1
    P2 --> C2
    P3 --> C3
```

---

## 🚀 Quick Start

### 1. Register a Data Source

```python
from azure.purview.scanning import PurviewScanningClient
from azure.identity import DefaultAzureCredential

client = PurviewScanningClient(
    endpoint="https://purview-account.purview.azure.com",
    credential=DefaultAzureCredential()
)

# Register Data Lake
source = {
    "kind": "AdlsGen2",
    "properties": {
        "endpoint": "https://datalake.dfs.core.windows.net/"
    }
}

client.data_sources.create_or_update("datalake", source)
```

### 2. Create a Scan

```python
scan = {
    "kind": "AdlsGen2Msi",
    "properties": {
        "scanRulesetName": "AdlsGen2",
        "scanRulesetType": "System"
    }
}

client.scans.create_or_update("datalake", "scan-001", scan)
client.scan_result.run_scan("datalake", "scan-001")
```

---

## 🔗 Related Documentation

- [Pipeline Lineage](../../analytics-compute/azure-synapse/pipelines/lineage-tracking.md)
- [Data Governance Best Practices](../../../05-best-practices/cross-cutting-concerns/data-governance/README.md)
- [Security Patterns](../../../03-architecture-patterns/governance-patterns/README.md)

---

*Last Updated: January 2025*
