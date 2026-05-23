# Tutorial 06 — Mirroring from Cosmos DB

Configure Loom Mirroring to ingest CDC changes from a Cosmos DB
container into a Bronze Delta table. **30 minutes.**

## Prerequisites

- Workspace from previous tutorials
- Cosmos DB account + database + container (or use the test container
  in `examples/fiab-quickstart/cosmos-seed/`)
- Cosmos DB connection string saved in workspace Key Vault

## Steps

### 1. Verify source Cosmos DB has change feed enabled

Change feed is on by default. Verify:

```bash
az cosmosdb sql container show \
  --resource-group <cosmos-rg> \
  --account-name <cosmos-account> \
  --database-name <db> \
  --name <container> \
  --query "resource.{name:id, changeFeedEnabled:'always-on'}"
```

### 2. Create the mirroring config

Open Loom Console **Mirroring** pane (v1.1) OR CLI (v1):

```bash
loom-mirroring create \
  --workspace <your-workspace-id> \
  --name "transactions-cosmos-mirror" \
  --source-type cosmos-nosql \
  --source-account <cosmos-account-name> \
  --source-database <db> \
  --source-container <container> \
  --credential-kv-ref "https://<kv>.vault.azure.us/secrets/cosmos-conn" \
  --target-lakehouse <workspace>-loom-bronze \
  --target-table-prefix "raw_transactions_" \
  --trigger-interval-seconds 30
```

This:
- Configures the Cosmos Spark connector to read the change feed
- Lands changes in Event Hubs (Kafka protocol)
- Spark Structured Streaming job MERGEs into Delta in your Bronze
  container

### 3. Watch the initial snapshot

```bash
loom-mirroring status --mirror "transactions-cosmos-mirror"
```

You should see:
- `phase: initial-snapshot` for the first ~minutes
- Then `phase: streaming-cdc` for ongoing change capture

### 4. Verify Bronze table appears

Console **Lakehouse** pane → refresh:
- `raw_transactions_<containerName>` Delta table appears with the
  initial snapshot rows

### 5. Test CDC propagation

Insert a row in the source Cosmos container:

```bash
az cosmosdb sql item create \
  --resource-group <cosmos-rg> \
  --account-name <cosmos-account> \
  --database-name <db> \
  --container-name <container> \
  --body '{"id": "test-001", "amount": 100.50, "ts": "2026-05-22T10:00:00Z"}'
```

Wait 30-60 seconds (one Spark Streaming trigger cycle).

Query the Bronze table:

```sql
SELECT * FROM raw_transactions_<containerName>
WHERE id = 'test-001'
```

Row appears with `__rowMarker__ = 1` (INSERT).

### 6. Test UPDATE

```bash
az cosmosdb sql item update \
  --resource-group <cosmos-rg> \
  --account-name <cosmos-account> \
  --database-name <db> \
  --container-name <container> \
  --item-id "test-001" \
  --body '{"id": "test-001", "amount": 200.75, "ts": "2026-05-22T10:00:00Z"}'
```

Wait 30-60s. Query — `amount` updated to 200.75.

### 7. Monitor lag

Console **Monitoring → Mirroring**:
- Per-mirror CDC lag (target < 60s steady-state)
- Throughput (rows/sec)
- Error rate (target < 0.1%)

## What's next

- Transform Bronze → Silver via [Tutorial 02 pattern](02-first-lakehouse.md)
- Wire Activator rules on the CDC stream per [Tutorial 04](04-activator-rules.md)
- [Mirroring parity workload](../workloads/mirroring-parity.md)
- [Mirroring Engine service docs](../services/mirroring-engine.md)

## Cleanup

```bash
loom-mirroring delete --mirror "transactions-cosmos-mirror"
```

Removes the Debezium / Spark Streaming job. Existing Bronze data
remains (drop manually if desired).

## Troubleshooting

- High CDC lag: see [Mirroring CDC lag runbook](../runbooks/mirroring-cdc-lag.md)
- Cosmos connector errors: verify connection string + Cosmos read
  permissions
- Schema-evolution issue (new column appears in source): Loom
  auto-unions; verify by querying the Bronze table
