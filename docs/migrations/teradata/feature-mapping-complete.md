# Feature Mapping — Teradata to Azure (Complete)

> **Audience:** Data architects and engineers mapping Teradata capabilities to Azure equivalents. This is the comprehensive reference covering 40+ features with migration guidance for each.

---

## 1. SQL language features

### 1.1 QUALIFY clause

**Teradata:** Native `QUALIFY` filters window function results inline.

```sql
-- Teradata: Get latest order per customer
SELECT customer_id, order_date, amount
FROM orders
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) = 1;
```

**Azure — Databricks / Spark SQL:** `QUALIFY` is supported natively in Databricks SQL (since DBR 12.0+).

```sql
-- Databricks: QUALIFY is supported
SELECT customer_id, order_date, amount
FROM orders
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) = 1;
```

**Azure — Synapse / Fabric T-SQL:** Use a subquery or CTE.

```sql
-- Synapse / Fabric: CTE pattern
WITH ranked AS (
    SELECT customer_id, order_date, amount,
           ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS rn
    FROM orders
)
SELECT customer_id, order_date, amount
FROM ranked
WHERE rn = 1;
```

**Migration effort:** Low. Automated via sqlglot.

---

### 1.2 MERGE statement

**Teradata:** Full ANSI MERGE with Teradata extensions.

```sql
MERGE INTO target_table tgt
USING source_table src
ON tgt.id = src.id
WHEN MATCHED THEN UPDATE SET tgt.value = src.value
WHEN NOT MATCHED THEN INSERT (id, value) VALUES (src.id, src.value);
```

**Azure — Databricks:** Delta Lake `MERGE INTO` with identical syntax.

```sql
MERGE INTO target_table tgt
USING source_table src
ON tgt.id = src.id
WHEN MATCHED THEN UPDATE SET tgt.value = src.value
WHEN NOT MATCHED THEN INSERT (id, value) VALUES (src.id, src.value);
```

**Azure — Synapse / Fabric:** T-SQL `MERGE` with semicolon termination.

```sql
MERGE INTO target_table AS tgt
USING source_table AS src
ON tgt.id = src.id
WHEN MATCHED THEN UPDATE SET tgt.value = src.value
WHEN NOT MATCHED THEN INSERT (id, value) VALUES (src.id, src.value);
```

**Migration effort:** Low. Minor syntax adjustments.

---

### 1.3 COLLECT STATISTICS

**Teradata:** Explicit statistics collection for the optimizer.

```sql
COLLECT STATISTICS ON orders COLUMN (customer_id);
COLLECT STATISTICS ON orders COLUMN (order_date);
COLLECT STATISTICS ON orders INDEX (orders_pk);
```

**Azure — Databricks:** `ANALYZE TABLE` computes Delta statistics.

```sql
ANALYZE TABLE orders COMPUTE STATISTICS FOR COLUMNS customer_id, order_date;
-- Or use OPTIMIZE for file-level statistics
OPTIMIZE orders ZORDER BY (customer_id);
```

**Azure — Synapse:** Automatic statistics creation (or manual).

```sql
CREATE STATISTICS stat_customer ON orders (customer_id);
UPDATE STATISTICS orders;
-- Auto-create is enabled by default
```

**Azure — Fabric:** Automatic statistics managed by the engine.

**Migration effort:** Low. Replace COLLECT STATISTICS scripts with ANALYZE TABLE or rely on automatic statistics.

---

### 1.4 SET vs MULTISET tables

**Teradata:** SET tables reject duplicate rows automatically; MULTISET allows duplicates.

```sql
CREATE SET TABLE unique_customers (...);
CREATE MULTISET TABLE all_events (...);
```

**Azure:** All Delta tables are MULTISET equivalent. For SET table behavior, enforce uniqueness through:

```sql
-- Databricks: MERGE-based dedup or constraints
ALTER TABLE unique_customers ADD CONSTRAINT pk_customer PRIMARY KEY (customer_id);
-- Note: Delta constraints are informational in Databricks, enforced in Fabric

-- dbt approach: unique test
-- schema.yml:
--   models:
--     - name: unique_customers
--       columns:
--         - name: customer_id
--           tests:
--             - unique
--             - not_null
```

**Migration effort:** Medium. Requires identifying SET tables and adding explicit uniqueness enforcement.

---

### 1.5 Temporal tables

**Teradata:** Built-in temporal support with VALIDTIME and TRANSACTIONTIME.

```sql
CREATE TABLE employee_history (
    emp_id INTEGER,
    salary DECIMAL(10,2),
    valid_start DATE,
    valid_end DATE
) PRIMARY INDEX (emp_id);

-- Temporal query
SELECT * FROM employee_history
WHERE VALIDTIME AS OF DATE '2024-01-01';
```

**Azure — Databricks:** Use Delta time travel for transaction-time queries.

```sql
-- Delta time travel (transaction time)
SELECT * FROM employee_history VERSION AS OF 3;
SELECT * FROM employee_history TIMESTAMP AS OF '2024-01-01';

-- For valid-time (application time), model explicitly:
SELECT * FROM employee_history
WHERE '2024-01-01' BETWEEN valid_start AND valid_end;
```

**Azure — Synapse:** Temporal tables supported in T-SQL.

```sql
CREATE TABLE employee_history (
    emp_id INT PRIMARY KEY,
    salary DECIMAL(10,2),
    valid_start DATETIME2 GENERATED ALWAYS AS ROW START,
    valid_end DATETIME2 GENERATED ALWAYS AS ROW END,
    PERIOD FOR SYSTEM_TIME (valid_start, valid_end)
) WITH (SYSTEM_VERSIONING = ON);
```

**Migration effort:** Medium. Transaction-time maps to Delta time travel. Valid-time requires explicit modeling or Synapse temporal tables.

---

### 1.6 Recursive views / CTEs

**Teradata:** Recursive views with Teradata-specific syntax.

```sql
CREATE RECURSIVE VIEW org_hierarchy AS (
    SELECT emp_id, manager_id, emp_name, 1 AS lvl
    FROM employees WHERE manager_id IS NULL
    UNION ALL
    SELECT e.emp_id, e.manager_id, e.emp_name, h.lvl + 1
    FROM employees e JOIN org_hierarchy h ON e.manager_id = h.emp_id
);
```

**Azure — Databricks:** Recursive CTEs supported (Spark 3.4+ / DBR 13.0+).

```sql
WITH RECURSIVE org_hierarchy AS (
    SELECT emp_id, manager_id, emp_name, 1 AS lvl
    FROM employees WHERE manager_id IS NULL
    UNION ALL
    SELECT e.emp_id, e.manager_id, e.emp_name, h.lvl + 1
    FROM employees e JOIN org_hierarchy h ON e.manager_id = h.emp_id
)
SELECT * FROM org_hierarchy;
```

**Azure — Synapse / Fabric:** Standard T-SQL recursive CTE.

```sql
WITH org_hierarchy AS (
    SELECT emp_id, manager_id, emp_name, 1 AS lvl
    FROM employees WHERE manager_id IS NULL
    UNION ALL
    SELECT e.emp_id, e.manager_id, e.emp_name, h.lvl + 1
    FROM employees e JOIN org_hierarchy h ON e.manager_id = h.emp_id
)
SELECT * FROM org_hierarchy
OPTION (MAXRECURSION 100);
```

**Migration effort:** Low. Syntax is nearly identical.

---

## 2. Data loading and ETL tools

### 2.1 TPT (Teradata Parallel Transporter)

**Teradata:** High-throughput parallel data loading/extraction.

**Azure equivalents:**

| TPT operator | Azure equivalent | Notes |
| --- | --- | --- |
| Load operator (bulk insert) | ADF Copy Activity (bulk) | JDBC or Parquet staging |
| Update operator (upsert) | ADF + Delta MERGE | ADF loads to staging, dbt/SQL merges |
| Export operator | ADF Copy Activity (extract) | JDBC from Teradata source |
| Stream operator (real-time) | Event Hubs + Spark Streaming | Different architecture entirely |
| SQL operator | ADF Stored Procedure activity | Or dbt run |

**Migration effort:** High. TPT scripts must be redesigned as ADF pipelines + dbt models. See [Tutorial — TPT to ADF](tutorial-tpt-to-adf.md).

---

### 2.2 BTEQ (Basic Teradata Query)

**Teradata:** Interactive/batch SQL execution with scripting, error handling, flow control.

```sql
.LOGON server/user,password
.SET WIDTH 200
DATABASE my_db;
SELECT COUNT(*) FROM orders;
.IF ERRORCODE <> 0 THEN .GOTO ERROR_HANDLER
.EXPORT FILE=output.csv
SELECT * FROM summary;
.EXPORT RESET
.LOGOFF
```

**Azure equivalents:**

| BTEQ feature | Azure equivalent |
| --- | --- |
| SQL execution | dbt model / Databricks notebook / Synapse SQL script |
| Error handling (.IF ERRORCODE) | dbt tests / ADF error handling / try-except in notebooks |
| Export to file | ADF Copy Activity / Spark DataFrame write / CETAS |
| Variable substitution | dbt Jinja variables / ADF parameters |
| Scheduling | ADF triggers / Databricks Jobs / dbt Cloud scheduler |

**Migration effort:** High. BTEQ scripts are the bulk of migration work. See [Tutorial — BTEQ to dbt](tutorial-bteq-to-dbt.md).

---

### 2.3 FastLoad

**Teradata:** High-speed bulk loading into empty tables (no indexes, no triggers).

```
.LOGON server/user,password
.BEGIN LOADING orders_staging;
.LAYOUT order_layout;
INSERT INTO orders_staging VALUES (:col1, :col2, :col3);
.END LOADING;
```

**Azure:** ADF Copy Activity with bulk insert mode.

```json
{
  "type": "Copy",
  "source": { "type": "DelimitedTextSource" },
  "sink": {
    "type": "DeltaLakeSink",
    "writeBatchSize": 1000000,
    "tableActionOption": "Overwrite"
  }
}
```

**Migration effort:** Medium. Conceptual mapping is direct; implementation differs.

---

### 2.4 MultiLoad

**Teradata:** Batch load into populated tables with INSERT, UPDATE, DELETE, UPSERT.

**Azure:** ADF Copy Activity → staging table → Delta MERGE.

```sql
-- Step 1: ADF loads data to staging
-- Step 2: Delta MERGE handles upsert
MERGE INTO target USING staging
ON target.id = staging.id
WHEN MATCHED AND staging.action = 'D' THEN DELETE
WHEN MATCHED AND staging.action = 'U' THEN UPDATE SET *
WHEN NOT MATCHED AND staging.action = 'I' THEN INSERT *;
```

**Migration effort:** Medium. Pattern is well-established in Azure.

---

## 3. Workload management

### 3.1 TASM (Teradata Active System Management)

**Teradata:** Classification rules, workload groups, priority, throttles, exceptions.

**Azure mapping:**

| TASM concept | Synapse | Databricks | Fabric |
| --- | --- | --- | --- |
| Workload class | Resource class | SQL warehouse size | Capacity allocation |
| Priority level | Workload importance | Warehouse priority | Not directly available |
| Throttle rule | Concurrency slots | Max clusters cap | Capacity smoothing |
| Filter rule | Application routing | Warehouse routing | Workspace routing |
| Exception handling | DMV-based monitoring | Query watchdog | Capacity guardrails |

**Migration effort:** High. Requires architectural redesign. See [Workload Migration](workload-migration.md).

---

### 3.2 TIWM (Teradata Intelligent Workload Manager)

**Teradata:** AI-driven workload management that auto-adjusts priorities.

**Azure:** No direct equivalent. Implement via:
- Databricks: Auto-scaling SQL warehouses + query queuing
- Synapse: Workload management with workload groups and classifiers
- Custom: Azure Monitor alerts triggering Azure Functions for dynamic adjustment

**Migration effort:** High. Often simplified during migration (which is usually acceptable).

---

## 4. Security and access control

### 4.1 Access logging

**Teradata:** Built-in access logging to DBC.AccessLog, DBC.DeleteAccessLog.

```sql
BEGIN LOGGING ON EACH ALL ON TABLE sensitive_data;
-- Queries against sensitive_data are now logged
SELECT * FROM DBC.AccessLog WHERE TableName = 'sensitive_data';
```

**Azure:** Azure Monitor + Diagnostic Logs + Microsoft Purview.

| Teradata log | Azure equivalent |
| --- | --- |
| DBC.AccessLog | Azure Monitor Diagnostic Logs |
| DBC.DeleteAccessLog | Purview Data Use Management |
| DBQL (Query Log) | Databricks Query History / Synapse DMVs |

**Migration effort:** Medium. Different mechanism, equivalent coverage. See [Security Migration](security-migration.md).

---

### 4.2 Row-level security (RLS)

**Teradata:** Row-level security via views or constraint assignments.

```sql
CREATE VIEW secure_orders AS
SELECT * FROM orders
WHERE region = SESSION.region_access;
```

**Azure — Fabric / Power BI:** Native RLS.

```dax
-- Power BI RLS rule
[Region] = USERPRINCIPALNAME()
-- Or via Fabric SQL:
CREATE SECURITY POLICY region_filter
ADD FILTER PREDICATE dbo.fn_region_access(region) ON dbo.orders;
```

**Azure — Databricks:** Row/column-level filters (Unity Catalog).

```sql
ALTER TABLE orders SET ROW FILTER region_filter ON (region);
```

**Migration effort:** Medium. Different mechanism but well-supported.

---

### 4.3 Column-level security

**Teradata:** Column-level access via GRANT SELECT on specific columns.

```sql
GRANT SELECT (customer_id, order_date) ON orders TO analyst_role;
-- analyst_role cannot see amount, discount columns
```

**Azure — Databricks (Unity Catalog):** Column masking.

```sql
ALTER TABLE orders ALTER COLUMN ssn SET MASK mask_ssn;
```

**Azure — Purview:** Dynamic data masking policies.

**Azure — Synapse:** Dynamic data masking.

```sql
ALTER TABLE orders
ALTER COLUMN ssn ADD MASKED WITH (FUNCTION = 'partial(0,"XXX-XX-",4)');
```

**Migration effort:** Medium. Multiple Azure options depending on target.

---

### 4.4 Teradata roles and profiles

**Teradata:** Database-level roles and profiles.

```sql
CREATE ROLE data_analyst;
GRANT SELECT ON my_db TO data_analyst;
GRANT data_analyst TO user1;

CREATE PROFILE analyst_profile AS
    DEFAULT DATABASE = my_db,
    SPOOL = 1e10,
    TEMPORARY = 1e9;
```

**Azure:** Entra ID groups + RBAC.

| Teradata concept | Azure equivalent |
| --- | --- |
| Role | Entra ID security group |
| Profile (spool, temp limits) | Databricks cluster policies / Synapse resource class |
| Database-level GRANT | Unity Catalog grants / Synapse permissions |
| User | Entra ID user or service principal |

**Migration effort:** Medium. Conceptual mapping is straightforward; implementation requires Entra ID integration.

---

### 4.5 Unity (Teradata ecosystem manager)

**Teradata Unity:** Multi-system coordination, connection management, query routing.

**Azure:** No single equivalent. Distributed across:

| Unity feature | Azure equivalent |
| --- | --- |
| Connection management | Azure Private Link + DNS |
| Query routing | Application-level routing / ADF |
| Multi-system failover | Azure Traffic Manager / Front Door |
| Ecosystem monitoring | Azure Monitor + Grafana |

**Migration effort:** Medium-High. Architectural redesign needed.

---

## 5. Data distribution and indexing

### 5.1 Primary Index (PI)

**Teradata:** Determines data distribution across AMPs. Critical for join performance.

```sql
CREATE TABLE orders (
    order_id INTEGER,
    customer_id INTEGER,
    order_date DATE
) PRIMARY INDEX (customer_id);
```

**Azure mapping:**

| Target | PI equivalent | Configuration |
| --- | --- | --- |
| Synapse Dedicated | Hash distribution column | `DISTRIBUTION = HASH(customer_id)` |
| Databricks Delta | Z-ORDER column | `OPTIMIZE orders ZORDER BY (customer_id)` |
| Fabric Warehouse | Automatic distribution | Engine-managed |

**Migration effort:** Medium. Requires analysis of PI choices and translation to distribution strategy.

---

### 5.2 Partitioned Primary Index (PPI)

**Teradata:** Partition elimination for range queries.

```sql
CREATE TABLE orders (
    order_id INTEGER,
    customer_id INTEGER,
    order_date DATE
) PRIMARY INDEX (customer_id)
  PARTITION BY RANGE_N(order_date BETWEEN DATE '2020-01-01' AND DATE '2030-12-31' EACH INTERVAL '1' MONTH);
```

**Azure:** Delta table partitioning.

```sql
-- Databricks
CREATE TABLE orders (...)
USING DELTA
PARTITIONED BY (order_month);
-- Where order_month is derived: date_format(order_date, 'yyyy-MM')

-- Synapse
CREATE TABLE orders (...)
WITH (
    DISTRIBUTION = HASH(customer_id),
    PARTITION (order_date RANGE RIGHT FOR VALUES ('2020-01-01', '2020-02-01', ...))
);
```

**Migration effort:** Medium. Conceptual mapping is direct; partition granularity may need adjustment.

---

### 5.3 Secondary Index (SI)

**Teradata:** Non-PI access path for queries that do not use the PI column.

```sql
CREATE INDEX idx_order_date ON orders (order_date);
```

**Azure:** No direct equivalent in Delta Lake. Alternatives:

| Strategy | When to use |
| --- | --- |
| Z-ORDER / OPTIMIZE | Frequently filtered columns |
| Bloom filter index | High-cardinality equality filters |
| Materialized view | Repeated aggregation patterns |
| Denormalization | Star schema access patterns |
| Delta file statistics | Automatically maintained, support data skipping |

**Migration effort:** Medium. Requires workload analysis to determine which SIs to replace and how.

---

### 5.4 Join Index (JI)

**Teradata:** Materialized join of two or more tables, automatically maintained.

```sql
CREATE JOIN INDEX ji_order_customer AS
SELECT o.order_id, o.amount, c.customer_name
FROM orders o JOIN customers c ON o.customer_id = c.customer_id
PRIMARY INDEX (order_id);
```

**Azure:**

| Target | JI equivalent |
| --- | --- |
| Databricks | Materialized view (Delta) or dbt incremental model |
| Synapse | Materialized view or indexed view |
| Fabric | Automatic performance optimization (engine-managed) |

**Migration effort:** Medium. Identify JIs and replace with materialized views or dbt models.

---

## 6. Stored procedures, macros, and UDFs

### 6.1 Stored procedures

**Teradata:** SPL (Stored Procedure Language) — SQL + control flow.

```sql
CREATE PROCEDURE update_summary()
BEGIN
    DELETE FROM daily_summary WHERE report_date = CURRENT_DATE;
    INSERT INTO daily_summary
    SELECT CURRENT_DATE, category, SUM(amount)
    FROM orders WHERE order_date = CURRENT_DATE
    GROUP BY category;
END;
```

**Azure equivalents:**

| Approach | Best for |
| --- | --- |
| dbt model (incremental) | Most transformation procedures |
| Databricks notebook | Complex logic with Python |
| Synapse T-SQL stored procedure | Direct translation of simple procedures |
| Azure Function | Event-driven procedures |

**Migration effort:** Medium-High. Each procedure must be analyzed individually.

---

### 6.2 Teradata macros

**Teradata:** Parameterized SQL blocks (simpler than stored procedures).

```sql
CREATE MACRO get_customer_orders (cust_id INTEGER) AS (
    SELECT * FROM orders WHERE customer_id = :cust_id;
);
EXEC get_customer_orders(12345);
```

**Azure:** dbt macros or parameterized views.

```sql
-- dbt macro (macros/get_customer_orders.sql)
{% macro get_customer_orders(cust_id) %}
    SELECT * FROM {{ ref('orders') }} WHERE customer_id = {{ cust_id }}
{% endmacro %}
```

**Migration effort:** Low-Medium. Macros are simpler to convert than stored procedures.

---

### 6.3 UDFs (User Defined Functions)

**Teradata:** SQL UDFs and Java/C UDFs.

```sql
-- SQL UDF
CREATE FUNCTION fiscal_quarter(dt DATE) RETURNS VARCHAR(6)
RETURN CAST(EXTRACT(YEAR FROM dt) AS VARCHAR(4)) || 'Q' ||
       CAST(((EXTRACT(MONTH FROM dt) - 1) / 3 + 1) AS VARCHAR(1));
```

**Azure — Databricks:** Spark UDFs (SQL or Python).

```sql
-- SQL UDF
CREATE FUNCTION fiscal_quarter(dt DATE) RETURNS STRING
RETURN CONCAT(YEAR(dt), 'Q', QUARTER(dt));

-- Python UDF (for complex logic)
-- @udf(returnType=StringType())
-- def fiscal_quarter(dt):
--     return f"{dt.year}Q{(dt.month - 1) // 3 + 1}"
```

**Azure — Synapse:** T-SQL scalar functions.

```sql
CREATE FUNCTION dbo.fiscal_quarter(@dt DATE) RETURNS VARCHAR(6) AS
BEGIN
    RETURN CAST(YEAR(@dt) AS VARCHAR(4)) + 'Q' +
           CAST(DATEPART(QUARTER, @dt) AS VARCHAR(1));
END;
```

**Migration effort:** Medium. SQL UDFs translate easily; Java/C UDFs require rewrite in Python/Scala.

---

### 6.4 UDTs (User Defined Types)

**Teradata:** Custom data types.

**Azure:** Not directly supported in Delta Lake. Model as:
- Struct types in Spark (for nested data)
- JSON columns for flexible schemas
- Domain validation in dbt tests

**Migration effort:** Medium. Requires schema redesign for UDT-heavy schemas.

---

## 7. Monitoring and administration

### 7.1 ViewPoint

**Teradata ViewPoint:** Web-based system monitoring — query performance, space usage, session management.

**Azure equivalents:**

| ViewPoint feature | Azure equivalent |
| --- | --- |
| Query monitor | Databricks Query History / Synapse DMVs |
| Space usage | ADLS Storage Explorer / Delta table DESCRIBE |
| Session management | Databricks SQL Warehouse UI / Synapse portal |
| Alert configuration | Azure Monitor alerts |
| System health | Azure Monitor dashboards / Grafana |
| Workload analysis | Databricks SQL Analytics / Synapse Workload Management |

**Migration effort:** Low-Medium. Azure has equivalent or better monitoring, but dashboards must be rebuilt.

---

### 7.2 QueryGrid

**Teradata QueryGrid:** Federated queries across Teradata, Hadoop, Spark, Presto, other DBs.

```sql
-- Teradata QueryGrid: query Hadoop from Teradata
SELECT * FROM hadoop_server.db.table@hadoop_connector;
```

**Azure:**

| Target | Federation approach |
| --- | --- |
| Synapse Serverless | External tables (ADLS, Cosmos DB, SQL Server) |
| Databricks | Lakehouse Federation (MySQL, PostgreSQL, SQL Server, Snowflake) |
| Fabric | Shortcuts (OneLake, S3, GCS, ADLS) |
| ADF | Copy activities across any supported source |

**Migration effort:** Medium. Federation patterns exist but require redesign.

---

### 7.3 ARC (Archive/Recovery)

**Teradata ARC:** Backup and restore utility.

**Azure:** Platform-managed backups.

| ARC feature | Azure equivalent |
| --- | --- |
| Full backup | ADLS snapshots / Delta CLONE |
| Incremental backup | Delta time travel (automatic) |
| Object-level restore | Delta RESTORE / point-in-time recovery |
| Archive | ADLS lifecycle to Cool/Archive tier |

**Migration effort:** Low. Azure backups are largely automatic.

---

## 8. Advanced features

### 8.1 Compression (multivalue, algorithmic)

**Teradata:** Multi-value compression (MVC), block-level compression, algorithmic compression (ALC).

**Azure:** Delta Lake inherits Parquet compression:
- Snappy compression (default, fast)
- ZSTD compression (better ratio)
- Z-ORDER for data co-location

Synapse: Columnstore compression (automatic, very efficient).

**Migration effort:** Low. Azure compression is automatic and generally more effective.

---

### 8.2 Data dictionary (DBC tables)

**Teradata:** DBC system views (DBC.Tables, DBC.Columns, DBC.Indices, etc.).

```sql
SELECT * FROM DBC.TablesV WHERE DatabaseName = 'my_db';
SELECT * FROM DBC.ColumnsV WHERE DatabaseName = 'my_db' AND TableName = 'orders';
```

**Azure:**

| DBC view | Databricks | Synapse |
| --- | --- | --- |
| DBC.TablesV | INFORMATION_SCHEMA.TABLES / Unity Catalog | INFORMATION_SCHEMA.TABLES |
| DBC.ColumnsV | INFORMATION_SCHEMA.COLUMNS | INFORMATION_SCHEMA.COLUMNS |
| DBC.IndicesV | DESCRIBE EXTENDED / SHOW TBLPROPERTIES | sys.indexes |
| DBC.AccessLog | audit_log (Unity Catalog) | sys.dm_pdw_exec_requests |
| DBC.QryLogV | query_history (system table) | sys.dm_pdw_exec_requests |

**Migration effort:** Low-Medium. Script-based DBC queries need rewriting.

---

### 8.3 Global temporary tables

**Teradata:** Volatile and global temporary tables.

```sql
CREATE VOLATILE TABLE tmp_calc AS (...) WITH DATA ON COMMIT PRESERVE ROWS;
CREATE GLOBAL TEMPORARY TABLE shared_tmp (...);
```

**Azure — Databricks:** Temporary views or Delta tables in a temp schema.

```sql
CREATE OR REPLACE TEMPORARY VIEW tmp_calc AS SELECT ...;
-- Or use Delta table in a temp database
CREATE TABLE temp.tmp_calc AS SELECT ...;
```

**Azure — Synapse:** T-SQL temporary tables.

```sql
CREATE TABLE #tmp_calc AS SELECT ...;
-- Global temp tables
CREATE TABLE ##shared_tmp (...);
```

**Migration effort:** Low. Direct equivalents available.

---

## 9. Quick reference matrix

| # | Teradata feature | Azure equivalent | Effort |
| --- | --- | --- | --- |
| 1 | QUALIFY | Databricks native / CTE pattern | Low |
| 2 | MERGE | Delta MERGE / T-SQL MERGE | Low |
| 3 | COLLECT STATISTICS | ANALYZE TABLE / auto-stats | Low |
| 4 | SET tables | Constraints + dbt unique test | Medium |
| 5 | Temporal tables | Delta time travel / Synapse temporal | Medium |
| 6 | Recursive views | Recursive CTE | Low |
| 7 | TPT | ADF Copy Activity + dbt | High |
| 8 | BTEQ | dbt models + ADF orchestration | High |
| 9 | FastLoad | ADF bulk copy | Medium |
| 10 | MultiLoad | ADF + Delta MERGE | Medium |
| 11 | TASM | Multiple warehouses + routing | High |
| 12 | TIWM | Auto-scaling + monitoring | High |
| 13 | Access logging | Azure Monitor + Purview | Medium |
| 14 | Row-level security | Fabric RLS / Unity Catalog | Medium |
| 15 | Column-level security | Dynamic masking / column masks | Medium |
| 16 | Roles/profiles | Entra ID groups + RBAC | Medium |
| 17 | Unity | Azure networking + routing | Medium-High |
| 18 | Primary Index | Distribution/Z-ORDER | Medium |
| 19 | PPI | Delta partitioning | Medium |
| 20 | Secondary Index | Z-ORDER/bloom filters | Medium |
| 21 | Join Index | Materialized views / dbt | Medium |
| 22 | Stored procedures | dbt models / notebooks | Medium-High |
| 23 | Macros | dbt macros | Low-Medium |
| 24 | SQL UDFs | Spark SQL UDFs / T-SQL functions | Medium |
| 25 | Java/C UDFs | Python/Scala UDFs | High |
| 26 | UDTs | Structs / JSON | Medium |
| 27 | ViewPoint | Azure Monitor / Grafana | Low-Medium |
| 28 | QueryGrid | Lakehouse Federation / external tables | Medium |
| 29 | ARC | Delta time travel / ADLS snapshots | Low |
| 30 | Compression (MVC) | Parquet/columnstore (automatic) | Low |
| 31 | DBC views | INFORMATION_SCHEMA / system tables | Low-Medium |
| 32 | Volatile tables | Temp views / temp tables | Low |
| 33 | Global temp tables | Temp schema / T-SQL ## tables | Low |
| 34 | CASESPECIFIC | Default case-sensitive in Spark | Low |
| 35 | FORMAT phrases | CAST + DATE_FORMAT | Low |
| 36 | SAMPLE clause | TABLESAMPLE | Low |
| 37 | NORMALIZE | Custom window function logic | Medium |
| 38 | PERIOD data type | Two DATE/TIMESTAMP columns | Medium |
| 39 | Geospatial (ST_Geometry) | Sedona (Spark) / T-SQL geography | Medium |
| 40 | JSON support (JSON/JSONB) | Native JSON in Spark / OPENJSON in T-SQL | Low |
| 41 | XML support | Spark XML / T-SQL XML methods | Medium |
| 42 | HASH functions | Spark hash/md5/sha2 / T-SQL HASHBYTES | Low |
| 43 | NAMED pipe | ADF streaming / Event Hubs | High |

---

## 10. Related resources

- [SQL Migration](sql-migration.md) — Detailed conversion patterns with before/after code
- [Data Migration](data-migration.md) — TPT/BTEQ replacement patterns
- [Workload Migration](workload-migration.md) — TASM/TIWM replacement
- [Security Migration](security-migration.md) — Access control mapping
- [Teradata Migration Overview](../teradata.md) — Original feature mapping table

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
