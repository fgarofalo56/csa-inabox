# Dedicated SQL Pool Monitoring

> **[Home](../../../README.md)** | **[Monitoring](../../README.md)** | **[Synapse](../synapse)** | **Dedicated SQL Pool Monitoring**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Synapse%20Dedicated%20SQL-purple?style=flat-square)

Comprehensive monitoring guide for Azure Synapse Dedicated SQL Pools.

---

## Overview

This guide covers monitoring for:

- Query performance and execution
- Resource utilization (CPU, memory, I/O)
- Workload management
- Data distribution health
- Concurrency and queuing

---

## Azure Monitor Integration

### Enable Diagnostic Settings

```bash
# Enable diagnostics for Synapse workspace
az monitor diagnostic-settings create \
    --name "synapse-diagnostics" \
    --resource "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Synapse/workspaces/{workspace}/sqlPools/{pool}" \
    --workspace "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{law}" \
    --logs '[
        {"category": "SqlRequests", "enabled": true},
        {"category": "RequestSteps", "enabled": true},
        {"category": "ExecRequests", "enabled": true},
        {"category": "DmsWorkers", "enabled": true},
        {"category": "Waits", "enabled": true}
    ]' \
    --metrics '[{"category": "AllMetrics", "enabled": true}]'
```

---

## Query Performance Monitoring

### DMV Queries

```sql
-- Active queries with resource consumption
SELECT
    r.request_id,
    r.session_id,
    r.status,
    r.submit_time,
    r.start_time,
    DATEDIFF(second, r.start_time, GETDATE()) AS running_seconds,
    r.command,
    r.resource_class,
    s.login_name,
    s.app_name
FROM sys.dm_pdw_exec_requests r
JOIN sys.dm_pdw_exec_sessions s ON r.session_id = s.session_id
WHERE r.status = 'Running'
ORDER BY r.submit_time;

-- Query history with performance metrics
SELECT TOP 100
    request_id,
    status,
    submit_time,
    start_time,
    end_time,
    DATEDIFF(second, start_time, end_time) AS duration_seconds,
    total_elapsed_time / 1000 AS elapsed_seconds,
    resource_class,
    command
FROM sys.dm_pdw_exec_requests
WHERE status = 'Completed'
ORDER BY submit_time DESC;

-- Long-running queries (> 5 minutes)
SELECT
    request_id,
    session_id,
    status,
    submit_time,
    DATEDIFF(minute, submit_time, GETDATE()) AS running_minutes,
    command
FROM sys.dm_pdw_exec_requests
WHERE status = 'Running'
    AND DATEDIFF(minute, submit_time, GETDATE()) > 5
ORDER BY submit_time;
```

### KQL Queries

```kql
// Query duration distribution
SynapseSqlPoolExecRequests
| where TimeGenerated > ago(24h)
| where Status == "Completed"
| extend DurationSeconds = TotalElapsedTimeMs / 1000
| summarize
    AvgDuration = avg(DurationSeconds),
    P50 = percentile(DurationSeconds, 50),
    P95 = percentile(DurationSeconds, 95),
    P99 = percentile(DurationSeconds, 99)
    by bin(TimeGenerated, 1h)
| render timechart

// Failed queries analysis
SynapseSqlPoolExecRequests
| where TimeGenerated > ago(24h)
| where Status == "Failed"
| summarize FailureCount = count() by ErrorId, bin(TimeGenerated, 1h)
| render timechart

// Resource class utilization
SynapseSqlPoolExecRequests
| where TimeGenerated > ago(24h)
| summarize QueryCount = count(), AvgDuration = avg(TotalElapsedTimeMs) by ResourceClass
| order by QueryCount desc
```

---

## Resource Utilization

### CPU and Memory

```sql
-- Current resource utilization
SELECT
    pdw_node_id,
    type,
    name,
    value
FROM sys.dm_pdw_nodes_os_performance_counters
WHERE name IN (
    'CPU usage %',
    'Total Server Memory (KB)',
    'Buffer cache hit ratio'
)
ORDER BY pdw_node_id, name;

-- Memory grants by resource class
SELECT
    resource_class,
    COUNT(*) AS request_count,
    SUM(request_memory_grant_used_memory_kb) / 1024 AS memory_grant_mb,
    AVG(request_memory_grant_used_memory_kb) / 1024 AS avg_memory_mb
FROM sys.dm_pdw_resource_waits w
JOIN sys.dm_pdw_exec_requests r ON w.request_id = r.request_id
WHERE w.state = 'Granted'
GROUP BY resource_class
ORDER BY memory_grant_mb DESC;
```

### I/O Monitoring

```sql
-- Data movement statistics
SELECT
    request_id,
    step_index,
    operation_type,
    distribution_type,
    DATEDIFF(second, start_time, end_time) AS duration_seconds,
    row_count,
    row_count / NULLIF(DATEDIFF(second, start_time, end_time), 0) AS rows_per_second
FROM sys.dm_pdw_request_steps
WHERE status = 'Completed'
    AND operation_type IN ('ShuffleMoveOperation', 'BroadcastMoveOperation', 'PartitionMoveOperation')
ORDER BY start_time DESC;

-- Tempdb usage
SELECT
    SUM(used_page_count) * 8 / 1024 AS tempdb_used_mb,
    SUM(total_page_count) * 8 / 1024 AS tempdb_total_mb,
    CAST(SUM(used_page_count) * 100.0 / SUM(total_page_count) AS DECIMAL(5,2)) AS pct_used
FROM sys.dm_pdw_nodes_db_file_space_usage
WHERE database_id = 2; -- tempdb
```

---

## Workload Management

### Workload Group Monitoring

```sql
-- Workload group statistics
SELECT
    wg.name AS workload_group,
    wg.min_percentage_resource,
    wg.cap_percentage_resource,
    wg.importance,
    wg.request_min_resource_grant_percent,
    wg.request_max_resource_grant_percent,
    COUNT(r.request_id) AS active_requests,
    AVG(r.total_elapsed_time) / 1000 AS avg_duration_sec
FROM sys.workload_management_workload_groups wg
LEFT JOIN sys.dm_pdw_exec_requests r
    ON r.group_name = wg.name AND r.status = 'Running'
GROUP BY
    wg.name, wg.min_percentage_resource, wg.cap_percentage_resource,
    wg.importance, wg.request_min_resource_grant_percent, wg.request_max_resource_grant_percent;

-- Classifier effectiveness
SELECT
    wc.name AS classifier,
    wg.name AS workload_group,
    COUNT(*) AS classified_requests,
    AVG(r.total_elapsed_time) / 1000 AS avg_duration_sec
FROM sys.workload_management_workload_classifiers wc
JOIN sys.workload_management_workload_groups wg ON wc.group_name = wg.name
JOIN sys.dm_pdw_exec_requests r ON r.classifier_name = wc.name
WHERE r.submit_time > DATEADD(hour, -24, GETDATE())
GROUP BY wc.name, wg.name;
```

### Concurrency Monitoring

```sql
-- Current concurrency slots
SELECT
    s.session_id,
    r.request_id,
    r.resource_class,
    r.status,
    r.submit_time,
    DATEDIFF(second, r.submit_time, GETDATE()) AS wait_time_seconds
FROM sys.dm_pdw_exec_sessions s
JOIN sys.dm_pdw_exec_requests r ON s.session_id = r.session_id
WHERE r.status IN ('Running', 'Queued')
ORDER BY r.submit_time;

-- Queued queries
SELECT
    request_id,
    status,
    resource_class,
    submit_time,
    DATEDIFF(second, submit_time, GETDATE()) AS queue_time_seconds,
    command
FROM sys.dm_pdw_exec_requests
WHERE status = 'Queued'
ORDER BY submit_time;
```

---

## Data Distribution Health

### Skew Detection

```sql
-- Table skew analysis
SELECT
    OBJECT_NAME(ps.object_id) AS table_name,
    ps.index_id,
    ps.partition_number,
    ps.pdw_node_id,
    ps.distribution_id,
    ps.row_count,
    ps.reserved_page_count * 8 / 1024 AS size_mb
FROM sys.dm_pdw_nodes_db_partition_stats ps
WHERE ps.index_id < 2
ORDER BY table_name, distribution_id;

-- Distribution skew summary
WITH dist_stats AS (
    SELECT
        OBJECT_NAME(ps.object_id) AS table_name,
        ps.distribution_id,
        SUM(ps.row_count) AS row_count
    FROM sys.dm_pdw_nodes_db_partition_stats ps
    WHERE ps.index_id < 2
    GROUP BY ps.object_id, ps.distribution_id
)
SELECT
    table_name,
    MIN(row_count) AS min_rows,
    MAX(row_count) AS max_rows,
    AVG(row_count) AS avg_rows,
    STDEV(row_count) AS stdev_rows,
    CASE
        WHEN AVG(row_count) = 0 THEN 0
        ELSE (MAX(row_count) - MIN(row_count)) * 100.0 / AVG(row_count)
    END AS skew_percent
FROM dist_stats
GROUP BY table_name
HAVING COUNT(*) > 1
ORDER BY skew_percent DESC;
```

---

## Alerting Configuration

### Critical Alerts

| Metric | Threshold | Severity |
|--------|-----------|----------|
| Query Duration | > 30 minutes | High |
| Queue Time | > 5 minutes | Medium |
| CPU Usage | > 80% sustained | High |
| Memory Pressure | Grant wait > 2 min | High |
| Failed Queries | > 5/hour | Medium |
| Data Skew | > 50% variance | Low |

### Alert Implementation

```json
{
    "alerts": [
        {
            "name": "Long Running Query",
            "query": "SynapseSqlPoolExecRequests | where Status == 'Running' and TotalElapsedTimeMs > 1800000",
            "severity": 2,
            "frequency": "PT5M"
        },
        {
            "name": "High Queue Time",
            "query": "SynapseSqlPoolExecRequests | where Status == 'Queued' | extend QueueTimeMin = datetime_diff('minute', now(), SubmitTime) | where QueueTimeMin > 5",
            "severity": 2,
            "frequency": "PT5M"
        },
        {
            "name": "Query Failures",
            "query": "SynapseSqlPoolExecRequests | where Status == 'Failed' | summarize FailCount = count() by bin(TimeGenerated, 1h) | where FailCount > 5",
            "severity": 1,
            "frequency": "PT15M"
        }
    ]
}
```

---

## Performance Dashboard

### Recommended Panels

1. **Query Performance**
   - Active queries count
   - Average query duration
   - Query success rate
   - Long-running queries list

2. **Resource Utilization**
   - CPU utilization %
   - Memory usage
   - Tempdb usage
   - DWU consumption

3. **Workload Management**
   - Requests by workload group
   - Queue depth
   - Concurrency utilization
   - Resource class distribution

4. **Data Health**
   - Distribution skew alerts
   - Index fragmentation
   - Statistics staleness

---

## Related Documentation

- [Dedicated SQL Best Practices](../../../best-practices/sql-performance/README.md)
- [Dedicated SQL Troubleshooting](../../../troubleshooting/dedicated-sql-troubleshooting.md)
- [Workload Management](../../../02-services/analytics-compute/azure-synapse/sql-pools/workload-management.md)

---

*Last Updated: January 2025*
