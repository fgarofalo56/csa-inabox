# Runbook — Direct-Lake-Shim stuck

## Symptom

Power BI semantic model not refreshing after Delta commits. Loom
Direct-Lake-Shim service `last_refresh_age_seconds` > 300 in
health endpoint.

## Diagnosis

```bash
# 1. Check service health
curl https://<dl-shim-url>/health

# Expected:
# {"status":"healthy","event_grid_subscription":"active",...}

# 2. Check Event Grid subscription is active
az eventgrid event-subscription show \
  --name csa-loom-shim-subscription \
  --source-resource-id /subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>

# 3. Check Redis lock isn't stuck
# Redis CLI from the shim container:
redis-cli -h <redis-host> -p 6380 --tls KEYS "shim:lock:*"
# Any keys > 5 min old indicate a stuck lock

# 4. Check Cosmos tracker for last-version sync
az cosmosdb sql query \
  --account-name <cosmos-account> \
  --database-name csa-loom \
  --container-name direct-lake-shim-tracker \
  --query-text "SELECT * FROM c WHERE c.tableId = '<table-id>'"

# 5. Check TOM connection from shim
# Look in App Insights for "TOMConnectionFailed" or "XMLAEndpointTimeout"
```

## Common causes + fixes

| Cause | Fix |
|---|---|
| Event Grid subscription stopped delivering | `az eventgrid event-subscription update --enable` |
| Power BI Premium capacity paused | Resume capacity in Console "Admin → Capacity" |
| Stuck Redis lock | `redis-cli DEL shim:lock:<modelId>` |
| TOM XMLA endpoint auth failure | Verify Shim MI has Power BI workspace `Member` role |
| Table partition not authored (refresh policy = `partition` but no partitions) | Re-author TMDL with partition definition |
| F-SKU memory exceeded | Switch table to `directquery-fallback` policy |
| Network egress to XMLA endpoint blocked | Verify NSG egress + DNS resolution to `*.analysis.windows.net` |

## Remediation

1. Restart Direct-Lake-Shim container:
   - Commercial / GCC: `az containerapp revision restart`
   - GCC-High / IL5: `kubectl rollout restart deployment/dl-shim`
2. Re-trigger refresh manually via TOM:
   ```bash
   # CLI tool in apps/fiab-direct-lake-shim/cli/
   dl-shim-refresh --model-id <id> --table <name> --partition <part>
   ```
3. Verify next Delta commit triggers a refresh within 60s

## Prevention

- Monitor `dl-shim-refresh-latency-p95` in App Insights; alert > 90s
- Right-size Premium F-SKU memory for largest semantic model
- Author tables with explicit partitions for partition-refresh policy

## Related

- Service: [Direct-Lake-Shim](../services/direct-lake-shim.md)
- Workload: [Direct Lake parity](../workloads/direct-lake-parity.md)
