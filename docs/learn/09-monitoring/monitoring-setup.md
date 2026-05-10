# Monitoring Setup Guide

[Home](../../README.md) > Monitoring > Monitoring Setup

!!! abstract "Overview"
This guide covers the setup and configuration of monitoring solutions for Azure Synapse Analytics, including Azure Monitor, Log Analytics, and alerting.

## 📊 Monitoring Architecture

Implement comprehensive monitoring for your Azure Synapse Analytics environment to ensure optimal performance, security, and reliability.

<div class="grid cards" markdown>

- ⚙️ __Initial Setup__

---

Configure base monitoring components and permissions

[→ Setup steps](#initial-setup)

- 📈 __Metrics Collection__

---

Configure and collect key performance metrics

[→ Metrics configuration](#metrics-collection)

- 🔍 __Log Analytics__

---

Centralize and analyze diagnostic logs

[→ Log setup](#log-analytics-setup)

- 🔔 __Alerting__

---

Configure proactive alerts and notifications

[→ Alert configuration](#alerting-setup)

</div>

## Reference Architecture

![Secure Data Lakehouse Architecture](https://learn.microsoft.com/en-us/azure/architecture/example-scenario/analytics/media/secure-data-lakehouse-architecture.svg)

## Initial Setup

!!! tip "Best Practice"
Create a dedicated Log Analytics workspace for all Synapse-related monitoring to centralize analysis.

Follow these steps to set up the monitoring foundation:

1. __Create Log Analytics Workspace__:

```bash
az monitor log-analytics workspace create \
  --resource-group myResourceGroup \
  --workspace-name synapse-monitoring \
  --sku PerGB2018
```

1. __Create Action Groups__ for notifications:

```bash
az monitor action-group create \
  --resource-group myResourceGroup \
  --name synapse-critical-alerts \
  --short-name synapseAlert \
  --email-receiver name=opsTeam email=ops@contoso.com
```

1. __Enable Microsoft Insights Provider__:

```bash
az provider register --namespace Microsoft.Insights
```

1. __Assign Monitoring Contributor Role__:

```bash
az role assignment create \
  --assignee "monitoring-service-principal-id" \
  --role "Monitoring Contributor" \
  --scope "/subscriptions/{subscription-id}/resourceGroups/{resource-group}"
```

## Metrics Collection

Configure metrics collection for Azure Synapse Analytics components:

| Component | Key Metrics | Collection Interval |
|-----------|-------------|---------------------|
| SQL Pool | DWU consumption, query duration | 1 minute |
| Spark Pool | Executor count, memory usage | 1 minute |
| Integration Runtime | Pipeline activity duration | 5 minutes |
| Data Lake Storage | Throughput, latency | 1 minute |

!!! example "Azure CLI for Metrics Setup"

```bash
# Enable metrics collection on Synapse workspace
az monitor diagnostic-settings create \
  --name synapse-metrics \
  --resource "/subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/Microsoft.Synapse/workspaces/{workspace}" \
  --workspace "/subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/Microsoft.OperationalInsights/workspaces/{la-workspace}" \
  --metrics '[{"category": "AllMetrics", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}}]'
```

## Log Analytics Setup

!!! warning "Important"
Configure appropriate retention periods based on your compliance requirements and budget considerations.

Configure Log Analytics to collect Synapse diagnostic logs:

1. __Enable Diagnostic Settings__:

```powershell
# PowerShell example for configuring diagnostic settings
$workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName "myResourceGroup" -Name "synapse-monitoring"

Set-AzDiagnosticSetting -ResourceId "/subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/Microsoft.Synapse/workspaces/{workspace}" `
  -WorkspaceId $workspace.ResourceId `
  -Enabled $true `
  -Category SQLSecurityAuditEvents,SynapseRbacOperations,GatewayApiRequests,BuiltinSqlReqsEnded,IntegrationPipelineRuns,IntegrationActivityRuns,IntegrationTriggerRuns
```

1. __Log Categories to Enable__:

| Log Category | Description | Retention |
|--------------|-------------|-----------|
| SQLSecurityAuditEvents | SQL authentication and authorization events | 90 days |
| SynapseRbacOperations | Role-based access control operations | 90 days |
| GatewayApiRequests | API requests through the gateway | 30 days |
| BuiltinSqlReqsEnded | SQL query execution statistics | 30 days |
| IntegrationPipelineRuns | Pipeline execution details | 90 days |
| IntegrationActivityRuns | Activity execution details | 90 days |
| IntegrationTriggerRuns | Trigger execution details | 90 days |

1. __Create Custom Log Queries__:

```kusto
// Query for failed pipeline runs
SynapseIntegrationPipelineRuns
| where Status == "Failed"
| project TimeGenerated, PipelineName, RunId, Parameters, SystemParameters, ErrorMessage
| order by TimeGenerated desc
```

## Alerting Setup

Configure these essential alerts for Azure Synapse Analytics:

1. __Performance Alerts__:
   - SQL Pool DWU/cDWU utilization > 90% for 30 minutes
   - Spark job failures > 5 in an hour
   - Query duration > 60 seconds consistently

2. __Availability Alerts__:
   - Workspace availability < 99.9%
   - Failed connectivity attempts > 10 in 15 minutes
   - Integration runtime availability issues

3. __Security Alerts__:
   - Multiple failed authentication attempts
   - Firewall rule changes
   - Permission changes to sensitive data

!!! example "Alert Rule Creation"

```json
{
  "location": "Global",
  "tags": {},
  "properties": {
    "description": "Alert when SQL pool is near capacity",
    "severity": 2,
    "enabled": true,
    "scopes": [
      "/subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/Microsoft.Synapse/workspaces/{workspace}/sqlPools/{pool-name}"
    ],
    "evaluationFrequency": "PT5M",
    "windowSize": "PT15M",
    "criteria": {
      "allOf": [
        {
          "metricName": "DWULimit",
          "metricNamespace": "Microsoft.Synapse/workspaces/sqlPools",
          "operator": "GreaterThan",
          "threshold": 90,
          "timeAggregation": "Average"
        }
      ]
    },
    "actions": [
      {
        "actionGroupId": "/subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/microsoft.insights/actionGroups/{action-group-name}"
      }
    ]
  }
}
```

## Monitoring Dashboards

Create custom dashboards using Azure Monitor Workbooks:

1. __Executive Dashboard__ - High-level overview of workspace health and usage
2. __Operational Dashboard__ - Detailed performance and availability metrics
3. __Security Dashboard__ - Authentication events and security alerts
4. __Cost Management Dashboard__ - Resource utilization and cost analytics

!!! tip "Dashboard Tip"
Pin the most important metrics and logs to your Azure portal dashboard for quick access.

```json
{
  "lenses": {
"0": {
  "order": 0,
  "parts": {
"0": {
  "position": {
"x": 0,
"y": 0,
"colSpan": 6,
"rowSpan": 4
  },
  "metadata": {
"inputs": [
  {
"name": "resourceTypeMode",
"value": "workspace"
  },
  {
"name": "ComponentId",
"value": "/subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/Microsoft.OperationalInsights/workspaces/{workspace-name}"
  }
],
"type": "Extension/Microsoft_OperationsManagementSuite_Workspace/PartType/LogsDashboardPart",
"settings": {
  "content": {
"Query": "SynapseIntegrationPipelineRuns\n| where Status == \"Failed\"\n| summarize FailedCount=count() by bin(TimeGenerated, 1h), PipelineName\n| render timechart",
"PartTitle": "Failed Pipeline Runs"
  }
}
  }
}
  }
}
  }
}
```

## Automation and Integration

Extend your monitoring setup with these automations:

1. __Automated Remediation__ - Use Azure Automation to automatically resolve common issues
2. __Monitoring as Code__ - Deploy monitoring configurations using ARM templates
3. __Integration with ITSM__ - Connect alerts to ServiceNow or other ITSM systems
4. __Power BI Integration__ - Create rich visualizations from monitoring data

## Implementation Checklist

- [ ] Create Log Analytics workspace for centralized monitoring
- [ ] Configure diagnostic settings for all Synapse components
- [ ] Set up action groups for notifications
- [ ] Create custom log queries for common scenarios
- [ ] Configure performance, availability, and security alerts
- [ ] Create monitoring dashboards for different stakeholders
- [ ] Implement automation for common remediation tasks
- [ ] Document monitoring architecture and alert procedures

## Related Resources

- [Azure Monitor for Synapse Analytics](https://learn.microsoft.com/en-us/azure/synapse-analytics/monitoring/monitor-azure-synapse-analytics-using-azure-monitor)
- [Log Analytics Query Examples](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/log-analytics-tutorial)
- [Azure Monitor Workbooks](https://learn.microsoft.com/en-us/azure/azure-monitor/visualize/workbooks-overview)
