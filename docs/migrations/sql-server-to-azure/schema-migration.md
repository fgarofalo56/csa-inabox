# Schema Migration -- SQL Server to Azure SQL

**Audience:** DBAs, data engineers, application developers
**Scope:** Compatibility assessment, schema conversion, deprecated feature remediation

---

## Overview

Schema migration is the first technical step in any SQL Server-to-Azure migration. Before moving data, you must ensure that the database schema -- tables, views, stored procedures, functions, indexes, constraints, and other objects -- is compatible with the target Azure SQL service. The level of effort depends on the source SQL Server version, the target service, and the features used in the schema.

---

## Compatibility levels

Every SQL Server database has a compatibility level that determines which T-SQL features and behaviors are available. When migrating to Azure SQL, set the compatibility level to match the target:

| SQL Server version | Default compat level | Azure SQL DB support            | Azure SQL MI support |
| ------------------ | -------------------- | ------------------------------- | -------------------- |
| SQL Server 2012    | 110                  | Supported (upgrade recommended) | Supported            |
| SQL Server 2014    | 120                  | Supported                       | Supported            |
| SQL Server 2016    | 130                  | Supported                       | Supported            |
| SQL Server 2017    | 140                  | Supported                       | Supported            |
| SQL Server 2019    | 150                  | Supported                       | Supported            |
| SQL Server 2022    | 160                  | Supported                       | Supported            |

```sql
-- Check current compatibility level
SELECT name, compatibility_level
FROM sys.databases
WHERE name = DB_NAME();

-- Upgrade compatibility level after migration
ALTER DATABASE [AdventureWorks] SET COMPATIBILITY_LEVEL = 160;
```

!!! info "Compatibility level upgrade strategy"
Migrate the database at its current compatibility level first, validate application behavior, then upgrade the compatibility level incrementally. Use Query Store to monitor for plan regressions after each level change.

---

## Assessment tools

### Data Migration Assistant (DMA)

DMA is the primary tool for schema compatibility assessment:

```powershell
# Command-line assessment
DmaCmd.exe /AssessmentName="SchemaAssessment" `
  /AssessmentDatabases="Server=OnPremServer;Initial Catalog=AdventureWorks;Integrated Security=true" `
  /AssessmentTargetPlatform="AzureSqlDatabase" `
  /AssessmentEvaluateCompatibilityIssues `
  /AssessmentEvaluateFeatureParity `
  /AssessmentResultJson="C:\Assessments\schema_report.json"
```

DMA reports two categories of issues:

1. **Compatibility issues:** T-SQL syntax or features that will cause errors on the target
2. **Feature parity issues:** Features available on-premises but not on the target (informational)

### Azure SQL Migration extension for Azure Data Studio

The Azure SQL Migration extension provides a more modern assessment experience:

1. Connect to your SQL Server instance in Azure Data Studio
2. Open the Azure SQL Migration wizard
3. Select target type (SQL DB, SQL MI, or SQL on VM)
4. Review the assessment report with issue categorization and remediation guidance
5. Export the report for team review

### Azure Migrate with database assessment

For large estates (50+ instances), Azure Migrate provides estate-wide discovery and assessment:

```bash
# Deploy Azure Migrate appliance
# Runs agentless discovery of all SQL Server instances
# Generates consolidated assessment report with migration readiness
az migrate assessment create \
  --resource-group myRG \
  --project-name myMigrateProject \
  --name SQLAssessment \
  --assessment-type SqlAssessment
```

---

## Deprecated features by SQL Server version

When migrating from older SQL Server versions, these deprecated features must be addressed:

### SQL Server 2012 to Azure SQL

| Deprecated feature             | Status in Azure SQL | Remediation                                   |
| ------------------------------ | ------------------- | --------------------------------------------- |
| `SET ROWCOUNT` in DML triggers | Not supported       | Use TOP clause instead                        |
| `FASTFIRSTROW` query hint      | Removed             | Use `OPTION (FAST n)`                         |
| `DBCC DBREINDEX`               | Deprecated          | Use `ALTER INDEX REBUILD`                     |
| `sp_addtype`                   | Deprecated          | Use `CREATE TYPE`                             |
| `RAISERROR` with string format | Changed syntax      | Use `RAISERROR (N'message', severity, state)` |

### SQL Server 2014/2016 to Azure SQL

| Deprecated feature          | Status in Azure SQL | Remediation                            |
| --------------------------- | ------------------- | -------------------------------------- |
| `sp_trace_*` procedures     | Deprecated          | Use Extended Events                    |
| `sys.trace_*` catalog views | Deprecated          | Use Extended Events DMVs               |
| Database mirroring          | Deprecated          | Use geo-replication or failover groups |
| SQL Server Profiler         | Deprecated          | Use Extended Events                    |
| `BACKUP ... WITH PASSWORD`  | Removed             | Use TDE for encryption at rest         |

### SQL Server 2017/2019 to Azure SQL

| Deprecated feature                | Status in Azure SQL  | Remediation                       |
| --------------------------------- | -------------------- | --------------------------------- |
| `STRING_SPLIT` compat level < 130 | Requires compat 130+ | Upgrade compatibility level       |
| Legacy cardinality estimator      | Default is new CE    | Test with new CE before migration |
| Undocumented system tables        | May not exist        | Use documented DMVs instead       |

---

## Breaking changes

### Azure SQL Database-specific breaking changes

```sql
-- 1. Three-part names (cross-database) are not supported
-- BEFORE:
SELECT * FROM [OtherDB].[dbo].[Table1];
-- AFTER: Use elastic query or application-level joins

-- 2. USE statement is limited to the connected database
-- BEFORE:
USE [OtherDB]; SELECT * FROM dbo.Table1;
-- AFTER: Connect directly to the target database

-- 3. Server-scoped objects are not available
-- No server-level triggers, server-level audit specs, or server logins
-- Use contained database users instead:
CREATE USER [appuser] WITH PASSWORD = 'StrongP@ssw0rd!';

-- 4. KILL command requires a different syntax
-- Use sys.dm_exec_sessions to find sessions, then KILL
SELECT session_id, login_name, status
FROM sys.dm_exec_sessions
WHERE is_user_process = 1;
```

### Schema objects requiring modification

| Object type       | Common issues                                 | Fix                                         |
| ----------------- | --------------------------------------------- | ------------------------------------------- |
| Stored procedures | Reference to system objects, cross-DB queries | Update references, use synonyms             |
| Views             | Cross-database references                     | Consolidate or use elastic query            |
| Triggers          | Server-level DDL triggers                     | Remove or move logic to application layer   |
| Functions         | CLR functions                                 | Rewrite in T-SQL or move to Azure Functions |
| Jobs              | SQL Agent not available (SQL DB)              | Migrate to Elastic Jobs or ADF              |
| Users/logins      | Windows logins                                | Convert to Entra ID or contained users      |
| Certificates      | Server-level certificates                     | Migrate to Azure Key Vault                  |

---

## Schema migration execution

### Step 1: Export schema

```bash
# Using SqlPackage
SqlPackage /Action:Extract \
  /SourceServerName:onprem-server \
  /SourceDatabaseName:AdventureWorks \
  /TargetFile:schema.dacpac \
  /p:ExtractAllTableData=false \
  /p:VerifyExtraction=true
```

### Step 2: Validate schema against target

```bash
# Generate a deployment report without executing
SqlPackage /Action:DeployReport \
  /SourceFile:schema.dacpac \
  /TargetServerName:myserver.database.windows.net \
  /TargetDatabaseName:AdventureWorks \
  /OutputPath:deployment_report.xml
```

### Step 3: Fix compatibility issues

Review the deployment report and fix issues in the DACPAC or in the source database before extracting again.

### Step 4: Deploy schema

```bash
# Deploy DACPAC to target
SqlPackage /Action:Publish \
  /SourceFile:schema.dacpac \
  /TargetServerName:myserver.database.windows.net \
  /TargetDatabaseName:AdventureWorks \
  /p:BlockOnPossibleDataLoss=true
```

### Step 5: Validate schema deployment

```sql
-- Compare object counts
SELECT type_desc, COUNT(*) AS object_count
FROM sys.objects
WHERE is_ms_shipped = 0
GROUP BY type_desc
ORDER BY type_desc;

-- Check for missing objects
-- Compare with source output
```

---

## Automated schema comparison

### Using SqlPackage schema compare

```bash
# Compare source and target schemas
SqlPackage /Action:DriftReport \
  /TargetServerName:myserver.database.windows.net \
  /TargetDatabaseName:AdventureWorks
```

### Using Visual Studio SSDT

1. Create a SQL Server Database Project in Visual Studio
2. Import the on-premises schema
3. Set the target platform to Azure SQL Database or Managed Instance
4. Build the project to identify compatibility errors
5. Fix errors and generate deployment scripts

---

## Collation considerations

Collation mismatches between source and target can cause query failures and sorting issues.

### Default collations

| Platform             | Default collation                 |
| -------------------- | --------------------------------- |
| SQL Server (English) | `SQL_Latin1_General_CP1_CI_AS`    |
| Azure SQL Database   | `SQL_Latin1_General_CP1_CI_AS`    |
| Azure SQL MI         | Configurable at instance creation |
| SQL Server on VM     | Configurable at install           |

```sql
-- Check database collation
SELECT name, collation_name FROM sys.databases;

-- Check column-level collations that differ from database default
SELECT
    t.name AS table_name,
    c.name AS column_name,
    c.collation_name
FROM sys.columns c
JOIN sys.tables t ON c.object_id = t.object_id
WHERE c.collation_name IS NOT NULL
  AND c.collation_name != DATABASEPROPERTYEX(DB_NAME(), 'Collation');
```

!!! warning "Collation mismatch with TempDB"
Azure SQL Database uses `SQL_Latin1_General_CP1_CI_AS` for TempDB regardless of database collation. If your source database uses a different collation, temporary table operations with string comparisons may fail. Add explicit `COLLATE` clauses to affected queries.

---

## Schema migration for specific object types

### Stored procedures with dynamic SQL

Dynamic SQL that references system objects or uses instance-level features may require modification:

```sql
-- Before (references server-level objects):
EXEC sp_executesql N'SELECT * FROM sys.server_principals WHERE type = ''S'''

-- After (for Azure SQL Database, use database-level equivalent):
EXEC sp_executesql N'SELECT * FROM sys.database_principals WHERE type = ''S'''
```

### Views with cross-database references

```sql
-- Before:
CREATE VIEW dbo.CombinedData AS
SELECT * FROM [OtherDB].[dbo].[Table1]
UNION ALL
SELECT * FROM [dbo].[Table2];

-- After (for Azure SQL Database):
-- Option 1: Consolidate tables into a single database
-- Option 2: Use elastic query external tables
CREATE EXTERNAL DATA SOURCE OtherDBSource
WITH (
    TYPE = RDBMS,
    LOCATION = 'otherserver.database.windows.net',
    DATABASE_NAME = 'OtherDB',
    CREDENTIAL = OtherDBCredential
);
```

### Indexes with deprecated options

```sql
-- Check for deprecated index options
SELECT
    t.name AS table_name,
    i.name AS index_name,
    i.type_desc,
    i.is_disabled
FROM sys.indexes i
JOIN sys.tables t ON i.object_id = t.object_id
WHERE i.name IS NOT NULL
  AND i.type_desc NOT IN ('HEAP')
ORDER BY t.name, i.name;
```

---

## Schema versioning and CI/CD

After migration, implement schema change management using CI/CD pipelines:

### DACPAC-based deployment

```yaml
# Azure DevOps pipeline for schema deployment
trigger:
    branches:
        include:
            - main
    paths:
        include:
            - database/schema/**

pool:
    vmImage: "windows-latest"

steps:
    - task: SqlAzureDacpacDeployment@1
      inputs:
          azureSubscription: "AzureServiceConnection"
          AuthenticationType: "servicePrincipal"
          ServerName: "myserver.database.windows.net"
          DatabaseName: "AdventureWorks"
          DacpacFile: "$(Build.ArtifactStagingDirectory)/schema.dacpac"
          AdditionalArguments: "/p:BlockOnPossibleDataLoss=true"
```

### Migration-based deployment (alternative)

For teams preferring incremental migrations over state-based deployments, use tools like DbUp, Flyway, or custom migration scripts:

```csharp
// DbUp migration example
var upgrader = DeployChanges.To
    .AzureSqlDatabase(connectionString)
    .WithScriptsFromFileSystem("./migrations")
    .LogToConsole()
    .Build();

var result = upgrader.PerformUpgrade();
```

---

## CSA-in-a-Box considerations

When migrating schema, consider the CSA-in-a-Box analytics pipeline:

- **Purview scanning:** After schema deployment, register the database in Purview for auto-discovery. Schema objects become data catalog entries.
- **dbt models:** If building analytics transformations with dbt, the schema migration determines the source tables available for the bronze layer.
- **Data contracts:** Document the migrated schema as data contracts in the CSA-in-a-Box `contract.yaml` format for governance.

---

## Related

- [Feature Mapping](feature-mapping-complete.md)
- [Azure SQL DB Migration](azure-sql-db-migration.md)
- [Azure SQL MI Migration](azure-sql-mi-migration.md)
- [Data Migration](data-migration.md)
- [Tutorial: Azure Data Studio](tutorial-azure-data-studio.md)

---

## References

- [Data Migration Assistant](https://learn.microsoft.com/sql/dma/)
- [SqlPackage documentation](https://learn.microsoft.com/sql/tools/sqlpackage/sqlpackage)
- [Azure SQL Database T-SQL differences](https://learn.microsoft.com/azure/azure-sql/database/transact-sql-tsql-differences-sql-server)
- [Azure SQL MI T-SQL differences](https://learn.microsoft.com/azure/azure-sql/managed-instance/transact-sql-tsql-differences-sql-server)
- [Compatibility levels](https://learn.microsoft.com/sql/t-sql/statements/alter-database-transact-sql-compatibility-level)
- [Breaking changes in SQL Server](https://learn.microsoft.com/sql/database-engine/breaking-changes-to-database-engine-features-in-sql-server-2022)
- [SSDT for Visual Studio](https://learn.microsoft.com/sql/ssdt/download-sql-server-data-tools-ssdt)
