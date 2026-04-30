# Tutorial: Oracle to Azure SQL MI with SSMA

**Step-by-step walkthrough: install SSMA for Oracle, connect to source Oracle database, assess compatibility, convert schema, remediate issues, migrate data, and validate on Azure SQL Managed Instance.**

---

!!! info "Prerequisites" - Oracle Database 11g or later with read access to the schema being migrated - Azure SQL Managed Instance provisioned and accessible - Windows workstation with SSMA installed (or Azure VM) - Oracle client libraries (Oracle Instant Client) - Network connectivity to both Oracle source and Azure SQL MI target

    **Time estimate:** 3-4 hours for a small database (< 100 tables, < 10 GB)

---

## Step 1: Install SSMA for Oracle

### 1.1 Download and install

```powershell
# Download SSMA for Oracle from Microsoft
# https://aka.ms/ssmafororacle

# Install Oracle Instant Client (required for SSMA to connect to Oracle)
# Download from https://www.oracle.com/database/technologies/instant-client/downloads.html
# Extract to C:\oracle\instantclient_19_20
# Add to system PATH

# Verify Oracle client
$env:PATH += ";C:\oracle\instantclient_19_20"
tnsping oracle-prod.agency.gov:1521/FEDDB
```

### 1.2 Launch SSMA and create a project

```
1. Launch "Microsoft SQL Server Migration Assistant for Oracle"
2. File > New Project
   - Project Name: FEDDB_Migration
   - Location: C:\SSMA\Projects\
   - Migrate To: Azure SQL Managed Instance
   - Migration Options: Full Migration (Schema + Data)
3. Click OK
```

---

## Step 2: Connect to source Oracle database

### 2.1 Configure Oracle connection

```
1. In SSMA, click "Connect to Oracle" in the toolbar
2. Enter connection details:
   - Provider: Oracle Client
   - Server: oracle-prod.agency.gov
   - Port: 1521
   - Oracle SID: FEDDB  (or Service Name if using service name)
   - User Name: migration_reader
   - Password: ***
3. Click Connect
4. In the Oracle Metadata Explorer (left panel), expand the server
5. Check the schemas you want to migrate (e.g., APP_SCHEMA, HR)
```

### 2.2 Create migration user on Oracle (if not exists)

```sql
-- Run on Oracle source as DBA
CREATE USER migration_reader IDENTIFIED BY "***"
    DEFAULT TABLESPACE users
    TEMPORARY TABLESPACE temp;

GRANT CREATE SESSION TO migration_reader;
GRANT SELECT ANY TABLE TO migration_reader;
GRANT SELECT ANY DICTIONARY TO migration_reader;
GRANT SELECT_CATALOG_ROLE TO migration_reader;

-- For data migration phase
GRANT SELECT ANY TABLE TO migration_reader;
GRANT READ ON DIRECTORY dp_export_dir TO migration_reader;
```

---

## Step 3: Connect to target Azure SQL MI

### 3.1 Configure Azure SQL MI connection

```
1. Click "Connect to SQL Server" in the toolbar
2. Enter connection details:
   - Server Name: mi-instance.public.xxxx.database.windows.net,3342
     (Use public endpoint with port 3342, or private endpoint)
   - Authentication: Azure Active Directory - Password
     (Or SQL Server Authentication for initial setup)
   - User Name: migration_admin@agency.onmicrosoft.com
   - Password: ***
   - Database: FEDDB
3. Click Connect
4. The SQL Server Metadata Explorer (right panel) shows the target
```

---

## Step 4: Run assessment report

### 4.1 Generate assessment

```
1. In Oracle Metadata Explorer, right-click the schema (e.g., APP_SCHEMA)
2. Select "Create Report"
3. SSMA analyzes all objects and generates a conversion assessment
4. Review the Assessment Report:
   - Summary tab: Overall conversion statistics
   - Details tab: Object-by-object conversion status
   - Issues tab: All conversion warnings and errors
```

### 4.2 Interpreting the assessment

| Assessment category         | What it means                                   | Action                       |
| --------------------------- | ----------------------------------------------- | ---------------------------- |
| **Converted**               | SSMA can auto-convert with no issues            | Review and approve           |
| **Converted with warnings** | Auto-converted but behavior may differ          | Test thoroughly              |
| **Error**                   | Cannot auto-convert; manual intervention needed | Assign to developer          |
| **Skipped**                 | Object type not supported by SSMA               | Evaluate if needed on target |

### 4.3 Common assessment findings

| Finding                            | Severity | Resolution                                                             |
| ---------------------------------- | -------- | ---------------------------------------------------------------------- |
| `CONNECT BY` hierarchical query    | Medium   | Convert to recursive CTE (see [Schema Migration](schema-migration.md)) |
| Oracle package with state          | Medium   | Decompose to schema + functions/procedures                             |
| `AUTONOMOUS_TRANSACTION`           | High     | Use table variables or Service Bus pattern                             |
| `DBMS_` package calls              | Variable | Map to T-SQL equivalents or Azure services                             |
| `ROWNUM` in complex queries        | Low      | Convert to `ROW_NUMBER()` or `OFFSET/FETCH`                            |
| `BEFORE` triggers                  | Medium   | Convert to `AFTER` triggers or `DEFAULT` constraints                   |
| `SDO_GEOMETRY` spatial types       | Medium   | Convert to SQL Server `geometry`/`geography`                           |
| PL/SQL collections (nested tables) | High     | Redesign using table variables or temp tables                          |

---

## Step 5: Convert schema

### 5.1 Auto-convert

```
1. In Oracle Metadata Explorer, right-click the schema
2. Select "Convert Schema"
3. SSMA converts all objects and shows results in the Output window
4. Review conversion messages:
   - Green checkmark: Successful conversion
   - Yellow warning: Converted with potential issues
   - Red X: Failed conversion (requires manual fix)
5. Converted objects appear in SQL Server Metadata Explorer
```

### 5.2 Review converted objects

```
1. Expand the target database in SQL Server Metadata Explorer
2. Navigate to each object type (Tables, Views, Procedures, Functions)
3. Click on an object to see the converted T-SQL in the SQL pane
4. Compare with the original Oracle PL/SQL (shown side-by-side)
5. Verify data type mappings are correct
6. Check for truncation warnings (e.g., VARCHAR2(4000) to nvarchar(4000))
```

---

## Step 6: Remediate conversion issues

### 6.1 Fix data type issues

```sql
-- Example: SSMA converts NUMBER to float by default
-- Override for specific columns that should be integer:

-- In SSMA Type Mapping settings:
-- Oracle NUMBER(10,0) -> T-SQL int (not float)
-- Oracle NUMBER(19,0) -> T-SQL bigint
-- Oracle NUMBER(5,2) -> T-SQL decimal(5,2)

-- After conversion, verify in T-SQL:
-- Check that employee_id is int, not float
-- Check that salary is decimal(10,2), not float
```

### 6.2 Fix PL/SQL conversion errors

For each object with a conversion error:

```
1. Double-click the error in the Error List
2. View the original PL/SQL and the attempted T-SQL conversion
3. Identify the unsupported Oracle construct
4. Manually write the T-SQL equivalent using patterns from:
   - [Schema Migration Guide](schema-migration.md)
   - [Feature Mapping](feature-mapping-complete.md)
5. Paste the corrected T-SQL into SSMA's SQL pane
6. Right-click > Save as Script
```

### 6.3 Common manual fixes

```sql
-- Fix 1: Oracle DECODE -> T-SQL CASE
-- SSMA sometimes fails on nested DECODE
-- Original Oracle:
-- DECODE(status, 'A', DECODE(type, 1, 'Active-Primary', 'Active-Secondary'), 'Inactive')
-- Manual T-SQL:
CASE status
    WHEN 'A' THEN
        CASE type WHEN 1 THEN 'Active-Primary' ELSE 'Active-Secondary' END
    ELSE 'Inactive'
END

-- Fix 2: Package global variables -> session context or table
-- Oracle: emp_pkg.g_current_department (package variable)
-- T-SQL: Use SESSION_CONTEXT or a configuration table
-- SET SESSION_CONTEXT @key = 'current_department', @value = 10;
-- SELECT CAST(SESSION_CONTEXT(N'current_department') AS int);
```

---

## Step 7: Deploy schema to Azure SQL MI

### 7.1 Synchronize with target

```
1. In SQL Server Metadata Explorer, right-click the target database
2. Select "Synchronize with Database"
3. Review the synchronization plan:
   - CREATE statements for new objects
   - ALTER statements for modified objects
   - DROP statements for removed objects (if applicable)
4. Click OK to deploy
5. Monitor deployment in the Output window
6. Verify all objects created successfully
```

### 7.2 Validate schema deployment

```sql
-- Connect to Azure SQL MI and verify
-- Count objects by type
SELECT
    type_desc,
    COUNT(*) AS object_count
FROM sys.objects
WHERE schema_id = SCHEMA_ID('dbo')  -- or your target schema
  AND type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'TR')
GROUP BY type_desc
ORDER BY type_desc;

-- Verify specific critical objects exist
SELECT name, type_desc
FROM sys.objects
WHERE name IN ('employees', 'departments', 'transactions',
               'get_employee_salary', 'update_salary', 'trg_audit')
ORDER BY name;
```

---

## Step 8: Migrate data

### 8.1 Configure data migration settings

```
1. In SSMA: Tools > Project Settings > Migration
2. Set:
   - Migration Engine: Server Side Data Migration
   - Batch Size: 10000
   - Parallel Processes: 4
   - Extended Options:
     - Truncate target tables: Yes (for clean migration)
     - Keep identity values: Yes
     - Keep nullability: Yes
```

### 8.2 Run data migration

```
1. In Oracle Metadata Explorer, right-click the schema
2. Select "Migrate Data"
3. SSMA migrates data table by table
4. Monitor progress:
   - Table name, row count, status
   - Elapsed time per table
   - Error count per table
5. Review Data Migration Report when complete
```

### 8.3 Handle data migration errors

```
Common data migration errors:
- String truncation: Source data exceeds target column width
  Fix: ALTER COLUMN to increase width before re-migrating

- Date conversion: Invalid dates in Oracle (e.g., '0000-00-00')
  Fix: Clean source data or add DEFAULT constraint

- Foreign key violations: Parent rows not yet migrated
  Fix: Disable FKs, migrate all tables, re-enable FKs

- LOB errors: Large BLOB/CLOB rows timing out
  Fix: Increase batch timeout, reduce batch size for LOB tables
```

---

## Step 9: Validate migration

### 9.1 Row count validation

```sql
-- Compare row counts (run on both source and target)
-- Oracle source:
SELECT table_name, num_rows
FROM all_tables
WHERE owner = 'APP_SCHEMA'
ORDER BY table_name;

-- Azure SQL MI target:
SELECT t.name, SUM(p.rows) AS row_count
FROM sys.tables t
JOIN sys.partitions p ON t.object_id = p.object_id
WHERE p.index_id IN (0, 1)
GROUP BY t.name
ORDER BY t.name;
```

### 9.2 Run application test suite

```bash
# Update application connection string to point to Azure SQL MI
# Run existing test suite
dotnet test --filter "Category=Integration"

# Or for Java applications
mvn test -Dspring.datasource.url="jdbc:sqlserver://mi-instance.database.windows.net:1433;database=FEDDB"
```

### 9.3 Performance comparison

```sql
-- Capture baseline queries and compare execution times
-- Use Query Store to monitor after migration
SELECT TOP 20
    qt.query_sql_text,
    rs.avg_duration / 1000.0 AS avg_ms,
    rs.count_executions,
    rs.avg_cpu_time / 1000.0 AS avg_cpu_ms
FROM sys.query_store_runtime_stats rs
JOIN sys.query_store_plan qp ON rs.plan_id = qp.plan_id
JOIN sys.query_store_query qs ON qp.query_id = qs.query_id
JOIN sys.query_store_query_text qt ON qs.query_text_id = qt.query_text_id
WHERE rs.last_execution_time > DATEADD(hour, -24, GETDATE())
ORDER BY rs.avg_duration DESC;
```

---

## Step 10: Configure Fabric Mirroring

After successful migration, enable Fabric Mirroring for CSA-in-a-Box analytics integration.

```
1. Navigate to Microsoft Fabric portal
2. Select your workspace
3. New > Mirrored Database > Azure SQL Managed Instance
4. Enter connection:
   - Server: mi-instance.database.windows.net
   - Database: FEDDB
   - Authentication: Managed Identity (recommended)
5. Select tables to mirror
6. Start mirroring
7. Verify data appears in OneLake within minutes
8. Create dbt models over mirrored data in CSA-in-a-Box
```

---

## Troubleshooting

| Issue                            | Cause                                        | Resolution                                                         |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| SSMA cannot connect to Oracle    | Oracle client not installed or not in PATH   | Install Oracle Instant Client, add to PATH                         |
| Assessment shows 50%+ errors     | Complex PL/SQL with Oracle-specific features | Expected for complex schemas; prioritize critical objects          |
| Data migration timeout           | Large tables with LOB columns                | Reduce batch size, increase timeout, migrate LOB tables separately |
| Performance regression on target | Missing indexes or statistics                | Rebuild indexes, update statistics on Azure SQL MI                 |
| Fabric Mirroring not replicating | CDC not enabled on tables                    | Enable CDC: `EXEC sys.sp_cdc_enable_table ...`                     |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
