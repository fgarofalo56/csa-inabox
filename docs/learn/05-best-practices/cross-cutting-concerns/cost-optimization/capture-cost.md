---
title: "Event Hubs Capture Cost Optimization"
description: "Cost optimization strategies for Azure Event Hubs Capture"
author: "CSA Documentation Team"
last_updated: "2025-12-10"
version: "1.0.0"
category: "Best Practices - Cost"
---

# Event Hubs Capture Cost Optimization

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow)
![Impact](https://img.shields.io/badge/Savings-20--40%25-green)

> **💰 Capture Cost Strategy**
> Optimize Event Hubs Capture costs through intelligent configuration, data lifecycle management, and storage optimization while maintaining data availability for analytics.

## 📋 Table of Contents

- [Overview](#overview)
- [Cost Model](#cost-model)
- [Capture Configuration Optimization](#capture-configuration-optimization)
- [Storage Cost Optimization](#storage-cost-optimization)
- [Data Retention Strategy](#data-retention-strategy)
- [Format Selection](#format-selection)
- [Monitoring and Optimization](#monitoring-and-optimization)
- [Implementation Checklist](#implementation-checklist)

## Overview

### Event Hubs Capture Costs

| Cost Component | Pricing Model | Optimization Strategy |
|----------------|---------------|---------------------|
| **Capture Fee** | Per GB captured | Optimize capture window |
| **Storage Costs** | Storage tier + transactions | Lifecycle policies, compression |
| **Data Transfer** | Egress charges | Regional co-location |
| **Throughput Units** | Hourly rate | Right-sizing, auto-inflate |

### Quick Wins

1. **Optimize Capture Window** - Reduce capture frequency for non-critical events
2. **Enable Compression** - Use Avro compression for captured files
3. **Implement Lifecycle Policies** - Auto-tier to cool/archive storage
4. **Right-Size Throughput Units** - Match TUs to actual throughput needs
5. **Clean Up Old Captures** - Delete or archive old captured data

**Potential Savings:** 20-40% on capture and storage costs

## Cost Model

### Capture Pricing Example

```text
Assumptions:
- Event ingestion: 100 GB/day
- Capture enabled: 24/7
- Storage tier: Hot
- Retention: 90 days

Monthly Costs:
1. Capture Fee: 100 GB/day × 30 days × $0.10/GB = $300
2. Storage: 3,000 GB × $0.0184/GB = $55.20
3. Throughput Units: 2 TUs × 730 hours × $0.015/hour = $21.90

Total: $377.10/month

With Optimizations:
1. Capture Fee: 100 GB/day × 30 days × $0.10/GB = $300 (same)
2. Storage (cool tier): 3,000 GB × $0.01/GB = $30.00
3. Throughput Units (auto-inflate): 1.5 TUs avg × 730 × $0.015 = $16.43

Optimized Total: $346.43/month
Savings: $30.67/month (8.1%)
```

## Capture Configuration Optimization

### 1. Optimize Capture Window

**Configure Time-Based Capture:**

```bash
# Azure CLI: Configure capture with optimized window
az eventhubs eventhub update \
    --resource-group rg-streaming \
    --namespace-name eh-namespace \
    --name event-hub-name \
    --enable-capture true \
    --capture-interval 900 \
    --capture-size-limit 314572800

# Time window: 15 minutes (900 seconds)
# Size limit: 300 MB (314572800 bytes)
```

**PowerShell Configuration:**

```powershell
# Configure capture with cost-optimized settings
$ResourceGroup = "rg-streaming"
$Namespace = "eh-namespace"
$EventHub = "event-hub-name"

# Enable capture with larger time windows for cost savings
Set-AzEventHubEventHub `
    -ResourceGroupName $ResourceGroup `
    -NamespaceName $Namespace `
    -Name $EventHub `
    -EnableCapture $true `
    -CaptureIntervalInSeconds 900 `
    -CaptureSizeLimitInBytes 314572800 `
    -Destination @{
        Name = "EventHubArchive.AzureBlockBlob"
        BlobContainer = "eventhub-capture"
        StorageAccountResourceId = "/subscriptions/{sub}/resourceGroups/rg-storage/providers/Microsoft.Storage/storageAccounts/stcapture"
        ArchiveNameFormat = "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}"
    }
```

### 2. Conditional Capture

**Capture Only Business Hours:**

```python
from azure.eventhub import EventHubConsumerClient
from azure.identity import DefaultAzureCredential
from datetime import datetime

class ConditionalCaptureManager:
    def __init__(self, resource_group, namespace, event_hub):
        self.resource_group = resource_group
        self.namespace = namespace
        self.event_hub = event_hub

    def should_capture(self):
        """Determine if capture should be enabled based on business hours"""
        now = datetime.now()
        # Capture only during business hours (9 AM - 6 PM weekdays)
        if now.weekday() >= 5:  # Weekend
            return False
        if now.hour < 9 or now.hour >= 18:  # Outside business hours
            return False
        return True

    def toggle_capture(self, enable):
        """Enable or disable capture based on schedule"""
        import subprocess

        cmd = f"""
        az eventhubs eventhub update \
            --resource-group {self.resource_group} \
            --namespace-name {self.namespace} \
            --name {self.event_hub} \
            --enable-capture {str(enable).lower()}
        """
        subprocess.run(cmd, shell=True, check=True)

# Azure Function or Logic App to run hourly
def main():
    manager = ConditionalCaptureManager(
        resource_group="rg-streaming",
        namespace="eh-namespace",
        event_hub="event-hub-name"
    )

    enable_capture = manager.should_capture()
    manager.toggle_capture(enable_capture)
```

**Estimated Savings:** 50-60% on capture fees for business-hours-only scenarios

### 3. Partition-Specific Capture

**ARM Template for Selective Capture:**

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "resources": [
    {
      "type": "Microsoft.EventHub/namespaces/eventhubs",
      "apiVersion": "2022-01-01-preview",
      "name": "[concat(parameters('namespaceName'), '/', parameters('eventHubName'))]",
      "properties": {
        "partitionCount": 4,
        "messageRetentionInDays": 7,
        "captureDescription": {
          "enabled": true,
          "encoding": "Avro",
          "intervalInSeconds": 900,
          "sizeLimitInBytes": 314572800,
          "destination": {
            "name": "EventHubArchive.AzureBlockBlob",
            "properties": {
              "storageAccountResourceId": "[parameters('storageAccountId')]",
              "blobContainer": "critical-events-only",
              "archiveNameFormat": "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}"
            }
          },
          "skipEmptyArchives": true
        }
      }
    }
  ]
}
```

## Storage Cost Optimization

### 1. Lifecycle Management

**Automated Tiering Policy:**

```json
{
  "rules": [
    {
      "enabled": true,
      "name": "capture-lifecycle",
      "type": "Lifecycle",
      "definition": {
        "actions": {
          "baseBlob": {
            "tierToCool": {
              "daysAfterModificationGreaterThan": 7
            },
            "tierToArchive": {
              "daysAfterModificationGreaterThan": 30
            },
            "delete": {
              "daysAfterModificationGreaterThan": 90
            }
          }
        },
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["eventhub-capture/"]
        }
      }
    },
    {
      "enabled": true,
      "name": "rapid-tier-hot-data",
      "type": "Lifecycle",
      "definition": {
        "actions": {
          "baseBlob": {
            "tierToCool": {
              "daysAfterModificationGreaterThan": 1
            },
            "tierToArchive": {
              "daysAfterModificationGreaterThan": 7
            }
          }
        },
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["eventhub-capture/high-volume/"]
        }
      }
    }
  ]
}
```

**Apply Lifecycle Policy:**

```bash
# Create lifecycle management policy
az storage account management-policy create \
    --account-name stcapture \
    --resource-group rg-storage \
    --policy @lifecycle-policy.json
```

**Cost Impact:** 50-70% storage cost reduction

### 2. Compression Optimization

**Avro with Snappy Compression:**

```bash
# Configure capture with compression
az eventhubs eventhub update \
    --resource-group rg-streaming \
    --namespace-name eh-namespace \
    --name event-hub-name \
    --enable-capture true \
    --encoding Avro \
    --skip-empty-archives true
```

**Verify Compression Ratio:**

```python
import avro.datafile
import avro.io
import os

def analyze_capture_files(storage_path):
    """Analyze captured Avro files for compression efficiency"""

    total_original_size = 0
    total_compressed_size = 0

    for root, dirs, files in os.walk(storage_path):
        for file in files:
            if file.endswith('.avro'):
                file_path = os.path.join(root, file)
                compressed_size = os.path.getsize(file_path)

                # Read Avro file to estimate original size
                with avro.datafile.DataFileReader(
                    open(file_path, 'rb'),
                    avro.io.DatumReader()
                ) as reader:
                    record_count = sum(1 for _ in reader)
                    avg_record_size = compressed_size / record_count if record_count > 0 else 0
                    estimated_original = record_count * avg_record_size * 2  # Rough estimate

                    total_original_size += estimated_original
                    total_compressed_size += compressed_size

    compression_ratio = (1 - total_compressed_size / total_original_size) * 100
    print(f"Compression Ratio: {compression_ratio:.2f}%")
    print(f"Total Original Size: {total_original_size / (1024**3):.2f} GB")
    print(f"Total Compressed Size: {total_compressed_size / (1024**3):.2f} GB")
    print(f"Storage Savings: ${(total_original_size - total_compressed_size) / (1024**3) * 0.0184:.2f}/month")

# Run analysis
analyze_capture_files("/mnt/capture-analysis")
```

## Data Retention Strategy

### 1. Compliance-Based Retention

**Retention Policy by Data Class:**

| Data Classification | Retention Period | Storage Tier | Cost Impact |
|---------------------|------------------|--------------|-------------|
| **Critical Events** | 365 days | Hot → Cool (30d) → Archive (90d) | High retention, optimized cost |
| **Operational Events** | 90 days | Cool (7d) → Archive (30d) | Medium retention |
| **Debug/Trace Events** | 30 days | Cool (1d) → Delete (30d) | Low retention, minimal cost |
| **Audit Events** | 2,555 days (7 years) | Archive (30d) | Long retention, archive tier |

**PowerShell Retention Script:**

```powershell
# Automated retention enforcement
param(
    [string]$StorageAccountName = "stcapture",
    [string]$ResourceGroup = "rg-storage"
)

function Remove-OldCaptures {
    param(
        [string]$Container,
        [int]$RetentionDays
    )

    $context = (Get-AzStorageAccount -ResourceGroupName $ResourceGroup -Name $StorageAccountName).Context
    $cutoffDate = (Get-Date).AddDays(-$RetentionDays)

    # Get blobs older than retention period
    $oldBlobs = Get-AzStorageBlob -Container $Container -Context $context |
        Where-Object { $_.LastModified.DateTime -lt $cutoffDate }

    $deletedSize = 0
    foreach ($blob in $oldBlobs) {
        $deletedSize += $blob.Length
        Remove-AzStorageBlob -Blob $blob.Name -Container $Container -Context $context -Force
    }

    $savedCost = ($deletedSize / 1GB) * 0.0184  # Hot tier cost per GB
    Write-Output "Deleted $($oldBlobs.Count) blobs, saved $([math]::Round($savedCost, 2)) USD/month"
}

# Execute retention policies
Remove-OldCaptures -Container "eventhub-capture/debug" -RetentionDays 30
Remove-OldCaptures -Container "eventhub-capture/operational" -RetentionDays 90
```

## Format Selection

### 1. Avro vs Parquet

**Format Comparison:**

| Characteristic | Avro | Parquet | Recommendation |
|----------------|------|---------|----------------|
| **Compression Ratio** | 60-70% | 85-90% | Parquet for storage |
| **Write Performance** | Excellent | Good | Avro for streaming |
| **Read Performance** | Good | Excellent | Parquet for analytics |
| **Schema Evolution** | Excellent | Good | Avro for flexibility |
| **Event Hub Native** | Yes | No | Avro for capture |

**Post-Capture Conversion:**

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder.appName("CaptureConversion").getOrCreate()

# Read Avro captures
avro_df = spark.read \
    .format("avro") \
    .load("abfss://eventhub-capture@stcapture.dfs.core.windows.net/*/2024/12/*/*.avro")

# Convert to Parquet for long-term storage
avro_df.write \
    .format("parquet") \
    .mode("overwrite") \
    .option("compression", "snappy") \
    .partitionBy("year", "month", "day") \
    .save("abfss://analytics@stcapture.dfs.core.windows.net/captured-events/")

# Cost savings: 20-30% additional compression
```

## Monitoring and Optimization

### 1. Cost Monitoring

**Azure Monitor Query:**

```kusto
// Event Hub capture costs
AzureMetrics
| where ResourceProvider == "MICROSOFT.EVENTHUB"
| where MetricName == "CaptureBacklog" or MetricName == "CapturedBytes"
| summarize
    TotalCapturedGB = sum(Total) / (1024*1024*1024),
    AvgBacklog = avg(Average)
by bin(TimeGenerated, 1d), Resource
| extend
    CaptureCost = TotalCapturedGB * 0.10,
    StorageCost = TotalCapturedGB * 0.0184
| project TimeGenerated, Resource, TotalCapturedGB, CaptureCost, StorageCost
| render columnchart
```

### 2. Capture Efficiency Analysis

**Python Cost Analysis:**

```python
from azure.monitor.query import LogsQueryClient, MetricsQueryClient
from azure.identity import DefaultAzureCredential
from datetime import timedelta

def analyze_capture_efficiency(resource_id):
    """Analyze Event Hub capture efficiency and costs"""

    credential = DefaultAzureCredential()
    metrics_client = MetricsQueryClient(credential)

    # Query metrics for last 30 days
    metrics_data = metrics_client.query_resource(
        resource_id,
        metric_names=["CapturedBytes", "IncomingBytes"],
        timespan=timedelta(days=30)
    )

    captured_bytes = sum([m.value for m in metrics_data.metrics[0].timeseries[0].data])
    incoming_bytes = sum([m.value for m in metrics_data.metrics[1].timeseries[0].data])

    capture_ratio = captured_bytes / incoming_bytes * 100
    monthly_capture_cost = (captured_bytes / (1024**3)) * 0.10
    monthly_storage_cost = (captured_bytes / (1024**3)) * 0.0184

    print(f"Capture Efficiency Analysis:")
    print(f"  Incoming Data: {incoming_bytes / (1024**3):.2f} GB")
    print(f"  Captured Data: {captured_bytes / (1024**3):.2f} GB")
    print(f"  Capture Ratio: {capture_ratio:.2f}%")
    print(f"  Monthly Capture Cost: ${monthly_capture_cost:.2f}")
    print(f"  Monthly Storage Cost: ${monthly_storage_cost:.2f}")
    print(f"  Total Monthly Cost: ${monthly_capture_cost + monthly_storage_cost:.2f}")

    return {
        "capture_ratio": capture_ratio,
        "monthly_cost": monthly_capture_cost + monthly_storage_cost
    }

# Run analysis
resource_id = "/subscriptions/{sub}/resourceGroups/rg-streaming/providers/Microsoft.EventHub/namespaces/eh-namespace"
result = analyze_capture_efficiency(resource_id)
```

## Implementation Checklist

### Immediate Actions (Week 1)

- [ ] Review current capture configuration
- [ ] Optimize capture window (time and size limits)
- [ ] Enable skip empty archives
- [ ] Implement basic lifecycle policy
- [ ] Review and clean up old captures

### Short-Term (Month 1)

- [ ] Implement tier-based lifecycle policies
- [ ] Configure conditional capture (if applicable)
- [ ] Set up cost monitoring dashboards
- [ ] Analyze compression effectiveness
- [ ] Document retention requirements

### Mid-Term (Quarter 1)

- [ ] Implement post-capture conversion to Parquet
- [ ] Optimize partition count for capture
- [ ] Review and adjust throughput units
- [ ] Automate retention policy enforcement
- [ ] Conduct quarterly cost review

### Long-Term (Year 1)

- [ ] Implement intelligent capture routing
- [ ] Optimize for specific event types
- [ ] Archive historical data to cold storage
- [ ] Review and optimize entire streaming architecture
- [ ] Document lessons learned and best practices

## Cost Optimization ROI

### Expected Savings by Optimization

| Optimization | Implementation Effort | Time to Value | Annual Savings Potential |
|--------------|----------------------|---------------|-------------------------|
| Capture Window Optimization | Low | Immediate | 10-20% |
| Lifecycle Policies | Medium | 30 days | 50-70% on storage |
| Conditional Capture | Medium | 1 week | 40-60% on capture fees |
| Compression | Low | Immediate | 60-70% on storage |
| Retention Policy | Low | Immediate | 20-40% |

## Related Resources

- [Event Hubs Cost Optimization](./eventhub-cost.md)
- [Storage Optimization](./storage-optimization.md)
- [Streaming Performance](../performance/streaming-optimization.md)
- [Event Hubs Best Practices](https://learn.microsoft.com/azure/event-hubs/event-hubs-capture-overview)

---

> **💰 Capture Cost Optimization is Continuous**
> Regularly review capture patterns, monitor storage growth, and adjust policies as data volumes and retention requirements change. Quarterly reviews help identify new optimization opportunities.
