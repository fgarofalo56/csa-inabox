# Cost management

CSA Loom cost = underlying Azure consumption only (Loom IP is free in
v1). Cost-optimization patterns:

## Major cost drivers

| Service | Approximate share of total |
|---|---|
| Power BI Premium F-SKU | 20-30% |
| Databricks DBU | 25-40% |
| ADX cluster | 10-15% |
| ADLS Gen2 storage | 5-15% |
| AOAI tokens | 5-15% |
| Synapse Serverless | < 5% |
| AI Search | < 5% |
| Purview | 5-10% |
| Container Apps / AKS workloads | < 5% |
| Misc (KV, LA, App Insights) | < 5% |

## Optimization patterns

### 1. Pause-resume Databricks workspaces

Overnight pause of dev/test workspaces saves ~70% DBU cost.

```bash
# Auto-pause cluster after 10 min idle:
# (set in Databricks cluster config)
spark.databricks.cluster.profile = "singleNode"
spark.databricks.cluster.autoTerminationMinutes = 10
```

Console "Admin → Capacity → Schedule pause" wires a Databricks Job
that pauses workspace clusters on a cron.

### 2. ADX hot/cold caching policy

Move older data from hot (in-memory) to cold (Blob storage) tier:

```kql
.alter table TelemetryEvents policy caching hot = 7d
// Last 7 days stay hot; older data on cold storage (cheaper)
```

Cuts ADX cluster costs by ~40% for large historical datasets.

### 3. Power BI Premium F-SKU smoothing

Schedule large semantic model refreshes outside business hours:

- Use Direct-Lake-Shim **partition refresh** policy (not full refresh)
- Schedule full refreshes 02:00-05:00 local time
- Pause Premium capacity nights + weekends (CLI cron)

### 4. AOAI provisioned throughput vs PAYG

| Pattern | When to use |
|---|---|
| PAYG (Standard) | Bursty workloads; < 1M tokens/day |
| Data Zone Standard | Cross-region failover scenarios |
| Provisioned Managed Throughput (PTU) | Stable 24/7 workloads; > 5M tokens/day |
| Provisioned reservations | Annual commit; ~40% savings vs PAYG |

### 5. Storage lifecycle rules

Auto-tier old Delta files:

```json
{
  "rules": [
    {
      "name": "ArchiveOldBronze",
      "actions": {
        "baseBlob": {
          "tierToCool": { "daysAfterModificationGreaterThan": 30 },
          "tierToArchive": { "daysAfterModificationGreaterThan": 180 },
          "delete": { "daysAfterModificationGreaterThan": 2555 }
        }
      },
      "filters": { "prefixMatch": ["bronze/"] }
    }
  ]
}
```

Hot → Cool after 30 days saves 50% storage cost; Cool → Archive after
180 days saves another 70%.

### 6. dbt incremental models

Avoid full refresh on huge facts:

```sql
{{ config(materialized='incremental', unique_key='event_id') }}

SELECT * FROM {{ source('bronze', 'events') }}
{% if is_incremental() %}
WHERE event_date > (SELECT MAX(event_date) FROM {{ this }})
{% endif %}
```

### 7. AI Search index reduction

- Use `searchable: false` on columns that don't need full-text search
- Use Standard tier (S1) instead of Standard 2/3 unless vector
  workloads require it
- Index only "Gold" tables; don't index Bronze / Silver

### 8. Reservations

| Service | Term | Approximate savings |
|---|---|---|
| Databricks DBU | 1-year | ~30% |
| Databricks DBU | 3-year | ~40% |
| Power BI Premium F-SKU | annual | ~40% |
| ADX | 1-year | ~30% |
| ADX | 3-year | ~40% |
| Storage | 1-year | ~15-20% |
| AOAI PTU | 1-year | ~30-40% |

## Cost reporting

Console "Monitoring → Cost" pane integrates:
- Azure Cost Management API (per-RG, per-tag, per-domain)
- Power BI per-workspace CU metering
- Databricks DBU per-cluster
- ADX vCore-hours per-cluster
- AOAI token consumption per-deployment

Cost alert rules deployed by Bicep:
- 80% of monthly budget → low-sev
- 100% of monthly budget → high-sev + email + Teams
- Per-DLZ overrun → notify Domain Steward

## Per-boundary cost

| Boundary | Gov premium delta |
|---|---|
| Commercial | baseline |
| GCC | same as Commercial |
| GCC-High / IL4 | +10-25% on most services |
| IL5 (v1.1) | +20-30% (HSM-CMK, double-encryption overhead) |

## Runbook

- [Capacity overrun](../runbooks/capacity-overrun.md)

## Related

- [Capacity management](capacity-management.md)
- [Monitoring](monitoring.md)
- Parent: [Cost Management](../../COST_MANAGEMENT.md), [Cost Optimization best practices](../../best-practices/cost-optimization.md)
