# Azure Storage Geo-Replication Reference

[Home](../../../README.md) > [Reference](../README.md) > [Storage](README.md) > Geo-Replication

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Documentation](https://img.shields.io/badge/Documentation-Complete-blue)

> Comprehensive reference guide for Azure Storage geo-replication, including replication options, failover strategies, disaster recovery, and best practices for cloud-scale analytics data protection.

---

## Table of Contents

- [Overview](#overview)
- [Replication Types](#replication-types)
- [Geo-Redundant Storage (GRS)](#geo-redundant-storage-grs)
- [Read-Access Geo-Redundant Storage (RA-GRS)](#read-access-geo-redundant-storage-ra-grs)
- [Geo-Zone-Redundant Storage (GZRS)](#geo-zone-redundant-storage-gzrs)
- [Failover and Recovery](#failover-and-recovery)
- [Data Consistency](#data-consistency)
- [Monitoring and Metrics](#monitoring-and-metrics)
- [Cost Considerations](#cost-considerations)
- [Migration Between Replication Types](#migration-between-replication-types)

---

## Overview

### What is Geo-Replication?

Azure Storage geo-replication automatically replicates your data to a secondary region that is hundreds of miles away from the primary region, protecting against regional disasters.

### Replication Architecture

```text
┌────────────────────────────────────────────────────────────┐
│         Azure Storage Replication Architecture             │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Primary Region (East US)       Secondary Region (West US) │
│  ┌─────────────────────┐        ┌─────────────────────┐   │
│  │                     │        │                     │   │
│  │  Zone 1  Zone 2     │        │  Zone 1  Zone 2     │   │
│  │  ┌────┐  ┌────┐     │  Async │  ┌────┐  ┌────┐     │   │
│  │  │Data│  │Data│     │ ─────> │  │Data│  │Data│     │   │
│  │  └────┘  └────┘     │  Sync  │  └────┘  └────┘     │   │
│  │    LRS/ZRS          │        │    LRS/ZRS          │   │
│  └─────────────────────┘        └─────────────────────┘   │
│                                                             │
│  Replication Types:                                        │
│  - GRS:   Primary (LRS) → Secondary (LRS)                 │
│  - RA-GRS: Primary (LRS) → Secondary (LRS) + Read Access  │
│  - GZRS:  Primary (ZRS) → Secondary (LRS)                 │
│  - RA-GZRS: Primary (ZRS) → Secondary (LRS) + Read Access │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

---

## Replication Types

### Comparison Matrix

| Feature | LRS | ZRS | GRS | RA-GRS | GZRS | RA-GZRS |
|---------|-----|-----|-----|--------|------|---------|
| **Copies of data** | 3 | 3 | 6 | 6 | 6 | 6 |
| **Regions** | 1 | 1 | 2 | 2 | 2 | 2 |
| **Availability zones** | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| **Read from secondary** | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| **Durability (9's)** | 11 | 12 | 16 | 16 | 16 | 16 |
| **Relative cost** | $ | $$ | $$$ | $$$ | $$$$ | $$$$ |
| **Use case** | Dev/Test | Production | DR | DR + Read | Production DR | Production DR + Read |

### Durability and Availability

| Replication Type | Annual Durability | Availability (Read) | Availability (Write) |
|------------------|-------------------|---------------------|---------------------|
| **LRS** | 99.999999999% (11 9's) | 99.9% | 99.9% |
| **ZRS** | 99.9999999999% (12 9's) | 99.9% | 99.9% |
| **GRS** | 99.99999999999999% (16 9's) | 99.9% | 99.9% |
| **RA-GRS** | 99.99999999999999% (16 9's) | 99.99% | 99.9% |
| **GZRS** | 99.99999999999999% (16 9's) | 99.9% | 99.9% |
| **RA-GZRS** | 99.99999999999999% (16 9's) | 99.99% | 99.9% |

### Region Pairs

| Primary Region | Secondary Region | Distance |
|----------------|------------------|----------|
| East US | West US | ~2,400 miles |
| East US 2 | Central US | ~800 miles |
| West US 2 | West Central US | ~1,000 miles |
| North Europe | West Europe | ~1,000 miles |
| Southeast Asia | East Asia | ~1,600 miles |
| Japan East | Japan West | ~250 miles |
| Australia East | Australia Southeast | ~500 miles |
| UK South | UK West | ~200 miles |
| Canada Central | Canada East | ~500 miles |
| Brazil South | South Central US | ~5,000 miles |

---

## Geo-Redundant Storage (GRS)

### Configuration

#### Azure CLI

```bash
# Create storage account with GRS
az storage account create \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --location eastus \
  --sku Standard_GRS \
  --kind StorageV2 \
  --https-only true \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false

# Verify replication status
az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query '{name:name,sku:sku.name,primaryLocation:primaryLocation,secondaryLocation:secondaryLocation,statusOfPrimary:statusOfPrimary,statusOfSecondary:statusOfSecondary}'

# Check last sync time
az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query 'geoReplicationStats.lastSyncTime'
```

#### Azure PowerShell

```powershell
# Create storage account with GRS
New-AzStorageAccount `
  -ResourceGroupName "rg-analytics-prod" `
  -Name "stadatalake001" `
  -Location "eastus" `
  -SkuName "Standard_GRS" `
  -Kind "StorageV2" `
  -EnableHttpsTrafficOnly $true `
  -MinimumTlsVersion "TLS1_2"

# Get replication statistics
$account = Get-AzStorageAccount `
  -ResourceGroupName "rg-analytics-prod" `
  -Name "stadatalake001"

$account.GeoReplicationStats | Format-List

# Output:
# Status          : Live
# LastSyncTime    : 12/10/2024 10:30:00 AM
# CanFailover     : True
```

#### Bicep Template

```bicep
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'stadatalake001'
  location: location
  sku: {
    name: 'Standard_GRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
    encryption: {
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
        file: {
          enabled: true
          keyType: 'Account'
        }
      }
      keySource: 'Microsoft.Storage'
    }
  }
}

output primaryEndpoint string = storageAccount.properties.primaryEndpoints.blob
output secondaryEndpoint string = storageAccount.properties.secondaryEndpoints.blob
```

### Replication Behavior

| Operation | Primary Region | Secondary Region |
|-----------|---------------|------------------|
| **Write** | Synchronous (3 copies) | Asynchronous replication |
| **Read** | Always from primary | Not available (use RA-GRS) |
| **Failover** | Becomes secondary | Becomes primary |
| **Consistency** | Strong | Eventually consistent |

---

## Read-Access Geo-Redundant Storage (RA-GRS)

### Configuration

```bash
# Create storage account with RA-GRS
az storage account create \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --location eastus \
  --sku Standard_RAGRS \
  --kind StorageV2

# Get secondary endpoint
SECONDARY_ENDPOINT=$(az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query secondaryEndpoints.blob -o tsv)

echo "Secondary endpoint: $SECONDARY_ENDPOINT"
# Output: https://stadatalake001-secondary.blob.core.windows.net/
```

### Accessing Secondary Region

#### Azure CLI

```bash
# Read from secondary endpoint
az storage blob download \
  --account-name stadatalake001 \
  --container-name data \
  --name file.txt \
  --file downloaded-file.txt \
  --blob-endpoint "https://stadatalake001-secondary.blob.core.windows.net/"

# List blobs from secondary
az storage blob list \
  --account-name stadatalake001 \
  --container-name data \
  --blob-endpoint "https://stadatalake001-secondary.blob.core.windows.net/" \
  --output table
```

#### .NET SDK

```csharp
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

// Configure client for RA-GRS
var options = new BlobClientOptions
{
    GeoRedundantSecondaryUri = new Uri("https://stadatalake001-secondary.blob.core.windows.net/"),
    Retry = {
        Mode = Azure.Core.RetryMode.Exponential,
        MaxRetries = 5,
        Delay = TimeSpan.FromSeconds(2)
    }
};

var blobServiceClient = new BlobServiceClient(
    new Uri("https://stadatalake001.blob.core.windows.net/"),
    new DefaultAzureCredential(),
    options
);

// Read from primary
var containerClient = blobServiceClient.GetBlobContainerClient("data");
var blobClient = containerClient.GetBlobClient("file.txt");
var content = await blobClient.DownloadContentAsync();

// Read from secondary (automatic on retry)
try
{
    var contentFromPrimary = await blobClient.DownloadContentAsync();
}
catch (RequestFailedException)
{
    // SDK automatically retries from secondary if configured
    Console.WriteLine("Primary failed, reading from secondary");
}
```

#### Python SDK

```python
from azure.storage.blob import BlobServiceClient
from azure.identity import DefaultAzureCredential

# Create client with RA-GRS support
credential = DefaultAzureCredential()
blob_service_client = BlobServiceClient(
    account_url="https://stadatalake001.blob.core.windows.net/",
    credential=credential
)

# Access primary endpoint
container_client = blob_service_client.get_container_client("data")
blob_client = container_client.get_blob_client("file.txt")

# Download from primary
with open("file.txt", "wb") as file:
    blob_data = blob_client.download_blob()
    file.write(blob_data.readall())

# Access secondary endpoint
secondary_client = BlobServiceClient(
    account_url="https://stadatalake001-secondary.blob.core.windows.net/",
    credential=credential
)

secondary_container = secondary_client.get_container_client("data")
secondary_blob = secondary_container.get_blob_client("file.txt")

# Download from secondary
with open("file-from-secondary.txt", "wb") as file:
    blob_data = secondary_blob.download_blob()
    file.write(blob_data.readall())
```

### Circuit Breaker Pattern

```csharp
public class GeoRedundantStorageClient
{
    private readonly BlobServiceClient primaryClient;
    private readonly BlobServiceClient secondaryClient;
    private bool usePrimary = true;
    private DateTime lastFailureTime = DateTime.MinValue;
    private readonly TimeSpan failoverDuration = TimeSpan.FromMinutes(5);

    public GeoRedundantStorageClient(string accountName, TokenCredential credential)
    {
        primaryClient = new BlobServiceClient(
            new Uri($"https://{accountName}.blob.core.windows.net/"),
            credential
        );

        secondaryClient = new BlobServiceClient(
            new Uri($"https://{accountName}-secondary.blob.core.windows.net/"),
            credential
        );
    }

    public async Task<BlobDownloadInfo> DownloadBlobAsync(string containerName, string blobName)
    {
        // Check if we should try primary again
        if (!usePrimary && DateTime.UtcNow - lastFailureTime > failoverDuration)
        {
            usePrimary = true;
        }

        var client = usePrimary ? primaryClient : secondaryClient;

        try
        {
            var containerClient = client.GetBlobContainerClient(containerName);
            var blobClient = containerClient.GetBlobClient(blobName);
            return await blobClient.DownloadAsync();
        }
        catch (RequestFailedException ex) when (usePrimary && IsRetryable(ex))
        {
            // Primary failed, switch to secondary
            usePrimary = false;
            lastFailureTime = DateTime.UtcNow;

            var secondaryContainerClient = secondaryClient.GetBlobContainerClient(containerName);
            var secondaryBlobClient = secondaryContainerClient.GetBlobClient(blobName);
            return await secondaryBlobClient.DownloadAsync();
        }
    }

    private bool IsRetryable(RequestFailedException ex)
    {
        return ex.Status >= 500 || ex.Status == 408 || ex.Status == 429;
    }
}
```

---

## Geo-Zone-Redundant Storage (GZRS)

### Configuration

```bash
# Create storage account with GZRS
az storage account create \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --location eastus \
  --sku Standard_GZRS \
  --kind StorageV2

# Verify zone redundancy
az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query '{sku:sku.name,primaryLocation:primaryLocation,secondaryLocation:secondaryLocation}'
```

### GZRS Benefits

| Feature | GRS | GZRS |
|---------|-----|------|
| **Zone failure protection** | ❌ No | ✅ Yes |
| **Region failure protection** | ✅ Yes | ✅ Yes |
| **Durability** | 16 9's | 16 9's |
| **Availability (single zone down)** | ❌ Degraded | ✅ Full |
| **Cost** | Lower | Higher |
| **Best for** | Cost-sensitive DR | Mission-critical workloads |

### When to Use GZRS

- Mission-critical production workloads
- High availability requirements (99.99%+)
- Protection against both zone and region failures
- Compliance requirements for data durability
- Low tolerance for data loss

---

## Failover and Recovery

### Types of Failover

| Failover Type | Initiated By | Downtime | Data Loss Risk | Cost |
|---------------|-------------|----------|----------------|------|
| **Customer-managed** | Customer | Minutes | Minimal (RPO ~15min) | No additional |
| **Microsoft-managed** | Microsoft | Hours | Minimal | No additional |
| **Planned failover** | Customer | Minimal | None | No additional |

### Customer-Managed Failover

#### Prerequisites

- Storage account with GRS or RA-GRS
- No failover in progress
- Primary region unavailable or degraded

#### Azure CLI - Initiate Failover

```bash
# Check if failover is possible
az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query '{canFailover:geoReplicationStats.canFailover,status:statusOfPrimary}'

# Initiate account failover
az storage account failover \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --yes

# Monitor failover status
az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query '{primaryLocation:primaryLocation,secondaryLocation:secondaryLocation,statusOfPrimary:statusOfPrimary}'
```

#### PowerShell - Initiate Failover

```powershell
# Check failover eligibility
$account = Get-AzStorageAccount `
  -ResourceGroupName "rg-analytics-prod" `
  -Name "stadatalake001"

if ($account.GeoReplicationStats.CanFailover) {
    Write-Host "Account is eligible for failover"

    # Initiate failover
    Invoke-AzStorageAccountFailover `
      -ResourceGroupName "rg-analytics-prod" `
      -Name "stadatalake001" `
      -Force

    Write-Host "Failover initiated"
} else {
    Write-Host "Account is not eligible for failover"
}
```

### Failover Process

```text
┌────────────────────────────────────────────────────────┐
│            Account Failover Process                    │
├────────────────────────────────────────────────────────┤
│                                                         │
│  Before Failover:                                      │
│  ┌──────────────┐            ┌──────────────┐         │
│  │ East US      │   Async    │ West US      │         │
│  │ (Primary)    │  ──────>   │ (Secondary)  │         │
│  │ Read/Write   │            │ Read (RA-GRS)│         │
│  └──────────────┘            └──────────────┘         │
│                                                         │
│  During Failover (10-60 minutes):                     │
│  ┌──────────────┐            ┌──────────────┐         │
│  │ East US      │            │ West US      │         │
│  │ (Offline)    │            │ (Promoting)  │         │
│  │              │            │              │         │
│  └──────────────┘            └──────────────┘         │
│                                                         │
│  After Failover:                                       │
│  ┌──────────────┐            ┌──────────────┐         │
│  │ East US      │            │ West US      │         │
│  │ (No longer   │            │ (New Primary)│         │
│  │  paired)     │            │ Read/Write   │         │
│  └──────────────┘            └──────────────┘         │
│                    LRS Only                            │
│                                                         │
│  Note: After failover, account becomes LRS.           │
│        Re-enable GRS to establish new pairing.        │
│                                                         │
└────────────────────────────────────────────────────────┘
```

### Post-Failover Actions

```bash
# After failover completes, re-enable geo-replication
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --sku Standard_GRS

# Verify new configuration
az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query '{sku:sku.name,primaryLocation:primaryLocation,secondaryLocation:secondaryLocation}'

# Update application endpoints if needed
# Primary endpoint remains the same, but physical location changed
```

### Failover Testing

```python
from azure.mgmt.storage import StorageManagementClient
from azure.identity import DefaultAzureCredential
import time

class FailoverTester:
    """Test storage account failover procedures."""

    def __init__(self, subscription_id: str):
        self.credential = DefaultAzureCredential()
        self.storage_client = StorageManagementClient(
            self.credential, subscription_id
        )

    def test_failover(self, resource_group: str, account_name: str, dry_run: bool = True):
        """
        Test failover procedure.

        Args:
            resource_group: Resource group name
            account_name: Storage account name
            dry_run: If True, only validate without performing failover
        """
        print(f"Testing failover for account: {account_name}")

        # Check current status
        account = self.storage_client.storage_accounts.get_properties(
            resource_group, account_name
        )

        print(f"Current primary location: {account.primary_location}")
        print(f"Current secondary location: {account.secondary_location}")
        print(f"Can failover: {account.geo_replication_stats.can_failover if account.geo_replication_stats else 'N/A'}")

        if dry_run:
            print("Dry run mode - no failover performed")
            return

        if not account.geo_replication_stats or not account.geo_replication_stats.can_failover:
            print("Account is not eligible for failover")
            return

        # Initiate failover
        print("Initiating failover...")
        operation = self.storage_client.storage_accounts.begin_failover(
            resource_group, account_name
        )

        # Wait for completion
        result = operation.result()
        print("Failover completed")

        # Verify new configuration
        time.sleep(30)  # Wait for metadata to update
        updated_account = self.storage_client.storage_accounts.get_properties(
            resource_group, account_name
        )

        print(f"New primary location: {updated_account.primary_location}")
        print(f"New SKU: {updated_account.sku.name}")

        # Re-enable geo-replication
        print("Re-enabling geo-replication...")
        self.storage_client.storage_accounts.update(
            resource_group,
            account_name,
            {
                "sku": {"name": "Standard_GRS"}
            }
        )

        print("Failover test completed successfully")

# Usage
tester = FailoverTester(subscription_id="your-sub-id")
tester.test_failover(
    resource_group="rg-analytics-prod",
    account_name="stadatalake001",
    dry_run=True  # Set to False for actual failover
)
```

---

## Data Consistency

### Last Sync Time (LST)

```bash
# Check last successful sync
az storage account show \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --query 'geoReplicationStats.{status:status,lastSyncTime:lastSyncTime,canFailover:canFailover}' \
  --output table

# Sample output:
# Status    LastSyncTime                  CanFailover
# --------  ---------------------------  ------------
# Live      2024-12-10T14:30:00.000000Z  True
```

### Understanding RPO

| Replication Type | Typical RPO | Maximum RPO |
|------------------|-------------|-------------|
| **GRS/RA-GRS** | <15 minutes | ~1 hour |
| **GZRS/RA-GZRS** | <15 minutes | ~1 hour |

### Monitoring LST

```kql
// Azure Monitor query for LST
AzureMetrics
| where ResourceProvider == "MICROSOFT.STORAGE"
| where MetricName == "GeoReplicationDataSyncTime"
| where TimeGenerated > ago(24h)
| summarize AvgSyncTime = avg(Average), MaxSyncTime = max(Maximum) by bin(TimeGenerated, 1h)
| render timechart

// Alert on high sync lag
AzureMetrics
| where ResourceProvider == "MICROSOFT.STORAGE"
| where MetricName == "GeoReplicationDataSyncTime"
| where Average > 900000  // 15 minutes in milliseconds
| project TimeGenerated, Resource, Average
```

---

## Monitoring and Metrics

### Key Metrics

```bash
# Monitor availability
az monitor metrics list \
  --resource "/subscriptions/{sub-id}/resourceGroups/rg-analytics-prod/providers/Microsoft.Storage/storageAccounts/stadatalake001" \
  --metric "Availability" \
  --start-time 2024-12-09T00:00:00Z \
  --end-time 2024-12-10T00:00:00Z \
  --interval PT1H \
  --aggregation Average

# Monitor geo-replication health
az monitor metrics list \
  --resource "/subscriptions/{sub-id}/resourceGroups/rg-analytics-prod/providers/Microsoft.Storage/storageAccounts/stadatalake001" \
  --metric "GeoReplicationDataLag" \
  --aggregation Maximum
```

### Diagnostic Logging

```bash
# Enable storage analytics logging
az monitor diagnostic-settings create \
  --name storage-diagnostics \
  --resource "/subscriptions/{sub-id}/resourceGroups/rg-analytics-prod/providers/Microsoft.Storage/storageAccounts/stadatalake001" \
  --logs '[
    {"category":"StorageRead","enabled":true},
    {"category":"StorageWrite","enabled":true},
    {"category":"StorageDelete","enabled":true}
  ]' \
  --metrics '[{"category":"Transaction","enabled":true}]' \
  --workspace "/subscriptions/{sub-id}/resourceGroups/rg-analytics-prod/providers/Microsoft.OperationalInsights/workspaces/law-analytics-prod"
```

---

## Cost Considerations

### Pricing Comparison

| Replication Type | Relative Cost | Storage Cost Multiplier | Egress Cost |
|------------------|---------------|------------------------|-------------|
| **LRS** | 1x (baseline) | 1.0x | Standard |
| **ZRS** | 1.25x | 1.25x | Standard |
| **GRS** | 2x | 2.0x | Higher (cross-region) |
| **RA-GRS** | 2x | 2.0x | Higher (cross-region + secondary reads) |
| **GZRS** | 2.5x | 2.5x | Higher (cross-region) |
| **RA-GZRS** | 2.5x | 2.5x | Higher (cross-region + secondary reads) |

### Cost Optimization

```yaml
# cost-optimization-strategy.yaml
replication_strategy:
  production_critical:
    type: "RA-GZRS"
    justification: "Mission-critical data requiring highest availability"

  production_standard:
    type: "GRS"
    justification: "Standard production workloads"

  development:
    type: "LRS"
    justification: "Non-production, can be recreated"

  archival:
    type: "GRS"
    tier: "Cool"
    justification: "Long-term retention with DR"

  backup:
    type: "LRS"
    tier: "Archive"
    justification: "Point-in-time backups, local redundancy sufficient"
```

---

## Migration Between Replication Types

### Upgrade Path

```bash
# LRS to ZRS (supported in most regions)
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --sku Standard_ZRS

# LRS to GRS
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --sku Standard_GRS

# GRS to RA-GRS
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --sku Standard_RAGRS

# GRS to GZRS (requires conversion)
# Step 1: Convert to ZRS first
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --sku Standard_ZRS

# Step 2: Convert to GZRS
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --sku Standard_GZRS
```

### Downgrade Considerations

```bash
# Note: Downgrading from geo-redundant to local may lose secondary copy
# Ensure data is backed up before downgrade

# GRS to LRS
az storage account update \
  --name stadatalake001 \
  --resource-group rg-analytics-prod \
  --sku Standard_LRS
```

---

## Best Practices

### Replication Checklist

- [ ] Select appropriate replication type based on RTO/RPO requirements
- [ ] Use GRS or higher for production workloads
- [ ] Enable RA-GRS for read scalability and availability
- [ ] Use GZRS for mission-critical workloads requiring zone redundancy
- [ ] Monitor last sync time regularly
- [ ] Test failover procedures annually
- [ ] Document failover runbooks
- [ ] Configure alerts for replication lag
- [ ] Understand failover impact on applications
- [ ] Plan for post-failover re-enablement of geo-replication

### Common Mistakes to Avoid

| Mistake | Impact | Solution |
|---------|--------|----------|
| Using LRS for production | Data loss risk | Use GRS or higher |
| Not testing failover | Unprepared for disasters | Test annually |
| Ignoring LST monitoring | Undetected replication issues | Set up alerts |
| No failover documentation | Slow recovery | Document procedures |
| Assuming zero data loss | Wrong expectations | Understand RPO (~15min) |

---

## Related Resources

- [Azure Storage Redundancy](https://docs.microsoft.com/azure/storage/common/storage-redundancy)
- [Disaster Recovery and Failover](https://docs.microsoft.com/azure/storage/common/storage-disaster-recovery-guidance)
- [Azure Storage SLA](https://azure.microsoft.com/support/legal/sla/storage/)
- [Storage Account Failover](https://docs.microsoft.com/azure/storage/common/storage-initiate-account-failover)
- [Azure Regions Reference](../azure-regions.md)
- [Custom Domains Configuration](custom-domains.md)

---

> **Note**: Geo-replication features and availability vary by region. Always verify current capabilities and test failover procedures in non-production environments before relying on them for disaster recovery.
