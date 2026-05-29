---
title: Migrations to Azure
description: Field-tested migration playbooks from on-prem, AWS, GCP, Snowflake, Databricks, Teradata, Hadoop, and more onto the CSA-in-a-Box Azure stack.
---

# Migrations to Azure

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


Field-tested migration playbooks from common on-prem and other-cloud platforms onto the CSA-in-a-Box Azure stack. Each playbook covers **assessment → design → migration → cutover → decommission** with realistic timelines and pitfalls.

<div class="grid cards" markdown>

- :material-database-arrow-right:{ .lg .middle } **Data, AI & Analytics**

    ***

    Core CSA-aligned playbooks for cloud-scale analytics, data platforms, AI/ML, and the operational data stores that feed them. Hyperscalers, warehouses, lakehouses, BI, ETL, and operational DBs.

    [:octicons-arrow-down-24: Jump to playbooks](#data-ai-analytics-migrations)

</div>

---

## Data, AI & Analytics migrations

Core CSA-aligned playbooks for cloud-scale analytics, data platforms, AI/ML, and the operational data stores that feed them.

!!! tip "Migrating to Microsoft Fabric?"
    Several playbooks below target Microsoft Fabric directly. For additional Fabric-specific migration guides, planning worksheets, and tutorials, see the [Supercharge Microsoft Fabric](https://fgarofalo56.github.io/Suppercharge_Microsoft_Fabric/) companion site — including the [Migration Planning Tutorial](https://fgarofalo56.github.io/Suppercharge_Microsoft_Fabric/tutorials/13-migration-planning/) and [Migration Patterns](https://fgarofalo56.github.io/Suppercharge_Microsoft_Fabric/best-practices/migration-patterns/).

### Hyperscaler & cloud platforms (analytics workloads)

| Source                        | Target                         | Playbook                           |
| ----------------------------- | ------------------------------ | ---------------------------------- |
| AWS (Redshift, S3, Glue, EMR) | Synapse, ADLS, ADF, Databricks | [aws-to-azure.md](aws-to-azure.md) |
| GCP (BigQuery, GCS, Dataflow) | Synapse/Fabric, ADLS, ADF      | [gcp-to-azure.md](gcp-to-azure.md) |

### Data warehouses & lakehouses

| Source                           | Target                                        | Playbook                                           |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| Snowflake                        | Fabric / Synapse + Databricks                 | [snowflake.md](snowflake.md)                       |
| Databricks (other clouds or AWS) | Microsoft Fabric                              | [databricks-to-fabric.md](databricks-to-fabric.md) |
| Teradata                         | Synapse Dedicated SQL Pool / Fabric Warehouse | [teradata.md](teradata.md)                         |
| Palantir Foundry                 | Azure data mesh + Purview                     | [palantir-foundry.md](palantir-foundry.md)         |

### Big data ecosystems

| Source                                       | Target                                   | Playbook                                       |
| -------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Hadoop / Hive (Cloudera, HDInsight, on-prem) | Synapse Spark + Delta / Fabric Lakehouse | [hadoop-hive.md](hadoop-hive.md)               |
| Cloudera / CDH (Impala, NiFi, CDP)           | Synapse + Databricks + ADF               | [cloudera-to-azure.md](cloudera-to-azure.md)   |

### ETL & data integration

| Source                         | Target                                     | Playbook                         |
| ------------------------------ | ------------------------------------------ | -------------------------------- |
| Informatica PowerCenter / IICS | Azure Data Factory / Fabric Data Pipelines | [informatica.md](informatica.md) |

### Business intelligence

| Source  | Target   | Playbook                                                 |
| ------- | -------- | -------------------------------------------------------- |
| Tableau | Power BI | [tableau-to-powerbi.md](tableau-to-powerbi.md)           |
| Qlik    | Power BI | [qlik-to-powerbi.md](qlik-to-powerbi.md)                 |

### Analytics & statistical computing

| Source             | Target              | Playbook                             |
| ------------------ | ------------------- | ------------------------------------ |
| SAS (9.4 / Viya)   | Azure ML / Fabric   | [sas-to-azure.md](sas-to-azure.md)   |

### Operational databases (analytics sources)

| Source                  | Target                              | Playbook                                             |
| ----------------------- | ----------------------------------- | ---------------------------------------------------- |
| SQL Server (on-prem)    | Azure SQL DB / MI / VM              | [sql-server-to-azure.md](sql-server-to-azure.md)     |
| Oracle Database         | Azure SQL MI / PostgreSQL / Oracle@Azure | [oracle-to-azure.md](oracle-to-azure.md)         |
| IBM Db2 (z/OS, LUW, i)  | Azure SQL                           | [db2-to-azure-sql.md](db2-to-azure-sql.md)           |
| MongoDB                 | Cosmos DB (vCore / RU)              | [mongodb-to-cosmosdb.md](mongodb-to-cosmosdb.md)     |
| MySQL (on-prem / cloud) | Azure Database for MySQL / PostgreSQL | [mysql-to-azure.md](mysql-to-azure.md)             |

## What every migration has in common

Regardless of source, every migration follows the same **5 phases**:

```mermaid
flowchart LR
    A[1. Assessment<br/>2-4 weeks] --> B[2. Design<br/>2-3 weeks]
    B --> C[3. Migration<br/>4-16 weeks]
    C --> D[4. Cutover<br/>1-2 weeks]
    D --> E[5. Decommission<br/>4-8 weeks]
```

| Phase            | Goal                                                                | Output                                                                                     |
| ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Assessment**   | Inventory current state — workloads, data sizes, dependencies, cost | Migration backlog (CSV / Azure Migrate output), workload tier, target architecture options |
| **Design**       | Map source primitives to Azure primitives                           | Target architecture diagram, security model, network topology, sizing assumptions          |
| **Migration**    | Move data + code in waves                                           | Working pipelines, dbt models, dashboards on Azure for each wave                           |
| **Cutover**      | Stop writes to source, freeze, switch consumers                     | Read-only source, consumers on Azure                                                       |
| **Decommission** | Verify, archive, delete                                             | Source archived, contracts cancelled, runbooks updated                                     |

## Sequencing rule

We **always** migrate consumers before producers, going **upstream**:

1. First: **read-only consumers** (BI dashboards, downstream APIs) — point them at a shadow Azure copy
2. Then: **transformations** (dbt / SQL / Spark)
3. Then: **ingestion** (the actual writes from source systems)
4. Finally: **freeze the source** and decommission

This minimizes the window where any single workload depends on both clouds simultaneously.

## Cost during migration

Plan for **~140% of your steady-state Azure cost** during the migration window because both source and target run in parallel. Tag every resource created during migration with `purpose=migration-from-<source>` so you can report on it separately.

See also [Best Practices — Cost Optimization](../best-practices/cost-optimization.md) for tagging and reserved-capacity strategy.

## Compliance during migration

Migration is the highest-risk window for data exposure. Read these before starting:

- [Best Practices — Security & Compliance](../best-practices/security-compliance.md)
- [Compliance — your relevant framework](../compliance/README.md)
- [Runbook — Security Incident](../runbooks/security-incident.md)

Specifically: **never** open a public IP on the source side to "make it easier to copy data over." Use ExpressRoute / VPN / Private Link.

## Need a playbook for something not listed?

Open an issue at https://github.com/fgarofalo56/csa-inabox/issues with the source platform, approximate data volume, and target Azure services. We add playbooks based on demand.
