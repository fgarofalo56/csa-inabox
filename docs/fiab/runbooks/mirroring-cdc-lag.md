# Runbook — Mirroring CDC lag

## Symptom

Mirrored Delta table is more than N minutes behind the source
operational database. Loom Console "Mirroring" pane shows CDC lag >
SLA.

## Diagnosis

```bash
# 1. Check Mirroring Engine health
curl https://<mirroring-url>/health

# 2. Check Debezium Connect status
curl http://<debezium-host>:8083/connectors/<connector-name>/status
# Expected: state = RUNNING

# 3. Check Event Hubs throughput / partitions
az eventhubs eventhub show -g <rg> -n <ehub-name> --namespace-name <ns>
# Look at messages-per-second; should not be throttled

# 4. Check Spark Streaming job status in Databricks
# Databricks UI → Workflows → Find "Mirroring-Spark-Streaming-Job"
# Look at: input rate, processing rate, batch duration

# 5. Check watermark in Cosmos
az cosmosdb sql query \
  --account-name <cosmos> --database-name csa-loom \
  --container-name mirroring-watermarks \
  --query-text "SELECT * FROM c WHERE c.mirrorId = '<id>'"
```

## Common causes + fixes

| Cause | Fix |
|---|---|
| Source DB CDC not enabled | Enable CDC on source: SQL Server `EXEC sys.sp_cdc_enable_db`; Postgres `wal_level = logical`; etc. |
| Debezium connector stuck / failed | Restart connector: `curl -X POST http://<host>:8083/connectors/<name>/restart` |
| Event Hubs throttled | Scale up Event Hubs namespace TUs or partition count |
| Spark Streaming job paused / failed | Restart Databricks job; check job-run logs |
| Backpressure: source change rate > sink ingest rate | Reduce trigger interval (more frequent micro-batches); add Spark executors |
| Idempotency key conflict (duplicate `last_op_id`) | Review MERGE logic; check for duplicate CDC events from source |
| Schema evolution failed (new column type incompatible) | Manually evolve target Delta schema; re-bootstrap if necessary |
| Network egress from source to Debezium blocked | Verify SHIR connectivity (on-prem sources) or NSG rules (Azure) |

## Remediation

1. **Identify** which stage is the bottleneck (Source / Debezium /
   Event Hubs / Spark Streaming / MERGE)
2. **Apply fix** per table
3. **Re-bootstrap** if necessary (loses incremental progress; full
   refresh from source):
   ```bash
   # From Mirroring Engine CLI
   mirroring-cli reseed --mirror-id <id>
   ```
4. **Verify** lag returns to < 60s steady-state

## Prevention

- Monitor `mirroring-cdc-lag-p95` per source; alert > 5 min
- Right-size Event Hubs TU + partition count for expected change
  volume
- Right-size Spark Streaming cluster for sink ingest rate
- Set Databricks job retry policy (3 attempts, exponential backoff)

## Related

- Service: [Mirroring Engine](../services/mirroring-engine.md)
- Workload: [Mirroring parity](../workloads/mirroring-parity.md)
