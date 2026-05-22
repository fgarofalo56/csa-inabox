# Runbook — Capacity overrun

## Symptom

CU-equivalent utilization exceeds budget threshold. Cost alert fires.
Or per-service throttling alerts (Databricks DBU quota,  Power BI
F-SKU memory, ADX vCore-second exhaustion).

## Diagnosis

```bash
# 1. Check Console Monitoring Hub → Capacity
# Look at the 24h CU-equivalent chart; identify which service is
# dominant

# 2. Per-service deep dive (LAW KQL)
# Databricks DBU consumption per cluster:
DatabricksClusterEvents
| where TimeGenerated > ago(24h)
| summarize dbu = sum(dbuConsumed) by ClusterName
| order by dbu desc

# Power BI Premium memory:
PowerBICapacityEvents
| where TimeGenerated > ago(24h)
| summarize avg_mem = avg(memoryMb), max_mem = max(memoryMb)
            by WorkspaceName

# ADX vCore-seconds:
ADXIngestionEvents
| where TimeGenerated > ago(24h)
| summarize vcs = sum(vcoreSeconds) by databaseName

# 3. Identify the workload driving overrun
# e.g., scheduled Spark job, semantic model refresh, mass query
# from a Power BI report
```

## Common causes + fixes

| Cause | Fix |
|---|---|
| Runaway Databricks job | Cancel + tune SQL / Spark partitioning |
| Full-table semantic model refresh on huge fact table | Switch to partition refresh in Direct-Lake-Shim policy |
| ADX query scanning > expected (full table scan instead of partition pruning) | Optimize KQL; add update policies; verify table partitioning |
| New workload onboarded without capacity sizing | Scale up SKU; or split workload across DLZs |
| Power BI dataset memory pressure (model > F-SKU memory) | Move tables to DirectQuery; or scale up F-SKU |
| ADX cold cluster auto-resuming on every query (5-10s overhead each) | Schedule warm-keep cron; or scale up to keep warm |
| AOAI runaway usage (debug loop in Copilot tool calling) | Investigate user; apply per-user rate limit |

## Remediation (immediate — stop the bleeding)

1. **Pause** the runaway resource:
   - Databricks: cancel job; pause cluster
   - Power BI Premium: pause capacity (loses queries until resume)
   - ADX: stop cluster
2. **Notify** workload owner + capacity Admin
3. **Scale up** if scale-down isn't viable mid-incident:
   - Console "Admin → Capacity → Scale up [service]"

## Remediation (longer-term)

1. Right-size the workload (per-service tuning)
2. Apply cost-optimization patterns from [Cost management](../operations/cost.md)
3. Move to Reservations for stable consumption
4. Pre-deploy capacity-overrun alerts at 60% / 80% / 95% of budget

## Prevention

- Monthly capacity-forecast review using `fiab-capacity-forecast`
- Per-workload capacity allocation: each DLZ has its own
  Databricks + ADX + Power BI capacity, billed separately
- Tag every resource with `CostCenter` for charge-back / show-back
- Deploy budget alerts at 50% / 80% / 100% of monthly budget

## Related

- [Cost management](../operations/cost.md)
- [Capacity management](../operations/capacity-management.md)
- Parent runbook: [Cost alert response](../../runbooks/cost-alert-response.md)
