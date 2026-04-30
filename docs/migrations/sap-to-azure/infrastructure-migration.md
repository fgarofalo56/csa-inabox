# SAP Infrastructure Migration to Azure

**Deploying SAP HANA and NetWeaver workloads on Azure-certified virtual machines with enterprise-grade storage, networking, and high availability.**

---

!!! warning "2027 Deadline"
Infrastructure migration is the foundation for every SAP-to-Azure workstream. Begin infrastructure planning at least 12 months before your target S/4HANA go-live to allow sufficient time for VM provisioning, network design, HANA installation, and HA/DR configuration.

## Overview

This guide covers the infrastructure layer for SAP on Azure: certified VM families, storage layout for HANA and application servers, networking design (VNet, subnets, NSG, proximity placement groups, accelerated networking), and Azure Center for SAP Solutions (ACSS) for automated deployment. The infrastructure described here serves as the foundation for the [HANA Database Migration](hana-migration.md) and [S/4HANA Conversion](s4hana-conversion.md) workstreams.

---

## 1. SAP-certified Azure VM families

SAP and Microsoft jointly certify Azure VM configurations against SAP Standard Application Benchmarks (SAPS). Only certified VMs are supported for production SAP HANA workloads.

### HANA database VMs

| VM family | VM size            | vCPUs | Memory (GiB) | SAPS    | Max HANA data (TB) | Use case                      |
| --------- | ------------------ | ----- | ------------ | ------- | ------------------ | ----------------------------- |
| Mv2       | Standard_M208s_v2  | 208   | 2,850        | 475,000 | 2.8                | S/4HANA, BW/4HANA             |
| Mv2       | Standard_M208ms_v2 | 208   | 5,700        | 475,000 | 5.7                | Large S/4HANA, BW/4HANA       |
| Mv2       | Standard_M416s_v2  | 416   | 5,700        | 850,000 | 5.7                | Very large BW/4HANA           |
| Mv2       | Standard_M416ms_v2 | 416   | 11,400       | 850,000 | 11.4               | Extreme-scale BW/4HANA        |
| M-series  | Standard_M128s     | 128   | 2,048        | 350,000 | 2.0                | S/4HANA production            |
| M-series  | Standard_M128ms    | 128   | 3,892        | 350,000 | 3.8                | S/4HANA + BW/4HANA            |
| M-series  | Standard_M64s      | 64    | 1,024        | 175,000 | 1.0                | Mid-size S/4HANA              |
| M-series  | Standard_M64ms     | 64    | 1,792        | 175,000 | 1.7                | Mid-size S/4HANA with growth  |
| M-series  | Standard_M32ts     | 32    | 192          | 85,000  | 0.19               | Non-production HANA (DEV/SBX) |

### Application server VMs

| VM family | VM size           | vCPUs | Memory (GiB) | SAPS     | Use case                           |
| --------- | ----------------- | ----- | ------------ | -------- | ---------------------------------- |
| Edsv5     | Standard_E96ds_v5 | 96    | 672          | 120,000+ | Large SAP application server       |
| Edsv5     | Standard_E64ds_v5 | 64    | 512          | 85,000+  | Standard SAP application server    |
| Edsv5     | Standard_E32ds_v5 | 32    | 256          | 42,000+  | Medium SAP application server      |
| Edsv5     | Standard_E16ds_v5 | 16    | 128          | 21,000+  | Small SAP app server / CI instance |
| Ddsv5     | Standard_D32ds_v5 | 32    | 128          | 35,000+  | SAP Web Dispatcher                 |
| Ddsv5     | Standard_D16ds_v5 | 16    | 64           | 17,000+  | SAP Gateway, SolMan                |

---

## 2. Storage layout

### SAP HANA storage --- Azure NetApp Files (recommended)

ANF is the recommended storage for production SAP HANA workloads. It provides consistent sub-millisecond latency, high throughput, and native NFS support required by HANA.

```
HANA Storage Layout (ANF)
├── /hana/data          → ANF volume (Ultra tier), 1.5x HANA memory
├── /hana/log           → ANF volume (Ultra tier), 512 GB minimum
├── /hana/shared        → ANF volume (Premium tier), 1x HANA memory
├── /usr/sap            → Premium SSD (256 GB, P15)
├── /sapmnt             → ANF volume (Premium tier, shared across app servers)
└── /hana/backup        → ANF volume (Standard tier) or Azure Blob (cool)
```

### ANF volume sizing

| Volume       | Tier     | Size formula              | IOPS     | Throughput | Notes                                   |
| ------------ | -------- | ------------------------- | -------- | ---------- | --------------------------------------- |
| /hana/data   | Ultra    | 1.5 x HANA memory         | 450,000+ | 4,500 MBps | Read-intensive; low latency critical    |
| /hana/log    | Ultra    | max(512 GB, 0.5 x memory) | 250,000+ | 2,000 MBps | Write-intensive; < 1ms latency required |
| /hana/shared | Premium  | 1 x HANA memory           | 64,000   | 1,000 MBps | Shared binaries, trace files            |
| /hana/backup | Standard | 3 x HANA data             | 32,000   | 500 MBps   | Backups; cost-optimized tier            |

### Alternative: Ultra Disk for HANA

```
HANA Storage Layout (Ultra Disk)
├── /hana/data          → Ultra Disk (1.5x memory, 80,000 IOPS, 2,000 MBps)
├── /hana/log           → Ultra Disk (512 GB, 40,000 IOPS, 1,000 MBps)
├── /hana/shared        → Premium SSD v2 (1x memory)
├── /usr/sap            → Premium SSD (256 GB)
└── /hana/backup        → Standard SSD or Azure Blob
```

### Application server storage

| Mount point | Disk type                   | Size                      | Notes                             |
| ----------- | --------------------------- | ------------------------- | --------------------------------- |
| /usr/sap    | Premium SSD                 | 256 GB (P15)              | SAP binaries, profiles            |
| /sapmnt     | ANF (shared) or Premium SSD | 256 GB                    | Shared across app servers via NFS |
| OS disk     | Premium SSD                 | 128 GB (P10)              | SUSE/RHEL OS                      |
| Swap        | Premium SSD                 | Based on SAP note 1597355 | Required for SAP                  |

---

## 3. Networking design

### VNet architecture for SAP

```
SAP Landing Zone VNet (10.1.0.0/16)
├── sap-db-subnet       (10.1.1.0/24)   → HANA VMs, ANF delegated subnet
├── sap-app-subnet      (10.1.2.0/24)   → Application servers, ASCS/ERS
├── sap-web-subnet      (10.1.3.0/24)   → Web Dispatcher, Fiori
├── sap-mgmt-subnet     (10.1.4.0/24)   → Jump boxes, Azure Bastion
└── anf-delegated-subnet (10.1.5.0/24)  → ANF delegated subnet

CSA-in-a-Box Data Landing Zone VNet (10.2.0.0/16)
├── fabric-subnet       (10.2.1.0/24)   → Fabric private endpoints
├── adf-subnet          (10.2.2.0/24)   → ADF integration runtime
├── databricks-subnet   (10.2.3.0/24)   → Databricks private endpoints
└── ai-subnet           (10.2.4.0/24)   → Azure AI private endpoints

VNet Peering: SAP VNet ↔ CSA-in-a-Box VNet (allow gateway transit)
```

### Network security groups (NSG)

| NSG rule               | Source         | Destination    | Port         | Protocol | Purpose                     |
| ---------------------- | -------------- | -------------- | ------------ | -------- | --------------------------- |
| Allow-HANA-SQL         | sap-app-subnet | sap-db-subnet  | 30015        | TCP      | HANA SQL/MDX                |
| Allow-HANA-Internal    | sap-db-subnet  | sap-db-subnet  | 39913--39915 | TCP      | HANA internal communication |
| Allow-HANA-HSR         | sap-db-subnet  | sap-db-subnet  | 40002--40005 | TCP      | HANA System Replication     |
| Allow-SAP-Dispatcher   | sap-web-subnet | sap-app-subnet | 3200--3299   | TCP      | SAP dispatcher ports        |
| Allow-SAP-Gateway      | sap-web-subnet | sap-app-subnet | 3300--3399   | TCP      | SAP gateway ports           |
| Allow-SAP-Message      | sap-app-subnet | sap-app-subnet | 3600--3699   | TCP      | SAP message server          |
| Allow-ICM              | sap-web-subnet | sap-app-subnet | 8000--8099   | TCP      | ICM HTTP/HTTPS              |
| Allow-Fiori            | Internet/AFD   | sap-web-subnet | 443          | TCP      | Fiori via Azure Front Door  |
| Allow-Fabric-Mirroring | sap-db-subnet  | fabric-subnet  | 443          | TCP      | Fabric Mirroring to OneLake |
| Deny-All-Inbound       | \*             | \*             | \*           | \*       | Default deny                |

### Proximity placement groups

!!! tip "Performance optimization"
Deploy HANA VMs and application server VMs in the same **proximity placement group** to minimize network latency between the database and application tiers. This is especially critical for SAP S/4HANA where application-to-database round-trip latency should be < 0.3 ms.

```bash
# Create proximity placement group
az ppg create \
  --resource-group rg-sap-prod \
  --name ppg-sap-prod \
  --location eastus2 \
  --type Standard

# Deploy HANA VM in PPG
az vm create \
  --resource-group rg-sap-prod \
  --name vm-hana-prd \
  --size Standard_M128s \
  --image SUSE:sles-sap-15-sp5:gen2:latest \
  --ppg ppg-sap-prod \
  --accelerated-networking true \
  --zone 1 \
  --subnet sap-db-subnet \
  --vnet-name vnet-sap-prod
```

### Accelerated networking

Accelerated networking is **mandatory** for all SAP VMs. It provides SR-IOV for near-bare-metal network performance.

```bash
# Verify accelerated networking is enabled
az vm show \
  --resource-group rg-sap-prod \
  --name vm-hana-prd \
  --query "networkProfile.networkInterfaces[0].id" -o tsv | \
  xargs az network nic show --ids | \
  jq '.enableAcceleratedNetworking'
```

---

## 4. Azure Center for SAP Solutions (ACSS) deployment

ACSS automates the deployment of SAP infrastructure on Azure, including VNet, VMs, disks, OS configuration, and HANA installation.

### Deployment via Azure CLI

```bash
# Create SAP Virtual Instance (three-tier deployment)
az workloads sap-virtual-instance create \
  --resource-group rg-sap-prod \
  --name S4H-PRD \
  --environment Production \
  --sap-product S4HANA \
  --location eastus2 \
  --configuration '{
    "configurationType": "DeploymentWithOSConfig",
    "appLocation": "eastus2",
    "infrastructureConfiguration": {
      "appResourceGroup": "rg-sap-prod-infra",
      "deploymentType": "ThreeTier",
      "centralServer": {
        "subnetId": "/subscriptions/<sub>/resourceGroups/rg-sap-prod/providers/Microsoft.Network/virtualNetworks/vnet-sap-prod/subnets/sap-app-subnet",
        "virtualMachineConfiguration": {
          "vmSize": "Standard_E32ds_v5",
          "imageReference": {
            "publisher": "SUSE",
            "offer": "sles-sap-15-sp5",
            "sku": "gen2",
            "version": "latest"
          },
          "osProfile": {
            "adminUsername": "sapadmin"
          }
        },
        "instanceCount": 1
      },
      "applicationServer": {
        "subnetId": "/subscriptions/<sub>/resourceGroups/rg-sap-prod/providers/Microsoft.Network/virtualNetworks/vnet-sap-prod/subnets/sap-app-subnet",
        "virtualMachineConfiguration": {
          "vmSize": "Standard_E32ds_v5",
          "imageReference": {
            "publisher": "SUSE",
            "offer": "sles-sap-15-sp5",
            "sku": "gen2",
            "version": "latest"
          },
          "osProfile": {
            "adminUsername": "sapadmin"
          }
        },
        "instanceCount": 3
      },
      "databaseServer": {
        "subnetId": "/subscriptions/<sub>/resourceGroups/rg-sap-prod/providers/Microsoft.Network/virtualNetworks/vnet-sap-prod/subnets/sap-db-subnet",
        "databaseType": "HANA",
        "virtualMachineConfiguration": {
          "vmSize": "Standard_M128s",
          "imageReference": {
            "publisher": "SUSE",
            "offer": "sles-sap-15-sp5",
            "sku": "gen2",
            "version": "latest"
          },
          "osProfile": {
            "adminUsername": "sapadmin"
          }
        },
        "instanceCount": 1
      }
    }
  }'
```

### Deployment via Bicep

```bicep
resource sapVirtualInstance 'Microsoft.Workloads/sapVirtualInstances@2023-10-01-preview' = {
  name: 'S4H-PRD'
  location: 'eastus2'
  properties: {
    environment: 'Production'
    sapProduct: 'S4HANA'
    configuration: {
      configurationType: 'DeploymentWithOSConfig'
      appLocation: 'eastus2'
      infrastructureConfiguration: {
        appResourceGroup: 'rg-sap-prod-infra'
        deploymentType: 'ThreeTier'
        centralServer: {
          subnetId: sapAppSubnet.id
          virtualMachineConfiguration: {
            vmSize: 'Standard_E32ds_v5'
            imageReference: {
              publisher: 'SUSE'
              offer: 'sles-sap-15-sp5'
              sku: 'gen2'
              version: 'latest'
            }
          }
          instanceCount: 1
        }
        databaseServer: {
          subnetId: sapDbSubnet.id
          databaseType: 'HANA'
          virtualMachineConfiguration: {
            vmSize: 'Standard_M128s'
            imageReference: {
              publisher: 'SUSE'
              offer: 'sles-sap-15-sp5'
              sku: 'gen2'
              version: 'latest'
            }
          }
          instanceCount: 1
        }
        applicationServer: {
          subnetId: sapAppSubnet.id
          virtualMachineConfiguration: {
            vmSize: 'Standard_E32ds_v5'
            imageReference: {
              publisher: 'SUSE'
              offer: 'sles-sap-15-sp5'
              sku: 'gen2'
              version: 'latest'
            }
          }
          instanceCount: 3
        }
      }
    }
  }
}
```

---

## 5. High availability architecture

### HANA HA with HSR and Pacemaker (SUSE)

```
                    Azure Load Balancer (Standard)
                         │
              ┌──────────┴──────────┐
              │                     │
    ┌─────────▼──────────┐  ┌──────▼──────────────┐
    │  HANA Primary      │  │  HANA Secondary     │
    │  (Zone 1)          │  │  (Zone 2)           │
    │  Standard_M128s    │  │  Standard_M128s     │
    │  ANF data/log      │──│  ANF data/log       │
    │  Pacemaker agent   │  │  Pacemaker agent    │
    └────────────────────┘  └─────────────────────┘
           HSR (synchronous, memory preload)
```

```bash
# Configure HANA System Replication (on primary)
hdbnsutil -sr_enable --name=site1

# Register secondary site
hdbnsutil -sr_register \
  --remoteHost=vm-hana-prd-02 \
  --remoteInstance=00 \
  --replicationMode=syncmem \
  --operationMode=logreplay \
  --name=site2
```

### ASCS/ERS HA with Pacemaker

```
              Azure Load Balancer (Standard)
                       │
            ┌──────────┴──────────┐
            │                     │
    ┌───────▼─────────┐  ┌───────▼──────────┐
    │  ASCS (Zone 1)  │  │  ERS (Zone 2)    │
    │  Pacemaker      │  │  Pacemaker       │
    │  Enqueue Server │  │  Enqueue Rep.    │
    └─────────────────┘  └──────────────────┘
```

---

## 6. Disaster recovery

| Component           | DR approach                        | RPO      | RTO        | Notes                                      |
| ------------------- | ---------------------------------- | -------- | ---------- | ------------------------------------------ |
| HANA database       | HSR (async to DR region)           | < 15 min | 30--60 min | Asynchronous HSR to secondary Azure region |
| Application servers | Azure Site Recovery                | < 15 min | 1--2 hours | ASR replicates app server VMs              |
| ANF volumes         | ANF Cross-Region Replication (CRR) | < 15 min | 30 min     | CRR for HANA data/log/shared               |
| SAP configuration   | Azure Backup (weekly)              | 24 hours | 2--4 hours | SAP profiles, transport directory          |
| Shared file systems | ANF CRR or Azure Backup            | Varies   | Varies     | /sapmnt, transport directory               |

---

## 7. CSA-in-a-Box integration points

Once SAP infrastructure is deployed on Azure, CSA-in-a-Box extends the value through data integration:

| Integration             | Configuration                                          | Purpose                                                   |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| VNet peering            | Peer SAP VNet with CSA-in-a-Box data landing zone VNet | Enable private network connectivity for data extraction   |
| Fabric Mirroring        | Private endpoint from Fabric to HANA on sap-db-subnet  | Near-real-time SAP data replication to OneLake            |
| ADF integration runtime | Self-hosted IR in sap-app-subnet                       | Batch extraction from SAP via SAP Table/BW/ODP connectors |
| Azure Monitor           | Azure Monitor for SAP Solutions on SAP VMs             | Unified monitoring across SAP and CSA-in-a-Box workloads  |
| Purview                 | Purview managed VNet scanning of HANA                  | Metadata scanning and classification of SAP data          |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [HANA Migration](hana-migration.md) | [S/4HANA Conversion](s4hana-conversion.md) | [Best Practices](best-practices.md) | [Tutorial: Deploy SAP on Azure](tutorial-sap-azure-deployment.md)
