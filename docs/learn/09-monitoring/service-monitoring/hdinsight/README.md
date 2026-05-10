# HDInsight Monitoring

> **[Home](../../../README.md)** | **[Monitoring](../../README.md)** | **HDInsight Monitoring**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Azure%20HDInsight-blue?style=flat-square)

Comprehensive monitoring guide for Azure HDInsight clusters.

---

## Overview

This guide covers monitoring for:

- Spark clusters
- Kafka clusters
- HBase clusters
- Cluster health and resource utilization
- Job and application monitoring

---

## Azure Monitor Integration

### Enable Diagnostic Settings

```bash
# Enable monitoring for HDInsight cluster
az hdinsight monitor enable \
    --name spark-cluster \
    --resource-group rg-hdinsight \
    --workspace "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{law}"

# Verify monitoring status
az hdinsight monitor show \
    --name spark-cluster \
    --resource-group rg-hdinsight
```

### Log Categories

| Category | Description | Retention |
|----------|-------------|-----------|
| AmbariMetrics | Cluster metrics from Ambari | 30 days |
| YarnMetrics | YARN resource manager metrics | 30 days |
| SparkApplications | Spark job metrics | 30 days |
| KafkaMetrics | Kafka broker metrics | 30 days |
| HBaseMetrics | HBase region server metrics | 30 days |

---

## Spark Cluster Monitoring

### KQL Queries

```kql
// Spark application summary
HDInsightSparkApplications
| where TimeGenerated > ago(24h)
| summarize
    TotalApps = count(),
    Succeeded = countif(State == "FINISHED"),
    Failed = countif(State == "FAILED"),
    Running = countif(State == "RUNNING")
    by ClusterName, bin(TimeGenerated, 1h)

// Long-running Spark jobs
HDInsightSparkApplications
| where TimeGenerated > ago(24h)
| extend DurationMinutes = (EndTime - StartTime) / 1m
| where DurationMinutes > 60
| project ClusterName, ApplicationId, Name, DurationMinutes, State
| order by DurationMinutes desc

// Executor failures
HDInsightSparkLogs
| where TimeGenerated > ago(24h)
| where Message contains "executor" and Message contains "failed"
| summarize FailureCount = count() by ClusterName, bin(TimeGenerated, 1h)
```

### Spark UI Metrics

```python
# Collect Spark metrics programmatically
from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()
sc = spark.sparkContext

# Get application metrics
metrics = {
    "application_id": sc.applicationId,
    "executor_count": len(sc._jsc.sc().getExecutorMemoryStatus()),
    "default_parallelism": sc.defaultParallelism,
    "active_jobs": len(sc.statusTracker().getActiveJobIds()),
    "completed_jobs": sc.statusTracker().getJobIdsForGroup()
}

print(metrics)
```

---

## Kafka Cluster Monitoring

### Broker Metrics

```kql
// Kafka broker health
HDInsightKafkaMetrics
| where TimeGenerated > ago(1h)
| where MetricName in ("UnderReplicatedPartitions", "OfflinePartitionsCount", "ActiveControllerCount")
| summarize Value = avg(Value) by ClusterName, MetricName, BrokerId, bin(TimeGenerated, 5m)
| render timechart

// Message throughput
HDInsightKafkaMetrics
| where TimeGenerated > ago(24h)
| where MetricName in ("MessagesInPerSec", "BytesInPerSec", "BytesOutPerSec")
| summarize AvgValue = avg(Value) by ClusterName, MetricName, bin(TimeGenerated, 1h)
| render timechart

// Consumer lag
HDInsightKafkaMetrics
| where TimeGenerated > ago(1h)
| where MetricName == "ConsumerLag"
| summarize MaxLag = max(Value) by ConsumerGroup, Topic, Partition
| where MaxLag > 1000
```

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| UnderReplicatedPartitions | > 0 for 5 min | > 0 for 15 min |
| OfflinePartitions | > 0 | > 0 |
| Consumer Lag | > 10000 | > 100000 |
| Disk Usage | > 70% | > 85% |

---

## HBase Monitoring

### Region Server Metrics

```kql
// HBase region server health
HDInsightHBaseMetrics
| where TimeGenerated > ago(1h)
| where MetricName in ("regionServerCount", "deadRegionServers", "averageLoad")
| summarize Value = avg(Value) by ClusterName, MetricName, bin(TimeGenerated, 5m)

// Request latency
HDInsightHBaseMetrics
| where TimeGenerated > ago(24h)
| where MetricName in ("readRequestLatency_mean", "writeRequestLatency_mean")
| summarize AvgLatency = avg(Value) by MetricName, bin(TimeGenerated, 1h)
| render timechart

// Region count per server
HDInsightHBaseMetrics
| where TimeGenerated > ago(1h)
| where MetricName == "regionCount"
| summarize RegionCount = sum(Value) by RegionServer
| order by RegionCount desc
```

---

## Resource Utilization

### Cluster Health Dashboard

```kql
// Node health overview
HDInsightAmbariMetrics
| where TimeGenerated > ago(1h)
| where MetricName in ("cpu_user", "mem_used_percent", "disk_used_percent")
| summarize AvgValue = avg(Value) by ClusterName, NodeName, MetricName, bin(TimeGenerated, 5m)

// YARN resource utilization
HDInsightYarnMetrics
| where TimeGenerated > ago(24h)
| where MetricName in ("AllocatedVCores", "AvailableVCores", "AllocatedMB", "AvailableMB")
| summarize AvgValue = avg(Value) by ClusterName, MetricName, bin(TimeGenerated, 1h)
| render timechart

// Container failures
HDInsightYarnMetrics
| where TimeGenerated > ago(24h)
| where MetricName == "ContainersFailed"
| summarize TotalFailed = sum(Value) by ClusterName, bin(TimeGenerated, 1h)
```

---

## Alerting Configuration

### Critical Alerts

```json
{
    "alerts": [
        {
            "name": "HDInsight Node Down",
            "query": "HDInsightAmbariMetrics | where MetricName == 'host_state' and Value != 'HEALTHY'",
            "threshold": 0,
            "severity": 0,
            "frequency": "PT5M"
        },
        {
            "name": "High CPU Utilization",
            "query": "HDInsightAmbariMetrics | where MetricName == 'cpu_user' and Value > 85",
            "threshold": 0,
            "severity": 2,
            "frequency": "PT5M"
        },
        {
            "name": "Kafka Under-Replicated Partitions",
            "query": "HDInsightKafkaMetrics | where MetricName == 'UnderReplicatedPartitions' and Value > 0",
            "threshold": 0,
            "severity": 1,
            "frequency": "PT5M"
        }
    ]
}
```

---

## Ambari Dashboard

### Access Ambari

1. Navigate to Azure Portal > HDInsight cluster
2. Click "Ambari home" under Cluster dashboards
3. Use cluster credentials to log in

### Key Dashboards

- **Hosts**: View all cluster nodes and their health
- **Services**: Monitor individual services (HDFS, YARN, Spark, etc.)
- **Alerts**: View active alerts and history
- **Configs**: Review and modify service configurations

---

## Related Documentation

- [Spark Performance Tuning](../../../best-practices/spark-performance/README.md)
- [Kafka Best Practices](../../../02-services/streaming-services/azure-event-hubs/README.md)
- [HDInsight Troubleshooting](../../../troubleshooting/spark-troubleshooting.md)

---

*Last Updated: January 2025*
