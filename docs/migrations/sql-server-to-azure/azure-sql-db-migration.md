# SQL Server to Azure SQL Database -- Migration Guide

**Target:** Azure SQL Database (fully managed PaaS, database-level)
**Best for:** Cloud-native applications, single-database workloads, microservices, new development
**Audience:** DBAs, application developers, cloud architects

---

## When to choose Azure SQL Database

Azure SQL Database is the right target when:

- Your application uses a single database (or a small number of independent databases)
- You want the lowest operational overhead (fully managed, serverless option)
- Your T-SQL code does not rely on instance-level features (SQL Agent, linked servers, CLR, Service Broker)
- You are building new cloud-native applications alongside migrated databases
- You want elastic scaling, including auto-pause for intermittent workloads
- Your database is under 100 TB (Hyperscale tier)

Azure SQL Database is NOT the right target when:

- Your application requires cross-database queries between multiple databases on the same instance
- You use CLR assemblies, linked servers, or Service Broker
- You need SQL Agent for job scheduling (use Elastic Jobs or ADF instead)
- You need near-100% compatibility without application changes (choose SQL MI instead)

---

## Pre-migration assessment

### Step 1: Run Data Migration Assistant (DMA)

DMA identifies compatibility issues, unsupported features, and breaking changes before migration.

```powershell
# Download and install DMA from Microsoft
# https://learn.microsoft.com/sql/dma/dma-overview

# Run assessment via command line
DmaCmd.exe /AssessmentName="AdventureWorks Assessment" `
  /AssessmentDatabases="Server=OnPremServer;Initial Catalog=AdventureWorks;Integrated Security=true" `
  /AssessmentTargetPlatform="AzureSqlDatabase" `
  /AssessmentEvaluateCompatibilityIssues `
  /AssessmentEvaluateFeatureParity `
  /AssessmentOverwriteResult `
  /AssessmentResultJson="C:\Assessments\AdventureWorks.json"
```

### Step 2: Run Azure SQL Migration extension in Azure Data Studio

The Azure SQL Migration extension provides SKU recommendations and migration readiness:

1. Install Azure Data Studio and the Azure SQL Migration extension
2. Connect to your on-premises SQL Server
3. Right-click the server and select **Manage > Azure SQL Migration**
4. Click **Assess and Migrate** to start the assessment wizard
5. Review compatibility issues and SKU recommendations

### Step 3: Review common blockers

Check your database for these Azure SQL Database blockers:

```sql
-- Check for CLR assemblies
SELECT name, permission_set_desc
FROM sys.assemblies
WHERE is_user_defined = 1;

-- Check for cross-database queries
SELECT DISTINCT
    referenced_database_name
FROM sys.sql_expression_dependencies
WHERE referenced_database_name IS NOT NULL
  AND referenced_database_name != DB_NAME();

-- Check for linked servers
SELECT name, provider, data_source
FROM sys.servers
WHERE is_linked = 1;

-- Check for SQL Agent jobs referencing this database
SELECT j.name, js.database_name
FROM msdb.dbo.sysjobs j
JOIN msdb.dbo.sysjobsteps js ON j.job_id = js.job_id
WHERE js.database_name = 'YourDatabase';

-- Check for Service Broker usage
SELECT name, is_broker_enabled
FROM sys.databases
WHERE is_broker_enabled = 1 AND name = DB_NAME();

-- Check for filestream columns
SELECT t.name AS table_name, c.name AS column_name
FROM sys.columns c
JOIN sys.tables t ON c.object_id = t.object_id
WHERE c.is_filestream = 1;

-- Check compatibility level
SELECT name, compatibility_level
FROM sys.databases
WHERE name = DB_NAME();
```

---

## Schema migration

### Option 1: DACPAC (recommended for schema-only)

Export the schema as a DACPAC and deploy to Azure SQL Database:

```bash
# Export DACPAC using SqlPackage
SqlPackage /Action:Extract \
  /SourceServerName:onprem-server \
  /SourceDatabaseName:AdventureWorks \
  /TargetFile:AdventureWorks.dacpac \
  /p:VerifyExtraction=True

# Deploy DACPAC to Azure SQL Database
SqlPackage /Action:Publish \
  /SourceFile:AdventureWorks.dacpac \
  /TargetServerName:myserver.database.windows.net \
  /TargetDatabaseName:AdventureWorks \
  /TargetUser:sqladmin \
  /TargetPassword:$env:SQL_PASSWORD
```

### Option 2: Generate scripts with SSMS

1. Right-click database > **Tasks > Generate Scripts**
2. Select **Schema and Data** or **Schema Only**
3. In **Advanced**, set **Script for target** to **Azure SQL Database**
4. Review and fix compatibility warnings
5. Execute against Azure SQL Database

### Option 3: Azure Data Studio migration extension

The extension handles schema migration as part of the integrated migration workflow.

---

## Data migration

### Option 1: Azure Database Migration Service (DMS) -- online migration

Online migration provides minimal downtime by continuously replicating changes until cutover.

```bash
# Create DMS instance
az dms create \
  --resource-group myRG \
  --name myDMS \
  --location eastus \
  --sku-name Standard_4vCores

# Create migration project
az dms project create \
  --resource-group myRG \
  --service-name myDMS \
  --name AdventureWorksMigration \
  --source-platform SQL \
  --target-platform SQLDB
```

!!! info "DMS online migration to Azure SQL Database"
Online migration to Azure SQL Database uses change tracking or CDC to capture ongoing changes. The source database must have change tracking or CDC enabled. See the [DMS tutorial](tutorial-dms-migration.md) for step-by-step instructions.

### Option 2: BACPAC import (offline, best for small databases)

```bash
# Export BACPAC from on-premises
SqlPackage /Action:Export \
  /SourceServerName:onprem-server \
  /SourceDatabaseName:AdventureWorks \
  /TargetFile:AdventureWorks.bacpac

# Upload to Azure Blob Storage
az storage blob upload \
  --account-name mystorageaccount \
  --container-name migration \
  --file AdventureWorks.bacpac \
  --name AdventureWorks.bacpac

# Import BACPAC into Azure SQL Database
az sql db import \
  --resource-group myRG \
  --server myserver \
  --name AdventureWorks \
  --storage-key-type StorageAccessKey \
  --storage-key $STORAGE_KEY \
  --storage-uri "https://mystorageaccount.blob.core.windows.net/migration/AdventureWorks.bacpac" \
  --admin-user sqladmin \
  --admin-password $SQL_PASSWORD
```

!!! warning "BACPAC size limits"
BACPAC import via the Azure portal is limited to 150 GB. For larger databases, use SqlPackage from an Azure VM in the same region as the target database for faster transfer.

### Option 3: Transactional replication

Configure the on-premises database as a publisher and Azure SQL Database as a subscriber for continuous data synchronization during the migration period.

### Option 4: Azure Data Factory (bulk copy)

Use ADF Copy Activity to move data table-by-table. Supports parallel copy, partitioned reads, and staging through Azure Blob Storage.

---

## Application changes required

### Connection string updates

```csharp
// Before (on-premises)
"Server=onprem-server;Database=AdventureWorks;Integrated Security=True;"

// After (Azure SQL Database with Entra ID)
"Server=myserver.database.windows.net;Database=AdventureWorks;Authentication=Active Directory Default;"

// After (Azure SQL Database with SQL auth)
"Server=tcp:myserver.database.windows.net,1433;Database=AdventureWorks;User ID=sqladmin;Password={password};Encrypt=True;TrustServerCertificate=False;"
```

### Retry logic

Azure SQL Database connections can experience transient failures. All applications must implement retry logic:

```csharp
// .NET SqlConnection retry with Microsoft.Data.SqlClient
var options = new SqlRetryLogicOption()
{
    NumberOfTries = 5,
    DeltaTime = TimeSpan.FromSeconds(1),
    MaxTimeInterval = TimeSpan.FromSeconds(20),
    TransientErrors = new[] { 4060, 40197, 40501, 40613, 49918, 49919, 49920 }
};

var retryLogic = SqlConfigurableRetryFactory.CreateExponentialRetryProvider(options);
connection.RetryLogicProvider = retryLogic;
```

### Features requiring code changes

| Feature used on-prem   | Required change for Azure SQL DB                                        |
| ---------------------- | ----------------------------------------------------------------------- |
| Cross-database queries | Consolidate to single DB, use elastic query, or application-level joins |
| CLR assemblies         | Rewrite in T-SQL or move to Azure Functions                             |
| Linked servers         | Use ADF, REST endpoints, or `sp_invoke_external_rest_endpoint`          |
| SQL Agent jobs         | Migrate to Elastic Jobs, Azure Automation, or ADF triggers              |
| Windows authentication | Switch to Entra ID authentication                                       |
| FILESTREAM             | Move files to Azure Blob Storage                                        |
| Database mail          | Use Azure Logic Apps or Azure Communication Services                    |

---

## Post-migration validation

```sql
-- Verify row counts match source
SELECT t.name AS table_name, p.rows AS row_count
FROM sys.tables t
JOIN sys.partitions p ON t.object_id = p.object_id
WHERE p.index_id IN (0, 1)
ORDER BY t.name;

-- Verify schema objects
SELECT type_desc, COUNT(*) AS object_count
FROM sys.objects
WHERE is_ms_shipped = 0
GROUP BY type_desc
ORDER BY type_desc;

-- Check database compatibility level
SELECT name, compatibility_level
FROM sys.databases
WHERE name = DB_NAME();

-- Verify TDE is enabled
SELECT name, is_encrypted
FROM sys.databases
WHERE name = DB_NAME();

-- Run a representative workload query
SET STATISTICS IO ON;
SET STATISTICS TIME ON;
-- [your critical query here]
```

---

## CSA-in-a-Box integration

After migrating to Azure SQL Database, connect to the CSA-in-a-Box platform:

1. **Register in Purview:** Scan the Azure SQL Database to auto-discover and classify data assets
2. **Create ADF pipeline:** Build a pipeline to mirror data from Azure SQL DB to OneLake (Delta Lake format)
3. **Build dbt models:** Create bronze/silver/gold transformations on the mirrored data
4. **Deploy Power BI:** Connect Power BI to the Fabric semantic model for self-service analytics
5. **Enable Defender:** Turn on Microsoft Defender for SQL for threat detection

---

## Related

- [Feature Mapping](feature-mapping-complete.md)
- [Schema Migration](schema-migration.md)
- [Data Migration](data-migration.md)
- [Security Migration](security-migration.md)
- [Azure SQL MI Migration](azure-sql-mi-migration.md) (if SQL DB is not the right fit)
- [Tutorial: DMS Migration](tutorial-dms-migration.md)

---

## References

- [Azure SQL Database overview](https://learn.microsoft.com/azure/azure-sql/database/sql-database-paas-overview)
- [Migrate SQL Server to Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/migration-guides/database/sql-server-to-sql-database-overview)
- [SqlPackage documentation](https://learn.microsoft.com/sql/tools/sqlpackage/sqlpackage)
- [BACPAC import](https://learn.microsoft.com/azure/azure-sql/database/database-import)
- [Transient fault handling](https://learn.microsoft.com/azure/azure-sql/database/troubleshoot-common-connectivity-issues)
