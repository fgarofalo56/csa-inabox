# Oracle to Azure -- Complete Feature Mapping

**50+ Oracle Database features mapped to Azure SQL Managed Instance, Azure Database for PostgreSQL, and Oracle Database@Azure equivalents with migration complexity ratings.**

---

!!! info "How to read this guide"
Each feature is rated for migration complexity: **XS** (trivial, syntax change only), **S** (small, documented pattern), **M** (medium, requires refactoring), **L** (large, significant redesign), **XL** (very large, architectural change). The "CSA-in-a-Box integration" column shows how the feature connects to the analytics platform.

---

## 1. Core SQL and data types

### 1.1 Data types {: #data-types }

| Oracle data type                 | Azure SQL MI equivalent               | PostgreSQL equivalent                 | Conversion notes                                                                          | Complexity |
| -------------------------------- | ------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| `NUMBER(p,s)`                    | `decimal(p,s)` / `int` / `bigint`     | `numeric(p,s)` / `integer` / `bigint` | SSMA auto-maps; choose integer types for whole numbers for performance                    | XS         |
| `NUMBER` (no precision)          | `float(53)`                           | `double precision`                    | Beware: Oracle `NUMBER` without precision is arbitrary precision; `float(53)` is IEEE 754 | S          |
| `VARCHAR2(n)`                    | `nvarchar(n)`                         | `varchar(n)`                          | Azure SQL uses Unicode by default (nvarchar); PostgreSQL varchar is already Unicode       | XS         |
| `NVARCHAR2(n)`                   | `nvarchar(n)`                         | `varchar(n)`                          | Direct mapping; PostgreSQL varchar handles Unicode natively                               | XS         |
| `CHAR(n)`                        | `nchar(n)`                            | `char(n)`                             | Watch for trailing space comparison semantics differences                                 | XS         |
| `DATE`                           | `datetime2(0)`                        | `timestamp(0)`                        | Oracle DATE includes time component; SQL Server DATE does not -- use datetime2            | S          |
| `TIMESTAMP`                      | `datetime2(7)`                        | `timestamp(6)`                        | Precision difference: SQL Server max 7 fractional digits, PostgreSQL max 6                | XS         |
| `TIMESTAMP WITH TIME ZONE`       | `datetimeoffset`                      | `timestamptz`                         | Direct mapping                                                                            | XS         |
| `TIMESTAMP WITH LOCAL TIME ZONE` | `datetime2` + application logic       | `timestamptz`                         | No direct SQL Server equivalent; PostgreSQL timestamptz is close                          | S          |
| `CLOB`                           | `nvarchar(max)`                       | `text`                                | Direct mapping; max 2 GB in all targets                                                   | XS         |
| `BLOB`                           | `varbinary(max)`                      | `bytea`                               | Direct mapping                                                                            | XS         |
| `BFILE`                          | `varbinary(max)` + external reference | `bytea` + external reference          | No direct equivalent; store file content or keep reference to Azure Blob                  | M          |
| `RAW(n)`                         | `varbinary(n)`                        | `bytea`                               | Direct mapping                                                                            | XS         |
| `LONG`                           | `nvarchar(max)`                       | `text`                                | Deprecated in Oracle; migrate to CLOB/nvarchar(max)                                       | S          |
| `LONG RAW`                       | `varbinary(max)`                      | `bytea`                               | Deprecated in Oracle; migrate to BLOB/varbinary(max)                                      | S          |
| `XMLTYPE`                        | `xml`                                 | `xml`                                 | Direct mapping; XQuery syntax differs slightly                                            | S          |
| `SDO_GEOMETRY`                   | `geometry` / `geography`              | `geometry` (PostGIS)                  | Requires PostGIS extension for PostgreSQL; SQL Server has built-in spatial                | M          |
| `ROWID` / `UROWID`               | No equivalent                         | `ctid` (not stable)                   | Physical row identifier; do not migrate -- use logical keys instead                       | M          |
| `INTERVAL YEAR TO MONTH`         | Compute with `DATEDIFF`               | `interval`                            | PostgreSQL has native interval type; SQL Server requires calculation                      | S          |
| `INTERVAL DAY TO SECOND`         | Compute with `DATEDIFF`               | `interval`                            | PostgreSQL has native interval type                                                       | S          |
| `BOOLEAN` (PL/SQL only)          | `bit`                                 | `boolean`                             | Oracle SQL does not have BOOLEAN; PL/SQL does. Both targets support it                    | XS         |
| `JSON` (Oracle 21c+)             | `nvarchar(max)` with JSON functions   | `jsonb`                               | PostgreSQL jsonb is more capable; SQL Server JSON is string-based                         | S          |

### 1.2 SQL syntax differences {: #sql-syntax }

| Oracle SQL feature               | Azure SQL MI equivalent                           | PostgreSQL equivalent                          | Complexity |
| -------------------------------- | ------------------------------------------------- | ---------------------------------------------- | ---------- |
| `SELECT ... FROM DUAL`           | `SELECT ...` (no FROM needed)                     | `SELECT ...` (no FROM needed)                  | XS         |
| `ROWNUM`                         | `ROW_NUMBER() OVER (ORDER BY ...)` or `TOP`       | `ROW_NUMBER() OVER (ORDER BY ...)` or `LIMIT`  | S          |
| `CONNECT BY` / `START WITH`      | Recursive CTE (`WITH RECURSIVE`)                  | Recursive CTE (`WITH RECURSIVE`)               | M          |
| `DECODE(expr, val1, res1, ...)`  | `CASE expr WHEN val1 THEN res1 ...` or `IIF`      | `CASE expr WHEN val1 THEN res1 ...`            | XS         |
| `NVL(expr, default)`             | `ISNULL(expr, default)` or `COALESCE`             | `COALESCE(expr, default)`                      | XS         |
| `NVL2(expr, not_null, null_val)` | `CASE WHEN expr IS NOT NULL THEN ... ELSE ...`    | `CASE WHEN expr IS NOT NULL THEN ... ELSE ...` | XS         |
| `LISTAGG(col, ',')`              | `STRING_AGG(col, ',')`                            | `string_agg(col, ',')`                         | XS         |
| `(+)` outer join syntax          | `LEFT/RIGHT JOIN ... ON`                          | `LEFT/RIGHT JOIN ... ON`                       | S          |
| `MERGE INTO`                     | `MERGE INTO` (same syntax)                        | `INSERT ... ON CONFLICT`                       | S          |
| `SEQUENCE.NEXTVAL`               | `NEXT VALUE FOR sequence`                         | `nextval('sequence')`                          | XS         |
| `SYSDATE`                        | `GETDATE()` or `SYSDATETIME()`                    | `now()` or `current_timestamp`                 | XS         |
| `SYSTIMESTAMP`                   | `SYSDATETIMEOFFSET()`                             | `clock_timestamp()`                            | XS         |
| `TO_DATE('...', 'format')`       | `CONVERT(datetime2, '...', style)` or `TRY_PARSE` | `to_timestamp('...', 'format')`                | S          |
| `TO_CHAR(date, 'format')`        | `FORMAT(date, 'format')`                          | `to_char(date, 'format')`                      | S          |
| `TO_NUMBER('...')`               | `CAST('...' AS decimal)` or `TRY_CAST`            | `'...'::numeric` or `to_number`                | XS         |
| `SUBSTR(str, start, len)`        | `SUBSTRING(str, start, len)`                      | `substr(str, start, len)`                      | XS         |
| `INSTR(str, substr)`             | `CHARINDEX(substr, str)`                          | `position(substr in str)` or `strpos`          | XS         |
| `LENGTH(str)`                    | `LEN(str)`                                        | `length(str)`                                  | XS         |
| `TRUNC(date)`                    | `CAST(date AS date)`                              | `date_trunc('day', date)`                      | XS         |
| `ADD_MONTHS(date, n)`            | `DATEADD(month, n, date)`                         | `date + interval 'n months'`                   | XS         |
| `MONTHS_BETWEEN(d1, d2)`         | `DATEDIFF(month, d2, d1)`                         | `EXTRACT(EPOCH FROM age(d1, d2))/2629746`      | S          |

---

## 2. PL/SQL to T-SQL and PL/pgSQL {: #plsql }

### 2.1 Procedural language constructs

| Oracle PL/SQL                 | Azure SQL T-SQL                               | PostgreSQL PL/pgSQL                      | Complexity |
| ----------------------------- | --------------------------------------------- | ---------------------------------------- | ---------- |
| `CREATE OR REPLACE PROCEDURE` | `CREATE OR ALTER PROCEDURE`                   | `CREATE OR REPLACE PROCEDURE`            | XS         |
| `CREATE OR REPLACE FUNCTION`  | `CREATE OR ALTER FUNCTION`                    | `CREATE OR REPLACE FUNCTION`             | XS         |
| `CREATE OR REPLACE PACKAGE`   | Schema + individual procedures/functions      | Schema + individual procedures/functions | M          |
| `PACKAGE BODY`                | No equivalent (use schema grouping)           | No equivalent (use schema grouping)      | M          |
| `%TYPE`                       | Declare with explicit type                    | Use `%TYPE` (supported in PL/pgSQL)      | S          |
| `%ROWTYPE`                    | Table variable or temp table                  | Use `%ROWTYPE` (supported in PL/pgSQL)   | S          |
| `CURSOR FOR LOOP`             | `DECLARE CURSOR` + `FETCH` + `WHILE`          | `FOR record IN query LOOP`               | S          |
| `BULK COLLECT` + `FORALL`     | Set-based operations (preferred)              | `ARRAY` + set-based operations           | M          |
| `EXCEPTION WHEN`              | `TRY...CATCH`                                 | `EXCEPTION WHEN`                         | S          |
| `RAISE_APPLICATION_ERROR`     | `THROW` or `RAISERROR`                        | `RAISE EXCEPTION`                        | XS         |
| `DBMS_OUTPUT.PUT_LINE`        | `PRINT`                                       | `RAISE NOTICE`                           | XS         |
| `AUTONOMOUS_TRANSACTION`      | Loopback linked server or separate connection | `dblink` extension                       | L          |
| `EXECUTE IMMEDIATE`           | `sp_executesql` or `EXEC`                     | `EXECUTE`                                | S          |
| `REF CURSOR`                  | Output parameter with result set              | `REFCURSOR`                              | S          |
| `SYS_REFCURSOR`               | Result set from stored procedure              | `REFCURSOR`                              | S          |
| `PIPELINED FUNCTION`          | Table-valued function                         | `RETURNS TABLE` function                 | M          |
| `PRAGMA RESTRICT_REFERENCES`  | Not needed                                    | Not needed                               | XS         |
| `DETERMINISTIC`               | `WITH SCHEMABINDING` (for indexed views)      | `IMMUTABLE` / `STABLE`                   | XS         |
| `RESULT_CACHE`                | Query Store + plan cache                      | `pg_prewarm` + shared_buffers            | M          |

### 2.2 PL/SQL package conversion example

Oracle PL/SQL package:

```sql
-- Oracle PL/SQL
CREATE OR REPLACE PACKAGE emp_pkg AS
    FUNCTION get_salary(p_emp_id NUMBER) RETURN NUMBER;
    PROCEDURE update_salary(p_emp_id NUMBER, p_new_salary NUMBER);
    PROCEDURE transfer_employee(p_emp_id NUMBER, p_new_dept NUMBER);
END emp_pkg;
/

CREATE OR REPLACE PACKAGE BODY emp_pkg AS
    FUNCTION get_salary(p_emp_id NUMBER) RETURN NUMBER IS
        v_salary NUMBER;
    BEGIN
        SELECT salary INTO v_salary FROM employees WHERE employee_id = p_emp_id;
        RETURN v_salary;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN NULL;
    END get_salary;

    PROCEDURE update_salary(p_emp_id NUMBER, p_new_salary NUMBER) IS
    BEGIN
        UPDATE employees SET salary = p_new_salary WHERE employee_id = p_emp_id;
        IF SQL%ROWCOUNT = 0 THEN
            RAISE_APPLICATION_ERROR(-20001, 'Employee not found');
        END IF;
    END update_salary;

    PROCEDURE transfer_employee(p_emp_id NUMBER, p_new_dept NUMBER) IS
    BEGIN
        UPDATE employees SET department_id = p_new_dept WHERE employee_id = p_emp_id;
        INSERT INTO transfer_log (employee_id, new_department_id, transfer_date)
        VALUES (p_emp_id, p_new_dept, SYSDATE);
    END transfer_employee;
END emp_pkg;
/
```

Converted to T-SQL (Azure SQL MI):

```sql
-- T-SQL (Azure SQL MI)
-- Package becomes a schema
CREATE SCHEMA emp_pkg;
GO

CREATE OR ALTER FUNCTION emp_pkg.get_salary(@emp_id int)
RETURNS decimal(10,2)
AS
BEGIN
    DECLARE @salary decimal(10,2);
    SELECT @salary = salary FROM dbo.employees WHERE employee_id = @emp_id;
    RETURN @salary;  -- Returns NULL if not found (no exception needed)
END;
GO

CREATE OR ALTER PROCEDURE emp_pkg.update_salary
    @emp_id int,
    @new_salary decimal(10,2)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.employees SET salary = @new_salary WHERE employee_id = @emp_id;
    IF @@ROWCOUNT = 0
        THROW 50001, 'Employee not found', 1;
END;
GO

CREATE OR ALTER PROCEDURE emp_pkg.transfer_employee
    @emp_id int,
    @new_dept int
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;
    BEGIN TRY
        UPDATE dbo.employees SET department_id = @new_dept WHERE employee_id = @emp_id;
        INSERT INTO dbo.transfer_log (employee_id, new_department_id, transfer_date)
        VALUES (@emp_id, @new_dept, GETDATE());
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH;
END;
GO
```

Converted to PL/pgSQL (Azure PostgreSQL):

```sql
-- PL/pgSQL (Azure Database for PostgreSQL)
-- Package becomes a schema
CREATE SCHEMA IF NOT EXISTS emp_pkg;

CREATE OR REPLACE FUNCTION emp_pkg.get_salary(p_emp_id integer)
RETURNS numeric AS $$
DECLARE
    v_salary numeric;
BEGIN
    SELECT salary INTO v_salary FROM employees WHERE employee_id = p_emp_id;
    RETURN v_salary;  -- Returns NULL if not found
EXCEPTION
    WHEN NO_DATA_FOUND THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE PROCEDURE emp_pkg.update_salary(
    p_emp_id integer,
    p_new_salary numeric
) AS $$
BEGIN
    UPDATE employees SET salary = p_new_salary WHERE employee_id = p_emp_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0001';
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE PROCEDURE emp_pkg.transfer_employee(
    p_emp_id integer,
    p_new_dept integer
) AS $$
BEGIN
    UPDATE employees SET department_id = p_new_dept WHERE employee_id = p_emp_id;
    INSERT INTO transfer_log (employee_id, new_department_id, transfer_date)
    VALUES (p_emp_id, p_new_dept, now());
END;
$$ LANGUAGE plpgsql;
```

---

## 3. High availability and disaster recovery {: #high-availability }

| Oracle feature                              | Azure SQL MI                                             | Azure PostgreSQL                        | Oracle DB@Azure              | Complexity |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------- | ---------------------------- | ---------- |
| **Real Application Clusters (RAC)**         | Failover groups (active-passive with auto-failover)      | Zone-redundant HA (synchronous standby) | RAC (native)                 | L          |
| **Active Data Guard**                       | Geo-replication (readable secondary in different region) | Read replicas (up to 5 per region)      | Active Data Guard (native)   | M          |
| **Data Guard (physical standby)**           | Auto-failover groups                                     | Zone-redundant HA                       | Data Guard (native)          | M          |
| **Data Guard Broker**                       | Azure Portal / CLI (automated)                           | Azure Portal / CLI (automated)          | Data Guard Broker (native)   | S          |
| **Fast-Start Failover**                     | Auto-failover groups (< 30s failover)                    | Automatic failover (< 60s)              | Fast-Start Failover (native) | S          |
| **Maximum Availability Architecture (MAA)** | Business Critical tier + geo-replication                 | Zone-redundant + read replicas          | MAA (native)                 | M          |
| **Flashback Database**                      | Point-in-time restore (up to 35 days)                    | Point-in-time recovery (up to 35 days)  | Flashback (native)           | S          |
| **Flashback Table**                         | Temporal tables                                          | No direct equivalent (use PITR)         | Flashback (native)           | M          |
| **Online Redefinition**                     | Online index operations, `ALTER TABLE ... ONLINE`        | `ALTER TABLE` (most operations online)  | Online Redefinition (native) | S          |

!!! note "RAC vs. failover groups"
Oracle RAC provides active-active multi-node clustering where all nodes serve read-write workloads simultaneously. Azure SQL MI failover groups are active-passive with automatic failover. For workloads that genuinely require active-active (rare in practice -- most RAC deployments use one node for reads and one for writes), Oracle Database@Azure retains RAC capability. For the majority of OLTP workloads, active-passive with automatic failover provides equivalent application availability.

---

## 4. Partitioning {: #partitioning }

| Oracle feature                           | Azure SQL MI                            | Azure PostgreSQL                                | Complexity |
| ---------------------------------------- | --------------------------------------- | ----------------------------------------------- | ---------- |
| **Range partitioning**                   | Partition schemes + partition functions | Declarative partitioning (`PARTITION BY RANGE`) | M          |
| **List partitioning**                    | Partition schemes + partition functions | Declarative partitioning (`PARTITION BY LIST`)  | M          |
| **Hash partitioning**                    | Partition schemes + partition functions | Declarative partitioning (`PARTITION BY HASH`)  | M          |
| **Composite partitioning**               | Sub-partitioning with partition schemes | Sub-partitioning (PostgreSQL 13+)               | M          |
| **Interval partitioning**                | Manual + SQL Agent job for auto-create  | `pg_partman` extension for auto-create          | M          |
| **Virtual column partitioning**          | Computed columns + partition schemes    | Generated columns + partitioning                | M          |
| **Partition exchange**                   | `ALTER TABLE ... SWITCH PARTITION`      | `ALTER TABLE ... ATTACH/DETACH PARTITION`       | S          |
| **Partition pruning**                    | Automatic (query optimizer)             | Automatic (query optimizer)                     | XS         |
| **Global indexes on partitioned tables** | Aligned indexes (auto-maintained)       | Global indexes not supported (use local)        | M          |

---

## 5. Materialized views {: #materialized-views }

| Oracle feature                 | Azure SQL MI                                         | Azure PostgreSQL                                                               | Complexity |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- |
| **Materialized view (basic)**  | Indexed views (`CREATE VIEW ... WITH SCHEMABINDING`) | `CREATE MATERIALIZED VIEW`                                                     | M          |
| **Complete refresh**           | Drop + recreate indexed view, or manual table        | `REFRESH MATERIALIZED VIEW`                                                    | S          |
| **Fast refresh (incremental)** | Indexed views auto-refresh on DML                    | `REFRESH MATERIALIZED VIEW CONCURRENTLY` (but not incremental -- full refresh) | M          |
| **Materialized view log**      | No equivalent (indexed views are always current)     | No equivalent (consider logical replication triggers)                          | L          |
| **Query rewrite**              | Automatic for indexed views                          | Not automatic (application must reference MV)                                  | M          |
| **On-demand refresh**          | N/A (indexed views are synchronous)                  | `REFRESH MATERIALIZED VIEW` on schedule                                        | S          |

!!! tip "CSA-in-a-Box alternative"
For analytics workloads, consider replacing Oracle materialized views with **Fabric Mirroring + dbt models**. dbt incremental models in CSA-in-a-Box provide materialization with lineage tracking, testing, and documentation -- a more capable alternative than database-level materialized views for analytics use cases.

---

## 6. Scheduling and automation {: #scheduling }

| Oracle feature               | Azure SQL MI                                              | Azure PostgreSQL                               | Complexity |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------------------- | ---------- |
| **DBMS_SCHEDULER**           | SQL Server Agent jobs                                     | `pg_cron` extension                            | M          |
| **DBMS_JOB** (deprecated)    | SQL Server Agent jobs                                     | `pg_cron` extension                            | M          |
| **Chains (multi-step jobs)** | SQL Agent job steps + `sp_start_job`                      | `pg_cron` + shell scripts or ADF orchestration | M          |
| **Event-based scheduling**   | Event notifications + Service Broker                      | `LISTEN/NOTIFY` + application logic            | M          |
| **External job execution**   | SQL Agent + `xp_cmdshell` (restricted) or Azure Functions | `pg_cron` + Azure Functions                    | M          |
| **Lightweight jobs**         | In-database automation                                    | `pg_cron` for simple schedules                 | S          |

!!! tip "CSA-in-a-Box alternative"
For cross-database orchestration, use **Azure Data Factory pipelines** (`domains/shared/pipelines/adf/`) instead of database-level schedulers. ADF provides visual orchestration, dependency management, retry logic, and monitoring across all Azure data services.

---

## 7. Full-text search {: #full-text-search }

| Oracle feature                     | Azure SQL MI                                      | Azure PostgreSQL                                | Complexity |
| ---------------------------------- | ------------------------------------------------- | ----------------------------------------------- | ---------- |
| **Oracle Text (CONTEXT index)**    | Full-Text Search (FTS) with `CONTAINS`            | `tsvector` + `tsquery` with GIN index           | M          |
| **CTXCAT index**                   | Full-Text Search with catalog                     | `tsvector` with weighted ranking                | M          |
| **CTXRULE index**                  | No equivalent (use application logic)             | No equivalent                                   | L          |
| **CONTAINS query**                 | `CONTAINS(col, 'term')`                           | `col @@ to_tsquery('term')`                     | S          |
| **NEAR operator**                  | `CONTAINS(col, 'NEAR((term1, term2), distance)')` | `phraseto_tsquery` or `tsquery` with positional | M          |
| **Thesaurus**                      | Thesaurus file for FTS                            | `ts_rewrite` or synonym dictionaries            | M          |
| **AUTO_FILTER (binary documents)** | IFilter for binary documents                      | `tika` or external parser                       | L          |

---

## 8. Messaging and queuing {: #messaging }

| Oracle feature                       | Azure SQL MI                                          | Azure PostgreSQL                                   | Complexity |
| ------------------------------------ | ----------------------------------------------------- | -------------------------------------------------- | ---------- |
| **Advanced Queuing (AQ)**            | Service Broker (in-database) or **Azure Service Bus** | `LISTEN/NOTIFY` + **Azure Service Bus**            | L          |
| **AQ with JMS**                      | Azure Service Bus (JMS-compatible)                    | Azure Service Bus (JMS-compatible)                 | M          |
| **AQ multi-consumer**                | Service Bus topics/subscriptions                      | Service Bus topics/subscriptions                   | M          |
| **AQ transactional enqueue/dequeue** | Service Broker (transactional)                        | `LISTEN/NOTIFY` (non-transactional) or Service Bus | L          |
| **Streams (deprecated)**             | Change Data Capture (CDC)                             | Logical replication                                | M          |
| **Change Data Capture**              | SQL Server CDC                                        | Logical decoding + `wal2json`                      | M          |

!!! warning "Advanced Queuing migration"
Oracle AQ with complex routing, multi-consumer topics, and transactional semantics is one of the most challenging Oracle features to migrate. **Azure Service Bus** is the recommended replacement for enterprise messaging. In-database alternatives (Service Broker, LISTEN/NOTIFY) work for simple patterns but do not match AQ's full capability. Plan additional effort for AQ-heavy applications.

---

## 9. Security features {: #security }

| Oracle feature                        | Azure SQL MI                               | Azure PostgreSQL                       | Complexity |
| ------------------------------------- | ------------------------------------------ | -------------------------------------- | ---------- |
| **Transparent Data Encryption (TDE)** | TDE (included, no extra cost)              | Storage encryption (AES-256, included) | XS         |
| **TDE with customer-managed keys**    | TDE with Azure Key Vault                   | Customer-managed keys with Key Vault   | S          |
| **Virtual Private Database (VPD)**    | Row-Level Security (RLS)                   | Row-Level Security (RLS)               | M          |
| **Oracle Label Security (OLS)**       | RLS with classification column             | RLS with classification column         | L          |
| **Data Redaction**                    | Dynamic Data Masking                       | `anon` extension or application-level  | M          |
| **Database Vault**                    | Azure RBAC + no `sa` access on MI          | `pg_hba.conf` + role separation        | M          |
| **Fine-Grained Auditing (FGA)**       | SQL Server Audit + Azure Monitor           | `pgAudit` extension + Azure Monitor    | M          |
| **Unified Auditing**                  | Azure SQL Auditing (to blob/Log Analytics) | `pgAudit` + Log Analytics              | M          |
| **Network Encryption (sqlnet.ora)**   | TLS 1.2+ enforced by default               | TLS 1.2+ enforced by default           | XS         |
| **Wallet / External Password Store**  | Azure Key Vault + managed identity         | Azure Key Vault + managed identity     | S          |
| **Kerberos authentication**           | Entra ID (Kerberos-compatible)             | Entra ID / SCRAM-SHA-256               | M          |
| **Proxy authentication**              | Entra ID managed identity                  | Entra ID managed identity              | M          |

See [Security Migration](security-migration.md) for detailed conversion patterns.

---

## 10. Spatial features {: #spatial }

| Oracle feature                        | Azure SQL MI                             | Azure PostgreSQL                              | Complexity |
| ------------------------------------- | ---------------------------------------- | --------------------------------------------- | ---------- |
| **SDO_GEOMETRY**                      | `geometry` / `geography` types           | PostGIS `geometry` / `geography`              | M          |
| **Spatial indexes (R-tree)**          | Spatial index                            | GiST index on geometry column                 | S          |
| **SDO_RELATE**                        | `.STIntersects()`, `.STContains()`, etc. | `ST_Intersects()`, `ST_Contains()`, etc.      | S          |
| **SDO_WITHIN_DISTANCE**               | `.STDistance() < threshold`              | `ST_DWithin(geom, geom, distance)`            | S          |
| **SDO_NN (nearest neighbor)**         | `.STDistance()` with `TOP`               | `<->` KNN operator with `ORDER BY`            | S          |
| **SDO_UTIL.TO_GEOJSON**               | `.STAsGeoJSON()` (SQL Server 2016+)      | `ST_AsGeoJSON()`                              | XS         |
| **Coordinate system transformations** | Limited built-in                         | `ST_Transform()` (comprehensive SRID support) | M          |
| **Linear referencing**                | Limited                                  | `ST_LineLocatePoint()`, `ST_LineSubstring()`  | M          |
| **Network data model**                | Not built-in                             | pgRouting extension                           | L          |
| **Raster data**                       | Not built-in                             | PostGIS Raster                                | L          |

!!! tip "PostGIS advantage"
For spatial-heavy workloads (GIS, geospatial analytics, mapping), **Azure Database for PostgreSQL with PostGIS** provides more comprehensive spatial functionality than Azure SQL MI. PostGIS supports 300+ spatial functions, raster data, topology, 3D geometry, and coordinate system transformations. CSA-in-a-Box integrates spatial data through the GeoAnalytics tutorial (`tutorials/03-geoanalytics-oss/`).

---

## 11. Advanced features {: #advanced }

| Oracle feature                   | Azure SQL MI                             | Azure PostgreSQL                        | Complexity |
| -------------------------------- | ---------------------------------------- | --------------------------------------- | ---------- |
| **In-Memory Column Store**       | In-Memory OLTP (Business Critical tier)  | Columnar extensions (`citus_columnar`)  | M          |
| **Result Cache**                 | Query Store + plan cache                 | `pg_prewarm` + shared_buffers tuning    | M          |
| **Parallel Query**               | Automatic parallelism (query optimizer)  | `max_parallel_workers_per_gather`       | S          |
| **Parallel DML**                 | Automatic for bulk operations            | Limited parallel DML                    | M          |
| **Edition-Based Redefinition**   | Blue-green deployment pattern            | Blue-green deployment pattern           | L          |
| **Multitenant (CDB/PDB)**        | Managed instance per database            | Server per database or schema isolation | M          |
| **JSON support (21c+)**          | `JSON_VALUE`, `JSON_QUERY`, `OPENJSON`   | `jsonb` operators, `jsonpath`           | S          |
| **Graph (SQL Property Graph)**   | Graph tables (SQL Server 2017+)          | Apache AGE extension                    | L          |
| **Blockchain tables (21c+)**     | Ledger tables (SQL Server 2022)          | No equivalent                           | M          |
| **Machine Learning (Oracle ML)** | SQL Server ML Services (R/Python)        | `pgml` extension or Azure ML            | M          |
| **Application Continuity**       | Connection retry logic + failover groups | Connection pooling + retry logic        | M          |
| **Sharding**                     | Elastic database tools                   | Citus distributed tables                | L          |

---

## 12. Triggers and constraints

| Oracle feature                | Azure SQL MI                                        | Azure PostgreSQL                            | Complexity |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------- | ---------- |
| **BEFORE triggers**           | `INSTEAD OF` triggers on views, or convert to AFTER | `BEFORE` triggers (native support)          | S          |
| **AFTER triggers**            | `AFTER` triggers                                    | `AFTER` triggers                            | XS         |
| **INSTEAD OF triggers**       | `INSTEAD OF` triggers on views                      | `INSTEAD OF` triggers on views              | XS         |
| **Statement-level triggers**  | Statement-level triggers (default)                  | Statement-level triggers                    | XS         |
| **Row-level triggers**        | Row-level triggers (using `INSERTED`/`DELETED`)     | Row-level triggers (`FOR EACH ROW`)         | S          |
| **Compound triggers**         | Multiple separate triggers                          | Multiple separate triggers                  | M          |
| **Mutating table workaround** | Not needed (SQL Server handles differently)         | Not needed (PostgreSQL handles differently) | S          |
| **System triggers (DDL)**     | DDL triggers, event notifications                   | Event triggers (`DDL_COMMAND_END`)          | M          |
| **CHECK constraints**         | `CHECK` constraints                                 | `CHECK` constraints                         | XS         |
| **DEFAULT values**            | `DEFAULT` clause                                    | `DEFAULT` clause                            | XS         |

---

## 13. Backup and recovery

| Oracle feature                | Azure SQL MI                   | Azure PostgreSQL                 | Complexity |
| ----------------------------- | ------------------------------ | -------------------------------- | ---------- |
| **RMAN backup**               | Automated (Azure-managed)      | Automated (Azure-managed)        | XS         |
| **RMAN incremental backup**   | Automated differential backups | Automated (WAL-based continuous) | XS         |
| **Point-in-time recovery**    | Up to 35-day retention         | Up to 35-day retention           | XS         |
| **Tablespace-level recovery** | Database-level restore         | Database-level restore           | S          |
| **Data Pump (expdp/impdp)**   | `BACPAC` export/import or BCP  | `pg_dump` / `pg_restore`         | S          |
| **Flashback Database**        | Point-in-time restore          | Point-in-time recovery           | S          |
| **Cross-region backup**       | Geo-redundant backup storage   | Geo-redundant backup storage     | XS         |

---

## 14. Migration tooling summary

| Tool                                       | Source                         | Target                          | What it does                                  |
| ------------------------------------------ | ------------------------------ | ------------------------------- | --------------------------------------------- |
| **SSMA for Oracle**                        | Oracle Database                | Azure SQL MI / SQL Server       | Schema assessment, conversion, data migration |
| **ora2pg**                                 | Oracle Database                | PostgreSQL                      | Schema assessment, conversion, data migration |
| **Azure Database Migration Service (DMS)** | Oracle Database                | Azure SQL MI / PostgreSQL       | Online and offline data migration             |
| **Azure Data Factory**                     | Oracle Database                | Any Azure target                | Batch data movement, orchestration            |
| **Oracle Data Pump + AzCopy**              | Oracle Database                | Azure Blob + target import      | Bulk export/import for large datasets         |
| **Oracle GoldenGate**                      | Oracle Database                | Oracle DB@Azure / other targets | Real-time replication, CDC                    |
| **Oracle Zero Downtime Migration (ZDM)**   | Oracle Database                | Oracle DB@Azure                 | Automated Oracle-to-Oracle migration          |
| **Fabric Mirroring**                       | Azure SQL MI / Oracle DB@Azure | OneLake                         | Near-real-time replication for analytics      |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
