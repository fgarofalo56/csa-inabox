# Tutorial: MongoDB to Cosmos DB Migration with VS Code Extension

**Duration:** 2--4 hours
**Prerequisites:** VS Code installed, Azure subscription, access to source MongoDB instance
**Outcome:** Assessed MongoDB compatibility, planned migration, executed data transfer, and validated results -- all from within VS Code.

---

## Overview

The Azure Cosmos DB migration extension for VS Code provides a guided, integrated experience for migrating MongoDB databases to Cosmos DB. This tutorial walks through the complete workflow: installing the extension, connecting to your source MongoDB, running a compatibility assessment, planning the migration, executing the data transfer, and validating the results.

---

## Step 1: Install required VS Code extensions

### 1.1 Install Azure Cosmos DB extension

1. Open VS Code.
2. Open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Search for **"Azure Databases"**.
4. Install the **Azure Databases** extension by Microsoft.
5. This extension includes Cosmos DB management, data exploration, and the migration assessment tool.

### 1.2 Install MongoDB extension (optional but recommended)

1. In the Extensions panel, search for **"MongoDB for VS Code"**.
2. Install the **MongoDB for VS Code** extension by MongoDB.
3. This provides a MongoDB playground for running queries against both source and target.

### 1.3 Sign in to Azure

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Type **"Azure: Sign In"** and select it.
3. Complete the browser-based authentication flow.
4. Verify your subscription appears in the Azure panel (left sidebar, Azure icon).

---

## Step 2: Connect to source MongoDB

### 2.1 Add MongoDB connection

1. In the left sidebar, click the **Azure** icon.
2. Expand **Workspace** section.
3. Click **Attached Database Accounts** > **Attach Database Account**.
4. Select **MongoDB** as the API.
5. Enter your MongoDB connection string:

    ```
    mongodb+srv://admin:password@cluster0.abc123.mongodb.net/?retryWrites=true&w=majority
    ```

6. Click **Connect**.

### 2.2 Explore source data

1. Expand the newly connected MongoDB account in the tree view.
2. Browse databases and collections.
3. Right-click a collection and select **View Documents** to inspect sample data.
4. Note the following for each collection:
    - Approximate document count
    - Average document size
    - Index definitions
    - Fields used in queries

### 2.3 Document your inventory

Create a migration inventory file in your workspace:

```markdown
<!-- migration-inventory.md -->

## Source MongoDB Inventory

| Database | Collection | Documents | Avg Size | Indexes | Partition Key Candidate |
| -------- | ---------- | --------- | -------- | ------- | ----------------------- |
| mydb     | users      | 50,000    | 2 KB     | 3       | userId                  |
| mydb     | orders     | 500,000   | 4 KB     | 5       | customerId              |
| mydb     | products   | 10,000    | 8 KB     | 4       | categoryId              |
| mydb     | sessions   | 100,000   | 1 KB     | 2 (TTL) | userId                  |
| mydb     | audit_log  | 2,000,000 | 0.5 KB   | 2       | entityId                |
```

---

## Step 3: Run compatibility assessment

### 3.1 Open assessment tool

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Type **"Cosmos DB: Assess MongoDB Migration"** and select it.
3. Select the connected MongoDB account.
4. Select the database(s) to assess.
5. Choose the target: **Cosmos DB for MongoDB vCore** or **Cosmos DB for MongoDB (RU-based)**.

### 3.2 Review assessment results

The assessment report covers:

**Compatibility issues:**

- Unsupported aggregation stages or operators (RU-based).
- Documents exceeding size limits (2 MB for RU-based, 16 MB for vCore).
- Unsupported index types.
- Capped collections (RU-based limitation).
- Time-series collections (neither supports natively).

**Recommendations:**

- Partition key suggestions based on query patterns.
- Indexing policy recommendations.
- Throughput estimates (RU/s for RU-based; tier for vCore).
- Feature compatibility warnings.

**Example assessment output:**

```
Assessment Report: mydb → Cosmos DB for MongoDB vCore
═══════════════════════════════════════════════════════

Overall Compatibility: 98% (High)

Collections:
  ✅ users          - Fully compatible
  ✅ orders         - Fully compatible
  ✅ products       - Fully compatible
  ⚠️ sessions      - Capped collection detected. Will migrate as regular collection.
  ✅ audit_log      - Fully compatible

Aggregation Pipelines:
  ✅ 12/12 pipelines compatible

Indexes:
  ✅ 16/16 indexes compatible

Warnings:
  ⚠️ sessions: Capped collection will be converted to regular collection with TTL.
  ℹ️ Recommended: Add TTL index on 'lastAccess' field (expireAfterSeconds: 3600).

Estimated Migration Time: 45 minutes (500 GB data)
```

### 3.3 Export assessment

1. Click **Export Report** in the assessment results panel.
2. Save as JSON or markdown for team review.
3. Share with your migration team and compliance officers (for federal migrations).

---

## Step 4: Provision Cosmos DB target

### 4.1 Create Cosmos DB account from VS Code

1. In the Azure panel, right-click **Cosmos DB** under your subscription.
2. Select **Create Database Account**.
3. Configure:

    | Setting       | Value                                 |
    | ------------- | ------------------------------------- |
    | Account name  | `my-cosmos-mongo`                     |
    | API           | MongoDB (vCore) or MongoDB (RU-based) |
    | Location      | East US (or your preferred region)    |
    | Capacity mode | Provisioned (or Serverless for dev)   |

4. Click **Create** and wait for deployment (3--5 minutes).

### 4.2 Create databases and containers

**For vCore:**

1. Right-click the new Cosmos DB account > **Create Database**.
2. Enter database name (match source database name for simplicity).
3. Databases and collections will be created during data migration.

**For RU-based:**

1. Right-click the new Cosmos DB account > **Create Database**.
2. Enter database name and throughput (shared or dedicated).
3. For each collection, right-click the database > **Create Collection**.
4. **Critical:** Enter the partition key (shard key) for each collection. This is immutable.
5. Set throughput (manual or autoscale) per collection.

### 4.3 Configure networking

1. In Azure Portal, navigate to the Cosmos DB account.
2. Go to **Networking** > **Firewall and virtual networks**.
3. Add your current IP address for development access.
4. For production, configure Private Endpoint.

---

## Step 5: Execute migration

### 5.1 Configure migration task

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Type **"Cosmos DB: Migrate MongoDB Data"** and select it.
3. Select the source MongoDB connection.
4. Select the target Cosmos DB account.
5. Map source databases/collections to target containers:

    | Source         | Target         | Partition Key |
    | -------------- | -------------- | ------------- |
    | mydb.users     | mydb.users     | /userId       |
    | mydb.orders    | mydb.orders    | /customerId   |
    | mydb.products  | mydb.products  | /categoryId   |
    | mydb.sessions  | mydb.sessions  | /userId       |
    | mydb.audit_log | mydb.audit_log | /entityId     |

6. Configure migration options:
    - **Migration mode:** Offline (one-time copy) or Online (with CDC).
    - **Parallelism:** Number of collections to migrate simultaneously (default: 4).
    - **Batch size:** Documents per batch (default: 1000).

### 5.2 Start migration

1. Click **Start Migration**.
2. The extension begins transferring data collection by collection.
3. Progress is displayed in the VS Code output panel:

    ```
    [Migration] Starting: mydb.users (50,000 documents)
    [Migration] Progress: mydb.users - 25,000/50,000 (50%) - 2 min elapsed
    [Migration] Complete: mydb.users - 50,000/50,000 (100%) - 4 min
    [Migration] Starting: mydb.orders (500,000 documents)
    [Migration] Progress: mydb.orders - 100,000/500,000 (20%) - 3 min elapsed
    ...
    ```

### 5.3 Monitor and troubleshoot

**Common issues during migration:**

| Issue                    | Symptom                     | Resolution                                          |
| ------------------------ | --------------------------- | --------------------------------------------------- |
| Rate limiting (RU-based) | 16500 errors in output      | Increase provisioned RU/s temporarily               |
| Document too large       | Error on specific documents | Split or compress documents > 2 MB                  |
| Unique key violation     | 11000 errors                | Deduplicate source data or adjust unique key policy |
| Network timeout          | Connection reset errors     | Check firewall rules; increase timeout settings     |
| Partition key missing    | Error on insert             | Ensure partition key field exists in every document |

---

## Step 6: Validate migration

### 6.1 Document count verification

1. In VS Code, connect to the target Cosmos DB account.
2. Right-click each collection > **View Documents**.
3. Compare document counts with source.

Use the MongoDB playground in VS Code to run validation queries:

```javascript
// In MongoDB Playground (connected to target)
use("mydb");

// Count documents
print("users:", db.users.countDocuments());
print("orders:", db.orders.countDocuments());
print("products:", db.products.countDocuments());
print("sessions:", db.sessions.countDocuments());
print("audit_log:", db.audit_log.countDocuments());
```

### 6.2 Data integrity validation

```javascript
// Sample-based validation
use("mydb");

// Get a few specific documents and verify content
const sampleOrder = db.orders.findOne({ _id: ObjectId("known-order-id") });
print("Sample order:", JSON.stringify(sampleOrder, null, 2));

// Verify aggregation results match
const totalRevenue = db.orders.aggregate([
    { $match: { status: "completed" } },
    { $group: { _id: null, total: { $sum: "$total" } } },
]);
print("Total revenue:", JSON.stringify(totalRevenue.toArray()));
```

### 6.3 Index verification

```javascript
// Verify indexes were created
use("mydb");

print("=== orders indexes ===");
db.orders.getIndexes().forEach((idx) => printjson(idx));

print("=== users indexes ===");
db.users.getIndexes().forEach((idx) => printjson(idx));
```

### 6.4 Query performance validation

```javascript
// Run explain on key queries
use("mydb");

const plan = db.orders
    .find({ customerId: "cust-123" })
    .explain("executionStats");
print("Query plan:", JSON.stringify(plan.executionStats, null, 2));
```

---

## Step 7: Post-migration steps

### 7.1 Update application connection strings

1. Update environment variables or Key Vault secrets.
2. Deploy application changes to staging.
3. Run integration tests against Cosmos DB target.

### 7.2 Configure monitoring

1. In Azure Portal, navigate to the Cosmos DB account.
2. Go to **Diagnostic Settings**.
3. Enable diagnostics to Log Analytics workspace.
4. Create alert rules for:
    - RU consumption > 80% of provisioned (RU-based)
    - Latency p99 > 50 ms
    - 429 error rate > 1%
    - Storage approaching limit

### 7.3 Enable platform integration

1. **Purview:** Register Cosmos DB as a data source. Run initial scan.
2. **Analytical store (RU-based):** Verify auto-sync is active via Azure Portal > Data Explorer > Analytical Store tab.
3. **Change feed:** Deploy Azure Functions change feed processor for event-driven integration with the csa-inabox platform.

### 7.4 Decommission source

1. Set source MongoDB to read-only (if possible).
2. Monitor for 1--2 weeks to confirm no unexpected traffic.
3. Take final backup of source for archive.
4. Decommission source MongoDB cluster.

---

## Troubleshooting

### Extension not showing migration option

- Ensure you have the latest version of the Azure Databases extension.
- Verify you are signed in to Azure (`Azure: Sign In`).
- Restart VS Code after installation.

### Connection failures

- Verify the MongoDB connection string is correct.
- Check firewall rules on both source and target.
- For Atlas, ensure your IP is in the Atlas IP Access List.
- For Cosmos DB, ensure your IP is in the firewall allow list.

### Migration hangs or fails

- Check the VS Code output panel for error details.
- For RU-based: temporarily increase throughput to 50,000+ RU/s.
- For large collections: reduce batch size to 500 or 100.
- For network issues: verify VNet peering or private endpoint configuration.

---

## Related resources

- [Tutorial: DMS Online Migration](tutorial-dms-migration.md)
- [Data Migration Guide](data-migration.md)
- [Application Migration](application-migration.md)
- [Migration Playbook](../mongodb-to-cosmosdb.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
