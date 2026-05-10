# Azure Synapse Analytics Serverless SQL: Detailed Architecture

[Home](../../../README.md) > [Architecture](../../README.md) > Serverless SQL > Detailed Architecture

## Overview

Azure Synapse Serverless SQL Pool provides on-demand, auto-scaling SQL query capabilities without the need to provision or manage infrastructure. This document provides a detailed technical overview of the serverless SQL architecture in Azure Synapse Analytics, focusing on querying data lakes, integrating with Delta Lake format, and optimizing for performance and cost.

## Core Architecture

### Distributed Query Processing

Serverless SQL in Azure Synapse Analytics utilizes a distributed query processing architecture:

1. __Query Parsing and Planning__
   - SQL query parsing and syntax validation
   - Query plan optimization based on statistics and metadata
   - Distributed execution plan generation

2. __Compute Layer__
   - Dynamically allocated compute resources based on query complexity
   - Automatic scaling during query execution
   - Pay-per-query billing model (TB processed)

3. __Data Access Layer__
   - Parallel data access to storage systems
   - Native support for multiple file formats
   - Data virtualization capabilities

### Logical Architecture

```text
┌───────────────────────────────────────────────────┐
│                 Client Applications               │
│  (SSMS, Azure Data Studio, Power BI, Custom Apps) │
└───────────────────┬───────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────────┐
│               Synapse SQL Endpoint                │
│           (TDS Protocol over TCP/IP)              │
└───────────────────┬───────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────────────────┐
│              Query Processing Engine              │
├───────────────┬───────────────┬───────────────────┤
│ Query Parser  │ Query Planner │ Query Optimizer   │
└───────────────┴───────────┬───┴───────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────┐
│            Distributed Query Execution            │
├───────────────┬───────────────┬───────────────────┤
│  Data Access  │  Processing   │  Result Assembly  │
└───────────────┴───────────────┴───────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────┐
│                  Storage Layer                    │
│       (ADLS Gen2, Azure Blob, Delta Lake)         │
└───────────────────────────────────────────────────┘
```

## Key Components

### Endpoint Management

Serverless SQL Pool provides a dedicated SQL endpoint with:

- Standard TDS (Tabular Data Stream) protocol support
- Compatibility with standard SQL clients and tools
- Always-on connectivity for applications
- Connection pooling and management

### Resource Management

__Dynamic Resource Allocation__

- Resources automatically scale based on query complexity
- Parallel processing adapts to data volume and query patterns
- CPU and memory allocation optimized for each query phase
- Isolation between multiple concurrent queries

__Billing Model__

- Pay only for data processed during query execution
- Billed per TB of data scanned
- No charges when idle
- Predictable cost model for data exploration and analytics

### Query Processing

__Query Compilation__

- SQL query parsing and validation
- Syntax compatibility with T-SQL
- Query plan optimization for distributed execution
- Statistics-based cardinality estimation

__Execution Engine__

- Massively parallel processing (MPP) architecture
- Distributed query execution across multiple nodes
- Dynamic node allocation based on workload
- Fault-tolerant execution with node failover

## Data Access Capabilities

### File Format Support

Serverless SQL Pool provides native support for multiple file formats:

| Format | Key Features | Best For |
|--------|-------------|----------|
| __Parquet__ | Columnar storage, compression, predicate pushdown | Analytics workloads, high-performance queries |
| __Delta__ | ACID transactions, time travel, schema evolution | Data lakes with transactional requirements |
| __CSV__ | Human-readable, widely supported, variable delimiters | Data exchange, simple datasets |
| __JSON__ | Semi-structured data, nested objects, arrays | Application logs, API data, flexible schemas |

### External Tables

Serverless SQL enables creating metadata-driven external tables that provide:

- Schema-on-read capabilities with schema enforcement
- Statistics collection for better query optimization
- Persistent metadata for consistent data access
- Security and access control integration

```sql
-- Example of creating an external table over Delta format
CREATE EXTERNAL TABLE ExternalDeltaTable
(
    CustomerID INT,
    Name NVARCHAR(100),
    OrderDate DATE,
    Amount DECIMAL(18,2)
)
WITH
(
    LOCATION = 'orders/delta/',
    DATA_SOURCE = ExternalDataSource,
    FILE_FORMAT = DeltaFormat
)
```

### Query Syntax Extensions

Serverless SQL Pool extends T-SQL with specialized syntax for external data access:

__OPENROWSET__

- Ad-hoc queries against file storage
- Schema inference capabilities
- Format-specific options for optimal access

```sql
-- Example of querying Delta format with OPENROWSET
SELECT TOP 100 *
FROM OPENROWSET(
    BULK 'https://account.dfs.core.windows.net/container/path/to/delta/',
    FORMAT = 'DELTA'
) AS [result]
```

__Specialized Functions__

- `FILEPATH()` - Access file path information
- `FILENAME()` - Extract filename from path
- `FORMAT_TYPE()` - Determine file format details

## Integration with Delta Lake

### Reading Delta Tables

Serverless SQL Pool provides native support for reading Delta Lake tables:

- Reads Delta transaction log to find latest snapshot
- Honors partition pruning for efficient data access
- Supports time travel queries using timestamp or version

```sql
-- Query latest version of Delta table
SELECT * FROM OPENROWSET(
    BULK 'https://account.dfs.core.windows.net/container/path/to/delta/',
    FORMAT = 'DELTA'
) AS [data]

-- Query specific version of Delta table
SELECT * FROM OPENROWSET(
    BULK 'https://account.dfs.core.windows.net/container/path/to/delta/',
    FORMAT = 'DELTA',
    DELTA_VERSION = 5
) AS [data]
```

### Metadata Integration

__Schema Discovery__

- Automatic schema inference from Delta metadata
- Data type mapping between Spark and SQL types
- Support for nested structures and arrays

__Statistics Utilization__

- Leverages Delta statistics for query optimization
- Data skipping based on min/max values
- Partition elimination for efficient data access

## Security and Access Control

### Authentication Methods

Serverless SQL Pool supports multiple authentication methods:

- Azure Active Directory integration
- SQL authentication for legacy applications
- Managed identities for service-to-service authentication
- Azure AD Pass-through for end-user identity flow

### Authorization and Access Control

__Resource-level Security__

- Role-based access control (RBAC) on Synapse workspace
- SQL role-based security for database objects
- Managed private endpoints for network isolation

__Data-level Security__

- Row-level security (RLS) policies
- Column-level security and data masking
- Azure storage access control with SAS or AAD

```sql
-- Example of row-level security implementation
CREATE SECURITY POLICY SalesDataFilter
ADD FILTER PREDICATE dbo.fn_securitypredicate(RegionID) ON dbo.SalesData
WITH (STATE = ON);
```

## Performance Optimization

### Query Performance Techniques

__Data Layout Optimization__

- Partitioning strategies for efficient filtering
- File size optimization (recommended: 100MB-1GB)
- Data organization for common access patterns

__Predicate Pushdown__

- Filter pushdown to storage layer
- Column pruning for reading only required fields
- Partition elimination for scanned data reduction

__Statistics Management__

- Creating statistics on key columns
- AUTO_CREATE_STATISTICS option
- Regular statistics updates for changing data

```sql
-- Create statistics for better query plans
CREATE STATISTICS Stats_OrderDate ON ExternalTable(OrderDate);
```

### Caching Mechanisms

__Result Set Cache__

- Automatic caching of query results
- Cache invalidation on data changes
- Configurable TTL for cached results

__Metadata Caching__

- Storage of file listings and statistics
- Schema caching for faster queries
- Partition metadata for efficient access

## Scaling and Limits

### Concurrency Management

Serverless SQL Pool provides built-in concurrency control:

- Dynamic resource management for concurrent queries
- Workload classification and importance
- Query queuing during high concurrency periods
- Configurable concurrency limits by resource class

### Resource Limits

Key resource limitations to consider:

| Resource | Limit |
|----------|-------|
| Maximum query memory | 1 GB per DW100 |
| Maximum query execution time | 60 minutes |
| Maximum result set size | 10 GB |
| Maximum columns per table | 1,024 |
| Maximum SQL statement size | 1 MB |
| Maximum concurrent queries | Varies by resource class |

## Integration Scenarios

### Cross-Engine Queries

Serverless SQL Pool can participate in cross-engine queries:

- Query Spark tables from SQL
- Join data between SQL and Spark
- Create views combining multiple sources
- Cross-service parameterized queries

### Synapse Link Integration

Native integration with Synapse Link for:

- Azure Cosmos DB analytical store
- Azure SQL Database change feed
- Near real-time analytics on operational data
- Hybrid HTAP (Hybrid Transactional/Analytical Processing) workloads

### PowerBI Integration

Optimized connection patterns for PowerBI:

- DirectQuery for real-time data access
- Import mode for pre-aggregated datasets
- Composite models combining multiple sources
- Row-level security pass-through

## Monitoring and Management

### Query Monitoring

Comprehensive monitoring capabilities:

- Dynamic management views (DMVs) for query insights
- Query execution plans and statistics
- Resource utilization metrics
- Query performance troubleshooting

```sql
-- Example of monitoring active queries
SELECT
    request_id,
    session_id,
    status,
    submit_time,
    total_elapsed_time,
    command
FROM
    sys.dm_pdw_exec_requests
WHERE
    status NOT IN ('Completed', 'Failed', 'Cancelled')
ORDER BY
    submit_time DESC;
```

### Cost Management

Tools and practices for cost optimization:

- Query data volume estimation
- Cost tracking by query and user
- Alerting on excessive data processing
- Query optimization for reduced data scanning

## Best Practices

### Query Optimization

- Filter data as early as possible in the query
- Limit columns selected to only those needed
- Use appropriate data types for joins and comparisons
- Optimize file formats and compression settings
- Use partitioning aligned with common query patterns

### Data Organization

- Implement logical partitioning by date/business unit
- Target optimal file sizes (100MB-1GB)
- Use Delta Lake for frequently updated data
- Implement a medallion architecture (bronze/silver/gold)
- Consider data lifecycle management for cost optimization

## Reference Architecture Patterns

### Data Lake Query Layer

Using Serverless SQL as a query layer over a data lake:

```text
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Power BI    ├───►│ Serverless  ├───►│ Data Lake   │
│ Excel       │    │ SQL Pool    │    │ (ADLS Gen2) │
│ SSMS        │    │             │    │             │
└─────────────┘    └─────────────┘    └─────────────┘
```

### Hybrid Query Architecture

Combining dedicated and serverless pools for different workloads:

```text
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Mission-    ├───►│ Dedicated   ├───►│ Curated     │
│ Critical    │    │ SQL Pool    │    │ Data Mart   │
│ Reports     │    │             │    │             │
└─────────────┘    └─────────────┘    └─────────────┘
      │                                      ▲
      │                                      │
      │            ┌─────────────┐    ┌─────────────┐
      └───────────►│ Serverless  ├───►│ Data Lake   │
                   │ SQL Pool    │    │ (Raw Data)  │
                   │             │    │             │
                   └─────────────┘    └─────────────┘
```

### Data Virtualization Hub

Using Serverless SQL as a data virtualization layer:

```text
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ BI Tools    │    │ Serverless  │    │ Azure SQL   │
│ Custom Apps ├───►│ SQL Pool    ├───►│ Cosmos DB   │
│ Reporting   │    │ (Polybase)  │    │ Data Lake   │
└─────────────┘    └─────────────┘    └─────────────┘
```

## Reference Implementation

For detailed code samples and implementation patterns for Serverless SQL in Azure Synapse Analytics, refer to the [code examples section](../../code-examples/README.md) of this documentation.
