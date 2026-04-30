# Dashboard Migration: Visualizations to Azure Workbooks and Managed Grafana

**Audience:** SREs, Platform Engineers, DevOps Leads, BI Analysts
**Source platforms:** Datadog Dashboards, New Relic One Dashboards, Splunk Observability Dashboards, Grafana (self-hosted)
**Target:** Azure Workbooks, Azure Managed Grafana, Power BI
**Last updated:** 2026-04-30

---

## Overview

Dashboards are the most visible artifact in any observability platform. They are also among the most labor-intensive to migrate because they combine data queries, visualization configurations, and layout decisions that do not translate automatically between platforms. This guide provides strategies and patterns for migrating dashboards to Azure Monitor.

Azure provides three dashboard targets:

| Target                    | Best for                                                                  | Query language            | Cost                                     |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------- | ---------------------------------------- |
| **Azure Workbooks**       | Azure-native monitoring, operational dashboards, compliance reports       | KQL                       | Free (included with Log Analytics)       |
| **Azure Managed Grafana** | Teams with Grafana expertise, multi-source dashboards, Prometheus metrics | KQL + PromQL + SQL        | ~$360-720/month per instance             |
| **Power BI**              | Business observability, executive dashboards, cross-domain analytics      | KQL (via connector) + DAX | Part of Microsoft 365 / Fabric licensing |

---

## Azure Workbooks

Azure Workbooks are the native dashboard and reporting tool for Azure Monitor. They provide interactive, parameterized reports that combine text, KQL queries, metrics, and visualizations.

### Workbook components

| Component           | Description                                                  | Equivalent in Datadog/NR       |
| ------------------- | ------------------------------------------------------------ | ------------------------------ |
| KQL query step      | Execute KQL against Log Analytics or Application Insights    | DQL/NRQL query widget          |
| Metrics query step  | Query Azure Monitor Metrics                                  | Metric graph widget            |
| Parameters          | Drop-down filters (subscription, resource group, time range) | Template variables             |
| Text step           | Markdown-formatted documentation                             | Text widget                    |
| Chart visualization | Line, area, bar, scatter, pie                                | Chart widgets                  |
| Grid visualization  | Tabular data with conditional formatting                     | Table widget                   |
| Map visualization   | Geographic data on Azure Map                                 | Geomap widget                  |
| Tile visualization  | Single value with sparkline                                  | Top list / single value widget |

### Creating a workbook: Application performance overview

```json
{
    "version": "Notebook/1.0",
    "items": [
        {
            "type": 9,
            "content": {
                "version": "KqlParameterItem/1.0",
                "parameters": [
                    {
                        "name": "TimeRange",
                        "type": 4,
                        "defaultValue": "Last 1 hour"
                    },
                    {
                        "name": "Application",
                        "type": 2,
                        "query": "AppRequests | distinct AppRoleName",
                        "multiSelect": true
                    }
                ]
            }
        },
        {
            "type": 3,
            "content": {
                "version": "KqlItem/1.0",
                "query": "AppRequests | where TimeGenerated {TimeRange} | where AppRoleName in ({Application}) | summarize RequestCount = count(), AvgDuration = avg(DurationMs), ErrorRate = countif(Success == false) * 100.0 / count() by bin(TimeGenerated, 5m) | render timechart",
                "size": 0,
                "title": "Request Volume, Latency, and Error Rate",
                "visualization": "timechart"
            }
        },
        {
            "type": 3,
            "content": {
                "version": "KqlItem/1.0",
                "query": "AppRequests | where TimeGenerated {TimeRange} | where AppRoleName in ({Application}) | summarize P50 = percentile(DurationMs, 50), P90 = percentile(DurationMs, 90), P99 = percentile(DurationMs, 99) by Name | order by P99 desc | take 20",
                "size": 0,
                "title": "Top 20 Slowest Endpoints (P50/P90/P99)",
                "visualization": "table"
            }
        }
    ]
}
```

### Pre-built workbook gallery

Azure Monitor includes 40+ pre-built workbook templates. These cover common dashboard patterns that would otherwise need manual recreation.

| Category             | Templates available                             | Replaces                                    |
| -------------------- | ----------------------------------------------- | ------------------------------------------- |
| Application Insights | Performance, failures, usage, availability      | Datadog APM Dashboard, NR APM Overview      |
| VM Insights          | Performance, connections, health                | Datadog Host Dashboard, NR Infrastructure   |
| Container Insights   | Cluster, nodes, controllers, containers         | Datadog Kubernetes Dashboard, NR Kubernetes |
| Network              | NSG flow, Traffic Analytics, Connection Monitor | Datadog Network Performance                 |
| Key Vault            | Operations, failures, latency                   | Custom integrations                         |
| Storage              | Capacity, availability, transactions            | Custom integrations                         |
| AKS                  | Workload, GPU, namespace                        | Datadog AKS Dashboard                       |

---

## Azure Managed Grafana

For organizations with existing Grafana expertise and dashboard assets, Azure Managed Grafana provides a fully managed Grafana instance backed by Azure Monitor data sources.

### Connecting Grafana to Azure Monitor

Azure Managed Grafana automatically configures the Azure Monitor data source. No manual configuration is needed for:

- Azure Monitor Metrics
- Azure Monitor Logs (Log Analytics via KQL)
- Azure Resource Graph
- Azure Data Explorer (ADX)
- Azure Monitor managed Prometheus

### Migrating Grafana dashboards

If you are running self-hosted Grafana or Grafana Cloud and want to migrate to Azure Managed Grafana:

1. **Export dashboards** from the source Grafana instance as JSON
2. **Import dashboards** into Azure Managed Grafana via the UI or API
3. **Update data source references** to point to Azure Monitor data sources
4. **Adjust queries** if migrating from Prometheus to Azure Monitor Metrics (PromQL to KQL) or keep PromQL if using Managed Prometheus

**Dashboard JSON import (API):**

```bash
# Export from source Grafana
curl -H "Authorization: Bearer $SOURCE_TOKEN" \
  "https://source-grafana.example.com/api/dashboards/uid/abc123" \
  > dashboard.json

# Import to Azure Managed Grafana
curl -X POST \
  -H "Authorization: Bearer $AZURE_TOKEN" \
  -H "Content-Type: application/json" \
  "https://my-grafana.azgrafana.io/api/dashboards/db" \
  -d @dashboard.json
```

### Grafana community dashboards

Azure Managed Grafana supports importing community dashboards from [grafana.com/grafana/dashboards](https://grafana.com/grafana/dashboards). Popular dashboards for Azure Monitor include:

| Dashboard ID | Name                       | Use case                    |
| ------------ | -------------------------- | --------------------------- |
| 14891        | Azure Monitor - Kubernetes | AKS cluster overview        |
| 10956        | Azure Monitor - VM         | Virtual machine performance |
| 12006        | Azure Monitor - Networking | Network performance         |

---

## Migrating specific dashboard patterns

### Pattern 1: Service overview dashboard

**Source (Datadog):** APM Service page with request rate, error rate, latency percentiles, and dependency health.

**Azure Workbook equivalent:**

```kusto
// Request rate and error rate over time
AppRequests
| where TimeGenerated > ago(1h)
| where AppRoleName == "order-service"
| summarize
    RequestRate = count() / (60 * 5),  // requests per second (5-min buckets)
    ErrorRate = countif(Success == false) * 100.0 / count()
    by bin(TimeGenerated, 5m)
| render timechart

// Latency percentiles over time
AppRequests
| where TimeGenerated > ago(1h)
| where AppRoleName == "order-service"
| summarize
    P50 = percentile(DurationMs, 50),
    P90 = percentile(DurationMs, 90),
    P99 = percentile(DurationMs, 99)
    by bin(TimeGenerated, 5m)
| render timechart

// Dependency health
AppDependencies
| where TimeGenerated > ago(1h)
| where AppRoleName == "order-service"
| summarize
    CallCount = count(),
    FailRate = countif(Success == false) * 100.0 / count(),
    AvgDuration = avg(DurationMs)
    by Target, Type
| order by FailRate desc
```

### Pattern 2: Infrastructure overview dashboard

**Source (Datadog/NR):** Host map with CPU, memory, disk utilization across fleet.

**Azure Workbook equivalent:**

```kusto
// VM fleet health summary
Perf
| where TimeGenerated > ago(15m)
| where ObjectName == "Processor" and CounterName == "% Processor Time"
| summarize AvgCPU = avg(CounterValue) by Computer
| extend Status = case(AvgCPU > 90, "Critical",
                       AvgCPU > 75, "Warning",
                       "Healthy")
| summarize Count = count() by Status

// Memory utilization by host
Perf
| where TimeGenerated > ago(15m)
| where ObjectName == "Memory" and CounterName == "% Used Memory"
| summarize AvgMemory = avg(CounterValue) by Computer
| order by AvgMemory desc
```

### Pattern 3: Kubernetes cluster dashboard

**Source (Datadog Kubernetes Dashboard):** Pod status, node resource usage, container restarts.

**Azure Workbook / Container Insights equivalent:**

```kusto
// Pod status summary
KubePodInventory
| where TimeGenerated > ago(5m)
| summarize Count = count() by PodStatus
| order by Count desc

// Container restart count (last 24h)
KubePodInventory
| where TimeGenerated > ago(24h)
| summarize Restarts = sum(PodRestartCount) by Name, Namespace
| where Restarts > 0
| order by Restarts desc

// Node CPU utilization
InsightsMetrics
| where TimeGenerated > ago(15m)
| where Namespace == "container.azm.ms/cpu"
| where Name == "cpuUsagePercentage"
| summarize AvgCPU = avg(Val) by Computer
| order by AvgCPU desc
```

---

## Power BI integration for business observability

Power BI connects natively to Log Analytics via the KQL data connector. This enables business observability dashboards that combine application performance metrics with business KPIs.

**Use cases:**

- Executive SLA dashboard showing application availability alongside business transaction volumes
- Data pipeline monitoring combined with data quality metrics
- Cost attribution dashboard showing observability spend by business unit

**Connection setup:**

1. In Power BI Desktop, select **Get Data > Azure > Azure Data Explorer (Kusto)**
2. Enter the Log Analytics workspace URL: `https://api.loganalytics.io/v1/workspaces/{workspace-id}`
3. Authenticate with Azure AD
4. Write KQL queries for the data you need
5. Build Power BI visuals and publish to Power BI service

```kusto
// KQL query for Power BI: Daily SLA metrics
AppRequests
| where TimeGenerated > ago(30d)
| summarize
    TotalRequests = count(),
    SuccessfulRequests = countif(ResultCode startswith "2"),
    AvailabilityPct = round(countif(ResultCode startswith "2") * 100.0 / count(), 3),
    P95LatencyMs = percentile(DurationMs, 95)
    by Day = bin(TimeGenerated, 1d), AppRoleName
```

---

## Migration strategy

### Recommended approach

1. **Do not attempt 1:1 dashboard migration.** Source dashboards often contain years of organic growth, unused panels, and legacy queries. Migration is an opportunity to rationalize.
2. **Identify the top 10 dashboards** by usage (views per week, unique viewers). Migrate these first.
3. **Use pre-built templates** from the Workbook gallery or Grafana community as starting points rather than rebuilding from scratch.
4. **Convert queries first, visualize second.** Get the KQL queries right before worrying about layout and formatting.
5. **Adopt Managed Grafana for teams with Grafana muscle memory.** Converting 50+ Grafana dashboards to Workbooks is wasted effort if the team prefers Grafana.

### Dashboard migration checklist

- [ ] Inventory all dashboards from source platform (name, owner, view frequency)
- [ ] Identify top 10 high-value dashboards for migration
- [ ] Decide target: Workbooks, Managed Grafana, or both
- [ ] Convert source queries (DQL/NRQL/SPL/PromQL) to KQL
- [ ] Recreate visualizations using Workbook components or Grafana panels
- [ ] Configure Workbook parameters / Grafana variables for filtering
- [ ] Set up dashboard sharing and RBAC
- [ ] Deploy Power BI dashboards for executive/business audience
- [ ] Create dashboard-as-code templates (ARM/Bicep for Workbooks, JSON for Grafana)
- [ ] Validate data accuracy against source dashboards during parallel run

---

**Related:** [Alerting Migration](alerting-migration.md) | [Log Migration](log-migration.md) | [Metrics Migration](metrics-migration.md) | [Tutorial: Log Analytics](tutorial-log-analytics.md)
