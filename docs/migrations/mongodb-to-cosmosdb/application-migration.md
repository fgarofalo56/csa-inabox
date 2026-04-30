# Application Migration: MongoDB to Cosmos DB

**Audience:** Application developers, backend engineers, and DevOps engineers updating application code, drivers, and deployment configurations for Cosmos DB compatibility.

---

## Overview

Application migration is where wire-protocol compatibility pays off. For many applications migrating to Cosmos DB for MongoDB vCore, the change is limited to a connection string update. For RU-based migrations, additional considerations include partition key routing, retry logic for rate limiting (error 16500), and aggregation pipeline compatibility. This guide covers driver compatibility, connection string changes, query compatibility, retry patterns, and error code differences.

---

## 1. Driver compatibility matrix

### Cosmos DB for MongoDB vCore

vCore provides full wire-protocol compatibility with MongoDB 5.0+. All major MongoDB drivers work without modification.

| Driver            | Language  | Minimum version | Recommended | Connection string change only? |
| ----------------- | --------- | --------------- | ----------- | ------------------------------ |
| mongodb           | Node.js   | 4.0             | 6.x+        | Yes                            |
| pymongo           | Python    | 4.0             | 4.6+        | Yes                            |
| mongo-java-driver | Java      | 4.0             | 5.x+        | Yes                            |
| MongoDB.Driver    | C# / .NET | 2.18            | 2.25+       | Yes                            |
| mongo-go-driver   | Go        | 1.8             | 1.14+       | Yes                            |
| mongo-ruby-driver | Ruby      | 2.18            | 2.20+       | Yes                            |
| mongodb (Rust)    | Rust      | 2.4             | 2.8+        | Yes                            |

### Cosmos DB for MongoDB (RU-based)

RU-based supports MongoDB wire protocol versions 3.6, 4.0, 4.2, 5.0, 6.0, and 7.0 (selectable at account creation). Most drivers work, but some configuration changes are needed.

| Driver              | Language  | Minimum version | Required changes                                               |
| ------------------- | --------- | --------------- | -------------------------------------------------------------- |
| mongodb             | Node.js   | 3.6             | Connection string + retry logic for 16500                      |
| pymongo             | Python    | 3.6             | Connection string + `retryWrites=false` for older API versions |
| mongo-java-driver   | Java      | 3.6             | Connection string + error handling                             |
| MongoDB.Driver      | C# / .NET | 2.10            | Connection string + `BulkWriteException` handling              |
| mongoose            | Node.js   | 6.0             | Connection string + `autoIndex: false` recommended             |
| spring-data-mongodb | Java      | 3.0             | Connection string + custom error handler                       |

---

## 2. Connection string changes

### Atlas to vCore

```
# Before (Atlas)
mongodb+srv://user:pass@cluster0.abc123.mongodb.net/mydb?retryWrites=true&w=majority

# After (Cosmos DB vCore)
mongodb+srv://user:pass@my-cluster.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000
```

### Atlas to RU-based

```
# Before (Atlas)
mongodb+srv://user:pass@cluster0.abc123.mongodb.net/mydb?retryWrites=true&w=majority

# After (Cosmos DB RU-based)
mongodb://account-name:primary-key@account-name.mongo.cosmos.azure.com:10255/mydb?ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000&appName=@account-name@
```

### Key differences

| Parameter      | Atlas              | Cosmos DB vCore        | Cosmos DB RU-based        |
| -------------- | ------------------ | ---------------------- | ------------------------- |
| Protocol       | `mongodb+srv://`   | `mongodb+srv://`       | `mongodb://` (port 10255) |
| TLS            | Implicit           | `tls=true`             | `ssl=true`                |
| Auth mechanism | SCRAM-SHA-256      | SCRAM-SHA-256          | Primary key (or Entra ID) |
| Retry writes   | `retryWrites=true` | `retrywrites=false`    | `retrywrites=false`       |
| Replica set    | Auto-discovered    | Not needed             | `replicaSet=globaldb`     |
| Idle timeout   | Driver default     | `maxIdleTimeMS=120000` | `maxIdleTimeMS=120000`    |

### Environment-based configuration

Best practice: store connection strings in Azure Key Vault and reference via environment variable.

```yaml
# Application settings (Azure App Service / Container App)
COSMOS_DB_URI: "@Microsoft.KeyVault(VaultName=kv-data-platform;SecretName=cosmosdb-connection-string)"
```

---

## 3. Query compatibility

### Fully supported operations (both vCore and RU-based)

**CRUD:**

- `insertOne`, `insertMany`, `findOne`, `find`, `findOneAndUpdate`, `findOneAndReplace`, `findOneAndDelete`
- `updateOne`, `updateMany` (with `$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet`, `$pop`, `$rename`, `$min`, `$max`, `$mul`, `$currentDate`)
- `deleteOne`, `deleteMany`
- `replaceOne`
- `bulkWrite`
- `countDocuments`, `estimatedDocumentCount`
- `distinct`

**Aggregation stages:**

- `$match`, `$group`, `$project`, `$addFields`, `$set`, `$unset`
- `$sort`, `$limit`, `$skip`
- `$unwind`, `$replaceRoot`, `$replaceWith`
- `$count`, `$sortByCount`
- `$facet`, `$bucket`, `$bucketAuto`
- `$lookup` (with caveats on RU-based -- see below)
- `$unionWith`

**Aggregation operators:**

- All arithmetic operators (`$add`, `$subtract`, `$multiply`, `$divide`, `$mod`, `$abs`, `$ceil`, `$floor`, `$round`, etc.)
- All string operators (`$concat`, `$substr`, `$toUpper`, `$toLower`, `$trim`, `$split`, `$regexMatch`, etc.)
- All date operators (`$year`, `$month`, `$dayOfMonth`, `$dateToString`, `$dateFromString`, etc.)
- All array operators (`$arrayElemAt`, `$size`, `$filter`, `$map`, `$reduce`, `$in`, `$isArray`, etc.)
- All comparison operators (`$cmp`, `$eq`, `$gt`, `$gte`, `$lt`, `$lte`, `$ne`)
- Conditional operators (`$cond`, `$ifNull`, `$switch`)
- Type operators (`$type`, `$convert`, `$toObjectId`, `$toString`, etc.)

### Operations with limitations on RU-based

| Operation                        | Limitation                            | Workaround                                          |
| -------------------------------- | ------------------------------------- | --------------------------------------------------- |
| `$lookup` (cross-partition)      | Works but expensive (fan-out query)   | Embed data or use same partition key                |
| `$graphLookup`                   | Not supported                         | Use vCore, or implement in application layer        |
| `$merge` (to different database) | Not supported                         | Application-level copy or change feed               |
| `$out` (to different database)   | Not supported                         | Use `$merge` to same database                       |
| `$where` / `$eval`               | Not supported                         | Rewrite as aggregation expression                   |
| Map-reduce                       | Not supported (deprecated in MongoDB) | Rewrite as aggregation pipeline                     |
| `$listSessions` / `$currentOp`   | Not supported                         | Use Azure Monitor diagnostics                       |
| `db.runCommand({collMod: ...})`  | Limited support                       | Use Azure Portal or CLI for container modifications |

### vCore-specific: full aggregation support

vCore supports the complete MongoDB aggregation pipeline, including `$graphLookup`, `$merge` to different databases, and all stages up to MongoDB 7.0. If your application relies on these features, vCore is the recommended target.

---

## 4. Error code mapping

Cosmos DB returns standard MongoDB error codes where possible, but some errors are Cosmos DB-specific.

### Critical error codes for RU-based

| Error code | MongoDB meaning     | Cosmos DB meaning                     | Action                                      |
| ---------- | ------------------- | ------------------------------------- | ------------------------------------------- |
| **16500**  | Not used in MongoDB | Rate limiting (429 Too Many Requests) | Retry with backoff; increase RU/s           |
| **1000**   | Not used            | Unique key violation                  | Check unique key policy; deduplicate data   |
| **40**     | Not used            | Request timeout                       | Increase throughput or simplify query       |
| **50**     | ExceededTimeLimit   | Query exceeded timeout                | Add indexes; simplify aggregation           |
| **13**     | Unauthorized        | Insufficient permissions              | Check RBAC or connection string credentials |
| **26**     | NamespaceNotFound   | Collection/database not found         | Verify container exists                     |
| **11000**  | DuplicateKey        | Duplicate `_id` or unique key         | Handle duplicates before insert             |

### Error handling pattern

```python
# Python: comprehensive error handling for Cosmos DB RU-based
from pymongo.errors import (
    BulkWriteError,
    OperationFailure,
    ConnectionFailure,
    AutoReconnect,
)
import time


def execute_with_retry(operation, max_retries=5, base_delay=0.1):
    """Execute a MongoDB operation with retry logic for Cosmos DB."""
    for attempt in range(max_retries):
        try:
            return operation()
        except OperationFailure as e:
            if e.code == 16500:  # Rate limiting
                delay = base_delay * (2 ** attempt)
                print(f"Rate limited (429). Retrying in {delay}s...")
                time.sleep(delay)
                continue
            elif e.code == 50:  # Timeout
                print(f"Query timeout. Consider adding indexes or simplifying.")
                raise
            else:
                raise
        except (ConnectionFailure, AutoReconnect) as e:
            delay = base_delay * (2 ** attempt)
            print(f"Connection error. Retrying in {delay}s...")
            time.sleep(delay)
            continue
    raise Exception(f"Operation failed after {max_retries} retries")


# Usage
result = execute_with_retry(
    lambda: db.orders.find({"customerId": "cust-123"}).to_list()
)
```

```javascript
// Node.js: retry wrapper for Cosmos DB
async function withRetry(operation, maxRetries = 5) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (error.code === 16500 && attempt < maxRetries - 1) {
                const delay = Math.min(100 * Math.pow(2, attempt), 5000);
                console.warn(
                    `Rate limited. Retry ${attempt + 1} in ${delay}ms`,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
}

// Usage
const orders = await withRetry(() =>
    db.collection("orders").find({ customerId: "cust-123" }).toArray(),
);
```

---

## 5. ODM and framework-specific changes

### Mongoose (Node.js)

```javascript
const mongoose = require("mongoose");

// Cosmos DB vCore: minimal changes
mongoose.connect(process.env.COSMOS_VCORE_URI, {
    tls: true,
    authMechanism: "SCRAM-SHA-256",
    maxIdleTimeMS: 120000,
});

// Cosmos DB RU-based: additional settings
mongoose.connect(process.env.COSMOS_RU_URI, {
    tls: true,
    maxIdleTimeMS: 120000,
    autoIndex: false, // RU-based manages indexes via indexing policy
    autoCreate: false, // Containers should be pre-created with partition keys
});

// Disable autoIndex on all schemas (RU-based)
mongoose.set("autoIndex", false);
```

### Spring Data MongoDB (Java)

```yaml
# application.yml
spring:
    data:
        mongodb:
            uri: ${COSMOS_DB_URI}
            auto-index-creation: false # RU-based: use indexing policy
```

```java
// Custom error handler for Cosmos DB rate limiting
@Component
public class CosmosRetryHandler implements RetryListener {
    @Override
    public <T, E extends Throwable> boolean onError(
            RetryContext context, RetryCallback<T, E> callback, Throwable throwable) {
        if (throwable instanceof MongoCommandException) {
            MongoCommandException mce = (MongoCommandException) throwable;
            if (mce.getErrorCode() == 16500) {
                // Rate limited -- retry will handle this
                return true;
            }
        }
        return false;
    }
}
```

### Prisma

```prisma
// schema.prisma
datasource db {
  provider = "mongodb"
  url      = env("COSMOS_VCORE_URI")  // vCore is fully compatible
}
```

Prisma works with Cosmos DB vCore without changes. RU-based compatibility is limited -- Prisma assumes certain MongoDB server behaviors that RU-based may not support. Use vCore for Prisma-based applications.

---

## 6. Bulk operation changes

### MongoDB bulk write (before)

```javascript
const ops = orders.map((order) => ({
    insertOne: { document: order },
}));
await db.collection("orders").bulkWrite(ops, { ordered: false });
```

### Cosmos DB bulk write (with rate limit handling)

```javascript
async function bulkWriteWithThrottle(collection, ops, batchSize = 100) {
    const batches = [];
    for (let i = 0; i < ops.length; i += batchSize) {
        batches.push(ops.slice(i, i + batchSize));
    }

    const results = { insertedCount: 0, errors: [] };

    for (const batch of batches) {
        await withRetry(async () => {
            const result = await collection.bulkWrite(batch, {
                ordered: false,
            });
            results.insertedCount += result.insertedCount;
        });
    }

    return results;
}
```

For RU-based, large bulk writes must be batched to avoid overwhelming the RU budget. A batch size of 100--500 documents is typical, with retry logic for 16500 errors between batches.

---

## 7. Change stream to change feed migration

### MongoDB change stream (before)

```javascript
const changeStream = db.collection("orders").watch([], {
    fullDocument: "updateLookup",
});

changeStream.on("change", (change) => {
    console.log("Change:", change.operationType, change.fullDocument._id);
    // Process change...
});
```

### Cosmos DB vCore: change streams (same API)

```javascript
// vCore: identical API
const changeStream = db.collection("orders").watch([], {
    fullDocument: "updateLookup",
});

changeStream.on("change", (change) => {
    console.log("Change:", change.operationType, change.fullDocument._id);
});
```

### Cosmos DB RU-based: change feed via Azure Functions

```csharp
// C#: Azure Functions change feed trigger (recommended for RU-based)
[FunctionName("OrderChangeFeed")]
public static async Task Run(
    [CosmosDBTrigger(
        databaseName: "mydb",
        containerName: "orders",
        Connection = "CosmosDBConnection",
        LeaseContainerName = "leases",
        CreateLeaseContainerIfNotExists = true)]
    IReadOnlyList<Document> changes,
    [EventHub("order-events", Connection = "EventHubConnection")]
    IAsyncCollector<string> outputEvents,
    ILogger log)
{
    foreach (var change in changes)
    {
        log.LogInformation($"Order changed: {change.Id}");
        await outputEvents.AddAsync(change.ToString());
    }
}
```

For RU-based, the change feed is the recommended approach. It integrates natively with Azure Functions, provides automatic checkpointing, and feeds directly into the csa-inabox Event Hubs pipeline.

---

## 8. Testing strategy

### Unit tests

- Update connection strings in test configuration to point to a Cosmos DB free tier or emulator.
- Run existing test suite. Note failures related to unsupported operations.
- Add retry logic tests (simulate 16500 errors for RU-based).

### Integration tests

- Run the application against Cosmos DB target with production-like data.
- Validate all CRUD operations, aggregation pipelines, and change stream/feed consumers.
- Measure query latency and compare with baseline (source MongoDB).
- For RU-based: monitor RU consumption per test to validate capacity planning.

### Load tests

- Run load tests at expected production traffic levels.
- Monitor for 429 (16500) errors. If throttling occurs, increase RU/s or optimize queries.
- Validate autoscale behavior: traffic ramp-up, scale-out, scale-down.

---

## 9. Application migration checklist

- [ ] Updated all connection strings (environment variables, Key Vault secrets, config files).
- [ ] Verified driver version meets minimum requirements for target Cosmos DB API.
- [ ] Added retry logic for error code 16500 (RU-based only).
- [ ] Disabled `autoIndex` in ODM configuration (RU-based only).
- [ ] Validated all CRUD operations against target.
- [ ] Validated aggregation pipelines against target (note any unsupported stages).
- [ ] Migrated change stream consumers to change feed (RU-based) or verified change stream compatibility (vCore).
- [ ] Updated bulk write operations with batching and throttle handling.
- [ ] Run integration test suite against target with zero failures.
- [ ] Run load test and validated RU consumption is within budget.
- [ ] Updated monitoring and alerting for Cosmos DB metrics (RU consumption, latency, 429 rate).

---

## Related resources

- [vCore Migration Guide](vcore-migration.md)
- [RU-Based Migration Guide](ru-migration.md)
- [Schema Migration](schema-migration.md)
- [Data Migration](data-migration.md)
- [Best Practices](best-practices.md)
- [Migration Playbook](../mongodb-to-cosmosdb.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
