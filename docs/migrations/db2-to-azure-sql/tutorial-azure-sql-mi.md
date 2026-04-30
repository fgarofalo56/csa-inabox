# Tutorial: Db2 LUW to Azure SQL Managed Instance

**Duration:** 6-8 hours
**Prerequisites:** Azure SQL MI provisioned (Business Critical or General Purpose), Db2 LUW 10.5+ source database, network connectivity between source and target, SSMA for Db2 installed
**Outcome:** Complete migration of a Db2 LUW database to Azure SQL MI including stored procedures, batch jobs, and application cutover

---

## Overview

This tutorial covers the end-to-end migration of a Db2 for LUW database to Azure SQL Managed Instance. Azure SQL MI is the recommended target for Db2 LUW workloads because it provides the broadest T-SQL surface area -- including SQL Agent jobs, linked servers, cross-database queries, and CLR -- which maps well to the features commonly used in Db2 LUW environments.

### Why Azure SQL MI for Db2 LUW

| Db2 LUW feature                     | Azure SQL MI capability         | Notes                                           |
| ----------------------------------- | ------------------------------- | ----------------------------------------------- |
| Db2 stored procedures               | T-SQL stored procedures         | SSMA converts; manual work for SQL PL specifics |
| Db2 triggers                        | T-SQL triggers                  | BEFORE triggers require INSTEAD OF refactoring  |
| Scheduled jobs (cron + db2 scripts) | SQL Agent jobs                  | Native scheduling engine on MI                  |
| Federation (nicknames)              | Linked servers                  | Cross-database and cross-instance queries       |
| HADR                                | Built-in zone-redundant HA      | No manual HA configuration needed               |
| db2audit                            | SQL Auditing + Defender for SQL | Built-in audit and threat detection             |
| BACKUP DATABASE                     | Automated backups (35-day PITR) | No manual backup management                     |

---

## Step 1: Provision Azure SQL Managed Instance

### Azure CLI deployment

```bash
# Create resource group
az group create \
    --name rg-db2-migration \
    --location usgovvirginia

# Create VNet and subnet for MI
az network vnet create \
    --resource-group rg-db2-migration \
    --name vnet-db2-migration \
    --address-prefixes 10.0.0.0/16

az network vnet subnet create \
    --resource-group rg-db2-migration \
    --vnet-name vnet-db2-migration \
    --name snet-sqlmi \
    --address-prefixes 10.0.1.0/24 \
    --delegations Microsoft.Sql/managedInstances

# Create managed instance (Business Critical, 16 vCores)
az sql mi create \
    --resource-group rg-db2-migration \
    --name sqlmi-db2-migration \
    --location usgovvirginia \
    --admin-user sqladmin \
    --admin-password "$ADMIN_PASSWORD" \
    --subnet "/subscriptions/$SUB_ID/resourceGroups/rg-db2-migration/providers/Microsoft.Network/virtualNetworks/vnet-db2-migration/subnets/snet-sqlmi" \
    --edition BusinessCritical \
    --vcore 16 \
    --storage 512 \
    --license-type BasePrice \
    --backup-storage-redundancy Geo \
    --timezone-id "Eastern Standard Time"
```

**Provisioning time:** Azure SQL MI takes 4-6 hours to provision for new deployments. Plan accordingly.

### Configure networking

Ensure connectivity between the Db2 source and Azure SQL MI:

1. **ExpressRoute** (recommended for production): Establish a private connection from the data center hosting Db2 to Azure.
2. **Site-to-Site VPN** (acceptable for dev/test): Create a VPN gateway in the MI VNet.
3. **Verify connectivity:** From the migration workstation, test connectivity to both Db2 (port 50000) and Azure SQL MI (port 1433).

```bash
# Test connectivity to Azure SQL MI
sqlcmd -S sqlmi-db2-migration.database.usgovcloudapi.net \
    -U sqladmin -P "$ADMIN_PASSWORD" \
    -Q "SELECT @@VERSION"
```

---

## Step 2: Assess the source database

### Gather database inventory

Connect to the Db2 source and inventory the database objects:

```sql
-- Db2: count objects by type
SELECT
    TYPE AS object_type,
    COUNT(*) AS object_count
FROM SYSCAT.ROUTINES
WHERE ROUTINESCHEMA NOT LIKE 'SYS%'
GROUP BY TYPE
UNION ALL
SELECT
    'TABLE' AS object_type,
    COUNT(*) AS object_count
FROM SYSCAT.TABLES
WHERE TABSCHEMA NOT LIKE 'SYS%' AND TYPE = 'T'
UNION ALL
SELECT
    'VIEW' AS object_type,
    COUNT(*) AS object_count
FROM SYSCAT.TABLES
WHERE TABSCHEMA NOT LIKE 'SYS%' AND TYPE = 'V'
UNION ALL
SELECT
    'INDEX' AS object_type,
    COUNT(*) AS object_count
FROM SYSCAT.INDEXES
WHERE INDSCHEMA NOT LIKE 'SYS%'
UNION ALL
SELECT
    'TRIGGER' AS object_type,
    COUNT(*) AS object_count
FROM SYSCAT.TRIGGERS
WHERE TRIGSCHEMA NOT LIKE 'SYS%'
UNION ALL
SELECT
    'SEQUENCE' AS object_type,
    COUNT(*) AS object_count
FROM SYSCAT.SEQUENCES
WHERE SEQSCHEMA NOT LIKE 'SYS%';
```

### Measure database size

```sql
-- Db2: get database and table sizes
SELECT
    TABSCHEMA,
    TABNAME,
    CARD AS row_count,
    (DATA_OBJECT_P_SIZE + INDEX_OBJECT_P_SIZE) / 1024 AS size_mb
FROM SYSCAT.TABLES
WHERE TYPE = 'T' AND TABSCHEMA NOT LIKE 'SYS%'
ORDER BY size_mb DESC;
```

### Identify Db2-specific features in use

```sql
-- Check for MQTs (Materialized Query Tables)
SELECT TABSCHEMA, TABNAME, REFRESH
FROM SYSCAT.TABLES
WHERE TYPE = 'S';  -- S = materialized query table

-- Check for BEFORE triggers
SELECT TRIGSCHEMA, TRIGNAME, TABNAME, TRIGTIME
FROM SYSCAT.TRIGGERS
WHERE TRIGTIME = 'B';  -- B = BEFORE

-- Check for DECFLOAT columns
SELECT TABSCHEMA, TABNAME, COLNAME, TYPENAME
FROM SYSCAT.COLUMNS
WHERE TYPENAME = 'DECFLOAT';

-- Check for GRAPHIC/DBCLOB columns
SELECT TABSCHEMA, TABNAME, COLNAME, TYPENAME
FROM SYSCAT.COLUMNS
WHERE TYPENAME IN ('GRAPHIC', 'VARGRAPHIC', 'DBCLOB');
```

---

## Step 3: Run SSMA assessment

Follow the SSMA assessment steps from [Tutorial: SSMA Migration](tutorial-ssma-migration.md), Steps 2-5. The assessment report will identify:

- Objects that convert automatically
- Objects requiring manual remediation
- Features not supported on the target

For Azure SQL MI targets, expect a higher conversion rate than Azure SQL Database because MI supports SQL Agent, linked servers, CLR, and cross-database queries.

---

## Step 4: Convert and deploy schema

1. Run SSMA schema conversion for all database objects.
2. Review conversion warnings and errors.
3. Apply manual fixes for:
    - BEFORE triggers (convert to INSTEAD OF)
    - SQL PL condition handlers (convert to TRY/CATCH)
    - DECFLOAT columns (map to DECIMAL)
    - MQTs (convert to indexed views or scheduled refresh views)
4. Synchronize the converted schema to Azure SQL MI.

### Post-deployment schema validation

```sql
-- Azure SQL MI: verify object counts match assessment
SELECT
    type_desc AS object_type,
    COUNT(*) AS object_count
FROM sys.objects
WHERE schema_id NOT IN (
    SELECT schema_id FROM sys.schemas
    WHERE name IN ('sys', 'INFORMATION_SCHEMA', 'ssma_db2')
)
AND type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'TR', 'SQ')
GROUP BY type_desc
ORDER BY type_desc;
```

---

## Step 5: Migrate data

### Small tables (< 10 GB each): Use SSMA

Use SSMA's integrated data migration for tables under 10 GB.

### Large tables (> 10 GB): Use ADF

For large tables, set up an ADF pipeline with the Db2 connector:

```bash
# Create ADF instance
az datafactory create \
    --resource-group rg-db2-migration \
    --name adf-db2-migration \
    --location usgovvirginia
```

Configure the ADF pipeline as described in [Data Migration](data-migration.md) Section 3.

### Monitor data migration progress

```sql
-- Azure SQL MI: monitor row counts during migration
SELECT
    SCHEMA_NAME(t.schema_id) + '.' + t.name AS table_name,
    SUM(p.rows) AS current_rows
FROM sys.tables t
JOIN sys.partitions p ON t.object_id = p.object_id
WHERE p.index_id IN (0, 1)
GROUP BY t.schema_id, t.name
HAVING SUM(p.rows) > 0
ORDER BY current_rows DESC;
```

---

## Step 6: Migrate batch jobs to SQL Agent

### Inventory Db2 batch jobs

List all scheduled jobs on the Db2 LUW server:

```bash
# List cron jobs that reference db2
crontab -l | grep -i db2

# Common patterns:
# 0 2 * * * /opt/batch/daily_interest.sh
# 0 6 * * 1 /opt/batch/weekly_report.sh
# 30 23 * * * /opt/batch/nightly_cleanup.sh
```

### Create equivalent SQL Agent jobs

```sql
-- Example: migrate daily interest calculation job
-- Step 1: Create the job
EXEC msdb.dbo.sp_add_job
    @job_name = N'Daily_Interest_Calculation',
    @description = N'Migrated from Db2 LUW cron: /opt/batch/daily_interest.sh',
    @owner_login_name = N'sqladmin';

-- Step 2: Add the job step
EXEC msdb.dbo.sp_add_jobstep
    @job_name = N'Daily_Interest_Calculation',
    @step_name = N'Calculate daily interest',
    @subsystem = N'TSQL',
    @command = N'
        BEGIN TRY
            EXEC dbo.sp_calculate_daily_interest @process_date = NULL;
            -- NULL defaults to today

            -- Log success
            INSERT INTO dbo.batch_job_log (job_name, status, completed_at)
            VALUES (''Daily_Interest_Calculation'', ''SUCCESS'', SYSDATETIME());
        END TRY
        BEGIN CATCH
            INSERT INTO dbo.batch_job_log (job_name, status, error_message, completed_at)
            VALUES (''Daily_Interest_Calculation'', ''FAILED'', ERROR_MESSAGE(), SYSDATETIME());
            THROW;
        END CATCH;
    ',
    @database_name = N'FinanceDB',
    @retry_attempts = 2,
    @retry_interval = 5;

-- Step 3: Create the schedule (daily at 2:00 AM)
EXEC msdb.dbo.sp_add_schedule
    @schedule_name = N'Daily_0200_EST',
    @freq_type = 4,        -- daily
    @freq_interval = 1,    -- every day
    @active_start_time = 020000;  -- 2:00 AM

-- Step 4: Attach schedule to job
EXEC msdb.dbo.sp_attach_schedule
    @job_name = N'Daily_Interest_Calculation',
    @schedule_name = N'Daily_0200_EST';

-- Step 5: Enable the job
EXEC msdb.dbo.sp_update_job
    @job_name = N'Daily_Interest_Calculation',
    @enabled = 1;
```

### Job monitoring

```sql
-- Check recent job execution history
SELECT
    j.name AS job_name,
    h.step_name,
    h.run_status,  -- 0=Failed, 1=Succeeded, 2=Retry, 3=Canceled
    h.run_date,
    h.run_time,
    h.run_duration,
    h.message
FROM msdb.dbo.sysjobs j
JOIN msdb.dbo.sysjobhistory h ON j.job_id = h.job_id
WHERE h.step_id = 0  -- job outcome
ORDER BY h.run_date DESC, h.run_time DESC;
```

---

## Step 7: Configure linked servers (if needed)

If the Db2 database used federation (nicknames) to access other data sources, configure linked servers on Azure SQL MI:

```sql
-- Create linked server to another SQL Server instance
EXEC sp_addlinkedserver
    @server = N'REPORTING_SERVER',
    @srvproduct = N'',
    @provider = N'SQLNCLI',
    @datasrc = N'reporting-server.database.usgovcloudapi.net';

EXEC sp_addlinkedsrvlogin
    @rmtsrvname = N'REPORTING_SERVER',
    @useself = N'FALSE',
    @locallogin = NULL,
    @rmtuser = N'readonly_user',
    @rmtpassword = N'password';

-- Test linked server
SELECT TOP 10 * FROM REPORTING_SERVER.ReportingDB.dbo.summary_table;
```

---

## Step 8: Set up Fabric Mirroring

Connect the migrated Azure SQL MI database to Microsoft Fabric for analytics integration:

1. Open Microsoft Fabric portal.
2. Navigate to your workspace.
3. Click **New > Mirrored Azure SQL Database**.
4. Enter the Azure SQL MI connection details.
5. Select the tables to mirror.
6. Fabric creates Delta tables in OneLake that are updated in near-real-time.

Once mirrored, the data is available for:

- Power BI Direct Lake reports
- Fabric notebooks (Spark)
- Fabric data pipelines
- Purview governance scanning

---

## Step 9: Application cutover

### Update connection strings

Update all applications from Db2 to Azure SQL MI connections:

```properties
# Before (Db2)
db.url=jdbc:db2://db2server:50000/FINANCEDB
db.driver=com.ibm.db2.jcc.DB2Driver
db.user=db2admin

# After (Azure SQL MI)
db.url=jdbc:sqlserver://sqlmi-db2-migration.database.usgovcloudapi.net:1433;database=FinanceDB;encrypt=true
db.driver=com.microsoft.sqlserver.jdbc.SQLServerDriver
db.user=sqladmin
```

### Dual-run validation

Run both Db2 and Azure SQL MI in parallel for 2-4 weeks:

1. Application writes to Azure SQL MI (primary).
2. ADF pipeline replicates writes back to Db2 (secondary, for rollback).
3. Compare transaction outputs daily.
4. After 2 weeks of matching results, decommission the Db2 write path.

---

## Step 10: Post-migration optimization

### Update statistics

```sql
-- Update all statistics after migration
EXEC sp_updatestats;
```

### Optimize indexes

```sql
-- Identify missing indexes recommended by SQL Server
SELECT
    mig.index_group_handle,
    mid.statement AS table_name,
    mid.equality_columns,
    mid.inequality_columns,
    mid.included_columns,
    migs.avg_user_impact AS avg_improvement_percent,
    migs.user_seeks + migs.user_scans AS total_queries
FROM sys.dm_db_missing_index_groups mig
JOIN sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle = migs.group_handle
JOIN sys.dm_db_missing_index_details mid ON mig.index_handle = mid.index_handle
WHERE migs.avg_user_impact > 50
ORDER BY migs.avg_user_impact DESC;
```

### Enable Intelligent Insights

Azure SQL MI's Intelligent Insights uses AI to detect performance issues and recommend tuning actions:

```sql
-- Verify Query Store is enabled
SELECT actual_state_desc, desired_state_desc
FROM sys.database_query_store_options;

-- Enable if not already
ALTER DATABASE FinanceDB SET QUERY_STORE = ON;
```

### Configure alerts

```bash
# Set up alerts for key metrics
az monitor metrics alert create \
    --resource-group rg-db2-migration \
    --name "High CPU Alert" \
    --scopes "/subscriptions/$SUB_ID/resourceGroups/rg-db2-migration/providers/Microsoft.Sql/managedInstances/sqlmi-db2-migration" \
    --condition "avg cpu_percent > 80" \
    --window-size 5m \
    --evaluation-frequency 1m \
    --action "/subscriptions/$SUB_ID/resourceGroups/rg-db2-migration/providers/Microsoft.Insights/actionGroups/db2-migration-alerts"
```

---

## Migration completion checklist

- [ ] All tables migrated with matching row counts
- [ ] All stored procedures converted and tested
- [ ] All triggers converted (BEFORE to INSTEAD OF) and tested
- [ ] All batch jobs migrated to SQL Agent
- [ ] Linked servers configured for cross-database access
- [ ] Application connection strings updated
- [ ] Dual-run validation completed (2+ weeks)
- [ ] Fabric Mirroring configured for analytics
- [ ] Purview scanning enabled
- [ ] Performance baseline established (Query Store)
- [ ] Monitoring and alerts configured
- [ ] Rollback procedure documented and tested
- [ ] Db2 LUW instance marked for decommission

---

## Related resources

- [Tutorial: SSMA Migration](tutorial-ssma-migration.md) -- detailed SSMA walkthrough
- [Stored Procedure Migration](stored-proc-migration.md) -- SQL PL to T-SQL conversion
- [Data Migration](data-migration.md) -- ADF and BCP for large tables
- [Best Practices](best-practices.md) -- validation methodology

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
