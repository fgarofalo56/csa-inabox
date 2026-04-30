# Complete Feature Mapping: Cloudera to Azure

**Every Cloudera component -- CDH, CDP Private Cloud, and CDP Public Cloud -- mapped to its Azure equivalent with migration complexity, CSA-in-a-Box evidence paths, and practical notes.**

---

## How to use this document

Each section below maps a Cloudera component or capability to its Azure-native equivalent. The migration complexity rating uses a three-tier scale:

| Rating | Meaning |
|---|---|
| **Low** | Configuration change or near-direct replacement; minimal code changes |
| **Medium** | Requires code modification, schema conversion, or workflow redesign |
| **High** | Fundamental redesign required; no direct equivalent exists |

---

## 1. Storage layer

### HDFS

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **HDFS (NameNode + DataNodes)** | ADLS Gen2 + OneLake | Medium | Directory structure maps to container/folder hierarchy. No NameNode HA to manage. Redundancy handled by LRS/ZRS/GRS. |
| **HDFS Federation** | Multiple ADLS Gen2 storage accounts | Low | Each HDFS namespace maps to a storage account or container. |
| **HDFS Snapshots** | ADLS Gen2 blob versioning + soft delete | Low | Enable versioning on storage account; no manual snapshot management. |
| **HDFS Encryption Zones** | ADLS Gen2 encryption (SSE + customer-managed keys) | Low | All data encrypted at rest by default. Customer-managed keys via Key Vault. |
| **HDFS Erasure Coding** | ADLS Gen2 storage tiers | Low | Erasure coding for storage efficiency replaced by hot/cool/archive tiering. |
| **WebHDFS / HttpFS** | ADLS Gen2 REST API / `abfss://` driver | Low | Standard REST API; Hadoop-compatible `abfss://` filesystem driver. |

### Kudu

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Apache Kudu** | Delta Lake on ADLS Gen2 | Medium | Kudu's fast-insert mutable storage maps to Delta Lake ACID transactions, MERGE operations, and time travel. See [Impala Migration](impala-migration.md) for Kudu-to-Delta conversion. |

---

## 2. SQL and query engines

### Hive

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Hive on Tez** | Databricks SQL + dbt models | Medium | HiveQL ports to Spark SQL with minor syntax changes. See playbook Section 6. |
| **Hive LLAP** | Databricks SQL Warehouse (Serverless) | Medium | LLAP's caching behavior replaced by Photon engine + result caching. |
| **Hive Metastore (HMS)** | Unity Catalog | Medium | HMS schemas export to Unity Catalog. Three-level namespace: catalog.schema.table. |
| **Hive ACID tables** | Delta tables | Medium | Hive ACID transactions replaced by Delta Lake ACID. MERGE, UPDATE, DELETE supported natively. |
| **Hive UDFs (Java)** | Python UDFs / pandas_udf / built-in functions | High | Java UDFs must be rewritten. Budget 30% of workload migration effort. See playbook Section 6.3. |
| **Hive SerDes** | Spark format readers / Delta Lake | Medium | Custom SerDes replaced by Spark's built-in format support or custom readers. |
| **Hive Views** | Databricks SQL views / dbt models | Low | Views port directly; consider converting to dbt models for lineage. |
| **Beeline CLI** | Databricks SQL CLI / Azure Data Studio | Low | Direct replacement for interactive SQL access. |

### Impala

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Impala (interactive SQL)** | Databricks SQL Warehouse | Medium | Impala SQL is close to Spark SQL. See [Impala Migration](impala-migration.md). |
| **Impala COMPUTE STATS** | Databricks `ANALYZE TABLE` | Low | Syntax change only. |
| **Impala metadata caching** | Databricks result caching + Photon | Low | Photon + adaptive query execution replace Impala's catalog caching. |
| **Impala Parquet reader** | Delta Lake (Parquet-native) | Low | Delta Lake reads Parquet natively with additional features (time travel, Z-ordering). |
| **Impala shell** | Databricks SQL CLI / JDBC | Low | Connection string change. |

---

## 3. Compute and processing

### Spark

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Spark on YARN** | Azure Databricks (Jobs + SQL) | Low-Medium | PySpark/Scala Spark code is highly portable. Remove YARN configs, update paths. See playbook Section 7. |
| **Spark Streaming (DStreams)** | Databricks Structured Streaming | Medium | DStreams deprecated; rewrite to Structured Streaming API. |
| **Spark Structured Streaming** | Databricks Structured Streaming | Low | Near-direct port; update source/sink configurations. |
| **spark-submit scripts** | Databricks Jobs API / Workflows | Low | Submit scripts become Job definitions (JSON/YAML). See playbook Section 7.3. |
| **Spark History Server** | Databricks Spark UI / Azure Monitor | Low | Built-in Spark UI per cluster; historical data in Azure Monitor. |
| **Spark Thrift Server** | Databricks SQL Warehouse | Low | JDBC/ODBC endpoint with Photon acceleration. |

### MapReduce

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **MapReduce jobs** | Databricks Spark jobs | High | MapReduce must be rewritten to Spark. No direct equivalent. |
| **Streaming MapReduce** | Spark Structured Streaming | High | Complete rewrite required. |

### YARN

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **YARN ResourceManager** | Databricks cluster autoscaling | Low | Managed by Databricks; no user-managed resource manager. |
| **YARN queues / Capacity Scheduler** | Databricks cluster policies | Low | Queue-based isolation becomes policy-based isolation. |
| **YARN NodeManager** | Databricks worker nodes | Low | Managed by Databricks auto-scaling. |
| **YARN ApplicationMaster** | Databricks driver node | Low | Transparent; Databricks manages driver lifecycle. |

---

## 4. Data ingestion and integration

### NiFi

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Apache NiFi** | Azure Data Factory + Logic Apps | Medium-High | Different paradigm. See [NiFi Migration](nifi-migration.md) for processor mapping. |
| **NiFi Registry** | ADF Git integration (Azure DevOps / GitHub) | Low | Version control model is different but functionally equivalent. |
| **NiFi clustering** | ADF Integration Runtime scaling | Low | ADF handles scaling internally. |
| **NiFi Site-to-Site** | ADF Self-Hosted Integration Runtime | Medium | SHIR provides secure on-prem to cloud data movement. |
| **MiNiFi (edge agents)** | Azure IoT Edge + ADF | Medium | Edge data collection and forwarding. |

### Sqoop

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Sqoop import (RDBMS to HDFS)** | ADF Copy Activity | Low | Direct replacement with more connectors and better parallelism. |
| **Sqoop export (HDFS to RDBMS)** | ADF Copy Activity (reverse) | Low | Same activity, different direction. |
| **Sqoop incremental import** | ADF tumbling window trigger + watermark | Low | ADF handles incremental patterns natively with watermarking. |

### Flume

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Flume agents (source/channel/sink)** | Event Hubs + Azure Functions | Medium | Event Hubs replaces the channel; Functions replace sink logic. |
| **Flume interceptors** | Event Hubs event processing + Functions | Medium | Transform logic moves to Functions or Databricks Structured Streaming. |
| **Flume to HDFS sink** | Event Hubs Capture (to ADLS Gen2) | Low | Event Hubs Capture writes Avro/Parquet directly to ADLS. |

---

## 5. Messaging and streaming

### Kafka

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Kafka brokers** | Azure Event Hubs (Kafka endpoint) | Low | Kafka wire-protocol compatible. Config change only. See ADR-0005. |
| **Kafka Connect** | ADF connectors / Event Hubs connectors | Medium | Reimplement connectors using ADF or custom Functions. |
| **Kafka Streams** | Databricks Structured Streaming / Azure Stream Analytics | Medium | Rewrite Kafka Streams apps to Spark Streaming or ASA. |
| **Schema Registry** | Azure Schema Registry (Event Hubs) | Low | Schema Registry built into Event Hubs namespace. |
| **Kafka MirrorMaker** | Event Hubs geo-DR / Event Hubs Capture | Low | Built-in geo-replication and capture. |
| **Streams Messaging Manager (SMM)** | Azure Monitor + Event Hubs metrics | Low | Monitoring and alerting via Azure Monitor dashboards. |
| **Kafka topics (retention)** | Event Hubs retention (1-90 days, or capture to ADLS) | Low | Configure retention per Event Hub; long-term via Capture. |

---

## 6. Orchestration

### Oozie

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Oozie Workflow** | ADF Pipeline / Databricks Workflows | Medium | See playbook Section 8 for conversion patterns. |
| **Oozie Coordinator** | ADF Schedule/Tumbling Window Trigger | Low | Time and data triggers map directly. |
| **Oozie Bundle** | ADF Execute Pipeline (nested) | Low | Group related pipelines into a parent. |
| **Oozie Fork/Join** | ADF parallel activities | Low | Native parallel execution in ADF. |
| **Oozie Decision node** | ADF If Condition / Switch | Low | Expression-based branching. |
| **Oozie Shell action** | ADF Custom Activity / Azure Batch | Medium | Arbitrary scripts via Azure Batch. |
| **Oozie Email action** | Logic App (triggered by ADF) | Low | ADF triggers Logic App for notifications. |
| **Oozie SLA monitoring** | ADF monitoring + alerts | Low | Azure Monitor alerts on pipeline duration/failure. |

---

## 7. Security and governance

### Ranger

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Ranger (database/table access)** | Unity Catalog GRANT | Medium | See playbook Section 9.1 for policy decomposition. |
| **Ranger column masking** | Unity Catalog column masks | Medium | Masking functions + ALTER TABLE SET COLUMN MASK. |
| **Ranger row-level filtering** | Unity Catalog row filters | Medium | Filter functions + ALTER TABLE SET ROW FILTER. |
| **Ranger HDFS policies** | ADLS Gen2 RBAC + ACLs | Medium | Azure IAM role assignments on containers/folders. |
| **Ranger Kafka policies** | Event Hubs RBAC | Low | Entra ID roles: Data Sender / Data Receiver. |
| **Ranger tag-based policies** | Purview classifications + sensitivity labels | Medium | Purview auto-classification replaces Atlas tags + Ranger tag policies. |
| **Ranger KMS** | Azure Key Vault | Low | Centralized key management with HSM backing. |
| **Ranger audit** | Azure Monitor + Log Analytics | Low | Unified audit trail across all services. |

### Atlas

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Atlas metadata catalog** | Microsoft Purview | Medium | Business glossary, classifications, data lineage. See ADR-0006. |
| **Atlas lineage tracking** | Purview lineage + ADF lineage + Unity Catalog lineage | Low | Automatic lineage from ADF pipelines and Databricks queries. |
| **Atlas classifications/tags** | Purview classifications + sensitivity labels | Medium | Auto-classification scans replace manual Atlas tagging. |
| **Atlas business glossary** | Purview business glossary | Low | Term-level mapping is straightforward. |
| **Atlas REST API** | Purview REST API / Purview SDK | Low | API-based catalog access with Python SDK. |

### Kerberos / Authentication

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Kerberos KDC** | Entra ID | Medium | Cloud-managed identity; no on-prem KDC. |
| **Keytab files** | Service principals + managed identities | Medium | Managed identities preferred for Azure service-to-service auth. |
| **kinit in scripts** | MSAL token acquisition / managed identity | Medium | Remove kinit calls; use DefaultAzureCredential. |
| **Sentry (legacy)** | Entra ID RBAC | Low | Sentry roles map cleanly to Entra ID groups + Unity Catalog grants. |

### Knox

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Apache Knox gateway** | Azure API Management | Medium | Knox topology-based URL rewriting becomes APIM policy-based routing. |
| **Knox SSO** | Entra ID SSO | Low | Enterprise SSO with SAML/OIDC. |

---

## 8. Cluster management and monitoring

### Cloudera Manager

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Cloudera Manager** | Azure Portal + Azure Monitor | Low | Service health, metrics, and alerting via Azure Monitor. |
| **CM host health checks** | Azure Monitor VM insights | Low | Built-in VM and service monitoring. |
| **CM service monitoring** | Azure Monitor + Databricks Admin Console | Low | Per-service dashboards and alerts. |
| **CM configuration management** | Bicep IaC / Terraform | Low | Infrastructure as Code replaces CM configuration profiles. |
| **CM rolling upgrades** | Managed by Azure services | Low | No manual upgrade orchestration. |
| **CM HDFS reports** | ADLS Gen2 storage metrics + Azure Monitor | Low | Built-in storage analytics. |
| **CM YARN reports** | Databricks cluster metrics | Low | Cluster utilization dashboards in Databricks admin console. |

### Hue

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Hue SQL editor** | Databricks SQL Editor / Azure Data Studio | Low | Direct replacement for interactive SQL. |
| **Hue job browser** | Databricks Workflows UI / ADF Monitor | Low | Built-in job monitoring per service. |
| **Hue file browser** | Azure Storage Explorer / Azure Portal | Low | GUI-based storage browsing. |
| **Hue Oozie editor** | ADF Pipeline editor (visual) | Low | Visual pipeline design in ADF Studio. |

---

## 9. CDP-specific components

### CDP Data Engineering (CDE)

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **CDE virtual clusters** | Databricks workspaces | Low | Workspace-level isolation replaces virtual cluster isolation. |
| **CDE Spark jobs** | Databricks Jobs | Low | Spark job definitions map directly. |
| **CDE Airflow** | Databricks Workflows / ADF | Medium | Airflow DAGs convert to Databricks multi-task jobs or ADF pipelines. |
| **CDE CLI** | Databricks CLI / REST API | Low | CLI tooling for job management. |
| **CDE job monitoring** | Databricks Jobs UI + Azure Monitor | Low | Built-in monitoring and alerting. |

For detailed CDE migration patterns, see [CDP Data Engineering Guide](cdp-data-engineering.md).

### CDP Machine Learning (CML)

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **CML Sessions** | Databricks Notebooks / Azure ML Compute | Low | Jupyter-compatible environments on both targets. |
| **CML Experiments** | MLflow on Databricks / Azure ML Experiments | Low | MLflow is available on both platforms. |
| **CML Models (serving)** | Databricks Model Serving / Azure ML Endpoints | Medium | Model packaging and serving configuration differs. |
| **CML Applied ML Prototypes** | Databricks Solution Accelerators | Low | Template-based quick-start patterns. |
| **CML Spark integration** | Databricks native Spark | Low | Tighter integration on Databricks. |

### CDP Data Warehouse (CDW)

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **CDW Hive Virtual Warehouse** | Databricks SQL Warehouse | Medium | HiveQL to Spark SQL conversion. |
| **CDW Impala Virtual Warehouse** | Databricks SQL Warehouse | Medium | See [Impala Migration](impala-migration.md). |
| **CDW auto-scaling** | Databricks SQL Serverless auto-scaling | Low | Serverless scaling on Databricks is more granular. |

---

## 10. Infrastructure services

### ZooKeeper

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **ZooKeeper** | Managed by Azure services internally | Low | No user-managed ZooKeeper. Event Hubs, Databricks, and Cosmos DB handle coordination internally. |

### Miscellaneous

| Cloudera component | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| **Cloudera Navigator (legacy)** | Microsoft Purview | Medium | Legacy governance tool; mapped to Purview. |
| **Cloudera Data Steward Studio** | Purview Data Catalog | Low | Data stewardship and quality monitoring. |
| **Cloudera Replication Manager** | ADF Copy Activity / ADLS geo-replication | Low | Data replication and DR. |
| **Cloudera Workload XM** | Databricks Overwatch / Azure Monitor | Low | Workload performance analysis. |
| **HBase** | Azure Cosmos DB (NoSQL or Table API) | High | Wide-column key-value; requires schema remapping. |
| **Phoenix (SQL on HBase)** | Cosmos DB SQL API / Azure SQL | High | SQL layer over key-value store; redesign likely. |
| **Solr (Cloudera Search)** | Azure AI Search | Medium | Full-text search; index schema conversion required. |

---

## Migration complexity summary

| Complexity | Component count | Examples |
|---|---|---|
| **Low** | 28 | YARN, ZooKeeper, Sqoop, Kafka, Hue, Beeline, Knox SSO, CM monitoring |
| **Medium** | 15 | HDFS, Hive, Impala, NiFi, Ranger, Atlas, Kerberos, Oozie, CDE Airflow |
| **High** | 5 | Hive UDFs, MapReduce, HBase, Phoenix, NiFi (complex flows) |

**Takeaway:** The majority of Cloudera components have low-to-medium complexity migrations. The highest-effort items are Hive UDFs, HBase, and complex NiFi flows. Plan accordingly and staff UDF rewrites early.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
