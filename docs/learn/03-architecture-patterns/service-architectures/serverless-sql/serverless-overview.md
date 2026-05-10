# Azure Synapse Serverless SQL Architecture

[Home](../../../README.md) > [Architecture](../../README.md) > Serverless SQL > Overview

## Overview

Azure Synapse Serverless SQL is a serverless query engine that enables you to query data in your data lake using SQL without managing any infrastructure. It works seamlessly with Delta Lakehouse and provides several advantages over traditional SQL databases.

## Key Features

### 1. Serverless Architecture

- No infrastructure management
- Pay-per-query pricing
- Automatic scaling
- High availability

### 2. Data Access

- Query data directly from ADLS Gen2
- Support for multiple file formats:
  - Parquet
  - Delta
  - CSV
  - JSON
  - Avro

### 3. Performance Optimizations

- Pushdown predicates
- Columnar processing
- Caching
- Query optimization

## Architecture Components

### 1. External Tables

- Define schema over existing data
- Support for partitioned data
- Statistics collection
- Row-level security

### 2. Views

- Materialized views
- Regular views
- Security views

### 3. Security

- Role-based access control
- Row-level security
- Column-level security
- Secure data access

## Shared Metadata Architecture

![Azure Synapse SQL Architecture](https://learn.microsoft.com/en-us/azure/synapse-analytics/media/overview-architecture/sql-architecture.png)

## Best Practices

### Schema Design

- Use appropriate data types
- Implement proper statistics
- Use meaningful column names
- Plan for schema evolution

### Performance

- Use appropriate partitioning
- Implement proper indexing
- Use query hints when needed
- Regularly update statistics

### Security

- Implement proper RBAC
- Use row-level security
- Regularly audit access
- Use secure connection strings

## Code Examples

### Creating External Tables

```sql
CREATE EXTERNAL TABLE my_table
WITH (
    LOCATION = 'abfss://container@storageaccount.dfs.core.windows.net/path',
    DATA_SOURCE = my_datasource,
    FILE_FORMAT = parquet_format
)
AS SELECT * FROM source_table
```

### Creating Views

```sql
CREATE VIEW secure_view
WITH (NOEXPAND)
AS
SELECT * FROM my_table
WHERE sensitive_column = 'public'
```

### Query Optimization

```sql
SELECT /*+ PUSHDOWN */
    customer_id,
    COUNT(*) as order_count
FROM orders
WHERE order_date >= '2024-01-01'
GROUP BY customer_id
```

## Next Steps

1. [Shared Metadata Architecture](../shared-metadata/README.md)
2. [Best Practices](../../best-practices/README.md)
3. [Code Examples](../../code-examples/README.md)
4. [Security Guide](../../reference/security.md)
