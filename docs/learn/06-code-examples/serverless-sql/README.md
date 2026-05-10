# Serverless SQL Examples for Azure Synapse Analytics

[Home](../../../README.md) > [Code Examples](../../README.md) > Serverless SQL

This section provides examples and best practices for working with Serverless SQL pools in Azure Synapse Analytics. Serverless SQL pools allow you to query data directly from your data lake storage without the need for data movement or pre-loading.

## Available Examples

### Performance Optimization

- [Query Optimization](query-optimization.md) - Techniques to optimize serverless SQL queries
  - File format selection
  - Column pruning
  - Predicate pushdown
  - Partition elimination
  - External tables and statistics
  - Resource management

## Coming Soon

- __External Tables Management__ - Best practices for creating and maintaining external tables
- __Complex Query Patterns__ - Solutions for common analytical query scenarios
- __Security and Access Control__ - Row-level security and column-level access
- __Data Virtualization__ - Creating logical data warehouses using views and stored procedures

## Why Serverless SQL in Azure Synapse?

Serverless SQL pools in Azure Synapse Analytics offer several benefits:

1. __Pay-per-Query__: Only pay for the data processed during query execution
2. __No Infrastructure Management__: Eliminates the need to provision or scale resources
3. __Built-in Security__: Seamless integration with Azure AD and role-based access control
4. __Data Exploration__: Efficiently query and analyze data in various formats
5. __Integration with BI Tools__: Connect with PowerBI and other visualization tools

## Serverless SQL Architecture Patterns

Serverless SQL in Azure Synapse Analytics supports several architecture patterns:

![Azure Synapse SQL Architecture](https://learn.microsoft.com/en-us/azure/synapse-analytics/media/overview-architecture/sql-architecture.png)

1. __Data Lake Query Engine__: Direct querying of files in storage
2. __Data Virtualization Layer__: Creating views and stored procedures over external data
3. __Hybrid Architecture__: Combining serverless SQL with dedicated SQL pools
4. __Logical Data Warehouse__: Federated queries across multiple data sources

## Code Example: Basic Serverless SQL Query

```sql
-- Query CSV files directly
SELECT TOP 100 *
FROM OPENROWSET(
    BULK 'https://mydatalake.blob.core.windows.net/data/sales/*.csv',
    FORMAT = 'CSV',
    PARSER_VERSION = '2.0',
    HEADER_ROW = TRUE
) AS [sales]
WHERE [sales].[Region] = 'North America'
ORDER BY [sales].[OrderDate];

-- Create an external table
CREATE EXTERNAL TABLE Sales (
    OrderID INT,
    OrderDate DATE,
    Region VARCHAR(50),
    Product VARCHAR(100),
    Quantity INT,
    UnitPrice DECIMAL(10,2),
    TotalAmount DECIMAL(10,2)
)
WITH (
    LOCATION = 'sales/*.csv',
    DATA_SOURCE = MyDataLake,
    FILE_FORMAT = CsvFormat
);

-- Query the external table
SELECT
    Region,
    SUM(TotalAmount) AS RegionalSales
FROM Sales
GROUP BY Region
ORDER BY RegionalSales DESC;
```

## Related Resources

- [Serverless SQL Guide](../../serverless-sql-guide.md) - Comprehensive guide to Serverless SQL
- [Serverless SQL Architecture](../../architecture/serverless-sql/README.md) - Reference architecture
- [Performance Best Practices](../../best-practices/performance.md) - Performance optimization tips
- [Azure Synapse Analytics Documentation](https://learn.microsoft.com/en-us/azure/synapse-analytics/)
- [T-SQL Reference for Serverless SQL Pools](https://learn.microsoft.com/en-us/azure/synapse-analytics/sql/overview-features)
