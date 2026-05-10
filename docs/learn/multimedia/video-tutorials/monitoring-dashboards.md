---
title: "Video Script: Monitoring Dashboards for Azure Synapse"
tags:
  - multimedia
  - video
---
# Video Script: Monitoring Dashboards for Azure Synapse

![Duration: 25 minutes](https://img.shields.io/badge/Duration-25%20minutes-blue)
![Level: Intermediate](https://img.shields.io/badge/Level-Intermediate-yellow)
![Version: 1.0](https://img.shields.io/badge/Version-1.0-blue)

## Video Metadata

- **Title**: Building Monitoring Dashboards for Azure Synapse Analytics
- **Duration**: 25:00
- **Target Audience**: Data engineers, platform administrators
- **Skill Level**: Intermediate
- **Prerequisites**:
  - Azure Synapse workspace
  - Log Analytics workspace
  - Power BI Desktop
  - Understanding of KQL (Kusto Query Language)

## Learning Objectives

1. Configure diagnostic settings for Synapse workspace
2. Create custom KQL queries for monitoring
3. Build Power BI dashboards for Synapse metrics
4. Set up alerting rules
5. Monitor SQL pool, Spark pool, and pipeline performance
6. Implement cost monitoring

## Video Script

### Opening (0:00 - 1:00)

**NARRATOR**:
"You can't improve what you don't measure. In this tutorial, you'll learn how to build comprehensive monitoring dashboards for Azure Synapse Analytics, giving you real-time visibility into performance, costs, and potential issues before they impact your users."

### Section 1: Diagnostic Settings (1:00 - 5:00)

#### Configure Log Analytics (1:00 - 3:00)

```bash
# Create Log Analytics workspace
az monitor log-analytics workspace create \
  --resource-group synapse-monitoring-rg \
  --workspace-name synapse-logs \
  --location eastus2

# Enable diagnostic settings for Synapse workspace
az monitor diagnostic-settings create \
  --name synapse-diagnostics \
  --resource /subscriptions/{sub-id}/resourceGroups/synapse-rg/providers/Microsoft.Synapse/workspaces/mysynapse \
  --logs '[
    {"category": "SynapseRbacOperations", "enabled": true},
    {"category": "GatewayApiRequests", "enabled": true},
    {"category": "SQLSecurityAuditEvents", "enabled": true},
    {"category": "BuiltinSqlReqsEnded", "enabled": true}
  ]' \
  --metrics '[
    {"category": "AllMetrics", "enabled": true}
  ]' \
  --workspace /subscriptions/{sub-id}/resourceGroups/synapse-monitoring-rg/providers/Microsoft.OperationalInsights/workspaces/synapse-logs
```

#### Log Categories (3:00 - 5:00)

**Key Log Categories**:
- `SynapseRbacOperations`: RBAC changes
- `SQLSecurityAuditEvents`: SQL audit logs
- `BuiltinSqlReqsEnded`: Serverless SQL queries
- `SynapseSqlPoolExecRequests`: Dedicated SQL queries
- `SynapseSqlPoolDmsWorkers`: Data movement
- `SynapseSqlPoolWaits`: SQL pool wait statistics
- `SynapseSparkJobsEnded`: Spark job completion

### Section 2: KQL Queries (5:00 - 12:00)

#### SQL Pool Monitoring (5:00 - 7:30)

```kusto
// Long-running queries
SynapseSqlPoolExecRequests
| where TimeGenerated > ago(24h)
| where DurationMs > 60000  // Over 1 minute
| project
    TimeGenerated,
    ResourceId,
    Command,
    DurationMs,
    RowCount,
    Status,
    SubmittedBy
| order by DurationMs desc
| take 50

// Query performance trends
SynapseSqlPoolExecRequests
| where TimeGenerated > ago(7d)
| summarize
    AvgDuration = avg(DurationMs),
    P50Duration = percentile(DurationMs, 50),
    P95Duration = percentile(DurationMs, 95),
    QueryCount = count()
    by bin(TimeGenerated, 1h)
| render timechart

// Failed queries
SynapseSqlPoolExecRequests
| where TimeGenerated > ago(24h)
| where Status == "Failed"
| project
    TimeGenerated,
    Command,
    ErrorMessage = Error,
    SubmittedBy
| order by TimeGenerated desc

// Resource consumption by user
SynapseSqlPoolExecRequests
| where TimeGenerated > ago(24h)
| summarize
    TotalQueries = count(),
    AvgDuration = avg(DurationMs),
    TotalDataProcessed = sum(DataProcessedMB)
    by SubmittedBy
| order by TotalDataProcessed desc
```

#### Spark Pool Monitoring (7:30 - 10:00)

```kusto
// Spark job completion status
SynapseSparkJobsEnded
| where TimeGenerated > ago(24h)
| summarize
    TotalJobs = count(),
    Succeeded = countif(Status == "Succeeded"),
    Failed = countif(Status == "Failed")
    by bin(TimeGenerated, 1h), AppName
| extend SuccessRate = (Succeeded * 100.0) / TotalJobs
| render timechart

// Resource utilization
SynapseSparkJobsEnded
| where TimeGenerated > ago(24h)
| project
    TimeGenerated,
    AppName,
    DurationMs,
    MemoryUsedMB,
    CoresUsed,
    Status
| summarize
    AvgDuration = avg(DurationMs),
    AvgMemory = avg(MemoryUsedMB),
    AvgCores = avg(CoresUsed)
    by AppName
| order by AvgDuration desc

// Failed Spark jobs with details
SynapseSparkJobsEnded
| where TimeGenerated > ago(24h)
| where Status == "Failed"
| project
    TimeGenerated,
    AppName,
    ErrorMessage,
    DurationMs,
    MemoryUsedMB
| order by TimeGenerated desc

// Spark pool auto-scaling events
SynapseSparkPoolsEnded
| where TimeGenerated > ago(7d)
| project
    TimeGenerated,
    PoolName,
    MinNodes,
    MaxNodes,
    CurrentNodes = NodeCount
| render timechart
```

#### Pipeline Monitoring (10:00 - 12:00)

```kusto
// Pipeline run status
SynapsePipelineRuns
| where TimeGenerated > ago(24h)
| summarize
    Total = count(),
    Succeeded = countif(Status == "Succeeded"),
    Failed = countif(Status == "Failed"),
    InProgress = countif(Status == "InProgress")
    by bin(TimeGenerated, 1h), PipelineName
| extend SuccessRate = (Succeeded * 100.0) / Total
| render timechart

// Failed pipeline activities
SynapseActivityRuns
| where TimeGenerated > ago(24h)
| where Status == "Failed"
| project
    TimeGenerated,
    PipelineName,
    ActivityName,
    ErrorMessage,
    DurationMs
| order by TimeGenerated desc

// Pipeline duration trends
SynapsePipelineRuns
| where TimeGenerated > ago(7d)
| where Status == "Succeeded"
| summarize
    AvgDuration = avg(DurationMs),
    P95Duration = percentile(DurationMs, 95)
    by bin(TimeGenerated, 1d), PipelineName
| render timechart

// Pipeline cost estimation
SynapseActivityRuns
| where TimeGenerated > ago(30d)
| extend CostEstimate = DurationMs * 0.0001  // Example calculation
| summarize
    TotalCost = sum(CostEstimate),
    ExecutionCount = count()
    by PipelineName
| order by TotalCost desc
```

### Section 3: Power BI Dashboard (12:00 - 18:00)

#### Connect to Log Analytics (12:00 - 13:30)

```m
// Power Query M formula
let
    Source = AzureMonitorDataExplorer.Contents(
        "https://api.loganalytics.io/v1",
        "workspace-id",
        "SynapseSqlPoolExecRequests
        | where TimeGenerated > ago(30d)
        | summarize
            QueryCount = count(),
            AvgDuration = avg(DurationMs),
            DataProcessed = sum(DataProcessedMB)
            by bin(TimeGenerated, 1d), SubmittedBy"
    ),
    #"Expanded Value" = Table.ExpandRecordColumn(Source, "Value",
        {"TimeGenerated", "SubmittedBy", "QueryCount", "AvgDuration", "DataProcessed"})
in
    #"Expanded Value"
```

#### Dashboard Visualizations (13:30 - 18:00)

**Page 1: Overview**
- Total queries (Card)
- Active SQL pools (Card)
- Running pipelines (Card)
- Cost this month (Card)
- Query duration trend (Line chart)
- Pipeline success rate (Gauge)
- Top 10 longest queries (Table)

**Page 2: SQL Pool Performance**
- Query duration distribution (Histogram)
- Queries by user (Bar chart)
- Data processed by query type (Pie chart)
- Wait statistics (Stacked bar chart)
- Failed queries (Table with drill-through)

**Page 3: Spark Jobs**
- Job success rate (KPI)
- Resource utilization (Multi-line chart)
- Job duration by application (Bar chart)
- Memory usage trends (Area chart)

**Page 4: Pipelines**
- Pipeline runs by status (Donut chart)
- Average duration by pipeline (Bar chart)
- Failed activities (Matrix)
- Cost breakdown (Treemap)

**DAX Measures**:

```dax
// Success Rate
SuccessRate =
DIVIDE(
    CALCULATE(COUNT(Queries[QueryId]), Queries[Status] = "Succeeded"),
    COUNT(Queries[QueryId]),
    0
) * 100

// Average Duration (minutes)
AvgDurationMinutes =
AVERAGE(Queries[DurationMs]) / 60000

// Cost This Month
CostThisMonth =
CALCULATE(
    SUM(Queries[EstimatedCost]),
    DATESMTD(Calendar[Date])
)

// YoY Growth
YoYGrowth =
VAR CurrentYear = CALCULATE(COUNT(Queries[QueryId]), YEAR(Calendar[Date]) = YEAR(TODAY()))
VAR PreviousYear = CALCULATE(COUNT(Queries[QueryId]), YEAR(Calendar[Date]) = YEAR(TODAY()) - 1)
RETURN
DIVIDE(CurrentYear - PreviousYear, PreviousYear, 0) * 100
```

### Section 4: Alerting (18:00 - 22:00)

#### Alert Rules (18:00 - 20:00)

```json
{
  "name": "High-SQL-Pool-DWU-Usage",
  "description": "Alert when SQL pool DWU usage exceeds 80%",
  "severity": 2,
  "enabled": true,
  "scopes": [
    "/subscriptions/{sub-id}/resourceGroups/synapse-rg/providers/Microsoft.Synapse/workspaces/mysynapse"
  ],
  "evaluationFrequency": "PT5M",
  "windowSize": "PT15M",
  "criteria": {
    "allOf": [
      {
        "query": "SynapseSqlPoolDmsWorkers | where TimeGenerated > ago(15m) | summarize AvgDWU = avg(DWUPercent) | where AvgDWU > 80",
        "timeAggregation": "Average",
        "operator": "GreaterThan",
        "threshold": 80
      }
    ]
  },
  "actions": [
    {
      "actionGroupId": "/subscriptions/{sub-id}/resourceGroups/synapse-rg/providers/microsoft.insights/actionGroups/SynapseAlerts",
      "webhookProperties": {}
    }
  ]
}
```

#### Action Groups (20:00 - 22:00)

```bash
# Create action group
az monitor action-group create \
  --name SynapseAlerts \
  --resource-group synapse-rg \
  --short-name SynAlerts \
  --email-receiver name=DevTeam email=devteam@company.com \
  --webhook-receiver name=Slack uri=https://hooks.slack.com/services/xxx

# Create metric alert
az monitor metrics alert create \
  --name pipeline-failure-alert \
  --resource-group synapse-rg \
  --scopes /subscriptions/{sub-id}/resourceGroups/synapse-rg/providers/Microsoft.Synapse/workspaces/mysynapse \
  --condition "count PipelineFailedRuns > 3" \
  --window-size 5m \
  --evaluation-frequency 1m \
  --action SynapseAlerts
```

### Section 5: Cost Monitoring (22:00 - 24:00)

#### Cost Analysis Queries (22:00 - 23:00)

```kusto
// SQL pool cost estimation
SynapseSqlPoolExecRequests
| where TimeGenerated > ago(30d)
| extend CostEstimate = (DurationMs / 3600000.0) * 1.20  // $1.20/hour example
| summarize
    TotalCost = sum(CostEstimate),
    QueryCount = count()
    by bin(TimeGenerated, 1d)
| render timechart

// Spark job cost
SynapseSparkJobsEnded
| where TimeGenerated > ago(30d)
| extend CostEstimate = (DurationMs / 3600000.0) * CoresUsed * 0.10  // Example rate
| summarize
    TotalCost = sum(CostEstimate),
    JobCount = count()
    by bin(TimeGenerated, 1d), AppName
| order by TotalCost desc
```

#### Cost Optimization Recommendations (23:00 - 24:00)

```kusto
// Idle SQL pools
AzureActivity
| where TimeGenerated > ago(7d)
| where OperationNameValue == "MICROSOFT.SYNAPSE/WORKSPACES/SQLPOOLS/RESUME/ACTION"
| summarize ResumeCount = count() by Resource
| where ResumeCount < 5
| project Resource, ResumeCount, Recommendation = "Consider pausing or deleting"

// Under-utilized Spark pools
SynapseSparkJobsEnded
| where TimeGenerated > ago(7d)
| summarize
    AvgCoresUsed = avg(CoresUsed),
    MaxCoresAvailable = max(MaxCores)
    by PoolName
| extend Utilization = (AvgCoresUsed / MaxCoresAvailable) * 100
| where Utilization < 30
| project PoolName, Utilization, Recommendation = "Consider reducing pool size"
```

### Conclusion (24:00 - 25:00)

**Best Practices**:
1. Set up comprehensive diagnostic logging
2. Create role-based dashboards
3. Implement proactive alerting
4. Review metrics weekly
5. Optimize based on insights

**Next Steps**:
- Customize queries for your workload
- Set up automated reports
- Integrate with ITSM tools
- Train team on dashboard usage

## Related Resources

- [Performance Tuning](performance-tuning.md)
- [Advanced Features](advanced-features.md)
- [Disaster Recovery](disaster-recovery.md)

---

*Last Updated: January 2025*
