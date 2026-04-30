# Tutorial: Online Migration with Azure Database Migration Service

**Duration:** 4--8 hours (depending on data volume)
**Prerequisites:** Azure subscription, Azure DMS Premium instance, source MongoDB 3.6+, target Cosmos DB account provisioned
**Outcome:** Online migration with continuous change data capture (CDC) from MongoDB to Cosmos DB, with minimal-downtime cutover.

---

## Overview

Azure Database Migration Service (DMS) provides online migration capability that continuously replicates changes from the source MongoDB to the target Cosmos DB. This enables near-zero-downtime cutovers -- the application switches from MongoDB to Cosmos DB while DMS handles the final data synchronization. This tutorial covers the complete workflow: prerequisites, DMS provisioning, source and target configuration, migration execution, monitoring, and cutover.

---

## Step 1: Verify prerequisites

### 1.1 Source MongoDB requirements

- **Version:** MongoDB 3.6 or later (change streams required for online CDC).
- **Deployment:** Replica set or sharded cluster (standalone instances do not support change streams).
- **Access:** User with `read` permission on source databases and `readAnyDatabase` on `admin` database.
- **Network:** DMS must be able to reach the MongoDB instance (public endpoint, VNet peering, or ExpressRoute).

Verify source configuration:

```bash
# Check MongoDB version
mongosh --uri="mongodb+srv://admin:pass@source.mongodb.net" --eval "db.version()"

# Check replica set status
mongosh --uri="mongodb+srv://admin:pass@source.mongodb.net" --eval "rs.status().set"

# Verify change stream support
mongosh --uri="mongodb+srv://admin:pass@source.mongodb.net" --eval '
  const cs = db.getSiblingDB("admin").watch();
  print("Change streams supported: true");
  cs.close();
'
```

### 1.2 Target Cosmos DB requirements

- **Account provisioned:** Cosmos DB for MongoDB (vCore or RU-based).
- **Databases created:** Target databases should exist.
- **Containers created (RU-based):** Containers with partition keys must be pre-created.
- **Throughput:** Set high enough for migration load (temporarily increase for duration of migration).

### 1.3 Network requirements

- DMS must have network connectivity to both source and target.
- For Atlas: add the DMS subnet's IP range to Atlas IP Access List, or configure VNet peering.
- For self-hosted MongoDB: ensure firewall allows DMS subnet access on port 27017.
- For Cosmos DB: ensure firewall allows DMS subnet or use Private Endpoint.

---

## Step 2: Provision Azure DMS

### 2.1 Create DMS instance

```bash
# Create resource group (if not exists)
az group create --name rg-dms-migration --location eastus

# Create VNet for DMS (DMS Premium requires a subnet)
az network vnet create \
  --resource-group rg-dms-migration \
  --name vnet-dms \
  --address-prefix 10.10.0.0/16

az network vnet subnet create \
  --resource-group rg-dms-migration \
  --vnet-name vnet-dms \
  --name subnet-dms \
  --address-prefix 10.10.1.0/24 \
  --delegations Microsoft.DataMigration/sqlMigrationServices

# Create DMS instance (Premium required for MongoDB online migration)
az dms create \
  --resource-group rg-dms-migration \
  --name dms-mongo-to-cosmos \
  --location eastus \
  --sku-name Premium_4vCores \
  --subnet "/subscriptions/{subscription-id}/resourceGroups/rg-dms-migration/providers/Microsoft.Network/virtualNetworks/vnet-dms/subnets/subnet-dms"
```

### 2.2 Verify DMS status

```bash
az dms show \
  --resource-group rg-dms-migration \
  --name dms-mongo-to-cosmos \
  --query "{name:name, status:provisioningState, sku:sku.name}"
```

Expected output:

```json
{
    "name": "dms-mongo-to-cosmos",
    "status": "Succeeded",
    "sku": "Premium_4vCores"
}
```

---

## Step 3: Create migration project

### 3.1 Create project via Azure Portal

1. Navigate to the DMS instance in Azure Portal.
2. Click **+ New Migration Project**.
3. Configure:

    | Setting            | Value                         |
    | ------------------ | ----------------------------- |
    | Project name       | `mongo-to-cosmosdb-migration` |
    | Source server type | MongoDB                       |
    | Target server type | Azure Cosmos DB for MongoDB   |
    | Activity type      | **Online data migration**     |

4. Click **Create and run activity**.

### 3.2 Configure source connection

| Setting           | Value                                         |
| ----------------- | --------------------------------------------- |
| Mode              | Standard (connection string)                  |
| Connection string | `mongodb+srv://admin:pass@source.mongodb.net` |
| SSL               | Required (for Atlas)                          |

Click **Verify** to test the connection.

### 3.3 Configure target connection

**For Cosmos DB vCore:**

| Setting           | Value                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Connection string | `mongodb+srv://admin:pass@target.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256` |
| SSL               | Required                                                                                              |

**For Cosmos DB RU-based:**

| Setting           | Value                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Connection string | `mongodb://account:key@account.mongo.cosmos.azure.com:10255/?ssl=true&replicaSet=globaldb` |
| SSL               | Required                                                                                   |

Click **Verify** to test the connection.

---

## Step 4: Configure migration task

### 4.1 Select databases and collections

1. In the **Select databases** step, check the databases you want to migrate.
2. For each database, expand to see collections. Check the collections to include.
3. Uncheck any collections you want to exclude (system collections, temporary data).

### 4.2 Collection settings (RU-based only)

For each collection migrating to RU-based Cosmos DB:

| Setting         | Description                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------ |
| **Shard key**   | Partition key for the target container. Must match the container's partition key if pre-created. |
| **Unique keys** | Unique index fields (optional). Must include partition key.                                      |
| **Throughput**  | RU/s for the migration. DMS can auto-create containers with specified throughput.                |

!!! warning "Partition key is permanent"
The partition key (shard key) specified here is immutable. If you need to change it later, you must create a new container and migrate data again. Refer to the [Schema Migration Guide](schema-migration.md) for partition key design patterns.

### 4.3 Migration settings

| Setting                                    | Recommended value |
| ------------------------------------------ | ----------------- |
| **Max parallel per-database activities**   | 4                 |
| **Max parallel per-collection activities** | 4                 |
| **Max retries on transient errors**        | 10                |

---

## Step 5: Execute migration

### 5.1 Start the migration

1. Review the configuration summary.
2. Click **Run migration**.
3. DMS begins the migration in two phases:
    - **Phase 1: Initial load** -- bulk copy of all existing data from source to target.
    - **Phase 2: Continuous sync (CDC)** -- tails the MongoDB oplog/change streams to replicate ongoing changes.

### 5.2 Monitor initial load

In Azure Portal, navigate to the migration activity. The dashboard shows:

| Metric                    | Description                                   |
| ------------------------- | --------------------------------------------- |
| **Status per collection** | Not started / In progress / Completed         |
| **Documents migrated**    | Count of documents transferred per collection |
| **Data migrated**         | Volume in MB/GB per collection                |
| **Elapsed time**          | Duration per collection                       |
| **Errors**                | Count and details of failed documents         |

**Expected throughput rates:**

| Network                          | Approximate throughput | Time for 100 GB |
| -------------------------------- | ---------------------- | --------------- |
| Public internet (high bandwidth) | 10--50 MB/s            | 30--160 minutes |
| VNet peering (same region)       | 50--200 MB/s           | 8--30 minutes   |
| ExpressRoute                     | 100--500 MB/s          | 3--15 minutes   |

### 5.3 Monitor CDC lag

After the initial load completes, DMS enters CDC mode. Monitor the following:

| Metric              | Healthy value | Action if exceeded                                |
| ------------------- | ------------- | ------------------------------------------------- |
| **Replication lag** | < 30 seconds  | Check network bandwidth; reduce source write rate |
| **Pending changes** | < 1,000       | Increase DMS SKU (more vCores)                    |
| **Error count**     | 0             | Investigate error details; fix data issues        |

```bash
# Check migration task status via CLI
az dms project task show \
  --resource-group rg-dms-migration \
  --service-name dms-mongo-to-cosmos \
  --project-name mongo-to-cosmosdb-migration \
  --name migration-task \
  --expand output \
  --query "properties.output[?resultType=='MigrationLevelOutput']"
```

---

## Step 6: Prepare for cutover

### 6.1 Pre-cutover checklist

Before initiating the cutover, verify:

- [ ] All collections show "Syncing" or "Ready to cutover" status.
- [ ] CDC lag is consistently below 10 seconds.
- [ ] No errors in the migration activity for the past 24 hours.
- [ ] Application has been tested against the target Cosmos DB (read-only validation).
- [ ] Rollback plan is documented (re-point application back to source MongoDB).
- [ ] Maintenance window is scheduled with stakeholders.
- [ ] Monitoring and alerting is configured on the Cosmos DB target.

### 6.2 Validate target data

Run validation queries against the Cosmos DB target while DMS is still syncing:

```javascript
// Connect to Cosmos DB target
// Verify document counts match source (within CDC lag margin)
use("mydb");
print("Target orders:", db.orders.countDocuments());
print("Target users:", db.users.countDocuments());

// Run sample aggregation
db.orders.aggregate([
    {
        $match: {
            status: "completed",
            orderDate: { $gte: ISODate("2026-01-01") },
        },
    },
    { $group: { _id: "$region", revenue: { $sum: "$total" } } },
    { $sort: { revenue: -1 } },
]);
```

---

## Step 7: Execute cutover

### 7.1 Cutover sequence

The cutover window should be as short as possible. Target: 2--5 minutes.

**Minute 0: Stop application writes**

```bash
# Option A: Set source to read-only (if possible)
# Option B: Stop application instances
# Option C: Toggle a feature flag to queue writes

# For Azure App Service:
az webapp stop --resource-group rg-app --name my-webapp
```

**Minute 1: Verify DMS drain**

1. In Azure Portal, check the migration activity.
2. Wait for "Pending changes" to reach 0.
3. Verify "Replication lag" is 0 seconds.

**Minute 2: Complete cutover in DMS**

1. Click **Cutover** for each collection (or "Cutover All").
2. Confirm the cutover.
3. DMS marks the migration as complete.

**Minute 3: Update connection strings**

```bash
# Update Key Vault secret
az keyvault secret set \
  --vault-name kv-data-platform \
  --name cosmosdb-connection-string \
  --value "mongodb+srv://admin:pass@target.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256"

# Restart application
az webapp start --resource-group rg-app --name my-webapp
```

**Minute 4: Validate**

```bash
# Check application health endpoint
curl -s https://my-webapp.azurewebsites.net/health | jq .

# Check for errors in application logs
az webapp log tail --resource-group rg-app --name my-webapp
```

**Minute 5: Confirm success**

- Application is serving traffic from Cosmos DB.
- No 500 errors in application logs.
- Latency is within acceptable range.
- Change feed consumers (if configured) are processing events.

### 7.2 Rollback procedure (if needed)

If issues are discovered after cutover:

1. Stop the application.
2. Revert connection string to source MongoDB.
3. Restart the application.
4. Investigate and fix the issue.
5. Repeat the cutover when ready.

!!! warning "Rollback data considerations"
Any writes to Cosmos DB after cutover will not be reflected in the source MongoDB. If rolling back after writes have occurred, you need a strategy to reconcile or replay those writes against the source. For this reason, keep the source MongoDB running for at least 1--2 weeks after cutover.

---

## Step 8: Post-cutover cleanup

### 8.1 Monitor Cosmos DB

For the first 48 hours after cutover, actively monitor:

- **RU consumption** (RU-based): ensure provisioned throughput is sufficient.
- **Latency** (p50, p99): compare with baseline from source MongoDB.
- **Error rates**: watch for 429 (rate limiting), timeout, or authentication errors.
- **Connection count**: verify connection pooling is working correctly.

### 8.2 Scale down throughput (RU-based)

If you temporarily increased RU/s for migration:

```bash
az cosmosdb mongodb collection throughput update \
  --resource-group rg-data-platform \
  --account-name my-cosmos-account \
  --database-name mydb \
  --name orders \
  --max-throughput 10000  # Scale to operational level
```

### 8.3 Enable platform integration

1. **Analytical store (RU-based):** Verify auto-sync is active. Query from Fabric Spark to confirm data flows.
2. **Change feed:** Deploy Azure Functions change feed processor.
3. **Purview:** Register Cosmos DB as data source, run initial scan.

### 8.4 Decommission source

After 1--2 weeks of stable operation on Cosmos DB:

1. Take a final backup of source MongoDB.
2. Archive the backup to long-term storage.
3. Terminate the source MongoDB cluster (Atlas) or decommission VMs (self-hosted).
4. Remove DMS resources.

```bash
# Clean up DMS resources
az dms project delete \
  --resource-group rg-dms-migration \
  --service-name dms-mongo-to-cosmos \
  --name mongo-to-cosmosdb-migration \
  --delete-running-tasks true

az dms delete \
  --resource-group rg-dms-migration \
  --name dms-mongo-to-cosmos
```

---

## Troubleshooting

### DMS cannot connect to source MongoDB

- **Atlas:** Ensure the DMS subnet IP range is in the Atlas IP Access List. If using VNet peering, verify peering status.
- **Self-hosted:** Check security group / firewall rules allow inbound on port 27017 from DMS subnet.
- **TLS:** Ensure SSL/TLS settings match between DMS configuration and source MongoDB requirements.

### Migration is slow

- Increase DMS SKU (e.g., from Premium_4vCores to Standard_8vCores).
- For RU-based: increase provisioned throughput temporarily to handle write load.
- Reduce parallel activities if target is being throttled (429 errors).
- Check network bandwidth between DMS and source/target.

### Documents failing with errors

- **16500 (rate limiting):** Increase RU/s on target container.
- **11000 (duplicate key):** Source data has duplicates that violate unique key policy. Resolve before retry.
- **Document too large:** Documents exceeding 2 MB (RU-based). Split or compress before migration.

### CDC lag not decreasing

- Source write volume may exceed DMS processing capacity. Increase DMS SKU.
- Network latency between DMS and source. Consider moving DMS closer to source.
- Check for long-running transactions on source that block change stream progress.

---

## Related resources

- [Tutorial: VS Code Migration](tutorial-vscode-migration.md)
- [Data Migration Guide](data-migration.md)
- [Application Migration](application-migration.md)
- [Best Practices](best-practices.md)
- [Migration Playbook](../mongodb-to-cosmosdb.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
