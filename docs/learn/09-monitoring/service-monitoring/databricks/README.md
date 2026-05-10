# Databricks Monitoring

> **[Home](../../../README.md)** | **[Monitoring](../../README.md)** | **Databricks Monitoring**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Azure%20Databricks-orange?style=flat-square)

Comprehensive monitoring guide for Azure Databricks workspaces and clusters.

---

## Overview

This guide covers monitoring for:

- Cluster health and performance
- Job execution metrics
- Spark application monitoring
- Delta Live Tables pipelines
- Cost and resource utilization

---

## Azure Monitor Integration

### Enable Diagnostic Settings

```bash
# Enable diagnostic logs for Databricks workspace
az monitor diagnostic-settings create \
    --name "databricks-diagnostics" \
    --resource "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Databricks/workspaces/{workspace}" \
    --workspace "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{law}" \
    --logs '[
        {"category": "dbfs", "enabled": true},
        {"category": "clusters", "enabled": true},
        {"category": "accounts", "enabled": true},
        {"category": "jobs", "enabled": true},
        {"category": "notebook", "enabled": true},
        {"category": "ssh", "enabled": true},
        {"category": "workspace", "enabled": true},
        {"category": "secrets", "enabled": true},
        {"category": "sqlPermissions", "enabled": true},
        {"category": "unityCatalog", "enabled": true}
    ]'
```

---

## Cluster Monitoring

### KQL Queries for Cluster Health

```kql
// Cluster state changes over time
DatabricksClusters
| where TimeGenerated > ago(24h)
| where ActionName == "clusterStateChange"
| extend ClusterState = tostring(parse_json(RequestParams).state)
| summarize StateChanges = count() by ClusterId, ClusterState, bin(TimeGenerated, 1h)
| render timechart

// Cluster utilization
DatabricksClusters
| where TimeGenerated > ago(7d)
| where ActionName == "resize"
| extend CurrentWorkers = toint(parse_json(RequestParams).current_num_workers)
| extend TargetWorkers = toint(parse_json(RequestParams).num_workers)
| project TimeGenerated, ClusterId, CurrentWorkers, TargetWorkers

// Failed cluster starts
DatabricksClusters
| where TimeGenerated > ago(24h)
| where ActionName == "start" and Response contains "error"
| project TimeGenerated, ClusterId, Response
```

### Spark Metrics Collection

```python
# Configure Spark metrics sink
spark.conf.set("spark.metrics.conf.*.sink.console.class", "org.apache.spark.metrics.sink.ConsoleSink")
spark.conf.set("spark.metrics.conf.*.sink.ganglia.class", "org.apache.spark.metrics.sink.GangliaSink")
spark.conf.set("spark.metrics.conf.driver.source.jvm.class", "org.apache.spark.metrics.source.JvmSource")
spark.conf.set("spark.metrics.conf.executor.source.jvm.class", "org.apache.spark.metrics.source.JvmSource")

# Custom metrics collection
from pyspark.sql import SparkSession

def get_cluster_metrics():
    """Collect cluster metrics for monitoring."""
    spark = SparkSession.getActiveSession()

    metrics = {
        "executor_count": spark.sparkContext._jsc.sc().getExecutorMemoryStatus().size(),
        "default_parallelism": spark.sparkContext.defaultParallelism,
        "active_jobs": len(spark.sparkContext.statusTracker().getActiveJobIds()),
        "active_stages": len(spark.sparkContext.statusTracker().getActiveStageIds())
    }

    return metrics
```

---

## Job Monitoring

### Job Execution Dashboard

```kql
// Job execution summary
DatabricksJobs
| where TimeGenerated > ago(24h)
| where ActionName == "runTriggered" or ActionName == "runSucceeded" or ActionName == "runFailed"
| extend JobId = tostring(parse_json(RequestParams).job_id)
| extend RunId = tostring(parse_json(RequestParams).run_id)
| summarize
    Triggered = countif(ActionName == "runTriggered"),
    Succeeded = countif(ActionName == "runSucceeded"),
    Failed = countif(ActionName == "runFailed")
    by JobId, bin(TimeGenerated, 1h)

// Long-running jobs
DatabricksJobs
| where TimeGenerated > ago(24h)
| where ActionName == "runSucceeded"
| extend Duration = toint(parse_json(Response).execution_duration)
| where Duration > 3600000 // > 1 hour
| project TimeGenerated, JobId = parse_json(RequestParams).job_id, Duration
| order by Duration desc

// Job failure analysis
DatabricksJobs
| where TimeGenerated > ago(7d)
| where ActionName == "runFailed"
| extend ErrorMessage = tostring(parse_json(Response).error_message)
| summarize FailureCount = count() by ErrorMessage
| order by FailureCount desc
```

---

## Alert Configuration

### Critical Alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| Cluster Start Failure | > 3 failures in 1 hour | Critical |
| Job Failure Rate | > 20% in 1 hour | High |
| Long Running Job | Duration > 4 hours | Medium |
| High Memory Usage | > 85% for 15 min | High |
| Executor Loss | > 50% executors lost | Critical |

### Alert Rule Example

```json
{
    "name": "Databricks Job Failure Alert",
    "severity": 2,
    "evaluationFrequency": "PT5M",
    "windowSize": "PT1H",
    "criteria": {
        "allOf": [{
            "query": "DatabricksJobs | where ActionName == 'runFailed' | summarize FailedJobs = count()",
            "operator": "GreaterThan",
            "threshold": 5,
            "failingPeriods": {
                "numberOfEvaluationPeriods": 1,
                "minFailingPeriodsToAlert": 1
            }
        }]
    }
}
```

---

## Monitoring Dashboard

### Recommended Panels

1. **Cluster Overview**
   - Active clusters count
   - Total DBU consumption
   - Cluster state distribution

2. **Job Performance**
   - Job success/failure rates
   - Average job duration
   - Running jobs count

3. **Resource Utilization**
   - CPU utilization across clusters
   - Memory usage
   - Disk I/O

4. **Cost Tracking**
   - DBU consumption trend
   - Cost by workspace
   - Cost by job

---

## Related Documentation

- [Delta Live Tables Monitoring](dlt-monitoring.md)
- [Spark Performance Tuning](../../../best-practices/spark-performance/README.md)
- [Azure Monitor Integration](../../monitoring-setup/README.md)

---

*Last Updated: January 2025*
