# HBase to Cosmos DB Migration

**A comprehensive guide for migrating Apache HBase workloads to Azure Cosmos DB, covering data model translation, API mapping, scaling strategies, coprocessor replacement, and service selection guidance.**

---

## Overview

HBase is the most challenging Hadoop component to migrate. Unlike HDFS-to-ADLS (near drop-in) or Hive-to-SparkSQL (minor syntax changes), HBase migration requires genuine re-architecture. The column-family data model, region-based partitioning, and server-side coprocessor framework do not map 1:1 to any single Azure service.

This guide covers:

1. Understanding the data model differences
2. HBase API to Cosmos DB SDK / CQL mapping
3. Region server scaling to RU-based throughput
4. Coprocessor replacement with Change Feed and Azure Functions
5. Choosing between Cosmos DB APIs
6. Migration strategy and tooling

---

## 1. Data model translation

### HBase data model

HBase stores data in a sparse, distributed, multi-dimensional sorted map:

```
(row_key, column_family:qualifier, timestamp) → value
```

| Concept | HBase | Description |
|---|---|---|
| Table | Namespace:Table | Top-level container |
| Row key | Byte array (sorted lexicographically) | Primary access pattern |
| Column family | Defined at table creation, stored together on disk | Physical storage grouping |
| Column qualifier | Dynamic, created at write time | Individual field within a family |
| Cell | (row, cf:qualifier, timestamp) → value | Single value with versioning |
| Region | Range of row keys | Unit of distribution (like a shard) |
| Timestamp | Per-cell versioning | Multiple versions of same cell |

### Cosmos DB data model (NoSQL API)

```json
{
    "id": "order-12345",
    "partitionKey": "customer-789",
    "orderDate": "2025-04-30",
    "items": [
        {"sku": "ABC", "qty": 2, "price": 29.99},
        {"sku": "DEF", "qty": 1, "price": 149.99}
    ],
    "status": "shipped",
    "_ts": 1714435200
}
```

| Concept | Cosmos DB | Description |
|---|---|---|
| Container | Logical table | Top-level container |
| Partition key | Single property value | Unit of distribution |
| Item | JSON document | Single record |
| Properties | Named fields | Strongly typed |
| TTL | Per-item or per-container | Automatic expiration |
| Versioning | Change feed (append-only log) | Not cell-level versioning |

### Model mapping strategy

| HBase pattern | Cosmos DB approach |
|---|---|
| Wide rows (many qualifiers) | Nested JSON document with arrays/objects |
| Tall rows (many versions per cell) | Separate documents per version, or Change Feed for history |
| Column family grouping | Single document (Cosmos stores per partition, not per column family) |
| Row key design (composite keys) | Partition key + id combination |
| Scan by row key range | Query by partition key + range filter |
| Get by exact row key | Point read by partition key + id |

### Example: HBase to Cosmos DB document transformation

```
# HBase row (conceptual):
Row Key: "user-789|order-12345"
Column Family "info":
  info:customer_name = "Alice"
  info:email = "alice@example.com"
Column Family "order":
  order:date = "2025-04-30"
  order:status = "shipped"
  order:total = "209.97"
Column Family "items":
  items:ABC = '{"qty":2,"price":29.99}'
  items:DEF = '{"qty":1,"price":149.99}'
```

```json
// Cosmos DB document:
{
    "id": "order-12345",
    "partitionKey": "user-789",
    "info": {
        "customer_name": "Alice",
        "email": "alice@example.com"
    },
    "order": {
        "date": "2025-04-30",
        "status": "shipped",
        "total": 209.97
    },
    "items": [
        {"sku": "ABC", "qty": 2, "price": 29.99},
        {"sku": "DEF", "qty": 1, "price": 149.99}
    ]
}
```

---

## 2. API mapping: HBase client to Cosmos DB SDK

### Basic CRUD operations

**HBase Java client (before):**

```java
// Connect
Configuration config = HBaseConfiguration.create();
Connection connection = ConnectionFactory.createConnection(config);
Table table = connection.getTable(TableName.valueOf("orders"));

// Put (insert/update)
Put put = new Put(Bytes.toBytes("user-789|order-12345"));
put.addColumn(Bytes.toBytes("info"), Bytes.toBytes("status"), Bytes.toBytes("shipped"));
table.put(put);

// Get (point read)
Get get = new Get(Bytes.toBytes("user-789|order-12345"));
Result result = table.get(get);
String status = Bytes.toString(result.getValue(Bytes.toBytes("info"), Bytes.toBytes("status")));

// Scan (range query)
Scan scan = new Scan();
scan.setStartRow(Bytes.toBytes("user-789|"));
scan.setStopRow(Bytes.toBytes("user-789|~"));
ResultScanner scanner = table.getScanner(scan);
for (Result r : scanner) {
    // Process each row
}

// Delete
Delete delete = new Delete(Bytes.toBytes("user-789|order-12345"));
table.delete(delete);
```

**Cosmos DB SDK (after) — NoSQL API:**

```python
# Connect
from azure.cosmos import CosmosClient, PartitionKey

client = CosmosClient(endpoint, credential)
database = client.get_database_client("orders_db")
container = database.get_container_client("orders")

# Upsert (insert or update)
container.upsert_item({
    "id": "order-12345",
    "partitionKey": "user-789",
    "info": {"status": "shipped"}
})

# Point read (fastest operation)
item = container.read_item(item="order-12345", partition_key="user-789")

# Query (range equivalent of HBase scan)
results = container.query_items(
    query="SELECT * FROM c WHERE c.partitionKey = @pk",
    parameters=[{"name": "@pk", "value": "user-789"}],
    partition_key="user-789"
)
for item in results:
    # Process each document
    pass

# Delete
container.delete_item(item="order-12345", partition_key="user-789")
```

**Cosmos DB SDK (after) — Cassandra API:**

```python
# Connect using cassandra-driver (familiar for HBase teams)
from cassandra.cluster import Cluster
from cassandra.auth import PlainTextAuthProvider

auth = PlainTextAuthProvider(username, password)
cluster = Cluster([contact_point], port=10350, auth_provider=auth, ssl_options=ssl_opts)
session = cluster.connect("orders_keyspace")

# Insert
session.execute("""
    INSERT INTO orders (user_id, order_id, status, total)
    VALUES (%s, %s, %s, %s)
""", ("user-789", "order-12345", "shipped", 209.97))

# Read by partition key
rows = session.execute("""
    SELECT * FROM orders WHERE user_id = %s
""", ("user-789",))

# Read by partition key + clustering key
row = session.execute("""
    SELECT * FROM orders WHERE user_id = %s AND order_id = %s
""", ("user-789", "order-12345"))

# Delete
session.execute("""
    DELETE FROM orders WHERE user_id = %s AND order_id = %s
""", ("user-789", "order-12345"))
```

---

## 3. Scaling: region servers to RU throughput

### HBase scaling model

| Concept | HBase behavior |
|---|---|
| Region | ~10 GB of data, assigned to a RegionServer |
| RegionServer | JVM process managing multiple regions |
| Auto-splitting | Regions split at threshold (default 10 GB) |
| Scaling up | Add more RegionServers (horizontal) |
| Hot regions | Manual pre-splitting or salting row keys |

### Cosmos DB scaling model

| Concept | Cosmos DB behavior |
|---|---|
| Logical partition | All items with same partition key value (max 20 GB) |
| Physical partition | System-managed group of logical partitions (max 50 GB, 10K RU/s) |
| Request Units (RU) | Normalized cost per operation (1 RU = 1 KB point read) |
| Auto-scale | Scales from 10% to 100% of provisioned max RU/s |
| Serverless | Pay per RU consumed, no provisioning |

### Throughput estimation

| HBase operation | Cosmos DB RU cost (approximate) |
|---|---|
| Point read (1 KB item) | 1 RU |
| Point read (10 KB item) | 2-3 RU |
| Write (1 KB item) | 5-7 RU |
| Write (10 KB item) | 10-15 RU |
| Query returning 10 items | 10-50 RU (depends on complexity) |
| Cross-partition query | 50-500+ RU (avoid if possible) |

### Sizing example

```
HBase cluster: 20 RegionServers, 500 regions
Peak throughput: 50,000 reads/sec + 10,000 writes/sec

Cosmos DB equivalent:
  Reads:  50,000 × 2 RU (avg 5 KB items) = 100,000 RU/s
  Writes: 10,000 × 7 RU (avg 2 KB items) =  70,000 RU/s
  Total:                                    170,000 RU/s

Provisioned throughput: 200,000 RU/s (with headroom)
Auto-scale: min 20,000 RU/s → max 200,000 RU/s

Estimated monthly cost: ~$9,600/month (auto-scale pricing)
```

---

## 4. Coprocessor replacement

### HBase coprocessors

HBase coprocessors are server-side code that runs on RegionServers:

| Type | Purpose | Example |
|---|---|---|
| Observer | Trigger logic on data events (pre/post Put, Delete, etc.) | Audit logging, secondary index maintenance |
| Endpoint | Custom RPC endpoints on regions | Server-side aggregation, custom filtering |

### Azure replacements

| HBase coprocessor pattern | Azure equivalent |
|---|---|
| Observer: pre-Put validation | Application-level validation before Cosmos write |
| Observer: post-Put audit logging | Cosmos DB Change Feed → Azure Function → Log Analytics |
| Observer: secondary index update | Cosmos DB Change Feed → Azure Function → secondary container |
| Endpoint: server-side aggregation | Cosmos DB stored procedures or aggregate queries |
| Endpoint: custom filtering | Cosmos DB SQL query (rich query language) |

### Change Feed pattern (replacing Observer coprocessors)

```python
# Azure Function triggered by Cosmos DB Change Feed
import azure.functions as func
import json

def main(documents: func.DocumentList):
    """Process changes from Cosmos DB orders container."""
    for doc in documents:
        order = json.loads(doc.to_json())

        # Pattern 1: Audit logging (replaces Observer coprocessor)
        log_audit_event(order)

        # Pattern 2: Secondary index update
        update_customer_index(order)

        # Pattern 3: Notification on status change
        if order.get("status") == "shipped":
            send_shipping_notification(order)

def log_audit_event(order):
    """Write audit log to Log Analytics or a separate container."""
    # Implementation here
    pass

def update_customer_index(order):
    """Maintain a denormalized view by customer."""
    # Implementation here
    pass

def send_shipping_notification(order):
    """Send notification via Event Grid or Service Bus."""
    # Implementation here
    pass
```

---

## 5. Choosing between Cosmos DB APIs

### Decision matrix

| Factor | NoSQL API | Cassandra API | Table API |
|---|---|---|---|
| Best for | New applications, complex queries | Teams with Cassandra/HBase experience | Simple key-value lookups |
| Query language | SQL-like | CQL (Cassandra Query Language) | OData filter |
| Schema | Flexible JSON | Column families (CQL tables) | Fixed (PartitionKey, RowKey, properties) |
| Secondary indexes | Automatic (all properties indexed) | Must declare explicitly | Limited |
| Complex types | Rich (nested objects, arrays) | Limited (UDTs, collections) | Flat properties only |
| Aggregation | Built-in (GROUP BY, SUM, AVG) | Limited | None |
| Driver ecosystem | Cosmos SDK (Python, Java, .NET, JS) | cassandra-driver (any language) | Azure Tables SDK |
| Migration from HBase | Moderate (schema redesign) | Lower (column family model preserved) | Low (for simple KV patterns) |
| Performance | Best for reads | Good | Best for simple lookups |

### Recommendations by HBase usage pattern

| HBase pattern | Recommended Cosmos API | Rationale |
|---|---|---|
| Wide-column with complex queries | **NoSQL API** | Best query engine, automatic indexing |
| Simple key-value lookups | **Table API** | Lowest cost, simplest API |
| Team knows Cassandra or wants CQL | **Cassandra API** | Familiar data model and query language |
| Heavy write workload | **NoSQL API** or **Cassandra API** | Both handle high write throughput |
| Global distribution needed | **NoSQL API** | Best multi-region write support |
| Time-series data | **NoSQL API** with TTL | Auto-expiration, partition by time window |

---

## 6. Migration strategy

### Phase 1: Schema design (2-4 weeks)

1. **Inventory HBase tables:** row key design, column families, access patterns
2. **Design Cosmos DB containers:** partition key selection, document schema
3. **Map coprocessors:** identify Change Feed + Function replacements
4. **Size throughput:** estimate RU/s from HBase metrics

### Phase 2: Data migration (4-8 weeks)

**Option A: Spark-based migration (recommended for large datasets)**

```python
# Read from HBase using Spark HBase connector
hbase_df = spark.read.format("org.apache.spark.sql.execution.datasources.hbase") \
    .options(catalog=hbase_catalog) \
    .load()

# Transform to Cosmos DB document structure
cosmos_df = hbase_df.select(
    col("row_key").alias("id"),
    col("info:customer_name").alias("customer_name"),
    col("info:email").alias("email"),
    col("order:date").alias("order_date"),
    col("order:status").alias("status"),
    col("order:total").cast("double").alias("total")
).withColumn(
    "partitionKey",
    # Extract user ID from composite row key
    split(col("id"), "\\|")[0]
)

# Write to Cosmos DB using Spark connector
cosmos_df.write.format("cosmos.oltp") \
    .options(**{
        "spark.cosmos.accountEndpoint": cosmos_endpoint,
        "spark.cosmos.accountKey": cosmos_key,
        "spark.cosmos.database": "orders_db",
        "spark.cosmos.container": "orders",
        "spark.cosmos.write.strategy": "ItemOverwrite",
        "spark.cosmos.write.bulk.enabled": "true"
    }) \
    .mode("append") \
    .save()
```

**Option B: ADF Copy Activity (for simpler schemas)**

Use Azure Data Factory with the HBase connector (source) and Cosmos DB connector (sink). ADF handles parallelism, retry logic, and monitoring.

### Phase 3: Application migration (4-8 weeks)

1. Replace HBase client calls with Cosmos DB SDK calls
2. Implement Change Feed processors for coprocessor logic
3. Update connection strings and authentication
4. Run integration tests against Cosmos DB

### Phase 4: Validation and cutover (2-4 weeks)

```python
# Compare row counts
hbase_count = spark.read.format("hbase").options(catalog=cat).load().count()
cosmos_count = spark.read.format("cosmos.oltp").options(**cosmos_opts).load().count()
assert hbase_count == cosmos_count

# Compare sample data
hbase_sample = spark.read.format("hbase").options(catalog=cat).load() \
    .filter("row_key = 'user-789|order-12345'").collect()
cosmos_sample = container.read_item("order-12345", "user-789")
# Compare field-by-field
```

---

## Partition key design patterns

### Common HBase row key patterns and Cosmos equivalents

| HBase row key pattern | Cosmos DB partition key | Notes |
|---|---|---|
| `user_id\|order_id` | partitionKey = `user_id`, id = `order_id` | Most common pattern |
| `reverse_timestamp\|event_id` | partitionKey = time bucket (e.g., `2025-04-30`), id = `event_id` | Time-series data |
| `salted_prefix\|entity_id` | partitionKey = `entity_id` (no salting needed) | Cosmos distributes automatically |
| `region\|date\|sensor_id` | partitionKey = `region\|date`, id = `sensor_id` | Hierarchical partition key |

### Anti-patterns to avoid

| Anti-pattern | Problem | Solution |
|---|---|---|
| Single partition key value | All data in one partition (20 GB limit, 10K RU/s limit) | Choose high-cardinality partition key |
| Too many cross-partition queries | High RU cost, poor performance | Design partition key around query patterns |
| Large documents (>2 MB) | Exceeds Cosmos item size limit | Split into multiple documents or use blob references |
| Monotonically increasing partition key | Hot partition | Use hierarchical partition keys or time-bucketing |

---

## Common pitfalls

| Pitfall | Mitigation |
|---|---|
| Mapping HBase row key directly to Cosmos id | Cosmos id must be unique within a partition; redesign composite keys |
| Ignoring RU cost of cross-partition queries | Profile query patterns; denormalize data to avoid cross-partition reads |
| Expecting cell-level versioning | Use Change Feed for audit trails; Cosmos is not a versioned store |
| Under-provisioning RU/s | Start with auto-scale; monitor and adjust based on actual usage |
| Large batch writes without bulk mode | Enable bulk execution in Cosmos SDK for batch operations |
| Not testing under load | HBase and Cosmos have different latency profiles; load test early |

---

## Related

- [Feature Mapping](feature-mapping-complete.md) — all component mappings
- [Security Migration](security-migration.md) — HBase ACLs to Cosmos RBAC
- [Benchmarks](benchmarks.md) — HBase vs Cosmos DB performance data
- [Migration Hub](index.md) — full migration center

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Feature Mapping](feature-mapping-complete.md) | [Benchmarks](benchmarks.md) | [Migration Hub](index.md)
