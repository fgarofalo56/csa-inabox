# Snowflake-to-Azure Migration Best Practices

**Status:** Authored 2026-04-30
**Audience:** Migration leads, data platform engineers, project managers
**Scope:** Warehouse-by-warehouse migration strategy, credit monitoring during parallel-run, data sharing alternatives, common pitfalls and remediation

---

## 1. Migration strategy: warehouse by warehouse

### Why warehouse-by-warehouse

Attempting a "big bang" migration of all Snowflake warehouses, dbt models, Cortex calls, and data shares at once is the leading cause of migration failure. The warehouse-by-warehouse approach:

- **Limits blast radius** -- if one warehouse migration has issues, others are unaffected
- **Builds team confidence** -- the first warehouse teaches patterns; subsequent warehouses go faster
- **Enables parallel-run** -- Snowflake and Azure coexist; consumers migrate gradually
- **Provides natural checkpoints** -- each warehouse cutover is a deliverable

### Warehouse prioritization matrix

Rank warehouses by migration value and complexity:

| Factor                 | Score 1 (Easy)         | Score 3 (Medium)    | Score 5 (Hard)                       |
| ---------------------- | ---------------------- | ------------------- | ------------------------------------ |
| dbt model count        | < 20 models            | 20-100 models       | > 100 models                         |
| Snowflake-specific SQL | Minimal (standard SQL) | Some (IFF, DATEADD) | Heavy (VARIANT, Snowpark, Cortex)    |
| Downstream consumers   | 1-2 reports            | 5-10 reports        | > 10 reports + external consumers    |
| Data volume            | < 100 GB               | 100 GB - 1 TB       | > 1 TB                               |
| Streaming dependencies | None                   | Snowpipe (batch)    | Snowpipe Streaming + Streams + Tasks |
| External data sharing  | None                   | 1-2 shares          | > 2 shares with external partners    |

**Migration order:**

1. **Start with:** Low complexity, medium value (build the pattern)
2. **Then:** High value, medium complexity (demonstrate ROI)
3. **Then:** Remaining warehouses (follow the established pattern)
4. **Last:** Highest complexity (streaming, Cortex, data sharing)

### Example migration wave plan

| Wave           | Warehouses                 | Models               | Weeks | Phase                |
| -------------- | -------------------------- | -------------------- | ----- | -------------------- |
| Wave 0 (pilot) | FINANCE_WH                 | 15 models            | 3-4   | Prove the pattern    |
| Wave 1         | HR_WH, SALES_WH            | 45 models            | 3-4   | Scale the pattern    |
| Wave 2         | ANALYTICS_WH, REPORTING_WH | 80 models            | 4-5   | Bulk migration       |
| Wave 3         | STREAMING_WH, AI_WH        | 30 models + Cortex   | 4-6   | Complex workloads    |
| Wave 4         | SHARED_WH                  | 20 models + 5 shares | 4-6   | Data sharing cutover |

---

## 2. Credit monitoring during parallel-run

During the parallel-run phase, you are paying for both Snowflake and Azure. Aggressive credit monitoring prevents budget overruns.

### Snowflake credit monitoring

```sql
-- Daily credit consumption report
SELECT
    DATE_TRUNC('day', start_time) AS usage_date,
    warehouse_name,
    SUM(credits_used) AS credits_consumed,
    SUM(credits_used) * 4.00 AS estimated_cost_usd  -- Adjust rate for your contract
FROM snowflake.account_usage.warehouse_metering_history
WHERE start_time >= DATEADD(day, -30, CURRENT_TIMESTAMP())
GROUP BY usage_date, warehouse_name
ORDER BY usage_date DESC, credits_consumed DESC;

-- Identify warehouses that should be suspended (already migrated)
SELECT
    warehouse_name,
    SUM(credits_used) AS total_credits_30d,
    MAX(start_time) AS last_used,
    DATEDIFF(day, MAX(start_time), CURRENT_TIMESTAMP()) AS days_since_last_use
FROM snowflake.account_usage.warehouse_metering_history
WHERE start_time >= DATEADD(day, -30, CURRENT_TIMESTAMP())
GROUP BY warehouse_name
HAVING days_since_last_use > 7  -- Not used in 7 days
ORDER BY total_credits_30d DESC;
```

### Azure cost monitoring

```bash
# Azure CLI: Check current month spend by resource group
az consumption usage list \
    --start-date 2026-05-01 \
    --end-date 2026-05-31 \
    --query "[?contains(instanceName, 'databricks')].{Name:instanceName, Cost:pretaxCost}" \
    --output table

# Set up budget alert
az consumption budget create \
    --budget-name "migration-parallel-run" \
    --amount 15000 \
    --category Cost \
    --time-grain Monthly \
    --start-date 2026-05-01 \
    --end-date 2026-12-31 \
    --resource-group "rg-analytics-prod"
```

### Cost dashboard during parallel-run

Track these metrics weekly:

| Metric                                        | Target                                  | Alert threshold                    |
| --------------------------------------------- | --------------------------------------- | ---------------------------------- |
| Snowflake daily credits (migrated warehouses) | Declining to zero                       | Any increase week-over-week        |
| Azure daily cost (new warehouses)             | Growing per migration wave              | > 120% of projected cost           |
| Combined daily spend                          | < 130% of pre-migration Snowflake spend | > 150% of pre-migration            |
| Snowflake idle warehouse hours                | Increasing                              | < 50% idle for migrated warehouses |

### Cost reduction actions

After each warehouse cutover:

1. **Suspend** the Snowflake warehouse (do not drop yet)
2. **Set resource monitor** to alert at 1 credit (catch any unexpected usage)
3. **Monitor for 2 weeks** -- if zero credits consumed, proceed to step 4
4. **Drop the warehouse** (after confirming no consumers need it)
5. **Update cost tracking** to reflect the reduction

---

## 3. Data sharing alternatives during migration

During migration, you will have data consumers on both Snowflake and Azure. Bridge strategies:

### Strategy A: Dual publish (recommended)

Publish data products to both platforms during transition:

```
Source data (Snowflake) → Snowflake share (existing consumers)
Source data (Azure)     → Delta share (new consumers)
```

Cost: Higher (running both platforms), but zero consumer disruption.

### Strategy B: Lakehouse Federation bridge

Let Azure consumers read from Snowflake without moving data:

```sql
-- Databricks: Create federation connection to Snowflake
CREATE CONNECTION snowflake_bridge
TYPE snowflake
OPTIONS (
    host 'acmegov.us-gov-west-1.snowflake-gov.com',
    port '443',
    user 'federation_reader',
    password SECRET ('scope', 'snowflake-federation-password')
);

-- Create foreign catalog
CREATE FOREIGN CATALOG snowflake_finance
USING CONNECTION snowflake_bridge
OPTIONS (database 'FINANCE_DB');

-- Azure consumers query Snowflake via federation
SELECT * FROM snowflake_finance.marts.fct_invoice_aging;
```

Cost: Moderate (Snowflake compute for reads), but avoids dual-publish overhead.

### Strategy C: Export and share via ADLS

Export Snowflake data to ADLS Gen2 and share from there:

```sql
-- Snowflake: Export to Azure storage
COPY INTO @azure_stage/finance/fct_invoice_aging/
FROM (SELECT * FROM FINANCE_DB.MARTS.FCT_INVOICE_AGING)
FILE_FORMAT = (TYPE = PARQUET)
OVERWRITE = TRUE;
```

Cost: Lowest during transition, but introduces data staleness.

---

## 4. Common pitfalls and how to avoid them

### Pitfall 1: Migrating everything at once

**Symptom:** Months of planning, no deliverables, stakeholder confidence erodes.

**Prevention:** Migrate one warehouse at a time. Ship the pilot in 3-4 weeks. Each subsequent wave takes 3-5 weeks.

### Pitfall 2: Ignoring SQL dialect differences until runtime

**Symptom:** dbt models compile on Snowflake adapter but fail on Databricks adapter.

**Prevention:** Run the automated SQL dialect scan (see [dbt tutorial](tutorial-dbt-snowflake-to-fabric.md) Step 3) before swapping the adapter. Fix all known dialect issues before attempting `dbt run`.

### Pitfall 3: DATEDIFF argument order

**Symptom:** Negative values where positive expected (or vice versa). Silent data correctness issue.

**Prevention:** This is the single most common SQL translation bug. Snowflake `DATEDIFF(day, start, end)` becomes Databricks `DATEDIFF(end, start)`. Search all models for `DATEDIFF` and verify argument order.

```bash
# Find all DATEDIFF calls that may need argument reversal
grep -rn "DATEDIFF" models/ --include="*.sql"
```

### Pitfall 4: Over-sizing Databricks warehouses

**Symptom:** Azure costs are higher than expected; cost savings not materializing.

**Prevention:** Start one size smaller than the Snowflake equivalent. Databricks Photon engine is more efficient per-compute-unit for scan-heavy workloads. Benchmark the top 20 queries before committing to warehouse size.

### Pitfall 5: Not applying Z-ORDER on Delta tables

**Symptom:** Queries scan more data than expected; performance is worse than Snowflake.

**Prevention:** Snowflake micro-partitions benefit from natural data ordering. Delta Lake needs explicit Z-ORDER on columns used in WHERE and JOIN clauses. Run `OPTIMIZE table ZORDER BY (column)` on large tables after initial load.

### Pitfall 6: Forgetting to enable Delta CDF before migration

**Symptom:** Streams migration fails because Delta Change Data Feed is not enabled on target tables.

**Prevention:** Enable CDF on all tables that had Snowflake Streams before loading data:

```sql
ALTER TABLE analytics_prod.raw.orders
SET TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');
```

### Pitfall 7: Snowflake contract lock-in

**Symptom:** Credit commits prevent reducing Snowflake spend during parallel-run.

**Prevention:** Review your Snowflake contract before starting migration. Key clauses to check:

- Minimum annual credit commitment
- Early termination fees
- Credit rollover policies
- Contract end date

**Negotiation tip:** If you are mid-contract, negotiate a reduced commitment for the remaining term. Snowflake would rather reduce the commitment than lose the customer entirely during the notice period.

### Pitfall 8: Neglecting team training

**Symptom:** Engineers struggle with Databricks; velocity drops; frustration increases.

**Prevention:** Start training in Phase 0 (Discovery):

- Databricks Academy certifications for engineers
- Microsoft Learn paths for Fabric teams
- Hands-on workshops using the pilot warehouse
- Pair programming: one Snowflake expert + one Databricks expert per migration wave

### Pitfall 9: Skipping reconciliation

**Symptom:** Data discrepancies discovered by consumers after cutover; trust is damaged.

**Prevention:** Run reconciliation for every migrated table:

```sql
-- Reconciliation template
SELECT
    'row_count' AS check,
    sf_value, db_value,
    CASE WHEN sf_value = db_value THEN 'PASS' ELSE 'FAIL' END AS status
FROM (
    SELECT
        COUNT(*) AS sf_value,
        (SELECT COUNT(*) FROM analytics_prod.marts.target_table) AS db_value
    FROM snowflake_bridge.marts.source_table
)
UNION ALL
SELECT
    'sum_amount', sf_value, db_value,
    CASE WHEN ABS(sf_value - db_value) / NULLIF(sf_value, 0) < 0.001 THEN 'PASS' ELSE 'FAIL' END
FROM (
    SELECT
        SUM(amount) AS sf_value,
        (SELECT SUM(amount) FROM analytics_prod.marts.target_table) AS db_value
    FROM snowflake_bridge.marts.source_table
);
```

**Acceptance criteria:** Row count exact match; aggregate values within 0.1% variance.

### Pitfall 10: Not decommissioning Snowflake aggressively

**Symptom:** Snowflake continues to consume credits months after migration; cost savings never materialize.

**Prevention:** Set a decommission date per warehouse. Suspend migrated warehouses immediately. Drop them after 30 days of zero usage. Set resource monitors at 1 credit to catch any lingering usage.

---

## 5. Parallel-run checklist

### Before starting parallel-run

- [ ] Azure environment deployed and validated (Phase 1 complete)
- [ ] dbt project compiled and tested on Databricks
- [ ] All SQL dialect issues resolved
- [ ] Delta tables loaded with initial data
- [ ] Z-ORDER applied on key columns
- [ ] Reconciliation queries prepared
- [ ] Cost monitoring dashboards configured
- [ ] Consumer notification sent

### During parallel-run (2+ weeks per warehouse)

- [ ] Daily: Run reconciliation queries (row counts, aggregates)
- [ ] Daily: Check Snowflake credit consumption on migrated warehouses
- [ ] Daily: Check Azure cost trends
- [ ] Weekly: Review query performance (p50, p90, p99)
- [ ] Weekly: Collect consumer feedback
- [ ] Weekly: Update migration status dashboard

### Before cutover

- [ ] Reconciliation passed for 14 consecutive days
- [ ] No P1/P2 defects for 10 business days
- [ ] All consumers confirmed on new platform
- [ ] Rollback procedure documented and tested
- [ ] Snowflake warehouse suspend scheduled

### After cutover

- [ ] Snowflake warehouse suspended (not dropped)
- [ ] Resource monitor set at 1 credit
- [ ] 30-day observation period started
- [ ] Cost savings validated against projection
- [ ] Consumer satisfaction survey sent

---

## 6. Performance optimization checklist

Apply these optimizations after each warehouse migration:

### Delta Lake optimizations

- [ ] Z-ORDER on columns used in WHERE clauses
- [ ] Z-ORDER on columns used in JOIN keys
- [ ] Enable liquid clustering on tables with diverse query patterns (Runtime 14+)
- [ ] Set `delta.autoOptimize.autoCompact = true` on write-heavy tables
- [ ] Set `delta.autoOptimize.optimizeWrite = true` on write-heavy tables
- [ ] Configure `delta.deletedFileRetentionDuration` for Time Travel retention
- [ ] Run `VACUUM` on tables after initial load to reclaim storage

### SQL Warehouse configuration

- [ ] Right-size the warehouse (start one size smaller than Snowflake equivalent)
- [ ] Configure auto-stop (1 minute for dev; 10 minutes for serverless)
- [ ] Configure auto-scaling (match peak concurrency needs)
- [ ] Enable Photon engine (usually default)
- [ ] Set statement timeout to catch runaway queries
- [ ] Configure query queue size and timeout

### Monitoring

- [ ] Configure Databricks SQL query alerts for slow queries (p99 > threshold)
- [ ] Set up Azure Cost Management budget alerts
- [ ] Enable diagnostic logging to Log Analytics
- [ ] Create a dashboard for warehouse utilization and cost

---

## 7. Rollback procedure

If a warehouse migration must be rolled back:

### Immediate rollback (within 24 hours of cutover)

1. **Resume** the Snowflake warehouse
2. **Notify** consumers to switch back to Snowflake endpoints
3. **Investigate** the root cause (query failures, data discrepancies, performance)
4. **Fix** the issue in the Databricks environment
5. **Re-run** parallel-run for another 2 weeks before re-attempting cutover

### Delayed rollback (after 24 hours)

1. **Assess** data staleness on Snowflake (has new data been loaded only to Azure?)
2. If Azure is the source of truth, **reverse-sync** critical data back to Snowflake
3. **Resume** the Snowflake warehouse with synced data
4. **Notify** consumers
5. **Root cause** analysis before re-attempting

### Preventing the need for rollback

- Run parallel for the full 2-week minimum
- Ensure reconciliation passes for all 14 days
- Get explicit consumer sign-off before cutover
- Have a Databricks engineer on-call for the first 48 hours after cutover

---

## 8. Communication templates

### Stakeholder update (weekly)

```
Subject: Snowflake Migration - Week [N] Update

Summary:
- [Wave X] warehouses migrated: [list]
- [Wave X+1] warehouses in parallel-run: [list]
- [Wave X+2] warehouses in planning: [list]

Metrics:
- Cost: Snowflake $X/week → Azure $Y/week (Z% savings realized)
- Performance: p90 query latency [improved/matched/degraded] by [N]%
- Quality: Reconciliation [pass/fail] for [N] of [M] tables

Blockers:
- [None / description]

Next week:
- [Planned actions]
```

### Consumer migration notice

```
Subject: Action Required: [Warehouse] migrating to Azure Databricks

Your data source [table/report/pipeline] currently reads from
Snowflake warehouse [name]. This warehouse is migrating to
Azure Databricks on [date].

What you need to do:
1. Verify access to the new endpoint: [instructions]
2. Test your queries/reports against the new source by [date]
3. Confirm readiness by replying to this email by [date]

What changes:
- Endpoint: [old] → [new]
- Connection: [old method] → [new method]
- Data: Identical (reconciled daily for 2 weeks)
- Performance: [Expected improvement/parity]

Support: Contact [team email] for migration assistance.
```

---

## Related documents

- [Warehouse Migration](warehouse-migration.md) -- detailed per-warehouse migration steps
- [Tutorial: dbt Migration](tutorial-dbt-snowflake-to-fabric.md) -- step-by-step dbt adapter swap
- [TCO Analysis](tco-analysis.md) -- cost modeling for parallel-run planning
- [Benchmarks](benchmarks.md) -- performance comparison data
- [Data Sharing Migration](data-sharing-migration.md) -- sharing alternatives during migration
- [Master playbook](../snowflake.md) -- Section 5 for the phased migration plan

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
