---
title: "SQL Performance Best Practices"
description: "> **[Home](../../README.md)** | **[Best Practices](../index.md)** | **SQL Performance**"
tags:
  - best-practices
  - sql-performance
---
# SQL Performance Best Practices

> **[Home](../../README.md)** | **[Best Practices](../index.md)** | **SQL Performance**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)

Best practices for SQL performance in Cloud Scale Analytics.

---

## Dedicated SQL Pool Optimization

### Distribution Strategy

| Strategy | Use Case | Example |
|----------|----------|---------|
| HASH | Large fact tables, join columns | `DISTRIBUTION = HASH(customer_id)` |
| REPLICATED | Small dimension tables (< 2GB) | `DISTRIBUTION = REPLICATE` |
| ROUND_ROBIN | Staging tables | `DISTRIBUTION = ROUND_ROBIN` |

```sql
-- Optimal distribution for fact table
CREATE TABLE fact_sales
WITH (
    DISTRIBUTION = HASH(customer_id),
    CLUSTERED COLUMNSTORE INDEX,
    PARTITION (order_date RANGE RIGHT FOR VALUES (
        '2023-01-01', '2024-01-01', '2025-01-01'
    ))
) AS
SELECT * FROM staging_sales;
```

### Index Strategy

```sql
-- Columnstore for analytics
CREATE CLUSTERED COLUMNSTORE INDEX cci_sales ON fact_sales;

-- Nonclustered for specific queries
CREATE NONCLUSTERED INDEX ix_sales_date
ON fact_sales (order_date)
INCLUDE (customer_id, amount);
```

### Statistics Management

```sql
-- Create statistics
CREATE STATISTICS stat_customer_id ON fact_sales (customer_id);
CREATE STATISTICS stat_order_date ON fact_sales (order_date);

-- Update all statistics
EXEC sp_updatestats;

-- Check statistics freshness
SELECT
    OBJECT_NAME(s.object_id) AS table_name,
    s.name AS stat_name,
    STATS_DATE(s.object_id, s.stats_id) AS last_updated,
    sp.rows,
    sp.modification_counter
FROM sys.stats s
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) sp
WHERE sp.modification_counter > 1000;
```

---

## Query Optimization

### Use EXPLAIN

```sql
-- Analyze query plan
EXPLAIN
SELECT
    c.CustomerName,
    SUM(s.Amount) AS TotalSales
FROM fact_sales s
JOIN dim_customer c ON s.customer_id = c.customer_id
WHERE s.order_date >= '2024-01-01'
GROUP BY c.CustomerName;
```

### Avoid Anti-Patterns

```sql
-- Bad: Functions on columns prevent index usage
WHERE YEAR(order_date) = 2024

-- Good: Use range predicate
WHERE order_date >= '2024-01-01' AND order_date < '2025-01-01'

-- Bad: SELECT *
SELECT * FROM fact_sales

-- Good: Select only needed columns
SELECT customer_id, order_date, amount FROM fact_sales
```

### Result Set Caching

```sql
-- Enable result set caching
ALTER DATABASE analytics SET RESULT_SET_CACHING ON;

-- Check cache hit rate
SELECT
    request_id,
    result_cache_hit
FROM sys.dm_pdw_exec_requests
WHERE result_cache_hit = 1;
```

---

## Monitoring

```sql
-- Long-running queries
SELECT
    request_id,
    status,
    command,
    total_elapsed_time / 60000.0 AS duration_minutes
FROM sys.dm_pdw_exec_requests
WHERE total_elapsed_time > 300000 -- > 5 minutes
ORDER BY total_elapsed_time DESC;

-- Resource utilization
SELECT
    request_id,
    resource_class,
    importance,
    group_name
FROM sys.dm_pdw_exec_requests r
JOIN sys.dm_pdw_exec_sessions s ON r.session_id = s.session_id
WHERE r.status = 'Running';
```

---

## Related Documentation

- [Dedicated SQL Troubleshooting](../../troubleshooting/dedicated-sql-troubleshooting.md)
- [Performance Optimization](../performance-optimization/README.md)

---

*Last Updated: January 2025*
