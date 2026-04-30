# MongoDB to Cosmos DB for MongoDB (RU-Based) Migration Guide

**Audience:** Platform architects, data engineers, and application developers migrating from MongoDB to Azure Cosmos DB for MongoDB with the request-unit (RU) throughput model.

---

## Overview

Cosmos DB for MongoDB (RU-based) is a globally distributed, multi-model database service that uses request units (RU/s) as its throughput currency. Unlike vCore (which mirrors a traditional cluster architecture), the RU model abstracts compute and storage into a throughput-provisioned service with automatic partitioning, global distribution, and analytical store capabilities. This model is best suited for applications that need planetary-scale distribution, event-driven architectures via change feed, or zero-ETL HTAP through analytical store.

---

## 1. Understanding request units

A request unit (RU) represents the normalized cost of a database operation. Every operation -- read, write, query, or aggregation -- consumes RUs based on:

- **Document size** -- larger documents consume more RUs per operation.
- **Index overhead** -- more indexed properties increase write RU cost.
- **Query complexity** -- simple point reads cost 1 RU per 1 KB document. Scans, sorts, and aggregations cost more.
- **Consistency level** -- strong consistency reads cost 2x eventual consistency reads.

### RU cost examples

| Operation                                               | Approximate RU cost     |
| ------------------------------------------------------- | ----------------------- |
| Point read (1 KB document, by `_id` + partition key)    | 1 RU                    |
| Point read (10 KB document)                             | ~3 RU                   |
| Insert (1 KB document)                                  | ~6 RU                   |
| Insert (10 KB document)                                 | ~20 RU                  |
| Replace (1 KB document)                                 | ~10 RU                  |
| Query returning 5 documents (1 KB each, indexed filter) | ~5 RU                   |
| Aggregation (scan 1,000 documents, return 10)           | ~50--200 RU             |
| Cross-partition query (fan-out)                         | 5--50x single-partition |

### Estimating total RU/s requirement

```
Total RU/s = (reads/sec x avg_read_RU) + (writes/sec x avg_write_RU) + (queries/sec x avg_query_RU)
```

**Example:** An application doing 500 point reads/sec (1 RU each), 100 inserts/sec (6 RU each), and 50 queries/sec (20 RU each) needs:

```
500 x 1 + 100 x 6 + 50 x 20 = 500 + 600 + 1,000 = 2,100 RU/s
```

With autoscale (10x range), provision 2,100 RU/s minimum, autoscaling to 21,000 RU/s for peaks.

---

## 2. Throughput provisioning models

### Manual throughput

- Fixed RU/s provisioned at container or database level.
- Minimum: 400 RU/s (or 100 RU/s with shared throughput database).
- Scales in increments of 100 RU/s.
- Best for: steady-state workloads with predictable traffic.

### Autoscale throughput

- Provisions a maximum RU/s; Cosmos DB scales between 10% of max and max.
- Billed at the highest RU/s reached in each hour.
- Best for: variable workloads, batch + interactive mixed patterns.
- Example: autoscale max 10,000 RU/s. If traffic uses only 2,000 RU/s, billed at 2,000.

### Serverless

- No provisioned throughput. Billed per RU consumed.
- Maximum 5,000 RU/s burst.
- Best for: dev/test, low-traffic applications, event-driven microservices.
- Limitation: single-region only, no geo-replication, no analytical store.

### Choosing the right model

| Workload pattern                  | Recommended model                          | Why                                           |
| --------------------------------- | ------------------------------------------ | --------------------------------------------- |
| Steady 24/7 traffic               | Manual (with reserved capacity discount)   | Lowest cost for predictable load              |
| Business hours peak, quiet nights | Autoscale                                  | Scales down automatically during off-hours    |
| Unpredictable bursts              | Autoscale                                  | Handles 10x traffic spikes without throttling |
| Dev/test                          | Serverless                                 | Zero cost when idle                           |
| Batch processing (nightly ETL)    | Autoscale (with programmatic max increase) | Scale up for batch, scale down after          |

---

## 3. Partition key design

**The partition key is the single most important design decision for RU-based Cosmos DB. It is immutable after container creation.**

### What a partition key does

- Determines how documents are distributed across physical partitions.
- Scopes transactions (multi-document transactions only within a single partition key value).
- Affects query performance (single-partition queries are cheap; cross-partition queries fan out).
- Determines throughput distribution (each physical partition has a max of 10,000 RU/s).

### Partition key selection criteria

| Criterion              | Good partition key                       | Bad partition key                              |
| ---------------------- | ---------------------------------------- | ---------------------------------------------- |
| **Cardinality**        | High (many distinct values)              | Low (few values, e.g., `status` with 3 values) |
| **Distribution**       | Even (similar document counts per value) | Skewed (one value has 80% of documents)        |
| **Query affinity**     | Most queries filter by this field        | Queries rarely filter by this field            |
| **Write distribution** | Writes spread across many values         | All writes go to one value (hot partition)     |

### Common patterns

| Use case           | Recommended partition key     | Rationale                                                               |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| User profiles      | `/userId`                     | High cardinality, most queries filter by user                           |
| Orders             | `/customerId`                 | Queries by customer; transactions scope to customer                     |
| IoT telemetry      | `/deviceId`                   | Even distribution across devices                                        |
| Multi-tenant SaaS  | `/tenantId`                   | Isolates tenant data; tenant-scoped queries                             |
| Catalog / products | `/categoryId`                 | Moderate cardinality; queries by category                               |
| Logs / events      | `/partitionDate` (YYYY-MM-DD) | Time-based distribution; avoid hot "today" partition by adding a suffix |

### Hierarchical partition keys

For scenarios needing multi-level distribution, Cosmos DB supports hierarchical partition keys (up to 3 levels):

```
Partition key: /tenantId, /userId, /sessionId
```

This allows fine-grained distribution while still supporting efficient queries at any level of the hierarchy.

### Anti-patterns

- **`_id` as partition key** -- ObjectId provides high cardinality but no query affinity. Every query becomes cross-partition.
- **Timestamp as sole partition key** -- creates hot partitions at the current time boundary.
- **Status fields** -- low cardinality (e.g., `active`/`inactive`) creates severe skew.
- **Overly specific keys** -- if every document has a unique partition key, transactions become impossible.

---

## 4. Capacity planning from MongoDB metrics

### Step 1: Collect MongoDB metrics

```bash
# Current operations per second
mongostat --uri="mongodb+srv://..." --rowcount=60

# Document sizes
mongosh --eval '
  db.orders.aggregate([
    { $sample: { size: 1000 } },
    { $project: { size: { $bsonSize: "$$ROOT" } } },
    { $group: {
      _id: null,
      avgSize: { $avg: "$size" },
      maxSize: { $max: "$size" },
      p95Size: { $percentile: { input: "$size", p: [0.95], method: "approximate" } }
    }}
  ])
'

# Operations breakdown
mongosh --eval 'db.serverStatus().opcounters'
```

### Step 2: Calculate RU requirements

Map MongoDB operations to RU costs:

```
MongoDB op/s → Cosmos DB RU/s
═══════════════════════════════
Reads:   getmore + query → Point reads (1 RU/KB) or queries (5-200 RU)
Inserts: insert           → Insert (5-20 RU depending on size + indexes)
Updates: update            → Replace (10-30 RU) or partial update (5-15 RU)
Deletes: delete            → Delete (5-10 RU)
```

### Step 3: Add headroom

- Add 20% headroom for indexing overhead.
- Add 30% headroom for query plan variations.
- If using autoscale, set max at 3--5x the calculated steady-state.

---

## 5. Indexing policy design

Unlike MongoDB, where you explicitly create indexes, RU-based Cosmos DB uses a declarative indexing policy. By default, all properties are indexed, which maximizes query flexibility but increases write RU cost.

### Default indexing policy (all properties indexed)

```json
{
    "indexingMode": "consistent",
    "automatic": true,
    "includedPaths": [{ "path": "/*" }],
    "excludedPaths": [{ "path": "/\"_etag\"/?" }]
}
```

### Optimized indexing policy (targeted)

```json
{
    "indexingMode": "consistent",
    "automatic": true,
    "includedPaths": [
        { "path": "/customerId/?" },
        { "path": "/orderDate/?" },
        { "path": "/status/?" },
        { "path": "/total/?" }
    ],
    "excludedPaths": [{ "path": "/*" }],
    "compositeIndexes": [
        [
            { "path": "/customerId", "order": "ascending" },
            { "path": "/orderDate", "order": "descending" }
        ]
    ]
}
```

**Impact:** Targeted indexing reduces write RU cost by 20--50% compared to the default "index everything" policy. Only index properties that appear in query filters, sort clauses, or range predicates.

---

## 6. Migration execution steps

### Step 1: Provision Cosmos DB account

```bash
# Create account with MongoDB API
az cosmosdb create \
  --resource-group rg-data-platform \
  --name my-cosmos-account \
  --kind MongoDB \
  --server-version 7.0 \
  --default-consistency-level Session \
  --locations regionName=eastus failoverPriority=0 isZoneRedundant=true \
  --locations regionName=westus failoverPriority=1 isZoneRedundant=false \
  --enable-analytical-storage true \
  --backup-policy-type Continuous
```

### Step 2: Create database and containers with partition keys

```bash
# Create database with shared throughput
az cosmosdb mongodb database create \
  --resource-group rg-data-platform \
  --account-name my-cosmos-account \
  --name mydb \
  --throughput 4000

# Create container with partition key
az cosmosdb mongodb collection create \
  --resource-group rg-data-platform \
  --account-name my-cosmos-account \
  --database-name mydb \
  --name orders \
  --shard "customerId" \
  --analytical-storage-ttl -1 \
  --throughput 4000
```

### Step 3: Configure indexing policy

Use the Azure Portal or Azure CLI to set a targeted indexing policy on each container. See Section 5 above.

### Step 4: Migrate data

See [Data Migration Guide](data-migration.md) for detailed options. For RU-based, Azure DMS with online CDC is the recommended path for production migrations.

### Step 5: Enable analytical store

Analytical store is enabled per container (set at creation with `--analytical-storage-ttl -1` for infinite retention). Once enabled, operational data automatically syncs to the column-oriented analytical store within approximately 2 minutes.

### Step 6: Configure change feed consumers

```csharp
// C# example: Azure Functions change feed trigger
[FunctionName("ProcessChangeFeed")]
public static void Run(
    [CosmosDBTrigger(
        databaseName: "mydb",
        containerName: "orders",
        Connection = "CosmosDBConnection",
        LeaseContainerName = "leases",
        CreateLeaseContainerIfNotExists = true)]
    IReadOnlyList<Document> documents,
    ILogger log)
{
    foreach (var doc in documents)
    {
        log.LogInformation($"Change detected: {doc.Id}");
        // Publish to Event Hubs for Fabric RTI
    }
}
```

---

## 7. Autoscale configuration

### Programmatic autoscale adjustment (for batch windows)

```bash
# Scale up before nightly batch
az cosmosdb mongodb collection throughput update \
  --resource-group rg-data-platform \
  --account-name my-cosmos-account \
  --database-name mydb \
  --name orders \
  --max-throughput 50000

# Scale down after batch completes
az cosmosdb mongodb collection throughput update \
  --resource-group rg-data-platform \
  --account-name my-cosmos-account \
  --database-name mydb \
  --name orders \
  --max-throughput 10000
```

### Monitoring RU consumption

```bash
# Check current RU usage via Azure Monitor
az monitor metrics list \
  --resource "/subscriptions/{sub}/resourceGroups/rg-data-platform/providers/Microsoft.DocumentDB/databaseAccounts/my-cosmos-account" \
  --metric "TotalRequestUnits" \
  --interval PT1M \
  --aggregation Total
```

Monitor the `NormalizedRUConsumption` metric. If it consistently exceeds 70%, increase autoscale maximum. If consistently below 20%, reduce to save cost.

---

## 8. Rate limiting and retry strategy

When RU consumption exceeds provisioned throughput, Cosmos DB returns HTTP 429 (Too Many Requests) with a `Retry-After` header. MongoDB wire protocol translates this to error code **16500**.

### Driver retry configuration

```javascript
// Node.js: configure retry for RU throttling
const client = new MongoClient(uri, {
    retryWrites: true,
    retryReads: true,
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 360000,
});

// Manually handle 16500 (rate limiting)
async function withRetry(fn, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (err.code === 16500 && i < maxRetries - 1) {
                const retryAfterMs = err.errorLabels?.includes(
                    "RetryableWriteError",
                )
                    ? 100 * Math.pow(2, i)
                    : 1000;
                await new Promise((resolve) =>
                    setTimeout(resolve, retryAfterMs),
                );
                continue;
            }
            throw err;
        }
    }
}
```

---

## 9. Global distribution setup

```bash
# Add regions for geo-replication
az cosmosdb update \
  --resource-group rg-data-platform \
  --name my-cosmos-account \
  --locations regionName=eastus failoverPriority=0 isZoneRedundant=true \
  --locations regionName=westus failoverPriority=1 isZoneRedundant=true \
  --locations regionName=northeurope failoverPriority=2 isZoneRedundant=false

# Enable multi-region writes
az cosmosdb update \
  --resource-group rg-data-platform \
  --name my-cosmos-account \
  --enable-multiple-write-locations true
```

Multi-region writes multiply the RU cost by the number of write regions. For a 3-region, multi-write deployment, every write consumes 3x the RU cost. Budget accordingly.

---

## 10. CSA-in-a-Box integration

The RU-based model unlocks two integration pathways unique to this deployment model:

### Analytical store to Fabric

```python
# Fabric Spark notebook: query Cosmos DB analytical store
df = spark.read \
    .format("cosmos.olap") \
    .option("spark.synapse.linkedService", "CosmosDb_mydb") \
    .option("spark.cosmos.container", "orders") \
    .load()

df.createOrReplaceTempView("orders_analytical")

# Run analytical queries without impacting operational workload
spark.sql("""
    SELECT region, DATE(orderDate) as order_date, SUM(total) as revenue
    FROM orders_analytical
    WHERE orderDate >= '2026-01-01'
    GROUP BY region, DATE(orderDate)
    ORDER BY revenue DESC
""").show()
```

### Change feed to Event Hubs to Fabric RTI

See `examples/iot-streaming/` and `csa_platform/data_activator/` for the full pattern. The change feed processor publishes events to Event Hubs; Fabric Real-Time Intelligence ingests them into a KQL database or Fabric lakehouse as Delta tables.

---

## Related resources

- [vCore Migration Guide](vcore-migration.md)
- [Schema Migration](schema-migration.md)
- [Data Migration](data-migration.md)
- [Application Migration](application-migration.md)
- [Best Practices](best-practices.md)
- [Migration Playbook](../mongodb-to-cosmosdb.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
