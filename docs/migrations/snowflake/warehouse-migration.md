# Snowflake Warehouse Migration Guide

**Status:** Authored 2026-04-30
**Audience:** Data engineers, platform engineers, DBAs managing Snowflake virtual warehouses
**Scope:** Multi-cluster warehouses to Databricks SQL Warehouses / Fabric capacity, sizing, auto-scaling, query optimization, resource monitors

---

## 1. Architecture comparison

### Snowflake virtual warehouses

Snowflake virtual warehouses are named compute clusters that execute SQL queries:

- Fixed sizes from X-Small (1 credit/hour) to 6X-Large (512 credits/hour)
- Multi-cluster mode scales out by cloning the entire warehouse
- Auto-suspend stops billing after configurable idle period (minimum 60 seconds)
- Auto-resume starts the warehouse when a query arrives
- Each warehouse is isolated -- no resource sharing between warehouses
- Query queue management per warehouse

### Databricks SQL Warehouses

Databricks SQL Warehouses are the direct replacement:

- Sizes from 2X-Small (4 DBU/hour) to 4X-Large (320 DBU/hour)
- Auto-scaling scales individual nodes, not full warehouse clones
- Auto-stop halts billing after configurable idle period (1 minute on classic, 10 minutes on serverless)
- Serverless warehouses spin up in under 10 seconds
- Photon engine accelerates scan-heavy queries automatically
- Query queue management with configurable concurrency

### Fabric SQL analytics endpoint

For teams moving to Microsoft Fabric rather than Databricks:

- Fabric Lakehouse SQL analytics endpoint provides T-SQL interface over Delta Lake
- Fabric capacity (CU/hour) shared across all Fabric workloads
- Direct Lake mode for Power BI eliminates import/export
- No per-warehouse sizing -- capacity is pool-level

---

## 2. Warehouse size mapping

### Direct size translation

| Snowflake size | Credits/hr | Databricks SQL size | DBU/hr | Fabric capacity (approximate) |
|---|---|---|---|---|
| X-Small | 1 | 2X-Small | 4 | F4 |
| Small | 2 | X-Small | 6 | F8 |
| Medium | 4 | Small | 12 | F16 |
| Large | 8 | Medium | 24 | F32-F64 |
| X-Large | 16 | Large | 40 | F64-F128 |
| 2X-Large | 32 | X-Large | 80 | F128-F256 |
| 3X-Large | 64 | 2X-Large | 144 | F256-F512 |
| 4X-Large | 128 | 3X-Large | 240 | F512-F1024 |
| 5X-Large | 256 | 4X-Large | 320 | F1024-F2048 |
| 6X-Large | 512 | 4X-Large (multi) | 640 | F2048 |

### Right-sizing methodology

Do not blindly translate sizes. Snowflake and Databricks have different performance characteristics at each tier.

**Step 1: Profile current Snowflake usage**

```sql
-- Snowflake: query warehouse utilization
SELECT
    warehouse_name,
    warehouse_size,
    AVG(avg_running) AS avg_concurrent_queries,
    MAX(avg_running) AS peak_concurrent_queries,
    AVG(avg_queued_load) AS avg_queue_depth,
    SUM(credits_used) AS total_credits,
    COUNT(DISTINCT DATE_TRUNC('day', start_time)) AS active_days
FROM snowflake.account_usage.warehouse_metering_history
WHERE start_time >= DATEADD(month, -3, CURRENT_TIMESTAMP())
GROUP BY warehouse_name, warehouse_size
ORDER BY total_credits DESC;
```

**Step 2: Analyze query patterns**

```sql
-- Snowflake: query duration and resource consumption
SELECT
    warehouse_name,
    query_type,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_elapsed_time) AS p50_ms,
    PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY total_elapsed_time) AS p90_ms,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY total_elapsed_time) AS p99_ms,
    AVG(bytes_scanned) / POWER(1024, 3) AS avg_gb_scanned,
    COUNT(*) AS query_count
FROM snowflake.account_usage.query_history
WHERE start_time >= DATEADD(month, -3, CURRENT_TIMESTAMP())
GROUP BY warehouse_name, query_type
ORDER BY query_count DESC;
```

**Step 3: Start one size smaller on Databricks**

Databricks Photon engine and Delta Lake file pruning often deliver equivalent or better performance at a smaller size. Start one tier smaller and benchmark.

**Step 4: Monitor and adjust**

```sql
-- Databricks: query warehouse performance
SELECT
    warehouse_id,
    COUNT(*) AS query_count,
    AVG(duration) AS avg_duration_ms,
    PERCENTILE(duration, 0.90) AS p90_duration_ms,
    SUM(total_task_duration_ms) AS total_compute_ms
FROM system.query.history
WHERE start_time >= CURRENT_DATE - INTERVAL 7 DAYS
GROUP BY warehouse_id;
```

---

## 3. Multi-cluster warehouse translation

### Snowflake multi-cluster behavior

Snowflake multi-cluster warehouses scale by cloning the entire warehouse:

- Economy mode: queues queries until load justifies a new cluster
- Standard mode: starts a new cluster immediately when queries queue
- Min/max clusters: configurable range (e.g., 1 min, 10 max)
- Each cluster is a full copy of the warehouse size (credits multiply linearly)

### Databricks auto-scaling

Databricks SQL Warehouses scale differently:

- Scaling is per-node, not per-warehouse-clone
- Cluster size range is configurable (e.g., 1 to 10 nodes)
- Scaling decisions are based on query queue depth and compute utilization
- More granular than Snowflake's all-or-nothing cluster cloning

**Translation rules:**

| Snowflake config | Databricks equivalent |
|---|---|
| Multi-cluster: min 1, max 1 | Auto-scaling: min 1, max 1 (fixed) |
| Multi-cluster: min 1, max 3 | Auto-scaling: min cluster size, max 3x cluster size |
| Multi-cluster: min 1, max 10 | Auto-scaling: use next-larger warehouse with max scaling |
| Multi-cluster: min 3, max 10 | Consider always-on medium + auto-scaling large |

### Concurrency management

| Snowflake | Databricks |
|---|---|
| 8 concurrent queries per cluster (default) | Configurable concurrent queries per warehouse |
| Queue depth triggers multi-cluster scaling | Queue depth triggers node scaling |
| Economy vs Standard scaling mode | Single scaling policy with configurable aggressiveness |
| Separate warehouses for isolation | Separate warehouses or query tagging for isolation |

---

## 4. Auto-suspend to auto-stop translation

### Snowflake auto-suspend

- Configurable in seconds (minimum 60 seconds, default 600 seconds)
- Warehouse remains running and billing during the suspend timer
- Resume takes 2-30 seconds depending on warehouse size and cold/warm state
- Suspended warehouses retain cached data (warm resume)

### Databricks auto-stop

**Classic SQL Warehouses:**
- Configurable in minutes (minimum 1 minute, default 10 minutes)
- Auto-stop completely deallocates the warehouse
- Restart takes 30-120 seconds for classic
- No cached data retention after stop

**Serverless SQL Warehouses:**
- Minimum 10 minutes auto-stop
- Restart in under 10 seconds (near-instant)
- Serverless billing is per-query, not per-time
- Recommended for interactive/ad-hoc workloads

### Translation guidance

| Snowflake auto-suspend | Databricks recommendation |
|---|---|
| 60 seconds (aggressive) | Serverless warehouse (instant resume) |
| 300 seconds (moderate) | Classic with 5-min auto-stop |
| 600 seconds (default) | Classic with 10-min auto-stop |
| 3600 seconds (conservative) | Classic with 15-min auto-stop; consider reservation |
| Never (always on) | Always-on classic warehouse with reserved capacity |

---

## 5. Query optimization differences

### Snowflake optimizations that translate directly

| Snowflake optimization | Databricks equivalent | Notes |
|---|---|---|
| Micro-partition pruning | Delta file pruning | Automatic based on file statistics |
| Clustering keys | Z-ORDER / liquid clustering | `OPTIMIZE table ZORDER BY (col)` or liquid clustering |
| Result cache | SQL Warehouse result cache | Automatic; same query returns cached result |
| Metadata cache | Delta file metadata cache | Automatic |
| Materialized views | Materialized views (Databricks) | GA in Runtime 13+; syntax slightly different |

### Snowflake optimizations that require changes

| Snowflake optimization | Databricks approach | Migration action |
|---|---|---|
| Search Optimization Service | Z-ORDER + liquid clustering | Apply Z-ORDER on lookup columns; evaluate liquid clustering |
| Query acceleration | Photon engine (automatic) | No action needed; Photon is included |
| Automatic clustering | Liquid clustering (Runtime 14+) | Enable liquid clustering on frequently-queried tables |
| Warehouse-level query timeout | SQL Warehouse statement timeout | Configure via warehouse settings |

### Query tuning checklist

After migrating each warehouse:

1. **Run the top 20 queries by frequency** and compare execution plans
2. **Check scan sizes** -- Delta file pruning should match or beat micro-partition pruning
3. **Apply Z-ORDER** on columns used in WHERE/JOIN clauses for large tables
4. **Enable Photon** on the SQL Warehouse (usually default)
5. **Set appropriate statement timeout** to catch runaway queries
6. **Monitor spill-to-disk** -- if excessive, consider a larger warehouse or query rewrite
7. **Compare result cache hit rates** between Snowflake and Databricks

---

## 6. Resource monitor translation

### Snowflake resource monitors

Snowflake resource monitors track credit consumption and can:

- Send notifications at configurable thresholds (50%, 75%, 100%)
- Suspend warehouse at a threshold
- Suspend and kill running queries at a threshold
- Apply per-warehouse or account-wide

### Azure cost governance

Azure provides multiple layers:

| Layer | Tool | Equivalent to |
|---|---|---|
| Budget alerts | Azure Cost Management | Resource monitor notifications |
| Warehouse auto-stop | Databricks SQL Warehouse config | Resource monitor suspend |
| Hard kill-switch | `scripts/deploy/teardown-platform.sh` | Resource monitor suspend + kill |
| Tag-based tracking | Azure resource tags | Resource monitor per-warehouse tracking |
| Anomaly detection | Azure Cost Management anomaly alerts | No Snowflake equivalent |

**Setup example (Azure Cost Management budget):**

```json
{
    "name": "finance-warehouse-monthly",
    "amount": 5000,
    "timeGrain": "Monthly",
    "timePeriod": {
        "startDate": "2026-05-01"
    },
    "notifications": {
        "notification50pct": {
            "enabled": true,
            "operator": "GreaterThanOrEqualTo",
            "threshold": 50,
            "contactEmails": ["data-platform-team@agency.gov"]
        },
        "notification90pct": {
            "enabled": true,
            "operator": "GreaterThanOrEqualTo",
            "threshold": 90,
            "contactEmails": ["data-platform-team@agency.gov", "cfo-office@agency.gov"]
        }
    }
}
```

---

## 7. Migration execution steps

### Per-warehouse migration procedure

1. **Profile** the Snowflake warehouse (queries, sizes, schedules, consumers)
2. **Create** the Databricks SQL Warehouse one size smaller
3. **Configure** auto-stop, scaling, and concurrency limits
4. **Migrate** the dbt models or queries that use this warehouse (see [dbt tutorial](tutorial-dbt-snowflake-to-fabric.md))
5. **Benchmark** the top 20 queries; adjust warehouse size if needed
6. **Apply** Z-ORDER on key tables
7. **Configure** cost budgets and alerts
8. **Run parallel** for 2 weeks minimum; reconcile results
9. **Cutover** consumers to the Databricks warehouse
10. **Decommission** the Snowflake warehouse (suspend, then drop after 30 days)

### Parallel-run monitoring

During the parallel-run phase, track these metrics daily:

| Metric | Snowflake source | Databricks source |
|---|---|---|
| Query count | `QUERY_HISTORY` view | `system.query.history` table |
| P50/P90/P99 latency | `QUERY_HISTORY` view | `system.query.history` table |
| Total compute cost | `WAREHOUSE_METERING_HISTORY` | Databricks usage logs |
| Error rate | `QUERY_HISTORY` (error queries) | `system.query.history` (failed) |
| Data freshness | Source table timestamps | Source table timestamps |

---

## 8. Common pitfalls

### Pitfall 1: Over-sizing Databricks warehouses

Databricks Photon engine is more efficient per-compute-unit than Snowflake's engine for scan-heavy workloads. Start one size smaller and scale up only if benchmarks justify it.

### Pitfall 2: Ignoring auto-stop configuration

The default auto-stop on Databricks classic warehouses is 10 minutes. For development warehouses, set it to 1 minute. For serverless warehouses, the minimum is 10 minutes but billing is per-query.

### Pitfall 3: Not applying Z-ORDER

Snowflake's micro-partition pruning works automatically based on natural data ordering. Delta Lake benefits from explicit Z-ORDER on high-cardinality columns used in filters. Skipping this step can result in slower queries.

### Pitfall 4: Carrying over multi-cluster patterns

Snowflake multi-cluster warehouses scale by cloning the entire warehouse. Do not replicate this pattern 1:1 on Databricks. Use auto-scaling (per-node) and concurrency limits instead.

### Pitfall 5: Ignoring serverless warehouses

For interactive and ad-hoc workloads, serverless SQL warehouses provide near-instant startup (under 10 seconds) at a higher per-DBU rate. The total cost is often lower because you eliminate idle billing.

---

## 9. Fabric capacity alternative

For teams choosing Microsoft Fabric over Databricks:

### Capacity mapping

| Snowflake warehouse count | Recommended Fabric capacity |
|---|---|
| 1-3 small warehouses | F32-F64 |
| 3-5 mixed warehouses | F64-F128 |
| 5-10 mixed warehouses | F128-F256 |
| 10+ warehouses or heavy workloads | F256-F512 |

### Key differences from Databricks

- Fabric capacity is **shared** across all Fabric workloads (data engineering, data science, BI, real-time analytics)
- No per-warehouse sizing -- capacity is pool-level
- Fabric capacity can be **paused** for dev/test (scale-to-zero)
- Direct Lake mode eliminates data import for Power BI
- T-SQL interface via SQL analytics endpoint (familiar for SQL Server teams)

### When to choose Fabric over Databricks

- Power BI is the primary consumption layer
- T-SQL skills are stronger than Spark/Python skills
- Unified platform is preferred over best-of-breed components
- Simpler capacity model is valued over per-warehouse control

### When to choose Databricks over Fabric

- Complex Spark workloads (ML, streaming, large-scale ETL)
- Unity Catalog is needed for fine-grained access control
- Multi-cloud strategy (Databricks runs on Azure, AWS, GCP)
- Existing Databricks skills and infrastructure

---

## Related documents

- [Feature Mapping](feature-mapping-complete.md) -- all 66 features mapped
- [Tutorial: dbt Migration](tutorial-dbt-snowflake-to-fabric.md) -- step-by-step dbt adapter swap
- [Best Practices](best-practices.md) -- warehouse-by-warehouse migration strategy
- [TCO Analysis](tco-analysis.md) -- cost comparison by warehouse tier
- [Benchmarks](benchmarks.md) -- performance comparison data
- [Master playbook](../snowflake.md) -- Section 4.5 for the original warehouse sizing table

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
