---
title: "Migration Guides"
tags:
  - implementation
  - migration-guides
---
# 🔄 Migration Guides

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


## Overview

Comprehensive guides for migrating legacy on-premises and cloud data workloads to the Cloud Scale Analytics platform on Azure.

## Migration Scenarios

| Scenario | Description |
|----------|-------------|
| **On-premises to Azure** | Migrate traditional data warehouses and ETL pipelines to Azure Synapse Analytics |
| **Legacy ETL to ADF** | Modernize SSIS/Informatica/Talend workloads to Azure Data Factory |
| **Hadoop to Azure** | Migrate Hadoop/Spark workloads to Azure Databricks or Synapse Spark |
| **SQL Server to Synapse** | Move analytical workloads from SQL Server to Azure Synapse dedicated pools |

## Migration Framework

A successful migration typically follows these phases:

1. **Assessment**: Evaluate existing workloads, dependencies, and data volumes
2. **Planning**: Design the target architecture and create a migration roadmap
3. **Preparation**: Set up the Azure environment and establish connectivity
4. **Migration**: Execute data and workload migration in phases
5. **Validation**: Verify data integrity and performance benchmarks
6. **Cutover**: Transition production workloads and decommission legacy systems

## Related Resources

- [End-to-End Solutions](../end-to-end-solutions/README.md)
- [Integration Scenarios](../integration-scenarios/README.md)
- [Architecture Patterns](../../03-architecture-patterns/README.md)
- [Best Practices](../../05-best-practices/README.md)
