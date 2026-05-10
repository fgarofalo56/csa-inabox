---
title: "Azure Synapse Query Performance Troubleshooting"
description: "Comprehensive guide for diagnosing and resolving slow queries, analyzing execution plans, and optimizing statistics in Azure Synapse Analytics."
tags:
  - troubleshooting
  - synapse
---
# Azure Synapse Query Performance Troubleshooting

![Status](https://img.shields.io/badge/Status-Active-brightgreen) ![Complexity](https://img.shields.io/badge/Complexity-Advanced-red)

Comprehensive guide for diagnosing and resolving slow queries, analyzing execution plans, and optimizing statistics in Azure Synapse Analytics.

## Table of Contents

- [Overview](#overview)
- [Common Performance Issues](#common-performance-issues)
- [Diagnostic Queries](#diagnostic-queries)
- [Execution Plan Analysis](#execution-plan-analysis)
- [Statistics Management](#statistics-management)
- [Query Optimization](#query-optimization)
- [Resource Waits](#resource-waits)
- [Resolution Procedures](#resolution-procedures)

---

## Overview

Query performance issues in Azure Synapse can significantly impact your analytics workloads. This guide helps identify bottlenecks, analyze execution plans, update statistics, and implement optimization strategies.

> **⚠️ Important:** Always test performance optimizations in a non-production environment first.

---

## Common Performance Issues

### Issue 1: Slow Query Execution

**Symptoms:**
- Queries taking significantly longer than expected
- Timeouts on previously working queries
- Inconsistent query performance

**Common Causes:**
| Cause | Likelihood | Impact | Quick Check |
|:------|:-----------|:-------|:------------|
| Outdated statistics | High | High | `SELECT STATS_DATE(...)` |
| Missing indexes | Medium | High | Check execution plan |
| Data skew | Medium | High | `DBCC PDW_SHOWSPACEUSED` |
| Resource contention | High | Medium | `sys.dm_pdw_resource_waits` |
| Poor query design | Medium | High | Review execution plan |

---

### Issue 2: Query Timeouts

**Error Message:**
```text
Timeout expired. The timeout period elapsed prior to completion of the operation or the server is not responding.
```

**Step-by-Step Resolution:**

#### 1. Check Current Running Queries

```sql
-- Find long-running queries
SELECT
    request_id,
    session_id,
    status,
    command,
    total_elapsed_time/1000 AS elapsed_seconds,
    start_time,
    SUBSTRING(sql_text.text, (statement_start_offset/2)+1,
        ((CASE statement_end_offset
            WHEN -1 THEN DATALENGTH(sql_text.text)
            ELSE statement_end_offset
        END - statement_start_offset)/2) + 1) AS query_text
FROM sys.dm_pdw_exec_requests er
CROSS APPLY sys.dm_exec_sql_text(er.command) AS sql_text
WHERE status IN ('Running', 'Suspended')
ORDER BY total_elapsed_time DESC;
```

#### 2. Kill Problematic Query (If Needed)

```sql
-- Kill a specific query
KILL 'session_id';  -- Replace with actual session ID

-- Or use:
SELECT session_id, command
FROM sys.dm_pdw_exec_sessions
WHERE is_user_process = 1 AND status = 'active';

-- Then kill it
KILL 'QID123456';  -- Replace with actual request ID
```

> **⚠️ Warning:** Only kill queries if absolutely necessary. This will rollback any uncommitted changes.

#### 3. Increase Query Timeout

**Application Level (C#):**
```csharp
// Increase command timeout
var connectionString = "Server=...;Database=...;";
using (var connection = new SqlConnection(connectionString))
{
    var command = new SqlCommand("SELECT ...", connection);
    command.CommandTimeout = 300; // 5 minutes
    connection.Open();
    var result = command.ExecuteReader();
}
```

**Connection String:**
```text
Server=<workspace>.sql.azuresynapse.net;Database=<db>;Connection Timeout=300;
```

#### 4. Optimize the Query

See [Query Optimization](#query-optimization) section below.

---

## Diagnostic Queries

### Query Performance Diagnostics

```sql
-- ==================================================
-- Query Performance Diagnostics Master Script
-- ==================================================

-- 1. Currently Running Queries
SELECT
    r.request_id,
    r.session_id,
    r.status,
    r.command,
    r.total_elapsed_time/1000 AS elapsed_seconds,
    r.start_time,
    r.login_name,
    r.resource_class,
    r.importance,
    SUBSTRING(sql_text.text, (r.statement_start_offset/2)+1,
        ((CASE r.statement_end_offset
            WHEN -1 THEN DATALENGTH(sql_text.text)
            ELSE r.statement_end_offset
        END - r.statement_start_offset)/2) + 1) AS query_text
FROM sys.dm_pdw_exec_requests r
CROSS APPLY sys.dm_exec_sql_text(r.command) AS sql_text
WHERE r.status IN ('Running', 'Suspended')
    AND r.session_id <> SESSION_ID() -- Exclude current session
ORDER BY r.total_elapsed_time DESC;

-- 2. Recent Completed Queries
SELECT TOP 20
    request_id,
    session_id,
    status,
    command,
    total_elapsed_time/1000 AS elapsed_seconds,
    start_time,
    end_time,
    login_name,
    error_id
FROM sys.dm_pdw_exec_requests
WHERE status IN ('Completed', 'Failed')
    AND start_time >= DATEADD(HOUR, -1, GETDATE())
ORDER BY total_elapsed_time DESC;

-- 3. Query Wait Statistics
SELECT
    wait_type,
    SUM(wait_time_ms)/1000.0 AS total_wait_seconds,
    AVG(wait_time_ms)/1000.0 AS avg_wait_seconds,
    MAX(wait_time_ms)/1000.0 AS max_wait_seconds,
    COUNT(*) AS wait_count
FROM sys.dm_pdw_waits
WHERE request_id IN (
    SELECT request_id
    FROM sys.dm_pdw_exec_requests
    WHERE start_time >= DATEADD(HOUR, -1, GETDATE())
)
GROUP BY wait_type
HAVING SUM(wait_time_ms) > 1000
ORDER BY total_wait_seconds DESC;

-- 4. Resource Class Assignment
SELECT
    s.session_id,
    s.login_name,
    r.resource_class,
    r.importance,
    r.command,
    r.status
FROM sys.dm_pdw_exec_sessions s
LEFT JOIN sys.dm_pdw_exec_requests r ON s.session_id = r.session_id
WHERE s.is_user_process = 1
ORDER BY s.session_id;

-- 5. Table Statistics Age
SELECT
    sch.name AS schema_name,
    tab.name AS table_name,
    stat.name AS stats_name,
    STATS_DATE(stat.object_id, stat.stats_id) AS stats_last_updated,
    DATEDIFF(DAY, STATS_DATE(stat.object_id, stat.stats_id), GETDATE()) AS days_old
FROM sys.tables tab
INNER JOIN sys.schemas sch ON tab.schema_id = sch.schema_id
INNER JOIN sys.stats stat ON stat.object_id = tab.object_id
WHERE STATS_DATE(stat.object_id, stat.stats_id) IS NOT NULL
    AND DATEDIFF(DAY, STATS_DATE(stat.object_id, stat.stats_id), GETDATE()) > 7
ORDER BY days_old DESC;
```

---

## Execution Plan Analysis

### Understanding Execution Plans

**Get Execution Plan:**

```sql
-- Enable execution plan output
SET SHOWPLAN_XML ON;
GO

-- Run your query
SELECT ...

SET SHOWPLAN_XML OFF;
GO
```

**Analyze Query Steps:**

```sql
-- Get detailed execution steps
SELECT
    request_id,
    step_index,
    operation_type,
    distribution_type,
    location_type,
    row_count,
    estimated_rows,
    total_elapsed_time/1000 AS elapsed_seconds
FROM sys.dm_pdw_request_steps
WHERE request_id = 'QID123456'  -- Replace with your request ID
ORDER BY step_index;
```

### Common Plan Issues

#### 1. Data Movement Operations

**Identify Excessive Data Movement:**

```sql
-- Find queries with high data movement
SELECT
    rs.request_id,
    rs.step_index,
    rs.operation_type,
    rs.distribution_type,
    rs.row_count,
    rs.total_elapsed_time/1000 AS elapsed_seconds,
    CASE
        WHEN rs.operation_type IN ('BroadcastMoveOperation', 'ShuffleMoveOperation', 'TrimMoveOperation')
        THEN 'Data Movement'
        ELSE 'Other'
    END AS operation_category
FROM sys.dm_pdw_request_steps rs
WHERE rs.request_id IN (
    SELECT TOP 10 request_id
    FROM sys.dm_pdw_exec_requests
    WHERE status = 'Completed'
        AND start_time >= DATEADD(HOUR, -1, GETDATE())
    ORDER BY total_elapsed_time DESC
)
    AND rs.operation_type IN ('BroadcastMoveOperation', 'ShuffleMoveOperation', 'TrimMoveOperation')
ORDER BY rs.total_elapsed_time DESC;
```

**Solutions:**
- Use replicated tables for small dimension tables
- Distribute fact tables on join keys
- Ensure distribution keys align with query patterns

#### 2. Table Scans on Large Tables

**Detect Full Table Scans:**

```sql
-- Identify table scans
SELECT
    rs.request_id,
    rs.step_index,
    rs.operation_type,
    rs.row_count,
    rs.estimated_rows,
    rs.total_elapsed_time/1000 AS elapsed_seconds
FROM sys.dm_pdw_request_steps rs
WHERE rs.operation_type LIKE '%TableScan%'
    AND rs.row_count > 1000000  -- Large scans
    AND rs.request_id IN (
        SELECT request_id
        FROM sys.dm_pdw_exec_requests
        WHERE start_time >= DATEADD(HOUR, -1, GETDATE())
    )
ORDER BY rs.row_count DESC;
```

**Solutions:**
- Add appropriate WHERE clauses to filter data early
- Create column store indexes
- Consider partitioning large tables
- Update statistics

---

## Statistics Management

### Check Statistics Status

```sql
-- Comprehensive statistics check
SELECT
    sm.name AS schema_name,
    tb.name AS table_name,
    st.name AS stats_name,
    STATS_DATE(st.object_id, st.stats_id) AS last_updated,
    DATEDIFF(DAY, STATS_DATE(st.object_id, st.stats_id), GETDATE()) AS days_old,
    st.auto_created,
    st.user_created,
    STUFF((
        SELECT ', ' + c.name
        FROM sys.stats_columns sc
        INNER JOIN sys.columns c ON sc.object_id = c.object_id AND sc.column_id = c.column_id
        WHERE sc.object_id = st.object_id AND sc.stats_id = st.stats_id
        FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS columns_in_stats
FROM sys.stats st
INNER JOIN sys.tables tb ON st.object_id = tb.object_id
INNER JOIN sys.schemas sm ON tb.schema_id = sm.schema_id
WHERE st.name NOT LIKE '_WA_Sys%' -- Exclude auto-generated stats
ORDER BY days_old DESC, schema_name, table_name;
```

### Update Statistics

**Update All Statistics on a Table:**

```sql
-- Update statistics for a specific table
UPDATE STATISTICS schema_name.table_name;

-- Update statistics with full scan
UPDATE STATISTICS schema_name.table_name WITH FULLSCAN;

-- Update statistics with sample
UPDATE STATISTICS schema_name.table_name WITH SAMPLE 50 PERCENT;
```

**Update All Statistics in Database:**

```sql
-- Generate update statistics commands
SELECT
    'UPDATE STATISTICS [' + s.name + '].[' + t.name + '] WITH FULLSCAN;' AS update_command
FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE t.is_external = 0  -- Exclude external tables
ORDER BY s.name, t.name;
```

**Automated Statistics Update Script:**

```sql
-- ==================================================
-- Automated Statistics Update
-- Updates statistics older than 7 days
-- ==================================================
DECLARE @schema_name NVARCHAR(128);
DECLARE @table_name NVARCHAR(128);
DECLARE @sql NVARCHAR(MAX);

DECLARE stats_cursor CURSOR FOR
SELECT DISTINCT
    s.name AS schema_name,
    t.name AS table_name
FROM sys.stats st
INNER JOIN sys.tables t ON st.object_id = t.object_id
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
WHERE DATEDIFF(DAY, STATS_DATE(st.object_id, st.stats_id), GETDATE()) > 7
    OR STATS_DATE(st.object_id, st.stats_id) IS NULL;

OPEN stats_cursor;
FETCH NEXT FROM stats_cursor INTO @schema_name, @table_name;

WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = 'UPDATE STATISTICS [' + @schema_name + '].[' + @table_name + '] WITH FULLSCAN;';
    PRINT 'Updating statistics for ' + @schema_name + '.' + @table_name;
    EXEC sp_executesql @sql;

    FETCH NEXT FROM stats_cursor INTO @schema_name, @table_name;
END

CLOSE stats_cursor;
DEALLOCATE stats_cursor;

PRINT 'Statistics update complete.';
```

### Create Custom Statistics

```sql
-- Create statistics on frequently filtered columns
CREATE STATISTICS stat_customer_city
ON dbo.Customer (City);

-- Create multi-column statistics
CREATE STATISTICS stat_order_customer_date
ON dbo.Orders (CustomerID, OrderDate);

-- Create statistics with sampling
CREATE STATISTICS stat_product_category
ON dbo.Product (CategoryID) WITH SAMPLE 25 PERCENT;

-- Create statistics with full scan
CREATE STATISTICS stat_sales_date
ON dbo.Sales (SaleDate) WITH FULLSCAN;
```

---

## Query Optimization

### Optimization Techniques

#### 1. Use Result Set Caching

```sql
-- Enable result set caching for database
ALTER DATABASE <database_name>
SET RESULT_SET_CACHING ON;

-- Check if result set caching is enabled
SELECT name, is_result_set_caching_on
FROM sys.databases;

-- For specific query (session level)
SET RESULT_SET_CACHING ON;
SELECT ...;
SET RESULT_SET_CACHING OFF;

-- Check cache hit rate
SELECT
    request_id,
    command,
    result_cache_hit,
    total_elapsed_time/1000 AS elapsed_seconds
FROM sys.dm_pdw_exec_requests
WHERE result_cache_hit = 1
    AND start_time >= DATEADD(HOUR, -1, GETDATE())
ORDER BY start_time DESC;
```

#### 2. Optimize JOIN Operations

**Use Appropriate Distribution:**

```sql
-- Redistribute table to match join key
CREATE TABLE dbo.Sales_Distributed
WITH (
    DISTRIBUTION = HASH(CustomerID),  -- Match join column
    CLUSTERED COLUMNSTORE INDEX
)
AS
SELECT * FROM dbo.Sales;

-- Use replicated tables for small dimensions
CREATE TABLE dbo.DimSmall
WITH (
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
)
AS
SELECT * FROM dbo.Dimension;
```

**Optimize JOIN Order:**

```sql
-- Bad: Large table first
SELECT *
FROM LargeFactTable f
JOIN SmallDimension d ON f.DimKey = d.DimKey
WHERE d.Category = 'A';

-- Good: Filter first, then join
SELECT *
FROM SmallDimension d
JOIN LargeFactTable f ON d.DimKey = f.DimKey
WHERE d.Category = 'A';
```

#### 3. Partition Elimination

```sql
-- Create partitioned table
CREATE TABLE dbo.Sales_Partitioned
(
    SaleID INT,
    SaleDate DATE,
    Amount DECIMAL(10,2)
)
WITH (
    DISTRIBUTION = HASH(SaleID),
    PARTITION (SaleDate RANGE RIGHT FOR VALUES
        ('2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01'))
);

-- Query with partition elimination
SELECT *
FROM dbo.Sales_Partitioned
WHERE SaleDate >= '2024-03-01' AND SaleDate < '2024-04-01';

-- Verify partition elimination
EXPLAIN
SELECT *
FROM dbo.Sales_Partitioned
WHERE SaleDate >= '2024-03-01' AND SaleDate < '2024-04-01';
```

#### 4. Columnstore Optimization

```sql
-- Check columnstore health
SELECT
    object_name(object_id) AS table_name,
    i.name AS index_name,
    partition_number,
    total_rows,
    deleted_rows,
    100.0 * deleted_rows / NULLIF(total_rows, 0) AS fragmentation_pct
FROM sys.dm_pdw_nodes_db_column_store_row_group_physical_stats s
INNER JOIN sys.indexes i ON s.object_id = i.object_id AND s.index_id = i.index_id
WHERE deleted_rows > 0
ORDER BY fragmentation_pct DESC;

-- Rebuild columnstore index
ALTER INDEX ALL ON dbo.TableName REBUILD;

-- Reorganize to remove deleted rows
ALTER INDEX ALL ON dbo.TableName REORGANIZE;
```

---

## Resource Waits

### Identify Resource Bottlenecks

```sql
-- Top wait types
SELECT TOP 20
    wait_type,
    COUNT(*) AS wait_count,
    SUM(wait_time_ms)/1000.0 AS total_wait_seconds,
    AVG(wait_time_ms)/1000.0 AS avg_wait_seconds,
    MAX(wait_time_ms)/1000.0 AS max_wait_seconds
FROM sys.dm_pdw_waits
WHERE request_id IN (
    SELECT request_id
    FROM sys.dm_pdw_exec_requests
    WHERE start_time >= DATEADD(HOUR, -24, GETDATE())
)
GROUP BY wait_type
ORDER BY total_wait_seconds DESC;
```

### Common Wait Types

| Wait Type | Cause | Solution |
|:----------|:------|:---------|
| **LockWait** | Blocking from concurrent queries | Review locking, optimize queries |
| **AggregationHashJoinWait** | Hash join spilling to disk | Increase DWU, optimize join |
| **DistributionHashJoinWait** | Data skew in distributed join | Re-distribute tables |
| **IO_COMPLETION** | Slow storage I/O | Check storage performance |
| **PAGEIOLATCH** | Memory pressure | Increase DWU or optimize memory usage |

### Check Resource Classes

```sql
-- Check current resource class assignments
SELECT
    s.login_name,
    s.session_id,
    r.resource_class,
    r.importance,
    r.command,
    r.total_elapsed_time/1000 AS elapsed_seconds
FROM sys.dm_pdw_exec_sessions s
LEFT JOIN sys.dm_pdw_exec_requests r ON s.session_id = r.session_id
WHERE s.is_user_process = 1;

-- Assign user to higher resource class
EXEC sp_addrolemember 'largerc', 'user@domain.com';

-- Remove from resource class
EXEC sp_droprolemember 'largerc', 'user@domain.com';
```

---

## Resolution Procedures

### Procedure 1: Slow Query Quick Fix

**When to Use:** Query suddenly running slower than normal

**Steps:**

1. **Update Statistics:**
   ```sql
   UPDATE STATISTICS schema_name.table_name WITH FULLSCAN;
   ```

2. **Check for Blocking:**
   ```sql
   SELECT * FROM sys.dm_pdw_lock_waits;
   ```

3. **Clear Plan Cache:**
   ```sql
   DBCC FREEPROCCACHE;
   ```

4. **Re-run Query and Monitor:**
   ```sql
   -- Get request ID
   SELECT request_id, status, total_elapsed_time
   FROM sys.dm_pdw_exec_requests
   WHERE session_id = SESSION_ID()
   ORDER BY start_time DESC;
   ```

---

### Procedure 2: Comprehensive Performance Audit

**When to Use:** Systematic performance review

**Steps:**

1. **Gather Baseline Metrics:**
   ```sql
   -- Save to temp table for comparison
   SELECT *
   INTO #baseline_queries
   FROM sys.dm_pdw_exec_requests
   WHERE start_time >= DATEADD(DAY, -7, GETDATE());
   ```

2. **Identify Top Slow Queries:**
   ```sql
   SELECT TOP 20
       request_id,
       command,
       total_elapsed_time/1000 AS elapsed_seconds,
       start_time,
       end_time
   FROM #baseline_queries
   ORDER BY total_elapsed_time DESC;
   ```

3. **Analyze Each Query:**
   - Review execution plan
   - Check statistics age
   - Verify distribution strategy
   - Look for data movement

4. **Implement Fixes:**
   - Update statistics
   - Add/modify indexes
   - Adjust resource classes
   - Optimize query logic

5. **Monitor Improvements:**
   ```sql
   -- Compare before/after
   SELECT
       'Before' AS period,
       AVG(total_elapsed_time)/1000 AS avg_elapsed_seconds
   FROM #baseline_queries
   UNION ALL
   SELECT
       'After' AS period,
       AVG(total_elapsed_time)/1000 AS avg_elapsed_seconds
   FROM sys.dm_pdw_exec_requests
   WHERE start_time >= DATEADD(HOUR, -1, GETDATE());
   ```

---

### Procedure 3: Production Query Timeout Emergency

**When to Use:** Production queries timing out

**Immediate Actions:**

1. **Identify Blocking Queries:**
   ```sql
   SELECT *
   FROM sys.dm_pdw_lock_waits;
   ```

2. **Kill Long-Running Queries (If Necessary):**
   ```sql
   -- Find sessions
   SELECT session_id, login_name, status, command
   FROM sys.dm_pdw_exec_sessions
   WHERE is_user_process = 1;

   -- Kill problematic session
   KILL 'session_id';
   ```

3. **Scale Up Temporarily:**
   ```bash
   az synapse sql pool update \
       --name <pool-name> \
       --workspace-name <workspace-name> \
       --resource-group <rg-name> \
       --performance-level DW500c
   ```

4. **Update Critical Statistics:**
   ```sql
   UPDATE STATISTICS [schema].[critical_table] WITH FULLSCAN;
   ```

5. **Monitor Recovery:**
   ```sql
   SELECT
       request_id,
       status,
       command,
       total_elapsed_time/1000 AS elapsed_seconds
   FROM sys.dm_pdw_exec_requests
   WHERE start_time >= DATEADD(MINUTE, -30, GETDATE())
   ORDER BY start_time DESC;
   ```

---

## When to Contact Support

Contact Microsoft Support if:

- [ ] Queries consistently slow despite optimization
- [ ] Execution plans show unexpected behavior
- [ ] Statistics updates don't improve performance
- [ ] Resource waits indicate platform issues
- [ ] Performance degraded after platform update
- [ ] Scaling up doesn't improve performance

**Information to Provide:**
- Request IDs of slow queries
- Execution plans (as XML)
- Statistics update history
- Resource class assignments
- Table distribution strategies
- Historical performance baselines

---

## Related Resources

- [Connectivity Troubleshooting](connectivity.md)
- [Scaling Issues](scaling.md)
- [Best Practices: Performance Optimization](../../../best-practices/performance-optimization.md)
- [SQL Performance Best Practices](../../../best-practices/sql-performance.md)
- [Synapse SQL Performance Documentation](https://docs.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-best-practices)

---

> **💡 Performance Tip:** Regularly update statistics, monitor query patterns, and proactively optimize before issues arise. Prevention is better than troubleshooting.
