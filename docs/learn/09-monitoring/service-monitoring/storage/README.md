# Storage Monitoring

> **[Home](../../../README.md)** | **[Monitoring](../../README.md)** | **Storage Monitoring**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Azure%20Storage-blue?style=flat-square)

Comprehensive monitoring guide for Azure Data Lake Storage Gen2 and Blob Storage.

---

## Overview

This guide covers monitoring for:

- Storage account health
- Capacity and usage metrics
- Transaction and latency metrics
- Data Lake access patterns
- Security and compliance

---

## Azure Monitor Integration

### Enable Diagnostic Settings

```bash
# Enable storage diagnostics
az monitor diagnostic-settings create \
    --name "storage-diagnostics" \
    --resource "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}" \
    --workspace "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{law}" \
    --logs '[
        {"category": "StorageRead", "enabled": true},
        {"category": "StorageWrite", "enabled": true},
        {"category": "StorageDelete", "enabled": true}
    ]' \
    --metrics '[{"category": "Transaction", "enabled": true}]'
```

---

## Capacity Monitoring

### KQL Queries

```kql
// Storage capacity trend
StorageAccountCapacity
| where TimeGenerated > ago(30d)
| where MetricName == "UsedCapacity"
| summarize AvgCapacityGB = avg(Value) / (1024*1024*1024) by StorageAccount, bin(TimeGenerated, 1d)
| render timechart

// Blob count by container
StorageBlobInventory
| where TimeGenerated > ago(1d)
| summarize BlobCount = count(), TotalSizeGB = sum(ContentLength) / (1024*1024*1024) by Container
| order by TotalSizeGB desc

// Growth rate analysis
StorageAccountCapacity
| where TimeGenerated > ago(30d)
| where MetricName == "UsedCapacity"
| summarize DailyCapacity = avg(Value) by StorageAccount, bin(TimeGenerated, 1d)
| order by TimeGenerated asc
| serialize
| extend PrevCapacity = prev(DailyCapacity, 1)
| extend GrowthRate = (DailyCapacity - PrevCapacity) / PrevCapacity * 100
| where isnotnull(GrowthRate)
```

### Capacity Alerts

| Metric | Warning | Critical |
|--------|---------|----------|
| Used Capacity | > 70% quota | > 85% quota |
| Blob Count | > 1M per container | > 5M per container |
| Daily Growth | > 10% | > 25% |

---

## Transaction Monitoring

### Request Metrics

```kql
// Transaction summary by API
StorageBlobLogs
| where TimeGenerated > ago(24h)
| summarize
    TotalRequests = count(),
    SuccessfulRequests = countif(StatusCode >= 200 and StatusCode < 300),
    FailedRequests = countif(StatusCode >= 400)
    by OperationName, bin(TimeGenerated, 1h)
| extend SuccessRate = round(SuccessfulRequests * 100.0 / TotalRequests, 2)
| order by TotalRequests desc

// Latency analysis
StorageBlobLogs
| where TimeGenerated > ago(24h)
| summarize
    AvgLatencyMs = avg(TotalTimeMs),
    P50Latency = percentile(TotalTimeMs, 50),
    P95Latency = percentile(TotalTimeMs, 95),
    P99Latency = percentile(TotalTimeMs, 99)
    by OperationName, bin(TimeGenerated, 1h)
| where P99Latency > 1000

// Throttled requests
StorageBlobLogs
| where TimeGenerated > ago(24h)
| where StatusCode == 503 or StatusCode == 429
| summarize ThrottledCount = count() by bin(TimeGenerated, 5m), OperationName
| render timechart
```

---

## Data Lake Analytics

### Access Patterns

```kql
// Most accessed paths
StorageBlobLogs
| where TimeGenerated > ago(7d)
| where OperationName == "GetBlob"
| extend Path = parse_url(Uri).Path
| summarize AccessCount = count() by Path
| top 20 by AccessCount desc

// Access by caller IP
StorageBlobLogs
| where TimeGenerated > ago(24h)
| summarize RequestCount = count() by CallerIpAddress
| top 10 by RequestCount desc

// Data transfer volume
StorageBlobLogs
| where TimeGenerated > ago(24h)
| summarize
    IngressGB = sum(RequestBodySize) / (1024*1024*1024),
    EgressGB = sum(ResponseBodySize) / (1024*1024*1024)
    by bin(TimeGenerated, 1h)
| render timechart
```

### Delta Lake Monitoring

```python
# Monitor Delta Lake table health
from delta.tables import DeltaTable
from pyspark.sql.functions import *

def get_delta_metrics(table_path: str) -> dict:
    """Get Delta table health metrics."""
    dt = DeltaTable.forPath(spark, table_path)

    # Get table history
    history = dt.history().select(
        "version", "timestamp", "operation",
        "operationMetrics.numFiles",
        "operationMetrics.numOutputRows"
    ).limit(100).collect()

    # Get table details
    detail = dt.detail().collect()[0]

    return {
        "name": detail.name,
        "location": detail.location,
        "num_files": detail.numFiles,
        "size_bytes": detail.sizeInBytes,
        "partitions": detail.partitionColumns,
        "version": history[0].version if history else 0,
        "last_modified": history[0].timestamp if history else None
    }

# Usage
metrics = get_delta_metrics("abfss://data@storage.dfs.core.windows.net/delta/customers")
print(metrics)
```

---

## Security Monitoring

### Access Auditing

```kql
// Failed authentication attempts
StorageBlobLogs
| where TimeGenerated > ago(24h)
| where StatusCode == 401 or StatusCode == 403
| summarize FailedAttempts = count() by CallerIpAddress, AuthenticationType
| where FailedAttempts > 10
| order by FailedAttempts desc

// Anonymous access detection
StorageBlobLogs
| where TimeGenerated > ago(24h)
| where AuthenticationType == "Anonymous"
| summarize RequestCount = count() by Uri
| order by RequestCount desc

// SAS token usage
StorageBlobLogs
| where TimeGenerated > ago(7d)
| where AuthenticationType == "SAS"
| summarize
    RequestCount = count(),
    UniqueIPs = dcount(CallerIpAddress)
    by bin(TimeGenerated, 1d)
```

### Compliance Alerts

| Event | Condition | Action |
|-------|-----------|--------|
| Anonymous Access | Any anonymous request | Alert security team |
| Multiple Auth Failures | > 10 from same IP | Block IP |
| Unusual Data Egress | > 2x normal volume | Investigate |
| Cross-region Access | Access from unexpected region | Review |

---

## Dashboard Configuration

### Azure Monitor Workbook

```json
{
    "version": "Notebook/1.0",
    "items": [
        {
            "type": "metric",
            "name": "Storage Capacity",
            "metrics": [
                {"resourceType": "microsoft.storage/storageaccounts", "name": "UsedCapacity"}
            ],
            "timeRange": "P30D"
        },
        {
            "type": "query",
            "name": "Transaction Success Rate",
            "query": "StorageBlobLogs | summarize SuccessRate = countif(StatusCode < 400) * 100.0 / count() by bin(TimeGenerated, 1h)"
        },
        {
            "type": "query",
            "name": "Top Accessed Files",
            "query": "StorageBlobLogs | where OperationName == 'GetBlob' | summarize Count = count() by Uri | top 10 by Count"
        }
    ]
}
```

---

## Cost Optimization

### Storage Tier Analysis

```kql
// Identify cold data candidates
StorageBlobLogs
| where TimeGenerated > ago(90d)
| summarize LastAccess = max(TimeGenerated) by Uri
| where LastAccess < ago(30d)
| count

// Access frequency by tier
StorageBlobLogs
| where TimeGenerated > ago(30d)
| join kind=inner (
    StorageBlobInventory | where TimeGenerated > ago(1d) | project Uri, AccessTier
) on Uri
| summarize AccessCount = count() by AccessTier
```

---

## Related Documentation

- [Data Lake Architecture](../../../architecture/delta-lakehouse/README.md)
- [Cost Optimization](../../../best-practices/cost-optimization/README.md)
- [Security Best Practices](../../../best-practices/security/README.md)

---

*Last Updated: January 2025*
