# Schema Migration: MongoDB to Cosmos DB

**Audience:** Data engineers, application architects, and database administrators designing the target schema for Cosmos DB after migrating from MongoDB.

---

## Overview

MongoDB's flexible schema is one of its core strengths -- and that flexibility carries over to Cosmos DB for MongoDB. Both vCore and RU-based deployments support schemaless documents, nested objects, arrays, and mixed-type fields. However, schema migration is not just about copying the document structure. It is about optimizing for Cosmos DB's performance characteristics: partition key design (RU-based), indexing policy tuning, document size management, and reference vs. embedding trade-offs.

This guide covers collection design patterns, document modeling, indexing strategy, partition key selection, and TTL configuration for both Cosmos DB deployment models.

---

## 1. Collection design patterns

### 1:1 collection mapping (default)

The simplest approach: map each MongoDB collection to a Cosmos DB container. This works for most migrations and is the recommended starting point.

```
MongoDB                    Cosmos DB
═══════                    ═════════
users        →            users (container)
orders       →            orders (container)
products     →            products (container)
inventory    →            inventory (container)
```

### Collection consolidation (RU-based optimization)

For RU-based deployments with shared database throughput, consolidating small collections into a single container reduces the minimum RU overhead. Each container on dedicated throughput requires at least 400 RU/s; shared throughput databases require 400 RU/s total across all containers.

**Pattern: discriminator field**

```json
// Users and preferences in a single container
// Partition key: /entityType + /userId (hierarchical)
{
  "entityType": "user",
  "userId": "user-123",
  "name": "Jane Doe",
  "email": "jane@example.com"
}

{
  "entityType": "preference",
  "userId": "user-123",
  "theme": "dark",
  "language": "en-US"
}
```

**When to consolidate:**

- Collections with fewer than 1,000 documents and minimal throughput
- Related entities always queried together
- Total collections exceed 25 (shared throughput has a 25-container limit for 400 RU/s)

**When not to consolidate:**

- Collections with different TTL requirements
- Collections with different indexing needs
- High-throughput collections that need dedicated RU budgets

### Collection splitting (for hot partitions)

If a single MongoDB collection has a skewed access pattern (e.g., 90% of traffic hits "active" orders), consider splitting:

```
MongoDB                    Cosmos DB
═══════                    ═════════
orders       →            active_orders (container, high throughput)
             →            archived_orders (container, low throughput)
```

---

## 2. Document modeling: embedded vs. referenced

### Embedded documents (denormalized)

MongoDB best practice: embed related data when it is read together. This carries over to Cosmos DB with one critical caveat for RU-based: **document size affects RU cost**.

**Good candidate for embedding:**

```json
{
    "_id": "order-456",
    "customerId": "cust-123",
    "orderDate": "2026-04-30T10:00:00Z",
    "items": [
        { "productId": "prod-1", "name": "Widget A", "qty": 2, "price": 29.99 },
        { "productId": "prod-2", "name": "Widget B", "qty": 1, "price": 49.99 }
    ],
    "shipping": {
        "address": "123 Main St",
        "city": "Arlington",
        "state": "VA",
        "zip": "22201"
    },
    "total": 109.97
}
```

**Why embed here:**

- Items and shipping are always read with the order.
- The embedded arrays are bounded (orders have finite items).
- The total document size stays well under 16 KB.

### Referenced documents (normalized)

Use references when:

- The referenced entity is large or unbounded.
- The referenced entity changes independently and frequently.
- The referenced entity is shared across multiple parent documents.

**Example: referencing user profile from orders**

```json
// orders container
{
  "_id": "order-456",
  "customerId": "cust-123",  // reference, not embedded
  "orderDate": "2026-04-30T10:00:00Z",
  "total": 109.97
}

// users container
{
  "_id": "cust-123",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "address": { "street": "123 Main St", "city": "Arlington" }
}
```

### RU-based sizing guidance

| Document size | Point read RU | Insert RU | Recommendation                     |
| ------------- | ------------- | --------- | ---------------------------------- |
| < 1 KB        | 1             | ~5        | Optimal for RU efficiency          |
| 1--4 KB       | 1--2          | ~10       | Good                               |
| 4--16 KB      | 2--5          | ~15--30   | Acceptable; monitor RU consumption |
| 16--100 KB    | 5--30         | ~30--100  | Consider splitting or trimming     |
| > 100 KB      | 30+           | 100+      | Strongly consider normalizing      |

For RU-based, keep documents under 16 KB for optimal RU efficiency. Documents approaching the 2 MB limit consume disproportionate RUs.

---

## 3. Partition key selection patterns

Partition key design is covered in detail in the [RU-Based Migration Guide](ru-migration.md). This section provides specific patterns for common MongoDB collection types.

### Pattern: user-centric application

```
Collection: user_profiles    → Partition key: /userId
Collection: user_sessions    → Partition key: /userId
Collection: user_orders      → Partition key: /userId
Collection: user_preferences → Partition key: /userId
```

**Advantage:** All user data co-located. Single-partition queries for user-scoped operations. Transactions across user's orders and preferences possible.

### Pattern: multi-tenant SaaS

```
Collection: tenants   → Partition key: /tenantId
Collection: documents → Partition key: /tenantId
Collection: audit_log → Partition key: /tenantId
```

**Advantage:** Tenant isolation. Per-tenant queries never cross partitions. Can use hierarchical partition key (`/tenantId`, `/userId`) for finer distribution.

### Pattern: event sourcing / time-series

```
Collection: events → Partition key: /entityId
                   → Use TTL for automatic expiration
                   → Use analytical store for time-range queries
```

**Why not partition by date:** Partitioning by date creates hot partitions (today's partition gets all writes). Partition by the entity generating events; use analytical store for time-range analytics.

### Pattern: catalog / reference data

```
Collection: products   → Partition key: /categoryId
Collection: categories → Partition key: /categoryId
```

**Consideration:** If the catalog is small (< 20 GB, < 10,000 RU/s), a synthetic partition key may work: `/id` provides maximum distribution but loses query affinity. For catalogs queried by category, `/categoryId` is better.

---

## 4. Indexing strategy

### vCore indexing (familiar MongoDB approach)

vCore uses standard MongoDB indexing. Migrate your existing indexes directly:

```javascript
// Indexes migrate with mongorestore
// Or create manually:
db.orders.createIndex({ customerId: 1, orderDate: -1 });
db.orders.createIndex({ status: 1 });
db.orders.createIndex({ "items.productId": 1 });
db.orders.createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 }); // 30-day TTL
```

**vCore indexing best practices:**

- Keep the total index count under 64 per collection (MongoDB default limit).
- Use compound indexes for queries that filter and sort on multiple fields.
- Drop unused indexes to reduce write overhead.
- Use `explain()` to validate query plans.

### RU-based indexing policy (declarative approach)

RU-based Cosmos DB uses a JSON indexing policy rather than `createIndex()`. The default policy indexes all properties, which is flexible but expensive on writes.

**Recommended approach: start with "exclude all, include explicitly"**

```json
{
    "indexingMode": "consistent",
    "automatic": true,
    "includedPaths": [],
    "excludedPaths": [{ "path": "/*" }]
}
```

Then add back only the paths your queries need:

```json
{
    "indexingMode": "consistent",
    "automatic": true,
    "includedPaths": [
        { "path": "/customerId/?" },
        { "path": "/orderDate/?" },
        { "path": "/status/?" },
        { "path": "/total/?" },
        { "path": "/items/[]/productId/?" }
    ],
    "excludedPaths": [{ "path": "/*" }],
    "compositeIndexes": [
        [
            { "path": "/customerId", "order": "ascending" },
            { "path": "/orderDate", "order": "descending" }
        ],
        [
            { "path": "/status", "order": "ascending" },
            { "path": "/total", "order": "descending" }
        ]
    ],
    "spatialIndexes": [
        {
            "path": "/location/*",
            "types": ["Point", "Polygon"]
        }
    ]
}
```

### Index type mapping

| MongoDB index type    | RU-based equivalent                             | Notes                                                   |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| Single-field          | Included path with `/?` suffix                  | Auto-indexed by default                                 |
| Compound              | Composite index                                 | Required for ORDER BY on multiple fields                |
| Multikey (array)      | Included path with `/[]`                        | Arrays auto-indexed when path is included               |
| Text                  | Basic text index or Azure AI Search             | For full-text search, integrate Azure AI Search         |
| Geospatial (2dsphere) | Spatial index in policy                         | Supports Point, Polygon, LineString                     |
| Hashed                | Not needed (partition key handles distribution) | Cosmos DB partitioning replaces hash-based distribution |
| Wildcard              | Default policy (include all)                    | Use sparingly; increases write cost                     |
| TTL                   | Container-level TTL policy                      | Set per container, not per index                        |
| Unique                | Unique key policy (set at container creation)   | Must include partition key; immutable after creation    |

---

## 5. TTL configuration

### MongoDB TTL (per-index)

```javascript
// MongoDB: TTL index on a date field
db.sessions.createIndex({ lastAccess: 1 }, { expireAfterSeconds: 3600 });
```

### Cosmos DB vCore TTL

Same syntax as MongoDB. TTL indexes work identically:

```javascript
db.sessions.createIndex({ lastAccess: 1 }, { expireAfterSeconds: 3600 });
```

### Cosmos DB RU-based TTL

RU-based TTL is set at the container level, not per-index. Documents must have a `_ts` (system timestamp) or a custom TTL field.

**Container-level TTL (based on `_ts`):**

```bash
# Set default TTL to 30 days (in seconds)
az cosmosdb mongodb collection update \
  --resource-group rg-data-platform \
  --account-name my-cosmos-account \
  --database-name mydb \
  --name sessions \
  --default-ttl 2592000
```

**Per-document TTL override:**

```json
{
    "_id": "session-789",
    "userId": "user-123",
    "ttl": 3600
}
```

Documents with a `ttl` field set to a positive integer expire that many seconds after their `_ts`. Documents with `ttl: -1` never expire (override container default). Documents without a `ttl` field use the container default.

---

## 6. Schema validation migration

### MongoDB `$jsonSchema` validation

```javascript
db.createCollection("orders", {
    validator: {
        $jsonSchema: {
            bsonType: "object",
            required: ["customerId", "orderDate", "total"],
            properties: {
                customerId: { bsonType: "string" },
                orderDate: { bsonType: "date" },
                total: { bsonType: "decimal", minimum: 0 },
                status: {
                    enum: [
                        "pending",
                        "processing",
                        "shipped",
                        "delivered",
                        "cancelled",
                    ],
                },
            },
        },
    },
    validationLevel: "moderate",
    validationAction: "warn",
});
```

### Cosmos DB vCore

Schema validation using `$jsonSchema` is supported. Migrate your validation rules directly.

### Cosmos DB RU-based

Server-side validation is supported via the `$jsonSchema` validator on container creation. Apply the same validation rules:

```bash
# Set validation via Azure CLI (or Azure Portal)
az cosmosdb mongodb collection create \
  --resource-group rg-data-platform \
  --account-name my-cosmos-account \
  --database-name mydb \
  --name orders \
  --shard "customerId" \
  --throughput 4000
# Then apply validator via mongosh or application code
```

---

## 7. Migration checklist

- [ ] Inventory all collections, document counts, average/max document sizes.
- [ ] Decide vCore or RU-based for each collection (or set of collections).
- [ ] Choose partition key for each container (RU-based) or shard key (vCore).
- [ ] Design indexing policy: list all query patterns, map to index paths.
- [ ] Review embedded vs. referenced relationships. Restructure if documents exceed 16 KB.
- [ ] Configure TTL policies for each container.
- [ ] Migrate schema validation rules (`$jsonSchema`).
- [ ] Create containers with correct partition keys, indexing policies, and TTL settings.
- [ ] Test with representative queries to validate RU consumption and latency.
- [ ] Document partition key decisions (these are permanent for RU-based).

---

## Related resources

- [vCore Migration Guide](vcore-migration.md)
- [RU-Based Migration Guide](ru-migration.md)
- [Data Migration](data-migration.md)
- [Application Migration](application-migration.md)
- [Best Practices](best-practices.md)
- [Migration Playbook](../mongodb-to-cosmosdb.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
