# Azure Synapse Analytics Shared Metadata

[🏠 Home](../../../README.md) > [🏗️ Architecture](../../README.md) > 📄 Shared Metadata

Azure Synapse Analytics provides a powerful shared metadata architecture that enables seamless integration between different compute engines, including Apache Spark pools and serverless SQL pools. This section provides in-depth documentation on the shared metadata capabilities, architecture, and best practices.

## Documentation

- [Shared Metadata Architecture Overview](./shared-metadata.md) - Comprehensive guide to the shared metadata architecture, including key components, security model, and best practices.
- [Visual Guides and Diagrams](./shared-metadata-visuals.md) - Visual representations of serverless replicated databases, three-part naming concepts, and layered data architecture.
- [Code Examples](./shared-metadata-examples.md) - Detailed code samples for implementing shared metadata patterns.

## Key Features

- Single metadata store for multiple compute engines
- Consistent schema definition across Spark and SQL
- Unified data governance and lineage
- Streamlined cross-engine workloads
- Simplified DevOps management

## Architecture Overview

![Azure Synapse SQL Architecture](https://learn.microsoft.com/en-us/azure/synapse-analytics/media/overview-architecture/sql-architecture.png)

The shared metadata architecture in Azure Synapse Analytics provides a unified metadata experience that bridges the gap between different compute engines, allowing for seamless data access and governance.

## Implementation Patterns

### Cross-Engine Table Access

Access tables defined in Spark from SQL:

```sql
-- Access a table created in Spark from SQL
SELECT TOP 10 * FROM sales_gold.customer_summary;
```

Access tables defined in SQL from Spark:

```python
# Access a table created in SQL from Spark
customer_df = spark.read.synapsesql("sales_gold.customer_summary")
```

### Metadata Propagation

- __Schema Changes__: Schema changes in one engine are automatically visible in others
- __Statistics__: Query optimization statistics are shared for better performance
- __Access Control__: Security permissions are consistently applied across engines
- __Lineage__: Data lineage is tracked across different processing engines

## Best Practices

1. __Use Consistent Naming Conventions__: Adopt a clear naming standard across all engines
2. __Implement Row-Level Security__: Apply consistent security at the row level where needed
3. __Establish Data Ownership__: Define clear ownership of metadata objects
4. __Document Metadata__: Maintain comprehensive documentation of your metadata structure
5. __Regular Validation__: Periodically validate metadata consistency across engines

## Related Resources

- [Best Practices for Metadata Management](../../best-practices/data-governance.md)
- [Integration Guide](../../code-examples/integration-guide.md)
- [Reference Documentation](../../reference/README.md)
