# MongoDB to Cosmos DB for MongoDB vCore Migration Guide

**Audience:** Platform architects, data engineers, and application developers migrating from MongoDB Atlas or self-hosted MongoDB to Azure Cosmos DB for MongoDB vCore.

---

## Overview

Cosmos DB for MongoDB vCore is a cluster-based deployment that provides the highest degree of wire-protocol compatibility with MongoDB. It uses dedicated compute nodes with local SSD storage, supports the full MongoDB aggregation pipeline (including `$lookup`, `$graphLookup`, `$merge`, `$out`), and offers native vector search. For teams migrating from Atlas or self-hosted MongoDB, vCore is the path of least resistance -- many applications require only a connection string swap.

---

## 1. Architecture comparison

### MongoDB Atlas / self-hosted

```
┌──────────────────────────────────────────┐
│  Replica Set (3 nodes)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Primary  │ │Secondary │ │Secondary │  │
│  │ (mongod) │ │ (mongod) │ │ (mongod) │  │
│  └──────────┘ └──────────┘ └──────────┘  │
│       WiredTiger storage engine           │
└──────────────────────────────────────────┘
```

### Cosmos DB for MongoDB vCore

```
┌──────────────────────────────────────────┐
│  vCore Cluster                            │
│  ┌──────────┐ ┌──────────┐               │
│  │ Primary  │ │ HA       │               │
│  │ Node     │ │ Replica  │  (optional)   │
│  └──────────┘ └──────────┘               │
│       Managed storage (SSD-backed)        │
│       Automatic failover                  │
│       Native vector search                │
└──────────────────────────────────────────┘
```

Key architectural differences:

- **Node count:** vCore clusters use 1 primary + 1 HA replica (optional), not the 3-node minimum of a replica set. HA is handled by Azure's infrastructure.
- **Storage:** Managed by Azure. No WiredTiger tuning (cache size, journal settings). Auto-scales up to the tier limit.
- **Mongos/config servers:** Not needed. Routing is handled by the managed service endpoint.
- **Wire protocol:** MongoDB 5.0+ wire protocol. Drivers connect using a standard MongoDB connection string.

---

## 2. Cluster tier selection

Map your current MongoDB deployment to a vCore tier:

| Atlas tier | vCores | RAM     | Storage | vCore tier             | vCores | RAM    | Storage (max) |
| ---------- | ------ | ------- | ------- | ---------------------- | ------ | ------ | ------------- |
| M10        | 2      | 2 GB    | 10 GB   | Burstable B2s          | 2      | 4 GB   | 32 GB         |
| M20        | 2      | 4 GB    | 20 GB   | Burstable B4ms         | 4      | 8 GB   | 64 GB         |
| M30        | 2      | 8 GB    | 40 GB   | General Purpose M32s   | 4      | 32 GB  | 128 GB        |
| M40        | 4      | 16 GB   | 80 GB   | General Purpose M64s   | 8      | 64 GB  | 256 GB        |
| M50        | 8      | 32 GB   | 160 GB  | General Purpose M64s   | 8      | 64 GB  | 512 GB        |
| M60        | 16     | 64 GB   | 320 GB  | General Purpose M128s  | 16     | 128 GB | 1 TB          |
| M80        | 32     | 128 GB  | 750 GB  | Memory Optimized M128s | 32     | 256 GB | 2 TB          |
| M140       | 48     | 192 GB  | 1 TB    | Memory Optimized M128s | 32     | 256 GB | 4 TB          |
| M200       | 64     | 256 GB  | 1.5 TB  | Memory Optimized E64s  | 64     | 512 GB | 4 TB          |
| M300+      | 96+    | 384+ GB | 2 TB+   | Memory Optimized E96s  | 96     | 672 GB | 4 TB          |

**Sizing guidance:**

- **Burstable tiers** -- use for dev/test, staging, and low-traffic production. Baseline performance with burst capability. Significantly cheaper than General Purpose.
- **General Purpose** -- production workloads with consistent performance. Good balance of compute and memory.
- **Memory Optimized** -- large working sets, in-memory aggregation, workloads that benefit from large cache. Choose when your current MongoDB cache-to-data ratio exceeds 30%.

### Free tier

Cosmos DB for MongoDB vCore offers a free tier: 32 GB storage, burstable compute, no time limit. Use for prototyping, proof-of-concept, and developer sandboxes.

---

## 3. Connection string migration

### Atlas connection string (before)

```
mongodb+srv://admin:password@cluster0.abc123.mongodb.net/mydb?retryWrites=true&w=majority
```

### Cosmos DB vCore connection string (after)

```
mongodb+srv://admin:password@my-cluster.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000
```

Key differences:

| Parameter      | Atlas                         | Cosmos DB vCore                                         |
| -------------- | ----------------------------- | ------------------------------------------------------- |
| Host           | `cluster0.abc123.mongodb.net` | `my-cluster.mongocluster.cosmos.azure.com`              |
| TLS            | Implicit (Atlas requires TLS) | Explicit: `tls=true`                                    |
| Auth mechanism | SCRAM-SHA-256 (default)       | SCRAM-SHA-256 (explicit recommended)                    |
| Retry writes   | `retryWrites=true`            | `retrywrites=false` (vCore handles retries differently) |
| Idle timeout   | Driver default                | `maxIdleTimeMS=120000` recommended                      |
| `w=majority`   | Supported                     | Supported (durable by default)                          |

### Connection string in application code

=== "Node.js (Mongoose)"

    ```javascript
    // Before (Atlas)
    const uri = process.env.ATLAS_URI;
    mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    // After (Cosmos DB vCore) -- only URI changes
    const uri = process.env.COSMOS_VCORE_URI;
    mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      tls: true,
      authMechanism: 'SCRAM-SHA-256',
    });
    ```

=== "Python (PyMongo)"

    ```python
    # Before (Atlas)
    client = MongoClient(os.environ["ATLAS_URI"])

    # After (Cosmos DB vCore)
    client = MongoClient(
        os.environ["COSMOS_VCORE_URI"],
        tls=True,
        authMechanism="SCRAM-SHA-256",
        maxIdleTimeMS=120000,
    )
    ```

=== "Java (MongoDB Driver)"

    ```java
    // Before (Atlas)
    MongoClient client = MongoClients.create(System.getenv("ATLAS_URI"));

    // After (Cosmos DB vCore)
    ConnectionString connStr = new ConnectionString(System.getenv("COSMOS_VCORE_URI"));
    MongoClientSettings settings = MongoClientSettings.builder()
        .applyConnectionString(connStr)
        .build();
    MongoClient client = MongoClients.create(settings);
    ```

=== "C# (.NET)"

    ```csharp
    // Before (Atlas)
    var client = new MongoClient(Environment.GetEnvironmentVariable("ATLAS_URI"));

    // After (Cosmos DB vCore)
    var client = new MongoClient(Environment.GetEnvironmentVariable("COSMOS_VCORE_URI"));
    ```

---

## 4. Driver compatibility

Cosmos DB for MongoDB vCore supports standard MongoDB drivers. Minimum recommended versions:

| Driver                 | Minimum version | Recommended version | Notes              |
| ---------------------- | --------------- | ------------------- | ------------------ |
| Node.js (mongodb)      | 4.0             | 6.x+                | Full compatibility |
| Python (PyMongo)       | 4.0             | 4.6+                | Full compatibility |
| Java                   | 4.0             | 5.x+                | Full compatibility |
| C# (.NET)              | 2.18            | 2.25+               | Full compatibility |
| Go                     | 1.8             | 1.14+               | Full compatibility |
| Ruby                   | 2.18            | 2.20+               | Full compatibility |
| Rust                   | 2.4             | 2.8+                | Full compatibility |
| Mongoose (Node.js ODM) | 6.0             | 8.x+                | Full compatibility |
| Spring Data MongoDB    | 3.4             | 4.x+                | Full compatibility |

---

## 5. Feature compatibility

### Fully supported (no code changes)

- All CRUD operations (`insertOne`, `insertMany`, `findOne`, `find`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `replaceOne`)
- Aggregation pipeline (all stages including `$lookup`, `$graphLookup`, `$merge`, `$out`, `$setWindowFields`)
- Multi-document transactions (within the cluster)
- All BSON types (including Decimal128, ObjectId, Binary)
- All index types (single, compound, multikey, text, geospatial, hashed, wildcard, TTL, unique)
- Change streams (collection, database, and deployment level)
- `mongosh` commands
- `mongodump` / `mongorestore`
- MongoDB Compass connectivity

### Limitations to be aware of

- **Single-region deployment** -- vCore does not support multi-region replication. For multi-region, use RU-based.
- **`$eval` / `$where`** -- server-side JavaScript execution is supported but discouraged for security.
- **Capped collections** -- supported with some behavioral differences. Test thoroughly.
- **Time-series collections** -- not supported natively. Use regular collections with TTL.
- **Config database** -- some `config` collection queries may behave differently in a managed cluster.

---

## 6. Migration execution steps

### Step 1: Provision Cosmos DB vCore cluster

```bash
# Azure CLI
az cosmosdb mongocluster create \
  --resource-group rg-data-platform \
  --cluster-name my-mongo-cluster \
  --location eastus \
  --administrator-login admin \
  --administrator-login-password "$ADMIN_PASSWORD" \
  --server-version "7.0" \
  --shard-node-tier "M64" \
  --shard-node-disk-size-gb 512 \
  --shard-node-ha true
```

### Step 2: Configure networking

```bash
# Enable private endpoint
az cosmosdb mongocluster firewall rule create \
  --resource-group rg-data-platform \
  --cluster-name my-mongo-cluster \
  --rule-name allow-app-subnet \
  --start-ip-address 10.0.1.0 \
  --end-ip-address 10.0.1.255
```

### Step 3: Migrate data

For detailed data migration options, see [Data Migration Guide](data-migration.md). Quick path for small datasets:

```bash
# mongodump from source
mongodump --uri="mongodb+srv://admin:pass@source-cluster.mongodb.net" \
  --out=/tmp/mongodump

# mongorestore to Cosmos DB vCore
mongorestore --uri="mongodb+srv://admin:pass@my-cluster.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256" \
  /tmp/mongodump
```

### Step 4: Validate

```bash
# Connect with mongosh
mongosh "mongodb+srv://admin:pass@my-cluster.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256"

# Verify collections
show dbs
use mydb
show collections

# Verify document counts
db.orders.countDocuments()
db.customers.countDocuments()

# Run sample queries
db.orders.find({ status: "completed" }).limit(5)
db.orders.aggregate([
  { $match: { status: "completed" } },
  { $group: { _id: "$region", total: { $sum: "$amount" } } }
])
```

### Step 5: Switch application connection strings

Update environment variables or Key Vault secrets to point to the Cosmos DB vCore endpoint. Deploy application changes. Monitor error rates and latency for 24--48 hours before decommissioning the source.

---

## 7. Vector search setup (vCore advantage)

One of vCore's unique capabilities is native vector search, co-located with operational data.

### Create a vector index

```javascript
db.runCommand({
    createIndexes: "products",
    indexes: [
        {
            name: "vector_index",
            key: { embedding: "cosmosSearch" },
            cosmosSearchOptions: {
                kind: "vector-hnsw",
                numLists: 100,
                similarity: "COS",
                dimensions: 1536,
                m: 16,
                efConstruction: 64,
            },
        },
    ],
});
```

### Query with vector search

```javascript
db.products.aggregate([
    {
        $search: {
            cosmosSearch: {
                vector: queryEmbedding, // 1536-dimension array from Azure OpenAI
                path: "embedding",
                k: 10,
            },
        },
    },
    {
        $project: {
            name: 1,
            description: 1,
            score: { $meta: "searchScore" },
        },
    },
]);
```

This integrates directly with Azure OpenAI for embedding generation and the csa-inabox AI integration patterns in `csa_platform/ai_integration/`.

---

## 8. CSA-in-a-Box platform integration

After migration, integrate Cosmos DB vCore with the csa-inabox data platform:

1. **Purview governance** -- register the Cosmos DB account as a data source in Purview. Purview scans collections, infers schemas, and applies classifications.
2. **Change streams to Fabric** -- use Azure Functions or a custom consumer to read vCore change streams and publish to Event Hubs. Fabric RTI ingests from Event Hubs into Delta tables.
3. **Power BI** -- connect Power BI to Cosmos DB vCore using the MongoDB ODBC/JDBC connector or import data through Fabric lakehouse.
4. **Azure AI integration** -- use vCore native vector search with Azure OpenAI embeddings for RAG scenarios within the csa-inabox AI patterns.

---

## Related resources

- [RU-Based Migration Guide](ru-migration.md)
- [Schema Migration](schema-migration.md)
- [Data Migration](data-migration.md)
- [Application Migration](application-migration.md)
- [Tutorial: VS Code Migration](tutorial-vscode-migration.md)
- [Benchmarks](benchmarks.md)
- [Migration Playbook](../mongodb-to-cosmosdb.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
