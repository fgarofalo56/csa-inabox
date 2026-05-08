[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **Fabric Capacity Management**

# Runbook — Fabric Capacity Management

> **When to use this runbook:** Your Fabric capacity is throttled, queries are
> slow, jobs are queuing, or CU utilization is sustained above 90%. This
> covers triage, immediate response by severity, right-sizing guidance, and
> long-term optimization for Microsoft Fabric capacities (F SKUs).

## Before First Use — Customization Checklist

- [ ] Populate the [Contact Information](#-8-contact-information) table with
      your Fabric admin and platform engineering leads.
- [ ] Replace `<capacity-name>` placeholders with your real capacity names
      (dev / staging / prod).
- [ ] Confirm your Azure subscription IDs for the CLI commands below.
- [ ] Verify the Capacity Metrics app is installed and shared with the
      on-call rotation.

---

## Symptoms

| Symptom                              | Severity | Likely Cause                                  |
| ------------------------------------ | -------- | --------------------------------------------- |
| Throttling alerts from Fabric portal | P1       | CU utilization sustained above 100%           |
| Slow query performance (>3x normal)  | P2       | CU contention from concurrent workloads       |
| Jobs queuing / not starting          | P2       | Capacity burst budget exhausted               |
| CU usage sustained >90%              | P3       | Under-provisioned capacity or workload growth |
| Background operations failing        | P2       | Throttling rejecting low-priority operations  |
| Scheduled refreshes timing out       | P3       | Refresh window overlap with heavy queries     |
| Lakehouse maintenance not completing | P3       | Maintenance throttled by foreground workloads |

---

## Triage

### Step 1: Confirm throttling is active

- [ ] Open the **Fabric Admin Portal** > **Capacity settings** > select the
      capacity in question.
- [ ] Check the **Capacity Metrics app** for the last 24 hours. Look for
      sustained utilization above 100% (the red line).

!!! warning
Fabric smooths CU consumption over a rolling window. A brief spike above
100% is normal (burst). Sustained utilization above 100% for more than
10 minutes triggers throttling.

### Step 2: Identify the utilization pattern

- [ ] **Burst overload** — short spike (< 10 min) followed by recovery.
      Typically caused by a single large query or refresh. Usually self-heals.
- [ ] **Sustained overload** — utilization above 90% for 30+ minutes.
      Indicates the capacity is under-sized for the current workload mix.
- [ ] **Periodic overload** — spikes at the same time daily. Points to
      overlapping scheduled refreshes or batch jobs.

### Step 3: Identify top CU consumers

Open the Capacity Metrics app and navigate to **Items** > sort by
**CU (s)** descending.

- [ ] Record the top 5 items by CU consumption.
- [ ] Note whether the top consumers are **interactive** (queries, reports)
      or **background** (refreshes, dataflows, Spark jobs).
- [ ] Check which **workspace** owns each top consumer.

### Step 4: Check for runaway operations

```kql
// Fabric capacity utilization — last 6 hours
FabricEvents
| where TimeGenerated > ago(6h)
| where CapacityName == "<capacity-name>"
| where OperationName == "QueryEnd" or OperationName == "RefreshEnd"
| summarize TotalCU = sum(CUSeconds), Count = count() by WorkspaceName, ItemName
| order by TotalCU desc
| take 20
```

- [ ] Look for a single item consuming more than 40% of total CU.
- [ ] Check for repeated failures that trigger automatic retries (each retry
      consumes CU).

### Step 5: Classify severity and move to response

| Condition                             | Severity |
| ------------------------------------- | -------- |
| Active throttling, user-facing impact | P1       |
| CU > 90% sustained, reports slow      | P2       |
| CU trending upward, no current impact | P3       |

---

## Response Actions

### P1 — Critical: Active Throttling

!!! danger
Active throttling means user queries are being delayed or rejected.
Act immediately.

- [ ] **Scale up the capacity** to the next SKU tier:

```bash
az fabric capacity update \
  --capacity-name <capacity-name> \
  --resource-group <rg> \
  --sku-name F16   # adjust to next tier above current
```

- [ ] **Pause non-critical workloads** — in the Fabric portal, navigate to
      workspace settings for non-production workspaces and pause scheduled
      refreshes.
- [ ] **Kill runaway Spark sessions** — in the Fabric portal, go to
      **Monitoring hub** > **Spark applications** > cancel long-running jobs
      that are not time-sensitive.
- [ ] **Notify stakeholders** using the communication template in section 7.
- [ ] **Monitor** — confirm CU drops below 80% within 15 minutes of scaling.

### P2 — Degraded: High Utilization

- [ ] Identify the top 3 CU consumers from the Capacity Metrics app.
- [ ] For **heavy refreshes**: reschedule to off-peak hours or stagger start
      times by 15-minute intervals.
- [ ] For **expensive queries**: check for missing aggregations, unnecessary
      DAX calculations, or reports scanning full tables (see Optimization
      Tactics below).
- [ ] For **Spark jobs**: review cluster sizing and consider switching to
      smaller, more frequent batch windows.
- [ ] Plan a capacity SKU review for the next sprint if utilization has
      trended above 80% for 7+ consecutive days.

### P3 — Warning: Approaching Limits

- [ ] Review the scheduled refresh calendar for overlap patterns.
- [ ] Audit workspace assignments — ensure dev/test workloads are not
      running on the production capacity.
- [ ] Evaluate whether Import models can be converted to DirectLake to
      reduce refresh CU cost.
- [ ] Create a capacity planning ticket for the next quarter.

---

## Capacity Sizing Guide

| Workload Profile                                  | Recommended SKU | CU/s | Typical Use Case                       |
| ------------------------------------------------- | --------------- | ---- | -------------------------------------- |
| Small team, < 10 reports, light refresh           | F2              | 2    | Proof of concept, dev/test             |
| Department, 10-30 reports, hourly refresh         | F4              | 4    | Single team analytics                  |
| Multi-team, 30-100 reports, Spark notebooks       | F8              | 8    | Cross-functional analytics             |
| Enterprise, 100+ reports, heavy ETL, DirectLake   | F16             | 16   | Production analytics platform          |
| Large enterprise, real-time + batch, ML workloads | F32             | 32   | Data platform with ML/AI               |
| Mission-critical, high concurrency, low latency   | F64             | 64   | Enterprise-wide, SLA-bound deployments |

!!! tip
Start one SKU below your estimate. Fabric's burst capability handles
temporary spikes. Scale up only if sustained utilization exceeds 80%
for 7+ days.

For a deeper breakdown of CU mechanics, burst windows, and smoothing
behavior, see
[Capacity Planning & Cost Optimization](https://fgarofalo56.github.io/Suppercharge_Microsoft_Fabric/best-practices/capacity-planning-cost-optimization/)
on the Supercharge Microsoft Fabric companion site.

---

## Optimization Tactics

### Query and Report Optimization

- [ ] **Remove unused visuals** — each visual on a report page fires a
      separate query. Fewer visuals = fewer CU seconds.
- [ ] **Use aggregations** — pre-aggregated tables reduce scan volume by
      orders of magnitude for summary reports.
- [ ] **Avoid complex DAX iterators** on large tables — `SUMX`, `FILTER`
      over millions of rows are CU-expensive. Push logic to the lakehouse
      SQL layer where possible.
- [ ] **Enable query caching** — in dataset settings, turn on "Enhanced
      metadata" and query caching for stable reports.

### Storage and Refresh Optimization

- [ ] **DirectLake over Import** — DirectLake models skip the refresh step
      entirely, eliminating refresh CU cost. Requires Delta tables in
      OneLake.
- [ ] **Incremental refresh** — for Import models that cannot move to
      DirectLake, configure incremental refresh to process only changed
      partitions.
- [ ] **Materialized views** — create materialized views in the SQL
      analytics endpoint for frequently queried aggregations.

### Scheduling and Concurrency

- [ ] **Stagger refreshes** — space scheduled refreshes at least 10 minutes
      apart to avoid burst stacking.
- [ ] **Separate capacities** — assign dev/test workspaces to a cheaper
      F2/F4 capacity. Never share production capacity with ad-hoc
      exploration.
- [ ] **Off-peak heavy jobs** — schedule Spark notebooks and large dataflows
      outside business hours (e.g., 02:00-05:00 UTC).

### Import vs. DirectQuery Decision Matrix

| Factor            | Import / DirectLake      | DirectQuery           |
| ----------------- | ------------------------ | --------------------- |
| Query latency     | Sub-second (cached)      | Source-dependent      |
| CU cost — query   | Lower (compressed scans) | Higher (live queries) |
| CU cost — refresh | Periodic cost            | None                  |
| Data freshness    | Refresh-dependent        | Real-time             |
| Best for          | Dashboards, aggregations | Operational reporting |

---

## Monitoring Setup

### Capacity Metrics App

- [ ] Install the **Microsoft Fabric Capacity Metrics** app from AppSource.
- [ ] Share the app with the on-call rotation and Fabric admins.
- [ ] Pin the **Utilization** and **Throttling** pages to a shared
      dashboard.

### Custom Alerts via Azure Monitor

```bash
# Create an alert rule for sustained high CU utilization
az monitor metrics alert create \
  --name "Fabric-CU-High" \
  --resource-group <rg> \
  --scopes "/subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.Fabric/capacities/<capacity-name>" \
  --condition "avg CapacityUtilization > 90" \
  --window-size 30m \
  --evaluation-frequency 5m \
  --action-group <action-group-id> \
  --description "Fabric capacity CU utilization above 90% for 30 minutes"
```

### Key Metrics to Track

| Metric                       | Threshold   | Alert Severity |
| ---------------------------- | ----------- | -------------- |
| CU utilization (avg 30 min)  | > 90%       | Warning        |
| CU utilization (avg 30 min)  | > 100%      | Critical       |
| Throttling events (count/hr) | > 0         | Critical       |
| Queued operations (count)    | > 10        | Warning        |
| Refresh duration (p95)       | > 2x normal | Warning        |

---

## Escalation

### When to Engage Microsoft Support

- [ ] Throttling persists after scaling to the maximum available SKU.
- [ ] The Capacity Metrics app shows utilization below 50% but throttling
      is still occurring (potential platform bug).
- [ ] Capacity provisioning or scaling commands fail with Azure errors.
- [ ] Unexplained CU spikes with no matching workload in the Monitoring hub.

### How to File a Support Ticket

```bash
# Open the Azure support blade directly
az support tickets create \
  --ticket-name "Fabric-Throttle-$(date +%Y%m%d)" \
  --severity "critical" \
  --problem-classification "/providers/Microsoft.Support/services/fabric/..." \
  --description "Fabric capacity <capacity-name> throttled despite scaling to F64. Details: ..."
```

Include in the ticket:

- [ ] Capacity name, subscription ID, region.
- [ ] Capacity Metrics app screenshots (last 24h utilization + throttling).
- [ ] List of top CU consumers (workspace, item, CU seconds).
- [ ] Timeline of scaling actions taken.

### When to Request a Capacity Increase

- [ ] Sustained utilization above 80% for 14+ consecutive days.
- [ ] Projected workload growth will exceed current SKU within 30 days.
- [ ] New workload (e.g., ML training, large-scale ETL) is being onboarded.

---

## Communication Templates

### Internal notification (P1/P2)

> **Subject:** [P1/P2] Fabric Capacity Throttling — `<capacity-name>`
>
> **Detected:** `<timestamp UTC>`
> **Impact:** Reports and refreshes on capacity `<capacity-name>` are
> throttled. Users may experience slow or failed queries.
> **Status:** Investigating / Scaling / Resolved
> **Actions taken:** `<bullet list>`
> **Next update:** `<time>`

---

## Contact Information

!!! warning
**Action Required:** Populate these before first production use.

| Role              | Contact                                                                                     | Phone                        | Escalation            |
| ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------- | --------------------- |
| Fabric Admin      | _(your Fabric admin)_                                                                       | _(see PagerDuty / OpsGenie)_ | First responder       |
| Platform Eng Lead | _(your platform team lead)_                                                                 | _(see PagerDuty / OpsGenie)_ | P1/P2 escalation      |
| FinOps Lead       | _(your FinOps contact)_                                                                     | _(DL)_                       | Cost/sizing decisions |
| Microsoft Support | [Azure Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A                          | Platform-level issues |

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

- [Supercharge Microsoft Fabric — Capacity Planning & Cost Optimization](https://fgarofalo56.github.io/Suppercharge_Microsoft_Fabric/best-practices/capacity-planning-cost-optimization/) — CU mechanics, burst behavior, right-sizing, and FinOps patterns
- [Supercharge Microsoft Fabric — FinOps & Cost Governance](https://fgarofalo56.github.io/Suppercharge_Microsoft_Fabric/best-practices/finops-cost-governance/) — automated cost controls and alerting
- [Supercharge Microsoft Fabric — Cost Estimation](https://fgarofalo56.github.io/Suppercharge_Microsoft_Fabric/COST_ESTIMATION/) — calculator and sizing worksheets
- [Data Pipeline Failure](./data-pipeline-failure.md) — ADF / Synapse pipeline failure triage
- [Databricks Cost Runaway](./databricks-cost-runaway.md) — Databricks cost management
- [DR Drill](./dr-drill.md) — region-level failover procedures
- [Troubleshooting](../TROUBLESHOOTING.md) — general triage
