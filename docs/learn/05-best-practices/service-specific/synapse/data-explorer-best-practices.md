# Data Explorer Best Practices

> **[Home](../../../README.md)** | **[Best Practices](../../README.md)** | **[Synapse](README.md)** | **Data Explorer**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Service](https://img.shields.io/badge/Service-Data%20Explorer-purple?style=flat-square)

Best practices for Azure Data Explorer (Kusto) pools in Synapse.

---

## Overview

Data Explorer is optimized for:

- Log and telemetry analytics
- Time-series analysis
- Real-time dashboards
- Ad-hoc exploration

---

## Schema Design

### Table Optimization

```kql
// Create table with optimal settings
.create table Events (
    Timestamp: datetime,
    EventType: string,
    UserId: string,
    Properties: dynamic
) with (docstring = "Event telemetry", folder = "Telemetry")

// Enable streaming ingestion
.alter table Events policy streamingingestion enable

// Set caching policy
.alter table Events policy caching hot = 30d
```

### Column Types

| Type | Use Case | Avoid |
|------|----------|-------|
| datetime | Timestamps | string for dates |
| string | Categorical data | for numeric IDs |
| dynamic | JSON/nested data | Overuse |
| real | Decimal numbers | int for decimals |

---

## Query Optimization

### Efficient Queries

```kql
// Good: Filter early, select needed columns
Events
| where Timestamp > ago(7d)
| where EventType == "PageView"
| project Timestamp, UserId, Properties.page
| summarize Views = count() by UserId

// Avoid: Select all then filter
// Events | project * | where EventType == "PageView"
```

### Time Filters

```kql
// Always filter on time first
Events
| where Timestamp between (datetime(2024-01-01) .. datetime(2024-01-31))
| where EventType == "Purchase"

// Use ingestion_time() for recent data
Events
| where ingestion_time() > ago(1h)
```

---

## Ingestion Best Practices

### Batch Ingestion

```kql
// Ingest from blob storage
.ingest into table Events (
    h'https://storage.blob.core.windows.net/data/events.json'
) with (
    format = 'multijson',
    ingestionMappingReference = 'EventMapping'
)
```

### Streaming Ingestion

```python
# Python SDK streaming
from azure.kusto.data import KustoClient, KustoConnectionStringBuilder
from azure.kusto.ingest import QueuedIngestClient, IngestionProperties

ingest_client = QueuedIngestClient(
    KustoConnectionStringBuilder.with_aad_device_authentication(cluster_uri)
)

props = IngestionProperties(
    database="telemetry",
    table="Events",
    data_format=DataFormat.JSON
)

ingest_client.ingest_from_dataframe(df, props)
```

---

## Performance Tips

### Materialized Views

```kql
// Create materialized view for aggregations
.create materialized-view EventSummary on table Events {
    Events
    | summarize DailyCount = count(), TotalValue = sum(Value)
        by EventType, bin(Timestamp, 1d)
}
```

### Update Policies

```kql
// Auto-transform ingested data
.alter table CleanEvents policy update @'[{
    "IsEnabled": true,
    "Source": "RawEvents",
    "Query": "RawEvents | extend CleanedField = trim(' ', RawField)"
}]'
```

---

## Retention & Caching

```kql
// Set retention policy (default: 3650 days)
.alter table Events policy retention
```
{ "SoftDeletePeriod": "365.00:00:00", "Recoverability": "Enabled" }
```

// Set caching policy
.alter table Events policy caching hot = 30d
```

---

## Related Documentation

- [Data Explorer Pools](../../../02-services/analytics-compute/azure-synapse/data-explorer-pools/README.md)
- [Real-time Analytics](../../../03-architecture-patterns/streaming-architectures/README.md)
- [Synapse Best Practices](dedicated-sql-best-practices.md)

---

*Last Updated: January 2025*
