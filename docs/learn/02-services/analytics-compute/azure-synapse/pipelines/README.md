---
title: "Synapse Pipelines"
description: "Data integration and orchestration within Azure Synapse Analytics."
tags:
  - services
  - synapse
  - pipelines
---
# 🔄 Synapse Pipelines

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)
![Last Updated](https://img.shields.io/badge/Updated-2025-blue?style=flat-square)

Data integration and orchestration within Azure Synapse Analytics.

---

## 🎯 Overview

Synapse Pipelines provide code-free data integration capabilities, sharing the same engine as Azure Data Factory with deep Synapse workspace integration.

### Key Capabilities

- **90+ connectors** for data sources
- **Visual data flows** for transformations
- **Notebook orchestration** for Spark workloads
- **Lineage tracking** with Azure Purview
- **CI/CD integration** with Azure DevOps

---

## 📚 Documentation

| Topic | Description |
|-------|-------------|
| [Lineage Tracking](lineage-tracking.md) | Data lineage with Purview integration |
| [Data Factory Guide](../../../orchestration-services/azure-data-factory/README.md) | Shared engine documentation |
| [Best Practices](../../../../05-best-practices/cross-cutting-concerns/development/README.md) | Pipeline development patterns |

---

## 🚀 Quick Start

```json
{
    "name": "IngestSalesData",
    "properties": {
        "activities": [
            {
                "name": "CopyFromSQL",
                "type": "Copy",
                "inputs": [{"referenceName": "SqlSource"}],
                "outputs": [{"referenceName": "DataLakeSink"}]
            }
        ]
    }
}
```

---

*Last Updated: January 2025*
