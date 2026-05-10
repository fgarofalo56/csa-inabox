# Azure Cosmos DB Reference

[Home](../../../README.md) > [Reference](../README.md) > Cosmos DB

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Documentation](https://img.shields.io/badge/Documentation-Complete-blue)

> Reference documentation for Azure Cosmos DB configuration, global distribution, consistency models, and integration with cloud-scale analytics workloads.

---

## Available References

### Global Distribution

- **[Global Distribution](global-distribution.md)** - Comprehensive guide to Azure Cosmos DB global distribution, multi-region writes, consistency levels, and disaster recovery strategies.

---

## Overview

Azure Cosmos DB is a globally distributed, multi-model database service designed for mission-critical applications requiring:

- Global distribution with multi-region writes
- Single-digit millisecond latency
- Five consistency levels
- Comprehensive SLAs for availability, throughput, latency, and consistency
- Support for multiple data models (SQL, MongoDB, Cassandra, Gremlin, Table)

---

## Integration with Analytics Workloads

### Azure Synapse Link for Cosmos DB

Azure Synapse Link enables near real-time analytics over operational data in Cosmos DB without ETL.

#### Key Features

| Feature | Description |
|---------|-------------|
| **No ETL** | Automatic sync to analytical store |
| **Performance Isolation** | Analytics don't impact transactional workload |
| **Real-time Insights** | Query operational data with low latency |
| **Cost Optimization** | Columnar storage for analytics queries |

#### Configuration Example

```bash
# Enable Synapse Link on Cosmos DB account
az cosmosdb update \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics-prod \
  --enable-analytical-storage true

# Create container with analytical store
az cosmosdb sql container create \
  --account-name cosmos-analytics-prod \
  --database-name analytics-db \
  --name events \
  --partition-key-path "/tenantId" \
  --analytical-storage-ttl -1
```

---

## Common Use Cases

### Analytics Workloads

- **Real-time Analytics** - Query operational data without impacting production
- **IoT Data Processing** - Ingest and analyze sensor data globally
- **Event Sourcing** - Store and query event streams
- **Time Series Data** - Store and analyze time-stamped data
- **Reference Data** - Globally distributed lookup tables

### Integration Scenarios

- **Synapse Analytics** - Query Cosmos DB data using Synapse Link
- **Azure Data Factory** - ETL from/to Cosmos DB
- **Azure Functions** - Trigger on Cosmos DB changes
- **Azure Stream Analytics** - Output streaming data to Cosmos DB

---

## Quick Links

- [Azure Cosmos DB Documentation](https://docs.microsoft.com/azure/cosmos-db/)
- [Synapse Link for Cosmos DB](https://docs.microsoft.com/azure/cosmos-db/synapse-link)
- [Consistency Levels](https://docs.microsoft.com/azure/cosmos-db/consistency-levels)
- [Global Distribution](global-distribution.md)

---

## Related Resources

- [Azure Regions Reference](../azure-regions.md)
- [Best Practices - Performance Optimization](../../best-practices/performance-optimization.md)
- [Integration Guides](../../code-examples/integration/README.md)

---

> **Note**: This reference section focuses on Cosmos DB features relevant to cloud-scale analytics workloads. For complete Cosmos DB documentation, refer to the official Microsoft documentation.
