# Storage Migration -- vSAN to Azure Storage

**Complete guide to migrating VMware vSAN and VMFS storage to Azure-native storage services including Managed Disks, Azure NetApp Files, Azure Elastic SAN, and Azure Files.**

---

## vSAN to Azure storage mapping

| vSAN / VMware concept           | Azure equivalent                           | Service                                   |
| ------------------------------- | ------------------------------------------ | ----------------------------------------- |
| **vSAN datastore**              | Azure Managed Disks                        | Per-VM block storage                      |
| **vSAN storage policies**       | Managed Disk SKU selection                 | Performance tier selection                |
| **VMDK (thick provisioned)**    | Premium SSD v2 / Premium SSD               | Predictable performance                   |
| **VMDK (thin provisioned)**     | Standard SSD / Standard HDD                | Cost-optimized                            |
| **vSAN deduplication**          | Not needed (per-VM disks, no shared pool)  | Azure handles storage efficiency          |
| **vSAN compression**            | Implicit in Managed Disk pricing           | No additional configuration               |
| **vSAN encryption**             | Azure Server-Side Encryption (SSE)         | Platform-managed or customer-managed keys |
| **vSAN stretched cluster**      | Azure Availability Zones + ZRS disks       | Cross-zone resilience                     |
| **VMFS datastore (SAN-backed)** | Azure Managed Disks / Azure Elastic SAN    | Block storage                             |
| **NFS datastore**               | Azure NetApp Files / Azure Files (NFS)     | File-based storage                        |
| **iSCSI datastore**             | Azure Elastic SAN                          | Block storage over iSCSI                  |
| **Content Library (ISO/OVA)**   | Azure Blob Storage / Azure Compute Gallery | Template and image storage                |
| **vSAN File Services**          | Azure Files (SMB/NFS)                      | Managed file shares                       |
| **RDM (Raw Device Mapping)**    | Ultra Disk / Premium SSD v2                | Direct disk attachment                    |

---

## Azure Managed Disk types

| Disk type          | Max IOPS | Max throughput | Max size  | Best for                                        |
| ------------------ | -------- | -------------- | --------- | ----------------------------------------------- |
| **Ultra Disk**     | 160,000  | 4,000 MB/s     | 65,536 GB | SAP HANA, top-tier databases, transaction-heavy |
| **Premium SSD v2** | 80,000   | 1,200 MB/s     | 65,536 GB | Production databases, high-performance apps     |
| **Premium SSD**    | 20,000   | 900 MB/s       | 32,767 GB | Production workloads, steady performance        |
| **Standard SSD**   | 6,000    | 750 MB/s       | 32,767 GB | Web servers, dev/test, light production         |
| **Standard HDD**   | 2,000    | 500 MB/s       | 32,767 GB | Backup, archive, infrequent access              |

### vSAN storage policy to Azure Managed Disk mapping

| vSAN policy attribute                | Azure equivalent                            | How to map                                  |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------- |
| **FTT=1 RAID-1 (mirror)**            | LRS (Locally Redundant Storage)             | Default for Managed Disks                   |
| **FTT=2 RAID-1 (triple mirror)**     | ZRS (Zone-Redundant Storage)                | Cross-zone protection                       |
| **FTT=1 RAID-5 (erasure coding)**    | LRS (with lower cost per GB)                | Standard SSD LRS                            |
| **Stripe width**                     | Premium SSD v2 (adjustable IOPS/throughput) | Configure IOPS and throughput independently |
| **Flash read cache reservation**     | Premium SSD (SSD-backed)                    | All Premium/Ultra tiers are SSD             |
| **IOPS limit**                       | Premium SSD v2 provisioned IOPS             | Set IOPS at disk level                      |
| **Object space reservation (thick)** | Premium SSD (fixed provisioning)            | Thick provisioned equivalent                |
| **Object space reservation (thin)**  | Standard SSD (pay for used)                 | Thin provisioned equivalent                 |
| **Encryption**                       | SSE (AES-256)                               | Default on all Managed Disks                |
| **Checksum**                         | Automatic (Azure storage subsystem)         | Built-in data integrity                     |

---

## VMDK to Azure Managed Disk conversion

### Automatic conversion via Azure Migrate

Azure Migrate automatically converts VMDK files to Azure VHD format during agentless replication:

1. Azure Migrate reads VMDK via vSphere APIs (CBT-based)
2. Disk data is replicated to Azure Managed Disk in VHD format
3. On cutover, the Azure VM boots from the converted Managed Disk
4. No manual conversion required

### Manual conversion (offline)

For manual migration scenarios:

```bash
# Export VMDK from VMware
# Use VMware OVF Tool or vCenter export

# Convert VMDK to VHD using qemu-img
qemu-img convert -f vmdk -O vpc source-disk.vmdk target-disk.vhd

# Fix VHD alignment (Azure requires 1 MB alignment)
qemu-img resize target-disk.vhd +1M

# Upload VHD to Azure
az storage blob upload \
  --account-name stgmigrationstagingeus2 \
  --container-name vhds \
  --name target-disk.vhd \
  --file target-disk.vhd \
  --type page

# Create Managed Disk from VHD
az disk create \
  --name disk-migrated-vm01-os \
  --resource-group rg-migrated-vms \
  --location eastus2 \
  --sku Premium_LRS \
  --source https://stgmigrationstagingeus2.blob.core.windows.net/vhds/target-disk.vhd
```

---

## Azure NetApp Files (replacing NFS datastores)

For workloads that use NFS-based storage (NFS datastores on VMware, or application-level NFS shares):

### Deploy Azure NetApp Files

```bash
# Create NetApp account
az netappfiles account create \
  --name anf-prod-eastus2 \
  --resource-group rg-storage \
  --location eastus2

# Create capacity pool
az netappfiles pool create \
  --account-name anf-prod-eastus2 \
  --resource-group rg-storage \
  --location eastus2 \
  --name pool-premium \
  --size 4 \
  --service-level Premium

# Create NFS volume
az netappfiles volume create \
  --account-name anf-prod-eastus2 \
  --resource-group rg-storage \
  --location eastus2 \
  --pool-name pool-premium \
  --name vol-app-data \
  --service-level Premium \
  --vnet vnet-spoke-prod \
  --subnet subnet-anf-delegated \
  --protocol-types NFSv3 \
  --usage-threshold 1024
```

### Azure NetApp Files service levels

| Service level | IOPS per TiB | Throughput per TiB | Best for                              |
| ------------- | ------------ | ------------------ | ------------------------------------- |
| Ultra         | ~12,800      | 128 MiB/s          | Database workloads, SAP               |
| Premium       | ~6,400       | 64 MiB/s           | Production file shares, VDI profiles  |
| Standard      | ~1,600       | 16 MiB/s           | General file shares, home directories |

### ANF for AVS external storage

Azure NetApp Files can serve as an external datastore for AVS, extending vSAN capacity:

```bash
# Attach ANF datastore to AVS (via Azure Portal)
# AVS > Storage > Datastores > Connect Azure NetApp Files
```

This is useful when AVS vSAN capacity is insufficient but you do not want to add more hosts.

---

## Azure Elastic SAN (replacing iSCSI / SAN)

For workloads that use iSCSI or SAN-based storage:

```bash
# Create Elastic SAN
az elastic-san create \
  --name esan-prod-eastus2 \
  --resource-group rg-storage \
  --location eastus2 \
  --base-size-tib 10 \
  --extended-capacity-size-tib 20 \
  --sku Premium_LRS

# Create volume group
az elastic-san volume-group create \
  --elastic-san-name esan-prod-eastus2 \
  --resource-group rg-storage \
  --name vg-database \
  --protocol-type Iscsi \
  --network-acls virtualNetworkRules="[{id:/subscriptions/{sub}/resourceGroups/rg-network/providers/Microsoft.Network/virtualNetworks/vnet-spoke-prod/subnets/subnet-db,action:Allow}]"

# Create volume
az elastic-san volume create \
  --elastic-san-name esan-prod-eastus2 \
  --resource-group rg-storage \
  --volume-group-name vg-database \
  --name vol-sqldata-01 \
  --size-gib 500
```

---

## Azure Files (replacing vSAN File Services / SMB/NFS shares)

### Deploy Azure Files share

```bash
# Create storage account
az storage account create \
  --name stgfileseastus2 \
  --resource-group rg-storage \
  --location eastus2 \
  --sku Premium_LRS \
  --kind FileStorage

# Create SMB share
az storage share-rm create \
  --storage-account stgfileseastus2 \
  --resource-group rg-storage \
  --name share-appdata \
  --quota 1024 \
  --enabled-protocols SMB

# Create NFS share (Premium FileStorage only)
az storage share-rm create \
  --storage-account stgfileseastus2 \
  --resource-group rg-storage \
  --name share-linuxdata \
  --quota 1024 \
  --enabled-protocols NFS
```

### Azure Files vs Azure NetApp Files

| Feature        | Azure Files                              | Azure NetApp Files                   |
| -------------- | ---------------------------------------- | ------------------------------------ |
| Protocol       | SMB 3.x, NFS 4.1                         | NFSv3, NFSv4.1, SMB 3.x              |
| Max IOPS       | 100,000 (Premium)                        | 450,000 (Ultra)                      |
| Latency        | < 2 ms (Premium)                         | < 1 ms (Ultra)                       |
| Max share size | 100 TiB                                  | 100 TiB                              |
| Snapshots      | Yes (200 per share)                      | Yes (255 per volume)                 |
| AD integration | Yes (Entra ID DS or on-prem AD DS)       | Yes (on-prem AD DS)                  |
| Best for       | General file shares, SMB-first workloads | High-performance NFS, databases, SAP |

---

## Storage migration strategy

### Phase 1: Assessment

For each VMware datastore / vSAN policy, determine the Azure storage target:

| VMware storage type         | Azure target                                  | Selection criteria                      |
| --------------------------- | --------------------------------------------- | --------------------------------------- |
| vSAN (VM workloads)         | Managed Disks (Premium SSD v2 or Premium SSD) | Default for all VM migrations           |
| NFS datastore (shared data) | Azure NetApp Files or Azure Files (NFS)       | Based on IOPS and latency requirements  |
| iSCSI / SAN LUNs            | Azure Elastic SAN or Managed Disks            | Based on protocol requirements          |
| SMB shares                  | Azure Files (SMB)                             | Entra ID integration for access control |
| ISO / template library      | Azure Blob Storage / Compute Gallery          | Static content storage                  |

### Phase 2: Data migration

| Method                    | Use case                              | Throughput                       |
| ------------------------- | ------------------------------------- | -------------------------------- |
| Azure Migrate (agentless) | VM disk migration                     | Automatic during VM replication  |
| AzCopy                    | Blob and file share migration         | Up to 10 Gbps                    |
| Azure Data Box            | Large offline data transfer (> 40 TB) | 80 TB per Data Box device        |
| Azure File Sync           | SMB share migration with sync         | Continuous sync during migration |
| robocopy + Azure Files    | Windows file share migration          | Limited by network bandwidth     |

### Phase 3: Validation

After migration, validate storage performance:

```bash
# Check disk IOPS and throughput
az monitor metrics list \
  --resource /subscriptions/{sub}/resourceGroups/rg-migrated-vms/providers/Microsoft.Compute/disks/disk-vm01-os \
  --metric "Composite Disk Read Operations/sec,Composite Disk Write Operations/sec" \
  --interval PT1H
```

---

## CSA-in-a-Box storage patterns

For data workloads migrated via CSA-in-a-Box, storage targets differ from VM storage:

| Data workload            | CSA-in-a-Box storage            | Service                                 |
| ------------------------ | ------------------------------- | --------------------------------------- |
| Data lake (raw/curated)  | ADLS Gen2 with Delta Lake       | OneLake or standalone ADLS Gen2         |
| Data warehouse tables    | Fabric Lakehouse / Warehouse    | OneLake managed storage                 |
| Power BI semantic models | Direct Lake over OneLake        | Zero-copy analytics                     |
| ML training data         | ADLS Gen2 + Azure ML datastores | Databricks DBFS / Unity Catalog volumes |
| ETL staging              | ADLS Gen2 bronze layer          | Medallion architecture                  |

---

## Related

- [AVS Migration Guide](avs-migration.md)
- [Azure IaaS Migration Guide](azure-iaas-migration.md)
- [Networking Migration](networking-migration.md)
- [Feature Mapping](feature-mapping-complete.md)
- [Migration Playbook](../vmware-to-azure.md)

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
