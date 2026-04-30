# Migration — Hadoop / Hive → Azure

> **Audience:** Teams running Hadoop (Cloudera, Hortonworks, on-prem, AWS EMR, HDInsight) considering modern lakehouse on Azure. Most Hadoop estates are 7-15 years old, deeply embedded, and **the right answer is rarely "lift and shift to a Hadoop on Azure."**

!!! tip "Expanded Migration Center Available"
    This playbook is the core migration reference. For the complete Hadoop/Hive-to-Azure migration package — including white papers, deep-dive guides, tutorials, and benchmarks — visit the **[Hadoop/Hive Migration Center](hadoop-hive/index.md)**.

    **Quick links:**

    - [Why Azure over Hadoop (Executive Brief)](hadoop-hive/why-azure-over-hadoop.md)
    - [Total Cost of Ownership Analysis](hadoop-hive/tco-analysis.md)
    - [Complete Feature Mapping (35+ features)](hadoop-hive/feature-mapping-complete.md)
    - [Tutorials & Walkthroughs](hadoop-hive/index.md#tutorials)
    - [Benchmarks & Performance](hadoop-hive/benchmarks.md)
    - [Best Practices](hadoop-hive/best-practices.md)

## Decide first: target architecture

Hadoop workloads decompose to multiple Azure targets:

| Workload type                  | Best Azure target                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| HDFS storage                   | **ADLS Gen2** (drop-in HDFS-compatible API)                                                    |
| Hive metastore + Hive SQL      | **Synapse Spark** with external tables OR **Fabric Lakehouse** OR **Databricks Unity Catalog** |
| Spark batch jobs               | **Synapse Spark** OR **Databricks** OR **Fabric Spark**                                        |
| Spark Streaming                | **Databricks Structured Streaming** OR **Fabric RTI**                                          |
| HBase                          | **Cosmos DB** (Cassandra API) OR **Azure Managed HBase on AKS** (rare)                         |
| Kafka on Hadoop                | **Event Hubs** (Kafka-compatible)                                                              |
| Oozie / Airflow workflows      | **ADF** + **dbt** OR **Fabric Data Pipelines**                                                 |
| YARN resource manager          | Replaced by Synapse/DBR/Fabric job schedulers                                                  |
| Sentry / Ranger access control | **Purview** + **Synapse RBAC** + **Unity Catalog**                                             |
| Atlas catalog                  | **Microsoft Purview** ([ADR 0006](../adr/0006-purview-over-atlas.md))                          |

**Key insight:** Modern Azure does not have a "Hadoop equivalent" — it has a _better-decomposed_ set of services. The migration is fundamentally a **modernization**, not a re-platforming.

## Phase 1 — Assessment (4-8 weeks)

### Inventory

For each cluster:

- **HDFS data**: total size, file count, hot vs cold, partitioning
- **Hive tables**: count, schema, partition strategy, format (Parquet, ORC, Avro, text)
- **Spark jobs**: count, cadence, runtime, dependencies
- **Workflows**: Oozie / Airflow DAGs
- **HBase tables** (if any): row counts, access patterns
- **Kafka topics** (if any): producers, consumers, retention
- **YARN queues**: capacity allocation, priority workloads
- **Users**: HDFS ACLs, Sentry/Ranger policies
- **Performance**: peak Spark executors, peak HDFS IO, peak query latency

### Migration tier

| Tier                 | Description                                                   | Action                                             |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| **A** Direct re-host | Spark jobs that read Parquet/Delta with no HDFS-specific code | Move to Synapse/Databricks Spark                   |
| **B** Modernize      | Hive SQL workloads                                            | Convert to dbt + Spark SQL                         |
| **C** Re-platform    | HBase, Storm, Flume, custom YARN apps                         | Replace with Cosmos / Event Hubs / Functions       |
| **D** Decommission   | Stale data, unused tables, abandoned jobs                     | Don't migrate; archive minimal evidence and delete |

Plan for **30-50% of HDFS data and 40-60% of jobs to be Tier D** — Hadoop estates accumulate enormous amounts of dead data.

## Phase 2 — Design (3-4 weeks)

### Storage migration

- ADLS Gen2 is **HDFS-compatible** via the abfs:// driver
- Spark code that uses `hdfs://` URIs needs minimal change to `abfs://`
- Hive tables registered as external tables work the same way
- **Convert Parquet/ORC to Delta** during/after migration — gives you ACID + time travel + Z-order

### Compute migration

| Source             | Target                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Cloudera CDP / CDH | Databricks (CDH was replaced by CDP; many Cloudera customers go to DBR for Spark continuity) |
| Hortonworks HDP    | Databricks (Cloudera acquired Hortonworks; HDP is end-of-life)                               |
| EMR (AWS)          | Databricks (multi-cloud) OR Synapse Spark                                                    |
| HDInsight          | Synapse Spark OR Fabric Spark                                                                |
| On-prem            | Databricks (most Spark-feature-equivalent) OR Synapse Spark                                  |

### Workflow migration

| Oozie pattern                | Replacement                                          |
| ---------------------------- | ---------------------------------------------------- |
| Coordinator (time-triggered) | ADF schedule trigger / Fabric Data Pipeline schedule |
| Workflow (DAG)               | ADF pipeline / Fabric Data Pipeline / Airflow on AKS |
| Sub-workflow                 | ADF execute pipeline activity                        |
| Decision node                | ADF if condition / switch activity                   |
| Email notification           | ADF web activity to Logic Apps / Teams webhook       |

For modern data engineering: **dbt-core** orchestrated by ADF (or Airflow / Dagster) replaces most Oozie + Spark glue.

## Phase 3 — Migration (16-52 weeks)

### Bulk HDFS → ADLS

For data <100 TB: **DistCp** to ADLS over ExpressRoute / VPN

```bash
hadoop distcp \
  hdfs://oldcluster/user/warehouse/orders \
  abfs://raw@<storage>.dfs.core.windows.net/teradata-orders
```

For data >100 TB: **Azure Data Box Heavy** + DistCp for delta sync after device ingestion

### Hive metastore → Spark catalog

- Export Hive metastore DDL to Spark SQL
- Recreate as **external tables** in Spark catalog pointing at ADLS
- Or migrate to **Unity Catalog** (Databricks) / **Lakehouse SQL endpoint** (Fabric) for richer governance

```sql
-- After ADLS migration
CREATE TABLE silver.orders
USING DELTA
LOCATION 'abfs://silver@<storage>.dfs.core.windows.net/orders';
```

### Spark job migration

Most PySpark code runs unchanged on Databricks/Synapse. Watch for:

- **HDFS-specific paths**: change `hdfs://` → `abfs://`
- **Hive UDFs**: re-register or replace with Spark SQL functions
- **YARN queue references**: replace with Spark configs
- **Custom Hadoop libraries**: re-evaluate need; many become unnecessary
- **HBase / Phoenix dependencies**: replace with Cosmos DB or Synapse SQL

### Streaming

| Source                             | Target                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Spark Structured Streaming on YARN | **Databricks Structured Streaming** with Unity Catalog or **Fabric RTI**         |
| Storm topology                     | Stream Analytics (low-mid complexity) or Databricks (high complexity)            |
| Flume agents                       | Event Hubs ingestion or ADF copy with self-hosted IR                             |
| Flink                              | **Confluent Cloud Flink on Azure** or rewrite in Databricks Structured Streaming |

## Phase 4 — Cutover (per workload, 1-2 weeks)

For each migrated workload:

- [ ] 14-day parallel run; daily reconciliation
- [ ] Downstream consumers (BI, APIs) repointed
- [ ] HDFS data made read-only (e.g., chmod -R 555)
- [ ] After 30 days stable, decommission Hadoop workload + free YARN capacity

## Phase 5 — Decommission (months 12-30)

- [ ] Final HDFS extract for cold/archive storage
- [ ] Hadoop cluster shut down per LOB
- [ ] Cluster hardware reclaimed / cloud subscription cancelled
- [ ] License termination (Cloudera, etc.)

## Cost during migration

Plan for **~2.5x your steady-state cost** during the 12-30 month window:

- Hadoop license (if Cloudera/HDP) + hardware/cloud
- Azure target running in parallel
- Migration team (often 5-15 FTE)
- Training (Spark engineers familiar with YARN need to learn Databricks/Synapse compute models)

## Common pitfalls

| Pitfall                                             | Mitigation                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Trying to migrate HBase as-is**                   | Cosmos DB has different consistency and partition semantics; redesign access patterns |
| **Lifting Oozie DAGs verbatim**                     | ADF / Fabric Data Pipelines have different triggers; redesign as dbt + scheduled runs |
| **Keeping all HDFS data**                           | 30-50% is dead data; use this as a forced cleanup                                     |
| **Leaving Hive SQL workloads on Spark SQL forever** | Modernize to dbt; you'll thank yourself in 2 years                                    |
| **Underestimating Sentry / Ranger replacement**     | Purview + Unity Catalog / Synapse RBAC needs explicit policy mapping                  |
| **Custom Java UDFs that depended on Hadoop libs**   | Often have pure-Spark equivalents; review one-by-one                                  |
| **Streaming workloads as an afterthought**          | Streaming has the longest cutover tail; plan early                                    |

## Trade-offs

✅ **Why modernize off Hadoop**

- Massive operational cost reduction (no YARN, HDFS, Zookeeper, HiveServer to operate)
- Better cloud-native integration (storage / compute separation)
- Newer formats (Delta) and engines (Photon, Direct Lake) are genuinely faster
- Easier hiring — modern Spark / dbt talent vs Hadoop ops talent

⚠️ **Why be patient**

- Hadoop estates have 7-15 years of business logic baked in
- HBase / Storm / custom YARN apps need real re-engineering
- Workflow modernization (Oozie → ADF/dbt) is bigger than people estimate
- Cutover requires consumer-side work — every BI report, every downstream API

## Related

- [Migrations — Teradata](teradata.md) — similar phased pattern
- [Migrations — Snowflake](snowflake.md)
- [Migrations — Informatica](informatica.md)
- [ADR 0001 — ADF + dbt over Airflow](../adr/0001-adf-dbt-over-airflow.md)
- [ADR 0006 — Purview over Atlas](../adr/0006-purview-over-atlas.md)
- Azure for Cloudera/Hadoop customers: https://learn.microsoft.com/azure/architecture/example-scenario/data/migrate-cloudera
