# Best Practices — Teradata to Azure Migration

> **Audience:** Migration leads, program managers, and senior data engineers planning and executing a Teradata-to-Azure migration. This document distills lessons from enterprise migrations into actionable guidance covering schema assessment, workload decomposition, phased cutover, parallel-run validation, and common pitfalls.

---

## 1. Schema assessment methodology

### 1.1 Inventory collection

Before designing anything, build a complete inventory. Run these queries on Teradata:

```sql
-- Table inventory with sizes
SELECT
    DatabaseName,
    TableName,
    TableKind,
    CAST(SUM(CurrentPerm) / 1e9 AS DECIMAL(12,2)) AS size_gb,
    CAST(SUM(PeakPerm) / 1e9 AS DECIMAL(12,2)) AS peak_gb
FROM DBC.TableSizeV
GROUP BY 1, 2, 3
ORDER BY size_gb DESC;

-- Column inventory
SELECT
    DatabaseName,
    TableName,
    ColumnName,
    ColumnType,
    Nullable,
    DefaultValue
FROM DBC.ColumnsV
WHERE DatabaseName NOT IN ('DBC', 'SystemFE', 'SYSLIB', 'SYSUDTLIB')
ORDER BY DatabaseName, TableName, ColumnId;

-- Index inventory (PI, SI, JI)
SELECT
    DatabaseName,
    TableName,
    IndexType,
    IndexName,
    ColumnName,
    UniqueFlag
FROM DBC.IndicesV
WHERE DatabaseName NOT IN ('DBC', 'SystemFE', 'SYSLIB')
ORDER BY DatabaseName, TableName, IndexType;

-- View inventory with complexity
SELECT
    DatabaseName,
    TableName AS ViewName,
    CHARACTERS(RequestText) AS sql_length,
    CASE
        WHEN RequestText LIKE '%JOIN%JOIN%JOIN%' THEN 'Complex (3+ joins)'
        WHEN RequestText LIKE '%JOIN%' THEN 'Medium (1-2 joins)'
        ELSE 'Simple'
    END AS complexity
FROM DBC.TablesV
WHERE TableKind = 'V'
  AND DatabaseName NOT IN ('DBC', 'SystemFE', 'SYSLIB')
ORDER BY sql_length DESC;

-- Stored procedure inventory
SELECT
    DatabaseName,
    TableName AS ProcedureName,
    CHARACTERS(RequestText) AS sql_length,
    CreateTimeStamp,
    LastAlterTimeStamp
FROM DBC.TablesV
WHERE TableKind = 'P'
ORDER BY sql_length DESC;
```

### 1.2 Workload profiling

Query DBQL to understand actual workload patterns:

```sql
-- Top queries by resource consumption (last 30 days)
SELECT
    UserName,
    SUBSTR(QueryText, 1, 200) AS query_preview,
    COUNT(*) AS execution_count,
    AVG(TotalIOCount) AS avg_io,
    AVG(AMPCPUTime) AS avg_cpu_sec,
    AVG(TotalFirstRespTime) AS avg_response_sec,
    MAX(TotalFirstRespTime) AS max_response_sec
FROM DBC.QryLog
WHERE StartTime >= CURRENT_TIMESTAMP - INTERVAL '30' DAY
  AND StatementType IN ('Select', 'Insert', 'Update', 'Delete', 'Merge')
GROUP BY 1, 2
ORDER BY avg_cpu_sec DESC
SAMPLE 100;

-- Workload class distribution
SELECT
    WDName AS workload_class,
    COUNT(*) AS query_count,
    AVG(TotalFirstRespTime) AS avg_response_sec,
    SUM(AMPCPUTime) AS total_cpu_sec,
    MAX(TotalFirstRespTime) AS max_response_sec
FROM DBC.QryLog q
LEFT JOIN DBC.TASMWorkloadV w ON q.WDName = w.WDName
WHERE StartTime >= CURRENT_TIMESTAMP - INTERVAL '7' DAY
GROUP BY 1
ORDER BY total_cpu_sec DESC;

-- Peak concurrency by hour
SELECT
    EXTRACT(HOUR FROM StartTime) AS hour_of_day,
    MAX(concurrent_queries) AS peak_concurrent
FROM (
    SELECT
        StartTime,
        COUNT(*) OVER (
            ORDER BY StartTime
            RANGE BETWEEN INTERVAL '1' MINUTE PRECEDING AND CURRENT ROW
        ) AS concurrent_queries
    FROM DBC.QryLog
    WHERE StartTime >= CURRENT_TIMESTAMP - INTERVAL '7' DAY
) t
GROUP BY 1
ORDER BY 1;
```

### 1.3 Dependency mapping

Identify which tables feed which downstream consumers:

```sql
-- View dependencies (which tables do views reference)
SELECT
    v.DatabaseName AS view_database,
    v.TableName AS view_name,
    d.DatabaseName AS source_database,
    d.TableName AS source_table
FROM DBC.TablesV v
CROSS JOIN TABLE (
    -- Parse view text for table references
    -- This is simplified; use SAMA for comprehensive dependency mapping
    SELECT DatabaseName, TableName
    FROM DBC.TablesV
    WHERE v.RequestText LIKE '%' || TableName || '%'
) d
WHERE v.TableKind = 'V';
```

For comprehensive dependency mapping, use **Microsoft SAMA** which automates this analysis.

---

## 2. Workload decomposition strategy

### 2.1 Decomposition by workload type

Do not migrate all workloads to a single Azure service. Decompose by type:

| Workload type | Characteristics | Best Azure target |
| --- | --- | --- |
| **Classic SQL EDW** | Star schema, scheduled reports, BTEQ scripts | Synapse Dedicated or Fabric Warehouse |
| **Ad-hoc analytics** | Analyst queries, variable complexity | Databricks SQL or Synapse Serverless |
| **Heavy joins/aggregations** | Large fact tables, complex joins | Databricks SQL (Photon) |
| **ML/feature engineering** | Python, Spark, notebooks | Databricks (ML Runtime) |
| **Real-time BI** | Sub-second dashboards | Fabric Direct Lake + Power BI |
| **Operational queries** | <1s response, high concurrency | Synapse Serverless or Cosmos DB |

### 2.2 Decomposition by schema/domain

Migrate one business domain at a time, not one technical component:

```
Migration Wave 1: Finance domain
  - finance.orders
  - finance.invoices
  - finance.payments
  - finance.general_ledger
  - All views, procedures, reports in finance

Migration Wave 2: Customer domain
  - customer.profiles
  - customer.interactions
  - customer.segments
  - All views, procedures, reports in customer

Migration Wave 3: Operations domain
  ...
```

### 2.3 Tier classification per workload

Apply the tier classification to every artifact:

```python
# classification_framework.py

TIER_CRITERIA = {
    'A': {
        'description': 'Direct migrate — automated translation',
        'criteria': [
            'Standard ANSI SQL',
            'No Teradata-specific functions',
            'No QUALIFY (or simple QUALIFY)',
            'No stored procedures',
            'No UDFs',
        ],
        'typical_effort': '1-2 hours per script',
        'tools': ['sqlglot', 'SAMA'],
    },
    'B': {
        'description': 'Refactor required — manual rewrite',
        'criteria': [
            'QUALIFY with complex window functions',
            'Teradata-specific date arithmetic',
            'RECURSIVE views',
            'Simple stored procedures',
            'NORMALIZE / PERIOD operations',
        ],
        'typical_effort': '4-8 hours per script',
        'tools': ['sqlglot (partial)', 'manual review'],
    },
    'C': {
        'description': 'Architectural rework — redesign needed',
        'criteria': [
            'TASM-dependent workload routing',
            'QueryGrid federation',
            'Java/C UDFs',
            'Complex stored procedure chains',
            'Custom BTEQ error handling',
        ],
        'typical_effort': '2-5 days per workload',
        'tools': ['manual design', 'architecture review'],
    },
    'D': {
        'description': 'Decommission — do not migrate',
        'criteria': [
            'No executions in 90+ days',
            'No downstream consumers',
            'Replaced by newer workload',
            'Owner cannot be identified',
        ],
        'typical_effort': '1 hour (archive and delete)',
        'tools': ['DBQL analysis'],
    },
}
```

---

## 3. Primary Index to partition mapping

### 3.1 Analysis framework

For every table with a Primary Index, determine the Azure distribution/partition strategy:

```sql
-- Analyze PI usage: which queries actually use the PI for joins?
SELECT
    t.DatabaseName,
    t.TableName,
    i.ColumnName AS pi_column,
    COUNT(DISTINCT q.QueryID) AS queries_using_pi,
    SUM(CASE WHEN q.QueryText LIKE '%JOIN%' || t.TableName || '%ON%' || i.ColumnName || '%'
             THEN 1 ELSE 0 END) AS join_queries_on_pi
FROM DBC.TablesV t
JOIN DBC.IndicesV i ON t.DatabaseName = i.DatabaseName AND t.TableName = i.TableName
LEFT JOIN DBC.QryLog q ON q.QueryText LIKE '%' || t.TableName || '%'
WHERE i.IndexType = 'P'
  AND q.StartTime >= CURRENT_TIMESTAMP - INTERVAL '30' DAY
GROUP BY 1, 2, 3
ORDER BY queries_using_pi DESC;
```

### 3.2 Mapping rules

| Teradata PI pattern | Azure strategy | When to use |
| --- | --- | --- |
| PI on natural key (customer_id) | Synapse HASH distribution on same key | When most joins use this key |
| PI on surrogate key (order_id) | Synapse ROUND_ROBIN or HASH | When PI is arbitrary |
| PI on composite key | Synapse HASH on most selective column | Pick the column used in most joins |
| PPI on date column | Delta PARTITION BY (date column) | Almost always correct |
| PI + PPI combination | Synapse HASH + partition / Delta Z-ORDER + partition | Combine strategies |

### 3.3 Distribution skew detection

After migrating, check for distribution skew:

```sql
-- Synapse: check distribution skew
DBCC PDW_SHOWSPACEUSED('silver.orders');

-- If one distribution has >2x the average rows, redistribution is needed
-- Target: all distributions within 10% of the average

-- Databricks: check partition sizes
DESCRIBE DETAIL silver.orders;
-- Check numFiles and sizeInBytes per partition
```

---

## 4. Phased cutover per schema

### 4.1 Cutover sequence

For each migration wave/schema:

```
Week 1-2: Preparation
├── Data migration complete and validated
├── dbt models tested and producing output
├── Monitoring and alerting configured
└── Rollback plan documented

Week 3-4: Parallel run
├── Both Teradata and Azure produce output daily
├── Automated reconciliation compares results
├── Any discrepancies investigated and resolved
├── BI consumers still reading from Teradata
└── Daily reconciliation report to stakeholders

Week 5: Soft cutover
├── BI consumers switched to Azure
├── Teradata continues running as backup
├── Team monitors Azure performance and data quality
├── Any issues → immediate rollback to Teradata
└── Stakeholder sign-off for hard cutover

Week 6+: Hard cutover
├── Teradata workload set to read-only
├── 30-day observation period
├── If stable → begin decommission planning
└── If issues → extend parallel run
```

### 4.2 Go/no-go criteria

Before each cutover, verify:

| Criterion | Threshold | Validation method |
| --- | --- | --- |
| Row count match | 100% exact | Automated count comparison |
| Revenue totals | <$0.01 variance | Golden query comparison |
| Query latency p95 | Within 2x of Teradata | Performance monitoring |
| Data freshness | <30 min lag (CDC) | Watermark monitoring |
| All tests passing | 100% dbt tests pass | dbt test run |
| Stakeholder approval | Written sign-off | Email or ticket |

---

## 5. Parallel-run validation

### 5.1 Automated reconciliation framework

```python
# reconciliation.py
# Run daily during parallel-run period

import pandas as pd
from datetime import date, timedelta

RECONCILIATION_QUERIES = {
    'orders_row_count': {
        'teradata': "SELECT COUNT(*) AS cnt FROM production.orders WHERE order_date = CURRENT_DATE - 1",
        'azure': "SELECT COUNT(*) AS cnt FROM silver.orders WHERE order_date = DATE_SUB(CURRENT_DATE(), 1)",
        'tolerance': 0,
        'severity': 'CRITICAL',
    },
    'orders_revenue_total': {
        'teradata': "SELECT SUM(amount) AS total FROM production.orders WHERE order_date = CURRENT_DATE - 1",
        'azure': "SELECT SUM(amount) AS total FROM silver.orders WHERE order_date = DATE_SUB(CURRENT_DATE(), 1)",
        'tolerance': 0.01,
        'severity': 'CRITICAL',
    },
    'summary_aggregation': {
        'teradata': """SELECT region_id, SUM(net_revenue) AS total
                       FROM production.orders_summary
                       WHERE order_date = CURRENT_DATE - 1
                       GROUP BY region_id ORDER BY region_id""",
        'azure': """SELECT region_id, SUM(net_revenue) AS total
                    FROM silver.orders_summary
                    WHERE order_date = DATE_SUB(CURRENT_DATE(), 1)
                    GROUP BY region_id ORDER BY region_id""",
        'tolerance': 0.01,
        'severity': 'HIGH',
    },
}

def run_reconciliation(td_conn, az_conn):
    results = []
    for name, config in RECONCILIATION_QUERIES.items():
        td_df = pd.read_sql(config['teradata'], td_conn)
        az_df = pd.read_sql(config['azure'], az_conn)

        # Compare
        row_match = len(td_df) == len(az_df)
        value_match = True

        for col in td_df.select_dtypes(include='number').columns:
            td_val = td_df[col].sum()
            az_val = az_df[col].sum()
            if abs(td_val - az_val) > config['tolerance']:
                value_match = False

        status = 'PASS' if (row_match and value_match) else 'FAIL'
        results.append({
            'check': name,
            'status': status,
            'severity': config['severity'],
            'teradata_result': td_df.to_dict(),
            'azure_result': az_df.to_dict(),
            'timestamp': pd.Timestamp.now(),
        })

    return results
```

### 5.2 Reconciliation dashboard

Build a Power BI or Grafana dashboard showing:

| Panel | Description |
| --- | --- |
| Pass/fail summary | Green/red for each reconciliation check |
| Daily trend | Pass rate over the parallel-run period |
| Discrepancy detail | Breakdown of any failures with values |
| CDC latency | Time between Teradata write and Azure availability |
| Schema coverage | % of tables/views with passing reconciliation |

---

## 6. Common pitfalls (expanded)

### Pitfall 1: Translating BTEQ line-by-line

**Problem:** Teams often attempt to convert every BTEQ script to an equivalent Azure SQL script, preserving the same structure, error handling, and file I/O patterns.

**Why it fails:** BTEQ's paradigm (connection → execute → check error → export → disconnect) does not map to Azure's paradigm (dbt model → test → deploy).

**Solution:** Convert to dbt models. The dbt framework handles:
- Dependency management (DAG)
- Error handling (built-in)
- Testing (schema + custom tests)
- Documentation (auto-generated)
- Scheduling (dbt Cloud or Databricks Jobs)

**Metric:** Teams that convert to dbt complete migration 30-40% faster than teams that convert BTEQ to equivalent notebook scripts.

---

### Pitfall 2: Keeping Teradata-style workload management

**Problem:** Teams try to replicate TASM's single-system workload management in Azure using a single SQL warehouse with complex routing rules.

**Why it fails:** Azure's architecture is fundamentally different. Trying to manage workloads within one endpoint creates the same contention problems without Teradata's mature management engine.

**Solution:** Separate workloads into dedicated compute endpoints. See [Workload Migration](workload-migration.md).

---

### Pitfall 3: Underestimating BI re-validation

**Problem:** Migration plans allocate 10-15% of effort to BI validation. Actual effort is 30-50%.

**Why it fails:** Every dashboard, report, and data extract must be:
- Repointed to Azure data source
- Visually validated (numbers match)
- Performance tested (load times acceptable)
- Re-certified by business users

**Solution:** Budget 30-50% of total migration effort for BI re-validation. Assign business analysts (not just engineers) to validate every report.

---

### Pitfall 4: Forgetting stored procedures and macros

**Problem:** Stored procedures and macros contain hidden business logic. Teams discover them late in migration.

**Solution:** Inventory all procedures and macros during assessment (Phase 1). Classify each by:
- Lines of code
- Teradata-specific features used
- Downstream consumers
- Last execution date (from DBQL)

Budget 2-5 days per complex stored procedure for conversion.

---

### Pitfall 5: No parallel-run window

**Problem:** "Cutover and pray" — switching from Teradata to Azure without a parallel-run period.

**Why it fails:** Data issues, SQL translation bugs, and performance problems only emerge under real production load. Without a parallel run, there is no safety net.

**Solution:** Always run 14-30 day parallel runs per schema. Automate reconciliation. Do not decommission Teradata workloads until reconciliation passes for 14 consecutive days.

---

### Pitfall 6: Trying to migrate everything

**Problem:** Teams attempt to migrate every table, view, procedure, and report — including those nobody uses.

**Why it fails:** 20-40% of workloads in most Teradata estates are "zombie" workloads: tables with no reads, procedures with no executions, reports with no consumers.

**Solution:** Use DBQL to identify workloads with no activity in 90+ days. Classify as Tier-D (decommission). Archive output (if any) and delete. This reduces migration scope by 20-40%.

---

### Pitfall 7: Ignoring data distribution strategy

**Problem:** Tables are migrated without considering Teradata PI → Azure distribution mapping. Queries that were fast on Teradata (co-located joins) become slow on Azure (data shuffling).

**Solution:** For every table with >10M rows, explicitly design the distribution strategy:
- Analyze PI columns and join patterns
- Choose HASH distribution (Synapse) or Z-ORDER (Databricks)
- Test join performance before cutover
- Monitor for distribution skew after loading

---

### Pitfall 8: Underestimating the timeline

**Problem:** Executive sponsors expect 6-12 months. Real timelines are 18-36 months for enterprise estates.

**Why it fails:** Migration involves not just data and SQL, but also:
- Change management (users learning new tools)
- BI re-validation (every report and dashboard)
- Integration testing (downstream consumers)
- Regulatory compliance re-certification
- Training and documentation

**Solution:** Set realistic expectations from day one. Use the Gantt chart in the [index page](index.md) as a starting reference. Plan for executive air cover lasting the full duration.

---

## 7. Project organization

### 7.1 Team structure

| Role | FTE (medium estate) | Responsibilities |
| --- | --- | --- |
| Migration lead / PM | 1 | Overall coordination, stakeholder management |
| Teradata SME | 1-2 | Source system knowledge, SQL translation review |
| Azure architect | 1 | Target architecture design, performance tuning |
| Data engineer (SQL) | 3-5 | SQL conversion, dbt model development |
| Data engineer (ETL) | 2-3 | ADF pipelines, data loading, CDC |
| BI developer | 2-3 | Report re-validation, Power BI conversion |
| QA/validation | 1-2 | Reconciliation, testing, data quality |
| Security engineer | 0.5-1 | Access control, compliance validation |

### 7.2 Sprint cadence

```
2-week sprints:
  Sprint 1: Assessment + inventory (Tier classification)
  Sprint 2-3: Target architecture design
  Sprint 4-6: Tier-D decommission + Tier-A automated conversion
  Sprint 7-12: Tier-B manual conversion (iterative)
  Sprint 13-18: Tier-C architectural redesign
  Sprint 19-22: BI re-validation + parallel run
  Sprint 23-24: Cutover + stabilization
```

### 7.3 Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Teradata license expires mid-migration | Medium | Critical | Negotiate short-term extension before starting |
| Key Teradata SME leaves | Medium | High | Document all knowledge in first 4 weeks |
| Azure performance does not meet SLA | Medium | High | Benchmark critical queries in Phase 2 |
| Budget overrun (dual-run costs) | High | Medium | Accurate dual-run cost model in business case |
| Stakeholder fatigue (18+ month program) | High | Medium | Regular progress demos, quick wins in early sprints |
| Undiscovered business logic in procedures | Medium | High | Comprehensive inventory in Phase 1 |

---

## 8. Post-migration optimization

After migration and stabilization, optimize the Azure environment:

### 8.1 First 30 days

- [ ] Enable auto-pause on all non-production SQL warehouses
- [ ] Review and right-size warehouse sizes based on actual usage
- [ ] Set up cost alerts at 80% and 100% of budget
- [ ] Run `OPTIMIZE` and `ZORDER` on all large Delta tables
- [ ] Enable Delta auto-optimize (auto-compact + optimized writes)

### 8.2 First 90 days

- [ ] Evaluate reserved capacity commitments (Databricks/Fabric)
- [ ] Implement ADLS lifecycle policies (hot → cool → archive)
- [ ] Set up materialized views for frequent aggregation queries
- [ ] Review query patterns and adjust Z-ORDER columns
- [ ] Consolidate monitoring into a single dashboard

### 8.3 First 6 months

- [ ] Evaluate additional Azure capabilities (AI/ML, streaming)
- [ ] Implement dbt contracts for data quality governance
- [ ] Set up Microsoft Purview for automated classification
- [ ] Review and optimize Power BI semantic models (Direct Lake)
- [ ] Begin training team on advanced Azure features

---

## 9. Related resources

- [Teradata Migration Overview](../teradata.md) — Foundational migration guide
- [Index](index.md) — Full package navigation and Gantt chart
- [TCO Analysis](tco-analysis.md) — Business case and cost modeling
- [Why Azure over Teradata](why-azure-over-teradata.md) — Strategic rationale
- [Feature Mapping](feature-mapping-complete.md) — Complete feature mapping
- [SQL Migration](sql-migration.md) — SQL conversion patterns
- [Data Migration](data-migration.md) — Data loading and validation
- [Workload Migration](workload-migration.md) — TASM replacement
- [Security Migration](security-migration.md) — Security model migration
- [Benchmarks](benchmarks.md) — Performance comparison
- Microsoft SAMA: <https://aka.ms/sama>
- dbt best practices: <https://docs.getdbt.com/best-practices>

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
