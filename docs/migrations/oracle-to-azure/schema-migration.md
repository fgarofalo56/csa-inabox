# Oracle Schema Migration -- PL/SQL Conversion Patterns

**Comprehensive data type mapping and PL/SQL to T-SQL / PL/pgSQL conversion patterns for Oracle-to-Azure migrations.**

---

!!! info "Scope"
This guide covers the schema conversion layer -- data types, SQL syntax, PL/SQL procedural constructs, and Oracle-specific idioms. For target-specific guidance, see [Azure SQL MI Migration](azure-sql-migration.md) or [PostgreSQL Migration](postgresql-migration.md). For the full feature mapping, see [Feature Mapping](feature-mapping-complete.md).

---

## 1. Data type mapping reference

### 1.1 Numeric types

| Oracle                           | Azure SQL MI (T-SQL)            | PostgreSQL         | Notes                              |
| -------------------------------- | ------------------------------- | ------------------ | ---------------------------------- |
| `NUMBER(1)`                      | `bit`                           | `boolean`          | For true/false flags               |
| `NUMBER(3)`                      | `tinyint` (0-255) or `smallint` | `smallint`         | Range matters                      |
| `NUMBER(5)`                      | `smallint`                      | `smallint`         |                                    |
| `NUMBER(10)`                     | `int`                           | `integer`          | Most common integer                |
| `NUMBER(19)`                     | `bigint`                        | `bigint`           | Large identifiers                  |
| `NUMBER(p,s)` where s > 0        | `decimal(p,s)`                  | `numeric(p,s)`     | Exact decimal                      |
| `NUMBER` (no precision)          | `float(53)`                     | `double precision` | Caution: loses arbitrary precision |
| `BINARY_FLOAT`                   | `real`                          | `real`             | 32-bit IEEE 754                    |
| `BINARY_DOUBLE`                  | `float(53)`                     | `double precision` | 64-bit IEEE 754                    |
| `PLS_INTEGER` / `BINARY_INTEGER` | `int`                           | `integer`          | PL/SQL only; use in variables      |

### 1.2 String types

| Oracle             | Azure SQL MI (T-SQL)          | PostgreSQL   | Notes                                    |
| ------------------ | ----------------------------- | ------------ | ---------------------------------------- |
| `VARCHAR2(n BYTE)` | `varchar(n)` or `nvarchar(n)` | `varchar(n)` | Use nvarchar in SQL Server for Unicode   |
| `VARCHAR2(n CHAR)` | `nvarchar(n)`                 | `varchar(n)` | Character semantics                      |
| `NVARCHAR2(n)`     | `nvarchar(n)`                 | `varchar(n)` | PostgreSQL varchar is Unicode by default |
| `CHAR(n)`          | `nchar(n)`                    | `char(n)`    | Fixed-width                              |
| `NCHAR(n)`         | `nchar(n)`                    | `char(n)`    |                                          |
| `CLOB`             | `nvarchar(max)`               | `text`       | Up to 2 GB                               |
| `NCLOB`            | `nvarchar(max)`               | `text`       |                                          |
| `LONG`             | `nvarchar(max)`               | `text`       | Deprecated in Oracle                     |

### 1.3 Date and time types

| Oracle                           | Azure SQL MI (T-SQL)    | PostgreSQL     | Notes                                                   |
| -------------------------------- | ----------------------- | -------------- | ------------------------------------------------------- |
| `DATE`                           | `datetime2(0)`          | `timestamp(0)` | Oracle DATE includes time; SQL Server DATE does not     |
| `TIMESTAMP(p)`                   | `datetime2(p)`          | `timestamp(p)` | p = fractional seconds (max 7 for SQL Server, 6 for PG) |
| `TIMESTAMP WITH TIME ZONE`       | `datetimeoffset(7)`     | `timestamptz`  | With timezone offset                                    |
| `TIMESTAMP WITH LOCAL TIME ZONE` | `datetime2` + app logic | `timestamptz`  | Session-dependent display                               |
| `INTERVAL YEAR TO MONTH`         | Calculate with DATEDIFF | `interval`     | PostgreSQL has native interval                          |
| `INTERVAL DAY TO SECOND`         | Calculate with DATEDIFF | `interval`     | PostgreSQL has native interval                          |

!!! warning "Oracle DATE trap"
The most common mapping error is Oracle `DATE` to SQL Server `date`. Oracle's `DATE` type stores both date and time (to the second). SQL Server's `date` type stores only the date. Always map Oracle `DATE` to `datetime2(0)` in SQL Server or `timestamp(0)` in PostgreSQL.

### 1.4 Binary and LOB types

| Oracle     | Azure SQL MI (T-SQL)                  | PostgreSQL                   | Notes                               |
| ---------- | ------------------------------------- | ---------------------------- | ----------------------------------- |
| `BLOB`     | `varbinary(max)`                      | `bytea`                      | Binary large object                 |
| `RAW(n)`   | `varbinary(n)`                        | `bytea`                      | Fixed-size binary                   |
| `LONG RAW` | `varbinary(max)`                      | `bytea`                      | Deprecated in Oracle                |
| `BFILE`    | External reference + `varbinary(max)` | External reference + `bytea` | Store in Azure Blob, keep reference |

### 1.5 Special types

| Oracle                  | Azure SQL MI (T-SQL)             | PostgreSQL         | Notes                              |
| ----------------------- | -------------------------------- | ------------------ | ---------------------------------- |
| `XMLTYPE`               | `xml`                            | `xml`              | XQuery syntax differs              |
| `SDO_GEOMETRY`          | `geometry` / `geography`         | PostGIS `geometry` | Requires PostGIS extension         |
| `SYS.ANYDATA`           | `sql_variant`                    | `jsonb`            | Polymorphic type                   |
| `ROWID`                 | No equivalent                    | `ctid` (unstable)  | Use logical keys                   |
| `UROWID`                | No equivalent                    | No equivalent      | Use logical keys                   |
| `BOOLEAN` (PL/SQL only) | `bit`                            | `boolean`          |                                    |
| `JSON` (21c)            | `nvarchar(max)` + JSON functions | `jsonb`            | PostgreSQL jsonb is strongly typed |

---

## 2. Oracle SQL idiom conversion

### 2.1 DUAL table

```sql
-- Oracle
SELECT SYSDATE FROM DUAL;
SELECT 1 + 1 FROM DUAL;
SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') FROM DUAL;
```

```sql
-- T-SQL (Azure SQL MI) -- no DUAL needed
SELECT GETDATE();
SELECT 1 + 1;
SELECT SUSER_SNAME();
```

```sql
-- PostgreSQL -- no DUAL needed (optional)
SELECT now();
SELECT 1 + 1;
SELECT current_user;
```

### 2.2 ROWNUM and pagination

```sql
-- Oracle: Top N rows
SELECT * FROM employees WHERE ROWNUM <= 10;

-- Oracle: Pagination (pre-12c)
SELECT * FROM (
    SELECT e.*, ROWNUM rn FROM (
        SELECT * FROM employees ORDER BY salary DESC
    ) e WHERE ROWNUM <= 20
) WHERE rn > 10;

-- Oracle 12c+: FETCH FIRST
SELECT * FROM employees ORDER BY salary DESC
FETCH FIRST 10 ROWS ONLY;

-- Oracle 12c+: OFFSET/FETCH
SELECT * FROM employees ORDER BY salary DESC
OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY;
```

```sql
-- T-SQL (Azure SQL MI)
SELECT TOP 10 * FROM employees;

-- Pagination
SELECT * FROM employees ORDER BY salary DESC
OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY;
```

```sql
-- PostgreSQL
SELECT * FROM employees LIMIT 10;

-- Pagination
SELECT * FROM employees ORDER BY salary DESC
LIMIT 10 OFFSET 10;
```

### 2.3 NVL, NVL2, DECODE, COALESCE

```sql
-- Oracle
SELECT NVL(commission_pct, 0) FROM employees;
SELECT NVL2(commission_pct, salary * commission_pct, 0) FROM employees;
SELECT DECODE(status, 'A', 'Active', 'I', 'Inactive', 'Unknown') FROM employees;
```

```sql
-- T-SQL
SELECT ISNULL(commission_pct, 0) FROM employees;
-- or COALESCE(commission_pct, 0) for ANSI compliance
SELECT CASE WHEN commission_pct IS NOT NULL
            THEN salary * commission_pct ELSE 0 END FROM employees;
-- or IIF(commission_pct IS NOT NULL, salary * commission_pct, 0)
SELECT CASE status WHEN 'A' THEN 'Active'
                   WHEN 'I' THEN 'Inactive'
                   ELSE 'Unknown' END FROM employees;
```

```sql
-- PostgreSQL
SELECT COALESCE(commission_pct, 0) FROM employees;
SELECT CASE WHEN commission_pct IS NOT NULL
            THEN salary * commission_pct ELSE 0 END FROM employees;
SELECT CASE status WHEN 'A' THEN 'Active'
                   WHEN 'I' THEN 'Inactive'
                   ELSE 'Unknown' END FROM employees;
```

### 2.4 String concatenation

```sql
-- Oracle
SELECT first_name || ' ' || last_name AS full_name FROM employees;
SELECT 'Employee: ' || TO_CHAR(employee_id) FROM employees;
```

```sql
-- T-SQL
SELECT first_name + ' ' + last_name AS full_name FROM employees;
-- or CONCAT(first_name, ' ', last_name)
SELECT 'Employee: ' + CAST(employee_id AS nvarchar(10)) FROM employees;
-- or CONCAT('Employee: ', employee_id)
```

```sql
-- PostgreSQL
SELECT first_name || ' ' || last_name AS full_name FROM employees;
-- Same as Oracle! (|| is standard SQL)
SELECT 'Employee: ' || employee_id::text FROM employees;
```

### 2.5 Date arithmetic

```sql
-- Oracle
SELECT SYSDATE + 30 FROM DUAL;                    -- Add 30 days
SELECT ADD_MONTHS(SYSDATE, 3) FROM DUAL;           -- Add 3 months
SELECT MONTHS_BETWEEN(date1, date2) FROM DUAL;     -- Months between
SELECT TRUNC(SYSDATE) FROM DUAL;                   -- Truncate to day
SELECT TRUNC(SYSDATE, 'MM') FROM DUAL;             -- Truncate to month
SELECT EXTRACT(YEAR FROM SYSDATE) FROM DUAL;       -- Extract year
SELECT LAST_DAY(SYSDATE) FROM DUAL;                -- Last day of month
SELECT NEXT_DAY(SYSDATE, 'MONDAY') FROM DUAL;      -- Next Monday
```

```sql
-- T-SQL
SELECT DATEADD(day, 30, GETDATE());
SELECT DATEADD(month, 3, GETDATE());
SELECT DATEDIFF(month, date2, date1);
SELECT CAST(GETDATE() AS date);
SELECT DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1);
SELECT YEAR(GETDATE());
SELECT EOMONTH(GETDATE());
-- NEXT_DAY: no direct equivalent; use DATEADD with calculation
```

```sql
-- PostgreSQL
SELECT now() + interval '30 days';
SELECT now() + interval '3 months';
SELECT EXTRACT(EPOCH FROM age(date1, date2)) / 2629746; -- approximate months
SELECT date_trunc('day', now());
SELECT date_trunc('month', now());
SELECT EXTRACT(YEAR FROM now());
SELECT (date_trunc('month', now()) + interval '1 month - 1 day')::date;
-- Or for last_day: SELECT (date_trunc('month', now() + interval '1 month') - interval '1 day')::date;
```

### 2.6 CONNECT BY hierarchical queries

```sql
-- Oracle: Employee org chart with path
SELECT
    LPAD(' ', 2 * (LEVEL - 1)) || employee_name AS org_tree,
    employee_id,
    manager_id,
    LEVEL,
    SYS_CONNECT_BY_PATH(employee_name, ' > ') AS path,
    CONNECT_BY_ISLEAF AS is_leaf
FROM employees
START WITH manager_id IS NULL
CONNECT BY PRIOR employee_id = manager_id
ORDER SIBLINGS BY employee_name;
```

```sql
-- T-SQL: Recursive CTE
WITH org_cte AS (
    -- Anchor: top-level managers
    SELECT
        CAST(employee_name AS nvarchar(max)) AS org_tree,
        employee_id,
        manager_id,
        1 AS lvl,
        CAST(' > ' + employee_name AS nvarchar(max)) AS path,
        CASE WHEN NOT EXISTS (
            SELECT 1 FROM employees c WHERE c.manager_id = employees.employee_id
        ) THEN 1 ELSE 0 END AS is_leaf
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    -- Recursive: subordinates
    SELECT
        CAST(REPLICATE(' ', 2 * o.lvl) + e.employee_name AS nvarchar(max)),
        e.employee_id,
        e.manager_id,
        o.lvl + 1,
        CAST(o.path + ' > ' + e.employee_name AS nvarchar(max)),
        CASE WHEN NOT EXISTS (
            SELECT 1 FROM employees c WHERE c.manager_id = e.employee_id
        ) THEN 1 ELSE 0 END
    FROM employees e
    INNER JOIN org_cte o ON e.manager_id = o.employee_id
)
SELECT * FROM org_cte ORDER BY path;
```

```sql
-- PostgreSQL: Recursive CTE (similar to T-SQL)
WITH RECURSIVE org_cte AS (
    SELECT
        employee_name AS org_tree,
        employee_id,
        manager_id,
        1 AS lvl,
        ' > ' || employee_name AS path
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    SELECT
        repeat(' ', 2 * o.lvl) || e.employee_name,
        e.employee_id,
        e.manager_id,
        o.lvl + 1,
        o.path || ' > ' || e.employee_name
    FROM employees e
    INNER JOIN org_cte o ON e.manager_id = o.employee_id
)
SELECT * FROM org_cte ORDER BY path;
```

### 2.7 Analytic functions

Most Oracle analytic functions work identically in T-SQL and PostgreSQL:

```sql
-- Oracle (works the same in T-SQL and PostgreSQL)
SELECT
    employee_id,
    department_id,
    salary,
    ROW_NUMBER() OVER (PARTITION BY department_id ORDER BY salary DESC) AS rank_in_dept,
    DENSE_RANK() OVER (ORDER BY salary DESC) AS overall_rank,
    LAG(salary) OVER (ORDER BY hire_date) AS prev_salary,
    LEAD(salary) OVER (ORDER BY hire_date) AS next_salary,
    SUM(salary) OVER (PARTITION BY department_id) AS dept_total,
    AVG(salary) OVER () AS company_avg,
    NTILE(4) OVER (ORDER BY salary) AS quartile
FROM employees;
```

Oracle-specific analytic differences:

| Oracle                                          | T-SQL                                                 | PostgreSQL                                            |
| ----------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `LISTAGG(col, ',') WITHIN GROUP (ORDER BY col)` | `STRING_AGG(col, ',') WITHIN GROUP (ORDER BY col)`    | `string_agg(col, ',' ORDER BY col)`                   |
| `RATIO_TO_REPORT(salary) OVER ()`               | `salary * 1.0 / SUM(salary) OVER ()`                  | `salary::numeric / SUM(salary) OVER ()`               |
| `MEDIAN(salary)`                                | `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY salary)` | `percentile_cont(0.5) WITHIN GROUP (ORDER BY salary)` |
| `KEEP (DENSE_RANK FIRST ORDER BY ...)`          | Subquery or `FIRST_VALUE()`                           | Subquery or `FIRST_VALUE()`                           |

---

## 3. Autonomous transaction patterns

Oracle autonomous transactions are used for logging, auditing, and sequence management that must commit independently. Neither T-SQL nor PL/pgSQL has a direct equivalent.

### 3.1 Logging pattern

```sql
-- Oracle: Autonomous transaction for audit logging
CREATE OR REPLACE PROCEDURE log_audit(
    p_action VARCHAR2,
    p_details VARCHAR2
) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
BEGIN
    INSERT INTO audit_log (action, details, log_time, session_user)
    VALUES (p_action, p_details, SYSTIMESTAMP, SYS_CONTEXT('USERENV','SESSION_USER'));
    COMMIT;
END;
/
```

```sql
-- T-SQL: Use table variable (survives ROLLBACK) or Service Bus
CREATE OR ALTER PROCEDURE dbo.log_audit
    @action nvarchar(100),
    @details nvarchar(max)
AS
BEGIN
    -- Option 1: Direct insert (will be rolled back if caller rolls back)
    INSERT INTO audit_log (action, details, log_time, session_user)
    VALUES (@action, @details, SYSDATETIMEOFFSET(), SUSER_SNAME());

    -- Option 2: Use Azure Service Bus for fire-and-forget logging
    -- (external queue ensures log survives transaction rollback)
END;
```

```sql
-- PostgreSQL: Use dblink for autonomous-like behavior
CREATE EXTENSION IF NOT EXISTS dblink;

CREATE OR REPLACE PROCEDURE log_audit(
    p_action text,
    p_details text
) AS $$
BEGIN
    PERFORM dblink_exec(
        'dbname=' || current_database() || ' user=' || current_user,
        format('INSERT INTO audit_log (action, details, log_time, session_user)
                VALUES (%L, %L, now(), current_user)', p_action, p_details)
    );
END;
$$ LANGUAGE plpgsql;
```

---

## 4. Oracle-specific SQL constructs

### 4.1 MERGE statement

```sql
-- Oracle MERGE
MERGE INTO target_table t
USING source_table s ON (t.id = s.id)
WHEN MATCHED THEN
    UPDATE SET t.name = s.name, t.updated_at = SYSDATE
WHEN NOT MATCHED THEN
    INSERT (id, name, created_at) VALUES (s.id, s.name, SYSDATE);
```

```sql
-- T-SQL MERGE (nearly identical syntax)
MERGE INTO target_table AS t
USING source_table AS s ON t.id = s.id
WHEN MATCHED THEN
    UPDATE SET t.name = s.name, t.updated_at = GETDATE()
WHEN NOT MATCHED THEN
    INSERT (id, name, created_at) VALUES (s.id, s.name, GETDATE());
```

```sql
-- PostgreSQL: INSERT ... ON CONFLICT (upsert)
INSERT INTO target_table (id, name, created_at)
SELECT id, name, now() FROM source_table
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, updated_at = now();
```

### 4.2 Flashback queries

```sql
-- Oracle: Query data as of a past time
SELECT * FROM employees AS OF TIMESTAMP
    TO_TIMESTAMP('2024-01-15 10:00:00', 'YYYY-MM-DD HH24:MI:SS');

-- Oracle: Flashback query with SCN
SELECT * FROM employees AS OF SCN 1234567;
```

```sql
-- T-SQL: Temporal tables (must be pre-configured)
-- 1. Create temporal table
ALTER TABLE employees ADD
    valid_from datetime2 GENERATED ALWAYS AS ROW START NOT NULL DEFAULT SYSUTCDATETIME(),
    valid_to datetime2 GENERATED ALWAYS AS ROW END NOT NULL DEFAULT CAST('9999-12-31 23:59:59.9999999' AS datetime2),
    PERIOD FOR SYSTEM_TIME (valid_from, valid_to);
ALTER TABLE employees SET (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.employees_history));

-- 2. Query historical data
SELECT * FROM employees FOR SYSTEM_TIME AS OF '2024-01-15T10:00:00';
```

```sql
-- PostgreSQL: No built-in temporal tables
-- Use triggers + history table pattern or temporal_tables extension
```

### 4.3 Global temporary tables

```sql
-- Oracle: Global temporary table
CREATE GLOBAL TEMPORARY TABLE temp_results (
    id NUMBER,
    result VARCHAR2(100)
) ON COMMIT DELETE ROWS;  -- or ON COMMIT PRESERVE ROWS
```

```sql
-- T-SQL: Temporary tables
-- Session-scoped (prefix with #)
CREATE TABLE #temp_results (
    id int,
    result nvarchar(100)
);
-- Automatically dropped when session ends

-- Or table variable (for small datasets)
DECLARE @temp_results TABLE (
    id int,
    result nvarchar(100)
);
```

```sql
-- PostgreSQL: Temporary tables
CREATE TEMPORARY TABLE temp_results (
    id integer,
    result varchar(100)
) ON COMMIT DROP;  -- or ON COMMIT DELETE ROWS / ON COMMIT PRESERVE ROWS
```

---

## 5. Schema conversion workflow

### 5.1 Recommended conversion order

```
1. Sequences           (XS effort, no dependencies)
2. Tables + constraints (S effort, defines structure)
3. Indexes             (S effort, after tables)
4. Views               (S-M effort, depends on tables)
5. Functions           (M effort, may depend on types)
6. Procedures          (M effort, may depend on functions)
7. Packages            (M-L effort, decompose to schema + functions/procs)
8. Triggers            (M effort, after tables and procs)
9. Types               (M-L effort, may need redesign)
10. Grants / security  (M effort, after all objects)
```

### 5.2 Validation checklist

- [ ] All tables created with correct data types
- [ ] Primary keys, unique constraints, foreign keys migrated
- [ ] Check constraints migrated and validated
- [ ] Default values converted (SYSDATE to GETDATE()/now(), etc.)
- [ ] Sequences created with correct START WITH and INCREMENT BY
- [ ] Indexes created (review for Azure SQL MI / PostgreSQL optimizer differences)
- [ ] Views converted (syntax changes applied)
- [ ] Functions and procedures converted and unit-tested
- [ ] Packages decomposed to schemas with individual objects
- [ ] Triggers converted (BEFORE to AFTER/INSTEAD OF for SQL Server)
- [ ] Grants and permissions mapped to target RBAC model
- [ ] Row counts match between source and target
- [ ] Key business queries produce identical results

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
