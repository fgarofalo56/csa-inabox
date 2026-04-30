# Complete Feature Mapping: MongoDB to Azure Cosmos DB

**Audience:** CTO, Platform Architects, Data Engineers evaluating feature-by-feature parity between MongoDB and Azure Cosmos DB for MongoDB.

---

## How to read this document

Each table maps a MongoDB feature to its Cosmos DB equivalent across both deployment models (vCore and RU-based). The **Effort** column indicates migration complexity:

- **XS** -- no code changes; configuration-only
- **S** -- minor code changes; connection string or config update
- **M** -- moderate code changes; query or schema refactoring
- **L** -- significant refactoring; architectural changes
- **N/A** -- no equivalent; feature must be replaced or dropped

The **Parity** column rates compatibility:

- **Full** -- feature works identically or near-identically
- **Partial** -- feature works with some limitations
- **Alternative** -- different approach achieves the same outcome
- **Gap** -- no direct equivalent

---

## 1. Cluster architecture and availability

| #   | MongoDB feature                               | Cosmos DB vCore                            | Cosmos DB RU-based                                          | Parity  | Effort | Notes                                                       |
| --- | --------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- | ------- | ------ | ----------------------------------------------------------- |
| 1   | Replica set (3-node)                          | HA cluster with automatic failover         | Multi-region replication with automatic failover            | Full    | XS     | Both provide automatic HA                                   |
| 2   | Arbiter nodes                                 | Not needed (HA built-in)                   | Not applicable                                              | Full    | XS     | Cosmos DB handles quorum internally                         |
| 3   | Read preference (primary, secondary, nearest) | Primary reads; HA replica for read scaling | Multi-region reads with configurable consistency            | Full    | S      | Connection string read preference maps to consistency level |
| 4   | Write concern (w:majority, w:1)               | Durable writes by default                  | Configurable via consistency levels                         | Full    | S      | Session consistency is the recommended default              |
| 5   | Sharded cluster                               | Built-in sharding (shard key selection)    | Physical partitions (partition key selection)               | Full    | M      | RU partition key is immutable; choose carefully             |
| 6   | Config servers                                | Not needed (managed)                       | Not applicable                                              | Full    | XS     | Metadata management is transparent                          |
| 7   | Mongos router                                 | Not needed (managed routing)               | Not applicable (gateway handles routing)                    | Full    | XS     | Connection string handles routing                           |
| 8   | Rolling upgrades                              | Managed by Azure                           | Managed by Azure (transparent)                              | Full    | XS     | No operational involvement required                         |
| 9   | Connection pooling                            | Driver-managed                             | Driver-managed + gateway mode (optional)                    | Full    | XS     | Use gateway mode for large connection counts on RU          |
| 10  | Zone-based sharding (Atlas Global Clusters)   | Not supported (single region)              | Multi-region with preferred regions per partition key range | Partial | M      | RU-based handles this natively; vCore is single-region      |

---

## 2. Data model and schema

| #   | MongoDB feature              | Cosmos DB vCore                                  | Cosmos DB RU-based                                                 | Parity      | Effort | Notes                                                                        |
| --- | ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | ----------- | ------ | ---------------------------------------------------------------------------- |
| 11  | Flexible schema (schemaless) | Full support                                     | Full support                                                       | Full        | XS     | Document model preserved exactly                                             |
| 12  | Embedded documents           | Full support                                     | Full support                                                       | Full        | XS     | No changes needed                                                            |
| 13  | Arrays and nested arrays     | Full support                                     | Full support                                                       | Full        | XS     | No changes needed                                                            |
| 14  | `$jsonSchema` validation     | Supported                                        | Supported (server-side validation)                                 | Full        | XS     | Validation rules migrate directly                                            |
| 15  | Capped collections           | Supported                                        | Not supported (use TTL + change feed)                              | Alternative | M      | Replace with TTL index on timestamp field                                    |
| 16  | Time-series collections      | Not supported natively (use regular collections) | Not supported natively                                             | Gap         | M      | Use regular collections with TTL; or use Azure Data Explorer for time-series |
| 17  | Document size limit          | 16 MB                                            | vCore: 16 MB; RU: 2 MB (16 MB with large document support preview) | Partial     | M      | Documents > 2 MB on RU may need restructuring                                |
| 18  | `ObjectId` generation        | Supported                                        | Supported (`_id` auto-generation)                                  | Full        | XS     | No changes needed                                                            |
| 19  | Binary data (BSON types)     | Full BSON support                                | Full BSON support                                                  | Full        | XS     | All BSON types preserved                                                     |
| 20  | Decimal128                   | Supported                                        | Supported                                                          | Full        | XS     | Financial precision preserved                                                |

---

## 3. Indexing

| #   | MongoDB feature                         | Cosmos DB vCore | Cosmos DB RU-based                                      | Parity  | Effort | Notes                                                                                |
| --- | --------------------------------------- | --------------- | ------------------------------------------------------- | ------- | ------ | ------------------------------------------------------------------------------------ |
| 21  | Single-field index                      | Supported       | Supported (or automatic via indexing policy)            | Full    | XS     | RU indexes all properties by default                                                 |
| 22  | Compound index                          | Supported       | Supported (composite index in indexing policy)          | Full    | S      | RU composite indexes defined in policy, not `createIndex`                            |
| 23  | Multikey index (arrays)                 | Supported       | Supported (automatic for arrays)                        | Full    | XS     | No changes needed                                                                    |
| 24  | Text index                              | Supported       | Supported (basic text search)                           | Full    | XS     | For advanced search, use Azure AI Search                                             |
| 25  | Geospatial index (2dsphere)             | Supported       | Supported (spatial index in policy)                     | Full    | S      | 2d index also supported                                                              |
| 26  | Hashed index                            | Supported       | Supported                                               | Full    | XS     | Used for equality queries                                                            |
| 27  | Wildcard index                          | Supported       | Automatic (default indexing policy indexes all paths)   | Full    | XS     | RU approach is "index everything" by default                                         |
| 28  | TTL index                               | Supported       | Supported (TTL policy per container)                    | Full    | XS     | RU TTL set at container level, not per-index                                         |
| 29  | Unique index                            | Supported       | Supported (unique key policy, set at creation)          | Partial | M      | RU unique keys must include partition key and are immutable after container creation |
| 30  | Partial index (partialFilterExpression) | Supported       | Not supported                                           | Partial | M      | vCore supports; RU requires workaround (use indexing policy with excluded paths)     |
| 31  | Sparse index                            | Supported       | Handled via indexing policy (exclude null)              | Partial | S      | Behavior preserved through policy configuration                                      |
| 32  | Background index builds                 | Supported       | Automatic (non-blocking on RU)                          | Full    | XS     | vCore supports background builds; RU indexing is always non-blocking                 |
| 33  | Index intersection                      | Supported       | RU uses single index per query (optimizer selects best) | Partial | S      | May need compound index instead of relying on intersection                           |

---

## 4. Query and aggregation

| #   | MongoDB feature                         | Cosmos DB vCore                           | Cosmos DB RU-based                                               | Parity      | Effort | Notes                                                                                        |
| --- | --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- | ----------- | ------ | -------------------------------------------------------------------------------------------- |
| 34  | `find()` with filter                    | Full support                              | Full support                                                     | Full        | XS     | Core query path preserved                                                                    |
| 35  | Projection                              | Supported                                 | Supported                                                        | Full        | XS     | No changes                                                                                   |
| 36  | Sort                                    | Supported                                 | Supported (compound index may be needed)                         | Full        | S      | RU may need composite index for multi-field sort                                             |
| 37  | `$match`                                | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 38  | `$group`                                | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 39  | `$project` / `$addFields`               | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 40  | `$unwind`                               | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 41  | `$lookup` (joins)                       | Supported                                 | Supported (within same database, same partition key recommended) | Partial     | M      | RU `$lookup` works but cross-partition lookups are expensive                                 |
| 42  | `$graphLookup`                          | Supported                                 | Not supported                                                    | Gap         | L      | vCore supports; RU requires application-level graph traversal or Azure Cosmos DB for Gremlin |
| 43  | `$merge` (to same DB)                   | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 44  | `$merge` (to different DB)              | Supported                                 | Not supported                                                    | Gap         | M      | RU requires application-level copy or change feed                                            |
| 45  | `$out`                                  | Supported                                 | Supported (same database)                                        | Partial     | S      |                                                                                              |
| 46  | `$facet`                                | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 47  | `$bucket` / `$bucketAuto`               | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 48  | `$sample`                               | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 49  | `$unionWith`                            | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 50  | `$setWindowFields`                      | Supported                                 | Supported (MongoDB 5.0+ API)                                     | Full        | XS     |                                                                                              |
| 51  | `$densify`                              | Supported                                 | Supported (MongoDB 5.1+ API)                                     | Full        | XS     |                                                                                              |
| 52  | `$fill`                                 | Supported                                 | Supported (MongoDB 5.3+ API)                                     | Full        | XS     |                                                                                              |
| 53  | Map-reduce                              | Deprecated in MongoDB; supported in vCore | Not supported (deprecated)                                       | Alternative | M      | Rewrite as aggregation pipeline; MongoDB also deprecates map-reduce                          |
| 54  | `$where` (JavaScript execution)         | Supported (with security caveats)         | Not supported                                                    | Gap         | M      | Rewrite as aggregation expressions                                                           |
| 55  | `$expr`                                 | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 56  | `$regex` queries                        | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 57  | Cursor methods (skip, limit, batchSize) | Supported                                 | Supported                                                        | Full        | XS     |                                                                                              |
| 58  | `explain()`                             | Supported                                 | Supported                                                        | Full        | XS     | Output format differs slightly on RU                                                         |

---

## 5. Transactions

| #   | MongoDB feature                          | Cosmos DB vCore                       | Cosmos DB RU-based                            | Parity  | Effort | Notes                                                                           |
| --- | ---------------------------------------- | ------------------------------------- | --------------------------------------------- | ------- | ------ | ------------------------------------------------------------------------------- |
| 59  | Single-document atomicity                | Full ACID                             | Full ACID                                     | Full    | XS     | Guaranteed on both                                                              |
| 60  | Multi-document transactions              | Supported (within replica set)        | Supported (within same logical partition key) | Partial | M      | RU transactions scoped to partition; cross-partition transactions not supported |
| 61  | Distributed transactions (across shards) | Supported                             | Not supported (cross-partition)               | Gap     | L      | Redesign to scope transactions within partition key                             |
| 62  | Read concern levels                      | Supported (local, majority, snapshot) | Mapped to consistency levels                  | Full    | S      | Session consistency covers most use cases                                       |
| 63  | Write concern levels                     | Supported (w:1, w:majority)           | Durable by default (equivalent to w:majority) | Full    | XS     | No configuration needed                                                         |
| 64  | Causal consistency                       | Supported                             | Supported (session consistency)               | Full    | XS     | Session consistency provides causal guarantees                                  |

---

## 6. Change data capture and eventing

| #   | MongoDB feature               | Cosmos DB vCore                                    | Cosmos DB RU-based                                                           | Parity      | Effort | Notes                                                      |
| --- | ----------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- | ----------- | ------ | ---------------------------------------------------------- |
| 65  | Change streams                | Supported (collection, database, deployment level) | Change feed (container level)                                                | Full        | S      | Change feed is push-based; integrates with Azure Functions |
| 66  | Resume tokens                 | Supported                                          | Continuation tokens (similar semantics)                                      | Full        | S      | Change feed processor handles checkpointing automatically  |
| 67  | Pre-image and post-image      | Supported (MongoDB 6.0+)                           | Change feed provides full document (post-image); pre-image via separate read | Partial     | M      | Pre-image support depends on change feed mode              |
| 68  | `$changeStream` aggregation   | Supported                                          | Not applicable (use change feed processor or Azure Functions trigger)        | Alternative | M      | Different API but same outcome                             |
| 69  | Oplog tailing                 | Supported                                          | Not applicable (change feed replaces oplog)                                  | Alternative | M      | Change feed is the recommended pattern                     |
| 70  | Database-level change streams | Supported                                          | Container-level only (one feed per container)                                | Partial     | S      | Monitor multiple containers with multiple processors       |

---

## 7. Security and authentication

| #   | MongoDB feature                  | Cosmos DB vCore                         | Cosmos DB RU-based                                    | Parity      | Effort | Notes                                                                                 |
| --- | -------------------------------- | --------------------------------------- | ----------------------------------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------- |
| 71  | SCRAM-SHA-256 authentication     | Supported                               | Supported (primary key or Entra ID)                   | Full        | XS     | Connection string authentication preserved                                            |
| 72  | x.509 certificate authentication | Supported                               | Not supported (use Entra ID)                          | Alternative | M      | Entra ID provides stronger identity assurance                                         |
| 73  | LDAP authentication              | Not supported (use Entra ID)            | Not supported (use Entra ID)                          | Alternative | M      | Entra ID replaces LDAP for cloud-native                                               |
| 74  | Kerberos authentication          | Not supported                           | Not supported                                         | Alternative | M      | Use Entra ID                                                                          |
| 75  | Role-based access control (RBAC) | MongoDB built-in roles                  | Azure RBAC + Entra ID                                 | Full        | M      | Migrate MongoDB roles to Azure RBAC definitions                                       |
| 76  | Field-level encryption (CSFLE)   | Client-side encryption (driver support) | Client-side encryption or Azure Key Vault integration | Partial     | M      | Cosmos DB does not support automatic CSFLE; use manual encryption or Always Encrypted |
| 77  | Encryption at rest               | Supported (Azure-managed or CMK)        | Supported (service-managed or CMK via Key Vault)      | Full        | XS     | CMK available on both models                                                          |
| 78  | Encryption in transit (TLS)      | TLS 1.2+ required                       | TLS 1.2+ required                                     | Full        | XS     | No changes needed                                                                     |
| 79  | Audit logging                    | Supported (diagnostic logs)             | Azure Monitor diagnostic logs                         | Full        | S      | Configure diagnostic settings to Log Analytics                                        |
| 80  | IP allowlist / network ACL       | Supported (firewall rules)              | Supported (firewall rules + Private Link)             | Full        | XS     |                                                                                       |

---

## 8. Backup and disaster recovery

| #   | MongoDB feature              | Cosmos DB vCore              | Cosmos DB RU-based                                                 | Parity | Effort | Notes                                                   |
| --- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------ | ------ | ------ | ------------------------------------------------------- |
| 81  | Continuous backup            | Supported (35-day retention) | Supported (PITR with configurable retention, 1-second granularity) | Full   | XS     | RU continuous backup is more granular than Atlas        |
| 82  | Snapshot backup              | Supported                    | Periodic backup (free, 2 copies, 8-hour or 24-hour interval)       | Full   | XS     |                                                         |
| 83  | Point-in-time restore        | Supported                    | Supported (continuous mode)                                        | Full   | XS     |                                                         |
| 84  | Cross-region backup          | Geo-redundant backup         | Geo-redundant backup (configurable)                                | Full   | XS     |                                                         |
| 85  | `mongodump` / `mongorestore` | Supported                    | Supported for data export/import                                   | Full   | XS     | Useful for migration; not recommended as primary backup |

---

## 9. Search and analytics

| #   | MongoDB feature             | Cosmos DB vCore                    | Cosmos DB RU-based                                                   | Parity             | Effort | Notes                                                       |
| --- | --------------------------- | ---------------------------------- | -------------------------------------------------------------------- | ------------------ | ------ | ----------------------------------------------------------- |
| 86  | Atlas Search (Lucene-based) | Native text search + vector search | Basic text search; Azure AI Search for full-text + vector + semantic | Alternative        | M      | vCore has built-in search; RU pairs with Azure AI Search    |
| 87  | Atlas Vector Search         | Native vector search (HNSW, IVF)   | Azure AI Search vector capabilities                                  | Full               | M      | vCore: co-located vectors; RU: external search service      |
| 88  | Atlas Data Federation       | Not applicable                     | Analytical store + Synapse Link + Fabric                             | Alternative        | M      | Cosmos DB analytical store replaces data federation         |
| 89  | Atlas Online Archive        | Not applicable                     | Analytical store (cold data analytics) + TTL                         | Alternative        | M      | Analytical store provides analytics; TTL handles expiration |
| 90  | Atlas Charts                | Power BI (Direct Lake or import)   | Power BI with Cosmos DB connector                                    | Alternative        | M      | Power BI is the enterprise BI standard on Azure             |
| 91  | Analytical store            | Not applicable                     | Column-oriented HTAP layer, auto-synced                              | N/A (RU advantage) | XS     | Zero-ETL analytics; unique to RU-based                      |

---

## 10. Drivers and tools

| #   | MongoDB feature                                       | Cosmos DB vCore                      | Cosmos DB RU-based                                           | Parity      | Effort | Notes                                   |
| --- | ----------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ | ----------- | ------ | --------------------------------------- |
| 92  | MongoDB drivers (Node.js, Python, Java, C#, Go, etc.) | Supported (wire-protocol compatible) | Supported (wire-protocol compatible, API version selectable) | Full        | XS     | Connection string swap for most drivers |
| 93  | Mongoose (Node.js ODM)                                | Supported                            | Supported                                                    | Full        | XS     | Set `autoIndex: false` on RU-based      |
| 94  | Spring Data MongoDB                                   | Supported                            | Supported                                                    | Full        | XS     | Update connection string                |
| 95  | MongoDB Compass                                       | Supported                            | Supported (connect via MongoDB URI)                          | Full        | XS     |                                         |
| 96  | `mongosh`                                             | Supported                            | Supported                                                    | Full        | XS     |                                         |
| 97  | `mongodump` / `mongorestore`                          | Supported                            | Supported                                                    | Full        | XS     |                                         |
| 98  | `mongoexport` / `mongoimport`                         | Supported                            | Supported                                                    | Full        | XS     |                                         |
| 99  | MongoDB Connector for BI (ODBC)                       | Not supported                        | Not supported (use Cosmos DB ODBC or Power BI connector)     | Alternative | M      | Power BI connector is preferred         |

---

## 11. Administration and operations

| #   | MongoDB feature                        | Cosmos DB vCore                                 | Cosmos DB RU-based                                           | Parity      | Effort | Notes                                       |
| --- | -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ | ----------- | ------ | ------------------------------------------- |
| 100 | Atlas Performance Advisor              | Azure Monitor metrics + query insights          | Azure Monitor + diagnostic logs + query performance insights | Alternative | S      | Azure Monitor provides equivalent insights  |
| 101 | Atlas Profiler                         | Query diagnostics via Azure Portal              | Query stats via diagnostic settings                          | Alternative | S      |                                             |
| 102 | Atlas Alerts                           | Azure Monitor alerts + Action Groups            | Azure Monitor alerts + Action Groups                         | Full        | S      | More flexible alerting with Action Groups   |
| 103 | Atlas Organization / Project hierarchy | Azure Resource Groups + Subscriptions           | Azure Resource Groups + Subscriptions                        | Alternative | M      | Map Atlas Projects to Azure Resource Groups |
| 104 | Atlas CLI (`atlas`)                    | Azure CLI (`az cosmosdb`)                       | Azure CLI (`az cosmosdb`)                                    | Full        | S      | Different CLI syntax; same capabilities     |
| 105 | Atlas Terraform provider               | Azure Terraform provider (`azurerm_cosmosdb_*`) | Azure Terraform provider                                     | Full        | M      | Rewrite Terraform resources                 |
| 106 | Atlas Kubernetes Operator              | Azure Service Operator                          | Azure Service Operator (ASO)                                 | Full        | M      | Rewrite K8s manifests                       |

---

## 12. Application services (Atlas-specific)

| #   | MongoDB feature            | Cosmos DB vCore                       | Cosmos DB RU-based                    | Parity      | Effort | Notes                                                   |
| --- | -------------------------- | ------------------------------------- | ------------------------------------- | ----------- | ------ | ------------------------------------------------------- |
| 107 | Atlas App Services (Realm) | No equivalent                         | No equivalent                         | Gap         | L      | Use Azure Mobile Apps or custom backend                 |
| 108 | Atlas Device Sync          | No equivalent                         | No equivalent                         | Gap         | L      | Use custom sync via change feed + Azure SignalR         |
| 109 | Atlas Triggers             | Azure Functions (change feed trigger) | Azure Functions (change feed trigger) | Alternative | M      | Azure Functions provides same trigger semantics         |
| 110 | Atlas GraphQL API          | No built-in GraphQL                   | No built-in GraphQL                   | Gap         | M      | Use Azure API Management + HotChocolate/Apollo          |
| 111 | Atlas Data API (REST)      | No built-in REST API                  | No built-in REST API                  | Gap         | M      | Use Data API Builder or custom Azure Functions REST API |

---

## Summary statistics

| Category                   | Full parity  | Partial parity | Alternative approach | Gap        |
| -------------------------- | ------------ | -------------- | -------------------- | ---------- |
| Cluster architecture (10)  | 8            | 2              | 0                    | 0          |
| Data model (10)            | 8            | 1              | 0                    | 1          |
| Indexing (13)              | 9            | 3              | 0                    | 1          |
| Query and aggregation (25) | 21           | 1              | 1                    | 2          |
| Transactions (6)           | 4            | 1              | 0                    | 1          |
| Change data capture (6)    | 2            | 2              | 2                    | 0          |
| Security (10)              | 5            | 1              | 4                    | 0          |
| Backup and DR (5)          | 5            | 0              | 0                    | 0          |
| Search and analytics (6)   | 1            | 0              | 4                    | 1          |
| Drivers and tools (8)      | 7            | 0              | 1                    | 0          |
| Administration (7)         | 3            | 0              | 4                    | 0          |
| Application services (5)   | 0            | 0              | 2                    | 3          |
| **Total (111)**            | **73 (66%)** | **11 (10%)**   | **18 (16%)**         | **9 (8%)** |

**Bottom line:** 76% of MongoDB features map directly or with minor changes to Cosmos DB. The 8% gap is concentrated in Atlas Application Services (Realm, Device Sync, GraphQL, Data API) -- features that are MongoDB's proprietary platform play, not core database capabilities. For organizations that do not use Atlas App Services, the compatibility story is 83% full parity.

---

## Related resources

- [Why Cosmos DB over MongoDB](why-cosmosdb-over-mongodb.md)
- [vCore Migration Guide](vcore-migration.md)
- [RU-Based Migration Guide](ru-migration.md)
- [Application Migration](application-migration.md)
- [Schema Migration](schema-migration.md)
- [Migration Playbook](../mongodb-to-cosmosdb.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
