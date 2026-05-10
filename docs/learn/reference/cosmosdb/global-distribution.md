# Azure Cosmos DB Global Distribution Reference

[Home](../../../README.md) > [Reference](../README.md) > [Cosmos DB](README.md) > Global Distribution

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Documentation](https://img.shields.io/badge/Documentation-Complete-blue)

> Comprehensive reference guide for Azure Cosmos DB global distribution, multi-region writes, consistency models, and disaster recovery strategies for cloud-scale analytics workloads.

---

## Table of Contents

- [Overview](#overview)
- [Global Distribution Capabilities](#global-distribution-capabilities)
- [Consistency Levels](#consistency-levels)
- [Multi-Region Configuration](#multi-region-configuration)
- [Conflict Resolution](#conflict-resolution)
- [Replication Patterns](#replication-patterns)
- [Failover and Disaster Recovery](#failover-and-disaster-recovery)
- [Performance Optimization](#performance-optimization)
- [Cost Considerations](#cost-considerations)
- [Monitoring and Diagnostics](#monitoring-and-diagnostics)

---

## Overview

Azure Cosmos DB provides turnkey global distribution across any number of Azure regions by transparently scaling and replicating your data wherever your users are.

### Key Features

| Feature | Description | Availability |
|---------|-------------|--------------|
| **Multi-region writes** | Write to multiple regions simultaneously | All tiers |
| **Automatic failover** | Automatic region failover with zero downtime | All tiers |
| **Five consistency levels** | Tunable consistency from strong to eventual | All tiers |
| **Single-digit millisecond latency** | P99 latency at 99.999% availability | SLA-backed |
| **Conflict resolution** | Automatic and custom conflict resolution | Multi-write enabled |
| **Geo-redundancy** | Automatic data replication across regions | All tiers |

### Distribution Patterns

```text
┌─────────────────────────────────────────────────────────────┐
│              Global Distribution Patterns                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Pattern 1: Single-Region Write, Multi-Region Read          │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐          │
│  │ Region 1 │      │ Region 2 │      │ Region 3 │          │
│  │  (Write) │─────>│  (Read)  │─────>│  (Read)  │          │
│  └──────────┘      └──────────┘      └──────────┘          │
│                                                              │
│  Pattern 2: Multi-Region Write                              │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐          │
│  │ Region 1 │<────>│ Region 2 │<────>│ Region 3 │          │
│  │ (R/W)    │      │ (R/W)    │      │ (R/W)    │          │
│  └──────────┘      └──────────┘      └──────────┘          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Global Distribution Capabilities

### Available Azure Regions

Azure Cosmos DB is available in 60+ Azure regions worldwide.

| Geography | Regions | Availability Zones |
|-----------|---------|-------------------|
| **Americas** | East US, East US 2, West US, West US 2, West US 3, Central US, North Central US, South Central US, Canada Central, Canada East, Brazil South, Brazil Southeast | Yes (select regions) |
| **Europe** | North Europe, West Europe, UK South, UK West, France Central, Germany West Central, Switzerland North, Norway East, Sweden Central, Poland Central | Yes (select regions) |
| **Asia Pacific** | Southeast Asia, East Asia, Australia East, Australia Southeast, Japan East, Japan West, Korea Central, Central India, South India | Yes (select regions) |
| **Middle East & Africa** | UAE North, South Africa North, Qatar Central, Israel Central | Yes (select regions) |

### Replication Latency

| Source Region | Target Region | Typical Latency | Max Latency (P99) |
|---------------|---------------|-----------------|-------------------|
| East US | West US | 50-70 ms | < 100 ms |
| East US | West Europe | 80-100 ms | < 150 ms |
| West Europe | Southeast Asia | 140-180 ms | < 250 ms |
| East US | Southeast Asia | 180-220 ms | < 300 ms |
| Within same geography | Same geography | 10-50 ms | < 100 ms |

---

## Consistency Levels

### Consistency Level Overview

Azure Cosmos DB offers five well-defined consistency levels with clear tradeoffs between consistency, availability, latency, and throughput.

| Consistency Level | Read Guarantee | Latency | Throughput | Use Case |
|------------------|----------------|---------|------------|----------|
| **Strong** | Linearizability | Highest | Lowest | Financial transactions, inventory |
| **Bounded Staleness** | Consistent prefix with lag bounds | High | Low | Coordinated scenarios, gaming leaderboards |
| **Session** | Read your writes, monotonic reads | Medium | Medium | Shopping carts, user sessions (default) |
| **Consistent Prefix** | Reads never see out-of-order writes | Low | High | Social media feeds, updates |
| **Eventual** | Out-of-order reads possible | Lowest | Highest | Non-ordered data, telemetry |

### Consistency Level Configuration

#### Azure CLI

```bash
# Set consistency level at account creation
az cosmosdb create \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics \
  --locations regionName=eastus failoverPriority=0 isZoneRedundant=true \
  --locations regionName=westus failoverPriority=1 isZoneRedundant=true \
  --default-consistency-level Session \
  --enable-multiple-write-locations true

# Update consistency level
az cosmosdb update \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics \
  --default-consistency-level BoundedStaleness \
  --max-staleness-prefix 100000 \
  --max-interval 300
```

#### Azure PowerShell

```powershell
# Create Cosmos DB account with bounded staleness
New-AzCosmosDBAccount `
  -ResourceGroupName "rg-analytics" `
  -Name "cosmos-analytics-prod" `
  -Location "East US" `
  -DefaultConsistencyLevel "BoundedStaleness" `
  -MaxStalenessIntervalInSeconds 300 `
  -MaxStalenessPrefix 100000 `
  -EnableMultipleWriteLocations $true

# Update consistency level
Update-AzCosmosDBAccount `
  -ResourceGroupName "rg-analytics" `
  -Name "cosmos-analytics-prod" `
  -DefaultConsistencyLevel "Session"
```

#### .NET SDK

```csharp
using Microsoft.Azure.Cosmos;

// Create client with specific consistency level
CosmosClient client = new CosmosClient(
    accountEndpoint: "https://cosmos-analytics-prod.documents.azure.com:443/",
    authKeyOrResourceToken: cosmosKey,
    clientOptions: new CosmosClientOptions()
    {
        ConsistencyLevel = ConsistencyLevel.Session,
        ApplicationRegion = Regions.EastUS,
        ConnectionMode = ConnectionMode.Direct
    }
);

// Override consistency per request
RequestOptions requestOptions = new RequestOptions
{
    ConsistencyLevel = ConsistencyLevel.Strong
};

var response = await container.ReadItemAsync<Product>(
    id: "product-123",
    partitionKey: new PartitionKey("electronics"),
    requestOptions: requestOptions
);
```

#### Python SDK

```python
from azure.cosmos import CosmosClient, PartitionKey, exceptions
from azure.cosmos.consistency_level import ConsistencyLevel

# Create client with session consistency
client = CosmosClient(
    url="https://cosmos-analytics-prod.documents.azure.com:443/",
    credential=cosmos_key,
    consistency_level=ConsistencyLevel.Session,
    preferred_locations=["East US", "West US"]
)

# Override consistency for specific operation
database = client.get_database_client("analytics-db")
container = database.get_container_client("events")

# Read with strong consistency
item = container.read_item(
    item="event-456",
    partition_key="sensor-data",
    consistency_level=ConsistencyLevel.Strong
)
```

### Bounded Staleness Configuration

```yaml
# bounded-staleness-config.yaml
consistency:
  level: "BoundedStaleness"

  # Time-based staleness (for geo-distributed accounts)
  max_staleness_interval_seconds: 300  # 5 minutes

  # Operation-based staleness (for single region)
  max_staleness_prefix: 100000  # 100k operations

  # Recommendations by scenario
  scenarios:
    - name: "Gaming Leaderboards"
      max_interval: 60
      max_prefix: 10000

    - name: "Inventory Management"
      max_interval: 300
      max_prefix: 100000

    - name: "Order Processing"
      max_interval: 30
      max_prefix: 5000
```

---

## Multi-Region Configuration

### Adding Regions

#### Azure CLI

```bash
# Add read region
az cosmosdb update \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics \
  --locations regionName=eastus failoverPriority=0 isZoneRedundant=true \
  --locations regionName=westus failoverPriority=1 isZoneRedundant=true \
  --locations regionName=westeurope failoverPriority=2 isZoneRedundant=true

# Enable multi-region writes
az cosmosdb update \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics \
  --enable-multiple-write-locations true

# List regions
az cosmosdb show \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics \
  --query '{writeLocations:writeLocations[].{name:locationName,priority:failoverPriority},readLocations:readLocations[].{name:locationName,priority:failoverPriority}}'
```

#### Azure PowerShell

```powershell
# Add multiple regions with zone redundancy
$locations = @(
    @{locationName="East US"; failoverPriority=0; isZoneRedundant="true"}
    @{locationName="West US"; failoverPriority=1; isZoneRedundant="true"}
    @{locationName="West Europe"; failoverPriority=2; isZoneRedundant="true"}
    @{locationName="Southeast Asia"; failoverPriority=3; isZoneRedundant="true"}
)

Update-AzCosmosDBAccountRegion `
  -ResourceGroupName "rg-analytics" `
  -Name "cosmos-analytics-prod" `
  -LocationObject $locations

# Enable multi-region writes
Update-AzCosmosDBAccount `
  -ResourceGroupName "rg-analytics" `
  -Name "cosmos-analytics-prod" `
  -EnableMultipleWriteLocations $true
```

#### Bicep Template

```bicep
resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2023-04-15' = {
  name: 'cosmos-analytics-prod'
  location: 'eastus'
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableMultipleWriteLocations: true
    enableAutomaticFailover: true
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: 'East US'
        failoverPriority: 0
        isZoneRedundant: true
      }
      {
        locationName: 'West US'
        failoverPriority: 1
        isZoneRedundant: true
      }
      {
        locationName: 'West Europe'
        failoverPriority: 2
        isZoneRedundant: true
      }
      {
        locationName: 'Southeast Asia'
        failoverPriority: 3
        isZoneRedundant: true
      }
    ]
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: {
        tier: 'Continuous30Days'
      }
    }
  }
}
```

### Region Priority Configuration

```bash
# Set failover priorities
az cosmosdb failover-priority-change \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics \
  --failover-policies eastus=0 westus=1 westeurope=2 southeastasia=3
```

---

## Conflict Resolution

### Conflict Resolution Policies

| Policy | Behavior | Use Case |
|--------|----------|----------|
| **Last Write Wins (LWW)** | Uses timestamp to resolve conflicts | Default, general purpose |
| **Custom - Merge Procedure** | User-defined stored procedure | Complex business logic |
| **Custom - Async** | Application handles conflicts | Full control over resolution |

### Last Write Wins Configuration

#### .NET SDK

```csharp
// Configure LWW conflict resolution
ConflictResolutionPolicy lwwPolicy = new ConflictResolutionPolicy
{
    Mode = ConflictResolutionMode.LastWriterWins,
    ResolutionPath = "/_ts"  // Use system timestamp
};

ContainerProperties containerProperties = new ContainerProperties
{
    Id = "events",
    PartitionKeyPath = "/tenantId",
    ConflictResolutionPolicy = lwwPolicy
};

var container = await database.CreateContainerIfNotExistsAsync(
    containerProperties,
    throughput: 10000
);
```

#### Custom Conflict Resolution with Stored Procedure

```javascript
// Custom merge stored procedure
function customConflictResolver(incomingItem, existingItem, isTombstone, conflictingItems) {
    var mergedItem = existingItem;

    // Merge strategy: combine arrays, keep highest values
    if (incomingItem.events && existingItem.events) {
        mergedItem.events = [...new Set([...existingItem.events, ...incomingItem.events])];
    }

    if (incomingItem.updateCount > existingItem.updateCount) {
        mergedItem.updateCount = incomingItem.updateCount;
    }

    // Keep most recent timestamp
    mergedItem._ts = Math.max(incomingItem._ts, existingItem._ts);

    return mergedItem;
}
```

```csharp
// Configure custom conflict resolution
ConflictResolutionPolicy customPolicy = new ConflictResolutionPolicy
{
    Mode = ConflictResolutionMode.Custom,
    ResolutionProcedure = "dbs/analytics-db/colls/events/sprocs/customConflictResolver"
};

ContainerProperties containerProperties = new ContainerProperties
{
    Id = "events",
    PartitionKeyPath = "/tenantId",
    ConflictResolutionPolicy = customPolicy
};
```

### Monitoring Conflicts

```csharp
// Monitor conflicts feed
using (var conflictIterator = container.Conflicts.GetConflictQueryIterator<JObject>())
{
    while (conflictIterator.HasMoreResults)
    {
        var conflicts = await conflictIterator.ReadNextAsync();

        foreach (var conflict in conflicts)
        {
            Console.WriteLine($"Conflict ID: {conflict["id"]}");
            Console.WriteLine($"Operation: {conflict["operationType"]}");
            Console.WriteLine($"Resource: {conflict["resourceId"]}");

            // Handle conflict asynchronously
            await HandleConflictAsync(conflict);
        }
    }
}
```

---

## Replication Patterns

### Active-Active Pattern

```text
┌──────────────────────────────────────────────────────────┐
│            Active-Active Multi-Region Setup              │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────────┐        ┌─────────────┐                 │
│  │  East US    │◄──────►│  West US    │                 │
│  │  (Write/Read)│        │ (Write/Read)│                 │
│  └──────┬──────┘        └──────┬──────┘                 │
│         │                       │                         │
│         └───────────┬───────────┘                         │
│                     │                                     │
│                     ▼                                     │
│          ┌──────────────────┐                            │
│          │   West Europe    │                            │
│          │   (Write/Read)   │                            │
│          └──────────────────┘                            │
│                                                           │
│  Benefits:                                               │
│  - Low latency reads/writes in all regions              │
│  - High availability with automatic failover            │
│  - Load distribution across regions                     │
└──────────────────────────────────────────────────────────┘
```

### Active-Passive Pattern

```text
┌──────────────────────────────────────────────────────────┐
│           Active-Passive Multi-Region Setup              │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  ┌─────────────┐                                         │
│  │  East US    │                                         │
│  │  (Write)    │───┐                                     │
│  └─────────────┘   │                                     │
│                    │                                     │
│                    ▼                                     │
│         ┌──────────────────┐                            │
│         │    West US       │                            │
│         │  (Read-Only)     │                            │
│         └──────────────────┘                            │
│                    │                                     │
│                    ▼                                     │
│         ┌──────────────────┐                            │
│         │  West Europe     │                            │
│         │  (Read-Only)     │                            │
│         └──────────────────┘                            │
│                                                           │
│  Benefits:                                               │
│  - Simpler conflict resolution                          │
│  - Lower cost than active-active                        │
│  - Fast local reads                                     │
└──────────────────────────────────────────────────────────┘
```

---

## Failover and Disaster Recovery

### Automatic Failover Configuration

```bash
# Enable automatic failover
az cosmosdb update \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics \
  --enable-automatic-failover true

# Verify failover configuration
az cosmosdb show \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics \
  --query '{automaticFailover:enableAutomaticFailover,multipleWriteLocations:enableMultipleWriteLocations}'
```

### Manual Failover

```bash
# Initiate manual failover
az cosmosdb failover-priority-change \
  --name cosmos-analytics-prod \
  --resource-group rg-analytics \
  --failover-policies westus=0 eastus=1 westeurope=2
```

```powershell
# Manual failover using PowerShell
Update-AzCosmosDBAccountFailoverPriority `
  -ResourceGroupName "rg-analytics" `
  -Name "cosmos-analytics-prod" `
  -FailoverPolicy @(
    @{locationName="West US"; failoverPriority=0}
    @{locationName="East US"; failoverPriority=1}
    @{locationName="West Europe"; failoverPriority=2}
  )
```

### Disaster Recovery Architecture

```yaml
# disaster-recovery-config.yaml
disaster_recovery:
  strategy: "active-passive"

  primary_region:
    name: "eastus"
    priority: 0
    zone_redundant: true

  secondary_regions:
    - name: "westus"
      priority: 1
      zone_redundant: true
      role: "hot-standby"

    - name: "westeurope"
      priority: 2
      zone_redundant: true
      role: "cold-standby"

  backup:
    mode: "continuous"
    retention_days: 30

  failover:
    automatic: true
    rto_minutes: 1
    rpo_minutes: 0

  testing:
    frequency: "quarterly"
    last_test: "2024-12-01"
    next_test: "2025-03-01"
```

### Testing Failover

```python
# test_failover.py
from azure.cosmos import CosmosClient
from azure.mgmt.cosmosdb import CosmosDBManagementClient
from azure.identity import DefaultAzureCredential
import time

class FailoverTester:
    """Test Cosmos DB failover procedures."""

    def __init__(self, subscription_id: str, resource_group: str, account_name: str):
        self.credential = DefaultAzureCredential()
        self.management_client = CosmosDBManagementClient(
            self.credential, subscription_id
        )
        self.resource_group = resource_group
        self.account_name = account_name

    def test_manual_failover(self):
        """Test manual failover operation."""
        print("Starting failover test...")

        # Get current configuration
        account = self.management_client.database_accounts.get(
            self.resource_group,
            self.account_name
        )

        current_locations = account.write_locations
        print(f"Current write region: {current_locations[0].location_name}")

        # Perform failover
        new_priorities = [
            {
                'locationName': current_locations[1].location_name,
                'failoverPriority': 0
            },
            {
                'locationName': current_locations[0].location_name,
                'failoverPriority': 1
            }
        ]

        # Initiate failover
        operation = self.management_client.database_accounts.begin_failover_priority_change(
            self.resource_group,
            self.account_name,
            new_priorities
        )

        # Wait for completion
        result = operation.result()
        print("Failover completed successfully")

        # Verify new configuration
        time.sleep(10)
        updated_account = self.management_client.database_accounts.get(
            self.resource_group,
            self.account_name
        )

        print(f"New write region: {updated_account.write_locations[0].location_name}")

        return True

# Usage
tester = FailoverTester(
    subscription_id="your-sub-id",
    resource_group="rg-analytics",
    account_name="cosmos-analytics-prod"
)

tester.test_manual_failover()
```

---

## Performance Optimization

### Preferred Locations

```csharp
// Configure preferred read regions
CosmosClientOptions options = new CosmosClientOptions
{
    ApplicationRegion = Regions.EastUS,
    ApplicationPreferredRegions = new List<string>
    {
        Regions.EastUS,
        Regions.WestUS,
        Regions.WestEurope
    },
    ConnectionMode = ConnectionMode.Direct
};

CosmosClient client = new CosmosClient(endpoint, key, options);
```

```python
# Python SDK preferred regions
from azure.cosmos import CosmosClient

client = CosmosClient(
    url=cosmos_endpoint,
    credential=cosmos_key,
    preferred_locations=["East US", "West US", "West Europe"]
)
```

### Request Routing

| Scenario | Configuration | Benefit |
|----------|---------------|---------|
| **Nearest region** | Set ApplicationRegion to user location | Lowest latency |
| **Manual routing** | Use ApplicationPreferredRegions list | Control over region usage |
| **Home region** | Single ApplicationRegion | Predictable costs |
| **Multi-region write** | Enable multiple write locations | Write locality |

---

## Cost Considerations

### Multi-Region Pricing

| Configuration | Cost Multiplier | Use Case |
|---------------|----------------|----------|
| Single region | 1x | Development, testing |
| 2 regions (1 write) | ~2x | Basic redundancy |
| 2 regions (2 writes) | ~2x + conflicts | Active-active workloads |
| 4 regions (1 write) | ~4x | Global read access |
| 4 regions (4 writes) | ~4x + conflicts | Global active-active |

### Cost Optimization Tips

```yaml
# cost-optimization.yaml
strategies:
  - name: "Use session consistency"
    savings: "Lower latency, better throughput"

  - name: "Minimize write regions"
    savings: "Reduce multi-write overhead"

  - name: "Right-size throughput per region"
    savings: "Pay only for needed capacity"

  - name: "Use autoscale"
    savings: "Scale down during low usage"

  - name: "Monitor cross-region traffic"
    savings: "Minimize data egress costs"
```

---

## Monitoring and Diagnostics

### Key Metrics

```bash
# Monitor replication latency
az monitor metrics list \
  --resource "/subscriptions/{sub}/resourceGroups/rg-analytics/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-analytics-prod" \
  --metric "ReplicationLatency" \
  --start-time 2024-12-01T00:00:00Z \
  --end-time 2024-12-10T00:00:00Z \
  --interval PT1H

# Monitor availability
az monitor metrics list \
  --resource "/subscriptions/{sub}/resourceGroups/rg-analytics/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-analytics-prod" \
  --metric "ServiceAvailability" \
  --aggregation Average
```

### Diagnostic Settings

```bash
# Configure diagnostic logs
az monitor diagnostic-settings create \
  --name cosmos-diagnostics \
  --resource "/subscriptions/{sub}/resourceGroups/rg-analytics/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-analytics-prod" \
  --logs '[{"category":"DataPlaneRequests","enabled":true},{"category":"QueryRuntimeStatistics","enabled":true}]' \
  --metrics '[{"category":"Requests","enabled":true}]' \
  --workspace "/subscriptions/{sub}/resourceGroups/rg-analytics/providers/Microsoft.OperationalInsights/workspaces/log-analytics-prod"
```

### Monitoring Dashboard

```kql
// Azure Monitor KQL queries
// Monitor cross-region latency
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DOCUMENTDB"
| where Category == "DataPlaneRequests"
| summarize avg(responseLength_s) by Region_s, bin(TimeGenerated, 5m)
| render timechart

// Track failover events
AzureActivity
| where OperationNameValue contains "failover"
| where ResourceProvider == "Microsoft.DocumentDB"
| project TimeGenerated, OperationNameValue, ActivityStatusValue, Region_s
| order by TimeGenerated desc
```

---

## Best Practices

### Global Distribution Checklist

- [ ] Select regions based on user distribution and latency requirements
- [ ] Enable zone redundancy in supported regions for 99.999% availability
- [ ] Configure appropriate consistency level for workload requirements
- [ ] Enable automatic failover for production workloads
- [ ] Implement conflict resolution strategy for multi-write scenarios
- [ ] Monitor replication latency and availability metrics
- [ ] Test failover procedures regularly
- [ ] Configure backup and disaster recovery policies
- [ ] Optimize request routing with preferred regions
- [ ] Monitor and optimize cross-region data transfer costs

### Common Pitfalls

| Issue | Impact | Solution |
|-------|--------|----------|
| Too many write regions | High cost, conflicts | Use write regions only where needed |
| Wrong consistency level | Performance or consistency issues | Match consistency to requirements |
| No failover testing | Unprepared for outages | Test failover quarterly |
| Ignoring conflicts | Data inconsistencies | Implement proper conflict resolution |
| Poor region selection | High latency | Place regions near users |

---

## Related Resources

- [Azure Cosmos DB Documentation](https://docs.microsoft.com/azure/cosmos-db/)
- [Consistency Levels Guide](https://docs.microsoft.com/azure/cosmos-db/consistency-levels)
- [Multi-Region Writes](https://docs.microsoft.com/azure/cosmos-db/how-to-multi-master)
- [Conflict Resolution](https://docs.microsoft.com/azure/cosmos-db/conflict-resolution-policies)
- [Azure Regions Reference](../azure-regions.md)
- [Cost Optimization Best Practices](../../best-practices/cost-optimization.md)

---

> **Note**: Global distribution features and regional availability are continuously expanding. Always verify current capabilities using the [Azure Cosmos DB products by region page](https://azure.microsoft.com/global-infrastructure/services/?products=cosmos-db).
