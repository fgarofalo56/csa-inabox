# Data Migration Strategies -- SQL Server to Azure SQL

**Audience:** DBAs, data engineers, migration architects
**Scope:** Data movement strategies, tools, and execution patterns

---

## Overview

Data migration is the most operationally critical phase of a SQL Server migration. The choice of data migration strategy depends on database size, acceptable downtime, network bandwidth, and the target Azure SQL service. This guide covers all available approaches, from simple backup/restore to zero-downtime online migration.

---

## Migration strategy decision matrix

| Strategy                      | Downtime   | Max DB size     | Complexity | Best for                                        |
| ----------------------------- | ---------- | --------------- | ---------- | ----------------------------------------------- |
| **Azure DMS (online)**        | Minutes    | 10 TB+          | Medium     | Minimal-downtime production migrations          |
| **Azure DMS (offline)**       | Hours      | 10 TB+          | Low        | Non-production or maintenance-window migrations |
| **BACPAC import/export**      | Hours      | 150 GB (portal) | Low        | Small databases, dev/test                       |
| **Transactional replication** | Minutes    | No limit        | High       | Near-zero downtime with selective tables        |
| **Log shipping**              | Minutes    | No limit        | Medium     | SQL on VM target                                |
| **Log Replay Service (LRS)**  | Minutes    | 16 TB           | Medium     | SQL MI target                                   |
| **Managed Instance Link**     | Seconds    | 16 TB           | Medium     | SQL MI target, production DR                    |
| **Backup and restore**        | Hours-days | No limit        | Low        | SQL on VM, offline migration                    |
| **Azure Data Box**            | Days       | 100 TB+         | High       | Very large databases with limited bandwidth     |
| **ADF Copy Activity**         | Hours      | No limit        | Medium     | Table-by-table with transformation              |

---

## Azure Database Migration Service (DMS)

### Online migration (minimal downtime)

Online migration continuously replicates changes from the source until cutover. The database remains operational during migration.

**Prerequisites:**

- Source: SQL Server 2008 or later
- Target: Azure SQL Database, Azure SQL MI, or SQL on VM
- Network connectivity between source and Azure (VPN, ExpressRoute, or public internet)
- Source databases must use full recovery model
- CDC or change tracking must be enabled (for SQL DB target)

```bash
# Step 1: Create DMS instance
az dms create \
  --resource-group migration-rg \
  --name sql-dms \
  --location eastus2 \
  --sku-name Premium_4vCores \
  --subnet /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/virtualNetworks/{vnet}/subnets/dms-subnet

# Step 2: Create migration project
az dms project create \
  --resource-group migration-rg \
  --service-name sql-dms \
  --name aw-migration \
  --source-platform SQL \
  --target-platform SQLMI

# Step 3: Create and start migration task
# (Use Azure portal or REST API for full task configuration)
```

**Online migration workflow:**

1. DMS takes an initial full backup/snapshot of the source database
2. DMS restores the backup on the target
3. DMS continuously applies transaction log changes (log shipping or CDC)
4. Monitor replication lag until it reaches near-zero
5. Stop writes to the source application
6. Wait for final replication to complete
7. Switch application connection strings to the target
8. Resume application operations

### Offline migration

Offline migration takes a point-in-time snapshot and restores it to the target. The source database is read-only or offline during migration.

```bash
# Offline migration is simpler but requires a maintenance window
# Use when downtime of several hours is acceptable
```

---

## BACPAC import/export

BACPAC files contain both schema and data. Best for databases under 150 GB.

### Export from on-premises

```bash
# Using SqlPackage (recommended for large databases)
SqlPackage /Action:Export \
  /SourceServerName:onprem-server \
  /SourceDatabaseName:AdventureWorks \
  /TargetFile:AdventureWorks.bacpac \
  /p:CommandTimeout=7200

# Verify BACPAC integrity
SqlPackage /Action:Export \
  /SourceServerName:onprem-server \
  /SourceDatabaseName:AdventureWorks \
  /TargetFile:AdventureWorks_verify.bacpac \
  /p:VerifyFullTextDocumentTypesSupported=false
```

### Upload to Azure Blob Storage

```bash
# Upload BACPAC to Azure Blob Storage
az storage blob upload \
  --account-name migrationstore \
  --container-name bacpacs \
  --file AdventureWorks.bacpac \
  --name AdventureWorks.bacpac \
  --type block \
  --tier Hot
```

### Import to Azure SQL Database

```bash
# Import using Azure CLI
az sql db import \
  --resource-group prod-rg \
  --server sql-prod-server \
  --name AdventureWorks \
  --storage-key-type StorageAccessKey \
  --storage-key "$STORAGE_KEY" \
  --storage-uri "https://migrationstore.blob.core.windows.net/bacpacs/AdventureWorks.bacpac" \
  --admin-user sqladmin \
  --admin-password "$SQL_PASSWORD"
```

!!! warning "Performance considerations for BACPAC import" - Run SqlPackage from an Azure VM in the same region as the target for fastest transfer - Use the `/p:CommandTimeout=7200` parameter for large databases - BACPAC import through the Azure portal has a 150 GB limit and may time out for databases over 50 GB - For databases > 150 GB, use SqlPackage directly or switch to DMS

---

## Transactional replication

Transactional replication provides near-real-time data synchronization from on-premises SQL Server to Azure SQL Database or MI.

```sql
-- Step 1: Configure the on-premises server as a distributor
EXEC sp_adddistributor @distributor = N'OnPremServer';
EXEC sp_adddistributiondb @database = N'distribution';

-- Step 2: Create a publication
USE [AdventureWorks];
EXEC sp_addpublication
    @publication = N'AW_AzureReplication',
    @status = N'active',
    @allow_push = N'true',
    @allow_anonymous = N'false';

-- Step 3: Add articles (tables) to the publication
EXEC sp_addarticle
    @publication = N'AW_AzureReplication',
    @article = N'SalesOrderHeader',
    @source_object = N'SalesOrderHeader',
    @source_owner = N'Sales',
    @schema_option = 0x000000000803509F;

-- Step 4: Add Azure SQL as a subscriber
EXEC sp_addsubscription
    @publication = N'AW_AzureReplication',
    @subscriber = N'myserver.database.windows.net',
    @destination_db = N'AdventureWorks',
    @subscription_type = N'Push',
    @sync_type = N'Automatic';

-- Step 5: Start the snapshot agent
EXEC sp_startpublication_snapshot @publication = N'AW_AzureReplication';
```

!!! info "Replication to Azure SQL Database"
Azure SQL Database can be a subscriber but not a publisher. Azure SQL MI can be both a publisher and subscriber. For bidirectional replication during migration, use SQL MI as the target.

---

## Log Replay Service (for SQL MI)

LRS replays log backups from Azure Blob Storage to SQL MI. See the [Azure SQL MI migration guide](azure-sql-mi-migration.md) for detailed LRS instructions.

```bash
# Start LRS in continuous mode
az sql midb log-replay start \
  --resource-group myRG \
  --managed-instance myMI \
  --name AdventureWorks \
  --storage-uri "https://migrationstore.blob.core.windows.net/logbackups" \
  --storage-sas "$SAS_TOKEN" \
  --auto-complete \
  --last-backup-name "AW_log_final.trn"
```

---

## Azure Data Factory (table-by-table migration)

ADF Copy Activity can migrate data table-by-table, with optional transformations during the copy.

```json
{
    "name": "CopyAdventureWorksTable",
    "type": "Copy",
    "inputs": [
        {
            "referenceName": "OnPremSqlServerDataset",
            "type": "DatasetReference"
        }
    ],
    "outputs": [
        {
            "referenceName": "AzureSqlDatabaseDataset",
            "type": "DatasetReference"
        }
    ],
    "typeProperties": {
        "source": {
            "type": "SqlServerSource",
            "sqlReaderQuery": "SELECT * FROM Sales.SalesOrderHeader WHERE ModifiedDate > '2024-01-01'",
            "partitionOption": "DynamicRange",
            "partitionSettings": {
                "partitionColumnName": "SalesOrderID",
                "partitionUpperBound": 75000,
                "partitionLowerBound": 1
            }
        },
        "sink": {
            "type": "AzureSqlSink",
            "writeBatchSize": 10000,
            "preCopyScript": "TRUNCATE TABLE Sales.SalesOrderHeader"
        },
        "enableStaging": true,
        "stagingSettings": {
            "linkedServiceName": {
                "referenceName": "AzureBlobStorage",
                "type": "LinkedServiceReference"
            }
        }
    }
}
```

!!! tip "When to use ADF for migration"
ADF is ideal when you need to transform data during migration (e.g., column mapping, data type changes, filtering). For pure lift-and-shift, DMS is faster and simpler.

---

## Azure Data Box (large database migration)

For databases exceeding 10 TB or environments with limited network bandwidth (< 100 Mbps), Azure Data Box provides offline data transfer:

1. **Order Data Box** from the Azure portal (Data Box or Data Box Heavy depending on capacity)
2. **Back up databases** to the Data Box device using BACKUP TO DISK
3. **Ship the Data Box** to the Azure data center
4. **Data is uploaded** to your Azure Blob Storage account
5. **Restore databases** from Azure Blob Storage to the target

| Data Box model | Usable capacity | Transfer time (local) | Best for |
| -------------- | --------------- | --------------------- | -------- |
| Data Box Disk  | 35 TB           | Hours                 | 1-35 TB  |
| Data Box       | 80 TB           | Hours-day             | 35-80 TB |
| Data Box Heavy | 770 TB          | Hours-days            | 80+ TB   |

---

## SSIS to ADF migration

SSIS packages are a critical part of many SQL Server environments. Two migration paths exist:

### Path 1: Lift-and-shift SSIS to Azure-SSIS IR

Run existing SSIS packages unchanged in the Azure-SSIS Integration Runtime:

```bash
# Create Azure-SSIS IR in ADF
az datafactory integration-runtime self-hosted create \
  --resource-group myRG \
  --factory-name myADF \
  --name AzureSSISIR

# Deploy SSIS packages to SSISDB on Azure SQL DB/MI
# Packages run unchanged in the cloud
```

### Path 2: Modernize SSIS to ADF pipelines

Convert SSIS packages to native ADF pipelines with dbt transformations:

| SSIS component     | ADF equivalent                | CSA-in-a-Box pattern           |
| ------------------ | ----------------------------- | ------------------------------ |
| Data Flow Task     | ADF Data Flow (mapping)       | dbt models for transformations |
| Execute SQL Task   | Stored Procedure Activity     | dbt SQL models                 |
| File System Task   | Azure Blob Storage activities | OneLake operations             |
| Script Task        | Azure Functions activity      | Platform functions             |
| For Each Loop      | ForEach Activity              | ADF orchestration              |
| Sequence Container | Pipeline grouping             | dbt model dependencies         |
| Package execution  | Pipeline trigger              | ADF schedule trigger           |

---

## Data validation after migration

### Row count validation

```sql
-- Source (on-premises)
SELECT 'SalesOrderHeader' AS table_name, COUNT(*) AS row_count
FROM Sales.SalesOrderHeader
UNION ALL
SELECT 'SalesOrderDetail', COUNT(*)
FROM Sales.SalesOrderDetail
UNION ALL
SELECT 'Customer', COUNT(*)
FROM Sales.Customer;

-- Run the same query on the target and compare
```

### Checksum validation

```sql
-- Generate checksum for critical tables
SELECT CHECKSUM_AGG(BINARY_CHECKSUM(*)) AS table_checksum
FROM Sales.SalesOrderHeader;

-- Compare source and target checksums
```

### Application-level validation

```sql
-- Run key business queries and compare results
-- Example: Total sales by year
SELECT YEAR(OrderDate) AS order_year,
       SUM(TotalDue) AS total_sales,
       COUNT(*) AS order_count
FROM Sales.SalesOrderHeader
GROUP BY YEAR(OrderDate)
ORDER BY order_year;
```

---

## Related

- [Schema Migration](schema-migration.md)
- [Azure SQL DB Migration](azure-sql-db-migration.md)
- [Azure SQL MI Migration](azure-sql-mi-migration.md)
- [SQL on VM Migration](sql-on-vm-migration.md)
- [Tutorial: DMS Migration](tutorial-dms-migration.md)
- [Tutorial: Azure Data Studio](tutorial-azure-data-studio.md)

---

## References

- [Azure Database Migration Service](https://learn.microsoft.com/azure/dms/)
- [BACPAC import and export](https://learn.microsoft.com/azure/azure-sql/database/database-import)
- [Transactional replication to Azure SQL](https://learn.microsoft.com/azure/azure-sql/database/replication-to-sql-database)
- [Log Replay Service](https://learn.microsoft.com/azure/azure-sql/managed-instance/log-replay-service-migrate)
- [Azure-SSIS Integration Runtime](https://learn.microsoft.com/azure/data-factory/create-azure-ssis-integration-runtime)
- [Azure Data Box](https://learn.microsoft.com/azure/databox/)
- [SqlPackage](https://learn.microsoft.com/sql/tools/sqlpackage/sqlpackage)
