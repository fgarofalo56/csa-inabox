# SQL Migration — Teradata SQL to T-SQL / Spark SQL

> **Audience:** Data engineers and DBAs converting Teradata SQL scripts to Azure-compatible SQL. This guide provides 25+ conversion patterns with before/after code examples, covering the most common Teradata-specific SQL constructs.

---

## 1. Conversion strategy

### Approach

Do not attempt line-by-line translation. Instead:

1. **Classify** each SQL artifact (Tier A/B/C/D per the [migration overview](../teradata.md))
2. **Automate** Tier-A conversions using sqlglot or Microsoft SAMA
3. **Refactor** Tier-B/C conversions manually, converting to dbt models where possible
4. **Decommission** Tier-D artifacts (20-40% of most estates)

### Tools

| Tool                 | Purpose                                          | Coverage                    |
| -------------------- | ------------------------------------------------ | --------------------------- |
| **sqlglot**          | Open-source SQL transpiler                       | 70-80% of syntax conversion |
| **Microsoft SAMA**   | Assessment + automated conversion                | Schema + basic SQL          |
| **dbt + sqlglot**    | Convert BTEQ to dbt models with auto-translation | End-to-end workflow         |
| **Datametica Raven** | Commercial Teradata-specific converter           | 80-90% (paid)               |

### Using sqlglot

```python
import sqlglot

# Teradata → Spark SQL
spark_sql = sqlglot.transpile(
    "SELECT * FROM orders QUALIFY ROW_NUMBER() OVER (PARTITION BY cust_id ORDER BY dt DESC) = 1",
    read="teradata",
    write="spark"
)[0]

# Teradata → T-SQL (Synapse / Fabric)
tsql = sqlglot.transpile(
    "SELECT * FROM orders QUALIFY ROW_NUMBER() OVER (PARTITION BY cust_id ORDER BY dt DESC) = 1",
    read="teradata",
    write="tsql"
)[0]
```

---

## 2. Data type conversions

### Numeric types

| Teradata       | Spark SQL       | T-SQL (Synapse/Fabric) | Notes                        |
| -------------- | --------------- | ---------------------- | ---------------------------- |
| `BYTEINT`      | `TINYINT`       | `TINYINT`              |                              |
| `SMALLINT`     | `SMALLINT`      | `SMALLINT`             |                              |
| `INTEGER`      | `INT`           | `INT`                  |                              |
| `BIGINT`       | `BIGINT`        | `BIGINT`               |                              |
| `DECIMAL(p,s)` | `DECIMAL(p,s)`  | `DECIMAL(p,s)`         | Direct mapping               |
| `FLOAT`        | `DOUBLE`        | `FLOAT`                | Teradata FLOAT = 64-bit      |
| `NUMBER`       | `DECIMAL(38,0)` | `DECIMAL(38,0)`        | Or DECIMAL(p,s) if specified |

### String types

| Teradata     | Spark SQL                | T-SQL            | Notes                     |
| ------------ | ------------------------ | ---------------- | ------------------------- |
| `CHAR(n)`    | `CHAR(n)`                | `CHAR(n)`        | Pad behavior differs      |
| `VARCHAR(n)` | `STRING` or `VARCHAR(n)` | `VARCHAR(n)`     | Spark STRING is unlimited |
| `CLOB`       | `STRING`                 | `VARCHAR(MAX)`   |                           |
| `BYTE(n)`    | `BINARY`                 | `VARBINARY(n)`   |                           |
| `BLOB`       | `BINARY`                 | `VARBINARY(MAX)` |                           |

### Date/time types

| Teradata                   | Spark SQL              | T-SQL            | Notes                           |
| -------------------------- | ---------------------- | ---------------- | ------------------------------- |
| `DATE`                     | `DATE`                 | `DATE`           | Teradata DATE allows arithmetic |
| `TIME`                     | `STRING`               | `TIME`           | Spark lacks native TIME         |
| `TIMESTAMP`                | `TIMESTAMP`            | `DATETIME2`      |                                 |
| `TIMESTAMP WITH TIME ZONE` | `TIMESTAMP`            | `DATETIMEOFFSET` | Spark TIMESTAMP is UTC          |
| `INTERVAL`                 | Compute with functions | `DATEDIFF`       | No direct interval type         |

### Special types

| Teradata       | Spark SQL                            | T-SQL                    | Notes                   |
| -------------- | ------------------------------------ | ------------------------ | ----------------------- |
| `PERIOD(DATE)` | Two DATE columns                     | Two DATE columns         | Model as start/end      |
| `JSON`         | `STRING` (parse with JSON functions) | `NVARCHAR(MAX)`          |                         |
| `XML`          | `STRING`                             | `XML`                    |                         |
| `ST_GEOMETRY`  | Sedona geometry types                | `GEOMETRY` / `GEOGRAPHY` | Requires Sedona library |
| `ARRAY`        | `ARRAY<type>`                        | JSON array in VARCHAR    |                         |

---

## 3. SQL conversion patterns

### Pattern 1: QUALIFY clause

**Teradata:**

```sql
SELECT customer_id, order_date, amount
FROM orders
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) = 1;
```

**Spark SQL (Databricks):**

```sql
-- Option A: QUALIFY is supported in Databricks SQL
SELECT customer_id, order_date, amount
FROM orders
QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) = 1;

-- Option B: Subquery (if targeting older Spark)
SELECT customer_id, order_date, amount
FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS rn
    FROM orders
) t WHERE rn = 1;
```

**T-SQL (Synapse / Fabric):**

```sql
WITH ranked AS (
    SELECT customer_id, order_date, amount,
           ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date DESC) AS rn
    FROM orders
)
SELECT customer_id, order_date, amount FROM ranked WHERE rn = 1;
```

---

### Pattern 2: Date arithmetic

**Teradata:**

```sql
-- Teradata allows integer arithmetic on DATE
SELECT order_date + 30 AS due_date FROM orders;
SELECT order_date - hire_date AS days_employed FROM employees;
SELECT ADD_MONTHS(order_date, 3) AS quarter_end FROM orders;
```

**Spark SQL:**

```sql
SELECT DATE_ADD(order_date, 30) AS due_date FROM orders;
SELECT DATEDIFF(order_date, hire_date) AS days_employed FROM employees;
SELECT ADD_MONTHS(order_date, 3) AS quarter_end FROM orders;
```

**T-SQL:**

```sql
SELECT DATEADD(DAY, 30, order_date) AS due_date FROM orders;
SELECT DATEDIFF(DAY, hire_date, order_date) AS days_employed FROM employees;
SELECT DATEADD(MONTH, 3, order_date) AS quarter_end FROM orders;
```

---

### Pattern 3: CASESPECIFIC and case sensitivity

**Teradata:**

```sql
-- Teradata is case-insensitive for CHAR by default
-- Use (CASESPECIFIC) or (NOT CASESPECIFIC) to override
SELECT * FROM users WHERE username (CASESPECIFIC) = 'Admin';
SELECT * FROM users WHERE city (NOT CASESPECIFIC) = 'new york';
```

**Spark SQL:**

```sql
-- Spark is case-sensitive for string comparisons by default
SELECT * FROM users WHERE username = 'Admin';
SELECT * FROM users WHERE LOWER(city) = 'new york';
```

**T-SQL:**

```sql
-- Synapse uses database collation (case-insensitive by default)
SELECT * FROM users WHERE username = 'Admin' COLLATE Latin1_General_CS_AS;
SELECT * FROM users WHERE city = 'new york'; -- case-insensitive by default
```

---

### Pattern 4: FORMAT phrases

**Teradata:**

```sql
SELECT order_date (FORMAT 'YYYY-MM-DD') FROM orders;
SELECT amount (FORMAT 'ZZZ,ZZ9.99') FROM orders;
SELECT CAST(CURRENT_TIMESTAMP AS VARCHAR(19) FORMAT 'YYYY-MM-DDBHH:MI:SS') AS ts;
```

**Spark SQL:**

```sql
SELECT DATE_FORMAT(order_date, 'yyyy-MM-dd') FROM orders;
SELECT FORMAT_NUMBER(amount, 2) FROM orders;
SELECT DATE_FORMAT(CURRENT_TIMESTAMP(), 'yyyy-MM-dd HH:mm:ss') AS ts;
```

**T-SQL:**

```sql
SELECT FORMAT(order_date, 'yyyy-MM-dd') FROM orders;
SELECT FORMAT(amount, 'N2') FROM orders;
SELECT FORMAT(GETDATE(), 'yyyy-MM-dd HH:mm:ss') AS ts;
```

---

### Pattern 5: SAMPLE clause

**Teradata:**

```sql
-- Random sample: 1000 rows
SELECT * FROM orders SAMPLE 1000;
-- Percentage sample
SELECT * FROM orders SAMPLE 0.10;
-- Stratified sample
SELECT * FROM orders SAMPLE WITH REPLACEMENT WHEN region = 'EAST' THEN 0.20
                                              WHEN region = 'WEST' THEN 0.10;
```

**Spark SQL:**

```sql
-- Row count (approximate)
SELECT * FROM orders TABLESAMPLE (1000 ROWS);
-- Percentage
SELECT * FROM orders TABLESAMPLE (10 PERCENT);
-- Or using DataFrame API for stratified:
-- df.stat.sampleBy("region", {"EAST": 0.2, "WEST": 0.1})
```

**T-SQL:**

```sql
-- Percentage
SELECT * FROM orders TABLESAMPLE (10 PERCENT);
-- Exact row count
SELECT TOP 1000 * FROM orders ORDER BY NEWID();
```

---

### Pattern 6: SEL / SELECT shorthand

**Teradata:**

```sql
SEL customer_id, COUNT(*) FROM orders GROUP BY 1;
SEL TOP 10 * FROM orders ORDER BY order_date DESC;
```

**Spark SQL / T-SQL:**

```sql
-- Replace SEL with SELECT everywhere
SELECT customer_id, COUNT(*) FROM orders GROUP BY 1;
-- TOP is T-SQL only; use LIMIT in Spark
SELECT * FROM orders ORDER BY order_date DESC LIMIT 10;  -- Spark
SELECT TOP 10 * FROM orders ORDER BY order_date DESC;    -- T-SQL
```

---

### Pattern 7: Named columns in GROUP BY

**Teradata:**

```sql
-- Teradata allows GROUP BY column alias
SELECT EXTRACT(YEAR FROM order_date) AS order_year, SUM(amount)
FROM orders
GROUP BY order_year;
```

**Spark SQL:**

```sql
-- Spark allows GROUP BY alias
SELECT YEAR(order_date) AS order_year, SUM(amount)
FROM orders
GROUP BY order_year;
```

**T-SQL:**

```sql
-- T-SQL does NOT allow GROUP BY alias
SELECT YEAR(order_date) AS order_year, SUM(amount)
FROM orders
GROUP BY YEAR(order_date);
```

---

### Pattern 8: TITLE / AS aliasing

**Teradata:**

```sql
SELECT customer_id (TITLE 'Customer ID'), SUM(amount) (TITLE 'Total Sales')
FROM orders GROUP BY 1;
```

**Spark SQL / T-SQL:**

```sql
-- Replace TITLE with AS
SELECT customer_id AS "Customer ID", SUM(amount) AS "Total Sales"
FROM orders GROUP BY customer_id;
```

---

### Pattern 9: COLLECT STATISTICS → ANALYZE TABLE

**Teradata:**

```sql
COLLECT STATISTICS ON orders COLUMN (customer_id);
COLLECT STATISTICS ON orders COLUMN (order_date);
COLLECT STATISTICS ON orders COLUMN (customer_id, order_date);
COLLECT STATISTICS ON orders INDEX (orders_pk);
```

**Spark SQL:**

```sql
ANALYZE TABLE orders COMPUTE STATISTICS;
ANALYZE TABLE orders COMPUTE STATISTICS FOR COLUMNS customer_id, order_date;
-- Delta-specific: OPTIMIZE for file statistics
OPTIMIZE orders ZORDER BY (customer_id, order_date);
```

**T-SQL:**

```sql
-- Synapse auto-creates statistics; manual if needed:
CREATE STATISTICS stat_cust ON orders (customer_id);
CREATE STATISTICS stat_date ON orders (order_date);
UPDATE STATISTICS orders;
```

---

### Pattern 10: VOLATILE TABLE → Temp table

**Teradata:**

```sql
CREATE VOLATILE TABLE tmp_orders AS (
    SELECT customer_id, SUM(amount) AS total
    FROM orders
    WHERE order_date >= DATE - 30
    GROUP BY customer_id
) WITH DATA ON COMMIT PRESERVE ROWS;
```

**Spark SQL:**

```sql
CREATE OR REPLACE TEMPORARY VIEW tmp_orders AS
SELECT customer_id, SUM(amount) AS total
FROM orders
WHERE order_date >= DATE_SUB(CURRENT_DATE(), 30)
GROUP BY customer_id;
```

**T-SQL:**

```sql
SELECT customer_id, SUM(amount) AS total
INTO #tmp_orders
FROM orders
WHERE order_date >= DATEADD(DAY, -30, GETDATE())
GROUP BY customer_id;
```

---

### Pattern 11: MERGE with multiple match conditions

**Teradata:**

```sql
MERGE INTO target t
USING source s ON t.id = s.id
WHEN MATCHED AND s.status = 'D' THEN DELETE
WHEN MATCHED AND s.status = 'U' THEN UPDATE SET t.value = s.value, t.updated_at = CURRENT_TIMESTAMP
WHEN NOT MATCHED THEN INSERT VALUES (s.id, s.value, s.status, CURRENT_TIMESTAMP);
```

**Spark SQL (Delta):**

```sql
MERGE INTO target t
USING source s ON t.id = s.id
WHEN MATCHED AND s.status = 'D' THEN DELETE
WHEN MATCHED AND s.status = 'U' THEN UPDATE SET t.value = s.value, t.updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (id, value, status, updated_at)
    VALUES (s.id, s.value, s.status, CURRENT_TIMESTAMP());
```

**T-SQL:**

```sql
MERGE INTO target AS t
USING source AS s ON t.id = s.id
WHEN MATCHED AND s.status = 'D' THEN DELETE
WHEN MATCHED AND s.status = 'U' THEN UPDATE SET t.value = s.value, t.updated_at = GETDATE()
WHEN NOT MATCHED THEN INSERT (id, value, status, updated_at)
    VALUES (s.id, s.value, s.status, GETDATE());
```

---

### Pattern 12: NORMALIZE / PERIOD operations

**Teradata:**

```sql
-- Normalize overlapping periods
SELECT NORMALIZE customer_id, PERIOD(start_date, end_date) AS coverage
FROM subscriptions;
```

**Spark SQL:**

```sql
-- No NORMALIZE equivalent; use window functions
WITH sorted AS (
    SELECT customer_id, start_date, end_date,
           LAG(end_date) OVER (PARTITION BY customer_id ORDER BY start_date) AS prev_end
    FROM subscriptions
),
grouped AS (
    SELECT *,
           SUM(CASE WHEN prev_end IS NULL OR start_date > prev_end THEN 1 ELSE 0 END)
               OVER (PARTITION BY customer_id ORDER BY start_date) AS grp
    FROM sorted
)
SELECT customer_id, MIN(start_date) AS start_date, MAX(end_date) AS end_date
FROM grouped
GROUP BY customer_id, grp;
```

**Migration effort:** High. NORMALIZE requires significant manual rewrite.

---

### Pattern 13: HASH functions

**Teradata:**

```sql
SELECT HASHROW(customer_id) FROM orders;
SELECT HASHBUCKET(HASHROW(customer_id)) FROM orders;
```

**Spark SQL:**

```sql
SELECT HASH(customer_id) FROM orders;
SELECT MD5(CAST(customer_id AS STRING)) FROM orders;
SELECT SHA2(CAST(customer_id AS STRING), 256) FROM orders;
```

**T-SQL:**

```sql
SELECT HASHBYTES('MD5', CAST(customer_id AS VARCHAR(50))) FROM orders;
SELECT HASHBYTES('SHA2_256', CAST(customer_id AS VARCHAR(50))) FROM orders;
```

---

### Pattern 14: ZEROIFNULL / NULLIFZERO

**Teradata:**

```sql
SELECT ZEROIFNULL(discount) AS discount FROM orders;
SELECT NULLIFZERO(quantity) AS quantity FROM orders;
```

**Spark SQL:**

```sql
SELECT COALESCE(discount, 0) AS discount FROM orders;
SELECT NULLIF(quantity, 0) AS quantity FROM orders;
```

**T-SQL:**

```sql
SELECT ISNULL(discount, 0) AS discount FROM orders;
SELECT NULLIF(quantity, 0) AS quantity FROM orders;
```

---

### Pattern 15: RANK / PARTITION with Teradata extensions

**Teradata:**

```sql
SELECT customer_id, order_date, amount,
       RANK(order_date DESC) AS date_rank,
       CSUM(amount, order_date) AS running_total
FROM orders;
```

**Spark SQL:**

```sql
SELECT customer_id, order_date, amount,
       RANK() OVER (ORDER BY order_date DESC) AS date_rank,
       SUM(amount) OVER (ORDER BY order_date ROWS UNBOUNDED PRECEDING) AS running_total
FROM orders;
```

**T-SQL:**

```sql
SELECT customer_id, order_date, amount,
       RANK() OVER (ORDER BY order_date DESC) AS date_rank,
       SUM(amount) OVER (ORDER BY order_date ROWS UNBOUNDED PRECEDING) AS running_total
FROM orders;
```

---

### Pattern 16: EXTRACT function

**Teradata:**

```sql
SELECT EXTRACT(YEAR FROM order_date) AS yr,
       EXTRACT(MONTH FROM order_date) AS mo,
       EXTRACT(DAY FROM order_date) AS dy
FROM orders;
```

**Spark SQL:**

```sql
SELECT YEAR(order_date) AS yr,
       MONTH(order_date) AS mo,
       DAY(order_date) AS dy
FROM orders;
-- EXTRACT also works: EXTRACT(YEAR FROM order_date)
```

**T-SQL:**

```sql
SELECT YEAR(order_date) AS yr,
       MONTH(order_date) AS mo,
       DAY(order_date) AS dy
FROM orders;
-- Or: DATEPART(YEAR, order_date)
```

---

### Pattern 17: String functions

| Teradata                    | Spark SQL                  | T-SQL                      |
| --------------------------- | -------------------------- | -------------------------- |
| `TRIM(BOTH FROM col)`       | `TRIM(col)`                | `LTRIM(RTRIM(col))`        |
| `INDEX(str, substr)`        | `INSTR(str, substr)`       | `CHARINDEX(substr, str)`   |
| `SUBSTR(str, pos, len)`     | `SUBSTRING(str, pos, len)` | `SUBSTRING(str, pos, len)` |
| `OREPLACE(str, old, new)`   | `REPLACE(str, old, new)`   | `REPLACE(str, old, new)`   |
| `OTRANSLATE(str, from, to)` | `TRANSLATE(str, from, to)` | Custom function            |
| `CHAR2HEXINT(str)`          | `HEX(str)`                 | `CONVERT(VARBINARY, str)`  |
| `CHARACTERS(str)`           | `LENGTH(str)`              | `LEN(str)`                 |

---

### Pattern 18: Teradata HELP commands

**Teradata:**

```sql
HELP DATABASE my_db;
HELP TABLE my_db.orders;
HELP COLUMN my_db.orders.*;
HELP STATISTICS my_db.orders;
```

**Spark SQL:**

```sql
SHOW TABLES IN my_db;
DESCRIBE TABLE EXTENDED my_db.orders;
DESCRIBE TABLE my_db.orders;
SHOW TBLPROPERTIES my_db.orders;
```

**T-SQL:**

```sql
SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'my_db';
EXEC sp_columns @table_name = 'orders';
EXEC sp_helpstats @objname = 'orders';
```

---

### Pattern 19: CAST with Teradata-specific formats

**Teradata:**

```sql
SELECT CAST(order_date AS CHAR(10) FORMAT 'YYYY-MM-DD') FROM orders;
SELECT CAST('2024-01-15' AS DATE FORMAT 'YYYY-MM-DD') AS dt;
SELECT CAST(amount AS FORMAT '$ZZZ,ZZ9.99') FROM orders;
```

**Spark SQL:**

```sql
SELECT DATE_FORMAT(order_date, 'yyyy-MM-dd') FROM orders;
SELECT TO_DATE('2024-01-15', 'yyyy-MM-dd') AS dt;
SELECT FORMAT_NUMBER(amount, 2) FROM orders;
```

**T-SQL:**

```sql
SELECT CONVERT(VARCHAR(10), order_date, 120) FROM orders;
SELECT CAST('2024-01-15' AS DATE) AS dt;
SELECT FORMAT(amount, '$#,##0.00') FROM orders;
```

---

### Pattern 20: Error handling in procedural SQL

**Teradata SPL:**

```sql
CREATE PROCEDURE safe_insert()
BEGIN
    DECLARE CONTINUE HANDLER FOR SQLSTATE '23000'
    BEGIN
        INSERT INTO error_log VALUES (CURRENT_TIMESTAMP, 'Duplicate key');
    END;

    INSERT INTO target SELECT * FROM source;
END;
```

**Spark SQL (Databricks notebook):**

```python
try:
    spark.sql("INSERT INTO target SELECT * FROM source")
except Exception as e:
    spark.sql(f"""
        INSERT INTO error_log VALUES (current_timestamp(), '{str(e)}')
    """)
```

**T-SQL:**

```sql
CREATE PROCEDURE dbo.safe_insert AS
BEGIN
    BEGIN TRY
        INSERT INTO target SELECT * FROM source;
    END TRY
    BEGIN CATCH
        INSERT INTO error_log VALUES (GETDATE(), ERROR_MESSAGE());
    END CATCH
END;
```

---

### Pattern 21: CREATE TABLE AS (CTAS)

**Teradata:**

```sql
CREATE TABLE new_orders AS (
    SELECT * FROM orders WHERE order_date >= DATE '2024-01-01'
) WITH DATA PRIMARY INDEX (customer_id);
```

**Spark SQL:**

```sql
CREATE TABLE new_orders
USING DELTA
PARTITIONED BY (order_month)
AS SELECT *, DATE_FORMAT(order_date, 'yyyy-MM') AS order_month
FROM orders WHERE order_date >= '2024-01-01';
```

**T-SQL:**

```sql
CREATE TABLE new_orders
WITH (
    DISTRIBUTION = HASH(customer_id),
    CLUSTERED COLUMNSTORE INDEX
)
AS SELECT * FROM orders WHERE order_date >= '2024-01-01';
```

---

### Pattern 22: LOCKING modifiers

**Teradata:**

```sql
LOCKING TABLE orders FOR ACCESS
SELECT * FROM orders WHERE order_date = CURRENT_DATE;

LOCKING ROW FOR WRITE
SELECT * FROM orders WHERE order_id = 12345;
```

**Spark SQL:**

```sql
-- Delta Lake uses MVCC; no explicit locking needed
-- Read isolation is automatic
SELECT * FROM orders WHERE order_date = CURRENT_DATE();
```

**T-SQL:**

```sql
-- Synapse: NOLOCK hint (similar to ACCESS lock)
SELECT * FROM orders WITH (NOLOCK) WHERE order_date = CAST(GETDATE() AS DATE);
```

---

### Pattern 23: EXPLAIN / query plan

**Teradata:**

```sql
EXPLAIN SELECT * FROM orders JOIN customers ON orders.customer_id = customers.customer_id;
```

**Spark SQL:**

```sql
EXPLAIN EXTENDED SELECT * FROM orders JOIN customers ON orders.customer_id = customers.customer_id;
EXPLAIN COST SELECT * FROM orders JOIN customers ON orders.customer_id = customers.customer_id;
```

**T-SQL:**

```sql
-- Enable estimated plan
SET SHOWPLAN_XML ON;
SELECT * FROM orders JOIN customers ON orders.customer_id = customers.customer_id;
SET SHOWPLAN_XML OFF;
```

---

### Pattern 24: IDENTITY columns and sequences

**Teradata:**

```sql
CREATE TABLE audit_log (
    log_id INTEGER GENERATED ALWAYS AS IDENTITY,
    event_type VARCHAR(50),
    event_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Spark SQL:**

```sql
CREATE TABLE audit_log (
    log_id BIGINT GENERATED ALWAYS AS IDENTITY,
    event_type STRING,
    event_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
) USING DELTA;
```

**T-SQL:**

```sql
CREATE TABLE audit_log (
    log_id INT IDENTITY(1,1),
    event_type VARCHAR(50),
    event_time DATETIME2 DEFAULT GETDATE()
);
```

---

### Pattern 25: MULTISET operations (EXCEPT, INTERSECT with ALL)

**Teradata:**

```sql
SELECT * FROM table_a EXCEPT ALL SELECT * FROM table_b;
SELECT * FROM table_a INTERSECT ALL SELECT * FROM table_b;
```

**Spark SQL:**

```sql
SELECT * FROM table_a EXCEPT ALL SELECT * FROM table_b;
SELECT * FROM table_a INTERSECT ALL SELECT * FROM table_b;
```

**T-SQL:**

```sql
-- T-SQL supports EXCEPT and INTERSECT but NOT the ALL variant
-- For EXCEPT ALL, use a ROW_NUMBER() workaround:
WITH a AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY col1, col2 ORDER BY (SELECT NULL)) AS rn FROM table_a),
     b AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY col1, col2 ORDER BY (SELECT NULL)) AS rn FROM table_b)
SELECT col1, col2 FROM a
EXCEPT
SELECT col1, col2 FROM b;
```

---

## 4. Stored procedure conversion patterns

### Control flow mapping

| Teradata SPL                        | Spark (Python)                        | T-SQL                              |
| ----------------------------------- | ------------------------------------- | ---------------------------------- |
| `IF ... THEN ... ELSEIF ... END IF` | `if ... elif ... else`                | `IF ... ELSE IF ... ELSE`          |
| `WHILE ... DO ... END WHILE`        | `while ...:`                          | `WHILE ... BEGIN ... END`          |
| `FOR ... DO ... END FOR`            | `for ... in ...:`                     | `WHILE` or cursor loop             |
| `CASE ... WHEN ... END CASE`        | `match ... case` (3.10+) or `if/elif` | `CASE ... WHEN ... END`            |
| `DECLARE cursor FOR SELECT`         | `spark.sql("SELECT ...").collect()`   | `DECLARE cursor CURSOR FOR SELECT` |
| `CALL procedure(args)`              | Function call                         | `EXEC procedure @args`             |
| `LEAVE label`                       | `break`                               | `BREAK`                            |
| `ITERATE label`                     | `continue`                            | `CONTINUE`                         |

### Best practice: convert to dbt models

Most Teradata stored procedures perform transformations that are better expressed as dbt models:

```yaml
# dbt model: models/marts/daily_summary.sql
-- Replaces: CALL sp_update_daily_summary()

{{ config(
    materialized='incremental',
    unique_key='report_date',
    incremental_strategy='merge'
) }}

SELECT
    CURRENT_DATE() AS report_date,
    category,
    SUM(amount) AS total_amount,
    COUNT(*) AS order_count
FROM {{ ref('stg_orders') }}
{% if is_incremental() %}
WHERE order_date >= (SELECT MAX(report_date) FROM {{ this }})
{% endif %}
GROUP BY category
```

---

## 5. Batch conversion workflow

### Step 1: Extract SQL inventory

```bash
# Export all BTEQ/SQL scripts from Teradata
find /path/to/teradata/scripts -name "*.bteq" -o -name "*.sql" | \
    while read f; do
        echo "=== $f ===" >> sql_inventory.txt
        head -50 "$f" >> sql_inventory.txt
    done
```

### Step 2: Classify each script

```python
import sqlglot

def classify_script(sql_text):
    """Classify Teradata SQL by migration difficulty."""
    teradata_features = {
        'QUALIFY': 'A',           # Auto-translatable
        'MERGE INTO': 'A',       # Nearly identical
        'COLLECT STAT': 'A',     # Simple replacement
        'NORMALIZE': 'B',        # Manual rewrite
        'PERIOD(': 'B',          # Schema change needed
        'CASESPECIFIC': 'A',     # Simple removal/addition
        'CREATE PROCEDURE': 'B', # Manual conversion
        'HASHROW': 'A',          # Simple replacement
        'TASM': 'C',             # Architectural change
        'QUERYGRID': 'C',        # Architectural change
    }
    worst = 'A'
    for feature, tier in teradata_features.items():
        if feature in sql_text.upper():
            if tier > worst:
                worst = tier
    return worst
```

### Step 3: Batch transpile Tier-A scripts

```python
import sqlglot
from pathlib import Path

source_dir = Path("teradata_scripts")
output_dir = Path("spark_scripts")
output_dir.mkdir(exist_ok=True)

for sql_file in source_dir.glob("*.sql"):
    with open(sql_file) as f:
        teradata_sql = f.read()
    try:
        spark_sql = sqlglot.transpile(teradata_sql, read="teradata", write="spark")
        with open(output_dir / sql_file.name, "w") as f:
            f.write("\n;\n".join(spark_sql))
        print(f"OK: {sql_file.name}")
    except Exception as e:
        print(f"FAIL: {sql_file.name} - {e}")
```

### Step 4: Validate converted SQL

```python
# Run converted SQL against test data and compare results
def validate_conversion(teradata_result_path, azure_result_path, tolerance=0.001):
    """Compare row counts and checksums between Teradata and Azure outputs."""
    td = pd.read_csv(teradata_result_path)
    az = pd.read_csv(azure_result_path)

    assert len(td) == len(az), f"Row count mismatch: {len(td)} vs {len(az)}"

    for col in td.select_dtypes(include='number').columns:
        td_sum = td[col].sum()
        az_sum = az[col].sum()
        diff = abs(td_sum - az_sum) / max(abs(td_sum), 1)
        assert diff < tolerance, f"Column {col}: {td_sum} vs {az_sum} (diff: {diff:.6f})"

    print("Validation PASSED")
```

---

## 6. Related resources

- [Feature Mapping](feature-mapping-complete.md) — Complete feature-to-feature mapping
- [Tutorial — BTEQ to dbt](tutorial-bteq-to-dbt.md) — Step-by-step BTEQ conversion
- [Data Migration](data-migration.md) — Data loading patterns
- [Teradata Migration Overview](../teradata.md) — SQL translation overview
- sqlglot documentation: <https://github.com/tobymao/sqlglot>
- Microsoft SAMA: <https://aka.ms/sama>

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
