[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **Cost Alert Response**

# Runbook — Cost Alert Response

> **Scope:** Triage and resolution of Azure Cost Management alerts across all CSA-in-a-Box subscriptions. Covers budget threshold responses, cost anomaly investigation, optimization playbooks, and preventive controls for ongoing cost governance.

---

## Before First Use — Customization Checklist

- [ ] Populate the [Contact Information](#contact-information) table.
- [ ] Confirm subscription and resource group naming conventions match your environment.
- [ ] Set up budget alerts at 50%, 80%, 100%, and 120% thresholds in Azure Cost Management.
- [ ] Confirm tag enforcement policy is active (required tags: `costCenter`, `environment`, `owner`).
- [ ] Verify Azure Advisor cost recommendations are reviewed monthly.

---

## Symptoms

| Symptom                                 | Where you see it                                  | Severity                |
| --------------------------------------- | ------------------------------------------------- | ----------------------- |
| Budget alert triggered (80%+ threshold) | Email / action group notification                 | P2–P1 depending on tier |
| Unexpected resource creation            | Azure Activity Log, Cost Management anomaly alert | P2                      |
| Cost anomaly detected by Azure          | Azure Cost Management anomaly alerts              | P2                      |
| Forecast exceeding budget by > 20%      | Azure Cost Management forecast view               | P3                      |
| Orphaned resources accumulating charges | Azure Advisor, resource group review              | P3                      |
| Cross-region data transfer spike        | Network cost breakdown in Cost Analysis           | P3                      |

---

## Triage

### Step 1 — Check Azure Cost Management for anomaly details

- [ ] Open [Azure Cost Management + Billing](https://portal.azure.com/#view/Microsoft_Azure_CostManagement) and navigate to **Cost analysis**.
- [ ] Set the time range to the current billing period and compare against the prior period.
- [ ] Check the **Anomaly detection** blade for auto-flagged spikes.

```bash
# Quick CLI check — current month cost by resource group
az consumption usage list \
  --start-date "$(date -u +%Y-%m-01)" \
  --end-date "$(date -u +%Y-%m-%d)" \
  --query "sort_by([].{rg:instanceName, cost:pretaxCost, currency:currency}, &cost)" \
  -o table
```

### Step 2 — Identify the cost driver

- [ ] Use Cost Analysis **Group by** to drill down by resource group, service name, region, and tag.
- [ ] Run the following KQL against your Log Analytics workspace to correlate resource creation with cost spikes:

```kql
AzureActivity
| where TimeGenerated > ago(7d)
| where OperationNameValue has "Microsoft.Resources/deployments/write"
    or OperationNameValue has "Microsoft.Compute/virtualMachines/write"
    or OperationNameValue has "Microsoft.Storage/storageAccounts/write"
| project TimeGenerated, Caller, ResourceGroup, OperationNameValue, ActivityStatusValue
| order by TimeGenerated desc
```

### Step 3 — Determine if cost is legitimate or waste

- [ ] Cross-reference newly created resources with active project tasks and deployment pipelines.
- [ ] Check if the cost driver maps to an approved change request or sprint story.
- [ ] If no owner can be identified, treat as potential waste and escalate.

### Step 4 — Check for orphaned resources

- [ ] Run Azure Advisor cost recommendations:

```bash
az advisor recommendation list --category Cost \
  --query '[].{resource:resourceMetadata.resourceId, impact:impact, problem:shortDescription.problem}' \
  -o table
```

- [ ] Look for unattached disks, idle VMs, empty App Service plans, and unused public IPs:

```bash
# Unattached managed disks
az disk list --query "[?diskState=='Unattached'].{name:name, rg:resourceGroup, sizeGb:diskSizeGb, sku:sku.name}" -o table

# Stopped (deallocated) VMs still incurring storage charges
az vm list -d --query "[?powerState!='VM running'].{name:name, rg:resourceGroup, size:hardwareProfile.vmSize}" -o table
```

---

## Response Actions by Alert Tier

### 80% Budget — Review and Forecast

!!! tip
At 80% you have time to optimize before hard limits. Focus on forecasting and identifying quick wins.

- [ ] **Review the forecast.** Will spend exceed budget at current run rate?

```bash
# Forecast remaining spend (requires Cost Management API)
az consumption forecast list \
  --query '{currentSpend:totalCost, forecastedSpend:forecastedCost, budget:budget}' \
  -o table
```

- [ ] **Identify optimization opportunities.** Run through the [Common Cost Drivers](#common-cost-drivers) table below.
- [ ] **Right-size underutilized resources.** Check Azure Advisor for right-sizing recommendations.
- [ ] **Review Reserved Instance coverage.** Are any expiring or underutilized?
- [ ] **Document findings** and share with the cost owner for awareness.

### 100% Budget — Escalate and Reduce

!!! warning
Budget is fully consumed. Immediate action required to prevent overspend.

- [ ] **Notify the cost owner** (see Contact Information) with a cost breakdown by service and resource group.
- [ ] **Implement immediate reductions:**
    - Shut down non-production environments outside business hours.
    - Scale down dev/test clusters to minimum viable size.
    - Pause non-critical batch jobs and data pipelines.
- [ ] **Freeze non-essential deployments** until spend is under control.
- [ ] **Request budget increase** if the overspend is due to legitimate, approved growth. Requires finance and management approval.

### 120% Budget — Emergency Cost Reduction

!!! danger
Significant overspend. Escalate to management immediately and take emergency measures.

- [ ] **Escalate to management** with a full cost impact analysis.
- [ ] **Scale down non-production environments** to the absolute minimum:

```bash
# Scale down non-prod AKS clusters to 1 node
az aks nodepool update \
  --resource-group <rg-dev> --cluster-name <aks-dev> \
  --name <nodepool> --min-count 1 --max-count 1

# Deallocate non-prod VMs
az vm deallocate --resource-group <rg-dev> --name <vm-name>
```

- [ ] **Enable auto-shutdown** on all dev/test VMs immediately:

```bash
az vm auto-shutdown \
  --resource-group <rg> --name <vm-name> \
  --time 1900 --timezone "UTC"
```

- [ ] **Review and delete orphaned resources** identified in triage Step 4.
- [ ] **Suspend non-critical data pipelines** (ADF triggers, Databricks scheduled jobs).
- [ ] **Schedule a cost review meeting** within 48 hours with all cost owners.

---

## Common Cost Drivers

| Service                   | Common Cause                                                        | Fix                                                                            |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Compute (VMs, AKS)        | Oversized VMs, idle clusters, no auto-scaling                       | Right-size via Advisor, enable cluster autoscaler, auto-shutdown dev/test      |
| Storage                   | Forgotten snapshots, no lifecycle policy, uncompressed data         | Apply lifecycle policies, delete stale snapshots, enable compression           |
| Networking                | Cross-region data transfer, unoptimized egress, idle load balancers | Use VNet peering, enable CDN for static content, remove idle LBs               |
| AI/ML (OpenAI, Cognitive) | GPU idle time, prompt waste, no caching                             | Use spot instances, implement prompt caching, use Batch API                    |
| Databases (SQL, Cosmos)   | Over-provisioned DTUs/RUs, idle replicas, no auto-scale             | Enable serverless tier, auto-scale RUs, remove unused replicas                 |
| App Service               | Empty or oversized plans, unused slots                              | Consolidate apps, scale down plans, delete unused deployment slots             |
| Key Vault                 | High transaction volume from polling                                | Switch to event-driven refresh, increase cache TTL                             |
| Log Analytics             | Excessive log ingestion, no data retention policy                   | Set retention policies, filter noisy logs, use Basic tier for low-value tables |

---

## Optimization Playbook

### Reserved Instances vs Pay-As-You-Go

- [ ] **Analyze usage patterns** over the last 30–90 days for stable workloads.
- [ ] If a resource runs > 60% of the time with predictable sizing, evaluate 1-year or 3-year reservations.
- [ ] Use the Azure Reservation recommendation engine:

```bash
az consumption reservation recommendation list \
  --scope "Single" \
  --resource-type "VirtualMachines" \
  --look-back-period "Last30Days" \
  -o table
```

### Spot instance strategy

- [ ] Use spot VMs for fault-tolerant workloads: batch processing, CI/CD agents, dev/test environments.
- [ ] Set max price to the pay-as-you-go rate to avoid surprise charges.
- [ ] Implement eviction handling in application code.

### Dev/test vs production pricing

- [ ] Ensure all non-production subscriptions use **Dev/Test pricing** (Enterprise Agreement benefit).
- [ ] Validate the subscription offer type:

```bash
az account show --query '{name:name, offerType:tenantDefaultDomain}' -o table
```

- [ ] Move dev/test workloads to dev/test subscriptions if they are running on production pricing.

### Resource tagging for chargeback

Enforce the following tags on every resource for cost allocation:

| Tag            | Purpose                         | Example                  |
| -------------- | ------------------------------- | ------------------------ |
| `costCenter`   | Finance chargeback code         | `CC-1234`                |
| `environment`  | Deployment environment          | `dev`, `staging`, `prod` |
| `owner`        | Team or individual responsible  | `platform-team`          |
| `project`      | Project or workload name        | `csa-inabox`             |
| `autoShutdown` | Eligible for scheduled shutdown | `true` / `false`         |

- [ ] Enforce tags via Azure Policy (deny deployment if required tags are missing).

### Azure Advisor recommendations

- [ ] Review Azure Advisor cost recommendations weekly:

```bash
az advisor recommendation list --category Cost -o table
```

- [ ] Track recommendation adoption rate as a KPI in monthly cost reviews.

---

## Preventive Controls

### Budget alerts setup

- [ ] Configure budget alerts at multiple thresholds:

```bash
az consumption budget create \
  --budget-name "csa-monthly-budget" \
  --amount 10000 --time-grain Monthly \
  --start-date "$(date -u +%Y-%m-01)" \
  --end-date "$(date -u -d '+1 year' +%Y-%m-01)" \
  --resource-group <rg> \
  --notifications '{
    "Actual_GreaterThan_80_Percent": {
      "enabled": true,
      "operator": "GreaterThan",
      "threshold": 80,
      "contactEmails": ["platform-team@contoso.com"],
      "contactRoles": ["Owner"]
    }
  }'
```

### Policy-based resource restrictions

- [ ] Deny creation of expensive SKUs in non-production subscriptions:

```json
{
    "if": {
        "allOf": [
            { "field": "type", "equals": "Microsoft.Compute/virtualMachines" },
            {
                "field": "Microsoft.Compute.virtualMachines/sku.name",
                "notIn": ["Standard_B2s", "Standard_B2ms", "Standard_D2s_v5"]
            },
            {
                "field": "[concat('tags[', 'environment', ']')]",
                "in": ["dev", "test"]
            }
        ]
    },
    "then": { "effect": "deny" }
}
```

- [ ] Restrict expensive regions unless explicitly approved.
- [ ] Limit the number of public IP addresses per subscription.

### Tag enforcement

- [ ] Deploy the `Require tag and its value` built-in policy for `costCenter`, `environment`, and `owner`.
- [ ] Use `Modify` effect to auto-apply default tags to resources that are missing them.

### Scheduled shutdown

- [ ] Apply auto-shutdown to all dev/test VMs (default 7:00 PM local time).
- [ ] Use Azure Automation runbooks or start/stop v2 solution for AKS clusters and other compute.
- [ ] Verify shutdown compliance weekly:

```kql
AzureActivity
| where TimeGenerated > ago(7d)
| where OperationNameValue == "Microsoft.Compute/virtualMachines/deallocate/action"
| summarize shutdownCount = count() by ResourceGroup, bin(TimeGenerated, 1d)
| order by TimeGenerated desc
```

---

## Reporting

### Monthly cost review template

Use the following agenda for monthly cost review meetings:

1. **Budget vs actual** — current month and trailing 3-month trend.
2. **Top 5 cost drivers** — by service, resource group, and tag.
3. **Anomalies** — any flagged anomalies and their root cause.
4. **Optimization actions** — completed and planned.
5. **Reservation coverage** — utilization and upcoming expirations.
6. **Advisor score** — number of open vs adopted recommendations.
7. **Forecast** — projected spend for the next 30, 60, 90 days.

### Chargeback dashboard

- [ ] Build an Azure Cost Management workbook grouped by `costCenter` tag.
- [ ] Share the workbook with finance and department leads monthly.
- [ ] Include per-team trend lines and month-over-month delta.

### Trend analysis KQL

```kql
// Daily cost trend by resource group — last 30 days
AzureMetrics
| where TimeGenerated > ago(30d)
| where MetricName == "CostUSD"
| summarize dailyCost = sum(Total) by bin(TimeGenerated, 1d), ResourceGroup = _ResourceId
| render timechart
```

---

## Contact Information

!!! warning
**Action Required:** Populate these before first production use.

| Role                     | Contact                                                                                        | Phone                        | Escalation                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------ |
| Cost Owner / FinOps Lead | _(set via your org's finance team)_                                                            | _(office hours)_             | Budget exceeded events               |
| Platform Team Lead       | _(set via your org's platform team)_                                                           | _(see PagerDuty / OpsGenie)_ | Resource optimization                |
| Subscription Owner       | _(per-subscription — see governance RBAC)_                                                     | _(DL)_                       | Policy exceptions                    |
| Azure Support            | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A                          | Billing disputes, reservation issues |

---

## Related Documentation

- [OpenAI Throttling](./openai-throttling.md) — AI/ML cost drivers and optimization
- [Key Rotation](./key-rotation.md) — Credential lifecycle (cost-neutral but related governance)
- [Tenant Onboarding](./tenant-onboarding.md) — Budget setup for new tenants
- [DR Drill](./dr-drill.md) — Cost implications of DR failover
- [Data Pipeline Failure](./data-pipeline-failure.md) — Pipeline cost during failure/retry storms
