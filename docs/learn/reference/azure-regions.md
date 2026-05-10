# Azure Regions Reference for Synapse Analytics

[Home](../../README.md) > [Reference](README.md) > Azure Regions

> Comprehensive reference guide for Azure region selection, availability, disaster recovery planning, and performance optimization for Azure Synapse Analytics deployments.

---

## Table of Contents

- [Available Azure Regions](#available-azure-regions)
- [Region Pairs for Disaster Recovery](#region-pairs-for-disaster-recovery)
- [Latency Considerations](#latency-considerations)
- [Feature Availability by Region](#feature-availability-by-region)
- [Region Selection Guide](#region-selection-guide)
- [Network Topology](#network-topology)
- [Migration Between Regions](#migration-between-regions)

---

## Available Azure Regions

### Global Region Overview

Azure Synapse Analytics is available in 60+ regions worldwide, providing global coverage with local data residency options.

### Americas

#### North America

| Region Name | Location | Region Code | Availability Zones | Synapse Features |
|------------|----------|-------------|-------------------|------------------|
| East US | Virginia, USA | eastus | Yes (3 zones) | All features |
| East US 2 | Virginia, USA | eastus2 | Yes (3 zones) | All features |
| Central US | Iowa, USA | centralus | No | All features |
| North Central US | Illinois, USA | northcentralus | No | All features |
| South Central US | Texas, USA | southcentralus | Yes (3 zones) | All features |
| West US | California, USA | westus | No | All features |
| West US 2 | Washington, USA | westus2 | Yes (3 zones) | All features |
| West US 3 | Phoenix, USA | westus3 | Yes (3 zones) | All features |
| Canada Central | Toronto, Canada | canadacentral | Yes (3 zones) | All features |
| Canada East | Quebec City, Canada | canadaeast | No | All features |

#### South America

| Region Name | Location | Region Code | Availability Zones | Synapse Features |
|------------|----------|-------------|-------------------|------------------|
| Brazil South | Sao Paulo, Brazil | brazilsouth | Yes (3 zones) | All features |
| Brazil Southeast | Rio de Janeiro, Brazil | brazilsoutheast | No | All features |

### Europe

| Region Name | Location | Region Code | Availability Zones | Synapse Features |
|------------|----------|-------------|-------------------|------------------|
| North Europe | Ireland | northeurope | Yes (3 zones) | All features |
| West Europe | Netherlands | westeurope | Yes (3 zones) | All features |
| France Central | Paris, France | francecentral | Yes (3 zones) | All features |
| France South | Marseille, France | francesouth | No | All features |
| Germany West Central | Frankfurt, Germany | germanywestcentral | Yes (3 zones) | All features |
| Germany North | Berlin, Germany | germanynorth | No | All features |
| Norway East | Oslo, Norway | norwayeast | Yes (3 zones) | All features |
| Norway West | Stavanger, Norway | norwaywest | No | All features |
| Switzerland North | Zurich, Switzerland | switzerlandnorth | Yes (3 zones) | All features |
| Switzerland West | Geneva, Switzerland | switzerlandwest | No | All features |
| UK South | London, UK | uksouth | Yes (3 zones) | All features |
| UK West | Cardiff, UK | ukwest | No | All features |
| Sweden Central | Gävle, Sweden | swedencentral | Yes (3 zones) | All features |
| Poland Central | Warsaw, Poland | polandcentral | Yes (3 zones) | All features |

### Asia Pacific

| Region Name | Location | Region Code | Availability Zones | Synapse Features |
|------------|----------|-------------|-------------------|------------------|
| Southeast Asia | Singapore | southeastasia | Yes (3 zones) | All features |
| East Asia | Hong Kong | eastasia | Yes (3 zones) | All features |
| Australia East | New South Wales | australiaeast | Yes (3 zones) | All features |
| Australia Southeast | Victoria | australiasoutheast | No | All features |
| Australia Central | Canberra | australiacentral | No | All features |
| Central India | Pune, India | centralindia | Yes (3 zones) | All features |
| South India | Chennai, India | southindia | No | All features |
| West India | Mumbai, India | westindia | No | All features |
| Japan East | Tokyo, Japan | japaneast | Yes (3 zones) | All features |
| Japan West | Osaka, Japan | japanwest | No | All features |
| Korea Central | Seoul, South Korea | koreacentral | Yes (3 zones) | All features |
| Korea South | Busan, South Korea | koreasouth | No | All features |

### Middle East and Africa

| Region Name | Location | Region Code | Availability Zones | Synapse Features |
|------------|----------|-------------|-------------------|------------------|
| UAE North | Dubai, UAE | uaenorth | Yes (3 zones) | All features |
| UAE Central | Abu Dhabi, UAE | uaecentral | No | All features |
| South Africa North | Johannesburg | southafricanorth | Yes (3 zones) | All features |
| South Africa West | Cape Town | southafricawest | No | All features |
| Qatar Central | Doha, Qatar | qatarcentral | Yes (3 zones) | All features |
| Israel Central | Israel | israelcentral | Yes (3 zones) | All features |

### Azure China (via 21Vianet)

| Region Name | Location | Region Code | Availability Zones | Synapse Features |
|------------|----------|-------------|-------------------|------------------|
| China North 3 | Beijing | chinanorth3 | Yes (3 zones) | Limited features |
| China East 3 | Shanghai | chinaeast3 | Yes (3 zones) | Limited features |

### Azure Government (US)

| Region Name | Location | Region Code | Availability Zones | Synapse Features |
|------------|----------|-------------|-------------------|------------------|
| US Gov Virginia | Virginia | usgovvirginia | Yes (3 zones) | All features |
| US Gov Arizona | Arizona | usgovarizona | No | All features |
| US Gov Texas | Texas | usgovtexas | Yes (3 zones) | All features |
| US DoD East | Virginia | usdodeast | No | Limited features |
| US DoD Central | Iowa | usdodcentral | No | Limited features |

---

## Region Pairs for Disaster Recovery

### Understanding Region Pairs

Azure region pairs are designed for disaster recovery and business continuity. Each Azure region is paired with another region within the same geography, at least 300 miles apart.

### Primary Region Pairs

| Primary Region | Paired Region | Distance (approx.) | Replication Options |
|----------------|---------------|-------------------|---------------------|
| East US | West US | 2,400 miles | GRS, GZRS |
| East US 2 | Central US | 800 miles | GRS, GZRS |
| West US 2 | West Central US | 1,000 miles | GRS, GZRS |
| North Europe | West Europe | 1,000 miles | GRS, GZRS |
| Southeast Asia | East Asia | 1,600 miles | GRS, GZRS |
| Australia East | Australia Southeast | 500 miles | GRS, GZRS |
| UK South | UK West | 200 miles | GRS, GZRS |
| Japan East | Japan West | 250 miles | GRS, GZRS |
| Canada Central | Canada East | 500 miles | GRS, GZRS |
| Brazil South | South Central US | 5,000 miles | GRS |
| France Central | France South | 400 miles | GRS, GZRS |
| Germany West Central | Germany North | 300 miles | GRS, GZRS |
| Switzerland North | Switzerland West | 100 miles | GRS, GZRS |
| Norway East | Norway West | 200 miles | GRS, GZRS |

### Disaster Recovery Architecture

```text
+----------------------------------+          +----------------------------------+
|   Primary Region (East US)       |          |   Paired Region (West US)        |
+----------------------------------+          +----------------------------------+
|                                  |          |                                  |
|  +----------------------------+  |          |  +----------------------------+  |
|  | Azure Synapse Workspace    |  |          |  | DR Synapse Workspace       |  |
|  | - Dedicated SQL Pool       |  |   Geo-   |  | - Dedicated SQL Pool       |  |
|  | - Spark Pool               |  | Replica  |  | - Spark Pool               |  |
|  | - Pipelines                |  +--------->|  | - Pipelines                |  |
|  +----------------------------+  |          |  +----------------------------+  |
|                                  |          |                                  |
|  +----------------------------+  |          |  +----------------------------+  |
|  | ADLS Gen2 (Primary)        |  |   GRS    |  | ADLS Gen2 (Secondary)      |  |
|  | - Hot Tier                 |  +--------->|  | - Hot Tier                 |  |
|  | - Cool Tier                |  |          |  | - Cool Tier                |  |
|  +----------------------------+  |          |  +----------------------------+  |
|                                  |          |                                  |
+----------------------------------+          +----------------------------------+
```

### Implementing Geo-Redundant Storage

```bash
# Create storage account with geo-redundant replication
az storage account create \
  --name synapsedata001 \
  --resource-group rg-synapse-prod \
  --location eastus \
  --sku Standard_GRS \
  --kind StorageV2 \
  --hierarchical-namespace true \
  --enable-large-file-share

# Check replication status
az storage account show \
  --name synapsedata001 \
  --resource-group rg-synapse-prod \
  --query '{location:primaryLocation, secondaryLocation:secondaryLocation, status:statusOfPrimary}'
```

### Disaster Recovery Best Practices

1. __Active-Passive Configuration__
   - Primary region handles all traffic
   - Secondary region on standby
   - Regular DR testing (quarterly recommended)

2. __Active-Active Configuration__
   - Both regions handle traffic
   - Load balanced across regions
   - Higher cost but better performance

3. __Backup Strategy__
   - Regular backups to paired region
   - Point-in-time restore capability
   - Backup retention policies

4. __Failover Procedures__
   - Documented failover runbook
   - Automated failover scripts
   - Regular DR drills

```python
# disaster_recovery.py
from azure.mgmt.synapse import SynapseManagementClient
from azure.identity import DefaultAzureCredential
from azure.mgmt.storage import StorageManagementClient

class DisasterRecoveryController:
    """Manage disaster recovery operations."""

    def __init__(self, subscription_id: str):
        self.credential = DefaultAzureCredential()
        self.synapse_client = SynapseManagementClient(
            self.credential, subscription_id
        )
        self.storage_client = StorageManagementClient(
            self.credential, subscription_id
        )

    def initiate_failover(
        self,
        resource_group: str,
        workspace_name: str,
        target_region: str
    ):
        """
        Initiate failover to disaster recovery region.

        Args:
            resource_group: Resource group name
            workspace_name: Synapse workspace name
            target_region: Target DR region
        """
        print(f"Initiating failover for {workspace_name} to {target_region}")

        # 1. Verify secondary region availability
        self._check_region_health(target_region)

        # 2. Initiate storage failover
        self._failover_storage(resource_group)

        # 3. Update DNS/Traffic Manager
        self._update_traffic_routing(target_region)

        # 4. Validate failover
        self._validate_failover(resource_group, workspace_name)

        print("Failover completed successfully")

    def _check_region_health(self, region: str):
        """Check health status of target region."""
        # Implementation to verify region health
        pass

    def _failover_storage(self, resource_group: str):
        """Initiate storage account failover."""
        # Implementation for storage failover
        pass
```

---

## Latency Considerations

### Network Latency Between Regions

Understanding network latency is crucial for multi-region deployments and data replication strategies.

### Average Latency Matrix (milliseconds)

| From/To | East US | West Europe | Southeast Asia | Australia East |
|---------|---------|-------------|----------------|----------------|
| __East US__ | <1 | 80-100 | 180-220 | 220-260 |
| __West Europe__ | 80-100 | <1 | 140-180 | 280-320 |
| __Southeast Asia__ | 180-220 | 140-180 | <1 | 80-120 |
| __Australia East__ | 220-260 | 280-320 | 80-120 | <1 |
| __Japan East__ | 140-180 | 220-260 | 60-100 | 100-140 |
| __Brazil South__ | 120-160 | 200-240 | 320-360 | 340-380 |
| __UK South__ | 70-90 | 10-20 | 150-190 | 290-330 |

### Within-Region Latency (Availability Zones)

| Configuration | Latency | Bandwidth |
|--------------|---------|-----------|
| Same Availability Zone | <1 ms | 25-100 Gbps |
| Different Availability Zones (same region) | 1-2 ms | 10-25 Gbps |
| Same Region (no AZ) | <5 ms | 10-25 Gbps |

### Measuring Network Latency

```bash
# Test latency between regions using Azure Network Watcher
az network watcher test-connectivity \
  --source-resource "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{vm}" \
  --dest-address "synapse-workspace.database.windows.net" \
  --dest-port 1433 \
  --protocol TCP

# Use psping for detailed latency testing (Windows)
psping synapse-eastus.sql.azuresynapse.net:1433

# Use nc for latency testing (Linux)
nc -zv synapse-westeurope.sql.azuresynapse.net 1433
```

### Performance Optimization Based on Latency

#### Low Latency Requirements (<10ms)

- Deploy in same region as data sources
- Use Availability Zones for HA
- Co-locate Synapse and storage

```yaml
# low-latency-config.yaml
deployment:
  architecture: "same-region"
  synapse_region: "eastus"
  storage_region: "eastus"
  availability_zones: true
  private_endpoints: true
  expected_latency: "1-5ms"
```

#### Medium Latency Tolerance (10-50ms)

- Same geography, different regions
- Regional replication acceptable
- Cached data strategies

```yaml
# medium-latency-config.yaml
deployment:
  architecture: "regional-failover"
  primary_region: "eastus"
  secondary_region: "westus"
  replication_lag: "15-30s"
  expected_latency: "10-30ms"
```

#### High Latency Tolerance (>50ms)

- Global deployments
- Batch processing workloads
- Asynchronous replication

```yaml
# high-latency-config.yaml
deployment:
  architecture: "multi-region"
  regions:
    - "eastus"
    - "westeurope"
    - "southeastasia"
  replication: "async"
  expected_latency: "50-200ms"
```

### Latency Impact on Workloads

| Workload Type | Latency Sensitivity | Recommended Deployment |
|---------------|---------------------|------------------------|
| Real-time Analytics | High (<10ms) | Same region, AZ-enabled |
| Interactive Queries | Medium (10-50ms) | Regional |
| Batch Processing | Low (>50ms) | Multi-region acceptable |
| Data Replication | Low | Async across regions |
| API Services | High (<20ms) | Regional with CDN |

---

## Feature Availability by Region

### General Availability Status

Most Azure Synapse features are generally available (GA) in all regions. However, some newer features may have limited regional availability.

### Feature Availability Matrix

| Feature | Global Regions | China Regions | Gov Regions | Notes |
|---------|---------------|---------------|-------------|-------|
| Dedicated SQL Pools | GA | GA | GA | All regions |
| Serverless SQL Pools | GA | GA | GA | All regions |
| Apache Spark Pools | GA | GA | GA | All regions |
| Data Integration Pipelines | GA | GA | GA | All regions |
| Azure Synapse Link | GA | Limited | GA | Some connectors limited in China |
| Purview Integration | GA | No | Limited | Not available in China regions |
| Power BI Integration | GA | Limited | GA | Requires Power BI availability |
| Azure ML Integration | GA | Limited | GA | Based on Azure ML availability |
| Git Integration | GA | Limited | GA | GitHub may be restricted |
| Managed VNet | GA | Limited | GA | Most regions |
| Data Exfiltration Protection | GA | No | Limited | Preview in some regions |
| Customer-Managed Keys | GA | GA | GA | All regions |
| Private Link | GA | Limited | GA | Most regions |
| Availability Zones | Selected | Selected | Selected | See region table |

### Preview Features by Region

| Preview Feature | Available Regions | GA Timeline |
|----------------|-------------------|-------------|
| Synapse Data Explorer Pools | Select regions | 2025 Q2 |
| Enhanced Security Features | All GA regions | 2025 Q1 |
| Advanced Monitoring | All regions | GA |

### Checking Feature Availability

```bash
# List available SKUs in a region
az synapse workspace list-skus \
  --location eastus \
  --output table

# Check specific feature availability
az provider show \
  --namespace Microsoft.Synapse \
  --query "resourceTypes[?resourceType=='workspaces'].capabilities" \
  --output table
```

### Regional Limitations

#### China Regions (via 21Vianet)

- Limited integration with global Azure services
- Separate compliance certifications
- Some SaaS integrations unavailable
- Different support model

#### Government Regions

- Enhanced security controls
- US-based personnel requirement
- Limited preview feature access
- Separate compliance framework

---

## Region Selection Guide

### Decision Framework

```text
┌─────────────────────────────┐
│  Region Selection Process   │
└──────────┬──────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ 1. Data Residency Requirements│
│    - Regulatory compliance    │
│    - Data sovereignty         │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ 2. User/Data Source Location │
│    - Minimize latency         │
│    - Network proximity        │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ 3. Feature Requirements      │
│    - Availability Zones       │
│    - Specific features        │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ 4. Cost Considerations       │
│    - Regional pricing         │
│    - Data transfer costs      │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ 5. Disaster Recovery         │
│    - Paired region available  │
│    - DR strategy              │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│    Final Region Selection    │
└──────────────────────────────┘
```

### Selection Criteria

#### Compliance-Driven Selection

```python
# region_selector.py
def select_region_by_compliance(compliance_requirements: list) -> list:
    """
    Select appropriate regions based on compliance requirements.

    Args:
        compliance_requirements: List of required compliance frameworks

    Returns:
        List of compliant regions
    """
    compliance_map = {
        "GDPR": ["westeurope", "northeurope", "francecentral", "germanywestcentral"],
        "HIPAA": ["eastus", "westus", "centralus"],
        "FedRAMP": ["usgovvirginia", "usgovarizona", "usgovtexas"],
        "PDPA": ["southeastasia"],
        "LGPD": ["brazilsouth"],
    }

    # Find regions that satisfy all requirements
    compliant_regions = None
    for requirement in compliance_requirements:
        regions = set(compliance_map.get(requirement, []))
        if compliant_regions is None:
            compliant_regions = regions
        else:
            compliant_regions = compliant_regions.intersection(regions)

    return list(compliant_regions) if compliant_regions else []

# Example usage
requirements = ["GDPR", "ISO 27001"]
recommended_regions = select_region_by_compliance(requirements)
print(f"Recommended regions: {recommended_regions}")
```

#### Performance-Driven Selection

```python
def select_region_by_latency(source_location: str, max_latency_ms: int) -> list:
    """
    Select regions based on latency requirements.

    Args:
        source_location: Primary data source location
        max_latency_ms: Maximum acceptable latency in milliseconds

    Returns:
        List of regions meeting latency requirement
    """
    # Latency matrix (simplified)
    latency_matrix = {
        "eastus": {
            "eastus": 1,
            "westus": 70,
            "westeurope": 90,
            "southeastasia": 200,
        },
        "westeurope": {
            "westeurope": 1,
            "northeurope": 15,
            "eastus": 90,
            "southeastasia": 160,
        },
    }

    acceptable_regions = []
    if source_location in latency_matrix:
        for region, latency in latency_matrix[source_location].items():
            if latency <= max_latency_ms:
                acceptable_regions.append(region)

    return acceptable_regions
```

#### Cost-Driven Selection

```python
def calculate_regional_costs(workload_config: dict) -> dict:
    """
    Calculate estimated costs across regions.

    Args:
        workload_config: Dictionary with compute, storage, and network requirements

    Returns:
        Dictionary of regions with estimated monthly costs
    """
    # Regional pricing multipliers (relative to East US)
    regional_multipliers = {
        "eastus": 1.0,
        "westeurope": 1.10,
        "uksouth": 1.15,
        "australiaeast": 1.20,
        "brazilsouth": 1.25,
    }

    base_cost = (
        workload_config["compute_hours"] * 0.50 +
        workload_config["storage_gb"] * 0.02 +
        workload_config["network_gb"] * 0.08
    )

    return {
        region: round(base_cost * multiplier, 2)
        for region, multiplier in regional_multipliers.items()
    }
```

### Multi-Region Strategy

```yaml
# multi-region-deployment.yaml
strategy:
  type: "active-active"

  regions:
    - name: "eastus"
      role: "primary"
      traffic_weight: 60
      workloads:
        - "real-time-analytics"
        - "interactive-queries"

    - name: "westeurope"
      role: "primary"
      traffic_weight: 40
      workloads:
        - "batch-processing"
        - "reporting"

    - name: "southeastasia"
      role: "secondary"
      traffic_weight: 0
      workloads:
        - "disaster-recovery"

  data_distribution:
    strategy: "geo-partitioned"
    replication: "async"

  failover:
    automatic: true
    rto_minutes: 15
    rpo_minutes: 5
```

---

## Network Topology

### Hub-and-Spoke Architecture

```text
                    ┌──────────────────────┐
                    │   Hub Region         │
                    │   (East US)          │
                    ├──────────────────────┤
                    │ - Shared Services    │
                    │ - Security Controls  │
                    │ - Monitoring         │
                    └─────────┬────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
    ┌───────▼────────┐ ┌──────▼──────┐ ┌───────▼────────┐
    │ Spoke Region 1 │ │ Spoke Region 2│ │ Spoke Region 3│
    │ (West US)      │ │ (West Europe) │ │ (Southeast Asia)│
    ├────────────────┤ ├───────────────┤ ├────────────────┤
    │ Synapse WS     │ │ Synapse WS    │ │ Synapse WS     │
    │ ADLS Gen2      │ │ ADLS Gen2     │ │ ADLS Gen2      │
    └────────────────┘ └───────────────┘ └────────────────┘
```

### ExpressRoute and Private Link

```bash
# Configure private endpoint for Synapse workspace
az synapse workspace create \
  --name syn-prod-eastus \
  --resource-group rg-synapse-prod \
  --location eastus \
  --enable-managed-vnet true \
  --prevent-data-exfiltration true

# Create private endpoint
az network private-endpoint create \
  --name pe-synapse-eastus \
  --resource-group rg-synapse-prod \
  --vnet-name vnet-prod \
  --subnet snet-synapse \
  --private-connection-resource-id "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Synapse/workspaces/syn-prod-eastus" \
  --connection-name synapse-connection \
  --group-id Sql
```

---

## Migration Between Regions

### Migration Scenarios

1. __Compliance-Driven Migration__
   - New regulatory requirements
   - Data sovereignty changes
   - Audit findings

2. __Performance Optimization__
   - Reduce latency
   - Improve user experience
   - Co-locate with data sources

3. __Cost Optimization__
   - Move to cheaper region
   - Optimize data transfer costs
   - Consolidate resources

### Migration Strategy

```text
┌─────────────────────┐
│ Pre-Migration Phase │
│ - Assessment        │
│ - Planning          │
│ - Validation        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Migration Execution │
│ - Data Copy         │
│ - Configuration     │
│ - Testing           │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Cutover Phase       │
│ - Traffic Switch    │
│ - Validation        │
│ - Cleanup           │
└─────────────────────┘
```

### Migration Script Example

```python
# region_migration.py
from azure.mgmt.synapse import SynapseManagementClient
from azure.storage.filedatalake import DataLakeServiceClient
from azure.identity import DefaultAzureCredential

class RegionMigration:
    """Handle migration of Synapse workspace between regions."""

    def __init__(self, subscription_id: str):
        self.credential = DefaultAzureCredential()
        self.synapse_client = SynapseManagementClient(
            self.credential, subscription_id
        )

    def migrate_workspace(
        self,
        source_rg: str,
        source_workspace: str,
        target_region: str,
        target_rg: str
    ):
        """
        Migrate Synapse workspace to new region.

        Args:
            source_rg: Source resource group
            source_workspace: Source workspace name
            target_region: Target Azure region
            target_rg: Target resource group
        """
        print(f"Starting migration from {source_workspace} to {target_region}")

        # 1. Export source configuration
        config = self._export_configuration(source_rg, source_workspace)

        # 2. Copy data to target region
        self._copy_data(source_rg, target_rg, target_region)

        # 3. Create target workspace
        self._create_target_workspace(
            target_rg, target_region, config
        )

        # 4. Validate migration
        self._validate_migration(target_rg, source_workspace)

        print("Migration completed successfully")

    def _export_configuration(self, rg: str, workspace: str) -> dict:
        """Export workspace configuration."""
        # Export pipelines, notebooks, SQL scripts, etc.
        return {}

    def _copy_data(self, source_rg: str, target_rg: str, target_region: str):
        """Copy data using AzCopy or Data Factory."""
        pass

    def _create_target_workspace(self, rg: str, region: str, config: dict):
        """Create workspace in target region with configuration."""
        pass

    def _validate_migration(self, rg: str, workspace: str):
        """Validate migrated workspace."""
        pass
```

### Migration Checklist

- [ ] Assess current region utilization and dependencies
- [ ] Select target region based on requirements
- [ ] Document current configuration and resources
- [ ] Estimate migration time and costs
- [ ] Create migration plan and rollback procedures
- [ ] Set up target region infrastructure
- [ ] Copy data to target region (use Azure Data Factory or AzCopy)
- [ ] Recreate Synapse workspace in target region
- [ ] Import pipelines, notebooks, and scripts
- [ ] Configure security and networking
- [ ] Test all workloads in target region
- [ ] Update DNS and connection strings
- [ ] Perform cutover during maintenance window
- [ ] Validate data integrity and functionality
- [ ] Monitor performance in new region
- [ ] Decommission source region resources

---

## Best Practices

### Region Selection Best Practices

1. __Prioritize Data Residency__
   - Start with compliance requirements
   - Verify regulatory alignment
   - Document decisions

2. __Consider Latency__
   - Co-locate with data sources
   - Minimize cross-region traffic
   - Use CDN for global access

3. __Plan for Disaster Recovery__
   - Use region pairs
   - Test failover procedures
   - Document DR runbooks

4. __Optimize Costs__
   - Compare regional pricing
   - Minimize data egress
   - Use reserved instances

5. __Monitor Regional Health__
   - Subscribe to Azure status updates
   - Implement health checks
   - Plan for regional outages

---

## Related Resources

- [Regional Compliance Guide](regional-compliance.md)
- [Network Security Best Practices](../best-practices/network-security.md)
- [Disaster Recovery Planning](../architecture/README.md)
- [Cost Optimization Guide](../best-practices/cost-optimization.md)
- [Azure Products by Region](https://azure.microsoft.com/en-us/global-infrastructure/services/)
- [Azure Regional Pairs](https://docs.microsoft.com/en-us/azure/availability-zones/cross-region-replication-azure)

---

> __Note__: Region availability and features change regularly. Always verify current status using `az account list-locations` and the [Azure products by region page](https://azure.microsoft.com/en-us/global-infrastructure/services/).
