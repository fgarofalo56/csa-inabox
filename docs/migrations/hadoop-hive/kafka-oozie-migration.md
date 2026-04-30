# Kafka, Oozie, and Supporting Services Migration

**A comprehensive guide for migrating Hadoop supporting services — Kafka, Oozie, Sqoop, Flume, ZooKeeper, and Pig — to their Azure equivalents.**

---

## Overview

Beyond the core storage (HDFS), SQL (Hive), compute (Spark), and NoSQL (HBase) components, Hadoop ecosystems include a constellation of supporting services that handle messaging, orchestration, data ingestion, coordination, and legacy scripting. This guide covers the migration path for each.

---

## 1. Apache Kafka to Azure Event Hubs

### Why Event Hubs?

Azure Event Hubs provides a Kafka-compatible endpoint. Kafka producers and consumers can connect to Event Hubs without code changes — only connection string and authentication configuration changes.

### Protocol compatibility

| Kafka feature | Event Hubs support |
|---|---|
| Kafka protocol (0.10+) | Full support |
| Producer API | Full support |
| Consumer API | Full support |
| Consumer groups | Full support |
| Topic partitions | Full support (up to 1024 per Event Hub) |
| Kafka Streams | Supported (with limitations) |
| Kafka Connect | Supported (source and sink connectors) |
| Schema Registry | Use Azure Schema Registry (Avro, JSON Schema, Protobuf) |
| Transactions | Not supported |
| Compacted topics | Supported (Event Hubs Premium/Dedicated) |

### Configuration changes

```properties
# BEFORE: Kafka on Hadoop
bootstrap.servers=kafka1.hadoop.local:9092,kafka2.hadoop.local:9092,kafka3.hadoop.local:9092
security.protocol=SASL_PLAINTEXT
sasl.mechanism=GSSAPI
sasl.kerberos.service.name=kafka

# AFTER: Event Hubs with Kafka protocol
bootstrap.servers=mynamespace.servicebus.windows.net:9093
security.protocol=SASL_SSL
sasl.mechanism=PLAIN
sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required \
  username="$ConnectionString" \
  password="Endpoint=sb://mynamespace.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=<key>";
```

### Python producer example

```python
# BEFORE: Kafka on Hadoop
from kafka import KafkaProducer

producer = KafkaProducer(
    bootstrap_servers=["kafka1:9092", "kafka2:9092"],
    security_protocol="SASL_PLAINTEXT",
    sasl_mechanism="GSSAPI",
    sasl_kerberos_service_name="kafka"
)
producer.send("orders", value=b'{"order_id": "12345"}')

# AFTER: Event Hubs (Kafka protocol)
from kafka import KafkaProducer

producer = KafkaProducer(
    bootstrap_servers=["mynamespace.servicebus.windows.net:9093"],
    security_protocol="SASL_SSL",
    sasl_mechanism="PLAIN",
    sasl_plain_username="$ConnectionString",
    sasl_plain_password="Endpoint=sb://mynamespace.servicebus.windows.net/;SharedAccessKeyName=send-policy;SharedAccessKey=<key>"
)
producer.send("orders", value=b'{"order_id": "12345"}')
```

### Topic mapping

| Kafka concept | Event Hubs concept |
|---|---|
| Kafka cluster | Event Hubs namespace |
| Topic | Event Hub (within namespace) |
| Partition | Partition (1:1 mapping) |
| Consumer group | Consumer group |
| Broker | Managed by Azure (no concept of individual brokers) |
| ZooKeeper | Not needed (managed internally) |
| Retention | Configurable: 1-90 days (Standard), unlimited with Capture |

### Throughput tiers

| Event Hubs tier | Throughput | Best for |
|---|---|---|
| Basic | 1 TU (1 MB/s ingress, 2 MB/s egress) | Dev/test |
| Standard | 1-40 TUs (per TU: 1 MB/s in, 2 MB/s out) | Most production workloads |
| Premium | 1-16 PUs (higher throughput per unit) | High-throughput, low-latency |
| Dedicated | 1-20 CUs (single-tenant) | Regulated industries, guaranteed isolation |

### Event Hubs Capture (replaces Kafka Connect to HDFS)

```json
{
    "captureDescription": {
        "enabled": true,
        "encoding": "Avro",
        "intervalInSeconds": 300,
        "sizeLimitInBytes": 314572800,
        "destination": {
            "name": "EventHubArchive.AzureBlockBlob",
            "properties": {
                "storageAccountResourceId": "/subscriptions/.../storageAccounts/datalake",
                "blobContainer": "raw",
                "archiveNameFormat": "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}"
            }
        }
    }
}
```

This replaces the common Kafka → HDFS pipeline with zero custom code.

---

## 2. Apache Oozie to ADF / Databricks Workflows

### Oozie architecture

Oozie consists of:

- **Workflow:** A DAG of actions (Spark, Hive, Shell, Java, etc.)
- **Coordinator:** Time-based or data-driven trigger for workflows
- **Bundle:** A collection of coordinators

### Mapping Oozie to ADF

| Oozie concept | ADF equivalent |
|---|---|
| Workflow | Pipeline |
| Coordinator (time) | Schedule trigger |
| Coordinator (data-ready) | Event trigger / tumbling window trigger |
| Bundle | Pipeline group (or ADF factory organization) |
| Action: Hive | Databricks notebook activity or HDInsight Hive activity |
| Action: Spark | Databricks notebook/JAR activity |
| Action: Shell | Azure Batch activity or Azure Function |
| Action: Java | Databricks JAR activity or Azure Function |
| Action: Sqoop | Copy activity with JDBC connector |
| Action: DistCp | Copy activity (ADLS to ADLS) |
| Action: Email | Web activity (Logic Apps / SendGrid) |
| Action: SubWorkflow | Execute pipeline activity |
| Decision node | If condition / Switch activity |
| Fork/Join | Parallel activity branches |
| Kill node | Failure path + alert |

### Example: Oozie workflow to ADF pipeline

**Oozie workflow.xml (before):**

```xml
<workflow-app name="daily-etl" xmlns="uri:oozie:workflow:0.5">
    <start to="extract-orders"/>

    <action name="extract-orders">
        <sqoop xmlns="uri:oozie:sqoop-action:0.2">
            <command>import --connect jdbc:mysql://db:3306/prod
                --table orders --target-dir /staging/orders
                --incremental lastmodified --check-column updated_at
                --last-value ${lastRunTimestamp}</command>
        </sqoop>
        <ok to="transform-orders"/>
        <error to="send-alert"/>
    </action>

    <action name="transform-orders">
        <spark xmlns="uri:oozie:spark-action:0.2">
            <master>yarn</master>
            <mode>cluster</mode>
            <name>TransformOrders</name>
            <jar>hdfs:///apps/etl/transform.py</jar>
            <arg>--date=${today}</arg>
        </spark>
        <ok to="load-warehouse"/>
        <error to="send-alert"/>
    </action>

    <action name="load-warehouse">
        <hive xmlns="uri:oozie:hive-action:0.2">
            <script>load_warehouse.hql</script>
            <param>date=${today}</param>
        </hive>
        <ok to="end"/>
        <error to="send-alert"/>
    </action>

    <action name="send-alert">
        <email xmlns="uri:oozie:email-action:0.1">
            <to>data-team@company.com</to>
            <subject>ETL Failed: ${wf:name()}</subject>
            <body>Action ${wf:lastErrorNode()} failed.</body>
        </email>
        <ok to="kill"/>
        <error to="kill"/>
    </action>

    <kill name="kill">
        <message>Workflow failed: ${wf:errorMessage(wf:lastErrorNode())}</message>
    </kill>
    <end name="end"/>
</workflow-app>
```

**ADF pipeline (after) — conceptual JSON:**

```json
{
    "name": "daily-etl",
    "activities": [
        {
            "name": "extract-orders",
            "type": "Copy",
            "inputs": [{"type": "MySqlSource", "query": "SELECT * FROM orders WHERE updated_at > @pipeline().parameters.lastRunTimestamp"}],
            "outputs": [{"type": "AzureBlobFSSink", "path": "raw/staging/orders/"}],
            "dependsOn": []
        },
        {
            "name": "transform-orders",
            "type": "DatabricksNotebook",
            "typeProperties": {
                "notebookPath": "/etl/transform_orders",
                "baseParameters": {"date": "@pipeline().parameters.today"}
            },
            "dependsOn": [{"activity": "extract-orders", "dependencyConditions": ["Succeeded"]}]
        },
        {
            "name": "load-warehouse",
            "type": "DatabricksNotebook",
            "typeProperties": {
                "notebookPath": "/etl/load_warehouse",
                "baseParameters": {"date": "@pipeline().parameters.today"}
            },
            "dependsOn": [{"activity": "transform-orders", "dependencyConditions": ["Succeeded"]}]
        }
    ],
    "triggers": [
        {
            "name": "daily-schedule",
            "type": "ScheduleTrigger",
            "recurrence": {"frequency": "Day", "interval": 1, "startTime": "02:00:00"}
        }
    ]
}
```

### Mapping Oozie to Databricks Workflows

For teams going all-in on Databricks, Databricks Workflows provides a native alternative to ADF:

| Oozie concept | Databricks Workflows equivalent |
|---|---|
| Workflow | Multi-task job |
| Action: Spark | Notebook task or Spark submit task |
| Action: Hive | SQL task |
| Action: Shell | Custom Python task |
| Decision node | Conditional task (if/else) |
| Fork/Join | Parallel task execution |
| Coordinator | Job schedule (cron) |
| Error handling | Task retry + email notification |

---

## 3. Apache Sqoop to ADF JDBC Connector

### Sqoop import pattern

```bash
# Sqoop import from MySQL to HDFS
sqoop import \
  --connect jdbc:mysql://db-server:3306/production \
  --username etl_user \
  --password-file hdfs:///credentials/mysql.password \
  --table orders \
  --target-dir /staging/orders/ \
  --as-parquetfile \
  --num-mappers 8 \
  --split-by order_id \
  --incremental lastmodified \
  --check-column updated_at \
  --last-value "2025-04-29 00:00:00"
```

### ADF Copy Activity replacement

```json
{
    "name": "import-orders",
    "type": "Copy",
    "typeProperties": {
        "source": {
            "type": "MySqlSource",
            "query": "SELECT * FROM orders WHERE updated_at > '@{pipeline().parameters.lastModified}'"
        },
        "sink": {
            "type": "ParquetSink",
            "storeSettings": {
                "type": "AzureBlobFSWriteSettings"
            },
            "formatSettings": {
                "type": "ParquetWriteSettings"
            }
        },
        "parallelCopies": 8
    },
    "inputs": [{"referenceName": "MySqlDataset", "type": "DatasetReference"}],
    "outputs": [{"referenceName": "ADLSParquetDataset", "type": "DatasetReference"}]
}
```

### ADF advantages over Sqoop

| Feature | Sqoop | ADF Copy Activity |
|---|---|---|
| Supported sources | JDBC only | 100+ connectors (SaaS, databases, files, APIs) |
| CDC support | Manual incremental mode | CDC connectors for SQL Server, Oracle, PostgreSQL |
| Monitoring | Oozie logs | ADF Monitor, Azure Monitor, Log Analytics |
| Retry logic | Manual Oozie configuration | Built-in retry policies |
| Data preview | None | Visual data preview |
| Schema drift | Not handled | Schema drift handling built-in |

---

## 4. Apache Flume to Event Hubs + ADF

### Flume architecture

Flume agents collect, aggregate, and move log data:

```
Source (e.g., syslog, file tail) → Channel (memory/file) → Sink (HDFS, Kafka)
```

### Azure replacements by Flume pattern

| Flume pattern | Azure replacement |
|---|---|
| File tail → HDFS | Azure Monitor Agent → Log Analytics, or ADF file watcher → ADLS |
| Syslog → HDFS | Azure Monitor Agent → Log Analytics → ADLS export |
| HTTP source → HDFS | Event Hubs HTTP endpoint → Capture to ADLS |
| Kafka source → HDFS | Event Hubs → Capture to ADLS (zero code) |
| Custom source → HDFS | Azure Function → Event Hubs → Capture to ADLS |
| Flume interceptors | Event Hubs + Stream Analytics (transformation) |

### Example: log collection replacement

```python
# BEFORE: Flume agent config
# agent.sources = tail-source
# agent.sources.tail-source.type = exec
# agent.sources.tail-source.command = tail -F /var/log/app.log
# agent.sinks.hdfs-sink.type = hdfs
# agent.sinks.hdfs-sink.hdfs.path = hdfs:///logs/app/%Y/%m/%d/

# AFTER: Azure Monitor Agent collects logs natively
# Or use a lightweight Python script to push to Event Hubs:
from azure.eventhub import EventHubProducerClient, EventData

producer = EventHubProducerClient.from_connection_string(conn_str, eventhub_name="app-logs")

def tail_and_send(log_path):
    with open(log_path, 'r') as f:
        f.seek(0, 2)  # Go to end of file
        while True:
            line = f.readline()
            if line:
                batch = producer.create_batch()
                batch.add(EventData(line.strip()))
                producer.send_batch(batch)
```

---

## 5. Apache ZooKeeper: no migration needed

### Why ZooKeeper disappears

ZooKeeper provides distributed coordination for Hadoop services:

- HDFS NameNode HA (leader election)
- YARN ResourceManager HA
- HBase RegionServer coordination
- Kafka broker coordination
- Oozie HA

In Azure, every service that needed ZooKeeper manages its own coordination internally:

| Hadoop service needing ZK | Azure service | ZK equivalent |
|---|---|---|
| HDFS NameNode HA | ADLS Gen2 (managed HA) | Not needed |
| YARN RM HA | Databricks (managed) | Not needed |
| HBase RegionServer | Cosmos DB (managed) | Not needed |
| Kafka broker | Event Hubs (managed) | Not needed |
| Oozie HA | ADF (managed) | Not needed |

**Action:** Do not migrate ZooKeeper. It is eliminated by the move to managed services.

---

## 6. Apache Pig: convert to SparkSQL or dbt

### Pig Latin to SparkSQL mapping

| Pig Latin | SparkSQL |
|---|---|
| `LOAD 'path' USING PigStorage(',')` | `spark.read.csv('path')` |
| `FILTER alias BY condition` | `WHERE condition` |
| `FOREACH alias GENERATE field` | `SELECT field` |
| `GROUP alias BY field` | `GROUP BY field` |
| `JOIN a BY key, b BY key` | `a JOIN b ON a.key = b.key` |
| `ORDER alias BY field` | `ORDER BY field` |
| `STORE alias INTO 'path'` | `.write.save('path')` |
| `DISTINCT alias` | `SELECT DISTINCT *` |
| `UNION alias1, alias2` | `alias1 UNION ALL alias2` |
| `FLATTEN(bag)` | `LATERAL VIEW explode(bag)` |

### Example conversion

```
-- BEFORE: Pig Latin
orders = LOAD '/data/orders' USING PigStorage(',')
    AS (order_id:chararray, customer_id:chararray, amount:double, date:chararray);

filtered = FILTER orders BY date >= '2025-01-01';

grouped = GROUP filtered BY customer_id;

aggregated = FOREACH grouped GENERATE
    group AS customer_id,
    COUNT(filtered) AS order_count,
    SUM(filtered.amount) AS total_amount;

sorted = ORDER aggregated BY total_amount DESC;

STORE sorted INTO '/output/customer_summary' USING PigStorage('\t');
```

```sql
-- AFTER: SparkSQL (or dbt model)
SELECT
    customer_id,
    COUNT(*) AS order_count,
    SUM(amount) AS total_amount
FROM silver.orders
WHERE date >= '2025-01-01'
GROUP BY customer_id
ORDER BY total_amount DESC;
```

### Migration recommendation

Pig is effectively deprecated (last major release in 2017). Do not port Pig scripts line-by-line. Instead:

1. Understand the business logic of each Pig script
2. Rewrite as SparkSQL queries or dbt models
3. Add tests (dbt schema tests, Great Expectations)
4. Document the transformation in dbt YAML

---

## Migration priority order

| Service | Priority | Rationale |
|---|---|---|
| ZooKeeper | N/A | Eliminated automatically by managed services |
| Sqoop | High (early) | Needed for ongoing data ingestion during migration |
| Kafka | High (early) | Streaming pipelines depend on messaging |
| Flume | Medium | Often replaced by Azure Monitor Agent early |
| Oozie | Medium (parallel) | Migrate as workloads move; last Oozie job triggers decommission |
| Pig | Low | Deprecated; convert during Hive/Spark migration |

---

## Related

- [Feature Mapping](feature-mapping-complete.md) — all component mappings
- [Security Migration](security-migration.md) — securing Event Hubs, ADF
- [Hive Migration](hive-migration.md) — SQL workload migration
- [Migration Hub](index.md) — full migration center

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Feature Mapping](feature-mapping-complete.md) | [Security Migration](security-migration.md) | [Migration Hub](index.md)
