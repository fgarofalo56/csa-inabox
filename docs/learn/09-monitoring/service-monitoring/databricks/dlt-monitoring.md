# Delta Live Tables Monitoring

> **[Home](../../../README.md)** | **[Monitoring](../../README.md)** | **[Databricks](README.md)** | **DLT Monitoring**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Feature](https://img.shields.io/badge/Feature-Delta%20Live%20Tables-blue?style=flat-square)

Comprehensive monitoring guide for Delta Live Tables pipelines.

---

## Overview

Delta Live Tables (DLT) monitoring covers:

- Pipeline health and execution status
- Data quality expectations
- Flow metrics and throughput
- Cost optimization

---

## Pipeline Event Logs

### Access Event Logs

```python
# Query DLT event logs
from pyspark.sql.functions import *

# Event log location (auto-created by DLT)
event_log_path = f"/pipelines/{pipeline_id}/system/events"

events = spark.read.format("delta").load(event_log_path)

# Recent pipeline events
events.filter(col("timestamp") > current_timestamp() - expr("INTERVAL 24 HOURS")) \
    .select("timestamp", "event_type", "message", "details") \
    .orderBy(desc("timestamp")) \
    .display()
```

### Event Types

| Event Type | Description | Action |
|------------|-------------|--------|
| `flow_progress` | Data flow metrics | Monitor throughput |
| `dataset_quality` | Expectation results | Check data quality |
| `update_progress` | Pipeline update status | Track execution |
| `maintenance_progress` | Auto-optimization | Monitor maintenance |

---

## Data Quality Monitoring

### Expectations Dashboard

```python
# Extract quality metrics from event logs
quality_events = events.filter(col("event_type") == "flow_progress") \
    .select(
        col("timestamp"),
        col("origin.flow_name").alias("flow_name"),
        col("details:flow_progress:metrics:num_output_rows").cast("long").alias("output_rows"),
        col("details:flow_progress:data_quality:dropped_records").cast("long").alias("dropped_records"),
        col("details:flow_progress:data_quality:expectations").alias("expectations")
    )

# Calculate quality scores
quality_metrics = quality_events \
    .withColumn("quality_score",
        (col("output_rows") - col("dropped_records")) / col("output_rows") * 100) \
    .groupBy("flow_name") \
    .agg(
        avg("quality_score").alias("avg_quality_score"),
        sum("dropped_records").alias("total_dropped"),
        sum("output_rows").alias("total_processed")
    )

quality_metrics.display()
```

### Expectation Alert Configuration

```python
# Define expectations in DLT pipeline
import dlt
from pyspark.sql.functions import *

@dlt.table(
    comment="Clean customer data with quality expectations"
)
@dlt.expect_or_drop("valid_email", "email RLIKE '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$'")
@dlt.expect_or_fail("valid_customer_id", "customer_id IS NOT NULL")
@dlt.expect("recent_data", "event_date >= current_date() - INTERVAL 30 DAYS")
def clean_customers():
    return spark.table("bronze.customers")
```

### KQL Query for Quality Alerts

```kql
// Quality expectation failures
DatabricksNotebook
| where TimeGenerated > ago(24h)
| where Message contains "expectation" and Message contains "failed"
| extend Pipeline = extract("pipeline_id=([^,]+)", 1, Message)
| extend Expectation = extract("expectation=([^,]+)", 1, Message)
| summarize FailureCount = count() by Pipeline, Expectation, bin(TimeGenerated, 1h)
| where FailureCount > 100
```

---

## Flow Metrics

### Throughput Monitoring

```python
# Calculate flow throughput
from pyspark.sql.functions import window

flow_metrics = events \
    .filter(col("event_type") == "flow_progress") \
    .select(
        col("timestamp"),
        col("origin.flow_name").alias("flow_name"),
        col("details:flow_progress:metrics:num_output_rows").cast("long").alias("rows"),
        col("details:flow_progress:metrics:duration_ms").cast("long").alias("duration_ms")
    ) \
    .withColumn("rows_per_second", col("rows") / (col("duration_ms") / 1000)) \
    .groupBy(
        window("timestamp", "1 hour"),
        "flow_name"
    ) \
    .agg(
        avg("rows_per_second").alias("avg_throughput"),
        max("rows_per_second").alias("peak_throughput"),
        sum("rows").alias("total_rows")
    )

flow_metrics.orderBy(desc("window")).display()
```

### Latency Analysis

```python
# End-to-end latency tracking
latency_events = events \
    .filter(col("event_type") == "update_progress") \
    .filter(col("details:update_progress:state") == "COMPLETED") \
    .select(
        col("timestamp"),
        col("origin.update_id").alias("update_id"),
        col("details:update_progress:update_start_time").cast("timestamp").alias("start_time")
    ) \
    .withColumn("duration_minutes",
        (unix_timestamp("timestamp") - unix_timestamp("start_time")) / 60)

# Alert on slow updates
slow_updates = latency_events.filter(col("duration_minutes") > 30)
```

---

## Pipeline Health Dashboard

### Dashboard Configuration

```json
{
    "dashboardName": "DLT Pipeline Monitoring",
    "widgets": [
        {
            "name": "Pipeline Status",
            "type": "counter",
            "query": "SELECT status, count(*) FROM pipeline_runs GROUP BY status"
        },
        {
            "name": "Data Quality Score",
            "type": "gauge",
            "query": "SELECT AVG(quality_score) FROM flow_metrics WHERE timestamp > NOW() - INTERVAL 24 HOURS"
        },
        {
            "name": "Throughput Trend",
            "type": "timeseries",
            "query": "SELECT timestamp, flow_name, rows_per_second FROM flow_metrics"
        },
        {
            "name": "Failed Expectations",
            "type": "table",
            "query": "SELECT flow_name, expectation, failure_count FROM quality_failures ORDER BY failure_count DESC LIMIT 10"
        }
    ]
}
```

---

## Alerting Rules

### Critical Alerts

| Metric | Threshold | Action |
|--------|-----------|--------|
| Pipeline Failure | Any failure | Page on-call |
| Quality Score Drop | < 95% | Notify team |
| Throughput Drop | < 50% of baseline | Investigate |
| Update Duration | > 2x normal | Scale resources |

### Alert Implementation

```python
# Custom alerting function
import requests

def send_dlt_alert(pipeline_name: str, alert_type: str, details: dict):
    """Send alert to monitoring system."""
    webhook_url = dbutils.secrets.get("monitoring", "alert-webhook")

    payload = {
        "pipeline": pipeline_name,
        "alert_type": alert_type,
        "severity": "high" if alert_type in ["failure", "quality_drop"] else "medium",
        "details": details,
        "timestamp": datetime.utcnow().isoformat()
    }

    response = requests.post(webhook_url, json=payload)
    return response.status_code == 200

# Usage in DLT pipeline
@dlt.table
def monitored_table():
    df = spark.table("bronze.events")

    # Check quality threshold
    quality_score = df.filter(col("is_valid")).count() / df.count()
    if quality_score < 0.95:
        send_dlt_alert("events_pipeline", "quality_drop", {"score": quality_score})

    return df
```

---

## Cost Optimization

### DBU Consumption Tracking

```python
# Track DBU usage by pipeline
dbu_metrics = events \
    .filter(col("event_type") == "cluster_resources") \
    .select(
        col("timestamp"),
        col("origin.pipeline_name").alias("pipeline"),
        col("details:cluster_resources:num_executors").cast("int").alias("executors"),
        col("details:cluster_resources:dbu_rate").cast("double").alias("dbu_rate")
    ) \
    .withColumn("hour", date_trunc("hour", "timestamp")) \
    .groupBy("hour", "pipeline") \
    .agg(
        avg("executors").alias("avg_executors"),
        sum("dbu_rate").alias("total_dbu")
    )

# Identify cost optimization opportunities
high_cost_pipelines = dbu_metrics \
    .groupBy("pipeline") \
    .agg(sum("total_dbu").alias("total_dbu_7d")) \
    .orderBy(desc("total_dbu_7d"))
```

---

## Related Documentation

- [Databricks Monitoring Index](README.md)
- [Delta Lake Best Practices](../../../best-practices/delta-lake-optimization.md)
- [Pipeline Troubleshooting](../../../troubleshooting/pipeline-troubleshooting/README.md)

---

*Last Updated: January 2025*
