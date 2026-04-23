---
title: "Azure Analytics: White Papers & Resources"
description: Curated collection of Microsoft architecture references, white papers, and decision guides for enterprise analytics on Azure
---

## Azure Analytics: White Papers & Resources

A curated collection of published Microsoft resources for designing, building, and operating enterprise analytics platforms on Azure. Resources are organized by category and annotated with relevance to CSA-in-a-Box patterns.

---

## Azure Architecture Center

The Azure Architecture Center is the primary source for validated reference architectures, best practices, and design patterns.

### Reference Architectures

| Architecture | Description | CSA-in-a-Box Relevance |
|---|---|---|
| [Analytics End-to-End](https://learn.microsoft.com/en-us/azure/architecture/example-scenario/dataplate2e/data-platform-end-to-end) | Complete analytics platform with ingestion, transformation, serving, and governance | Foundation architecture; CSA-in-a-Box extends with domain patterns |
| [Modern Data Warehouse](https://learn.microsoft.com/en-us/azure/architecture/solution-ideas/articles/modern-data-warehouse) | Data warehouse pattern with Azure Synapse | Alternative to Databricks-centric approach |
| [Real-Time Analytics on Big Data](https://learn.microsoft.com/en-us/azure/architecture/solution-ideas/articles/real-time-analytics) | Streaming analytics with Event Hubs and Spark | Streaming extensions to batch patterns |
| [Big Data with Azure Databricks](https://learn.microsoft.com/en-us/azure/architecture/solution-ideas/articles/azure-databricks-modern-analytics-architecture) | Databricks-centric analytics architecture | Closely aligned with CSA-in-a-Box compute layer |
| [Data Lakehouse](https://learn.microsoft.com/en-us/azure/architecture/example-scenario/data/azure-databricks-lakehouse) | Delta Lake lakehouse pattern | Core CSA-in-a-Box storage pattern |

### Design Patterns

| Pattern | Description | Relevance |
|---|---|---|
| [Medallion Architecture](https://learn.microsoft.com/en-us/azure/databricks/lakehouse/medallion) | Bronze/Silver/Gold data layers | Core CSA-in-a-Box pattern |
| [Data Mesh on Azure](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/data-mesh-azure) | Domain-driven data ownership | CSA-in-a-Box domain organization |
| [Data Lake Zones](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/best-practices/data-lake-zones) | Storage zone organization | Maps to medallion layers |

---

## Cloud Adoption Framework for Analytics

The Cloud Adoption Framework (CAF) provides organizational, governance, and technical guidance for cloud analytics at scale.

### Key Guides

| Guide | Description | When to Use |
|---|---|---|
| [Cloud-Scale Analytics Overview](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/) | Top-level scenario overview | Starting an analytics initiative |
| [Data Management Landing Zone](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/data-management-landing-zone) | Centralized governance zone | Designing governance layer |
| [Data Landing Zone](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/data-landing-zone) | Domain-specific compute and storage | Creating new domains |
| [Data Products](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/data-products) | Self-contained governed datasets | Implementing data contracts |
| [Data Governance](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/govern) | Governance patterns and Purview integration | Setting up governance |

!!! tip "CAF + CSA-in-a-Box"
    CSA-in-a-Box implements the CAF Cloud-Scale Analytics patterns with opinionated technology choices (Databricks, dbt, Delta Lake). The CAF provides the "what" and "why"; CSA-in-a-Box provides the "how."

---

## Data Platform Decision Guides

These guides help teams make informed technology and architecture decisions.

### Compute and Storage

| Guide | Decision |
|---|---|
| [Choose a data analytics technology](https://learn.microsoft.com/en-us/azure/architecture/data-guide/technology-choices/analysis-visualizations-reporting) | Analytics and visualization tool selection |
| [Choose a batch processing technology](https://learn.microsoft.com/en-us/azure/architecture/data-guide/technology-choices/batch-processing) | Batch compute selection |
| [Choose a stream processing technology](https://learn.microsoft.com/en-us/azure/architecture/data-guide/technology-choices/stream-processing) | Streaming compute selection |
| [Choose a data store](https://learn.microsoft.com/en-us/azure/architecture/data-guide/technology-choices/data-store-overview) | Storage technology selection |

### CSA-in-a-Box Decision Trees

This documentation includes its own decision trees for common choices:

| Decision | Page |
|---|---|
| Batch vs. Streaming | [Decision Guide](../decisions/batch-vs-streaming.md) |
| Delta vs. Iceberg vs. Parquet | [Decision Guide](../decisions/delta-vs-iceberg-vs-parquet.md) |
| ETL vs. ELT | [Decision Guide](../decisions/etl-vs-elt.md) |
| Fabric vs. Databricks vs. Synapse | [Decision Guide](../decisions/fabric-vs-databricks-vs-synapse.md) |
| Lakehouse vs. Warehouse vs. Lake | [Decision Guide](../decisions/lakehouse-vs-warehouse-vs-lake.md) |

---

## Disaster Recovery for Data Platforms

Disaster recovery planning is critical for government and enterprise analytics platforms.

### Microsoft Guidance

| Resource | Description |
|---|---|
| [DR for Azure Data Platform](https://learn.microsoft.com/en-us/azure/architecture/data-guide/disaster-recovery/dr-for-azure-data-platform-overview) | Comprehensive DR guidance for analytics |
| [ADLS Gen2 Redundancy](https://learn.microsoft.com/en-us/azure/storage/common/storage-redundancy) | Storage redundancy options (LRS, ZRS, GRS, GZRS) |
| [Databricks DR Patterns](https://learn.microsoft.com/en-us/azure/databricks/administration-guide/disaster-recovery) | Workspace and data recovery |

### CSA-in-a-Box DR Resources

| Resource | Page |
|---|---|
| Disaster Recovery Architecture | [DR Guide](../DR.md) |
| Multi-Region Patterns | [Multi-Region](../MULTI_REGION.md) |
| DR Drill Runbook | [DR Drill](../runbooks/dr-drill.md) |

---

## eDiscovery and Legal Analytics

For legal analytics workloads, Microsoft provides specialized services and guidance.

### Microsoft Purview eDiscovery

| Capability | Description |
|---|---|
| **Content Search** | Search across Microsoft 365 workloads for relevant content |
| **eDiscovery (Standard)** | Case-based holds, searches, and exports |
| **eDiscovery (Premium)** | Advanced analytics, review sets, predictive coding |
| **Compliance Manager** | Continuous compliance assessment |

### Legal Analytics Architecture Considerations

When building legal analytics platforms on Azure, consider:

- **Data preservation** — Immutable storage with legal hold capabilities (ADLS Gen2 immutability policies)
- **Chain of custody** — Full audit logging with Azure Monitor and Purview lineage
- **Privilege review** — Integration with Azure Cognitive Services for document classification
- **Export compliance** — Controlled export with sensitivity labels and DLP policies
- **Cross-border data** — Data residency controls for international legal matters

---

## Security and Compliance Resources

### Microsoft Compliance Documentation

| Resource | Description |
|---|---|
| [Azure compliance documentation](https://learn.microsoft.com/en-us/azure/compliance/) | Central compliance resource |
| [Microsoft Trust Center](https://www.microsoft.com/en-us/trust-center) | Certifications, regulations, privacy |
| [Azure Government compliance](https://learn.microsoft.com/en-us/azure/azure-government/documentation-government-plan-compliance) | Government-specific compliance |
| [Service Trust Portal](https://servicetrust.microsoft.com/) | Audit reports and compliance artifacts |

### CSA-in-a-Box Compliance Mappings

| Framework | Page |
|---|---|
| NIST 800-53 Rev 5 | [Compliance Mapping](../compliance/nist-800-53-rev5.md) |
| CMMC 2.0 Level 2 | [Compliance Mapping](../compliance/cmmc-2.0-l2.md) |
| HIPAA Security Rule | [Compliance Mapping](../compliance/hipaa-security-rule.md) |

---

## Microsoft Fabric Resources

Microsoft Fabric represents the next generation of Microsoft's unified analytics platform. CSA-in-a-Box tracks Fabric as a strategic target (see [ADR-0010](../adr/0010-fabric-strategic-target.md)).

| Resource | Description |
|---|---|
| [Microsoft Fabric documentation](https://learn.microsoft.com/en-us/fabric/) | Official Fabric docs |
| [Fabric Lakehouse](https://learn.microsoft.com/en-us/fabric/data-engineering/lakehouse-overview) | Lakehouse architecture in Fabric |
| [Fabric Data Warehouse](https://learn.microsoft.com/en-us/fabric/data-warehouse/) | SQL-based warehouse in Fabric |
| [OneLake](https://learn.microsoft.com/en-us/fabric/onelake/onelake-overview) | Unified data lake for Fabric |

!!! info "Fabric in Azure Government"
    Microsoft Fabric availability in Azure Government regions is evolving. Check the [Azure Government services by region](https://azure.microsoft.com/en-us/explore/global-infrastructure/government/by-region/) page for current availability.

---

## Additional Reading

### Books and Publications

- *Fundamentals of Data Engineering* (Reis & Housley) — Foundation for medallion architecture concepts
- *Data Mesh* (Dehghani) — Domain-driven data architecture principles
- *The Data Warehouse Toolkit* (Kimball) — Dimensional modeling for gold-layer design

### Community Resources

| Resource | Description |
|---|---|
| [Azure Architecture Blog](https://techcommunity.microsoft.com/t5/azure-architecture-blog/bg-p/AzureArchitectureBlog) | Architecture best practices and updates |
| [Databricks Blog](https://www.databricks.com/blog) | Delta Lake, lakehouse, and Spark updates |
| [dbt Developer Blog](https://docs.getdbt.com/blog) | dbt patterns and best practices |
| [Azure Government Blog](https://devblogs.microsoft.com/azuregov/) | Government-specific updates and guidance |
