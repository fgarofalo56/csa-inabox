# SQL Server to SQL Server on Azure VM -- Migration Guide

**Target:** SQL Server on Azure Virtual Machines (IaaS, full control)
**Best for:** Lift-and-shift, full feature compatibility, third-party software requirements, SSRS/SSAS/SSIS co-location
**Audience:** DBAs, infrastructure engineers, cloud architects

---

## When to choose SQL Server on Azure VM

SQL Server on Azure VM is the right target when:

- You need 100% feature compatibility with zero application changes
- Your workload uses features not available in SQL DB or MI: FILESTREAM, FileTable, full CLR (UNSAFE), distributed transactions, cross-instance Service Broker
- Third-party software runs on the same server as SQL Server (monitoring agents, backup tools, custom services)
- You need co-located SSRS, SSAS, or SSIS on the same machine
- You need full OS-level control for performance tuning, custom drivers, or regulatory requirements
- You are migrating as a short-term step before further modernization to SQL MI or Fabric

SQL Server on Azure VM is NOT the right target when:

- You want to minimize operational overhead (choose SQL DB or MI)
- You want built-in HA without manual configuration (choose SQL DB or MI)
- You want automated patching and backups with zero effort (choose SQL DB or MI)

---

## VM sizing guidelines

### Compute selection

| Workload type         | Recommended VM series     | vCPU range  | Memory        | Notes                             |
| --------------------- | ------------------------- | ----------- | ------------- | --------------------------------- |
| General OLTP          | E-series (Eds_v5, Eas_v5) | 4-32 vCPU   | 32-256 GB     | Memory-optimized for SQL Server   |
| High-performance OLTP | M-series                  | 32-128 vCPU | 256 GB - 4 TB | For large in-memory workloads     |
| Data warehouse        | E-series or M-series      | 16-64 vCPU  | 128-512 GB    | Column store benefits from memory |
| Dev/Test              | D-series (Ds_v5)          | 2-8 vCPU    | 8-32 GB       | General purpose, lower cost       |
| Small production      | E4ds_v5                   | 4 vCPU      | 32 GB         | Entry-level production            |

```bash
# List available VM sizes for SQL Server
az vm list-sizes --location eastus \
  --query "[?starts_with(name, 'Standard_E')].{Name:name, vCPUs:numberOfCores, Memory:memoryInMb}" \
  --output table
```

### Storage best practices

SQL Server on Azure VM performance is heavily dependent on storage configuration:

| Storage layer              | Recommended disk                    | Configuration                        | Purpose                        |
| -------------------------- | ----------------------------------- | ------------------------------------ | ------------------------------ |
| **Data files (.mdf/.ndf)** | Premium SSD v2 or Ultra Disk        | RAID 0 stripe, 64 KB allocation unit | Highest IOPS and throughput    |
| **Log files (.ldf)**       | Premium SSD v2 or Ultra Disk        | Separate disk, 64 KB allocation unit | Low latency writes             |
| **TempDB**                 | Local SSD (temp disk) or Ultra Disk | D: drive or separate managed disk    | High IOPS, ephemeral OK        |
| **Backup**                 | Standard SSD or Blob Storage        | Separate disk or backup to URL       | Cost-effective, large capacity |

```powershell
# Best practice: Format data disks with 64 KB allocation unit
# PowerShell on the VM:
$disk = Get-Disk | Where-Object PartitionStyle -eq 'Raw'
$disk | Initialize-Disk -PartitionStyle GPT
$disk | New-Partition -UseMaximumSize -DriveLetter F
Format-Volume -DriveLetter F -FileSystem NTFS -AllocationUnitSize 65536 -NewFileSystemLabel "SQLData"
```

!!! warning "Critical: Do NOT use the OS disk for SQL Server data files"
The OS disk (C:) has caching enabled by default and is not sized for database workloads. Always use separate managed disks for data, log, and TempDB files.

### Storage performance tiers

| Disk type             | Max IOPS      | Max throughput | Latency | Best for                  |
| --------------------- | ------------- | -------------- | ------- | ------------------------- |
| Premium SSD v2        | 80,000        | 1,200 MB/s     | Sub-ms  | Most production workloads |
| Ultra Disk            | 160,000       | 4,000 MB/s     | Sub-ms  | Extreme IOPS requirements |
| Premium SSD (P30-P80) | 20,000-80,000 | 900 MB/s       | 1-2 ms  | Standard production       |
| Standard SSD          | 6,000         | 750 MB/s       | 5-10 ms | Dev/test only             |

---

## Migration approaches

### Approach 1: Backup and restore (simplest)

```sql
-- Step 1: Back up on-premises database to Azure Blob Storage
CREATE CREDENTIAL [https://mystorageaccount.blob.core.windows.net/backups]
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
SECRET = '<sas-token>';

BACKUP DATABASE [AdventureWorks]
TO URL = 'https://mystorageaccount.blob.core.windows.net/backups/AW_full.bak'
WITH COMPRESSION, STATS = 10;

-- Step 2: On Azure VM, restore from Azure Blob Storage
CREATE CREDENTIAL [https://mystorageaccount.blob.core.windows.net/backups]
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
SECRET = '<sas-token>';

RESTORE DATABASE [AdventureWorks]
FROM URL = 'https://mystorageaccount.blob.core.windows.net/backups/AW_full.bak'
WITH MOVE 'AdventureWorks_Data' TO 'F:\SQLData\AdventureWorks.mdf',
     MOVE 'AdventureWorks_Log' TO 'G:\SQLLog\AdventureWorks_log.ldf',
     STATS = 10;
```

### Approach 2: Log shipping (minimal downtime)

1. Restore full backup on Azure VM with NORECOVERY
2. Configure log shipping to continuously apply transaction log backups
3. At cutover, apply final log backup and restore WITH RECOVERY

### Approach 3: Always On AG (near-zero downtime)

1. Extend on-premises AG to include the Azure VM as an asynchronous replica
2. Synchronize data until the replica is current
3. Switch to synchronous mode briefly for zero data loss
4. Failover to the Azure VM replica
5. Remove the on-premises replica from the AG

### Approach 4: Azure Migrate (automated discovery and migration)

Azure Migrate provides automated discovery, assessment, and migration of SQL Server VMs:

```bash
# Register the Azure Migrate project
az migrate project create \
  --resource-group myRG \
  --name myMigrateProject \
  --location eastus

# Deploy the Azure Migrate appliance on-premises
# Follow the Azure Migrate setup wizard
```

### Approach 5: Azure Data Box (for very large databases)

For databases over 10 TB where network transfer would take days:

1. Order Azure Data Box from the Azure portal
2. Back up databases to the Data Box device
3. Ship the Data Box to the Azure data center
4. Data is uploaded to Azure Blob Storage
5. Restore from Blob Storage on the Azure VM

---

## SQL IaaS Agent extension

The SQL IaaS Agent extension is essential for SQL Server on Azure VMs. It provides:

- **Automated patching:** Schedule OS and SQL Server patching windows
- **Automated backup:** Configure backup schedules, retention, and encryption
- **Azure portal integration:** Manage SQL Server from the Azure portal
- **Storage configuration:** Optimize storage layout for SQL Server
- **License management:** Track and apply Azure Hybrid Benefit
- **Defender for SQL:** Enable threat detection and vulnerability assessment

```bash
# Register VM with SQL IaaS Agent extension (full mode)
az sql vm create \
  --resource-group myRG \
  --name mySQLVM \
  --license-type AHUB \
  --sql-mgmt-type Full \
  --location eastus
```

---

## Post-migration optimization

### Configure max degree of parallelism

```sql
-- Set MAXDOP based on VM vCPU count
-- General guideline: min(8, number of vCPUs)
EXEC sp_configure 'max degree of parallelism', 8;
RECONFIGURE;
```

### Configure max server memory

```sql
-- Reserve 4 GB for OS + 1 GB per 4 GB above 16 GB for OS
-- Example: 128 GB VM -> leave ~8 GB for OS
EXEC sp_configure 'max server memory (MB)', 122880;  -- 120 GB
RECONFIGURE;
```

### Enable instant file initialization

```powershell
# Grant the SQL Server service account the
# "Perform volume maintenance tasks" privilege
# via Local Security Policy > User Rights Assignment
```

### Configure TempDB

```sql
-- Create one TempDB data file per vCPU (up to 8)
-- Size each file equally
ALTER DATABASE tempdb
MODIFY FILE (NAME = tempdev, SIZE = 8192MB, FILEGROWTH = 1024MB);

ALTER DATABASE tempdb
ADD FILE (NAME = tempdev2, FILENAME = 'D:\TempDB\tempdev2.ndf', SIZE = 8192MB, FILEGROWTH = 1024MB);
-- Repeat for each additional file
```

---

## Licensing on Azure VMs

### Azure Hybrid Benefit

Apply existing SQL Server licenses with Software Assurance to Azure VMs to eliminate SQL licensing costs:

```bash
# Apply AHB to an existing SQL VM
az sql vm update \
  --resource-group myRG \
  --name mySQLVM \
  --license-type AHUB

# Verify license type
az sql vm show \
  --resource-group myRG \
  --name mySQLVM \
  --query "sqlServerLicenseType"
```

### Free Extended Security Updates

SQL Server 2012, 2014, and 2016 instances migrated to Azure VMs automatically receive free Extended Security Updates. This saves $500-$2,000+ per core per year compared to purchasing ESU for on-premises instances.

### License mobility

SQL Server Enterprise Edition with Software Assurance includes license mobility rights, allowing you to move licenses to Azure without purchasing new ones.

---

## High availability on Azure VMs

### Always On Availability Groups

For production workloads on Azure VMs, configure Always On AG:

1. Deploy two or more VMs in an availability set or across availability zones
2. Configure Windows Server Failover Clustering (WSFC)
3. Create an Always On Availability Group
4. Deploy an Azure internal load balancer for the AG listener

```bash
# Create availability set for SQL VMs
az vm availability-set create \
  --resource-group myRG \
  --name sql-avset \
  --platform-fault-domain-count 2 \
  --platform-update-domain-count 5
```

### Availability Zones

For highest availability, deploy SQL VMs across availability zones:

```bash
# Create SQL VM in zone 1
az vm create \
  --resource-group myRG \
  --name SQLVM1 \
  --zone 1 \
  --image MicrosoftSQLServer:sql2022-ws2022:enterprise-gen2:latest \
  --size Standard_E16ds_v5 \
  --admin-username sqladmin

# Create SQL VM in zone 2
az vm create \
  --resource-group myRG \
  --name SQLVM2 \
  --zone 2 \
  --image MicrosoftSQLServer:sql2022-ws2022:enterprise-gen2:latest \
  --size Standard_E16ds_v5 \
  --admin-username sqladmin
```

---

## Modernization path: VM to SQL MI

SQL Server on Azure VM is often an intermediate step. Plan for eventual modernization:

| Phase                         | Duration    | Action                                                        |
| ----------------------------- | ----------- | ------------------------------------------------------------- |
| Phase 1: Lift-and-shift to VM | Weeks 1-4   | Migrate databases to Azure VM with zero changes               |
| Phase 2: Stabilize on Azure   | Months 1-6  | Optimize performance, apply AHB, enable monitoring            |
| Phase 3: Assess for PaaS      | Month 6     | Run DMA against each database for MI/SQL DB compatibility     |
| Phase 4: Migrate to MI/SQL DB | Months 7-12 | Move compatible databases to managed services                 |
| Phase 5: Decommission VM      | Month 12+   | Move remaining workloads or keep VM for incompatible features |

---

## CSA-in-a-Box integration

1. **Install Self-hosted IR:** Deploy the Azure Data Factory self-hosted integration runtime on the VM or a nearby VM for data movement to OneLake
2. **Register in Purview:** Add the SQL VM as a data source for governance scanning
3. **Create ADF pipelines:** Build pipelines from the SQL VM to the Fabric lakehouse
4. **Plan modernization:** Use SQL on VM as a stepping stone to SQL MI or Fabric for long-term cost optimization

---

## Related

- [Feature Mapping](feature-mapping-complete.md)
- [Data Migration](data-migration.md)
- [HA/DR Migration](ha-dr-migration.md)
- [Benchmarks](benchmarks.md)
- [Azure SQL MI Migration](azure-sql-mi-migration.md) (for modernization path)
- [Best Practices](best-practices.md)

---

## References

- [SQL Server on Azure VMs overview](https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/sql-server-on-azure-vm-iaas-what-is-overview)
- [VM sizing guidelines](https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/performance-guidelines-best-practices-vm-size)
- [Storage best practices](https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/performance-guidelines-best-practices-storage)
- [SQL IaaS Agent extension](https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/sql-server-iaas-agent-extension-automate-management)
- [Azure Hybrid Benefit for SQL on VMs](https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/licensing-model-azure-hybrid-benefit-ahb-change)
- [Checklist: SQL Server on Azure VMs](https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/performance-guidelines-best-practices-checklist)
- [Always On AG on Azure VMs](https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/availability-group-overview)
