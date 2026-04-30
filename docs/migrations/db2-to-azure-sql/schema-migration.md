# Schema Migration -- IBM Db2 to Azure SQL

**Audience:** DBAs, Database Engineers, Migration Engineers
**Purpose:** Detailed guide for converting Db2 schemas to T-SQL, including data type mapping, SQL syntax differences, table structures, indexes, and constraints.

---

## Migration tool: SSMA for Db2

SQL Server Migration Assistant (SSMA) for Db2 is the primary tool for schema conversion. SSMA connects to Db2 for z/OS (via DRDA), Db2 for LUW (direct or DRDA), and Db2 for iSeries (via DRDA), reads the catalog, and generates T-SQL DDL. For most schemas, SSMA converts 70-85% of objects automatically. The remaining 15-30% requires manual intervention, primarily around Db2-specific data types, SQL syntax patterns, and stored procedure logic.

This guide covers the manual conversion patterns you will encounter after running SSMA.

---

## 1. Data type mapping reference

### Numeric types

| Db2 type       | T-SQL type      | Notes                                                                     |
| -------------- | --------------- | ------------------------------------------------------------------------- |
| `SMALLINT`     | `SMALLINT`      | 1:1 (-32,768 to 32,767)                                                   |
| `INTEGER`      | `INT`           | 1:1                                                                       |
| `BIGINT`       | `BIGINT`        | 1:1                                                                       |
| `DECIMAL(p,s)` | `DECIMAL(p,s)`  | 1:1; max precision 31 in Db2, 38 in SQL Server                            |
| `NUMERIC(p,s)` | `NUMERIC(p,s)`  | 1:1                                                                       |
| `REAL`         | `REAL`          | 1:1 (single-precision float)                                              |
| `DOUBLE`       | `FLOAT(53)`     | 1:1 semantically                                                          |
| `DECFLOAT(16)` | `DECIMAL(16,s)` | No direct DECFLOAT. Choose scale based on usage. Test rounding carefully. |
| `DECFLOAT(34)` | `DECIMAL(34,s)` | Same as above. Consider `FLOAT` if exact decimal semantics not required.  |

**DECFLOAT conversion guidance:** DECFLOAT is an IEEE 754 decimal floating-point type that preserves decimal precision. SQL Server has no equivalent. The safest mapping is to `DECIMAL(p,s)` with a scale determined by the maximum fractional digits in the data. Run this query on Db2 to determine actual precision usage:

```sql
-- Db2: analyze DECFLOAT column precision
SELECT
    MAX(LENGTH(STRIP(CAST(decfloat_col AS VARCHAR(50)), TRAILING, '0')) -
        POSSTR(CAST(decfloat_col AS VARCHAR(50)), '.')) AS max_scale
FROM your_table
WHERE decfloat_col IS NOT NULL;
```

### Character and string types

| Db2 type        | T-SQL type       | Notes                                                    |
| --------------- | ---------------- | -------------------------------------------------------- |
| `CHAR(n)`       | `CHAR(n)`        | Max 254 in Db2 vs 8000 in T-SQL. 1:1.                    |
| `VARCHAR(n)`    | `VARCHAR(n)`     | Max 32672 in Db2. If n > 8000, map to `VARCHAR(MAX)`.    |
| `LONG VARCHAR`  | `VARCHAR(MAX)`   | Deprecated in Db2.                                       |
| `CLOB(n)`       | `VARCHAR(MAX)`   | CLOB up to 2 GB maps to VARCHAR(MAX) up to 2 GB.         |
| `GRAPHIC(n)`    | `NCHAR(n)`       | GRAPHIC stores DBCS (double-byte). NCHAR stores Unicode. |
| `VARGRAPHIC(n)` | `NVARCHAR(n)`    | Variable-length DBCS to Unicode.                         |
| `DBCLOB(n)`     | `NVARCHAR(MAX)`  | Double-byte CLOB to Unicode MAX.                         |
| `BLOB(n)`       | `VARBINARY(MAX)` | Binary large object. 1:1 semantically.                   |

**EBCDIC consideration (z/OS):** Db2 for z/OS stores character data in EBCDIC encoding. Azure SQL uses Unicode (UTF-16). All character data must be converted during migration. SSMA handles this automatically for standard code pages (CCSID 037 for US EBCDIC, CCSID 500 for international EBCDIC). Custom code pages or mixed EBCDIC/ASCII columns require manual validation. See [Mainframe Considerations](mainframe-considerations.md) for the full EBCDIC conversion guide.

### Date and time types

| Db2 type                               | T-SQL type                            | Notes                                                                                                                                 |
| -------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `DATE`                                 | `DATE`                                | 1:1                                                                                                                                   |
| `TIME`                                 | `TIME`                                | 1:1                                                                                                                                   |
| `TIMESTAMP`                            | `DATETIME2(7)`                        | Db2 TIMESTAMP supports up to 12 fractional seconds. DATETIME2 supports up to 7. Truncation from 12 to 7 digits is usually acceptable. |
| `TIMESTAMP(0)` through `TIMESTAMP(6)`  | `DATETIME2(0)` through `DATETIME2(6)` | Precision maps directly up to 6.                                                                                                      |
| `TIMESTAMP(7)` through `TIMESTAMP(12)` | `DATETIME2(7)`                        | All mapped to max T-SQL precision of 7.                                                                                               |
| `TIMESTAMP WITH TIME ZONE`             | `DATETIMEOFFSET`                      | 1:1 semantically                                                                                                                      |

### Other types

| Db2 type  | T-SQL type                              | Notes                                                                                 |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `XML`     | `XML`                                   | 1:1. XQuery support in both.                                                          |
| `BOOLEAN` | `BIT`                                   | TRUE/FALSE/NULL maps to 1/0/NULL.                                                     |
| `ROWID`   | `UNIQUEIDENTIFIER` or `BIGINT IDENTITY` | Context-dependent. Use IDENTITY for sequential, UNIQUEIDENTIFIER for globally unique. |

---

## 2. SQL syntax conversion patterns

### Row limiting

```sql
-- Db2
SELECT * FROM employees
ORDER BY hire_date DESC
FETCH FIRST 10 ROWS ONLY;

-- T-SQL (option 1: TOP)
SELECT TOP 10 * FROM employees
ORDER BY hire_date DESC;

-- T-SQL (option 2: OFFSET...FETCH, ANSI-compliant)
SELECT * FROM employees
ORDER BY hire_date DESC
OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY;
```

### Pagination

```sql
-- Db2
SELECT * FROM employees
ORDER BY emp_id
OFFSET 20 ROWS FETCH FIRST 10 ROWS ONLY;

-- T-SQL
SELECT * FROM employees
ORDER BY emp_id
OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY;
```

The OFFSET...FETCH syntax is nearly identical. SSMA converts this automatically.

### VALUES as a query

```sql
-- Db2: VALUES used as a standalone SELECT
VALUES (CURRENT DATE, CURRENT TIME, CURRENT TIMESTAMP);

-- T-SQL: use SELECT
SELECT GETDATE(), CAST(GETDATE() AS TIME), SYSDATETIME();
```

### Date arithmetic

Date arithmetic is one of the largest areas of manual conversion.

```sql
-- Db2: days between two dates
SELECT DAYS(end_date) - DAYS(start_date) FROM contracts;

-- T-SQL
SELECT DATEDIFF(DAY, start_date, end_date) FROM contracts;
```

```sql
-- Db2: add months
SELECT start_date + 3 MONTHS FROM contracts;

-- T-SQL
SELECT DATEADD(MONTH, 3, start_date) FROM contracts;
```

```sql
-- Db2: add days
SELECT start_date + 30 DAYS FROM contracts;

-- T-SQL
SELECT DATEADD(DAY, 30, start_date) FROM contracts;
```

```sql
-- Db2: date durations
SELECT hire_date + 1 YEAR + 6 MONTHS + 15 DAYS FROM employees;

-- T-SQL
SELECT DATEADD(DAY, 15, DATEADD(MONTH, 6, DATEADD(YEAR, 1, hire_date)))
FROM employees;
```

```sql
-- Db2: MONTHS_BETWEEN
SELECT MONTHS_BETWEEN(end_date, start_date) FROM contracts;

-- T-SQL
SELECT DATEDIFF(MONTH, start_date, end_date) FROM contracts;
```

### String functions

```sql
-- Db2: POSSTR (find position of substring)
SELECT POSSTR(full_name, ',') FROM employees;

-- T-SQL: CHARINDEX (note: argument order reversed)
SELECT CHARINDEX(',', full_name) FROM employees;
```

```sql
-- Db2: STRIP (remove leading/trailing characters)
SELECT STRIP(account_code, BOTH, '0') FROM accounts;

-- T-SQL: TRIM (SQL Server 2017+)
SELECT TRIM('0' FROM account_code) FROM accounts;
```

```sql
-- Db2: HEX function
SELECT HEX(binary_col) FROM data_table;

-- T-SQL: CONVERT with style 2
SELECT CONVERT(VARCHAR(MAX), binary_col, 2) FROM data_table;
```

```sql
-- Db2: DIGITS function (convert number to character)
SELECT DIGITS(account_num) FROM accounts;

-- T-SQL: RIGHT + REPLICATE for zero-padded conversion
SELECT RIGHT(REPLICATE('0', 10) + CAST(account_num AS VARCHAR(10)), 10)
FROM accounts;
```

### Special registers

```sql
-- Db2 special registers -> T-SQL equivalents
-- CURRENT DATE          -> CAST(GETDATE() AS DATE)
-- CURRENT TIME          -> CAST(GETDATE() AS TIME)
-- CURRENT TIMESTAMP     -> SYSDATETIME()
-- CURRENT USER          -> CURRENT_USER or SUSER_SNAME()
-- CURRENT SCHEMA        -> SCHEMA_NAME()
-- CURRENT SERVER        -> @@SERVERNAME
-- CURRENT PATH          -> (no equivalent; schemas are explicit)
-- CURRENT TIMEZONE      -> DATENAME(TZOFFSET, SYSDATETIMEOFFSET())
```

### MERGE statement differences

```sql
-- Db2 MERGE
MERGE INTO target_table t
USING source_table s
ON t.id = s.id
WHEN MATCHED THEN
    UPDATE SET t.name = s.name, t.amount = s.amount
WHEN NOT MATCHED THEN
    INSERT (id, name, amount) VALUES (s.id, s.name, s.amount)
WHEN NOT MATCHED BY SOURCE THEN
    DELETE;

-- T-SQL MERGE (nearly identical but requires semicolon terminator)
MERGE INTO target_table AS t
USING source_table AS s
ON t.id = s.id
WHEN MATCHED THEN
    UPDATE SET t.name = s.name, t.amount = s.amount
WHEN NOT MATCHED BY TARGET THEN
    INSERT (id, name, amount) VALUES (s.id, s.name, s.amount)
WHEN NOT MATCHED BY SOURCE THEN
    DELETE;
```

Key difference: Db2 uses `WHEN NOT MATCHED` (implied BY TARGET). T-SQL uses `WHEN NOT MATCHED BY TARGET` explicitly.

### Sequence usage

```sql
-- Db2: get next sequence value
VALUES NEXT VALUE FOR order_seq INTO :order_id;
-- or in a SELECT
SELECT NEXT VALUE FOR order_seq FROM SYSIBM.SYSDUMMY1;

-- T-SQL: get next sequence value
SELECT NEXT VALUE FOR order_seq;  -- standalone SELECT works
-- or in a variable
DECLARE @order_id BIGINT = NEXT VALUE FOR order_seq;
```

### Type casting

```sql
-- Db2: DECIMAL function for casting
SELECT DECIMAL(amount_char, 10, 2) FROM transactions;

-- T-SQL: CAST or CONVERT
SELECT CAST(amount_char AS DECIMAL(10,2)) FROM transactions;
```

```sql
-- Db2: INTEGER function
SELECT INTEGER(quantity_char) FROM orders;

-- T-SQL
SELECT CAST(quantity_char AS INT) FROM orders;
```

### Isolation levels

```sql
-- Db2: isolation in query
SELECT * FROM accounts WITH UR;   -- Uncommitted Read
SELECT * FROM accounts WITH CS;   -- Cursor Stability
SELECT * FROM accounts WITH RS;   -- Read Stability
SELECT * FROM accounts WITH RR;   -- Repeatable Read

-- T-SQL: table hints
SELECT * FROM accounts WITH (NOLOCK);           -- Read Uncommitted
SELECT * FROM accounts WITH (READCOMMITTED);    -- default
SELECT * FROM accounts WITH (REPEATABLEREAD);   -- Repeatable Read
SELECT * FROM accounts WITH (SERIALIZABLE);     -- Serializable
```

---

## 3. Constraint and index conversion

### Primary keys and unique constraints

```sql
-- Db2
CREATE TABLE employees (
    emp_id INTEGER NOT NULL,
    ssn CHAR(9) NOT NULL,
    name VARCHAR(100),
    CONSTRAINT pk_employees PRIMARY KEY (emp_id),
    CONSTRAINT uk_ssn UNIQUE (ssn)
);

-- T-SQL (identical syntax)
CREATE TABLE employees (
    emp_id INT NOT NULL,
    ssn CHAR(9) NOT NULL,
    name VARCHAR(100),
    CONSTRAINT pk_employees PRIMARY KEY (emp_id),
    CONSTRAINT uk_ssn UNIQUE (ssn)
);
```

### Foreign keys

Foreign key syntax is identical in both platforms. SSMA converts these automatically.

### Check constraints

```sql
-- Db2
ALTER TABLE orders ADD CONSTRAINT chk_status
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'));

-- T-SQL (identical)
ALTER TABLE orders ADD CONSTRAINT chk_status
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'));
```

### Indexes

```sql
-- Db2: standard index
CREATE INDEX idx_emp_dept ON employees (dept_id);

-- T-SQL (identical)
CREATE INDEX idx_emp_dept ON employees (dept_id);

-- Db2: unique index with INCLUDE columns
CREATE UNIQUE INDEX idx_emp_email ON employees (email)
    INCLUDE (name, dept_id);

-- T-SQL
CREATE UNIQUE INDEX idx_emp_email ON employees (email)
    INCLUDE (name, dept_id);
```

### Db2 clustering index

```sql
-- Db2: clustering index (physical ordering)
CREATE INDEX idx_orders_date ON orders (order_date) CLUSTER;

-- T-SQL: clustered index (physical ordering)
CREATE CLUSTERED INDEX idx_orders_date ON orders (order_date);
```

---

## 4. Table and schema organization

### Db2 schema mapping

Db2 schemas map directly to SQL Server schemas. SSMA preserves schema names during conversion. If the Db2 database uses the default schema (matching the authorization ID), consider mapping to `dbo` in SQL Server for simplicity or to a named schema for multi-tenant patterns.

```sql
-- Db2
CREATE TABLE FINANCE.accounts (
    account_id INTEGER NOT NULL,
    balance DECIMAL(15,2)
);

-- T-SQL
CREATE TABLE FINANCE.accounts (
    account_id INT NOT NULL,
    balance DECIMAL(15,2)
);
```

### Identity column conversion

```sql
-- Db2: GENERATED ALWAYS
CREATE TABLE orders (
    order_id INTEGER GENERATED ALWAYS AS IDENTITY (START WITH 1, INCREMENT BY 1),
    order_date DATE
);

-- T-SQL: IDENTITY
CREATE TABLE orders (
    order_id INT IDENTITY(1,1),
    order_date DATE
);
```

```sql
-- Db2: GENERATED BY DEFAULT (allows explicit values)
CREATE TABLE orders (
    order_id INTEGER GENERATED BY DEFAULT AS IDENTITY,
    order_date DATE
);

-- T-SQL: IDENTITY with SET IDENTITY_INSERT for explicit values
CREATE TABLE orders (
    order_id INT IDENTITY(1,1),
    order_date DATE
);
-- To insert explicit values:
SET IDENTITY_INSERT orders ON;
INSERT INTO orders (order_id, order_date) VALUES (100, '2026-01-01');
SET IDENTITY_INSERT orders OFF;
```

---

## 5. Post-conversion validation checklist

After SSMA conversion, validate the following:

- [ ] All tables created with correct column types and nullability
- [ ] Primary keys and unique constraints preserved
- [ ] Foreign key relationships intact with correct referential actions
- [ ] Check constraints converted correctly
- [ ] Indexes created with correct columns and include lists
- [ ] Sequences created with correct start, increment, cache, and cycle settings
- [ ] Views compile successfully and return correct results
- [ ] Default values converted correctly (especially date/time defaults)
- [ ] Computed columns (Db2 GENERATED ALWAYS AS) converted to computed columns
- [ ] Table partitioning boundaries match source partition scheme
- [ ] Row counts match between source and target for all tables
- [ ] Data type precision validated for DECIMAL, TIMESTAMP, and GRAPHIC columns

---

## Related resources

- [Complete Feature Mapping](feature-mapping-complete.md) -- comprehensive feature comparison
- [Stored Procedure Migration](stored-proc-migration.md) -- SQL PL to T-SQL conversion
- [Data Migration](data-migration.md) -- data movement strategies
- [Tutorial: SSMA Migration](tutorial-ssma-migration.md) -- step-by-step SSMA walkthrough

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
