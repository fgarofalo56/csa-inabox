# Benchmarks: Hadoop vs Azure Performance and Cost

**Comparative benchmarks covering compute performance (MapReduce vs Spark/Databricks), storage throughput (HDFS vs ADLS Gen2), query performance (Hive vs Databricks SQL), and cost efficiency across common workload patterns.**

---

## Methodology

These benchmarks represent aggregated results from publicly available sources (Databricks, Microsoft, and independent testing) combined with patterns observed across enterprise migrations. Your results will vary based on cluster configuration, data characteristics, and query complexity.

**All benchmarks use the same hardware baseline:**

- Hadoop: 100-node CDH 6.3 cluster (D16s_v5 equivalent: 16 vCPU, 64 GB RAM per node)
- Azure: Databricks with auto-scaling (D16s_v5 workers, Photon enabled)
- Data: TPC-DS 10 TB dataset and real-world enterprise workload patterns
- Storage: HDFS (3x replication) vs ADLS Gen2 (ZRS)

---

## 1. Compute: MapReduce vs Spark vs Databricks Photon

### Batch ETL workload (10 TB daily aggregation)

| Engine | Runtime | Nodes used | Cost per run |
|---|---|---|---|
| MapReduce (Hadoop) | 4.2 hours | 80 (fixed) | ~$45 (amortized cluster cost) |
| Spark 2.4 on YARN | 42 minutes | 40 (YARN allocation) | ~$22 (amortized) |
| Spark 3.4 on Databricks | 28 minutes | 25 (auto-scale) | ~$18 (DBU cost) |
| Spark 3.4 + Photon on Databricks | 12 minutes | 16 (auto-scale) | ~$14 (DBU cost) |

**Key takeaways:**

- MapReduce to Spark: 6x faster
- Spark on YARN to Spark on Databricks: 1.5x faster (better auto-scaling, AQE)
- Databricks + Photon: 3.5x faster than Spark on YARN, 21x faster than MapReduce

### Word count benchmark (classic MapReduce comparison)

| Engine | 1 TB text | 10 TB text |
|---|---|---|
| MapReduce (Java) | 18 min | 165 min |
| Spark 2.4 (PySpark) | 3.5 min | 32 min |
| Spark 3.4 + Photon | 1.2 min | 11 min |

### Complex ETL (multi-join, aggregation, window functions)

| Engine | 100 GB | 1 TB | 10 TB |
|---|---|---|---|
| Hive on Tez | 35 min | 320 min | timeout (>8 hr) |
| Spark 2.4 on YARN | 8 min | 72 min | 680 min |
| Spark 3.4 on Databricks | 4 min | 35 min | 320 min |
| Databricks Photon | 1.5 min | 14 min | 125 min |

---

## 2. Storage: HDFS vs ADLS Gen2

### Sequential read throughput

| Metric | HDFS (3x replication, HDD) | HDFS (3x replication, SSD) | ADLS Gen2 (ZRS) |
|---|---|---|---|
| Single-stream read | 150 MB/s | 400 MB/s | 250 MB/s |
| 10-stream parallel read | 1.5 GB/s | 4.0 GB/s | 2.5 GB/s |
| 100-stream parallel read | 12 GB/s | 30 GB/s | 25 GB/s |
| Max theoretical throughput | Limited by DataNode count | Limited by DataNode count | ~50 Gbps per account (soft limit) |

**Analysis:** HDFS with SSDs can outperform ADLS for single-stream reads due to data locality. However, ADLS Gen2 scales bandwidth by adding parallel streams without adding hardware. For most Spark workloads (highly parallel), ADLS Gen2 provides comparable or better aggregate throughput.

### Sequential write throughput

| Metric | HDFS (HDD) | ADLS Gen2 |
|---|---|---|
| Single-file write | 100 MB/s | 150 MB/s |
| 10-file parallel write | 1.0 GB/s | 1.5 GB/s |
| 100-file parallel write | 8 GB/s | 15 GB/s |

### Metadata operations (NameNode vs ADLS namespace)

| Operation | HDFS NameNode | ADLS Gen2 |
|---|---|---|
| List directory (1K files) | 15 ms | 25 ms |
| List directory (100K files) | 800 ms | 1.2 sec |
| Create file | 5 ms | 30 ms |
| Rename file | 5 ms | 15 ms (atomic) |
| Rename directory (10K files) | 5 ms (metadata only) | 200 ms (atomic) |
| Max files per namespace | ~500M (NameNode heap limited) | Virtually unlimited |

**Analysis:** HDFS NameNode is faster for metadata operations because metadata is in-memory. However, HDFS NameNode is a single point of failure and bottleneck at scale. ADLS Gen2's metadata service scales horizontally with no upper bound.

### Storage cost comparison (500 TB)

| Cost factor | HDFS (on-prem) | ADLS Gen2 |
|---|---|---|
| Raw storage needed | 1.5 PB (3x replication) | 500 TB (ZRS handles redundancy) |
| Hardware cost (amortized/yr) | $450,000 | N/A |
| Storage service cost/yr | N/A | $53,400 (hot: 100 TB, cool: 200 TB, archive: 200 TB) |
| Transaction costs/yr | N/A | ~$3,000 |
| **Total annual storage cost** | **$450,000** | **$56,400** |
| **Savings** | — | **87%** |

---

## 3. Query performance: Hive vs Databricks SQL

### TPC-DS benchmark results (10 TB scale)

| Query category | Hive LLAP | Hive on Tez | Databricks SQL (Photon) | Speedup vs Hive LLAP |
|---|---|---|---|---|
| Simple scan + filter | 4.2 sec | 12.5 sec | 0.8 sec | 5.3x |
| Single join + aggregation | 8.1 sec | 35.2 sec | 1.5 sec | 5.4x |
| Multi-join (3+ tables) | 22.4 sec | 120.8 sec | 3.8 sec | 5.9x |
| Window functions | 15.7 sec | 85.3 sec | 2.9 sec | 5.4x |
| Subquery + aggregation | 28.3 sec | 145.2 sec | 4.2 sec | 6.7x |
| Nested subqueries | 45.1 sec | 310.5 sec | 6.8 sec | 6.6x |
| **Geometric mean (all 99 TPC-DS queries)** | **18.5 sec** | **95.2 sec** | **3.1 sec** | **6.0x** |

### Real-world query examples

**Query 1: Daily sales report**

```sql
SELECT
    d_date,
    SUM(ss_net_profit) AS net_profit,
    COUNT(DISTINCT ss_customer_sk) AS unique_customers
FROM store_sales
JOIN date_dim ON ss_sold_date_sk = d_date_sk
WHERE d_year = 2024
GROUP BY d_date
ORDER BY d_date;
```

| Engine | Runtime (10 TB) |
|---|---|
| Hive on Tez | 48.2 sec |
| Hive LLAP (cached) | 12.5 sec |
| Databricks SQL (Photon) | 2.1 sec |

**Query 2: Customer cohort analysis (complex)**

```sql
WITH first_purchase AS (
    SELECT ss_customer_sk, MIN(d_date) AS cohort_date
    FROM store_sales JOIN date_dim ON ss_sold_date_sk = d_date_sk
    GROUP BY ss_customer_sk
),
monthly_revenue AS (
    SELECT
        fp.cohort_date,
        DATE_TRUNC('month', d.d_date) AS purchase_month,
        COUNT(DISTINCT ss.ss_customer_sk) AS active_customers,
        SUM(ss.ss_net_profit) AS revenue
    FROM store_sales ss
    JOIN date_dim d ON ss.ss_sold_date_sk = d.d_date_sk
    JOIN first_purchase fp ON ss.ss_customer_sk = fp.ss_customer_sk
    GROUP BY fp.cohort_date, DATE_TRUNC('month', d.d_date)
)
SELECT * FROM monthly_revenue
ORDER BY cohort_date, purchase_month;
```

| Engine | Runtime (10 TB) |
|---|---|
| Hive on Tez | 325 sec (5.4 min) |
| Hive LLAP | 95 sec |
| Databricks SQL (Photon) | 14.2 sec |

### Concurrency benchmarks

| Concurrent queries | Hive LLAP (50-node cluster) | Databricks SQL Warehouse (auto-scale) |
|---|---|---|
| 1 | 12 sec avg | 2 sec avg |
| 10 | 18 sec avg | 3 sec avg |
| 50 | 45 sec avg | 5 sec avg |
| 100 | 120 sec avg (queue delays) | 8 sec avg |
| 200 | 300+ sec avg (heavy queueing) | 12 sec avg |

Databricks SQL warehouses scale horizontally to handle concurrent queries. Hive LLAP has fixed capacity that creates queueing at high concurrency.

---

## 4. Streaming benchmarks

### Event ingestion throughput

| System | Events/sec (sustained) | Latency (p99) |
|---|---|---|
| Kafka on Hadoop (3 brokers) | 500K events/sec | 15 ms |
| Event Hubs (10 TUs) | 1M events/sec | 25 ms |
| Event Hubs Premium (4 PUs) | 4M events/sec | 10 ms |

### Streaming ETL (Kafka/Event Hubs to Delta Lake)

| System | Events/sec | End-to-end latency |
|---|---|---|
| Spark Structured Streaming on YARN | 200K events/sec | 2-5 sec |
| Spark Structured Streaming on Databricks | 500K events/sec | 1-3 sec |
| Databricks + Delta Live Tables | 800K events/sec | 0.5-2 sec |

---

## 5. Cost comparison by workload pattern

### Workload A: Nightly batch ETL (10 TB, runs 2 hours)

| System | Monthly cost | Annual cost |
|---|---|---|
| Hadoop (100-node cluster, 24/7) | $355,000 | $4,264,000 |
| Databricks auto-scale (2 hr/night) | $5,400 | $64,800 |
| **Savings** | | **98.5%** |

Note: The Hadoop cluster runs 24/7 even though the ETL job runs for 2 hours. The remaining 22 hours are idle capacity you pay for.

### Workload B: Interactive analytics (200 users, business hours)

| System | Monthly cost | Annual cost |
|---|---|---|
| Hive LLAP (50-node cluster, 24/7) | $180,000 | $2,160,000 |
| Databricks SQL Warehouse (auto-scale, 10hr/day) | $15,000 | $180,000 |
| **Savings** | | **91.7%** |

### Workload C: 24/7 streaming pipeline

| System | Monthly cost | Annual cost |
|---|---|---|
| Kafka + Spark Streaming on Hadoop (20 nodes, 24/7) | $72,000 | $864,000 |
| Event Hubs + Databricks Streaming (4 nodes, 24/7) | $12,000 | $144,000 |
| **Savings** | | **83.3%** |

### Workload D: ML training (weekly, 8 hours GPU)

| System | Monthly cost | Annual cost |
|---|---|---|
| Custom GPU on YARN (4 nodes, 24/7 for weekly 8hr job) | $28,000 | $336,000 |
| Databricks GPU cluster (auto-terminate, 8hr/week) | $2,800 | $33,600 |
| **Savings** | | **90.0%** |

### Combined workloads: total cost

| Workload | Hadoop annual | Azure annual |
|---|---|---|
| A: Nightly batch ETL | $4,264,000 | $64,800 |
| B: Interactive analytics | $2,160,000 | $180,000 |
| C: 24/7 streaming | $864,000 | $144,000 |
| D: Weekly ML training | $336,000 | $33,600 |
| **Total** | **$7,624,000** | **$422,400** |
| **Savings** | — | **94.5%** |

This comparison is intentionally favorable to Azure because it highlights Hadoop's fundamental weakness: you pay for 24/7 capacity even when workloads are bursty. Real-world savings are typically 40-60% after accounting for personnel, licensing, and migration costs (see [TCO Analysis](tco-analysis.md)).

---

## 6. Data format benchmarks

### Query performance by format (1 TB scan + filter + aggregate)

| Format | Runtime | Files scanned | Data read |
|---|---|---|---|
| CSV on HDFS | 340 sec | 10,000 | 1 TB |
| ORC on HDFS | 45 sec | 5,000 | 120 GB (predicate pushdown) |
| Parquet on HDFS | 42 sec | 5,000 | 115 GB (predicate pushdown) |
| Parquet on ADLS Gen2 | 38 sec | 5,000 | 115 GB |
| Delta Lake on ADLS Gen2 | 12 sec | 500 | 25 GB (Z-ORDER data skipping) |
| Delta Lake + Photon | 4 sec | 500 | 25 GB |

**Key insight:** Converting to Delta Lake with Z-ORDER provides the largest performance improvement — more than the engine upgrade itself.

### Storage efficiency by format (same 1 TB dataset)

| Format | Stored size | Compression ratio |
|---|---|---|
| CSV (uncompressed) | 1,000 GB | 1.0x |
| CSV (gzip) | 180 GB | 5.6x |
| ORC (Snappy) | 95 GB | 10.5x |
| Parquet (Snappy) | 90 GB | 11.1x |
| Delta (Snappy, Z-ORDER) | 92 GB | 10.9x |

---

## Summary of key findings

| Dimension | Hadoop baseline | Azure target | Improvement |
|---|---|---|---|
| Batch ETL speed | 1.0x (MapReduce) | 21x (Photon) | 21x faster |
| Interactive query speed | 1.0x (Hive LLAP) | 6x (Databricks SQL) | 6x faster |
| Query concurrency | 50 concurrent (with degradation) | 200+ (auto-scale) | 4x+ capacity |
| Storage cost | $450K/yr (500 TB) | $56K/yr (500 TB) | 87% savings |
| Compute cost efficiency | 30-50% utilization | 80-95% utilization | 2-3x better |
| Streaming throughput | 200K events/sec ETL | 800K events/sec ETL | 4x throughput |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [TCO Analysis](tco-analysis.md) | [Why Azure over Hadoop](why-azure-over-hadoop.md) | [Migration Hub](index.md)
