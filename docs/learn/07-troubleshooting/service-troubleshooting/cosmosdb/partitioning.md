---
title: "Azure Cosmos DB Partition Troubleshooting"
description: "Comprehensive guide for diagnosing and resolving partition-related issues in Azure Cosmos DB including hot partitions, partition key selection, cross-partition queries, and partition splitting."
tags:
  - troubleshooting
  - cosmosdb
---
# Azure Cosmos DB Partition Troubleshooting

![Status](https://img.shields.io/badge/Status-Active-brightgreen) ![Complexity](https://img.shields.io/badge/Complexity-Advanced-red)

Comprehensive guide for diagnosing and resolving partition-related issues in Azure Cosmos DB including hot partitions, partition key selection, cross-partition queries, and partition splitting.

## Table of Contents

- [Overview](#overview)
- [Common Partition Issues](#common-partition-issues)
- [Diagnostic Queries](#diagnostic-queries)
- [Hot Partition Detection](#hot-partition-detection)
- [Partition Key Selection](#partition-key-selection)
- [Resolution Strategies](#resolution-strategies)
- [Related Resources](#related-resources)

---

## Overview

Partition strategy is critical for Cosmos DB performance and scalability. Poor partition key selection or uneven data distribution can lead to hot partitions, throttling, and degraded performance across your database.

> **⚠️ Important:** Partition keys cannot be changed after container creation. Plan carefully before implementing.

---

## Common Partition Issues

### Issue 1: Hot Partitions

**Symptoms:**
- 429 (Request Rate Too Large) errors on specific partition keys
- Uneven request distribution
- Some operations fast while others are throttled
- High RU consumption on subset of data

**Common Causes:**

| Cause | Likelihood | Impact | Detection |
|:------|:-----------|:-------|:----------|
| Celebrity problem (few popular items) | High | High | Monitor partition metrics |
| Sequential keys (timestamps) | High | High | Check partition distribution |
| Uneven data growth | Medium | High | Analyze partition size |
| Query patterns favor specific partitions | Medium | Medium | Review query patterns |

**Step-by-Step Resolution:**

#### 1. Identify Hot Partitions

```kusto
// Query to identify hot partitions in Azure Monitor
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DOCUMENTDB"
| where Category == "PartitionKeyStatistics"
| where TimeGenerated > ago(1h)
| summarize
    TotalRequests = sum(RequestCharge),
    AvgRU = avg(RequestCharge)
    by PartitionKey, bin(TimeGenerated, 5m)
| order by TotalRequests desc
```

#### 2. Analyze Partition Distribution

```python
from azure.cosmos import CosmosClient, exceptions
import json

def analyze_partition_distribution(database_name, container_name):
    """Analyze data distribution across partitions."""

    client = CosmosClient(endpoint, credential)
    database = client.get_database_client(database_name)
    container = database.get_container_client(container_name)

    # Get partition key ranges
    query = """
    SELECT
        c.partitionKey,
        COUNT(1) as DocumentCount,
        SUM(c._ts) as LastModified
    FROM c
    GROUP BY c.partitionKey
    ORDER BY COUNT(1) DESC
    """

    results = list(container.query_items(
        query=query,
        enable_cross_partition_query=True
    ))

    # Calculate distribution metrics
    total_docs = sum(r['DocumentCount'] for r in results)
    avg_docs_per_partition = total_docs / len(results)

    print(f"Total Documents: {total_docs}")
    print(f"Total Partitions: {len(results)}")
    print(f"Average Docs per Partition: {avg_docs_per_partition:.2f}")
    print("\nTop 10 Largest Partitions:")

    for idx, result in enumerate(results[:10], 1):
        partition_key = result['partitionKey']
        doc_count = result['DocumentCount']
        percentage = (doc_count / total_docs) * 100

        print(f"{idx}. Partition '{partition_key}': {doc_count} docs ({percentage:.2f}%)")

        # Flag hot partitions (> 10% of data)
        if percentage > 10:
            print(f"   ⚠️ HOT PARTITION DETECTED!")

    return results

# Run analysis
results = analyze_partition_distribution("myDatabase", "myContainer")
```

#### 3. Monitor Partition-Level Metrics

```python
from azure.monitor.query import LogsQueryClient, LogsQueryStatus
from azure.identity import DefaultAzureCredential
from datetime import timedelta

def get_partition_metrics(workspace_id, resource_id):
    """Get detailed partition metrics from Azure Monitor."""

    credential = DefaultAzureCredential()
    client = LogsQueryClient(credential)

    query = f"""
    AzureDiagnostics
    | where ResourceId == "{resource_id}"
    | where Category == "DataPlaneRequests"
    | where TimeGenerated > ago(1h)
    | summarize
        RequestCount = count(),
        TotalRU = sum(todouble(requestCharge_s)),
        AvgRU = avg(todouble(requestCharge_s)),
        P95RU = percentile(todouble(requestCharge_s), 95)
        by partitionId_g, operationType_s, bin(TimeGenerated, 5m)
    | order by TotalRU desc
    """

    response = client.query_workspace(
        workspace_id=workspace_id,
        query=query,
        timespan=timedelta(hours=1)
    )

    if response.status == LogsQueryStatus.SUCCESS:
        for table in response.tables:
            for row in table.rows:
                print(row)
    else:
        print(f"Query failed: {response.status}")

    return response
```

### Issue 2: Poor Partition Key Selection

**Symptoms:**
- All requests hitting same partition
- Cannot scale beyond single partition throughput
- Cross-partition queries required for most operations

**Bad Partition Key Examples:**

| Bad Key | Why It's Bad | Better Alternative |
|:--------|:-------------|:-------------------|
| `id` | Each partition has 1 document | Use category, region, or tenant ID |
| `timestamp` | Sequential writes create hot partition | Combine with other property (e.g., `category-timestamp`) |
| `true/false` | Only 2 partitions | Use more granular property |
| `status` | Limited cardinality (few values) | Combine with user ID or date |
| Empty string | All data in one partition | Always provide meaningful key |

**Good Partition Key Characteristics:**

```python
class PartitionKeyEvaluator:
    """Evaluate partition key quality."""

    def __init__(self, container_name, partition_key_path):
        self.container_name = container_name
        self.partition_key_path = partition_key_path

    def evaluate_cardinality(self, documents):
        """Check unique partition key values."""
        unique_keys = set(
            self._get_nested_value(doc, self.partition_key_path)
            for doc in documents
        )

        cardinality_ratio = len(unique_keys) / len(documents)

        print(f"📊 Cardinality Analysis:")
        print(f"   Total Documents: {len(documents)}")
        print(f"   Unique Partition Keys: {len(unique_keys)}")
        print(f"   Cardinality Ratio: {cardinality_ratio:.2%}")

        if cardinality_ratio < 0.1:
            print("   ❌ Poor cardinality - too few unique values")
        elif cardinality_ratio < 0.5:
            print("   ⚠️ Moderate cardinality - may cause issues at scale")
        else:
            print("   ✅ Good cardinality")

        return cardinality_ratio

    def evaluate_distribution(self, documents):
        """Check data distribution across partition keys."""
        from collections import Counter

        partition_counts = Counter(
            self._get_nested_value(doc, self.partition_key_path)
            for doc in documents
        )

        # Calculate standard deviation
        import statistics
        std_dev = statistics.stdev(partition_counts.values())
        mean = statistics.mean(partition_counts.values())
        cv = std_dev / mean  # Coefficient of variation

        print(f"\n📈 Distribution Analysis:")
        print(f"   Mean docs per partition: {mean:.2f}")
        print(f"   Std deviation: {std_dev:.2f}")
        print(f"   Coefficient of variation: {cv:.2%}")

        if cv > 0.5:
            print("   ❌ Highly uneven distribution")
        elif cv > 0.3:
            print("   ⚠️ Moderately uneven distribution")
        else:
            print("   ✅ Even distribution")

        # Show top 5 largest partitions
        print(f"\n   Top 5 Largest Partitions:")
        for key, count in partition_counts.most_common(5):
            percentage = (count / len(documents)) * 100
            print(f"   - '{key}': {count} docs ({percentage:.1f}%)")

        return cv

    def _get_nested_value(self, doc, path):
        """Get nested property value from document."""
        keys = path.strip('/').split('/')
        value = doc
        for key in keys:
            value = value.get(key, '')
        return value

# Example usage
evaluator = PartitionKeyEvaluator("myContainer", "/tenantId")
documents = list(container.read_all_items())

cardinality = evaluator.evaluate_cardinality(documents)
distribution = evaluator.evaluate_distribution(documents)
```

---

## Diagnostic Queries

### Partition Size Query

```sql
-- Query to check partition sizes
SELECT
    c.partitionKey,
    COUNT(1) as DocumentCount,
    SUM(LENGTH(ToString(c))) as ApproximateSizeBytes,
    MIN(c._ts) as OldestDocument,
    MAX(c._ts) as NewestDocument
FROM c
GROUP BY c.partitionKey
ORDER BY COUNT(1) DESC
```

### Partition Health Check

```python
def partition_health_check(container):
    """Comprehensive partition health check."""

    # Get partition key paths
    container_properties = container.read()
    partition_key_path = container_properties['partitionKey']['paths'][0]

    print(f"🔍 Partition Health Check")
    print(f"Container: {container.id}")
    print(f"Partition Key: {partition_key_path}")
    print("-" * 60)

    # Query partition statistics
    query = f"""
    SELECT
        c{partition_key_path} as PartitionKey,
        COUNT(1) as DocCount,
        MIN(c._ts) as FirstDoc,
        MAX(c._ts) as LastDoc,
        AVG(LENGTH(ToString(c))) as AvgDocSize
    FROM c
    GROUP BY c{partition_key_path}
    """

    results = list(container.query_items(
        query=query,
        enable_cross_partition_query=True
    ))

    # Analyze results
    total_docs = sum(r['DocCount'] for r in results)
    total_partitions = len(results)
    avg_per_partition = total_docs / total_partitions if total_partitions > 0 else 0

    # Identify issues
    issues = []

    # Check for hot partitions (>10% of data)
    for r in results:
        percentage = (r['DocCount'] / total_docs) * 100
        if percentage > 10:
            issues.append({
                'type': 'Hot Partition',
                'partition': r['PartitionKey'],
                'percentage': percentage,
                'doc_count': r['DocCount']
            })

    # Check for empty or small partitions
    for r in results:
        if r['DocCount'] < 10:
            issues.append({
                'type': 'Small Partition',
                'partition': r['PartitionKey'],
                'doc_count': r['DocCount']
            })

    # Print summary
    print(f"\n📊 Summary:")
    print(f"   Total Documents: {total_docs:,}")
    print(f"   Total Partitions: {total_partitions:,}")
    print(f"   Avg Docs/Partition: {avg_per_partition:,.1f}")

    if issues:
        print(f"\n⚠️ Issues Found ({len(issues)}):")
        for issue in issues[:10]:  # Show first 10
            if issue['type'] == 'Hot Partition':
                print(f"   - HOT: '{issue['partition']}' has {issue['percentage']:.1f}% of data")
            else:
                print(f"   - SMALL: '{issue['partition']}' has only {issue['doc_count']} docs")
    else:
        print(f"\n✅ No major partition issues detected")

    return {
        'total_docs': total_docs,
        'total_partitions': total_partitions,
        'avg_per_partition': avg_per_partition,
        'issues': issues
    }
```

---

## Hot Partition Detection

### Real-Time Monitoring

```python
from azure.monitor.query import MetricsQueryClient
from datetime import datetime, timedelta

def monitor_partition_metrics(resource_id):
    """Monitor partition-level metrics in real-time."""

    credential = DefaultAzureCredential()
    client = MetricsQueryClient(credential)

    # Define metrics to monitor
    metrics = [
        "NormalizedRUConsumption",
        "TotalRequests",
        "ServerSideLatency"
    ]

    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=1)

    response = client.query_resource(
        resource_uri=resource_id,
        metric_names=metrics,
        timespan=(start_time, end_time),
        granularity=timedelta(minutes=1),
        aggregations=["Average", "Maximum"]
    )

    # Analyze results
    for metric in response.metrics:
        print(f"\n📊 Metric: {metric.name}")

        for timeseries in metric.timeseries:
            partition_id = timeseries.metadata_values.get('PartitionId', 'Unknown')

            for data_point in timeseries.data:
                if data_point.maximum and data_point.maximum > 80:  # 80% threshold
                    print(f"   ⚠️ {data_point.time_stamp}: Partition {partition_id}")
                    print(f"      Average: {data_point.average:.2f}%")
                    print(f"      Maximum: {data_point.maximum:.2f}%")

    return response
```

### Alert Configuration

```bash
# Create alert rule for hot partitions
az monitor metrics alert create \
    --name "CosmosDB-HotPartition" \
    --resource-group <rg-name> \
    --scopes <cosmosdb-account-id> \
    --condition "avg NormalizedRUConsumption > 80" \
    --window-size 5m \
    --evaluation-frequency 1m \
    --action <action-group-id> \
    --description "Alert when partition RU consumption exceeds 80%"
```

---

## Partition Key Selection

### Choosing the Right Partition Key

**Decision Matrix:**

```python
def recommend_partition_key(document_sample, query_patterns):
    """Recommend partition key based on data and query patterns."""

    recommendations = []

    # Analyze document properties
    if 'tenantId' in document_sample[0]:
        recommendations.append({
            'key': '/tenantId',
            'reason': 'Multi-tenant data - natural isolation',
            'score': 9,
            'pros': ['Query isolation', 'Data isolation', 'Scalable'],
            'cons': ['May have tenant size variance']
        })

    if 'category' in document_sample[0] and 'userId' in document_sample[0]:
        recommendations.append({
            'key': '/category-userId',
            'reason': 'Composite key for better distribution',
            'score': 8,
            'pros': ['High cardinality', 'Even distribution'],
            'cons': ['Requires synthetic property']
        })

    # Analyze query patterns
    common_filters = extract_common_filters(query_patterns)

    for filter_field in common_filters:
        if filter_field not in [r['key'] for r in recommendations]:
            recommendations.append({
                'key': f'/{filter_field}',
                'reason': f'Frequently filtered in queries',
                'score': 7,
                'pros': ['Optimizes common queries'],
                'cons': ['Need to verify cardinality']
            })

    # Sort by score
    recommendations.sort(key=lambda x: x['score'], reverse=True)

    # Print recommendations
    print("🎯 Partition Key Recommendations:\n")
    for idx, rec in enumerate(recommendations, 1):
        print(f"{idx}. {rec['key']} (Score: {rec['score']}/10)")
        print(f"   Reason: {rec['reason']}")
        print(f"   Pros: {', '.join(rec['pros'])}")
        print(f"   Cons: {', '.join(rec['cons'])}")
        print()

    return recommendations[0] if recommendations else None

def extract_common_filters(query_patterns):
    """Extract commonly filtered fields from queries."""
    # Simplified example
    from collections import Counter

    filters = []
    for query in query_patterns:
        # Parse WHERE clause and extract fields
        # This is a simplified version
        if 'WHERE' in query:
            # Extract field names
            pass

    return Counter(filters).most_common(3)
```

---

## Resolution Strategies

### Strategy 1: Migrate to Better Partition Key

**Note:** Partition keys cannot be changed. Migration requires creating new container.

```python
from azure.cosmos import PartitionKey
import asyncio

async def migrate_to_new_partition_key(
    source_container,
    target_database,
    new_container_name,
    new_partition_key_path,
    batch_size=100
):
    """Migrate data to container with new partition key."""

    # Create new container
    new_container = target_database.create_container(
        id=new_container_name,
        partition_key=PartitionKey(path=new_partition_key_path),
        offer_throughput=10000  # Temporary high throughput for migration
    )

    print(f"✅ Created new container: {new_container_name}")

    # Read all items from source
    query = "SELECT * FROM c"
    items = list(source_container.query_items(
        query=query,
        enable_cross_partition_query=True
    ))

    print(f"📊 Migrating {len(items)} items...")

    # Batch upsert to new container
    batch = []
    migrated = 0

    for item in items:
        # Add synthetic partition key if needed
        if new_partition_key_path.startswith('/synthetic'):
            # Example: create synthetic key from multiple properties
            item['synthetic_key'] = f"{item.get('category', 'unknown')}-{item.get('userId', 'unknown')}"

        batch.append(item)

        if len(batch) >= batch_size:
            # Upsert batch
            for doc in batch:
                try:
                    new_container.upsert_item(doc)
                    migrated += 1
                except Exception as e:
                    print(f"❌ Error migrating document {doc.get('id')}: {e}")

            print(f"   Migrated {migrated}/{len(items)} items...")
            batch = []

    # Upsert remaining items
    for doc in batch:
        try:
            new_container.upsert_item(doc)
            migrated += 1
        except Exception as e:
            print(f"❌ Error migrating document {doc.get('id')}: {e}")

    print(f"✅ Migration complete: {migrated} items migrated")

    # Scale down new container
    new_container.replace_throughput(400)

    return new_container
```

### Strategy 2: Implement Synthetic Partition Keys

```python
def create_synthetic_partition_key(document, strategy='hash'):
    """Create synthetic partition key for better distribution."""

    if strategy == 'hash':
        # Hash-based distribution
        import hashlib
        key_source = f"{document.get('userId', '')}{document.get('timestamp', '')}"
        hash_value = hashlib.md5(key_source.encode()).hexdigest()
        bucket = int(hash_value[:8], 16) % 100  # 100 buckets
        return f"bucket-{bucket:03d}"

    elif strategy == 'composite':
        # Composite key from multiple properties
        category = document.get('category', 'unknown')
        date = document.get('date', '1970-01-01')[:7]  # YYYY-MM
        return f"{category}-{date}"

    elif strategy == 'hierarchical':
        # Hierarchical key for multi-tenant scenarios
        tenant = document.get('tenantId', 'unknown')
        region = document.get('region', 'unknown')
        return f"{tenant}/{region}"

    else:
        raise ValueError(f"Unknown strategy: {strategy}")

# Example: Add synthetic key before insert
def insert_with_synthetic_key(container, document):
    """Insert document with synthetic partition key."""

    # Add synthetic partition key
    document['partitionKey'] = create_synthetic_partition_key(document, strategy='composite')

    # Upsert document
    container.upsert_item(document)

    return document
```

---

## Related Resources

### Internal Documentation

| Resource | Description |
|----------|-------------|
| [RU Optimization](ru-optimization.md) | Request Unit optimization strategies |
| [Query Performance](query-performance.md) | Query optimization techniques |
| Cosmos DB Best Practices | General best practices |

### External Resources

| Resource | Link |
|----------|------|
| **Partitioning Guide** | [Microsoft Docs](https://docs.microsoft.com/azure/cosmos-db/partitioning-overview) |
| **Partition Key Strategies** | [Best Practices](https://docs.microsoft.com/azure/cosmos-db/partition-data) |
| **Performance Tips** | [Cosmos DB Performance](https://docs.microsoft.com/azure/cosmos-db/performance-tips) |

---

> **💡 Partitioning Tip:** Choose partition keys that align with your query patterns and provide high cardinality. Test with production-like data before finalizing your design.

**Last Updated:** 2025-12-10
**Version:** 1.0.0
