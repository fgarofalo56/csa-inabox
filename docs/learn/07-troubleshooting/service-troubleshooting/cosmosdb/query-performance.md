# Azure Cosmos DB Query Performance Troubleshooting

![Status](https://img.shields.io/badge/Status-Active-brightgreen) ![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow)

Guide for diagnosing and resolving query performance issues in Azure Cosmos DB including slow queries, high RU consumption, and query optimization strategies.

## Table of Contents

- [Overview](#overview)
- [Common Query Issues](#common-query-issues)
- [Query Metrics Analysis](#query-metrics-analysis)
- [Index Optimization](#index-optimization)
- [Query Optimization Techniques](#query-optimization-techniques)
- [Related Resources](#related-resources)

---

## Overview

Query performance in Cosmos DB is measured in Request Units (RUs). Inefficient queries can consume excessive RUs, leading to throttling and increased costs.

> **⚠️ Important:** Always use query metrics to understand RU consumption and execution patterns.

---

## Common Query Issues

### Issue 1: High RU Consumption

**Symptoms:**
- Queries consuming 100+ RUs
- Frequent 429 (throttling) errors
- Increased costs
- Slow query execution

**Common Causes:**

| Cause | Impact | Solution |
|:------|:-------|:---------|
| Missing indexes | Very High | Add composite indexes |
| Cross-partition queries | High | Use partition key in WHERE clause |
| Full collection scans | Very High | Add appropriate filters |
| Large result sets | Medium | Implement pagination |
| ORDER BY without index | High | Create composite index for ORDER BY |

**Resolution:**

```python
from azure.cosmos import CosmosClient
import json

def analyze_query_metrics(container, query):
    """Analyze query metrics to identify performance issues."""

    # Enable query metrics
    query_items = container.query_items(
        query=query,
        enable_cross_partition_query=True,
        populate_query_metrics=True
    )

    results = []
    metrics_list = []

    for item in query_items:
        results.append(item)

    # Get query metrics
    metrics = query_items.response_headers

    print(f"📊 Query Metrics Analysis")
    print(f"{'='*60}")
    print(f"Total RU Charge: {metrics.get('x-ms-request-charge', 'N/A')}")
    print(f"Retrieved Document Count: {metrics.get('x-ms-item-count', 'N/A')}")
    print(f"Total Query Execution Time: {metrics.get('x-ms-total-query-execution-time-ms', 'N/A')} ms")
    print(f"Index Lookup Time: {metrics.get('x-ms-documentdb-index-utilization', 'N/A')}")

    # Parse detailed metrics
    if 'x-ms-cosmos-query-metrics' in metrics:
        detailed_metrics = json.loads(metrics['x-ms-cosmos-query-metrics'])
        print(f"\n🔍 Detailed Metrics:")
        for key, value in detailed_metrics.items():
            print(f"   {key}: {value}")

    return {
        'ru_charge': float(metrics.get('x-ms-request-charge', 0)),
        'item_count': int(metrics.get('x-ms-item-count', 0)),
        'execution_time_ms': float(metrics.get('x-ms-total-query-execution-time-ms', 0))
    }

# Example usage
query = "SELECT * FROM c WHERE c.category = 'electronics' ORDER BY c.price"
metrics = analyze_query_metrics(container, query)
```

### Issue 2: Slow Cross-Partition Queries

**Symptoms:**
- Queries taking several seconds
- High latency
- Inconsistent performance

**Resolution:**

```python
def optimize_cross_partition_query(container, category, max_price):
    """Optimize cross-partition query with best practices."""

    # Bad: Full scan across all partitions
    bad_query = f"""
    SELECT * FROM c
    WHERE c.category = '{category}' AND c.price < {max_price}
    ORDER BY c.price
    """

    # Good: Optimized with pagination and specific fields
    good_query = f"""
    SELECT TOP 100 c.id, c.name, c.price, c.category
    FROM c
    WHERE c.category = '{category}' AND c.price < {max_price}
    ORDER BY c.price
    """

    # Execute optimized query
    results = []
    continuation_token = None

    while True:
        query_items = container.query_items(
            query=good_query,
            enable_cross_partition_query=True,
            max_item_count=100,
            continuation_token=continuation_token
        )

        batch = []
        for item in query_items:
            batch.append(item)
            if len(batch) >= 100:
                break

        results.extend(batch)

        # Check for more pages
        if len(batch) < 100:
            break

        continuation_token = query_items.response_headers.get('x-ms-continuation')
        if not continuation_token:
            break

    return results
```

---

## Query Metrics Analysis

### Understanding Query Metrics

```python
class QueryPerformanceAnalyzer:
    """Analyze and report on query performance."""

    def __init__(self, container):
        self.container = container

    def benchmark_query(self, query, iterations=10):
        """Run query multiple times and collect metrics."""
        import time

        results = []

        print(f"🔬 Benchmarking query ({iterations} iterations)...")
        print(f"Query: {query[:100]}...")

        for i in range(iterations):
            start_time = time.time()

            query_items = self.container.query_items(
                query=query,
                enable_cross_partition_query=True,
                populate_query_metrics=True
            )

            items = list(query_items)
            execution_time = time.time() - start_time

            metrics = {
                'iteration': i + 1,
                'execution_time': execution_time,
                'ru_charge': float(query_items.response_headers.get('x-ms-request-charge', 0)),
                'item_count': len(items)
            }

            results.append(metrics)

        # Calculate statistics
        avg_time = sum(r['execution_time'] for r in results) / len(results)
        avg_ru = sum(r['ru_charge'] for r in results) / len(results)
        total_items = results[0]['item_count']

        print(f"\n📊 Benchmark Results:")
        print(f"   Average Execution Time: {avg_time:.3f} seconds")
        print(f"   Average RU Charge: {avg_ru:.2f} RUs")
        print(f"   Items Retrieved: {total_items}")
        print(f"   RU per Item: {avg_ru/total_items:.2f}" if total_items > 0 else "   N/A")

        # Performance assessment
        if avg_ru > 100:
            print(f"\n⚠️ HIGH RU CONSUMPTION - Consider optimization")
        if avg_time > 1.0:
            print(f"⚠️ SLOW QUERY - Execution time > 1 second")

        return results
```

---

## Index Optimization

### Check Indexing Policy

```python
def analyze_indexing_policy(container):
    """Analyze container indexing policy."""

    properties = container.read()
    indexing_policy = properties['indexingPolicy']

    print(f"📑 Indexing Policy Analysis")
    print(f"{'='*60}")
    print(f"Indexing Mode: {indexing_policy.get('indexingMode', 'N/A')}")
    print(f"Automatic: {indexing_policy.get('automatic', 'N/A')}")

    # Included paths
    print(f"\n✅ Included Paths:")
    for path in indexing_policy.get('includedPaths', []):
        print(f"   - {path.get('path', 'N/A')}")

    # Excluded paths
    print(f"\n❌ Excluded Paths:")
    for path in indexing_policy.get('excludedPaths', []):
        print(f"   - {path.get('path', 'N/A')}")

    # Composite indexes
    print(f"\n🔗 Composite Indexes:")
    for composite in indexing_policy.get('compositeIndexes', []):
        paths = [f"{p['path']} ({p.get('order', 'ASC')})" for p in composite]
        print(f"   - {' + '.join(paths)}")

    return indexing_policy

def add_composite_index(container, index_paths):
    """Add composite index to container."""

    properties = container.read()
    indexing_policy = properties['indexingPolicy']

    # Add composite index
    if 'compositeIndexes' not in indexing_policy:
        indexing_policy['compositeIndexes'] = []

    indexing_policy['compositeIndexes'].append(index_paths)

    # Update container
    container.replace_container(
        partition_key=properties['partitionKey'],
        indexing_policy=indexing_policy
    )

    print(f"✅ Added composite index: {index_paths}")

# Example: Add composite index for ORDER BY query
add_composite_index(container, [
    {"path": "/category", "order": "ascending"},
    {"path": "/price", "order": "ascending"}
])
```

---

## Query Optimization Techniques

### Best Practices

```python
class QueryOptimizer:
    """Collection of query optimization techniques."""

    @staticmethod
    def use_specific_fields(category):
        """Return only needed fields instead of SELECT *."""

        # Bad
        bad = f"SELECT * FROM c WHERE c.category = '{category}'"

        # Good
        good = f"SELECT c.id, c.name, c.price FROM c WHERE c.category = '{category}'"

        return good

    @staticmethod
    def use_parameterized_queries(container, category, min_price):
        """Use parameterized queries for better performance."""

        query = """
        SELECT c.id, c.name, c.price
        FROM c
        WHERE c.category = @category AND c.price >= @minPrice
        """

        parameters = [
            {"name": "@category", "value": category},
            {"name": "@minPrice", "value": min_price}
        ]

        items = container.query_items(
            query=query,
            parameters=parameters,
            enable_cross_partition_query=True
        )

        return list(items)

    @staticmethod
    def implement_pagination(container, query, page_size=100):
        """Implement efficient pagination."""

        continuation_token = None
        page_number = 1

        while True:
            print(f"📄 Fetching page {page_number}...")

            query_items = container.query_items(
                query=query,
                enable_cross_partition_query=True,
                max_item_count=page_size,
                continuation_token=continuation_token
            )

            page_results = []
            for item in query_items:
                page_results.append(item)

            if not page_results:
                break

            yield page_results

            continuation_token = query_items.response_headers.get('x-ms-continuation')
            if not continuation_token:
                break

            page_number += 1

# Usage
optimizer = QueryOptimizer()
query = "SELECT c.id, c.name FROM c WHERE c.category = 'electronics'"

for page in optimizer.implement_pagination(container, query, page_size=50):
    print(f"Processing {len(page)} items...")
```

---

## Related Resources

| Resource | Description |
|----------|-------------|
| [Partitioning](partitioning.md) | Partition strategy optimization |
| [RU Optimization](ru-optimization.md) | Request Unit optimization |
| [Cosmos DB Query Best Practices](https://docs.microsoft.com/azure/cosmos-db/sql-query-getting-started) | Microsoft documentation |

---

> **💡 Query Tip:** Always use query metrics to measure performance. What gets measured gets improved.

**Last Updated:** 2025-12-10
**Version:** 1.0.0
