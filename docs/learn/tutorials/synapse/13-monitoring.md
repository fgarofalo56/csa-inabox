# Tutorial 13: Monitoring and Diagnostics

## Overview

This tutorial covers comprehensive monitoring and diagnostics for Azure Synapse Analytics, including performance monitoring, alerting, troubleshooting, and operational best practices.

## Prerequisites

- Completed [Tutorial 12: Security Configuration](12-security.md)
- Access to Azure Monitor
- Understanding of Synapse architecture

## Learning Objectives

By the end of this tutorial, you will be able to:

- Configure diagnostic settings
- Monitor query performance
- Set up alerts and notifications
- Troubleshoot common issues
- Implement operational dashboards

---

## Section 1: Diagnostic Settings

### Enable Diagnostics

```powershell
# Enable diagnostic settings via Azure CLI
az monitor diagnostic-settings create \
    --name "synapse-diagnostics" \
    --resource "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Synapse/workspaces/<workspace>" \
    --workspace "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<la-workspace>" \
    --logs '[
        {"category": "SynapseRbacOperations", "enabled": true},
        {"category": "GatewayApiRequests", "enabled": true},
        {"category": "BuiltinSqlReqsEnded", "enabled": true},
        {"category": "IntegrationPipelineRuns", "enabled": true},
        {"category": "IntegrationActivityRuns", "enabled": true},
        {"category": "IntegrationTriggerRuns", "enabled": true},
        {"category": "SQLSecurityAuditEvents", "enabled": true}
    ]' \
    --metrics '[{"category": "AllMetrics", "enabled": true}]'
```

### Log Categories

```
┌─────────────────────────────────────────────────────────────────┐
│                  Synapse Diagnostic Logs                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SQL Pools                                                       │
│  ├── SQLSecurityAuditEvents    (Login/Query auditing)           │
│  ├── DmsWorkers                (Data movement)                  │
│  ├── RequestSteps              (Query steps)                    │
│  ├── ExecRequests              (Query requests)                 │
│  └── Waits                     (Wait statistics)                │
│                                                                  │
│  Spark Pools                                                     │
│  ├── BigDataPoolAppsEnded      (Application completion)         │
│  └── SparkJobDefinitions       (Job definitions)                │
│                                                                  │
│  Pipeline/Integration                                            │
│  ├── IntegrationPipelineRuns   (Pipeline executions)            │
│  ├── IntegrationActivityRuns   (Activity executions)            │
│  └── IntegrationTriggerRuns    (Trigger executions)             │
│                                                                  │
│  Workspace                                                       │
│  ├── SynapseRbacOperations     (RBAC changes)                   │
│  ├── GatewayApiRequests        (API gateway)                    │
│  └── BuiltinSqlReqsEnded       (Serverless queries)             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Section 2: SQL Pool Monitoring

### Query Performance Monitoring

```sql
-- View active queries
SELECT
    request_id,
    status,
    submit_time,
    start_time,
    DATEDIFF(second, start_time, GETDATE()) AS running_seconds,
    [label],
    command,
    resource_class,
    group_name
FROM sys.dm_pdw_exec_requests
WHERE status = 'Running'
ORDER BY submit_time;

-- View query history with performance metrics
SELECT
    request_id,
    status,
    submit_time,
    start_time,
    end_time,
    total_elapsed_time / 1000.0 AS total_seconds,
    (total_elapsed_time - queued_time) / 1000.0 AS execution_seconds,
    queued_time / 1000.0 AS queued_seconds,
    resource_class,
    result_cache_hit,
    [label],
    LEFT(command, 200) AS command_preview
FROM sys.dm_pdw_exec_requests
WHERE submit_time >= DATEADD(hour, -24, GETUTCDATE())
  AND status = 'Completed'
ORDER BY total_elapsed_time DESC;

-- View slow queries
SELECT TOP 20
    request_id,
    total_elapsed_time / 1000.0 AS total_seconds,
    result_cache_hit,
    resource_class,
    [label],
    LEFT(command, 500) AS command
FROM sys.dm_pdw_exec_requests
WHERE status = 'Completed'
  AND submit_time >= DATEADD(day, -7, GETUTCDATE())
  AND total_elapsed_time > 60000  -- More than 60 seconds
ORDER BY total_elapsed_time DESC;
```

### Query Step Analysis

```sql
-- View query execution steps
SELECT
    request_id,
    step_index,
    operation_type,
    distribution_type,
    location_type,
    status,
    total_elapsed_time / 1000.0 AS step_seconds,
    row_count,
    command
FROM sys.dm_pdw_request_steps
WHERE request_id = 'QID12345'
ORDER BY step_index;

-- View data movement details
SELECT
    request_id,
    step_index,
    pdw_node_id,
    distribution_id,
    type,
    status,
    start_time,
    end_time,
    total_elapsed_time / 1000.0 AS seconds,
    rows_processed,
    bytes_processed / 1024.0 / 1024.0 AS mb_processed
FROM sys.dm_pdw_dms_workers
WHERE request_id = 'QID12345'
ORDER BY step_index, pdw_node_id;

-- Identify data skew
SELECT
    step_index,
    MIN(rows_processed) AS min_rows,
    MAX(rows_processed) AS max_rows,
    AVG(rows_processed) AS avg_rows,
    MAX(rows_processed) * 1.0 / NULLIF(AVG(rows_processed), 0) AS skew_factor
FROM sys.dm_pdw_dms_workers
WHERE request_id = 'QID12345'
GROUP BY step_index
HAVING MAX(rows_processed) * 1.0 / NULLIF(AVG(rows_processed), 0) > 2
ORDER BY step_index;
```

### Wait Statistics

```sql
-- View current waits
SELECT
    request_id,
    type AS wait_type,
    state,
    object_type,
    object_name,
    request_time,
    DATEDIFF(second, request_time, GETDATE()) AS wait_seconds
FROM sys.dm_pdw_waits
WHERE state = 'Queued'
ORDER BY request_time;

-- Aggregate wait statistics
SELECT
    type AS wait_type,
    COUNT(*) AS wait_count,
    SUM(DATEDIFF(second, request_time, acquire_time)) AS total_wait_seconds,
    AVG(DATEDIFF(second, request_time, acquire_time)) AS avg_wait_seconds
FROM sys.dm_pdw_waits
WHERE acquire_time IS NOT NULL
  AND request_time >= DATEADD(day, -1, GETUTCDATE())
GROUP BY type
ORDER BY total_wait_seconds DESC;
```

### Resource Utilization

```sql
-- View node resource utilization
SELECT
    pdw_node_id,
    type,
    name,
    compute_node_id,
    process_id,
    memory_usage_mb,
    cpu_usage_percent,
    total_space_mb,
    available_space_mb
FROM sys.dm_pdw_nodes_resource_governor_workload_groups
ORDER BY pdw_node_id;

-- View storage utilization
SELECT
    pdw_node_id,
    distribution_id,
    reserved_space_mb,
    data_space_mb,
    index_space_mb,
    unused_space_mb
FROM sys.dm_pdw_nodes_db_file_space_usage
ORDER BY reserved_space_mb DESC;

-- Table storage metrics
SELECT
    OBJECT_NAME(object_id) AS table_name,
    SUM(reserved_page_count) * 8 / 1024.0 AS reserved_mb,
    SUM(data_page_count) * 8 / 1024.0 AS data_mb,
    SUM(index_page_count) * 8 / 1024.0 AS index_mb,
    SUM(row_count) AS row_count
FROM sys.dm_pdw_nodes_db_partition_stats
GROUP BY object_id
ORDER BY reserved_mb DESC;
```

---

## Section 3: Serverless SQL Monitoring

### Query History

```sql
-- View serverless SQL query history
SELECT
    submit_time,
    end_time,
    DATEDIFF(second, submit_time, end_time) AS duration_seconds,
    data_processed_mb,
    status,
    error_id,
    LEFT(query_text, 200) AS query_preview
FROM sys.dm_exec_requests_history
WHERE submit_time >= DATEADD(hour, -24, GETUTCDATE())
ORDER BY submit_time DESC;

-- Cost estimation (based on data processed)
SELECT
    CAST(submit_time AS DATE) AS query_date,
    COUNT(*) AS query_count,
    SUM(data_processed_mb) AS total_data_mb,
    SUM(data_processed_mb) / 1024.0 AS total_data_gb,
    SUM(data_processed_mb) / 1024.0 * 5.0 AS estimated_cost_usd  -- ~$5 per TB
FROM sys.dm_exec_requests_history
WHERE submit_time >= DATEADD(day, -30, GETUTCDATE())
GROUP BY CAST(submit_time AS DATE)
ORDER BY query_date DESC;

-- Top data consumers
SELECT TOP 20
    query_hash,
    COUNT(*) AS execution_count,
    SUM(data_processed_mb) AS total_data_mb,
    AVG(data_processed_mb) AS avg_data_mb,
    MAX(LEFT(query_text, 200)) AS sample_query
FROM sys.dm_exec_requests_history
WHERE submit_time >= DATEADD(day, -7, GETUTCDATE())
GROUP BY query_hash
ORDER BY total_data_mb DESC;
```

---

## Section 4: Spark Pool Monitoring

### Spark Application Monitoring

```python
# In Spark notebook - view Spark UI metrics
spark.sparkContext.uiWebUrl

# Application configuration
for key, value in spark.sparkContext.getConf().getAll():
    print(f"{key}: {value}")

# Job metrics
from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()

# Get job statistics
for job_id in spark.sparkContext.statusTracker().getJobIdsForGroup():
    job_info = spark.sparkContext.statusTracker().getJobInfo(job_id)
    if job_info:
        print(f"Job {job_id}: {job_info.status()}")

# Stage metrics
for stage_id in spark.sparkContext.statusTracker().getActiveStageIds():
    stage_info = spark.sparkContext.statusTracker().getStageInfo(stage_id)
    if stage_info:
        print(f"Stage {stage_id}: {stage_info.numTasks()} tasks, {stage_info.numCompletedTasks()} completed")
```

### Log Analytics Queries for Spark

```kql
// Spark application summary
SynapseBigDataPoolApplicationsEnded
| where TimeGenerated > ago(24h)
| project
    TimeGenerated,
    ApplicationName,
    SubmitTime,
    EndTime,
    Duration = datetime_diff('second', EndTime, SubmitTime),
    State,
    Cores,
    MemoryMB
| order by TimeGenerated desc

// Failed Spark applications
SynapseBigDataPoolApplicationsEnded
| where TimeGenerated > ago(7d)
| where State == "Failed"
| project
    TimeGenerated,
    ApplicationName,
    ErrorMessage = tostring(Properties.errorMessage)
| order by TimeGenerated desc

// Resource utilization trend
SynapseBigDataPoolApplicationsEnded
| where TimeGenerated > ago(7d)
| summarize
    AvgCores = avg(Cores),
    MaxCores = max(Cores),
    AvgMemoryGB = avg(MemoryMB / 1024),
    MaxMemoryGB = max(MemoryMB / 1024)
    by bin(TimeGenerated, 1h)
| render timechart
```

---

## Section 5: Pipeline Monitoring

### Pipeline Run Monitoring

```kql
// Pipeline run summary
SynapseIntegrationPipelineRuns
| where TimeGenerated > ago(24h)
| project
    TimeGenerated,
    PipelineName,
    Status,
    DurationInMs,
    Parameters
| order by TimeGenerated desc

// Failed pipelines
SynapseIntegrationPipelineRuns
| where TimeGenerated > ago(7d)
| where Status == "Failed"
| project
    TimeGenerated,
    PipelineName,
    Error = tostring(Error)
| order by TimeGenerated desc

// Pipeline success rate
SynapseIntegrationPipelineRuns
| where TimeGenerated > ago(30d)
| summarize
    TotalRuns = count(),
    Succeeded = countif(Status == "Succeeded"),
    Failed = countif(Status == "Failed")
    by PipelineName
| extend SuccessRate = round(100.0 * Succeeded / TotalRuns, 2)
| order by TotalRuns desc
```

### Activity Monitoring

```kql
// Activity run details
SynapseIntegrationActivityRuns
| where TimeGenerated > ago(24h)
| project
    TimeGenerated,
    PipelineName,
    ActivityName,
    ActivityType,
    Status,
    DurationInMs,
    Input = tostring(Input),
    Output = tostring(Output)
| order by TimeGenerated desc

// Long-running activities
SynapseIntegrationActivityRuns
| where TimeGenerated > ago(7d)
| where DurationInMs > 600000  // > 10 minutes
| project
    TimeGenerated,
    PipelineName,
    ActivityName,
    ActivityType,
    DurationMinutes = DurationInMs / 60000
| order by DurationMinutes desc

// Activity failure analysis
SynapseIntegrationActivityRuns
| where TimeGenerated > ago(7d)
| where Status == "Failed"
| summarize FailureCount = count() by ActivityName, ActivityType
| order by FailureCount desc
```

---

## Section 6: Alerting

### Metric-Based Alerts

```json
// ARM template for CPU alert
{
  "type": "Microsoft.Insights/metricAlerts",
  "apiVersion": "2018-03-01",
  "name": "SQLPool-HighCPU",
  "location": "global",
  "properties": {
    "severity": 2,
    "enabled": true,
    "scopes": [
      "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Synapse/workspaces/<workspace>/sqlPools/<pool>"
    ],
    "evaluationFrequency": "PT5M",
    "windowSize": "PT15M",
    "criteria": {
      "odata.type": "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",
      "allOf": [
        {
          "name": "HighCPU",
          "metricName": "DWUUsedPercent",
          "operator": "GreaterThan",
          "threshold": 80,
          "timeAggregation": "Average"
        }
      ]
    },
    "actions": [
      {
        "actionGroupId": "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Insights/actionGroups/DataTeam"
      }
    ]
  }
}
```

### Log-Based Alerts

```kql
// Alert: Failed queries
SynapseAuditLogs
| where TimeGenerated > ago(5m)
| where Category == "SQLSecurityAuditEvents"
| where ActionName == "BATCH COMPLETED"
| where Succeeded == false
| summarize FailedQueries = count()
| where FailedQueries > 10

// Alert: Long-running queries
SynapseAuditLogs
| where TimeGenerated > ago(5m)
| where DurationMs > 3600000  // > 1 hour
| summarize LongQueries = count()
| where LongQueries > 0

// Alert: High data processed (cost)
SynapseBuiltinSqlPoolRequestsEnded
| where TimeGenerated > ago(1h)
| summarize TotalDataGB = sum(DataProcessedMB) / 1024
| where TotalDataGB > 100  // > 100 GB per hour
```

### Action Groups

```powershell
# Create action group
az monitor action-group create \
    --name "DataPlatformTeam" \
    --resource-group "rg-monitoring" \
    --short-name "DataTeam" \
    --action email "data-team" "data-team@company.com" \
    --action webhook "pagerduty" "https://events.pagerduty.com/integration/xxx/enqueue" \
    --action azurefunction "scaleup" \
        "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Web/sites/<app>/functions/ScaleUp" \
        "https://<app>.azurewebsites.net/api/ScaleUp"
```

---

## Section 7: Operational Dashboards

### Azure Workbook Template

```json
{
  "version": "Notebook/1.0",
  "items": [
    {
      "type": 1,
      "content": {
        "json": "# Synapse Analytics Monitoring Dashboard"
      }
    },
    {
      "type": 3,
      "content": {
        "version": "KqlItem/1.0",
        "query": "SynapseIntegrationPipelineRuns | where TimeGenerated > ago(24h) | summarize Succeeded=countif(Status=='Succeeded'), Failed=countif(Status=='Failed'), InProgress=countif(Status=='InProgress') | project Succeeded, Failed, InProgress",
        "size": 1,
        "title": "Pipeline Status (24h)",
        "queryType": 0,
        "resourceType": "microsoft.operationalinsights/workspaces",
        "visualization": "tiles"
      }
    },
    {
      "type": 3,
      "content": {
        "version": "KqlItem/1.0",
        "query": "SynapseBuiltinSqlPoolRequestsEnded | where TimeGenerated > ago(24h) | summarize Queries=count(), DataGB=sum(DataProcessedMB)/1024 by bin(TimeGenerated, 1h) | render timechart",
        "size": 0,
        "title": "Serverless SQL Usage",
        "queryType": 0,
        "resourceType": "microsoft.operationalinsights/workspaces"
      }
    }
  ]
}
```

### Key Performance Indicators

```sql
-- Create KPI view
CREATE VIEW monitoring.vw_DailyKPIs
AS
WITH QueryStats AS (
    SELECT
        CAST(submit_time AS DATE) AS metric_date,
        COUNT(*) AS total_queries,
        SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) AS failed_queries,
        AVG(total_elapsed_time / 1000.0) AS avg_duration_seconds,
        MAX(total_elapsed_time / 1000.0) AS max_duration_seconds,
        SUM(CASE WHEN result_cache_hit = 1 THEN 1 ELSE 0 END) AS cache_hits
    FROM sys.dm_pdw_exec_requests
    WHERE submit_time >= DATEADD(day, -30, GETUTCDATE())
    GROUP BY CAST(submit_time AS DATE)
)
SELECT
    metric_date,
    total_queries,
    failed_queries,
    ROUND(100.0 * (total_queries - failed_queries) / NULLIF(total_queries, 0), 2) AS success_rate,
    ROUND(avg_duration_seconds, 2) AS avg_duration_seconds,
    ROUND(max_duration_seconds, 2) AS max_duration_seconds,
    ROUND(100.0 * cache_hits / NULLIF(total_queries, 0), 2) AS cache_hit_rate
FROM QueryStats;
GO
```

---

## Exercises

### Exercise 1: Build Monitoring Dashboard
Create a comprehensive Azure Workbook for Synapse monitoring.

### Exercise 2: Set Up Alerting
Configure alerts for query failures, resource usage, and cost thresholds.

### Exercise 3: Performance Analysis
Identify and optimize the top 5 slowest queries in your environment.

---

## Best Practices Summary

| Area | Recommendation |
|------|----------------|
| Diagnostics | Enable all relevant log categories |
| Retention | Keep logs for 90+ days for trend analysis |
| Alerting | Set up proactive alerts before issues impact users |
| Dashboards | Create role-specific views (ops, dev, business) |
| Cost Monitoring | Track data processed for serverless SQL |
| Automation | Use Azure Functions for auto-remediation |

---

## Next Steps

- Continue to [Tutorial 14: CI/CD Setup](14-cicd-setup.md)
- Explore [Monitoring Best Practices](../../monitoring/monitoring-setup.md)
- Review [Troubleshooting Guide](../../troubleshooting/index.md)
