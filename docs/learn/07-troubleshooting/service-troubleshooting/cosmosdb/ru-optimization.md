# Azure Cosmos DB RU Optimization

![Status](https://img.shields.io/badge/Status-Active-brightgreen) ![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow)

Comprehensive guide for optimizing Request Unit (RU) consumption in Azure Cosmos DB to reduce costs and improve performance.

## Table of Contents

- [Overview](#overview)
- [RU Consumption Patterns](#ru-consumption-patterns)
- [Optimization Strategies](#optimization-strategies)
- [Monitoring and Alerts](#monitoring-and-alerts)
- [Cost Optimization](#cost-optimization)
- [Related Resources](#related-resources)

---

## Overview

Request Units (RUs) are the currency of throughput in Cosmos DB. Optimizing RU consumption directly impacts both performance and cost.

---

## RU Consumption Patterns

### Common High-RU Operations

| Operation | Typical RU Cost | Optimization |
|:----------|:----------------|:-------------|
| **Full scan query** | 100-1000+ RUs | Add indexes, use filters |
| **Cross-partition query** | 50-500 RUs | Include partition key in WHERE |
| **Large document write** | 10-100 RUs | Reduce document size |
| **Bulk operations** | Variable | Use bulk executor |
| **ORDER BY without index** | 100+ RUs | Create composite index |

### Monitor RU Consumption

```python
from azure.cosmos import CosmosClient
from azure.monitor.query import LogsQueryClient
from datetime import timedelta

def monitor_ru_consumption(workspace_id, resource_id):
    """Monitor RU consumption patterns."""

    query = f"""
    AzureDiagnostics
    | where ResourceId == "{resource_id}"
    | where TimeGenerated > ago(24h)
    | summarize
        TotalRU = sum(todouble(requestCharge_s)),
        AvgRU = avg(todouble(requestCharge_s)),
        MaxRU = max(todouble(requestCharge_s)),
        Count = count()
        by operationType_s, bin(TimeGenerated, 1h)
    | order by TotalRU desc
    """

    # Execute and analyze results
    # Implementation details...

    return query
```

---

## Optimization Strategies

### 1. Optimize Document Size

```python
def optimize_document_size(document):
    """Reduce document size to lower RU consumption."""

    optimized = {}

    # Use shorter property names
    property_mapping = {
        'customerIdentifier': 'cId',
        'orderTimestamp': 'ts',
        'totalAmount': 'amt',
        'shippingAddress': 'addr'
    }

    for original, short in property_mapping.items():
        if original in document:
            optimized[short] = document[original]

    # Remove null/empty values
    optimized = {k: v for k, v in optimized.items() if v is not None and v != ''}

    # Store large properties separately (blob storage)
    if 'largeDescription' in document:
        # Upload to blob, store reference
        optimized['descRef'] = upload_to_blob(document['largeDescription'])

    return optimized
```

### 2. Use Bulk Operations

```python
from azure.cosmos import CosmosClient, PartitionKey

def bulk_upsert_items(container, items, batch_size=100):
    """Efficiently upsert items in bulk."""

    from concurrent.futures import ThreadPoolExecutor, as_completed

    def upsert_batch(batch):
        """Upsert a batch of items."""
        operations = []
        for item in batch:
            operations.append(('upsert', (item,), {}))

        # Execute batch
        results = container.execute_item_batch(operations, item['partitionKey'])
        return len(results)

    # Split into batches
    batches = [items[i:i + batch_size] for i in range(0, len(items), batch_size)]

    total_upserted = 0
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(upsert_batch, batch) for batch in batches]

        for future in as_completed(futures):
            total_upserted += future.result()

    print(f"✅ Bulk upserted {total_upserted} items")
    return total_upserted
```

### 3. Implement Caching

```python
from functools import lru_cache
from datetime import datetime, timedelta

class CosmosCache:
    """Cache frequently accessed documents."""

    def __init__(self, container):
        self.container = container
        self.cache = {}
        self.cache_ttl = {}

    def get_item_cached(self, item_id, partition_key, ttl_minutes=30):
        """Get item with caching."""

        cache_key = f"{partition_key}/{item_id}"

        # Check cache
        if cache_key in self.cache:
            if datetime.now() < self.cache_ttl.get(cache_key, datetime.min):
                print(f"✅ Cache hit for {cache_key}")
                return self.cache[cache_key]

        # Cache miss - fetch from Cosmos
        print(f"⚠️ Cache miss for {cache_key} - fetching from Cosmos DB")
        item = self.container.read_item(
            item=item_id,
            partition_key=partition_key
        )

        # Update cache
        self.cache[cache_key] = item
        self.cache_ttl[cache_key] = datetime.now() + timedelta(minutes=ttl_minutes)

        return item
```

---

## Monitoring and Alerts

### Set Up RU Alerts

```bash
# Alert for high RU consumption
az monitor metrics alert create \
    --name "CosmosDB-HighRU" \
    --resource-group <rg-name> \
    --scopes <cosmosdb-account-id> \
    --condition "total NormalizedRUConsumption > 80" \
    --window-size 5m \
    --evaluation-frequency 1m \
    --action <action-group-id>

# Alert for throttling
az monitor metrics alert create \
    --name "CosmosDB-Throttling" \
    --resource-group <rg-name> \
    --scopes <cosmosdb-account-id> \
    --condition "count TotalRequests where ResultType = '429' > 10" \
    --window-size 5m \
    --action <action-group-id>
```

---

## Cost Optimization

### Autoscale vs Provisioned Throughput

```python
def calculate_autoscale_savings(container_name, metrics):
    """Calculate potential savings with autoscale."""

    peak_ru = max(metrics['ru_per_hour'])
    average_ru = sum(metrics['ru_per_hour']) / len(metrics['ru_per_hour'])

    # Provisioned cost (always at peak)
    provisioned_monthly_cost = (peak_ru / 100) * 0.008 * 730  # $0.008 per 100 RU/s per hour

    # Autoscale cost (average consumption + 10% overhead)
    autoscale_monthly_cost = (average_ru / 100) * 0.012 * 730  # $0.012 per 100 RU/s per hour

    savings = provisioned_monthly_cost - autoscale_monthly_cost
    savings_percent = (savings / provisioned_monthly_cost) * 100

    print(f"💰 Cost Analysis for {container_name}")
    print(f"   Peak RU/s: {peak_ru:,.0f}")
    print(f"   Average RU/s: {average_ru:,.0f}")
    print(f"   Provisioned Monthly Cost: ${provisioned_monthly_cost:,.2f}")
    print(f"   Autoscale Monthly Cost: ${autoscale_monthly_cost:,.2f}")
    print(f"   Potential Savings: ${savings:,.2f} ({savings_percent:.1f}%)")

    if savings > 0:
        print(f"   ✅ Recommendation: Switch to autoscale")
    else:
        print(f"   ℹ️ Recommendation: Keep provisioned throughput")

    return savings
```

---

## Related Resources

| Resource | Link |
|----------|------|
| [Query Performance](query-performance.md) | Query optimization guide |
| [Partitioning](partitioning.md) | Partition strategy guide |
| [Cosmos DB Pricing](https://azure.microsoft.com/pricing/details/cosmos-db/) | Official pricing |

---

> **💡 Optimization Tip:** Monitor RU consumption patterns over time to identify optimization opportunities and right-size your throughput.

**Last Updated:** 2025-12-10
**Version:** 1.0.0
