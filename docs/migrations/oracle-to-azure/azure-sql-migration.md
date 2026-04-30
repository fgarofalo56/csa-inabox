# Oracle to Azure SQL Managed Instance Migration

**When to choose Azure SQL MI, how to use SSMA for assessment and conversion, PL/SQL to T-SQL conversion patterns, and CSA-in-a-Box integration via Fabric Mirroring.**

---

!!! abstract "When to choose Azure SQL MI"
Choose Azure SQL Managed Instance when your Oracle workload is standard OLTP with moderate PL/SQL complexity, your organization is already in the Microsoft ecosystem (Active Directory, Office 365, Power BI), and you want the lowest operational overhead with built-in HA, automated backups, and zero database licensing cost.

---

## 1. Azure SQL MI for Oracle DBAs

Azure SQL MI is a fully managed SQL Server instance in Azure that provides near-100% compatibility with the on-premises SQL Server engine. For Oracle DBAs, the key equivalences are:

| Oracle concept                  | Azure SQL MI equivalent            |
| ------------------------------- | ---------------------------------- |
| Oracle Instance                 | Managed Instance                   |
| Oracle Database (CDB/PDB)       | Database within the instance       |
| Oracle Schema                   | Schema (same concept)              |
| Tablespace                      | Filegroup                          |
| Data Dictionary (`DBA_*` views) | System catalog views (`sys.*`)     |
| AWR / ASH                       | Query Store + Performance Insights |
| Enterprise Manager              | Azure Portal + Azure Monitor       |
| SQL\*Plus                       | Azure Data Studio, SSMS, sqlcmd    |
| PL/SQL                          | T-SQL                              |
| Oracle Net Services (TNS)       | TDS protocol (connection string)   |
| RMAN                            | Automated (Azure-managed backups)  |
| Data Guard                      | Auto-failover groups               |
| RAC                             | N/A (built-in HA, active-passive)  |

### 1.1 Service tiers

| Tier                         | Use case                                        | SLA    | Compute      | Storage                |
| ---------------------------- | ----------------------------------------------- | ------ | ------------ | ---------------------- |
| **General Purpose**          | Standard OLTP, dev/test, batch processing       | 99.99% | 4-80 vCores  | Up to 16 TB            |
| **Business Critical**        | Mission-critical OLTP, in-memory, read replicas | 99.99% | 4-128 vCores | Up to 16 TB, local SSD |
| **Next-gen General Purpose** | Cost-optimized, flexible compute/storage        | 99.99% | 4-128 vCores | Up to 32 TB            |

### 1.2 What is included at no additional cost

Features that Oracle charges separately for:

- **High availability** (equivalent of RAC -- $23,000/processor on Oracle)
- **Disaster recovery** (equivalent of Active Data Guard -- $11,500/processor)
- **Encryption at rest** (equivalent of Advanced Security TDE -- $15,000/processor)
- **Performance diagnostics** (equivalent of Diagnostics Pack -- $7,500/processor)
- **Automated backups** with up to 35-day retention
- **Automated patching** and version upgrades
- **Read replicas** (Business Critical tier)

---

## 2. SSMA assessment and conversion

### 2.1 Assessment workflow

SQL Server Migration Assistant (SSMA) for Oracle automates the assessment and conversion of Oracle schemas to SQL Server / Azure SQL MI.

```
Oracle Database ──► SSMA Assessment ──► Conversion Report
                                             │
                    ┌────────────────────────┤
                    │                        │
              Auto-converted            Manual remediation
              (80%+ typical)            (complex PL/SQL)
                    │                        │
                    └────────┬───────────────┘
                             │
                    Azure SQL MI deployment
                             │
                    Data migration (SSMA or DMS)
                             │
                    Fabric Mirroring to OneLake
```

### 2.2 SSMA conversion categories

SSMA categorizes each Oracle object into conversion tiers:

| Category                       | Description                                      | Typical percentage | Action                               |
| ------------------------------ | ------------------------------------------------ | ------------------ | ------------------------------------ |
| **Auto-converted**             | Direct translation, no manual work               | 60-80%             | Review and deploy                    |
| **Converted with warnings**    | Translated but may need behavioral validation    | 10-20%             | Test thoroughly                      |
| **Manual conversion required** | SSMA cannot convert; manual T-SQL rewrite needed | 5-15%              | DBA/developer effort                 |
| **Not supported**              | Oracle feature has no SQL Server equivalent      | 1-5%               | Architectural redesign or workaround |

### 2.3 Running an SSMA assessment

```bash
# Install SSMA for Oracle (download from Microsoft)
# Launch SSMA and create a new project

# Connect to source Oracle database
# Connection string: host:port/service_name
# Example: oracle-prod.agency.gov:1521/FEDDB

# Connect to target Azure SQL MI
# Connection string: mi-instance.database.windows.net

# Run Assessment
# Menu: Oracle Metadata Explorer > right-click schema > Create Report

# Review Assessment Report
# - Conversion statistics (auto/warning/manual/unsupported)
# - Object-by-object conversion details
# - Estimated effort
```

---

## 3. PL/SQL to T-SQL conversion patterns

### 3.1 Variable declarations

```sql
-- Oracle PL/SQL
DECLARE
    v_employee_id   NUMBER(10);
    v_salary        NUMBER(10,2);
    v_hire_date     DATE;
    v_name          VARCHAR2(100);
    v_is_active     BOOLEAN := TRUE;
BEGIN
    -- logic
END;
/
```

```sql
-- T-SQL (Azure SQL MI)
DECLARE
    @employee_id    int,
    @salary         decimal(10,2),
    @hire_date      datetime2(0),
    @name           nvarchar(100),
    @is_active      bit = 1;
-- logic (no BEGIN/END block needed for simple scripts)
```

### 3.2 Cursor patterns

```sql
-- Oracle PL/SQL cursor FOR loop
DECLARE
    CURSOR c_employees IS
        SELECT employee_id, salary FROM employees WHERE department_id = 10;
BEGIN
    FOR emp_rec IN c_employees LOOP
        DBMS_OUTPUT.PUT_LINE('Employee: ' || emp_rec.employee_id);
        UPDATE employees SET salary = emp_rec.salary * 1.1
        WHERE employee_id = emp_rec.employee_id;
    END LOOP;
END;
/
```

```sql
-- T-SQL equivalent (prefer set-based)
-- Set-based approach (preferred):
UPDATE employees SET salary = salary * 1.1 WHERE department_id = 10;

-- Cursor approach (when row-by-row logic is required):
DECLARE @employee_id int, @salary decimal(10,2);
DECLARE c_employees CURSOR FOR
    SELECT employee_id, salary FROM employees WHERE department_id = 10;
OPEN c_employees;
FETCH NEXT FROM c_employees INTO @employee_id, @salary;
WHILE @@FETCH_STATUS = 0
BEGIN
    PRINT 'Employee: ' + CAST(@employee_id AS nvarchar(10));
    UPDATE employees SET salary = @salary * 1.1 WHERE employee_id = @employee_id;
    FETCH NEXT FROM c_employees INTO @employee_id, @salary;
END;
CLOSE c_employees;
DEALLOCATE c_employees;
```

### 3.3 Exception handling

```sql
-- Oracle PL/SQL
BEGIN
    INSERT INTO audit_log (event_type, event_date, details)
    VALUES ('LOGIN', SYSDATE, 'User login');
EXCEPTION
    WHEN DUP_VAL_ON_INDEX THEN
        UPDATE audit_log SET event_date = SYSDATE
        WHERE event_type = 'LOGIN';
    WHEN OTHERS THEN
        RAISE_APPLICATION_ERROR(-20001, 'Unexpected error: ' || SQLERRM);
END;
/
```

```sql
-- T-SQL (Azure SQL MI)
BEGIN TRY
    INSERT INTO audit_log (event_type, event_date, details)
    VALUES ('LOGIN', GETDATE(), 'User login');
END TRY
BEGIN CATCH
    IF ERROR_NUMBER() = 2601 OR ERROR_NUMBER() = 2627  -- Unique constraint violation
        UPDATE audit_log SET event_date = GETDATE()
        WHERE event_type = 'LOGIN';
    ELSE
        THROW 50001, 'Unexpected error', 1;
END CATCH;
```

### 3.4 Sequences

```sql
-- Oracle
CREATE SEQUENCE emp_seq START WITH 1 INCREMENT BY 1;

-- Usage in INSERT
INSERT INTO employees (employee_id, name)
VALUES (emp_seq.NEXTVAL, 'John Doe');
```

```sql
-- T-SQL (Azure SQL MI) - Option 1: Sequence
CREATE SEQUENCE emp_seq START WITH 1 INCREMENT BY 1;

INSERT INTO employees (employee_id, name)
VALUES (NEXT VALUE FOR emp_seq, 'John Doe');

-- T-SQL - Option 2: IDENTITY column (preferred for surrogate keys)
CREATE TABLE employees (
    employee_id int IDENTITY(1,1) PRIMARY KEY,
    name nvarchar(100)
);

INSERT INTO employees (name) VALUES ('John Doe');
-- employee_id auto-generated
```

### 3.5 Trigger differences

```sql
-- Oracle BEFORE INSERT trigger
CREATE OR REPLACE TRIGGER trg_emp_before_insert
BEFORE INSERT ON employees
FOR EACH ROW
BEGIN
    :NEW.created_date := SYSDATE;
    :NEW.created_by := SYS_CONTEXT('USERENV', 'SESSION_USER');
    IF :NEW.employee_id IS NULL THEN
        :NEW.employee_id := emp_seq.NEXTVAL;
    END IF;
END;
/
```

```sql
-- T-SQL INSTEAD OF / AFTER trigger (no BEFORE triggers in SQL Server)
-- Use DEFAULT constraints and IDENTITY for the simple cases:
ALTER TABLE employees ADD CONSTRAINT df_created_date
    DEFAULT GETDATE() FOR created_date;
ALTER TABLE employees ADD CONSTRAINT df_created_by
    DEFAULT SUSER_SNAME() FOR created_by;

-- For complex logic, use AFTER trigger:
CREATE OR ALTER TRIGGER trg_emp_after_insert
ON employees
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE e
    SET created_date = GETDATE(),
        created_by = SUSER_SNAME()
    FROM employees e
    INNER JOIN inserted i ON e.employee_id = i.employee_id
    WHERE e.created_date IS NULL;
END;
```

---

## 4. Common conversion challenges

### 4.1 CONNECT BY to recursive CTE

```sql
-- Oracle hierarchical query
SELECT employee_id, manager_id, name,
       LEVEL as depth,
       SYS_CONNECT_BY_PATH(name, '/') as path
FROM employees
START WITH manager_id IS NULL
CONNECT BY PRIOR employee_id = manager_id
ORDER SIBLINGS BY name;
```

```sql
-- T-SQL recursive CTE
WITH org_hierarchy AS (
    -- Anchor member
    SELECT employee_id, manager_id, name,
           1 AS depth,
           CAST('/' + name AS nvarchar(max)) AS path
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    -- Recursive member
    SELECT e.employee_id, e.manager_id, e.name,
           h.depth + 1,
           CAST(h.path + '/' + e.name AS nvarchar(max))
    FROM employees e
    INNER JOIN org_hierarchy h ON e.manager_id = h.employee_id
)
SELECT * FROM org_hierarchy
ORDER BY path;
```

### 4.2 Autonomous transactions

Oracle autonomous transactions (used for logging that must commit independently of the parent transaction) have no direct T-SQL equivalent.

```sql
-- Oracle autonomous transaction
CREATE OR REPLACE PROCEDURE log_event(p_message VARCHAR2) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
BEGIN
    INSERT INTO event_log (message, log_date) VALUES (p_message, SYSDATE);
    COMMIT;  -- Commits independently of caller's transaction
END;
/
```

```sql
-- T-SQL workaround: Use a loopback linked server or separate connection
-- Option 1: Table variable (not rolled back on ROLLBACK)
CREATE OR ALTER PROCEDURE dbo.log_event @message nvarchar(max)
AS
BEGIN
    -- Table variables are not affected by ROLLBACK
    DECLARE @log TABLE (message nvarchar(max), log_date datetime2);
    INSERT INTO @log VALUES (@message, GETDATE());

    -- Insert from table variable (survives ROLLBACK in some patterns)
    INSERT INTO event_log (message, log_date)
    SELECT message, log_date FROM @log;
END;

-- Option 2: Service Broker or Azure Service Bus for async logging
-- (Recommended for production -- fire-and-forget pattern)
```

---

## 5. Fabric Mirroring integration

After migrating Oracle to Azure SQL MI, configure Fabric Mirroring to replicate transactional data to OneLake for analytics.

### 5.1 Enable Fabric Mirroring

```bash
# Prerequisites:
# 1. Azure SQL MI with system-assigned managed identity
# 2. Microsoft Fabric capacity (F64 or higher)
# 3. Fabric workspace with Mirroring enabled

# In Fabric portal:
# 1. Navigate to workspace > New > Mirrored Database
# 2. Select "Azure SQL Managed Instance"
# 3. Provide connection details (MI endpoint, database name)
# 4. Authenticate with managed identity or SQL authentication
# 5. Select tables to mirror
# 6. Start mirroring
```

### 5.2 CSA-in-a-Box integration pattern

Once mirroring is active, mirrored tables appear in OneLake and are accessible from:

- **dbt models** -- reference mirrored tables as sources in `domains/shared/dbt/models/`
- **Power BI Direct Lake** -- create semantic models over mirrored data
- **Purview** -- auto-catalog mirrored tables with classifications from the source database
- **Azure AI** -- use mirrored data for RAG patterns and model training

---

## 6. Application migration considerations

### 6.1 Connection string changes

```python
# Oracle (cx_Oracle / oracledb)
import oracledb
conn = oracledb.connect(user="app_user", password="***",
                         dsn="oracle-prod:1521/FEDDB")

# Azure SQL MI (pyodbc)
import pyodbc
conn = pyodbc.connect(
    'DRIVER={ODBC Driver 18 for SQL Server};'
    'SERVER=mi-instance.database.windows.net;'
    'DATABASE=FEDDB;'
    'Authentication=ActiveDirectoryManagedIdentity'
)
```

### 6.2 ORM changes

| ORM              | Oracle dialect                        | Azure SQL MI dialect                      |
| ---------------- | ------------------------------------- | ----------------------------------------- |
| SQLAlchemy       | `oracle+oracledb://`                  | `mssql+pyodbc://`                         |
| Entity Framework | `Oracle.EntityFrameworkCore`          | `Microsoft.EntityFrameworkCore.SqlServer` |
| Hibernate        | `org.hibernate.dialect.OracleDialect` | `org.hibernate.dialect.SQLServerDialect`  |
| Django           | `django.db.backends.oracle`           | `mssql` (django-mssql-backend)            |

### 6.3 Query syntax changes for applications

| Oracle SQL                                       | Azure SQL MI equivalent                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `SELECT ... FROM DUAL`                           | `SELECT ...`                                                      |
| `ROWNUM <= 10`                                   | `TOP 10` or `OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY`               |
| `NVL(col, default)`                              | `ISNULL(col, default)`                                            |
| `SYSDATE`                                        | `GETDATE()`                                                       |
| `TO_DATE('2024-01-01', 'YYYY-MM-DD')`            | `CAST('2024-01-01' AS datetime2)`                                 |
| `emp_seq.NEXTVAL`                                | `NEXT VALUE FOR emp_seq`                                          |
| `DECODE(status, 'A', 'Active', 'I', 'Inactive')` | `CASE status WHEN 'A' THEN 'Active' WHEN 'I' THEN 'Inactive' END` |

---

## 7. Post-migration validation

### 7.1 Data validation queries

```sql
-- Row count comparison
SELECT 'employees' AS table_name, COUNT(*) AS row_count FROM employees
UNION ALL
SELECT 'departments', COUNT(*) FROM departments
UNION ALL
SELECT 'audit_log', COUNT(*) FROM audit_log;

-- Checksum comparison (run on both Oracle and Azure SQL MI)
-- Oracle:
SELECT ORA_HASH(LISTAGG(employee_id || salary || name, ',')
    WITHIN GROUP (ORDER BY employee_id)) AS checksum
FROM employees;

-- Azure SQL MI:
SELECT CHECKSUM_AGG(CHECKSUM(employee_id, salary, name)) AS checksum
FROM employees;
```

### 7.2 Performance baseline

```sql
-- Azure SQL MI: Enable Query Store (enabled by default)
-- Review top resource-consuming queries
SELECT TOP 20
    qs.query_id,
    qt.query_sql_text,
    rs.avg_duration / 1000.0 AS avg_duration_ms,
    rs.avg_cpu_time / 1000.0 AS avg_cpu_ms,
    rs.avg_logical_io_reads,
    rs.count_executions
FROM sys.query_store_runtime_stats rs
JOIN sys.query_store_plan qp ON rs.plan_id = qp.plan_id
JOIN sys.query_store_query qs ON qp.query_id = qs.query_id
JOIN sys.query_store_query_text qt ON qs.query_text_id = qt.query_text_id
ORDER BY rs.avg_duration DESC;
```

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
