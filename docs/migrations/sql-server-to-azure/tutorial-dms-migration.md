# Tutorial: Online Migration to Azure SQL MI with DMS

**Duration:** 2-3 hours
**Prerequisites:** On-premises SQL Server 2016+, Azure subscription, VPN or ExpressRoute connectivity
**Target:** Azure SQL Managed Instance
**Migration type:** Online (minimal downtime)

---

## What you will accomplish

In this tutorial, you will:

1. Set up an Azure Database Migration Service (DMS) instance
2. Assess an on-premises SQL Server database for MI compatibility
3. Provision an Azure SQL Managed Instance
4. Configure network connectivity between on-premises and Azure
5. Create a DMS migration project
6. Perform an online migration with continuous replication
7. Execute cutover with minimal downtime
8. Validate the migrated database

---

## Prerequisites

Before starting, ensure you have:

- [ ] On-premises SQL Server 2016 or later with the AdventureWorks sample database
- [ ] SQL Server configured with **Full recovery model**
- [ ] Azure subscription with Contributor access
- [ ] Azure CLI installed (version 2.50+)
- [ ] Network connectivity between on-premises and Azure (VPN or ExpressRoute)
- [ ] SSMS 19+ or Azure Data Studio with SQL Migration extension

---

## Step 1: Assess the source database

### Run assessment with Azure Data Studio

1. Open Azure Data Studio and connect to your on-premises SQL Server
2. Right-click the server connection and select **Manage**
3. Click **Azure SQL Migration** in the management dashboard
4. Click **Assess and Migrate**
5. Select **Azure SQL Managed Instance** as the target
6. Review the assessment report

### Run assessment with DMA (alternative)

```powershell
DmaCmd.exe /AssessmentName="AdventureWorks-MI" `
  /AssessmentDatabases="Server=OnPremServer;Initial Catalog=AdventureWorks;Integrated Security=true" `
  /AssessmentTargetPlatform="AzureSqlManagedInstance" `
  /AssessmentEvaluateCompatibilityIssues `
  /AssessmentEvaluateFeatureParity `
  /AssessmentResultJson="C:\Assessments\aw-mi-assessment.json"
```

!!! info "Assessment output"
The assessment identifies three categories:

    - **Blocking issues:** Must be resolved before migration
    - **Behavior changes:** Features that work differently on MI
    - **Feature parity:** Features not available on MI (informational)

---

## Step 2: Provision Azure SQL Managed Instance

### Create the VNet and MI subnet

```bash
# Create resource group
az group create --name migration-rg --location eastus2

# Create VNet
az network vnet create \
  --resource-group migration-rg \
  --name mi-vnet \
  --address-prefix 10.0.0.0/16 \
  --subnet-name mi-subnet \
  --subnet-prefix 10.0.0.0/24

# Delegate subnet to SQL MI
az network vnet subnet update \
  --resource-group migration-rg \
  --vnet-name mi-vnet \
  --name mi-subnet \
  --delegations Microsoft.Sql/managedInstances

# Create NSG with required rules
az network nsg create \
  --resource-group migration-rg \
  --name mi-nsg

# Associate NSG with subnet
az network vnet subnet update \
  --resource-group migration-rg \
  --vnet-name mi-vnet \
  --name mi-subnet \
  --network-security-group mi-nsg

# Create route table
az network route-table create \
  --resource-group migration-rg \
  --name mi-rt

# Associate route table with subnet
az network vnet subnet update \
  --resource-group migration-rg \
  --vnet-name mi-vnet \
  --name mi-subnet \
  --route-table mi-rt
```

### Create the Managed Instance

```bash
# Create SQL MI (this takes 4-6 hours for initial deployment)
az sql mi create \
  --resource-group migration-rg \
  --name adventureworks-mi \
  --location eastus2 \
  --admin-user miadmin \
  --admin-password "$MI_PASSWORD" \
  --subnet /subscriptions/{sub}/resourceGroups/migration-rg/providers/Microsoft.Network/virtualNetworks/mi-vnet/subnets/mi-subnet \
  --capacity 8 \
  --edition GeneralPurpose \
  --family Gen5 \
  --license-type BasePrice \
  --storage 256 \
  --backup-storage-redundancy Geo \
  --minimal-tls-version 1.2
```

!!! warning "MI provisioning time"
The first SQL Managed Instance in a subnet takes 4-6 hours to provision. Subsequent instances in the same subnet take 1-2 hours. Plan accordingly and start provisioning before the migration window.

---

## Step 3: Set up Azure Database Migration Service

### Create DMS instance

```bash
# Register the DMS resource provider
az provider register --namespace Microsoft.DataMigration

# Create a subnet for DMS
az network vnet subnet create \
  --resource-group migration-rg \
  --vnet-name mi-vnet \
  --name dms-subnet \
  --address-prefix 10.0.1.0/24

# Create DMS instance (Premium tier required for online migration)
az dms create \
  --resource-group migration-rg \
  --name adventureworks-dms \
  --location eastus2 \
  --sku-name Premium_4vCores \
  --subnet /subscriptions/{sub}/resourceGroups/migration-rg/providers/Microsoft.Network/virtualNetworks/mi-vnet/subnets/dms-subnet
```

---

## Step 4: Prepare the source database

### Ensure full recovery model

```sql
-- Verify recovery model
SELECT name, recovery_model_desc
FROM sys.databases
WHERE name = 'AdventureWorks';

-- Set to full recovery model if needed
ALTER DATABASE [AdventureWorks] SET RECOVERY FULL;

-- Take a full backup (required to start log chain)
BACKUP DATABASE [AdventureWorks]
TO DISK = N'C:\Backups\AdventureWorks_full.bak'
WITH INIT, COMPRESSION;
```

### Create a backup storage account

```bash
# Create storage account for backups
az storage account create \
  --resource-group migration-rg \
  --name migrationbackups$(date +%s) \
  --location eastus2 \
  --sku Standard_LRS

# Create container
az storage container create \
  --account-name migrationbackups \
  --name aw-backups

# Get SAS token (valid for 7 days)
az storage container generate-sas \
  --account-name migrationbackups \
  --name aw-backups \
  --permissions rwdl \
  --expiry $(date -d '+7 days' +%Y-%m-%dT%H:%MZ) \
  --output tsv
```

### Back up to Azure Blob Storage

```sql
-- Create credential on source SQL Server
CREATE CREDENTIAL [https://migrationbackups.blob.core.windows.net/aw-backups]
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
SECRET = '<sas-token-from-previous-step>';

-- Full backup to Azure Blob
BACKUP DATABASE [AdventureWorks]
TO URL = 'https://migrationbackups.blob.core.windows.net/aw-backups/AW_full.bak'
WITH COMPRESSION, STATS = 10;

-- Transaction log backup
BACKUP LOG [AdventureWorks]
TO URL = 'https://migrationbackups.blob.core.windows.net/aw-backups/AW_log_001.trn'
WITH COMPRESSION, STATS = 10;
```

---

## Step 5: Create and start the migration

### Using Azure Data Studio (recommended)

1. In Azure Data Studio, open the Azure SQL Migration wizard
2. Select the AdventureWorks database
3. Choose **Azure SQL Managed Instance** as the target
4. Enter the MI connection details
5. Select **Online migration** mode
6. Configure the Azure Blob Storage backup location
7. Start the migration

### Using Azure CLI (alternative)

```bash
# Create migration using the Azure SQL Migration extension
az datamigration sql-managed-instance create \
  --resource-group migration-rg \
  --managed-instance-name adventureworks-mi \
  --target-db-name AdventureWorks \
  --migration-service /subscriptions/{sub}/resourceGroups/migration-rg/providers/Microsoft.DataMigration/sqlMigrationServices/adventureworks-dms \
  --scope /subscriptions/{sub}/resourceGroups/migration-rg/providers/Microsoft.Sql/managedInstances/adventureworks-mi \
  --source-sql-connection authentication="SqlAuthentication" \
    data-source="onprem-server" \
    user-name="sa" \
    password="$SA_PASSWORD" \
  --source-database-name AdventureWorks \
  --target-db-collation "SQL_Latin1_General_CP1_CI_AS"
```

---

## Step 6: Monitor the migration

```bash
# Check migration status
az datamigration sql-managed-instance show \
  --resource-group migration-rg \
  --managed-instance-name adventureworks-mi \
  --target-db-name AdventureWorks

# Watch for status transitions:
# InProgress -> ReadyForCutover -> Succeeded
```

Monitor these metrics during migration:

- **Backup restore status:** All full and differential backups restored
- **Log backup lag:** Transaction log backups being applied continuously
- **Replication lag:** Time difference between source and target
- **Pending log backups:** Number of log backups waiting to be applied

!!! tip "Reduce cutover time"
Take frequent transaction log backups (every 5 minutes) to minimize the log backups pending at cutover time. The fewer pending log backups, the faster the cutover.

---

## Step 7: Execute cutover

When the migration status shows **ReadyForCutover** and replication lag is minimal:

### Pre-cutover checklist

- [ ] Notify users of upcoming maintenance window
- [ ] Stop application writes to the source database
- [ ] Take a final transaction log backup
- [ ] Wait for all pending log backups to be applied
- [ ] Verify replication lag is zero

### Execute the cutover

```bash
# Perform cutover
az datamigration sql-managed-instance cutover \
  --resource-group migration-rg \
  --managed-instance-name adventureworks-mi \
  --target-db-name AdventureWorks \
  --migration-operation-id "<operation-id>"

# Verify cutover completed
az datamigration sql-managed-instance show \
  --resource-group migration-rg \
  --managed-instance-name adventureworks-mi \
  --target-db-name AdventureWorks \
  --query "properties.migrationStatus"
```

### Post-cutover steps

```sql
-- On the Managed Instance, verify the database
SELECT name, state_desc, compatibility_level, recovery_model_desc
FROM sys.databases
WHERE name = 'AdventureWorks';

-- Verify row counts for critical tables
SELECT
    SCHEMA_NAME(t.schema_id) AS schema_name,
    t.name AS table_name,
    SUM(p.rows) AS row_count
FROM sys.tables t
JOIN sys.partitions p ON t.object_id = p.object_id
WHERE p.index_id IN (0, 1)
GROUP BY SCHEMA_NAME(t.schema_id), t.name
ORDER BY schema_name, table_name;
```

---

## Step 8: Update application connection strings

```
# Old connection string (on-premises)
Server=onprem-server;Database=AdventureWorks;Integrated Security=True;

# New connection string (Azure SQL MI)
Server=adventureworks-mi.abc123.database.windows.net;Database=AdventureWorks;Authentication=Active Directory Default;
```

---

## Step 9: Validate

### Run critical application queries

```sql
-- Run your most important business queries and compare results
-- with the source database

-- Example: Check recent order totals
SELECT TOP 10
    SalesOrderID,
    OrderDate,
    TotalDue
FROM Sales.SalesOrderHeader
ORDER BY OrderDate DESC;
```

### Performance validation

```sql
-- Enable Query Store for performance monitoring
ALTER DATABASE [AdventureWorks] SET QUERY_STORE = ON;

-- Check for plan regressions
SELECT TOP 10
    qt.query_sql_text,
    rs.avg_duration,
    rs.avg_cpu_time,
    rs.avg_logical_io_reads
FROM sys.query_store_query_text qt
JOIN sys.query_store_query q ON qt.query_text_id = q.query_text_id
JOIN sys.query_store_plan p ON q.query_id = p.query_id
JOIN sys.query_store_runtime_stats rs ON p.plan_id = rs.plan_id
ORDER BY rs.avg_duration DESC;
```

---

## Cleanup

```bash
# After successful validation (wait at least 72 hours):

# Remove DMS instance
az dms delete --resource-group migration-rg --name adventureworks-dms

# Remove backup storage (after retention period)
az storage account delete --resource-group migration-rg --name migrationbackups
```

---

## Troubleshooting

| Issue                            | Cause                        | Resolution                              |
| -------------------------------- | ---------------------------- | --------------------------------------- |
| Migration stuck at InProgress    | Backup files not accessible  | Verify SAS token permissions and expiry |
| High replication lag             | Large transactions on source | Increase log backup frequency           |
| Cutover taking too long          | Many pending log backups     | Wait for pending backups to apply       |
| Connection failure to MI         | Network configuration        | Verify VPN/ExpressRoute and NSG rules   |
| Assessment shows blocking issues | Incompatible features        | Address issues per DMA recommendations  |

---

## Related

- [Azure SQL MI Migration Guide](azure-sql-mi-migration.md)
- [Data Migration Strategies](data-migration.md)
- [Schema Migration](schema-migration.md)
- [Tutorial: Azure Data Studio](tutorial-azure-data-studio.md)

---

## References

- [Migrate SQL Server to MI with DMS](https://learn.microsoft.com/azure/dms/tutorial-sql-server-managed-instance-online-ads)
- [Azure Database Migration Service](https://learn.microsoft.com/azure/dms/dms-overview)
- [MI networking prerequisites](https://learn.microsoft.com/azure/azure-sql/managed-instance/connectivity-architecture-overview)
- [Log Replay Service](https://learn.microsoft.com/azure/azure-sql/managed-instance/log-replay-service-migrate)
