# Capture Optimization

> **[Home](../../../../README.md)** | **[Best Practices](../../README.md)** | **[Cross-Cutting](../README.md)** | **Capture Optimization**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Storage-green?style=flat-square)

Best practices for Event Hubs Capture and data ingestion optimization.

---

## Overview

Event Hubs Capture automatically delivers streaming data to Azure Blob Storage or Azure Data Lake Storage, enabling seamless integration with batch analytics.

---

## Capture Configuration

### Optimal Settings

| Parameter | Recommended | Notes |
|-----------|-------------|-------|
| Size window | 100-300 MB | Balance between file size and latency |
| Time window | 5-15 minutes | Adjust based on throughput |
| File format | Avro | Native format, best performance |
| Encoding | Avro with Snappy | Good compression ratio |

### Terraform Configuration

```hcl
resource "azurerm_eventhub" "capture" {
  name                = "eh-iot-telemetry"
  namespace_name      = azurerm_eventhub_namespace.main.name
  resource_group_name = var.resource_group_name
  partition_count     = 32
  message_retention   = 7

  capture_description {
    enabled             = true
    encoding            = "Avro"
    interval_in_seconds = 300  # 5 minutes
    size_limit_in_bytes = 314572800  # 300 MB
    skip_empty_archives = true

    destination {
      name                = "EventHubArchive.AzureBlockBlob"
      archive_name_format = "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}"
      blob_container_name = "capture"
      storage_account_id  = azurerm_storage_account.capture.id
    }
  }
}
```

---

## File Organization

### Partition Strategy

```
datalake/
└── capture/
    └── eventhub-ns/
        └── eh-telemetry/
            ├── 0/              # Partition 0
            │   └── 2024/01/15/10/00/00/
            │       └── 0_abc123.avro
            ├── 1/              # Partition 1
            │   └── 2024/01/15/10/00/00/
            │       └── 1_def456.avro
            └── ...
```

### Custom Path Format

```hcl
# Optimized for Delta Lake processing
archive_name_format = "bronze/iot/{EventHub}/year={Year}/month={Month}/day={Day}/hour={Hour}/{PartitionId}_{Second}"
```

---

## Processing Captured Data

### Auto Loader Integration

```python
# Read captured Avro files with Auto Loader
df = (spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "avro")
    .option("cloudFiles.schemaLocation", "/checkpoints/iot/schema")
    .option("cloudFiles.includeExistingFiles", "true")
    .load("abfss://capture@datalake.dfs.core.windows.net/bronze/iot/"))

# Process and write to Delta
(df.writeStream
    .format("delta")
    .option("checkpointLocation", "/checkpoints/iot/delta")
    .option("mergeSchema", "true")
    .trigger(availableNow=True)
    .toTable("bronze.iot_telemetry"))
```

### Batch Processing

```python
# Process captured files in batch
from pyspark.sql.functions import input_file_name, col

def process_captured_files(date: str):
    """Process captured files for a specific date."""
    path = f"abfss://capture@datalake.dfs.core.windows.net/bronze/iot/*/year={date[:4]}/month={date[5:7]}/day={date[8:10]}/"

    df = (spark.read
        .format("avro")
        .load(path)
        .withColumn("source_file", input_file_name())
        .withColumn("partition_id",
            regexp_extract(col("source_file"), r"/(\d+)_", 1)))

    return df
```

---

## Performance Optimization

### Throughput Scaling

```python
# Calculate optimal partition count
def calculate_partitions(
    events_per_second: int,
    event_size_kb: float,
    capture_interval_minutes: int = 5,
    target_file_size_mb: int = 128
) -> int:
    """Calculate partition count for optimal file sizes."""
    data_per_interval_mb = (events_per_second * event_size_kb * 60 * capture_interval_minutes) / 1024
    partitions = max(1, int(data_per_interval_mb / target_file_size_mb))
    # Round up to power of 2
    return 2 ** (partitions - 1).bit_length()

# Example: 10K events/sec, 1KB each, 5 min capture
partitions = calculate_partitions(10000, 1.0, 5, 128)  # Returns 32
```

### File Compaction

```python
# Compact small capture files
def compact_capture_files(source_path: str, target_path: str, target_size_mb: int = 128):
    """Compact small Avro files into larger Parquet files."""
    df = spark.read.format("avro").load(source_path)

    # Calculate optimal partition count
    total_size = df.rdd.map(lambda x: len(str(x))).sum() / (1024 * 1024)
    num_files = max(1, int(total_size / target_size_mb))

    (df.repartition(num_files)
        .write
        .format("parquet")
        .mode("overwrite")
        .save(target_path))
```

---

## Monitoring

### Capture Metrics

```kql
// Monitor capture throughput
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.EVENTHUB"
| where Category == "ArchiveLogs"
| summarize
    CapturedMessages = sum(toint(archiveMessageCount_d)),
    CapturedBytes = sum(toint(archiveSize_d)),
    FileCount = count()
    by bin(TimeGenerated, 1h), EventHub = Resource
| order by TimeGenerated desc
```

### Alert Configuration

```json
{
    "type": "Microsoft.Insights/metricAlerts",
    "properties": {
        "severity": 2,
        "criteria": {
            "odata.type": "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",
            "allOf": [
                {
                    "name": "CaptureBytesBacklog",
                    "metricName": "CaptureBacklog",
                    "operator": "GreaterThan",
                    "threshold": 1073741824,
                    "timeAggregation": "Average"
                }
            ]
        }
    }
}
```

---

## Cost Optimization

### Storage Tiers

```python
# Move old capture files to cool storage
def apply_lifecycle_policy():
    """Configure lifecycle management for capture storage."""
    policy = {
        "rules": [
            {
                "name": "move-capture-to-cool",
                "enabled": True,
                "type": "Lifecycle",
                "definition": {
                    "filters": {
                        "blobTypes": ["blockBlob"],
                        "prefixMatch": ["capture/"]
                    },
                    "actions": {
                        "baseBlob": {
                            "tierToCool": {"daysAfterModificationGreaterThan": 7},
                            "tierToArchive": {"daysAfterModificationGreaterThan": 30},
                            "delete": {"daysAfterModificationGreaterThan": 365}
                        }
                    }
                }
            }
        ]
    }
    return policy
```

### Compression Analysis

| Format | Compression | Size Reduction | Read Performance |
|--------|-------------|----------------|------------------|
| Avro (none) | None | 0% | Fast |
| Avro (snappy) | Snappy | 40-60% | Fast |
| Avro (deflate) | Deflate | 60-70% | Medium |
| Parquet (snappy) | Snappy | 70-80% | Fast |

---

## Related Documentation

- [Event Hubs Overview](../../../../02-services/streaming-services/azure-event-hubs/README.md)
- [Event Hubs DR](../../operational-excellence/eventhub-dr.md)
- [Storage Best Practices](../../service-specific/storage/README.md)

---

*Last Updated: January 2025*
