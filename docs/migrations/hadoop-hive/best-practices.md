# Best Practices: Hadoop to Azure Migration

**Operational best practices for planning, executing, and completing a Hadoop-to-Azure migration, covering cluster decomposition, parallel-run validation, decommission planning, edge case handling, and team retraining.**

---

## 1. Cluster decomposition strategy

### The decomposition principle

Do not migrate your Hadoop cluster as a monolith. Decompose it into independent workloads and migrate each one separately. This reduces risk, enables parallel work streams, and allows early wins.

### Step 1: Inventory and classify

Create a workload inventory with four tiers:

| Tier                 | Description                                              | Migration action                                        | Typical percentage |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ------------------ |
| **A — Direct port**  | Spark/Hive jobs reading Parquet/Delta, standard patterns | Port to Databricks/Fabric with minimal changes          | 20-30%             |
| **B — Modernize**    | Hive SQL workloads, Pig scripts, simple MapReduce        | Convert to dbt + SparkSQL                               | 20-30%             |
| **C — Re-platform**  | HBase, Storm, Flink, custom YARN apps                    | Redesign for Cosmos DB, Functions, Databricks Streaming | 10-20%             |
| **D — Decommission** | Stale data, abandoned jobs, unused tables                | Archive evidence and delete                             | 30-50%             |

### Step 2: Identify Tier D first

Hadoop clusters accumulate dead weight over 7-15 years. Before migrating anything, identify what should not migrate:

```sql
-- Find tables with no reads in the last 12 months (Hive audit log)
-- Export from Ranger audit or Hive metastore access logs
SELECT
    db_name,
    table_name,
    MAX(access_time) AS last_accessed,
    DATEDIFF(CURRENT_DATE, MAX(access_time)) AS days_since_access
FROM hive_audit_log
GROUP BY db_name, table_name
HAVING DATEDIFF(CURRENT_DATE, MAX(access_time)) > 365
ORDER BY days_since_access DESC;
```

```bash
# Find HDFS directories with no modification in 12+ months
hdfs dfs -ls -R /user/hive/warehouse/ | \
  awk '{print $6, $7, $8}' | \
  sort | \
  awk -v cutoff=$(date -d "12 months ago" +%Y-%m-%d) '$1 < cutoff {print}'
```

### Step 3: Build the migration sequence

Order migrations by value and dependency:

```
Phase 1 (Weeks 1-8):
  ├── HDFS → ADLS Gen2 (bulk copy) [Tier A]
  ├── Kafka → Event Hubs [Tier A]
  └── Sqoop → ADF connectors [Tier A]

Phase 2 (Weeks 8-20):
  ├── Hive SQL → dbt + SparkSQL [Tier B]
  ├── Spark jobs → Databricks jobs [Tier A/B]
  └── Oozie → ADF / Databricks Workflows [Tier B]

Phase 3 (Weeks 20-36):
  ├── HBase → Cosmos DB [Tier C]
  ├── Storm/Flink → Databricks Streaming [Tier C]
  └── Custom YARN apps → AKS / Functions [Tier C]

Phase 4 (Weeks 36-48):
  ├── Security migration (Ranger → Purview/Unity Catalog)
  ├── Parallel-run validation
  └── Decommission planning
```

---

## 2. Parallel-run validation

### Why parallel-run matters

Never cut over from Hadoop to Azure based solely on unit tests. Run both systems in parallel and compare outputs at every stage.

### Parallel-run architecture

```
Data Sources
    ├── → Hadoop cluster (existing pipeline) → Hadoop outputs
    │                                               │
    │                                               ├── Reconciliation
    │                                               │   (daily comparison)
    │                                               │
    └── → Azure pipeline (new) ──────────────────→ Azure outputs
```

### Reconciliation framework

```python
# reconciliation.py — Daily comparison of Hadoop vs Azure outputs

from pyspark.sql import SparkSession, functions as F

spark = SparkSession.builder.getOrCreate()

def reconcile_table(hadoop_path, azure_path, key_columns, metric_columns, table_name):
    """Compare Hadoop and Azure outputs for a single table."""

    hadoop_df = spark.read.parquet(hadoop_path)
    azure_df = spark.read.format("delta").load(azure_path)

    results = {
        "table": table_name,
        "hadoop_rows": hadoop_df.count(),
        "azure_rows": azure_df.count(),
        "row_match": False,
        "metric_matches": {},
        "mismatched_keys": []
    }

    # Row count comparison
    results["row_match"] = results["hadoop_rows"] == results["azure_rows"]

    # Aggregate metric comparison
    for col in metric_columns:
        h_val = hadoop_df.agg(F.sum(col)).collect()[0][0]
        a_val = azure_df.agg(F.sum(col)).collect()[0][0]
        # Allow 0.01% tolerance for floating-point differences
        tolerance = abs(h_val * 0.0001) if h_val else 0.01
        results["metric_matches"][col] = abs(h_val - a_val) < tolerance

    # Key-level comparison (find mismatched rows)
    hadoop_keys = hadoop_df.select(*key_columns).distinct()
    azure_keys = azure_df.select(*key_columns).distinct()

    missing_in_azure = hadoop_keys.subtract(azure_keys)
    missing_in_hadoop = azure_keys.subtract(hadoop_keys)

    results["missing_in_azure"] = missing_in_azure.count()
    results["missing_in_hadoop"] = missing_in_hadoop.count()

    return results


# Run reconciliation for all migrated tables
tables_to_reconcile = [
    {
        "name": "daily_revenue",
        "hadoop_path": "hdfs:///analytics/daily_revenue/",
        "azure_path": "abfss://gold@storage.dfs.core.windows.net/daily_revenue/",
        "key_columns": ["report_date"],
        "metric_columns": ["total_revenue", "total_orders"]
    },
    {
        "name": "customer_360",
        "hadoop_path": "hdfs:///analytics/customer_360/",
        "azure_path": "abfss://gold@storage.dfs.core.windows.net/customer_360/",
        "key_columns": ["customer_id"],
        "metric_columns": ["lifetime_revenue", "lifetime_orders"]
    }
]

for table_config in tables_to_reconcile:
    result = reconcile_table(**table_config)
    print(f"\n{'='*60}")
    print(f"Table: {result['table']}")
    print(f"  Row count:  Hadoop={result['hadoop_rows']:,}  Azure={result['azure_rows']:,}  Match={result['row_match']}")
    for metric, match in result["metric_matches"].items():
        print(f"  {metric}: Match={match}")
    print(f"  Missing in Azure: {result['missing_in_azure']}")
    print(f"  Extra in Azure: {result['missing_in_hadoop']}")
```

### Parallel-run duration

| Workload type        | Minimum parallel-run             | Recommended                 |
| -------------------- | -------------------------------- | --------------------------- |
| Daily batch ETL      | 14 days                          | 30 days                     |
| Weekly reports       | 4 weeks                          | 8 weeks                     |
| Monthly aggregations | 2 months                         | 3 months                    |
| Streaming pipelines  | 7 days                           | 14 days                     |
| Ad-hoc queries       | N/A (validate with test queries) | 5-10 representative queries |

### Exit criteria for parallel-run

| Criterion              | Threshold                                                     |
| ---------------------- | ------------------------------------------------------------- |
| Row count match        | 100% for all tables                                           |
| Aggregate metric match | Within 0.01% for all numeric columns                          |
| Schema match           | 100% column name and type match                               |
| Missing records        | 0 in either direction                                         |
| Performance            | Azure pipeline completes within 1.5x of Hadoop time or better |
| Consumer acceptance    | All downstream consumers validate Azure outputs               |

---

## 3. Decommission planning

### Decommission sequence

Do not shut down Hadoop all at once. Decommission workload by workload:

```
For each workload:
  1. Complete parallel-run (exit criteria met)
  2. Redirect consumers to Azure endpoints
  3. Make Hadoop data read-only (chmod -R 555 on HDFS path)
  4. Monitor for 30 days (catch any missed consumers)
  5. Archive Hadoop data to ADLS cold/archive tier
  6. Free YARN capacity (reduce cluster allocation for this workload)
  7. After all workloads decommissioned:
     a. Final HDFS snapshot to ADLS
     b. Export Ranger policies and Atlas metadata (archive)
     c. Shut down cluster services (Hive, Spark, HBase)
     d. Power off nodes
     e. Terminate Cloudera/HDP license
     f. Reclaim hardware or cancel cloud subscription
```

### License termination timeline

| Vendor               | Typical notice period     | Key actions                                   |
| -------------------- | ------------------------- | --------------------------------------------- |
| Cloudera             | 90 days before renewal    | Notify account team; do not auto-renew        |
| Hortonworks (legacy) | N/A (end of life)         | Cancel support contract                       |
| AWS EMR              | Immediate (pay-as-you-go) | Terminate clusters, cancel reserved instances |
| Azure HDInsight      | Immediate (pay-as-you-go) | Delete clusters                               |

### Data retention for compliance

Before decommissioning, ensure compliance requirements are met:

```python
# Archive critical HDFS data to ADLS Archive tier for compliance
azcopy copy \
  "/mnt/hdfs-export/compliance-data/" \
  "https://archivestorage.dfs.core.windows.net/compliance/?<SAS>" \
  --recursive \
  --put-md5

# Set lifecycle policy for automatic deletion after retention period
az storage account management-policy create \
  --account-name archivestorage \
  --policy '{
    "rules": [{
      "name": "compliance-retention",
      "type": "Lifecycle",
      "definition": {
        "filters": {"blobTypes": ["blockBlob"], "prefixMatch": ["compliance/"]},
        "actions": {"baseBlob": {"delete": {"daysAfterModificationGreaterThan": 2555}}}
      }
    }]
  }'
```

---

## 4. Handling edge cases

### HBase edge cases

| Edge case                                 | Challenge                             | Recommended approach                                    |
| ----------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| HBase with 100+ column families           | Cosmos DB document size limits (2 MB) | Split into multiple containers by access pattern        |
| HBase coprocessors for real-time indexing | No direct equivalent                  | Use Change Feed + Azure Functions                       |
| HBase with Phoenix SQL layer              | Phoenix-specific SQL extensions       | Rewrite queries for Cosmos DB SQL or move to Azure SQL  |
| HBase TTL (cell-level expiration)         | Cosmos DB has item-level TTL          | Map cell TTL to item TTL; may require schema redesign   |
| HBase with multi-version cells            | Cosmos DB has no cell versioning      | Store versions as separate documents or use Change Feed |

### Kafka edge cases

| Edge case                       | Challenge                                           | Recommended approach                                       |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| Kafka Streams application       | Stateful processing                                 | Evaluate Event Hubs support; may need Databricks Streaming |
| Kafka transactions              | Event Hubs does not support transactions            | Design for at-least-once; add idempotency in consumer      |
| Custom Kafka serdes             | Must register in Schema Registry                    | Migrate to Azure Schema Registry                           |
| Kafka MirrorMaker               | Event Hubs has different replication model          | Use Event Hubs Geo-DR or multi-namespace                   |
| Low-latency requirements (<5ms) | Event Hubs has higher latency than bare-metal Kafka | Use Event Hubs Premium or evaluate Confluent on Azure      |

### Oozie edge cases

| Edge case                           | Challenge                    | Recommended approach                                        |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------------- |
| Custom Java actions                 | ADF does not run custom Java | Convert to Databricks JAR task or Azure Function            |
| Oozie SLA monitoring                | ADF has different SLA model  | Use ADF custom metrics + Azure Monitor alerts               |
| Oozie shared library                | Centralized JAR management   | Use Databricks cluster libraries or Unity Catalog volumes   |
| Complex decision trees (100+ nodes) | ADF If/Switch has limits     | Decompose into multiple ADF pipelines                       |
| Oozie bundle (multi-coordinator)    | No direct ADF equivalent     | Create ADF trigger groups or use Databricks multi-task jobs |

### Streaming edge cases

| Edge case                       | Challenge                                   | Recommended approach                                          |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| Storm bolts with external state | Stateful processing redesign                | Move to Databricks Structured Streaming with state store      |
| Sub-second latency requirements | Databricks micro-batch adds latency         | Evaluate continuous processing mode or Azure Stream Analytics |
| Complex event processing (CEP)  | Spark Structured Streaming lacks native CEP | Use Azure Stream Analytics for CEP patterns                   |
| Flink savepoints/checkpoints    | Not compatible with Spark                   | Restart streaming from Event Hubs offset (replay)             |

---

## 5. Team retraining

### Skills transfer matrix

| Hadoop skill             | Azure equivalent skill      | Training path                     | Duration |
| ------------------------ | --------------------------- | --------------------------------- | -------- |
| HDFS administration      | ADLS Gen2 management        | Azure Storage learning path       | 1-2 days |
| YARN capacity management | Databricks cluster policies | Databricks admin training         | 2-3 days |
| Hive SQL                 | SparkSQL + dbt              | dbt Fundamentals + Databricks SQL | 3-5 days |
| Spark on YARN            | Spark on Databricks         | Databricks Developer training     | 2-3 days |
| Oozie workflow design    | ADF pipeline design         | ADF learning path                 | 2-3 days |
| Ranger policy management | Purview + Unity Catalog     | Microsoft Security learning path  | 2-3 days |
| Kerberos administration  | Entra ID management         | Microsoft Identity learning path  | 2-3 days |
| HBase administration     | Cosmos DB management        | Cosmos DB learning path           | 3-5 days |
| Kafka administration     | Event Hubs management       | Event Hubs learning path          | 1-2 days |
| Atlas catalog management | Purview governance          | Purview learning path             | 2-3 days |

### Recommended certification paths

| Role               | Certification                                | Provider   |
| ------------------ | -------------------------------------------- | ---------- |
| Data engineer      | Databricks Certified Data Engineer Associate | Databricks |
| Data engineer      | Azure Data Engineer Associate (DP-203)       | Microsoft  |
| Platform engineer  | Azure Administrator Associate (AZ-104)       | Microsoft  |
| Security engineer  | Azure Security Engineer Associate (AZ-500)   | Microsoft  |
| Analytics engineer | dbt Analytics Engineering Certification      | dbt Labs   |
| Data architect     | Azure Solutions Architect Expert (AZ-305)    | Microsoft  |

### Training timeline

```
Month 1-2 (Pre-migration):
  ├── Azure Fundamentals (AZ-900) for entire team
  ├── Databricks Lakehouse Fundamentals for data engineers
  └── ADF fundamentals for workflow engineers

Month 3-4 (During migration):
  ├── Hands-on labs with migrated workloads
  ├── Databricks Developer training (data engineers)
  └── dbt Fundamentals (analytics engineers)

Month 5-6 (Post-migration):
  ├── Advanced Databricks (performance tuning, streaming)
  ├── Purview governance training
  └── Certification exams
```

### Knowledge transfer from Hadoop to Azure

| Hadoop knowledge    | How it transfers                                     | What is new                                         |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| SQL (HiveQL)        | 95% transfers directly to SparkSQL                   | Delta Lake DDL, MERGE, OPTIMIZE                     |
| PySpark             | 90% transfers directly                               | Databricks widgets, dbutils, Unity Catalog APIs     |
| Data modeling       | Fully transfers                                      | Medallion architecture (bronze/silver/gold) pattern |
| ETL design patterns | Mostly transfers                                     | dbt incremental models, ADF event triggers          |
| Security concepts   | Concepts transfer (RBAC, ACLs)                       | Entra ID, managed identity, Unity Catalog           |
| Performance tuning  | Concepts transfer (partitioning, predicate pushdown) | Photon, AQE, Z-ORDER, liquid clustering             |
| Monitoring          | Concepts transfer (dashboards, alerts)               | Azure Monitor, Databricks Overwatch, ADF Monitor    |

---

## 6. Risk mitigation

### Top 10 migration risks and mitigations

| #   | Risk                                | Likelihood | Impact   | Mitigation                                                            |
| --- | ----------------------------------- | ---------- | -------- | --------------------------------------------------------------------- |
| 1   | Data loss during transfer           | Low        | Critical | Checksum validation, parallel-run, HDFS snapshots before migration    |
| 2   | Performance regression              | Medium     | High     | Benchmark before/after, tune Databricks clusters, use Photon          |
| 3   | Security gap during transition      | Medium     | Critical | Map all Ranger policies before migration, validate with security team |
| 4   | Missed downstream consumers         | High       | High     | Inventory all consumers before cutover, 30-day read-only period       |
| 5   | Budget overrun (parallel costs)     | Medium     | Medium   | Time-box parallel-run, decommission aggressively                      |
| 6   | Team skill gaps                     | Medium     | Medium   | Start training early, pair senior and junior engineers                |
| 7   | HBase migration complexity          | High       | High     | Start HBase migration early, allow 2x estimated time                  |
| 8   | Oozie workflow translation errors   | High       | Medium   | Test each workflow independently, automated regression tests          |
| 9   | Network bandwidth for data transfer | Medium     | Medium   | Use ExpressRoute, Data Box for large datasets                         |
| 10  | Vendor lock-in concerns             | Low        | Medium   | Use Delta Lake (open format), dbt (portable SQL), standard APIs       |

---

## 7. Operational checklists

### Pre-migration checklist

- [ ] Complete workload inventory (all HDFS paths, Hive tables, Spark jobs, workflows)
- [ ] Classify all workloads into Tier A/B/C/D
- [ ] Identify and archive Tier D data (do not migrate dead data)
- [ ] Provision Azure landing zones (ADLS Gen2, Databricks, ADF)
- [ ] Establish network connectivity (ExpressRoute or VPN)
- [ ] Begin team training (Azure Fundamentals, Databricks basics)
- [ ] Export Ranger policies and Atlas metadata
- [ ] Document all Hive UDFs and custom Java code
- [ ] Identify all downstream consumers of Hadoop data

### During-migration checklist

- [ ] Run DistCp with checksum validation for each data batch
- [ ] Convert data formats (ORC/Parquet to Delta) with row-count validation
- [ ] Register all tables in Unity Catalog
- [ ] Convert Hive SQL to dbt models with schema tests
- [ ] Port Spark jobs to Databricks (test each independently)
- [ ] Migrate Oozie workflows to ADF (test each independently)
- [ ] Implement security policies in Purview and Unity Catalog
- [ ] Run parallel pipelines with daily reconciliation
- [ ] Track and resolve reconciliation differences

### Post-migration checklist

- [ ] All parallel-run exit criteria met
- [ ] All downstream consumers validated on Azure
- [ ] Hadoop data set to read-only
- [ ] 30-day monitoring period completed
- [ ] Final HDFS snapshot archived to ADLS
- [ ] Hadoop cluster services shut down
- [ ] Hardware reclaimed or cloud subscription cancelled
- [ ] Cloudera/HDP license terminated
- [ ] Team certifications completed
- [ ] Migration retrospective conducted and documented

---

## Related

- [Migration Hub](index.md) — full migration center
- [TCO Analysis](tco-analysis.md) — cost justification
- [Benchmarks](benchmarks.md) — performance comparison data
- [Hadoop / Hive Migration Overview](../hadoop-hive.md) — original single-page guide

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Hub](index.md) | [TCO Analysis](tco-analysis.md) | [Benchmarks](benchmarks.md)
