# Data Migration: MongoDB to Cosmos DB

**Audience:** Data engineers, DevOps engineers, and DBAs executing the data transfer from MongoDB (Atlas or self-hosted) to Azure Cosmos DB for MongoDB.

---

## Overview

Data migration is the most operationally intensive phase of a MongoDB-to-Cosmos DB migration. The right tool depends on data volume, acceptable downtime, network connectivity, and whether you need continuous synchronization (CDC) during cutover. This guide covers five migration tools, from simplest to most sophisticated, with decision criteria for each.

---

## 1. Tool selection matrix

| Tool                                | Best for                           | Data volume     | Downtime          | CDC support        | Complexity |
| ----------------------------------- | ---------------------------------- | --------------- | ----------------- | ------------------ | ---------- |
| `mongodump` / `mongorestore`        | Small datasets, dev/test           | < 10 GB         | Minutes--hours    | No                 | Low        |
| Azure DMS (online)                  | Production migrations              | 10 GB -- 1 TB   | Seconds (cutover) | Yes                | Medium     |
| Azure Data Factory                  | Large datasets, scheduled          | 100 GB -- 10 TB | Hours (batch)     | No (polling-based) | Medium     |
| Spark connector (Databricks/Fabric) | Very large, transformations needed | 1 TB+           | Hours             | No                 | High       |
| Cosmos DB data migration tool       | Any size, GUI-driven               | Any             | Varies            | No                 | Low        |

### Decision flowchart

```mermaid
flowchart TD
    Start["Choose migration tool"] --> Q1{"Data volume?"}
    Q1 -->|"< 10 GB"| Q2{"Need zero-downtime?"}
    Q2 -->|No| Dump["mongodump / mongorestore"]
    Q2 -->|Yes| DMS["Azure DMS (online)"]
    Q1 -->|"10 GB - 1 TB"| Q3{"Need zero-downtime?"}
    Q3 -->|Yes| DMS
    Q3 -->|No| Q4{"Need transformations?"}
    Q4 -->|Yes| ADF["Azure Data Factory"]
    Q4 -->|No| DMS
    Q1 -->|"> 1 TB"| Q5{"Need transformations?"}
    Q5 -->|Yes| Spark["Spark connector"]
    Q5 -->|No| Q6{"Network bandwidth?"}
    Q6 -->|"High (ExpressRoute)"| ADF
    Q6 -->|"Limited"| Spark
```

---

## 2. mongodump / mongorestore

The simplest migration path. Suitable for small datasets where downtime is acceptable.

### Prerequisites

- `mongodump` and `mongorestore` version 100.x+ (MongoDB Database Tools).
- Network connectivity from the migration host to both source and target.
- Source: read access. Target: write access.

### Step-by-step

#### Export from source MongoDB

```bash
# Full database export
mongodump \
  --uri="mongodb+srv://admin:pass@source.mongodb.net" \
  --db=mydb \
  --out=/data/migration/dump \
  --gzip \
  --numParallelCollections=4

# Single collection export
mongodump \
  --uri="mongodb+srv://admin:pass@source.mongodb.net" \
  --db=mydb \
  --collection=orders \
  --out=/data/migration/dump \
  --gzip
```

#### Import to Cosmos DB

```bash
# Full database restore to Cosmos DB vCore
mongorestore \
  --uri="mongodb+srv://admin:pass@target.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256" \
  --gzip \
  --numParallelCollections=4 \
  --numInsertionWorkersPerCollection=4 \
  /data/migration/dump

# To Cosmos DB RU-based (with throttle handling)
mongorestore \
  --uri="mongodb://target-account:key@target-account.mongo.cosmos.azure.com:10255/?ssl=true&replicaSet=globaldb&retrywrites=false" \
  --gzip \
  --numParallelCollections=2 \
  --numInsertionWorkersPerCollection=2 \
  --writeConcern="{w:0}" \
  /data/migration/dump
```

!!! warning "RU-based throttling"
When restoring to RU-based Cosmos DB, the restore will hit RU limits and receive 429 (rate limiting) errors. Mitigate by:

    1. Temporarily increasing provisioned throughput to 50,000+ RU/s.
    2. Reducing parallel workers (`--numInsertionWorkersPerCollection=1`).
    3. Using `--writeConcern="{w:0}"` to reduce per-write overhead.
    4. Scaling back down after migration completes.

### Validation

```bash
# Connect to target and verify counts
mongosh "mongodb+srv://admin:pass@target.mongocluster.cosmos.azure.com/?tls=true" --eval '
  const dbs = db.adminCommand({ listDatabases: 1 });
  dbs.databases.forEach(d => {
    const dbRef = db.getSiblingDB(d.name);
    const colls = dbRef.getCollectionNames();
    colls.forEach(c => {
      print(`${d.name}.${c}: ${dbRef.getCollection(c).countDocuments()} documents`);
    });
  });
'
```

### Limitations

- **No CDC** -- point-in-time snapshot only. Writes to the source after dump starts are not captured.
- **Index recreation** -- `mongorestore` attempts to recreate indexes. On RU-based, some index types need manual configuration via indexing policy.
- **Large documents** -- documents exceeding 2 MB will fail on RU-based (16 MB limit on vCore).

---

## 3. Azure Database Migration Service (DMS)

The recommended tool for production migrations requiring minimal downtime. DMS supports online (continuous sync) migration with CDC.

### Prerequisites

- Azure DMS instance provisioned (Premium tier for MongoDB migrations).
- Network connectivity: DMS must reach both source MongoDB and target Cosmos DB.
- Source: MongoDB 3.6+ with replica set or sharded cluster (change streams required for CDC).
- Target: Cosmos DB account provisioned with databases and containers.

### Architecture

```mermaid
flowchart LR
    Source["MongoDB Atlas<br/>or Self-Hosted"] -->|"Initial load<br/>(full copy)"| DMS["Azure DMS<br/>(Premium)"]
    Source -->|"CDC<br/>(change streams)"| DMS
    DMS -->|"Write"| Target["Cosmos DB<br/>for MongoDB"]

    subgraph Cutover["Cutover Window"]
        Stop["Stop source writes"]
        Drain["Wait for DMS<br/>to drain CDC"]
        Switch["Switch connection<br/>strings"]
    end
```

### Step-by-step

#### Create DMS instance

```bash
# Create DMS instance (Premium for MongoDB online migration)
az dms create \
  --resource-group rg-data-platform \
  --name dms-mongo-migration \
  --location eastus \
  --sku-name Premium_4vCores \
  --subnet /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{vnet}/subnets/{subnet}
```

#### Create migration project

```bash
az dms project create \
  --resource-group rg-data-platform \
  --service-name dms-mongo-migration \
  --name mongo-to-cosmosdb \
  --source-platform MongoDB \
  --target-platform AzureDbForMongo
```

#### Configure and start migration task

Use Azure Portal for the guided experience:

1. **Source configuration** -- provide MongoDB connection string, select SSL/TLS settings.
2. **Target configuration** -- provide Cosmos DB connection string (vCore or RU-based).
3. **Select databases and collections** -- choose which databases/collections to migrate.
4. **Collection settings** -- for RU-based, specify partition (shard) key for each collection.
5. **Migration mode** -- select "Online" for continuous sync with CDC.
6. **Start migration** -- DMS begins initial load followed by continuous CDC.

#### Monitor progress

```bash
# Check migration status
az dms project task show \
  --resource-group rg-data-platform \
  --service-name dms-mongo-migration \
  --project-name mongo-to-cosmosdb \
  --name migration-task-1 \
  --expand output
```

Monitor in Azure Portal:

- **Initial load progress** -- percentage complete per collection, documents migrated, elapsed time.
- **CDC lag** -- time between source write and target replication. Should approach zero before cutover.
- **Errors** -- document-level errors (oversized documents, unsupported BSON types, partition key violations).

#### Cutover

1. **Verify CDC lag is near zero** -- all source changes are replicated.
2. **Stop application writes to source** -- redirect traffic or set source to read-only.
3. **Wait for final CDC drain** -- DMS processes remaining changes (typically seconds).
4. **Complete cutover in DMS** -- marks migration as complete.
5. **Switch application connection strings** to Cosmos DB.
6. **Validate** -- run smoke tests, check document counts, verify query results.

### DMS limitations

- **MongoDB version** -- source must be 3.6+ (change streams required for online migration).
- **Capped collections** -- not supported for online migration (no change stream on capped collections).
- **Unique index conflicts** -- if the target has unique key constraints that the source data violates, DMS will report errors.
- **RU throttling** -- DMS will retry on 429 errors but migration may slow. Increase provisioned throughput during migration.
- **Network** -- DMS must be in a VNet that can reach both source and target. For Atlas, use VNet peering or private endpoint.

---

## 4. Azure Data Factory (ADF)

ADF provides a scalable, scheduled data migration pipeline. Best for large datasets where you need transformation during migration or want to integrate with the csa-inabox ADF patterns.

### Pipeline design

```mermaid
flowchart LR
    Source["MongoDB<br/>Linked Service"] --> Copy["Copy Activity<br/>(parallel partitions)"]
    Copy --> Target["Cosmos DB<br/>Linked Service"]
    Copy --> Log["Logging<br/>(Log Analytics)"]

    subgraph Orchestration
        Trigger["Schedule Trigger<br/>(or manual)"] --> ForEach["ForEach Collection"]
        ForEach --> Copy
    end
```

### Linked service configuration

**Source (MongoDB Atlas):**

```json
{
    "name": "MongoDbAtlas",
    "type": "MongoDbAtlasLinkedService",
    "typeProperties": {
        "connectionString": {
            "type": "AzureKeyVaultSecret",
            "store": {
                "referenceName": "KeyVault",
                "type": "LinkedServiceReference"
            },
            "secretName": "mongodb-atlas-connection-string"
        },
        "database": "mydb"
    }
}
```

**Target (Cosmos DB for MongoDB):**

```json
{
    "name": "CosmosDbMongo",
    "type": "CosmosDbMongoDbApiLinkedService",
    "typeProperties": {
        "connectionString": {
            "type": "AzureKeyVaultSecret",
            "store": {
                "referenceName": "KeyVault",
                "type": "LinkedServiceReference"
            },
            "secretName": "cosmosdb-connection-string"
        },
        "database": "mydb"
    }
}
```

### Copy activity configuration

```json
{
    "name": "CopyOrders",
    "type": "Copy",
    "inputs": [
        {
            "referenceName": "MongoDbOrders",
            "type": "DatasetReference"
        }
    ],
    "outputs": [
        {
            "referenceName": "CosmosDbOrders",
            "type": "DatasetReference"
        }
    ],
    "typeProperties": {
        "source": {
            "type": "MongoDbAtlasSource",
            "batchSize": 1000
        },
        "sink": {
            "type": "CosmosDbMongoDbApiSink",
            "writeBatchSize": 500,
            "writeBehavior": "upsert"
        },
        "parallelCopies": 8,
        "dataIntegrationUnits": 32
    }
}
```

### ADF advantages

- **Scheduling** -- cron-based triggers for incremental loads.
- **Transformation** -- data flows can transform documents during migration (rename fields, flatten structures, compute derived values).
- **Monitoring** -- Azure Monitor integration with pipeline run history, error tracking.
- **CSA-in-a-Box alignment** -- follows the ADF patterns in `domains/shared/pipelines/adf/`.

### ADF limitations

- **No real-time CDC** -- ADF is batch-oriented. For online migration with continuous sync, use DMS.
- **RU management** -- large batch writes can exhaust RU budget. Use retry policies and throttle batch size.
- **Cost** -- data movement charged per DIU-hour. Large migrations can be expensive at high parallelism.

---

## 5. Spark connector (Databricks / Fabric)

For very large datasets (1 TB+) or migrations that require complex transformations, the MongoDB Spark connector provides the most scalable option.

### Architecture

```mermaid
flowchart LR
    Source["MongoDB Atlas"] -->|Spark Connector| Cluster["Databricks or<br/>Fabric Spark"]
    Cluster -->|Cosmos DB<br/>Spark Connector| Target["Cosmos DB"]
```

### Databricks notebook example

```python
# Read from MongoDB
mongo_df = spark.read \
    .format("mongodb") \
    .option("connection.uri", dbutils.secrets.get("kv-migration", "mongodb-uri")) \
    .option("database", "mydb") \
    .option("collection", "orders") \
    .option("partitioner", "MongoSamplePartitioner") \
    .option("partitionerOptions.partitionSizeMB", "64") \
    .load()

print(f"Source document count: {mongo_df.count()}")

# Optional: transformations
from pyspark.sql.functions import col, to_date

transformed_df = mongo_df \
    .withColumn("orderDate", to_date(col("orderDate"))) \
    .drop("_class")  # Remove Spring Data MongoDB metadata

# Write to Cosmos DB (vCore via MongoDB connector)
transformed_df.write \
    .format("mongodb") \
    .option("connection.uri", dbutils.secrets.get("kv-migration", "cosmosdb-vcore-uri")) \
    .option("database", "mydb") \
    .option("collection", "orders") \
    .mode("append") \
    .save()

# Or write to Cosmos DB (RU-based via Cosmos DB Spark connector)
transformed_df.write \
    .format("cosmos.oltp") \
    .option("spark.cosmos.accountEndpoint", cosmos_endpoint) \
    .option("spark.cosmos.accountKey", cosmos_key) \
    .option("spark.cosmos.database", "mydb") \
    .option("spark.cosmos.container", "orders") \
    .option("spark.cosmos.write.strategy", "ItemOverwrite") \
    .option("spark.cosmos.write.bulk.enabled", "true") \
    .option("spark.cosmos.write.maxRetryCount", "10") \
    .mode("append") \
    .save()
```

### Spark advantages

- **Scalability** -- processes terabytes in parallel across cluster nodes.
- **Transformations** -- full Spark SQL and DataFrame API for complex transformations.
- **Partitioned reads** -- MongoDB Spark connector partitions reads across multiple ranges for parallelism.
- **Integration** -- Databricks connects to both MongoDB and Cosmos DB natively.

### Spark considerations

- **Cluster cost** -- a 4-node Databricks cluster with Standard_D8s_v5 costs ~$8/hour. Budget for migration runtime.
- **No CDC** -- batch-only. Use DMS for continuous sync during cutover.
- **Cosmos DB RU saturation** -- bulk writes from Spark can easily exhaust RU budget. Set `spark.cosmos.write.bulk.maxPendingOperations` to control write rate.

---

## 6. Azure Cosmos DB data migration tool

A lightweight, cross-platform desktop tool for migrating data into Cosmos DB. Supports JSON, CSV, MongoDB, and SQL Server sources.

### Installation

Download from the [Azure Cosmos DB Data Migration Tool GitHub releases](https://github.com/AzureCosmosDB/data-migration-desktop-tool).

### Usage

```bash
# JSON export from MongoDB, then import to Cosmos DB
mongoexport --uri="mongodb+srv://..." --db=mydb --collection=orders --out=orders.json --jsonArray

# Import using data migration tool
dmt --source json --source-connection "FilePath=orders.json" \
    --target cosmos-mongo --target-connection "AccountEndpoint=..." \
    --target-options "Database=mydb;Collection=orders"
```

### Best for

- Quick one-time migrations of individual collections.
- Non-technical users who prefer a GUI.
- Validating data format compatibility before running DMS.

---

## 7. Post-migration validation

### Document count verification

```javascript
// Compare source and target counts
const sourceCount = sourceDb.orders.countDocuments();
const targetCount = targetDb.orders.countDocuments();
console.log(
    `Source: ${sourceCount}, Target: ${targetCount}, Delta: ${sourceCount - targetCount}`,
);
```

### Data integrity checks

```javascript
// Sample-based comparison (random 100 documents)
const sampleIds = sourceDb.orders
    .aggregate([{ $sample: { size: 100 } }, { $project: { _id: 1 } }])
    .map((d) => d._id);

let mismatches = 0;
sampleIds.forEach((id) => {
    const sourceDoc = sourceDb.orders.findOne({ _id: id });
    const targetDoc = targetDb.orders.findOne({ _id: id });
    if (JSON.stringify(sourceDoc) !== JSON.stringify(targetDoc)) {
        mismatches++;
        print(`Mismatch: ${id}`);
    }
});
print(`Sample validation: ${100 - mismatches}/100 match`);
```

### Index verification

```javascript
// List indexes on target
targetDb.orders.getIndexes().forEach((idx) => {
    print(`Index: ${idx.name}, Keys: ${JSON.stringify(idx.key)}`);
});
```

### Query performance validation

Run your top-10 most frequent queries against the target and compare latency with the source. For RU-based, note the RU charge per query (available in the response headers or via `explain()`).

---

## 8. Migration checklist

- [ ] Chose migration tool based on data volume, downtime tolerance, and CDC needs.
- [ ] Provisioned target Cosmos DB with correct partition keys, indexing policies, and throughput.
- [ ] Tested migration with a single small collection before running full migration.
- [ ] Temporarily increased RU/s on target (RU-based) to handle migration write load.
- [ ] Executed migration and monitored for errors (429s, document size violations, unique key conflicts).
- [ ] Validated document counts match between source and target.
- [ ] Validated data integrity with sample-based comparison.
- [ ] Validated indexes are present on target.
- [ ] Validated top queries return correct results with acceptable latency.
- [ ] Scaled RU/s back to operational level after migration.
- [ ] Documented migration duration, data volume transferred, and any issues encountered.

---

## Related resources

- [vCore Migration Guide](vcore-migration.md)
- [RU-Based Migration Guide](ru-migration.md)
- [Schema Migration](schema-migration.md)
- [Application Migration](application-migration.md)
- [Tutorial: DMS Online Migration](tutorial-dms-migration.md)
- [Migration Playbook](../mongodb-to-cosmosdb.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
