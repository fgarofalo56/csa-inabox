# Serverless SQL Best Practices

> **[Home](../../README.md)** | **[Best Practices](../index.md)** | **Serverless SQL**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)

Best practices for Azure Synapse Serverless SQL pools.

---

## Overview

Serverless SQL is ideal for:

- Ad-hoc data exploration
- Power BI DirectQuery
- Data lake querying
- ETL transformations

For detailed guidance, see: **[Full Serverless SQL Guide](../../docs/05-best-practices/serverless-sql-best-practices/README.md)**

---

## Query Optimization

### Use Proper File Formats

| Format | Query Performance | Compression | Schema Evolution |
|--------|-------------------|-------------|------------------|
| Parquet | Excellent | High | Good |
| Delta | Excellent | High | Excellent |
| CSV | Poor | Low | None |
| JSON | Poor | Low | Flexible |

```sql
-- Optimal: Query Parquet with schema
SELECT *
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.windows.net/data/*.parquet',
    FORMAT = 'PARQUET'
) WITH (
    customer_id INT,
    order_date DATE,
    amount DECIMAL(18,2)
) AS orders
WHERE order_date >= '2024-01-01';
```

### Partition Pruning

```sql
-- Enable partition pruning with filepath
SELECT
    filepath(1) AS year,
    filepath(2) AS month,
    COUNT(*) AS record_count
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.windows.net/data/year=*/month=*/*.parquet',
    FORMAT = 'PARQUET'
) AS sales
WHERE filepath(1) = '2024' AND filepath(2) = '01'
GROUP BY filepath(1), filepath(2);
```

### Create Views

```sql
-- Create optimized view
CREATE VIEW gold.vw_sales AS
SELECT
    customer_id,
    order_date,
    product_id,
    amount
FROM OPENROWSET(
    BULK 'https://storage.dfs.core.windows.net/gold/sales/**/*.parquet',
    FORMAT = 'PARQUET'
) WITH (
    customer_id INT,
    order_date DATE,
    product_id INT,
    amount DECIMAL(18,2)
) AS sales;
```

---

## Cost Optimization

### Data Processed Estimation

```sql
-- Check estimated data processed
SELECT
    execution_type,
    total_worker_time / 1000000.0 AS cpu_seconds,
    total_physical_reads * 8 / 1024.0 AS data_read_mb
FROM sys.dm_exec_query_stats
ORDER BY total_physical_reads DESC;
```

### Best Practices

1. **Use Parquet/Delta** - 10-100x less data scanned
2. **Partition data** - Enable partition elimination
3. **Project only needed columns** - Columnar storage benefits
4. **Filter early** - Reduce data processed

---

## Related Documentation

- [Serverless SQL Architecture](../../docs/architecture/serverless-sql/README.md)
- [SQL Performance](../sql-performance/README.md)

---

*Last Updated: January 2025*
