# Tutorial: SSMA Migration -- IBM Db2 to Azure SQL

**Duration:** 4-6 hours
**Prerequisites:** SSMA for Db2 installed, access to a Db2 source database (LUW or z/OS), Azure SQL MI or Azure SQL Database provisioned
**Outcome:** Complete schema conversion, data migration, and validation of a Db2 database to Azure SQL

---

## Overview

This tutorial walks through an end-to-end migration of an IBM Db2 database to Azure SQL using SQL Server Migration Assistant (SSMA) for Db2. SSMA connects to the source Db2 instance, assesses compatibility, converts the schema to T-SQL, and migrates data. You will learn to interpret the assessment report, remediate conversion issues, and validate the migrated database.

---

## Step 1: Install SSMA for Db2

### Download and install

1. Download SSMA for Db2 from the [Microsoft Download Center](https://aka.ms/ssmafordb2).
2. Run the installer (`SSMAforDB2_x.x.x.msi`).
3. Accept the license agreement and choose the installation directory.
4. Complete the installation.

### Install the SSMA extension pack on the target

The extension pack installs helper objects in the target Azure SQL database:

1. Launch SSMA for Db2.
2. Go to **Tools > Install Extension Pack**.
3. Connect to the target Azure SQL instance.
4. Select the target database and click **Install**.

The extension pack creates the `ssma_db2` schema with helper functions for type conversion and data migration.

### Configure Db2 client connectivity

For **Db2 LUW** connections, SSMA uses the IBM Db2 .NET data provider or OLEDB. Ensure one of the following is installed:

- IBM Data Server Driver Package (minimum)
- IBM Db2 Client (full)
- IBM Data Server Runtime Client

For **Db2 for z/OS** connections, SSMA connects via DRDA (Distributed Relational Database Architecture). Configure the DRDA connection in the SSMA connection dialog.

---

## Step 2: Create a new SSMA project

1. Launch SSMA for Db2.
2. Click **File > New Project**.
3. Configure the project:
    - **Name:** `Db2_Finance_Migration`
    - **Location:** Your working directory
    - **Migrate To:** Azure SQL Database or SQL Server (select your target)
    - **Project Type:** Default
4. Click **OK**.

### Configure project settings

Go to **Tools > Project Settings** and configure:

**General tab:**

- **Target platform:** Azure SQL Database (or SQL Server version for VM targets)

**Type mapping tab:**

Review and adjust default type mappings. Key adjustments:

| Db2 source type | Default SSMA mapping | Recommended adjustment                             |
| --------------- | -------------------- | -------------------------------------------------- |
| TIMESTAMP(12)   | DATETIME2(7)         | Accept (truncation from 12 to 7 fractional digits) |
| DECFLOAT(16)    | FLOAT                | Change to DECIMAL(16,6) if precision required      |
| GRAPHIC(n)      | NCHAR(n)             | Accept                                             |
| VARGRAPHIC(n)   | NVARCHAR(n)          | Accept                                             |

**Data migration tab:**

- **Client side data migration engine:** Enable
- **Batch size:** 10000 (increase for simple schemas)
- **Parallel table migration:** Enable (4-8 threads)

---

## Step 3: Connect to the source Db2 database

1. In SSMA, click **Connect to Db2** in the toolbar.
2. Enter connection details:

**For Db2 LUW:**

| Field     | Value                               |
| --------- | ----------------------------------- |
| Server    | db2server.example.com               |
| Port      | 50000                               |
| Database  | FINANCEDB                           |
| User name | db2admin                            |
| Password  | (your password)                     |
| Provider  | IBM Db2 .NET Data Provider or OLEDB |

**For Db2 for z/OS (via DRDA):**

| Field     | Value                       |
| --------- | --------------------------- |
| Server    | mainframe.example.gov       |
| Port      | 446 (DRDA port)             |
| Database  | DB2PLOC (Db2 location name) |
| User name | RACF user ID                |
| Password  | (your password)             |
| Provider  | DRDA                        |

3. Click **Connect**.
4. SSMA reads the Db2 catalog and populates the source metadata explorer on the left panel.

---

## Step 4: Connect to the target Azure SQL database

1. Click **Connect to SQL Server** in the toolbar.
2. Enter connection details:

| Field              | Value                                     |
| ------------------ | ----------------------------------------- |
| Server name        | sqlmi-instance.database.usgovcloudapi.net |
| Port               | 1433                                      |
| Database           | FinanceDB                                 |
| Authentication     | SQL Server Authentication or Azure AD     |
| User name          | sqladmin                                  |
| Password           | (your password)                           |
| Encrypt connection | Yes                                       |

3. Click **Connect**.
4. The target metadata explorer appears on the right panel.

---

## Step 5: Run the assessment report

Before converting anything, run the assessment to understand the migration complexity.

1. In the source explorer, right-click the database name (FINANCEDB).
2. Select **Create Report**.
3. SSMA analyzes all objects and generates an assessment report.

### Reading the assessment report

The report categorizes objects by conversion readiness:

| Category                    | Meaning                                     | Action                        |
| --------------------------- | ------------------------------------------- | ----------------------------- |
| **Automatically converted** | SSMA converts without manual intervention   | Review for correctness        |
| **Manually converted**      | SSMA identifies issues; manual fix required | Plan remediation effort       |
| **Not converted**           | Feature not supported; requires redesign    | Architectural decision needed |

**Key metrics to capture:**

- Total objects assessed (tables, views, procedures, functions, triggers)
- Percentage automatically converted
- Count of manual conversion items
- Count of not-converted items
- Estimated remediation effort

### Common assessment findings

| Finding                    | Frequency       | Resolution                               |
| -------------------------- | --------------- | ---------------------------------------- |
| BEFORE triggers            | Common          | Convert to INSTEAD OF triggers           |
| SQL PL condition handlers  | Common          | Convert to TRY/CATCH                     |
| DECFLOAT columns           | Occasional      | Map to DECIMAL with appropriate scale    |
| GRAPHIC/DBCLOB types       | Occasional      | Map to NCHAR/NVARCHAR                    |
| MDC tables                 | Rare (LUW only) | Redesign with partitioning + columnstore |
| MQTs with deferred refresh | Occasional      | Implement scheduled refresh              |

---

## Step 6: Convert the schema

1. In the source explorer, select the objects to convert (or select the entire database).
2. Right-click and select **Convert Schema**.
3. SSMA processes each object and generates T-SQL DDL.
4. Converted objects appear in the target explorer with status icons:
    - Green check: successfully converted
    - Yellow warning: converted with warnings (review)
    - Red X: conversion failed (manual intervention required)

### Review conversion output

For each object with warnings or errors:

1. Click the object in the target explorer.
2. Review the T-SQL output in the lower panel.
3. Read the conversion messages (warnings, errors, informational).
4. Edit the T-SQL directly in SSMA if manual fixes are needed.

### Apply the schema to the target

1. Select the converted objects in the target explorer.
2. Right-click and select **Synchronize with Database**.
3. SSMA executes the DDL against the target Azure SQL database.
4. Review the synchronization report for any errors.

---

## Step 7: Remediate conversion issues

After SSMA conversion, address the items that were not automatically converted.

### Example: Convert a condition handler procedure

See [Stored Procedure Migration](stored-proc-migration.md) for detailed conversion patterns. Here is a common pattern:

```sql
-- SSMA output (partially converted, with warnings)
-- Original Db2: DECLARE CONTINUE HANDLER FOR NOT FOUND
-- SSMA cannot directly convert condition handlers

-- Manual fix: replace with TRY/CATCH and @@ROWCOUNT checks
CREATE OR ALTER PROCEDURE dbo.lookup_account
    @p_account_id INT,
    @p_name VARCHAR(100) OUTPUT,
    @p_balance DECIMAL(15,2) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

    SELECT @p_name = name, @p_balance = balance
    FROM accounts
    WHERE account_id = @p_account_id;

    IF @@ROWCOUNT = 0
    BEGIN
        SET @p_name = NULL;
        SET @p_balance = NULL;
    END;
END;
```

### Example: Convert a BEFORE trigger

```sql
-- SSMA marks BEFORE triggers as requiring manual conversion
-- Convert to INSTEAD OF trigger

CREATE OR ALTER TRIGGER dbo.trg_accounts_before_insert
ON accounts
INSTEAD OF INSERT
AS
BEGIN
    SET NOCOUNT ON;

    -- Validation logic from the BEFORE trigger
    IF EXISTS (SELECT 1 FROM inserted WHERE balance < 0)
    BEGIN
        THROW 50001, 'Balance cannot be negative', 1;
        RETURN;
    END;

    -- Perform the actual insert
    INSERT INTO accounts (account_id, name, balance, status, created_date)
    SELECT account_id, name, balance, status, CAST(GETDATE() AS DATE)
    FROM inserted;
END;
```

---

## Step 8: Migrate data

1. In the source explorer, right-click the database and select **Migrate Data**.
2. Select the tables to migrate (typically all tables).
3. SSMA reads data from Db2 via the source connection and bulk-inserts into the target.
4. Monitor progress in the output window.

### Data migration order

SSMA handles table ordering based on foreign key dependencies. If you encounter foreign key violations:

1. Disable foreign key constraints on the target before migration.
2. Migrate all tables.
3. Re-enable foreign key constraints.
4. Validate referential integrity.

```sql
-- Disable all foreign key constraints
EXEC sp_MSforeachtable 'ALTER TABLE ? NOCHECK CONSTRAINT ALL';

-- After data migration, re-enable
EXEC sp_MSforeachtable 'ALTER TABLE ? WITH CHECK CHECK CONSTRAINT ALL';
```

### Large table handling

For tables exceeding 10 GB, SSMA data migration may be slow. Consider:

1. Use SSMA for tables under 10 GB.
2. Use ADF with the Db2 connector for tables over 10 GB (see [Data Migration](data-migration.md)).
3. Migrate large tables in parallel using ADF parallel copy activities.

---

## Step 9: Validate the migration

### Row count comparison

```sql
-- Generate row count queries for all tables
-- Run on both Db2 and Azure SQL, then compare

-- Azure SQL: get all table row counts
SELECT
    SCHEMA_NAME(t.schema_id) AS schema_name,
    t.name AS table_name,
    SUM(p.rows) AS row_count
FROM sys.tables t
JOIN sys.partitions p ON t.object_id = p.object_id
WHERE p.index_id IN (0, 1)  -- heap or clustered index
GROUP BY t.schema_id, t.name
ORDER BY schema_name, table_name;
```

### Stored procedure validation

Test each converted stored procedure:

```sql
-- Test a converted procedure
DECLARE @p_name VARCHAR(100);
DECLARE @p_balance DECIMAL(15,2);

EXEC dbo.lookup_account
    @p_account_id = 12345,
    @p_name = @p_name OUTPUT,
    @p_balance = @p_balance OUTPUT;

SELECT @p_name AS name, @p_balance AS balance;
```

### Query result comparison

Run representative queries on both Db2 and Azure SQL and compare results:

```sql
-- Business-critical query validation
-- Run on both platforms, compare output

-- Example: monthly transaction summary
SELECT
    YEAR(trans_date) AS trans_year,
    MONTH(trans_date) AS trans_month,
    COUNT(*) AS trans_count,
    SUM(amount) AS total_amount
FROM transactions
WHERE trans_date >= '2025-01-01'
GROUP BY YEAR(trans_date), MONTH(trans_date)
ORDER BY trans_year, trans_month;
```

### Performance baseline

Capture performance metrics on Azure SQL for comparison:

```sql
-- Enable Query Store (if not already enabled)
ALTER DATABASE FinanceDB SET QUERY_STORE = ON;

-- After running test workload, review top resource-consuming queries
SELECT TOP 20
    qs.query_id,
    qt.query_sql_text,
    rs.avg_duration / 1000.0 AS avg_duration_ms,
    rs.avg_cpu_time / 1000.0 AS avg_cpu_ms,
    rs.avg_logical_io_reads,
    rs.count_executions
FROM sys.query_store_query_stats rs
JOIN sys.query_store_query qs ON rs.query_id = qs.query_id
JOIN sys.query_store_query_text qt ON qs.query_text_id = qt.query_text_id
ORDER BY rs.avg_duration DESC;
```

---

## Step 10: Post-migration cleanup

1. **Remove SSMA extension pack** (optional, if helper functions are not needed):

    ```sql
    DROP SCHEMA ssma_db2;
    ```

2. **Update statistics on all tables:**

    ```sql
    EXEC sp_updatestats;
    ```

3. **Rebuild indexes** to optimize storage:

    ```sql
    EXEC sp_MSforeachtable 'ALTER INDEX ALL ON ? REBUILD';
    ```

4. **Configure automated maintenance** on Azure SQL MI:
    - Verify automatic statistics update is enabled
    - Configure maintenance window for index rebuilds if needed
    - Enable Intelligent Insights for AI-driven performance recommendations

5. **Set up monitoring:**
    - Configure Azure Monitor alerts for DTU/vCore utilization, storage, and deadlocks
    - Enable Microsoft Defender for SQL
    - Configure audit logging

---

## Troubleshooting

| Issue                                    | Cause                                          | Resolution                                                               |
| ---------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| SSMA cannot connect to Db2               | Firewall, DRDA port blocked, wrong credentials | Verify network connectivity, port 50000 (LUW) or 446 (z/OS), credentials |
| Schema conversion hangs                  | Very large schema (10,000+ objects)            | Convert in smaller batches (by schema or object type)                    |
| Data migration timeout                   | Large table, slow network                      | Increase timeout, use ADF for large tables                               |
| Character encoding errors                | EBCDIC conversion issues (z/OS)                | Review CCSID settings, validate with encoding queries                    |
| Stored procedure errors after conversion | Unconverted SQL PL constructs                  | Follow stored procedure migration guide for manual fixes                 |
| Performance regression after migration   | Missing indexes, outdated statistics           | Rebuild indexes, update statistics, review execution plans               |

---

## Next steps

- [Stored Procedure Migration](stored-proc-migration.md) -- manual remediation for unconverted procedures
- [Data Migration](data-migration.md) -- ADF and BCP for large tables
- [Application Migration](application-migration.md) -- update application connectivity
- [Best Practices](best-practices.md) -- validation methodology and complexity assessment

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
