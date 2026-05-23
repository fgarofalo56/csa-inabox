# Runbook — Activator rules not firing

## Symptom

A configured Loom Activator rule isn't dispatching its action when
the rule condition is met.

## Diagnosis

```bash
# 1. Check Activator Engine health
curl https://<activator-url>/health

# 2. Check rule definition in Cosmos
az cosmosdb sql query \
  --account-name <cosmos> --database-name csa-loom \
  --container-name activator-rules \
  --query-text "SELECT * FROM c WHERE c.id = '<rule-id>'"

# Verify enabled = true, cadenceMinutes >= 1

# 3. Check rule scheduler executed the KQL recently
# App Insights query:
ActivatorEngineLogs
| where Category == "RuleScheduler"
| where RuleId == "<rule-id>"
| order by TimeGenerated desc
| take 10

# 4. Check KQL query result count for the cadence window
# Run the rule's KQL manually in ADX Web UI

# 5. Check Redis state for the affected object
redis-cli HGETALL "activator:state:<workspaceId>:<ruleId>:<splitColumnValue>"

# 6. Check action dispatcher executed
# App Insights query:
ActivatorEngineLogs
| where Category == "RuleFiring"
| where RuleId == "<rule-id>"
| project TimeGenerated, SplitValue, ActionDispatched, ActionResult
```

## Common causes + fixes

| Cause | Fix |
|---|---|
| Rule disabled | Re-enable in Console "Activator" pane or set `enabled: true` in Cosmos |
| Cadence too long for expected event freshness | Reduce `cadenceMinutes` (min 1) |
| KQL query returns no rows in cadence window | Adjust KQL (extend `ago()` window, fix filter) |
| Stuck Redis state (`andStays` rule waiting on dwell-time that started before deploy) | `redis-cli DEL activator:state:*` for affected objects to reset |
| Action dispatcher Function App down | Restart Function App; check App Insights for errors |
| Teams / Email / webhook destination unreachable | Verify destination URL + Function App egress |
| Per-rule throttle exceeded (>10,000 events/sec) | Optimize KQL to filter earlier; or split rule |
| Token / credential for action expired | Rotate via Key Vault; restart Activator Engine |

## Remediation

1. **Identify** which step failed (Schedule / Query / Evaluate /
   Dispatch) via App Insights query above
2. **Apply fix** per table
3. **Restart** Activator Engine if config change required:
   ```bash
   az containerapp revision restart -g <rg> -n activator-engine
   # OR kubectl rollout restart deployment/activator-engine
   ```
4. **Verify** next rule evaluation fires action by injecting a known
   test event

## Prevention

- Monitor `activator-action-dispatch-success-rate` < 99% → alert
- Authoring discipline: test rules in dry-run mode before enable
- Use Loom Console "Activator → Test" feature to inject synthetic
  events

## Related

- Service: [Activator Engine](../services/activator-engine.md)
- Workload: [Data Activator parity](../workloads/data-activator-parity.md)
