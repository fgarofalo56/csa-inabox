# SQL Server to Azure SQL Managed Instance -- Migration Guide

**Target:** Azure SQL Managed Instance (PaaS, instance-level, near-100% compatibility)
**Best for:** Lift-and-shift of multi-database workloads, applications using SQL Agent, CLR, linked servers, cross-database queries
**Audience:** DBAs, data engineers, cloud architects

---

## When to choose Azure SQL Managed Instance

Azure SQL Managed Instance is the right target when:

- Your application relies on instance-level features: SQL Agent, linked servers, cross-database queries, Service Broker, CLR (SAFE), Database Mail
- You want near-100% compatibility with on-premises SQL Server to minimize application changes
- You are consolidating multiple databases that query each other
- You need a managed service but cannot accept the feature limitations of Azure SQL Database
- You are migrating from SQL Server 2008 or later and want to preserve existing T-SQL code
- You need VNet integration for network isolation

Azure SQL Managed Instance is NOT the right target when:

- You need full OS-level access or third-party software on the server (choose SQL on VM)
- You use FILESTREAM, FileTable, or full CLR with UNSAFE assemblies (choose SQL on VM)
- You need SSRS, SSAS, or SSIS installed on the same instance (choose SQL on VM)
- A single database with simple requirements fits Azure SQL Database better

---

## Key advantages of SQL Managed Instance

| Capability                  | Details                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| **Near-100% compatibility** | ~99% T-SQL surface area; same engine as on-premises SQL Server                      |
| **SQL Agent**               | Full SQL Agent with jobs, schedules, operators, alerts, proxies                     |
| **Cross-database queries**  | Native three-part name queries across databases on the same instance                |
| **CLR**                     | SAFE assemblies supported; EXTERNAL_ACCESS/UNSAFE can be enabled with configuration |
| **Linked servers**          | Full linked server support with OLEDB providers                                     |
| **Service Broker**          | Within-instance messaging supported                                                 |
| **Database Mail**           | Supported for email notifications from T-SQL                                        |
| **VNet integration**        | Deployed inside a VNet subnet for network isolation                                 |
| **Managed Instance Link**   | Live replication link from on-prem AG to MI for migration or hybrid                 |
| **Built-in HA**             | 99.99% SLA with automatic failover                                                  |
| **Auto-failover groups**    | Cross-region DR with automatic failover and single endpoint                         |

---

## Pre-migration assessment

### Run the Azure SQL Migration extension

```powershell
# In Azure Data Studio:
# 1. Connect to on-premises SQL Server
# 2. Right-click server > Manage > Azure SQL Migration
# 3. Select "Azure SQL Managed Instance" as target
# 4. Review assessment results and SKU recommendations
```

### Check for MI-specific blockers

```sql
-- Check for UNSAFE/EXTERNAL_ACCESS CLR assemblies
SELECT name, permission_set_desc
FROM sys.assemblies
WHERE is_user_defined = 1
  AND permission_set_desc IN ('EXTERNAL_ACCESS', 'UNSAFE');

-- Check for FILESTREAM (not supported on MI)
SELECT t.name AS table_name, c.name AS column_name
FROM sys.columns c
JOIN sys.tables t ON c.object_id = t.object_id
WHERE c.is_filestream = 1;

-- Check for features not available on MI
-- Server-level triggers (limited support)
SELECT name, type_desc
FROM sys.server_triggers;

-- Check database size (MI max 16 TB)
SELECT
    DB_NAME() AS database_name,
    SUM(size * 8 / 1024.0 / 1024.0) AS size_tb
FROM sys.database_files;

-- Check number of databases (MI limit: 100)
SELECT COUNT(*) AS database_count
FROM sys.databases
WHERE database_id > 4;  -- Exclude system databases
```

---

## Migration approaches

### Approach 1: Azure Database Migration Service (online -- recommended)

Online migration provides minimal downtime by continuously replicating transaction log backups until cutover.

```bash
# Create DMS instance (requires Premium tier for online migrations)
az dms create \
  --resource-group myRG \
  --name myDMS \
  --location eastus \
  --sku-name Premium_4vCores \
  --subnet /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{vnet}/subnets/{subnet}
```

See the [DMS migration tutorial](tutorial-dms-migration.md) for complete step-by-step instructions.

### Approach 2: Log Replay Service (LRS)

LRS is a free, cloud-native migration service that replays transaction log backups from Azure Blob Storage to SQL MI. It provides finer control than DMS.

```bash
# Step 1: Back up database to Azure Blob Storage
# On-premises SQL Server:
```

```sql
-- Create a credential for Azure Blob Storage
CREATE CREDENTIAL [https://mystorageaccount.blob.core.windows.net/migration]
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
SECRET = '<your-sas-token>';

-- Full backup
BACKUP DATABASE [AdventureWorks]
TO URL = 'https://mystorageaccount.blob.core.windows.net/migration/AdventureWorks_full.bak'
WITH COMPRESSION, STATS = 10;

-- Differential backup
BACKUP DATABASE [AdventureWorks]
TO URL = 'https://mystorageaccount.blob.core.windows.net/migration/AdventureWorks_diff.bak'
WITH DIFFERENTIAL, COMPRESSION, STATS = 10;

-- Transaction log backups (run periodically)
BACKUP LOG [AdventureWorks]
TO URL = 'https://mystorageaccount.blob.core.windows.net/migration/AdventureWorks_log_001.trn'
WITH COMPRESSION, STATS = 10;
```

```bash
# Step 2: Start Log Replay Service
az sql midb log-replay start \
  --resource-group myRG \
  --managed-instance myMI \
  --name AdventureWorks \
  --storage-uri "https://mystorageaccount.blob.core.windows.net/migration" \
  --storage-sas "<sas-token>" \
  --auto-complete \
  --last-backup-name "AdventureWorks_log_final.trn"

# Step 3: Monitor progress
az sql midb log-replay show \
  --resource-group myRG \
  --managed-instance myMI \
  --name AdventureWorks

# Step 4: Complete migration (if not using auto-complete)
az sql midb log-replay complete \
  --resource-group myRG \
  --managed-instance myMI \
  --name AdventureWorks \
  --last-backup-name "AdventureWorks_log_final.trn"
```

### Approach 3: Managed Instance Link (hybrid / migration)

The Managed Instance Link creates a near-real-time replication link between an on-premises Always On Availability Group and SQL MI. It supports both one-way and bidirectional replication.

```sql
-- Prerequisites:
-- 1. On-premises SQL Server 2016 SP3+ or SQL Server 2019 CU17+
-- 2. Always On AG configured on-premises
-- 3. Network connectivity between on-prem and MI VNet

-- Step 1: Create the MI link endpoint (on MI)
-- This is configured through SSMS or Azure portal

-- Step 2: On-premises, add MI as a replica
-- Configured through the Managed Instance Link wizard in SSMS 19+
```

!!! tip "MI Link for zero-downtime migration"
The Managed Instance Link is the best option for large databases requiring zero downtime. The link maintains a synchronized replica on MI that can be promoted to primary with a single failover operation. After cutover, the link can be broken to complete migration.

### Approach 4: Native backup and restore

For offline migrations with acceptable downtime windows:

```sql
-- On SQL MI, restore from Azure Blob Storage
RESTORE DATABASE [AdventureWorks]
FROM URL = 'https://mystorageaccount.blob.core.windows.net/migration/AdventureWorks_full.bak'
WITH REPLACE;
```

---

## Network configuration

SQL Managed Instance is deployed inside a dedicated VNet subnet. Networking must be configured before migration.

### VNet requirements

```bicep
// Bicep: Create VNet with MI subnet
resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: 'mi-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.0.0.0/16']
    }
    subnets: [
      {
        name: 'mi-subnet'
        properties: {
          addressPrefix: '10.0.0.0/24'
          delegations: [
            {
              name: 'managedInstanceDelegation'
              properties: {
                serviceName: 'Microsoft.Sql/managedInstances'
              }
            }
          ]
          networkSecurityGroup: {
            id: nsg.id
          }
          routeTable: {
            id: routeTable.id
          }
        }
      }
    ]
  }
}
```

### Connectivity options

| Scenario                   | Solution                                         |
| -------------------------- | ------------------------------------------------ |
| On-prem to MI (migration)  | Site-to-site VPN or ExpressRoute                 |
| Application in Azure to MI | VNet peering or same VNet                        |
| Application on-prem to MI  | VPN/ExpressRoute + private endpoint              |
| Public internet access     | Public endpoint (not recommended for production) |

---

## SQL Agent job migration

SQL Agent jobs migrate directly to MI. Verify after migration:

```sql
-- List all jobs and their schedules
SELECT j.name AS job_name,
       j.enabled,
       s.name AS schedule_name,
       s.freq_type,
       s.active_start_time
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.sysjobschedules js ON j.job_id = js.job_id
LEFT JOIN msdb.dbo.sysschedules s ON js.schedule_id = s.schedule_id
ORDER BY j.name;

-- Check for jobs referencing external resources
SELECT j.name, js.step_name, js.command
FROM msdb.dbo.sysjobs j
JOIN msdb.dbo.sysjobsteps js ON j.job_id = js.job_id
WHERE js.command LIKE '%linked_server%'
   OR js.command LIKE '%\\%'   -- UNC paths
   OR js.command LIKE '%xp_cmdshell%';
```

!!! warning "Job step paths"
SQL Agent job steps that reference local file system paths (UNC shares, local drives) must be updated to use Azure Blob Storage URLs or removed. MI does not have access to on-premises file shares.

---

## Post-migration validation

```sql
-- Verify all databases restored
SELECT name, state_desc, compatibility_level
FROM sys.databases
WHERE database_id > 4;

-- Verify cross-database queries work
USE [Database1];
SELECT * FROM [Database2].dbo.SomeTable;

-- Verify SQL Agent jobs
SELECT name, enabled, date_created
FROM msdb.dbo.sysjobs;

-- Verify linked servers
SELECT name, provider, data_source
FROM sys.servers
WHERE is_linked = 1;

-- Check for any errors in SQL error log
EXEC sp_readerrorlog 0, 1, N'Error';
```

---

## CSA-in-a-Box integration

1. **Register MI in Purview:** Add the managed instance as a data source in Microsoft Purview for automated scanning and classification
2. **Create ADF pipelines:** Build pipelines from MI databases to OneLake for lakehouse analytics
3. **Configure Fabric mirroring:** Use Fabric mirroring (preview) for near-real-time replication of MI data to OneLake
4. **Deploy dbt models:** Transform MI data through the medallion architecture
5. **Enable monitoring:** Configure Azure Monitor diagnostic settings on the MI

---

## Related

- [Feature Mapping](feature-mapping-complete.md)
- [Data Migration](data-migration.md)
- [Security Migration](security-migration.md)
- [HA/DR Migration](ha-dr-migration.md)
- [Tutorial: DMS Migration](tutorial-dms-migration.md)
- [Azure SQL DB Migration](azure-sql-db-migration.md) (if MI features are not needed)

---

## References

- [Azure SQL Managed Instance overview](https://learn.microsoft.com/azure/azure-sql/managed-instance/sql-managed-instance-paas-overview)
- [Migrate to SQL MI using DMS](https://learn.microsoft.com/azure/dms/tutorial-sql-server-managed-instance-online-ads)
- [Log Replay Service](https://learn.microsoft.com/azure/azure-sql/managed-instance/log-replay-service-migrate)
- [Managed Instance Link](https://learn.microsoft.com/azure/azure-sql/managed-instance/managed-instance-link-feature-overview)
- [MI networking](https://learn.microsoft.com/azure/azure-sql/managed-instance/connectivity-architecture-overview)
- [T-SQL differences from SQL Server](https://learn.microsoft.com/azure/azure-sql/managed-instance/transact-sql-tsql-differences-sql-server)
