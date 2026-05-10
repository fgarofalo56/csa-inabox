# Monitoring Best Practices

> **[Home](../../../README.md)** | **[Best Practices](../README.md)** | **[Operational Excellence](README.md)** | **Monitoring**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Operations-orange?style=flat-square)

Comprehensive monitoring strategies for Azure analytics platforms.

---

## Overview

Effective monitoring provides visibility into platform health, performance, and usage patterns, enabling proactive issue detection and capacity planning.

---

## Monitoring Layers

### Observability Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    Business Metrics                          │
│              (SLAs, Data Freshness, Quality)                │
├─────────────────────────────────────────────────────────────┤
│                   Application Metrics                        │
│           (Pipeline Success, Query Performance)              │
├─────────────────────────────────────────────────────────────┤
│                 Infrastructure Metrics                       │
│              (CPU, Memory, Network, Storage)                │
├─────────────────────────────────────────────────────────────┤
│                      Platform Logs                           │
│          (Azure Diagnostics, Activity Logs)                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Azure Monitor Configuration

### Diagnostic Settings

```bicep
resource diagnosticSettings 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-synapse'
  scope: synapseWorkspace
  properties: {
    workspaceId: logAnalyticsWorkspace.id
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: true
          days: 90
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: true
          days: 90
        }
      }
    ]
  }
}
```

### Workbook Template

```json
{
    "version": "Notebook/1.0",
    "items": [
        {
            "type": 1,
            "content": {
                "json": "## Data Platform Health Dashboard"
            }
        },
        {
            "type": 3,
            "content": {
                "version": "KqlItem/1.0",
                "query": "AzureDiagnostics | where ResourceProvider == 'MICROSOFT.SYNAPSE' | summarize count() by Category, bin(TimeGenerated, 1h)",
                "size": 0,
                "queryType": 0,
                "resourceType": "microsoft.operationalinsights/workspaces",
                "visualization": "timechart"
            }
        }
    ]
}
```

---

## Key Metrics

### Synapse Analytics

| Metric | Query | Alert Threshold |
|--------|-------|-----------------|
| Pipeline Success Rate | `BuiltInFailureRate` | < 95% |
| Spark Job Duration | `SparkJobsEnded` | > 2x baseline |
| SQL Pool DTU | `DWU_used` | > 80% |
| Integration Runtime | `IntegrationRuntimeAvailableNodeNumber` | < 2 |

### Databricks

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| Cluster Utilization | Ganglia | > 85% sustained |
| Job Failure Rate | Job API | > 5% |
| Library Install Failures | Cluster logs | > 0 |
| DBU Consumption | Unity Catalog | > budget |

---

## Log Analytics Queries

### Pipeline Monitoring

```kql
// Pipeline run summary
SynapseIntegrationPipelineRuns
| where TimeGenerated > ago(24h)
| summarize
    TotalRuns = count(),
    Succeeded = countif(Status == "Succeeded"),
    Failed = countif(Status == "Failed"),
    InProgress = countif(Status == "InProgress")
    by PipelineName
| extend SuccessRate = round(100.0 * Succeeded / TotalRuns, 2)
| order by Failed desc
```

### Resource Utilization

```kql
// Spark pool resource usage
SynapseSqlPoolRequestSteps
| where TimeGenerated > ago(1h)
| summarize
    AvgCPU = avg(TotalElapsedTimeMs),
    MaxCPU = max(TotalElapsedTimeMs),
    QueryCount = count()
    by bin(TimeGenerated, 5m), DatabaseName
| render timechart
```

### Error Analysis

```kql
// Top errors by category
AzureDiagnostics
| where ResourceProvider in ("MICROSOFT.SYNAPSE", "MICROSOFT.DATABRICKS")
| where Level == "Error"
| summarize ErrorCount = count() by Category, OperationName
| top 20 by ErrorCount desc
```

---

## Custom Metrics

### Application Insights Integration

```python
from applicationinsights import TelemetryClient
from opencensus.ext.azure.log_exporter import AzureLogHandler
import logging

class PipelineMetrics:
    """Custom metrics for data pipelines."""

    def __init__(self, instrumentation_key: str):
        self.client = TelemetryClient(instrumentation_key)
        self.logger = logging.getLogger(__name__)
        self.logger.addHandler(AzureLogHandler(
            connection_string=f"InstrumentationKey={instrumentation_key}"
        ))

    def track_pipeline_run(self, pipeline_name: str, duration_ms: float, status: str):
        """Track pipeline execution metrics."""
        self.client.track_metric(
            name="PipelineDuration",
            value=duration_ms,
            properties={
                "pipeline": pipeline_name,
                "status": status
            }
        )

    def track_data_quality(self, table_name: str, null_rate: float, duplicate_rate: float):
        """Track data quality metrics."""
        self.client.track_metric(name="NullRate", value=null_rate, properties={"table": table_name})
        self.client.track_metric(name="DuplicateRate", value=duplicate_rate, properties={"table": table_name})

    def flush(self):
        """Ensure all metrics are sent."""
        self.client.flush()
```

### Databricks Custom Metrics

```python
# In Databricks notebook
from pyspark.sql.functions import *

def publish_job_metrics(job_name: str, metrics: dict):
    """Publish custom metrics to Azure Monitor."""
    from azure.monitor.ingestion import LogsIngestionClient
    from azure.identity import DefaultAzureCredential

    credential = DefaultAzureCredential()
    client = LogsIngestionClient(
        endpoint="https://dce-xxx.eastus-1.ingest.monitor.azure.com",
        credential=credential
    )

    log_entry = [{
        "TimeGenerated": datetime.utcnow().isoformat(),
        "JobName": job_name,
        **metrics
    }]

    client.upload(
        rule_id="dcr-xxx",
        stream_name="Custom-DataPlatformMetrics_CL",
        logs=log_entry
    )
```

---

## Dashboards

### Executive Dashboard

```kql
// SLA compliance overview
let sla_threshold = 99.5;
SynapseIntegrationPipelineRuns
| where TimeGenerated > ago(7d)
| summarize
    TotalRuns = count(),
    SuccessfulRuns = countif(Status == "Succeeded")
    by bin(TimeGenerated, 1d)
| extend
    SuccessRate = round(100.0 * SuccessfulRuns / TotalRuns, 2),
    SLAMet = iff(100.0 * SuccessfulRuns / TotalRuns >= sla_threshold, "Yes", "No")
| project TimeGenerated, SuccessRate, SLAMet
```

### Operations Dashboard

```kql
// Real-time pipeline status
SynapseIntegrationPipelineRuns
| where TimeGenerated > ago(1h)
| summarize arg_max(TimeGenerated, *) by PipelineName, RunId
| project
    TimeGenerated,
    PipelineName,
    Status,
    DurationMs = datetime_diff('millisecond', End, Start)
| extend StatusIcon = case(
    Status == "Succeeded", "✅",
    Status == "Failed", "❌",
    Status == "InProgress", "🔄",
    "⚠️")
```

---

## Best Practices

### Monitoring Checklist

| Area | Check | Frequency |
|------|-------|-----------|
| Pipeline health | Success rate > 95% | Hourly |
| Data freshness | Tables updated on schedule | Per pipeline |
| Resource utilization | < 80% sustained | 5 minutes |
| Error rate | < 1% | Real-time |
| Cost tracking | Within budget | Daily |

### Retention Policy

| Log Type | Retention | Archive |
|----------|-----------|---------|
| Activity logs | 90 days | 1 year |
| Diagnostic logs | 30 days | 90 days |
| Custom metrics | 30 days | 1 year |
| Security logs | 1 year | 7 years |

---

## Related Documentation

- [Alert Strategies](alert-strategies.md)
- [Synapse Monitoring](../../../09-monitoring/service-monitoring/synapse/README.md)
- [Databricks Monitoring](../../../09-monitoring/service-monitoring/databricks/README.md)

---

*Last Updated: January 2025*
