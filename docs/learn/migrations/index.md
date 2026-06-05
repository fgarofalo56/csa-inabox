---
title: Migration Hub
description: One landing page linking every CSA-in-a-Box migration playbook — hyperscalers, warehouses, lakehouses, BI tools, ETL platforms, and operational databases onto the Azure stack.
---

# Migration Hub

Every migration playbook in one place. Each entry links to that source platform's
**Migration Center** — the full playbook with assessment, feature mapping, TCO,
per-workload migration guides, hands-on tutorials, benchmarks, and best practices.

!!! info "Comparative positioning note"
    These playbooks are written from the perspective of Microsoft Azure, Cloud
    Scale Analytics, and CSA Loom. Any description of third-party or competing
    products is derived from **publicly available documentation** believed
    accurate at the time of writing and is provided for **general comparison
    only**. Verify all third-party details against the vendor's current official
    documentation before making decisions.

Prefer the full narrative landing page with grid cards? See the
[Migrations overview](../../migrations/README.md).

---

## Hyperscaler & cloud platforms

<div class="grid cards" markdown>

- :material-aws:{ .lg .middle } **[AWS to Azure](../../migrations/aws-to-azure/index.md)**

    Move S3, Redshift, EMR, Glue, Kinesis, and SageMaker workloads onto ADLS,
    Fabric, Synapse, ADF, Event Hubs, and Azure ML.

- :material-google-cloud:{ .lg .middle } **[GCP to Azure](../../migrations/gcp-to-azure/index.md)**

    Re-platform BigQuery, Dataflow, Looker, and Vertex AI onto Fabric, ADF,
    Power BI, and Azure ML.

</div>

---

## Cloud data warehouses & lakehouses

<div class="grid cards" markdown>

- :material-snowflake:{ .lg .middle } **[Snowflake to Azure](../../migrations/snowflake/index.md)**

    Migrate warehouses, Snowpark, Cortex AI, data sharing, and streams & tasks
    to Fabric, Delta, and Azure AI.

- :material-cube-outline:{ .lg .middle } **[Databricks to Fabric](../../migrations/databricks-to-fabric/index.md)**

    Convert notebooks, Unity Catalog, Delta Live Tables, and MLflow workloads
    onto Fabric pipelines and OneLake.

- :material-database:{ .lg .middle } **[Teradata to Synapse / Fabric](../../migrations/teradata/index.md)**

    Move SQL, BTEQ, TPT, and large analytical workloads onto Synapse dedicated
    SQL and Fabric.

</div>

---

## Big-data & ETL platforms

<div class="grid cards" markdown>

- :material-elephant:{ .lg .middle } **[Hadoop / Hive to Azure](../../migrations/hadoop-hive/index.md)**

    Re-home HDFS, Hive, Spark, HBase, Kafka, and Oozie onto ADLS, Databricks,
    and Event Hubs.

- :material-server-network:{ .lg .middle } **[Cloudera / CDH to Azure](../../migrations/cloudera-to-azure/index.md)**

    Migrate Impala, NiFi, and CDP Data Engineering onto Databricks and ADF.

- :material-transit-connection-variant:{ .lg .middle } **[Informatica to ADF / Fabric](../../migrations/informatica/index.md)**

    Convert PowerCenter, IICS, data quality, and MDM workloads onto ADF, dbt,
    and Purview.

- :material-shield-lock-outline:{ .lg .middle } **[Palantir Foundry to Azure](../../migrations/palantir-foundry/index.md)**

    Re-platform Ontology, pipelines, Workshop apps, and AIP onto Purview, ADF,
    Power Platform, and Azure AI.

</div>

---

## Business intelligence

<div class="grid cards" markdown>

- :material-chart-box-outline:{ .lg .middle } **[Tableau to Power BI](../../migrations/tableau-to-powerbi/index.md)**

    Convert workbooks, calculations, data sources, Server, and Prep flows onto
    Power BI.

- :material-chart-bar:{ .lg .middle } **[Qlik to Power BI](../../migrations/qlik-to-powerbi/index.md)**

    Migrate apps, expressions, visualizations, Server, and NPrinting onto
    Power BI.

- :material-language-r:{ .lg .middle } **[SAS to Azure ML / Fabric](../../migrations/sas-to-azure/index.md)**

    Lift-and-shift SAS Viya or re-platform analytics, data management, and
    models onto Azure ML and Fabric.

</div>

---

## Operational & relational databases

<div class="grid cards" markdown>

- :material-microsoft:{ .lg .middle } **[SQL Server to Azure SQL](../../migrations/sql-server-to-azure/index.md)**

    Move to Azure SQL Database, Managed Instance, or SQL on Azure VM with DMS.

- :material-database-arrow-right:{ .lg .middle } **[Oracle Database to Azure](../../migrations/oracle-to-azure/index.md)**

    Migrate to Azure SQL MI, PostgreSQL, or Oracle Database@Azure with SSMA and
    ora2pg.

- :material-database-outline:{ .lg .middle } **[IBM Db2 to Azure SQL](../../migrations/db2-to-azure-sql/index.md)**

    Convert schema, data, stored procedures, and applications — including
    mainframe considerations.

- :material-leaf:{ .lg .middle } **[MongoDB to Cosmos DB](../../migrations/mongodb-to-cosmosdb/index.md)**

    Move to Cosmos DB vCore or RU-based with VS Code extension and DMS online
    migration.

- :material-database-cog-outline:{ .lg .middle } **[MySQL to Azure Database](../../migrations/mysql-to-azure/index.md)**

    Migrate to Azure Database for MySQL Flexible Server or PostgreSQL with DMS
    and mysqldump.

</div>
