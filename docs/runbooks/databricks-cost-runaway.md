[Home](../../README.md) > [Docs](../index.md) > [Runbooks](index.md) > **Databricks Cost Runaway**

# Runbook — Databricks Cost Runaway

> **When to use this runbook:** Databricks spending has spiked beyond
> forecasted budgets, zombie clusters are burning DBUs, a notebook is
> stuck in an infinite loop consuming compute, or autoscale has expanded
> to maximum workers and is not contracting.

## Before First Use — Customization Checklist

- [ ] Populate the [Contact Information](#contact-information) table with
      your Databricks workspace admins and FinOps contacts.
- [ ] Replace `<workspace-url>` placeholders with your actual Databricks
      workspace URLs (dev / staging / prod).
- [ ] Set your Azure subscription IDs and resource group names in the CLI
      commands below.
- [ ] Confirm budget alert thresholds match your organization's spend limits.

---

## Symptoms

| Symptom                                     | Severity | Likely Cause                                                 |
| ------------------------------------------- | -------- | ------------------------------------------------------------ |
| Unexpected cost spike (>30% above forecast) | P1       | Runaway notebook, zombie cluster, or misconfigured autoscale |
| Zombie clusters (running but idle > 2 hrs)  | P2       | Auto-termination disabled or set too high                    |
| Runaway notebook (stuck loop, no progress)  | P1       | Infinite loop, unbounded collect, or cartesian join          |
| Autoscale at max workers for > 1 hour       | P2       | Workload spike or inefficient Spark job                      |
| DBU consumption trending 2x+ above plan     | P3       | Organic workload growth or new unoptimized jobs              |
| Spot instance fallback to on-demand         | P3       | Spot capacity unavailable in region                          |
| Interactive clusters left running overnight | P2       | Missing auto-termination policy                              |

---

## Triage

### Step 1: Quantify the cost impact

- [ ] Open the **Databricks Account Console** > **Usage** tab.
- [ ] Filter to the last 7 days and compare against the previous period.

```bash
az consumption usage list \
  --start-date $(date -d '-7 days' +%Y-%m-%d) \
  --end-date $(date +%Y-%m-%d) \
  --query "[?contains(instanceName, 'databricks')]" \
  --output table
```

### Step 2: Identify top-spending workspaces and clusters

- [ ] In the Account Console, drill into **Usage by Workspace**. Sort by
      DBU consumption descending.
- [ ] Within the workspace, go to **Compute** and sort clusters by DBU.

```bash
databricks clusters list \
  --host <workspace-url> \
  --output json | jq '.clusters[] | select(.state=="RUNNING") | {cluster_id, cluster_name, autoscale, num_workers}'
```

### Step 3: Check for zombie clusters

- [ ] Look for clusters with `State: Running` and `Last Activity` older
      than 2 hours.

```bash
databricks clusters get \
  --host <workspace-url> \
  --cluster-id <cluster-id> | jq '{cluster_name, autotermination_minutes, state, last_activity_time}'
```

!!! warning
Clusters with `autotermination_minutes: 0` will never auto-terminate.
These are the most common source of zombie cost.

### Step 4: Check for runaway notebooks

- [ ] Navigate to **Monitoring** > **Spark UI** for the suspect cluster.
- [ ] Look for jobs running hours when minutes is expected.
- [ ] Check for infinite loops, unbounded `collect()`, or cartesian joins.

### Step 5: Check autoscale configurations

- [ ] For clusters at max workers, verify autoscale bounds are reasonable.
- [ ] Check if the workload genuinely needs that scale or if an
      inefficient job is holding workers.

### Step 6: Classify severity

| Condition                                        | Severity |
| ------------------------------------------------ | -------- |
| Runaway job or zombie cluster burning > $500/day | P1       |
| Multiple clusters idle, cost 30%+ above forecast | P2       |
| Trending upward but no immediate overspend       | P3       |

---

## Response Actions

### P1 — Critical: Active Cost Runaway

!!! danger
A runaway cluster or notebook can burn thousands of dollars in hours.
Terminate first, investigate second.

- [ ] **Kill the runaway cluster immediately:**

```bash
databricks clusters delete \
  --host <workspace-url> \
  --cluster-id <cluster-id>
```

- [ ] **Cancel a stuck notebook run:**

```bash
databricks runs cancel \
  --host <workspace-url> \
  --run-id <run-id>
```

- [ ] **Set an emergency budget alert** if one does not exist:

```bash
az consumption budget create \
  --budget-name "Databricks-Emergency" \
  --resource-group <rg> \
  --amount 5000 \
  --time-grain Monthly \
  --category Cost \
  --start-date $(date +%Y-%m-01) \
  --notifications '[{"enabled":true,"operator":"GreaterThanOrEqualTo","threshold":80,"contactEmails":["oncall@example.com"]}]'
```

- [ ] **Audit all running clusters** in the affected workspace. Terminate
      any that are not actively needed.
- [ ] **Notify stakeholders** using the communication template below.

### P2 — Degraded: Overspend Without Runaway

- [ ] **Right-size clusters** — reduce max workers, switch to smaller
      instance types, enable auto-termination (30 min interactive, 10 min
      job clusters).
- [ ] **Enforce autoscale limits** via cluster policies (see next section).
- [ ] **Terminate idle interactive clusters** running without activity > 1 hr.
- [ ] **Enable spot instances** for fault-tolerant workloads.

### P3 — Warning: Cost Trending Upward

- [ ] **Review cluster policies** — ensure all workspaces have mandatory
      policies applied.
- [ ] **Audit new workloads** added in the last 30 days.
- [ ] **Stagger batch jobs** to off-peak hours to avoid overlap.
- [ ] **Create a capacity planning ticket** for the next sprint.

---

## Cluster Policies

Cluster policies are your first line of defense against cost runaway.
Apply a cost-controlled policy to every workspace.

### Cost-Controlled Policy Template

```json
{
    "name": "cost-controlled-standard",
    "definition": {
        "autotermination_minutes": {
            "type": "range",
            "minValue": 10,
            "maxValue": 120,
            "defaultValue": 30
        },
        "autoscale.max_workers": {
            "type": "range",
            "minValue": 1,
            "maxValue": 16
        },
        "node_type_id": {
            "type": "allowlist",
            "values": [
                "Standard_DS3_v2",
                "Standard_DS4_v2",
                "Standard_E4ds_v5",
                "Standard_E8ds_v5"
            ]
        },
        "azure_attributes.availability": {
            "type": "allowlist",
            "values": ["SPOT_WITH_FALLBACK_AZURE", "SPOT_AZURE"],
            "defaultValue": "SPOT_WITH_FALLBACK_AZURE"
        },
        "custom_tags.CostCenter": { "type": "fixed", "value": "" },
        "custom_tags.Team": { "type": "regex", "pattern": ".+" }
    }
}
```

```bash
databricks cluster-policies create \
  --host <workspace-url> \
  --json-file cost-controlled-standard.json
```

!!! tip
Set the policy as **default** for all new clusters at the workspace
admin level. Users can request exemptions via a tagged ticket.

---

## Cost Optimization

### Spot Instances

- Use `SPOT_WITH_FALLBACK_AZURE` for batch workloads (saves 60-80%).
- Reserve `ON_DEMAND_AZURE` for latency-sensitive interactive clusters.
- Monitor spot eviction rates; escalate if evictions exceed 10% of tasks.

### Photon and Compute Efficiency

- Enable Photon on SQL-heavy workloads for 2-8x speedup, reducing DBU-hours.
- Use **instance pools** to cut cluster start time and idle warm-up cost.
- Share interactive clusters across team members instead of one per user.

### Init Scripts and Libraries

- Audit init scripts for unnecessary installs — each adds start-time cost.
- Pin library versions to prevent performance-degrading upgrades.

### Delta Caching and Storage

- Enable Delta caching for repeated reads (`spark.databricks.io.cache.enabled`).
- Run `OPTIMIZE` + `ZORDER` on frequently queried Delta tables.
- Schedule `VACUUM` to reclaim storage and reduce listing overhead.

### Troubleshooting Cost Issues

| Symptom                              | Cause                           | Fix                                              |
| ------------------------------------ | ------------------------------- | ------------------------------------------------ |
| High DBU but low CPU utilization     | Over-provisioned cluster        | Reduce worker count or instance type             |
| Cluster starts frequently            | No instance pool configured     | Create and assign an instance pool               |
| Spot evictions causing job failures  | Insufficient on-demand fallback | Use `SPOT_WITH_FALLBACK_AZURE`                   |
| Repeated full table scans            | Missing Delta ZORDER            | Apply ZORDER on filter columns                   |
| Jobs running 3x longer than expected | Shuffle spill to disk           | Increase worker memory or reduce partition count |

---

## Preventive Controls

### Budget Alerts

```bash
az consumption budget create \
  --budget-name "Databricks-Monthly" \
  --resource-group <rg> \
  --amount 10000 \
  --time-grain Monthly \
  --category Cost \
  --start-date $(date +%Y-%m-01) \
  --notifications '[
    {"enabled":true,"operator":"GreaterThanOrEqualTo","threshold":50,"contactEmails":["finops@example.com"]},
    {"enabled":true,"operator":"GreaterThanOrEqualTo","threshold":80,"contactEmails":["finops@example.com","eng-lead@example.com"]},
    {"enabled":true,"operator":"GreaterThanOrEqualTo","threshold":100,"contactEmails":["finops@example.com","eng-lead@example.com","oncall@example.com"]}
  ]'
```

### Tagging and Chargeback

- [ ] Require `CostCenter` and `Team` tags on all clusters via policy.
- [ ] Use `Environment` tag (`dev`, `staging`, `prod`) for segmentation.
- [ ] Enforce tagging via Azure Policy — deny creation without required tags.
- [ ] Export usage data to Azure Cost Management monthly; share chargeback
      reports with team leads by the 5th of each month.

### Workspace Governance

- [ ] Restrict unrestricted cluster creation to admins only.
- [ ] Require all users to select a cluster policy when creating clusters.
- [ ] Audit workspace admin membership quarterly — remove stale accounts.

---

## Monitoring

### Key Metrics and Alerts

| Metric                      | Source                | Alert Threshold         |
| --------------------------- | --------------------- | ----------------------- |
| Daily DBU consumption       | Account Console / API | > 120% of 7-day avg     |
| Running cluster count       | Clusters API          | > expected max          |
| Idle cluster count (> 1 hr) | Clusters API          | > 0                     |
| Spot eviction rate          | Spark UI metrics      | > 10%                   |
| Monthly spend vs. budget    | Azure Cost Management | > 80% of monthly budget |
| Cluster policy compliance   | Workspace admin audit | < 100% compliance       |

### Azure Cost Management KQL

```kql
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DATABRICKS"
| where TimeGenerated > ago(30d)
| summarize TotalCost = sum(CostInBillingCurrency) by WorkspaceName = tostring(properties_s), bin(TimeGenerated, 1d)
| order by TotalCost desc
```

---

## Communication Templates

### Internal notification (P1/P2)

> **Subject:** [P1/P2] Databricks Cost Runaway — `<workspace-name>`
>
> **Detected:** `<timestamp UTC>`
> **Impact:** Estimated overspend of $`<amount>` in the last `<timeframe>`.
> Cluster `<cluster-name>` identified as the primary cost driver.
> **Status:** Investigating / Contained / Resolved
> **Actions taken:** `<bullet list>`
> **Next update:** `<time>`

---

## Contact Information

!!! warning
**Action Required:** Populate these before first production use.

| Role               | Contact                                                                                     | Phone                        | Escalation            |
| ------------------ | ------------------------------------------------------------------------------------------- | ---------------------------- | --------------------- |
| Databricks Admin   | _(your workspace admin)_                                                                    | _(see PagerDuty / OpsGenie)_ | First responder       |
| Platform Eng Lead  | _(your platform team lead)_                                                                 | _(see PagerDuty / OpsGenie)_ | P1/P2 escalation      |
| FinOps Lead        | _(your FinOps contact)_                                                                     | _(DL)_                       | Budget/cost decisions |
| Databricks Support | [Support Portal](https://help.databricks.com)                                               | N/A                          | Platform-level issues |
| Azure Support      | [Azure Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A                          | Azure billing issues  |

---

## Drill Log

Run this runbook in tabletop form quarterly. Add one row per drill.

| Quarter  | Date  | Type (tabletop / live) | Scenario exercised | Lead  | Gaps identified | Fixes tracked |
| -------- | ----- | ---------------------- | ------------------ | ----- | --------------- | ------------- |
| Q1 — Jan | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q2 — Apr | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q3 — Jul | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |
| Q4 — Oct | _TBD_ | _TBD_                  | _TBD_              | _TBD_ | _TBD_           | _TBD_         |

---

## Related Documentation

- [Data Pipeline Failure](./data-pipeline-failure.md) — ADF / Synapse pipeline failure triage
- [Fabric Capacity Management](./fabric-capacity-management.md) — Fabric capacity throttling and sizing
- [DR Drill](./dr-drill.md) — region-level failover procedures
- [Troubleshooting](../TROUBLESHOOTING.md) — general triage
