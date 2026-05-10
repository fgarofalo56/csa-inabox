# Dedicated SQL Pool Best Practices

> **[Home](../../../README.md)** | **[Best Practices](../../README.md)** | **[Synapse](README.md)** | **Dedicated SQL**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Dedicated%20SQL-purple?style=flat-square)

Best practices for Azure Synapse Dedicated SQL Pools.

---

## Table Design

### Distribution Strategy

| Distribution | Use Case | Example |
|--------------|----------|---------|
| Hash | Large fact tables | Sales, Transactions |
| Replicate | Small dimension tables (< 2GB) | Products, Regions |
| Round Robin | Staging/temporary tables | STG_Sales |

```sql
-- Hash distributed fact table
CREATE TABLE FactSales (
    SalesKey BIGINT NOT NULL,
    CustomerKey INT NOT NULL,
    ProductKey INT NOT NULL,
    SalesAmount DECIMAL(18,2),
    SalesDate DATE
)
WITH (
    DISTRIBUTION = HASH(CustomerKey),
    CLUSTERED COLUMNSTORE INDEX
);

-- Replicated dimension
CREATE TABLE DimProduct (
    ProductKey INT NOT NULL,
    ProductName NVARCHAR(100),
    Category NVARCHAR(50)
)
WITH (
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
);
```

### Indexing Strategy

```sql
-- Clustered columnstore (default, best for analytics)
CREATE CLUSTERED COLUMNSTORE INDEX CCI_FactSales ON FactSales;

-- Ordered clustered columnstore
CREATE CLUSTERED COLUMNSTORE INDEX CCI_FactSales
ON FactSales ORDER (SalesDate);

-- Heap for staging
CREATE TABLE STG_Sales (...)
WITH (HEAP);
```

---

## Query Optimization

### Statistics

```sql
-- Create statistics on filter columns
CREATE STATISTICS Stats_CustomerKey ON FactSales(CustomerKey);
CREATE STATISTICS Stats_SalesDate ON FactSales(SalesDate);

-- Update statistics
UPDATE STATISTICS FactSales;

-- Auto-create statistics
ALTER DATABASE database_name
SET AUTO_CREATE_STATISTICS ON;
```

### Query Hints

```sql
-- Force hash join
SELECT /*+ HASH JOIN */ *
FROM FactSales f
JOIN DimCustomer c ON f.CustomerKey = c.CustomerKey;

-- Force replicated table broadcast
SELECT /*+ REPLICATE(DimProduct) */ *
FROM FactSales f
JOIN DimProduct p ON f.ProductKey = p.ProductKey;
```

---

## Workload Management

### Resource Classes

```sql
-- Assign user to resource class
EXEC sp_addrolemember 'largerc', 'analyst_user';

-- Check current allocations
SELECT * FROM sys.dm_pdw_resource_waits;
```

### Workload Groups

```sql
-- Create workload group
CREATE WORKLOAD GROUP wg_analytics
WITH (
    MIN_PERCENTAGE_RESOURCE = 20,
    CAP_PERCENTAGE_RESOURCE = 50,
    REQUEST_MIN_RESOURCE_GRANT_PERCENT = 5,
    REQUEST_MAX_RESOURCE_GRANT_PERCENT = 10
);

-- Create classifier
CREATE WORKLOAD CLASSIFIER wc_analytics
WITH (
    WORKLOAD_GROUP = 'wg_analytics',
    MEMBERNAME = 'analytics_users',
    IMPORTANCE = ABOVE_NORMAL
);
```

---

## Data Loading

### COPY Command (Recommended)

```sql
-- Fast bulk load
COPY INTO FactSales
FROM 'https://storage.blob.core.windows.net/data/sales/*.parquet'
WITH (
    FILE_TYPE = 'PARQUET',
    CREDENTIAL = (IDENTITY = 'Managed Identity')
);
```

### PolyBase

```sql
-- External table for querying external data
CREATE EXTERNAL TABLE ext_Sales (
    SalesKey BIGINT,
    CustomerKey INT,
    SalesAmount DECIMAL(18,2)
)
WITH (
    LOCATION = '/sales/',
    DATA_SOURCE = AzureDataLake,
    FILE_FORMAT = ParquetFormat
);

-- Load via CTAS
CREATE TABLE FactSales
WITH (DISTRIBUTION = HASH(CustomerKey))
AS SELECT * FROM ext_Sales;
```

---

## Maintenance

### Index Maintenance

```sql
-- Rebuild columnstore index
ALTER INDEX CCI_FactSales ON FactSales REBUILD;

-- Check index health
SELECT
    OBJECT_NAME(object_id) AS table_name,
    index_id,
    partition_number,
    row_group_id,
    state_description,
    total_rows,
    deleted_rows
FROM sys.dm_pdw_nodes_column_store_row_groups
WHERE deleted_rows > total_rows * 0.1;
```

### Statistics Maintenance

```sql
-- Update all statistics
EXEC sp_updatestats;

-- Check statistics age
SELECT
    OBJECT_NAME(object_id) AS table_name,
    name AS stats_name,
    STATS_DATE(object_id, stats_id) AS last_updated
FROM sys.stats
WHERE STATS_DATE(object_id, stats_id) < DATEADD(day, -7, GETDATE());
```

---

## Performance Checklist

| Check | Target | Action |
|-------|--------|--------|
| Distribution skew | < 10% variance | Redistribute |
| Statistics age | < 7 days | Update statistics |
| Query duration | Baseline ± 20% | Optimize query |
| Concurrency | < 128 queries | Use workload management |

---

## Related Documentation

- [Dedicated SQL Monitoring](../../../09-monitoring/service-monitoring/synapse/dedicated-monitoring.md)
- [SQL Performance Guide](../../../best-practices/sql-performance/README.md)
- [Synapse Overview](../../../02-services/analytics-compute/azure-synapse/README.md)

---

*Last Updated: January 2025*
