# Azure Synapse Shared Metadata Architecture

[Home](../../../README.md) > [Architecture](../../README.md) > Shared Metadata > Shared Metadata Architecture

## Overview

The shared metadata architecture in Azure Synapse Analytics enables seamless integration between different compute engines while maintaining a single source of truth for your data. This architecture is crucial for maintaining consistency across your analytics environment and supports the modern data warehouse pattern by allowing different processing engines to collaborate efficiently.

## Key Components

### 1. Unified Metadata Layer

- Single metadata store
- Consistent schema across engines
- Centralized security
- Version control

### 2. Metadata Synchronization

- Automatic synchronization
- Schema evolution tracking
- Data lineage
- Impact analysis

### 3. Security Integration

- Unified access control
- Row-level security
- Column-level security
- Audit logging

## Architecture Diagram

![Azure Synapse SQL Architecture](https://learn.microsoft.com/en-us/azure/synapse-analytics/media/overview-architecture/sql-architecture.png)

## Best Practices

### Schema Management

- Use consistent naming conventions
- Implement proper schema evolution
- Regularly update statistics
- Use appropriate data types

### Security

- Implement proper RBAC
- Use row-level security
- Regularly audit changes
- Use secure connection strings

### Performance

- Use appropriate partitioning
- Implement proper indexing
- Use query hints when needed
- Regularly update statistics

## Code Examples

### Creating a Table with Shared Metadata

```sql
CREATE TABLE my_table
WITH (
    LOCATION = 'abfss://container@storageaccount.dfs.core.windows.net/path',
    DATA_SOURCE = my_datasource,
    FILE_FORMAT = parquet_format
)
AS SELECT * FROM source_table
```

### Schema Evolution

```sql
-- Add column
ALTER TABLE my_table ADD COLUMNS (new_column INT)

-- Rename column
ALTER TABLE my_table RENAME COLUMN old_name TO new_name

-- Drop column
ALTER TABLE my_table DROP COLUMN column_name
```

### Security Management

```sql
-- Grant permissions
GRANT SELECT ON my_table TO [user]

-- Row-level security
CREATE SECURITY POLICY my_policy
ADD FILTER PREDICATE my_function(user_id)
ON my_table
```

## Serverless Replicated Databases

Serverless replicated databases are a key feature of the shared metadata architecture in Azure Synapse Analytics. These databases are created automatically in the serverless SQL pool when corresponding databases are created in Spark pools.

### How Serverless Replicated Databases Work

1. When a database is created in a Spark pool, a corresponding database is automatically created in the serverless SQL pool.
2. Tables created in Spark using Parquet, Delta Lake, or CSV formats are exposed as external tables in the serverless SQL pool.
3. The synchronization happens asynchronously, typically with a delay of a few seconds.
4. Tables appear in the `dbo` schema of the corresponding database in the serverless SQL pool.
5. The maximum number of databases synchronized from Apache Spark pools is not limited, but serverless SQL pools can have up to 100 additional (non-synchronized) databases.

### Limitations of Serverless Replicated Databases

- __Read-Only Access__: Replicated databases in serverless SQL are read-only due to the asynchronous nature of metadata synchronization from Spark.
- __Format Restrictions__: Only tables using Parquet, Delta Lake (preview), or CSV formats are synchronized; other formats are not automatically available.
- __Asynchronous Updates__: Changes in Spark metadata are propagated to SQL with a short delay.
- __Spark Views__: Spark views require a Spark engine to process and cannot be accessed from SQL engines.

## Three-Part Naming Support and Limitations

Three-part naming (database.schema.table) is an important feature for cross-database queries but has specific limitations in both Spark and serverless SQL environments.

### Three-Part Naming in Serverless SQL

- Serverless SQL pools support three-part name references and cross-database queries, including the `USE` statement.
- Queries can reference serverless SQL databases or Lake databases (replicated from Spark) within the same workspace.
- Cross-workspace queries are __not__ supported.

### Three-Part Naming in Spark

- Spark has more restrictive three-part naming support compared to traditional SQL environments.
- In Spark, databases and schemas are treated as the same concept, which limits the traditional three-part naming convention.
- Using fully qualified names (database.schema.table) may not work as expected in certain Spark operations.

## Workarounds for Three-Part Naming Limitations

### Managed Serverless Databases with Spark Schema Synchronization

A recommended pattern to overcome three-part naming limitations is to create managed serverless databases that leverage Spark database schemas:

1. Create and design tables in Spark using appropriate formats (Parquet, Delta, CSV).
2. Let these tables automatically synchronize to serverless SQL.
3. Use schema isolation in Spark (which treats schemas the same as databases) for logical separation.
4. Access the synchronized tables in serverless SQL using database.dbo.table naming convention.

### Auto-Creation of External Tables in Serverless SQL

To maintain schema synchronization between Spark and serverless SQL:

1. Define your schema and tables in Spark pools using supported formats.
2. Allow automatic synchronization to create corresponding external tables in serverless SQL.
3. For formats not automatically synchronized, create manual external tables in serverless SQL pointing to the same underlying storage.

```sql
-- Example: Creating a table in Spark that will sync to serverless SQL
-- In Spark:
CREATE TABLE mydb.mytable (id INT, name STRING, data STRING) USING PARQUET

-- After sync, access in serverless SQL:
SELECT * FROM mydb.dbo.mytable
```

### Best Practices for Layered Data Architecture

- __Raw Data Layer__: Minimal processing, typically accessed directly through specific engines without relying on shared metadata.
- __Silver Layer (Curated)__: Apply three-part naming and schema synchronization here for clean, transformed data.
- __Gold Layer (Business)__: Fully leverage synchronized metadata for business-ready data models across engines.

This layered approach ensures that metadata synchronization complexity is applied where it adds the most value, rather than in raw data layers where direct access patterns may be more efficient.

## Next Steps

1. [Delta Lakehouse Architecture](../delta-lakehouse/README.md)
2. [Serverless SQL Architecture](../serverless-sql/README.md)
3. [Best Practices](../../best-practices/README.md)
4. [Code Examples](../../code-examples/README.md)
