# 🔀 Partitioning Strategies for Azure Cosmos DB

![Scaling](https://img.shields.io/badge/Scaling-Automatic-green?style=flat-square)

Proper partition key selection is critical for Cosmos DB performance and scalability. Choose partition keys that distribute data evenly and align with query patterns.

---

## 🎯 Partition Key Fundamentals

### Key Concepts

- __Logical Partition__: Group of items with same partition key (max 20 GB)
- __Physical Partition__: Storage managed by Cosmos DB (10 GB each)
- __Partition Key Path__: JSON property used for partitioning (e.g., `/customerId`)

```python
# Example: E-commerce order partitioning by customerId
{
    "id": "order-12345",
    "customerId": "cust-67890",  # Partition key
    "orderDate": "2024-01-15",
    "items": [...],
    "total": 299.99
}
```

---

## 📊 Partition Key Selection Criteria

### Good Partition Key Characteristics

| Criteria | Description | Example |
|----------|-------------|---------|
| __High Cardinality__ | Many distinct values | UserId, DeviceId |
| __Even Distribution__ | Balanced storage across partitions | CustomerId, TenantId |
| __Query Pattern Alignment__ | Included in WHERE clauses | Date ranges, Categories |
| __Write Distribution__ | Spreads writes evenly | Timestamp + UserId |

### Anti-patterns to Avoid

```python
# ❌ BAD: Low cardinality
partition_key = "status"  # Only a few values (active, inactive, pending)

# ❌ BAD: Uneven distribution
partition_key = "country"  # US might have 80% of data

# ❌ BAD: Always changes
partition_key = "lastModifiedDate"  # Creates new partitions constantly

# ✅ GOOD: High cardinality, even distribution
partition_key = "customerId"  # Thousands of customers, even distribution
```

---

## 🏗️ Common Partitioning Patterns

### Pattern 1: Single Property Key

```python
# User-centric applications
container = database.create_container(
    id="user-profiles",
    partition_key=PartitionKey(path="/userId")
)

# All user data stays together
user_data = {
    "id": "profile-001",
    "userId": "user-12345",  # Partition key
    "profile": {...},
    "preferences": {...}
}
```

### Pattern 2: Composite Key (Synthetic)

```python
# Combine properties for better distribution
import hashlib

def generate_partition_key(user_id: str) -> str:
    """Create synthetic partition key from userId."""
    # Hash and take modulo for distribution
    hash_value = int(hashlib.md5(user_id.encode()).hexdigest(), 16)
    bucket = hash_value % 100  # 100 partitions
    return f"bucket-{bucket:03d}"

# Usage
document = {
    "id": "doc-001",
    "userId": "user-12345",
    "partitionKey": generate_partition_key("user-12345"),  # "bucket-042"
    "data": {...}
}
```

### Pattern 3: Hierarchical Key

```python
# Multi-tenant SaaS applications
document = {
    "id": "record-001",
    "tenantId": "tenant-A",  # Partition key
    "customerId": "cust-123",
    "data": {...}
}

# All tenant data in same partition - efficient for tenant-scoped queries
```

### Pattern 4: Time-based Partitioning

```python
# IoT or time-series data
from datetime import datetime

def create_time_partition_key(timestamp: datetime) -> str:
    """Create partition key from timestamp."""
    # Partition by year-month for time-series queries
    return timestamp.strftime("%Y-%m")

document = {
    "id": "reading-001",
    "deviceId": "sensor-123",
    "timestamp": "2024-01-15T10:30:00Z",
    "partitionKey": "2024-01",  # Partition by month
    "temperature": 72.5
}
```

---

## 📈 Scaling Considerations

### Monitoring Partition Distribution

```python
from azure.mgmt.cosmosdb import CosmosDBManagementClient
from azure.identity import DefaultAzureCredential

def analyze_partition_metrics():
    """Check partition key distribution."""
    credential = DefaultAzureCredential()
    cosmosdb_client = CosmosDBManagementClient(credential, subscription_id="<sub-id>")

    # Get partition key ranges
    metrics = cosmosdb_client.collection.list_metrics(
        resource_group_name="myresourcegroup",
        account_name="mycosmosaccount",
        database_rid="<database-rid>",
        collection_rid="<collection-rid>",
        filter="name.value eq 'DataUsage'"
    )

    for metric in metrics.value:
        print(f"Partition: {metric.name.value}")
        for timeseries in metric.timeseries:
            for data in timeseries.data:
                print(f"  Storage: {data.total} bytes")
```

---

## 🔗 Related Resources

- [Cosmos DB Overview](README.md)
- [API Selection Guide](api-selection.md)
- [Change Feed](change-feed.md)

---

*Last Updated: 2025-01-28*
*Documentation Status: Complete*
