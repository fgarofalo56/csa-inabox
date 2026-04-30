# Complete Feature Mapping: Hadoop to Azure

**A component-by-component mapping of 35+ Hadoop ecosystem services to their Azure equivalents, with migration complexity ratings and recommended approaches.**

---

## How to read this guide

Each Hadoop component is mapped to one or more Azure services. The migration complexity rating uses a three-tier system:

| Rating | Meaning | Typical effort |
|---|---|---|
| **Low** | Near drop-in replacement, minimal code changes | Days to weeks |
| **Medium** | Functional equivalent exists but requires redesign | Weeks to months |
| **High** | No direct equivalent; requires re-architecture | Months |

---

## Storage layer

### 1. HDFS (Hadoop Distributed File System)

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | HDFS | **ADLS Gen2** |
| Protocol | `hdfs://` | `abfss://` (HDFS-compatible) |
| Replication | 3x block replication across DataNodes | LRS (3x within DC), ZRS (3x across zones), GRS (6x across regions) |
| Max file size | Limited by available disk | 5 TB per file (append for larger) |
| Max namespace | ~500M files per NameNode | Virtually unlimited |
| Snapshots | HDFS snapshots (directory-level) | Soft delete + Delta time travel |
| ACLs | POSIX ACLs | POSIX ACLs + Azure RBAC |
| Encryption | HDFS Transparent Encryption (manual KMS) | Enabled by default (Microsoft-managed or CMK) |
| **Complexity** | | **Low** |

**Migration path:** DistCp or AzCopy. See [HDFS Migration](hdfs-migration.md).

### 2. HDFS Federation

| Aspect | Hadoop | Azure |
|---|---|---|
| Purpose | Multiple NameNodes for namespace partitioning | Not needed — ADLS has no NameNode bottleneck |
| Azure equivalent | N/A | Single ADLS account scales to exabytes |
| **Complexity** | | **Low** (problem eliminated) |

### 3. HDFS Erasure Coding

| Aspect | Hadoop | Azure |
|---|---|---|
| Purpose | Reduce 3x replication overhead to ~1.5x | ADLS uses LRS/ZRS/GRS — erasure coding is internal |
| Azure equivalent | N/A | Storage redundancy is managed by the platform |
| **Complexity** | | **Low** (problem eliminated) |

---

## Compute layer

### 4. MapReduce

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | MapReduce v2 (on YARN) | **Databricks Spark** or **Fabric Spark** |
| Programming model | Map + Reduce phases | Spark RDDs / DataFrames (superset of MapReduce) |
| Performance | 10-100x slower than Spark for most workloads | Spark + Photon engine |
| **Complexity** | | **Medium** (rewrite MapReduce Java to Spark) |

**Migration path:** Rewrite MapReduce jobs as Spark jobs. Most MapReduce patterns have direct Spark equivalents that are simpler and faster.

### 5. YARN (Yet Another Resource Negotiator)

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | YARN ResourceManager + NodeManagers | **Databricks cluster manager** or **Fabric Spark pools** |
| Resource allocation | Static queues, capacity scheduler | Dynamic auto-scaling, cluster policies |
| Multi-tenancy | YARN queues with capacity/fair scheduler | Databricks workspace isolation, SQL warehouse concurrency |
| Job types | MapReduce, Spark, Tez, custom containers | Spark jobs, SQL queries, ML training |
| **Complexity** | | **Low** (replaced by managed compute) |

### 6. Tez

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Apache Tez (Hive execution engine) | **Databricks Photon** or **Spark SQL engine** |
| Purpose | DAG-based execution replacing MapReduce for Hive | Photon provides similar DAG optimization + vectorized execution |
| **Complexity** | | **Low** (transparent replacement) |

### 7. Spark on YARN

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Apache Spark submitted to YARN | **Databricks** or **Fabric Spark** |
| Submission | `spark-submit` to YARN cluster | Databricks Jobs API, Fabric notebook scheduling |
| Cluster management | Static YARN allocation | Auto-scaling clusters with spot instances |
| Libraries | Manual JAR management on HDFS/local | Databricks cluster libraries, init scripts, Fabric environments |
| **Complexity** | | **Low-Medium** |

**Migration path:** See [Spark Migration](spark-migration.md).

---

## SQL and query engines

### 8. Apache Hive

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | HiveServer2 + Hive Metastore | **Databricks SQL** + **Unity Catalog** or **Fabric SQL endpoint** |
| Query language | HiveQL | SparkSQL (HiveQL-compatible with minor differences) |
| Metastore | MySQL/PostgreSQL-backed HMS | Unity Catalog or Fabric OneLake catalog |
| Table format | Managed/external, ORC/Parquet | Delta Lake tables |
| Performance | Hive LLAP or Tez | Photon engine (10-50x faster for most queries) |
| **Complexity** | | **Medium** |

**Migration path:** See [Hive Migration](hive-migration.md).

### 9. Presto / Trino

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Presto or Trino on Hadoop | **Databricks SQL** (serverless) or **Fabric SQL endpoint** |
| Use case | Interactive SQL on HDFS data | Interactive SQL on Delta Lake data |
| Federation | Multi-source query federation | Databricks Lakehouse Federation or Fabric shortcuts |
| **Complexity** | | **Low-Medium** |

### 10. Apache Pig

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Pig Latin scripts on MapReduce/Tez | **SparkSQL** or **dbt models** |
| Status | Effectively deprecated; last release 2017 | N/A |
| **Complexity** | | **Medium** (rewrite Pig Latin to SQL/PySpark) |

**Migration path:** Convert Pig scripts to SparkSQL or dbt models. Pig Latin's data flow model maps well to dbt's transformation-centric approach.

### 11. Apache Impala

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Impala MPP SQL engine | **Databricks SQL** (serverless) |
| Use case | Low-latency interactive SQL | Sub-second queries via Photon |
| Catalog | Impala shares Hive metastore | Unity Catalog |
| **Complexity** | | **Low** |

---

## NoSQL and key-value stores

### 12. Apache HBase

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | HBase on HDFS | **Cosmos DB** (Cassandra API or NoSQL API) |
| Data model | Column-family, row-key partitioned | Document/key-value, partition-key based |
| Scaling | Region splitting across RegionServers | Automatic RU-based scaling |
| Consistency | Strong (single-row), eventual (cross-region) | Tunable (strong to eventual) |
| API | HBase Java client, REST, Thrift | Cassandra CQL, Cosmos SDK, REST |
| **Complexity** | | **High** |

**Migration path:** See [HBase Migration](hbase-migration.md).

### 13. Apache Phoenix

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | SQL layer on HBase | **Cosmos DB** with SQL query or **Azure SQL** |
| Use case | SQL access to HBase data | SQL access to Cosmos or relational data |
| **Complexity** | | **High** (follows HBase migration) |

---

## Streaming and messaging

### 14. Apache Kafka (on Hadoop clusters)

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Kafka brokers on Hadoop nodes | **Event Hubs** (Kafka-compatible) |
| Protocol | Kafka protocol | Kafka protocol (compatible) |
| Management | Manual broker management, ZK dependency | Fully managed, auto-inflate |
| Retention | Configurable, disk-limited | Configurable, up to 90 days (standard) or unlimited (capture) |
| **Complexity** | | **Low** |

**Migration path:** See [Kafka, Oozie, and Supporting Services](kafka-oozie-migration.md).

### 15. Apache Storm

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Storm topologies on YARN | **Databricks Structured Streaming** or **Fabric RTI** |
| Programming model | Spouts + bolts | Spark structured streaming micro-batches |
| **Complexity** | | **High** (rewrite required) |

### 16. Apache Flink

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Flink on YARN | **Databricks Structured Streaming** or **Confluent Flink on Azure** |
| Programming model | DataStream / Table API | Spark structured streaming or native Flink (Confluent) |
| **Complexity** | | **Medium-High** |

### 17. Apache Flume

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Flume agents collecting log data | **Event Hubs** + **ADF** or **Azure Monitor Agent** |
| Pattern | Source → Channel → Sink | Event producer → Event Hubs → consumer |
| **Complexity** | | **Low-Medium** |

---

## Workflow and orchestration

### 18. Apache Oozie

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Oozie coordinator + workflow | **ADF pipelines** or **Databricks Workflows** |
| Triggers | Time-based coordinators | ADF schedule/event/tumbling window triggers |
| DAG model | XML workflow definitions | Visual designer + JSON/YAML + Bicep IaC |
| Sub-workflows | Oozie sub-workflow action | ADF execute pipeline activity |
| Error handling | Kill node + email | ADF failure paths, Logic Apps alerts |
| **Complexity** | | **Medium** |

### 19. Apache Airflow (on Hadoop)

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Airflow on Hadoop edge nodes | **ADF** (Airflow-like) or **Airflow on AKS** (if preferred) |
| DAG model | Python DAGs | ADF pipelines or native Airflow DAGs |
| **Complexity** | | **Low** (Airflow concepts transfer directly) |

---

## Data integration

### 20. Apache Sqoop

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Sqoop import/export (RDBMS ↔ HDFS) | **ADF JDBC/ODBC connectors** |
| Pattern | RDBMS → HDFS (bulk import) | RDBMS → ADLS Gen2 (copy activity) |
| CDC | Not supported natively | ADF CDC connectors, Debezium on Event Hubs |
| **Complexity** | | **Low** |

### 21. Apache NiFi

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | NiFi data flow manager | **ADF** or **Fabric Data Pipelines** |
| Pattern | Visual data flow with processors | Visual pipeline with activities |
| Edge collection | NiFi MiNiFi | IoT Hub / IoT Edge |
| **Complexity** | | **Medium** |

---

## Security and governance

### 22. Apache Ranger

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Ranger policy admin + plugins | **Purview access policies** + **Unity Catalog** + **Azure RBAC** |
| Policy model | Resource-based (path, table, column) | Resource-based + attribute-based (ABAC) |
| Audit | Ranger audit to Solr/HDFS | Azure Monitor + Purview audit logs |
| **Complexity** | | **Medium** |

**Migration path:** See [Security Migration](security-migration.md).

### 23. Apache Sentry

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Sentry authorization | **Purview** + **Unity Catalog** |
| Status | Deprecated (merged into Ranger in CDP) | N/A |
| **Complexity** | | **Medium** |

### 24. Apache Atlas

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Atlas metadata catalog + lineage | **Microsoft Purview** |
| Catalog | Type-based entity catalog | Automated scanning + classification |
| Lineage | Atlas lineage API | Purview lineage (ADF, Databricks, Fabric native) |
| Glossary | Atlas glossary terms | Purview business glossary |
| **Complexity** | | **Medium** |

### 25. Apache Knox

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Knox gateway (reverse proxy) | **Azure API Management** or **Entra ID app proxy** |
| Pattern | Single entry point for Hadoop REST APIs | API gateway with Entra authentication |
| **Complexity** | | **Low** |

### 26. Kerberos KDC

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | MIT Kerberos or Active Directory KDC | **Entra ID** (formerly Azure AD) |
| Authentication | Kerberos tickets (kinit, keytabs) | OAuth2 tokens, managed identities |
| Service-to-service | Kerberos principals | Managed identities (no credentials to rotate) |
| **Complexity** | | **Medium** |

---

## Cluster management

### 27. Apache Ambari

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Ambari server + agents | **Databricks workspace UI** or **Fabric admin portal** |
| Capabilities | Service management, config, monitoring, alerts | Cluster management, job monitoring, cost tracking |
| **Complexity** | | **Low** (replaced by managed service consoles) |

### 28. Cloudera Manager

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Cloudera Manager (commercial) | **Databricks workspace** + **Azure Monitor** |
| Capabilities | Service management, rolling upgrades, diagnostics | Managed upgrades, auto-diagnostics, Overwatch |
| **Complexity** | | **Low** |

### 29. Apache ZooKeeper

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | ZooKeeper ensemble (3-5 nodes) | **Not needed** — managed by Azure services internally |
| Use cases | Leader election, config management, distributed locks | Built into Databricks, Event Hubs, Cosmos DB |
| **Complexity** | | **Low** (problem eliminated) |

---

## File formats

### 30. Apache ORC

| Aspect | Hadoop | Azure |
|---|---|---|
| Format | ORC columnar format | **Delta Lake** (Parquet-based) |
| Migration | Convert ORC → Parquet → Delta | Spark `read.orc().write.format("delta")` |
| **Complexity** | | **Low** |

### 31. Apache Parquet

| Aspect | Hadoop | Azure |
|---|---|---|
| Format | Parquet columnar format | **Delta Lake** (Parquet + transaction log) |
| Migration | Add Delta transaction log to existing Parquet | `CONVERT TO DELTA` command |
| **Complexity** | | **Low** |

### 32. Apache Avro

| Aspect | Hadoop | Azure |
|---|---|---|
| Format | Avro row-based format | **Delta Lake** or keep Avro for streaming |
| Migration | Convert Avro → Delta for analytics | Spark `read.avro().write.format("delta")` |
| **Complexity** | | **Low** |

---

## Machine learning

### 33. Spark MLlib

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | MLlib on YARN Spark | **Databricks MLflow** + **MLlib** or **Azure ML** |
| Model registry | Manual / custom | MLflow Model Registry, Azure ML model registry |
| Experiment tracking | Manual / custom | MLflow tracking, Azure ML experiments |
| **Complexity** | | **Low** |

### 34. Apache Mahout

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Mahout (MapReduce-based ML) | **Spark MLlib** or **Azure ML** |
| Status | Effectively abandoned | N/A |
| **Complexity** | | **Medium** (rewrite to modern ML frameworks) |

---

## Data serialization and schema

### 35. Hive SerDe (Serializer/Deserializer)

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Custom SerDe classes for Hive | **Delta Lake schema evolution** + Spark readers |
| Pattern | Custom Java classes for parsing | Built-in format support (JSON, CSV, XML, etc.) |
| **Complexity** | | **Low-Medium** |

### 36. Apache Thrift

| Aspect | Hadoop | Azure |
|---|---|---|
| Service | Thrift RPC for HBase, Hive | **REST APIs** or **gRPC** |
| Migration | Replace Thrift clients with REST/SDK calls | Use Cosmos SDK, Databricks REST API |
| **Complexity** | | **Low-Medium** |

---

## Summary: migration complexity by component

| Complexity | Components | Count |
|---|---|---|
| **Low** | HDFS, HDFS Federation, Erasure Coding, YARN, Tez, Kafka, Sqoop, Knox, Ambari, CM, ZooKeeper, ORC, Parquet, Avro, Spark MLlib, Impala | 16 |
| **Medium** | MapReduce, Hive, Presto/Trino, Pig, Oozie, Flume, Ranger, Sentry, Atlas, Kerberos, NiFi, Airflow, SerDe, Thrift, Mahout, Flink | 16 |
| **High** | HBase, Phoenix, Storm | 3 |

**80% of Hadoop components have low-to-medium migration complexity.** The high-complexity components (HBase, Phoenix, Storm) affect a minority of deployments and have well-documented migration paths.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Why Azure over Hadoop](why-azure-over-hadoop.md) | [TCO Analysis](tco-analysis.md) | [Migration Hub](index.md)
