# MySQL / MariaDB Schema Migration

**Data type mapping, AUTO_INCREMENT handling, character set conversion, collation mapping, foreign key management, index types, partitioning conversion, and storage engine migration for MySQL/MariaDB to Azure targets.**

---

!!! info "Scope"
This guide covers schema conversion for all three Azure targets: Azure MySQL Flexible Server (same engine, minimal changes), Azure PostgreSQL Flexible Server (engine switch, significant conversion), and Azure SQL Database (engine switch, significant conversion). Each section identifies target-specific differences.

---

## 1. Storage engine conversion

### 1.1 InnoDB requirement

Azure Database for MySQL Flexible Server supports multiple storage engines, but InnoDB is required for zone-redundant high availability (replication requires transactional tables). Convert all non-InnoDB tables before migration.

```sql
-- Find all non-InnoDB tables
SELECT table_schema, table_name, engine
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND engine != 'InnoDB'
ORDER BY table_schema, table_name;

-- Convert MyISAM to InnoDB
ALTER TABLE mydb.my_table ENGINE = InnoDB;

-- Convert MariaDB Aria to InnoDB
ALTER TABLE mydb.my_table ENGINE = InnoDB;

-- Convert MEMORY to InnoDB (data will persist after restart)
-- Note: MEMORY tables lose data on restart anyway
ALTER TABLE mydb.my_table ENGINE = InnoDB;
```

### 1.2 Engine conversion considerations

| Source engine             | Conversion notes                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MyISAM**                | No foreign keys on MyISAM; add FK constraints after conversion if needed. Full-text indexes work on InnoDB (MySQL 5.6+). Table-level locking becomes row-level. |
| **Aria** (MariaDB)        | Similar to MyISAM conversion. Check for crash-recovery behavior changes.                                                                                        |
| **MEMORY / HEAP**         | Data lost on conversion; reload after ALTER TABLE. Consider InnoDB with buffer pool caching.                                                                    |
| **ARCHIVE**               | Insert-only engine; InnoDB allows all DML. Consider compression (`ROW_FORMAT=COMPRESSED`).                                                                      |
| **CSV**                   | No indexes, no transactions; InnoDB adds both. Test applications expecting CSV file access.                                                                     |
| **BLACKHOLE**             | Used for replication filtering; remove or redesign replication topology.                                                                                        |
| **FEDERATED**             | Remote table access; replace with Azure Data Factory or application-level data access.                                                                          |
| **ColumnStore** (MariaDB) | Analytics engine; migrate to Microsoft Fabric for analytics workloads.                                                                                          |

---

## 2. Data type mapping

### 2.1 MySQL to Azure MySQL Flexible Server

Same engine, so most data types require no change. Key exceptions:

| MySQL type                  | Azure MySQL Flexible Server | Notes                                           |
| --------------------------- | --------------------------- | ----------------------------------------------- |
| All standard types          | Supported as-is             | No conversion needed                            |
| `GEOMETRY` (MyISAM spatial) | `GEOMETRY` (InnoDB spatial) | Convert engine to InnoDB first                  |
| `YEAR`                      | `YEAR`                      | Supported                                       |
| `SET`                       | `SET`                       | Supported                                       |
| `ENUM`                      | `ENUM`                      | Supported                                       |
| Custom UDF return types     | Not applicable              | UDFs not supported; rewrite as stored functions |

### 2.2 MySQL to Azure PostgreSQL

| MySQL type               | PostgreSQL type                                                      | Conversion notes                               |
| ------------------------ | -------------------------------------------------------------------- | ---------------------------------------------- |
| `TINYINT`                | `SMALLINT`                                                           | PostgreSQL has no TINYINT; SMALLINT is 2 bytes |
| `TINYINT(1)` / `BOOLEAN` | `BOOLEAN`                                                            | Map to native boolean                          |
| `SMALLINT`               | `SMALLINT`                                                           | Direct mapping                                 |
| `MEDIUMINT`              | `INTEGER`                                                            | PostgreSQL has no MEDIUMINT                    |
| `INT` / `INTEGER`        | `INTEGER`                                                            | Direct mapping                                 |
| `BIGINT`                 | `BIGINT`                                                             | Direct mapping                                 |
| `INT UNSIGNED`           | `INTEGER` + `CHECK (col >= 0)`                                       | No unsigned types in PostgreSQL                |
| `BIGINT UNSIGNED`        | `BIGINT` + `CHECK (col >= 0)` or `NUMERIC(20,0)`                     | For values > 9.2 quintillion                   |
| `FLOAT`                  | `REAL`                                                               | 4-byte floating point                          |
| `DOUBLE`                 | `DOUBLE PRECISION`                                                   | 8-byte floating point                          |
| `DECIMAL(p,s)`           | `NUMERIC(p,s)`                                                       | Exact numeric                                  |
| `CHAR(n)`                | `CHARACTER(n)`                                                       | Fixed-length string                            |
| `VARCHAR(n)`             | `VARCHAR(n)`                                                         | Variable-length string                         |
| `TINYTEXT`               | `TEXT`                                                               | PostgreSQL TEXT is unlimited                   |
| `TEXT`                   | `TEXT`                                                               | Direct mapping                                 |
| `MEDIUMTEXT`             | `TEXT`                                                               | PostgreSQL TEXT is unlimited                   |
| `LONGTEXT`               | `TEXT`                                                               | PostgreSQL TEXT is unlimited (max 1 GB)        |
| `TINYBLOB`               | `BYTEA`                                                              | Binary data                                    |
| `BLOB`                   | `BYTEA`                                                              | Binary data (max 1 GB)                         |
| `MEDIUMBLOB`             | `BYTEA`                                                              | Binary data                                    |
| `LONGBLOB`               | `BYTEA`                                                              | Consider Azure Blob Storage for > 100 MB       |
| `DATE`                   | `DATE`                                                               | Direct mapping                                 |
| `TIME`                   | `TIME`                                                               | Direct mapping                                 |
| `DATETIME`               | `TIMESTAMP`                                                          | PostgreSQL TIMESTAMP has microsecond precision |
| `TIMESTAMP`              | `TIMESTAMPTZ`                                                        | Use TIMESTAMPTZ for timezone awareness         |
| `YEAR`                   | `SMALLINT`                                                           | No YEAR type in PostgreSQL                     |
| `ENUM('a','b','c')`      | `CREATE TYPE enum_name AS ENUM ('a','b','c')` or `VARCHAR` + `CHECK` | Custom type or constraint                      |
| `SET('a','b','c')`       | `TEXT[]` (array) or junction table                                   | No SET type in PostgreSQL                      |
| `JSON`                   | `JSONB`                                                              | JSONB is binary, indexable, superior           |
| `BIT(n)`                 | `BIT(n)` or `BIT VARYING(n)`                                         | Direct mapping                                 |
| `BINARY(n)`              | `BYTEA`                                                              | No fixed-length binary in PostgreSQL           |
| `VARBINARY(n)`           | `BYTEA`                                                              | No variable-length binary type                 |
| `GEOMETRY`               | PostGIS `GEOMETRY`                                                   | Install PostGIS extension                      |
| `POINT`                  | PostGIS `POINT`                                                      | Install PostGIS extension                      |
| `POLYGON`                | PostGIS `POLYGON`                                                    | Install PostGIS extension                      |

### 2.3 MySQL to Azure SQL Database

| MySQL type       | Azure SQL type                   | Conversion notes                               |
| ---------------- | -------------------------------- | ---------------------------------------------- |
| `TINYINT`        | `TINYINT`                        | Direct mapping (0-255, unsigned in SQL Server) |
| `TINYINT SIGNED` | `SMALLINT`                       | SQL Server TINYINT is unsigned only            |
| `SMALLINT`       | `SMALLINT`                       | Direct mapping                                 |
| `MEDIUMINT`      | `INT`                            | No MEDIUMINT in SQL Server                     |
| `INT`            | `INT`                            | Direct mapping                                 |
| `BIGINT`         | `BIGINT`                         | Direct mapping                                 |
| `FLOAT`          | `REAL` or `FLOAT`                | REAL is 4 bytes; FLOAT is 8 bytes              |
| `DOUBLE`         | `FLOAT`                          | SQL Server FLOAT is 8 bytes                    |
| `DECIMAL(p,s)`   | `DECIMAL(p,s)`                   | Direct mapping                                 |
| `CHAR(n)`        | `CHAR(n)` or `NCHAR(n)`          | Use NCHAR for Unicode                          |
| `VARCHAR(n)`     | `VARCHAR(n)` or `NVARCHAR(n)`    | Use NVARCHAR for Unicode; max 8000 (or MAX)    |
| `TEXT`           | `NVARCHAR(MAX)`                  | TEXT is deprecated in SQL Server               |
| `MEDIUMTEXT`     | `NVARCHAR(MAX)`                  | Up to 2 GB                                     |
| `LONGTEXT`       | `NVARCHAR(MAX)`                  | Up to 2 GB                                     |
| `BLOB`           | `VARBINARY(MAX)`                 | Up to 2 GB                                     |
| `DATE`           | `DATE`                           | Direct mapping                                 |
| `TIME`           | `TIME`                           | Direct mapping                                 |
| `DATETIME`       | `DATETIME2`                      | DATETIME2 has better precision and range       |
| `TIMESTAMP`      | `DATETIME2` + trigger            | SQL Server TIMESTAMP/ROWVERSION is different   |
| `YEAR`           | `SMALLINT`                       | No YEAR type                                   |
| `ENUM`           | `VARCHAR` + `CHECK`              | No ENUM type in SQL Server                     |
| `SET`            | Junction table                   | No SET type                                    |
| `JSON`           | `NVARCHAR(MAX)` + JSON functions | No native JSON type; text-based                |
| `BIT(n)`         | `BIT` (single bit) or `BINARY`   | SQL Server BIT is 1 bit                        |
| `GEOMETRY`       | `GEOMETRY` / `GEOGRAPHY`         | Native spatial types                           |
| `AUTO_INCREMENT` | `IDENTITY(1,1)`                  | Different syntax                               |

---

## 3. AUTO_INCREMENT conversion

### 3.1 MySQL to Azure MySQL Flexible Server

No change needed. AUTO_INCREMENT works identically.

### 3.2 MySQL to Azure PostgreSQL

MySQL AUTO_INCREMENT converts to PostgreSQL sequences:

```sql
-- MySQL
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100)
);

-- PostgreSQL option 1: SERIAL (traditional)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100)
);

-- PostgreSQL option 2: GENERATED ALWAYS (SQL standard, preferred)
CREATE TABLE users (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100)
);

-- PostgreSQL option 3: GENERATED BY DEFAULT (allows manual inserts)
CREATE TABLE users (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name VARCHAR(100)
);
```

After data migration, reset sequences to the maximum existing value:

```sql
-- Reset sequence for each table with SERIAL/IDENTITY
SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users));
```

### 3.3 MySQL to Azure SQL Database

```sql
-- MySQL
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100)
);

-- Azure SQL
CREATE TABLE users (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(100)
);
```

After bulk data import with `SET IDENTITY_INSERT ON`:

```sql
SET IDENTITY_INSERT users ON;
-- Insert data with explicit ID values
INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob');
SET IDENTITY_INSERT users OFF;

-- Reseed identity
DBCC CHECKIDENT('users', RESEED);
```

---

## 4. Character set and collation conversion

### 4.1 Inventory source character sets

```sql
-- Database level
SELECT schema_name, default_character_set_name, default_collation_name
FROM information_schema.schemata
WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys');

-- Table level
SELECT table_schema, table_name, table_collation
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND table_type = 'BASE TABLE'
ORDER BY table_schema, table_name;

-- Column level (only non-default)
SELECT table_schema, table_name, column_name, character_set_name, collation_name
FROM information_schema.columns
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND character_set_name IS NOT NULL
ORDER BY table_schema, table_name, ordinal_position;
```

### 4.2 MySQL to Azure MySQL Flexible Server

Target utf8mb4 as the standard character set:

```sql
-- Convert database
ALTER DATABASE mydb CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- Convert all tables in a database (generate ALTER statements)
SELECT CONCAT('ALTER TABLE `', table_schema, '`.`', table_name,
              '` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;')
FROM information_schema.tables
WHERE table_schema = 'mydb'
  AND table_type = 'BASE TABLE'
  AND table_collation != 'utf8mb4_0900_ai_ci';
```

### 4.3 MySQL to Azure PostgreSQL

PostgreSQL uses UTF-8 natively. The database encoding is set at creation time and cannot be changed afterward.

```sql
-- Create PostgreSQL database with UTF-8 encoding
CREATE DATABASE mydb
  ENCODING = 'UTF8'
  LC_COLLATE = 'en_US.UTF-8'
  LC_CTYPE = 'en_US.UTF-8';
```

pgloader handles character set conversion automatically during data migration.

### 4.4 Collation mapping table

| MySQL collation      | PostgreSQL collation       | Azure SQL collation            | Notes                                |
| -------------------- | -------------------------- | ------------------------------ | ------------------------------------ |
| `utf8mb4_0900_ai_ci` | `en-US-x-icu` (ICU)        | `Latin1_General_100_CI_AI`     | Accent-insensitive, case-insensitive |
| `utf8mb4_0900_as_cs` | `en-US-x-icu` with options | `Latin1_General_100_CS_AS`     | Accent-sensitive, case-sensitive     |
| `utf8mb4_unicode_ci` | `en-US-x-icu`              | `Latin1_General_CI_AI`         | Unicode comparison                   |
| `utf8mb4_general_ci` | `en-US-x-icu`              | `SQL_Latin1_General_CP1_CI_AS` | MySQL fast comparison                |
| `utf8mb4_bin`        | `C` collation              | `Latin1_General_BIN2`          | Binary comparison                    |
| `latin1_swedish_ci`  | `sv-SE-x-icu`              | `Finnish_Swedish_CI_AS`        | Swedish/Finnish sorting              |

---

## 5. Foreign key handling

### 5.1 Export and validate foreign keys

```sql
-- List all foreign keys
SELECT
    tc.table_schema, tc.table_name, tc.constraint_name,
    kcu.column_name, kcu.referenced_table_schema,
    kcu.referenced_table_name, kcu.referenced_column_name,
    rc.update_rule, rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name
    AND tc.table_schema = rc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'mydb'
ORDER BY tc.table_name;
```

### 5.2 Foreign key migration strategy

For large data migrations, disable foreign keys during data load:

```sql
-- MySQL (source and Azure MySQL target)
SET FOREIGN_KEY_CHECKS = 0;
-- ... load data ...
SET FOREIGN_KEY_CHECKS = 1;

-- PostgreSQL target
-- Drop constraints, load data, re-add constraints
-- Or use: SET session_replication_role = 'replica'; (disables triggers and FK checks)
SET session_replication_role = 'replica';
-- ... load data ...
SET session_replication_role = 'origin';

-- Azure SQL target
ALTER TABLE child_table NOCHECK CONSTRAINT fk_name;
-- ... load data ...
ALTER TABLE child_table CHECK CONSTRAINT fk_name;
```

### 5.3 Cross-database foreign keys

MySQL allows foreign keys between tables in different databases on the same server. This is not supported on Azure MySQL Flexible Server (each Flexible Server hosts databases independently, and cross-database FK enforcement depends on the same server).

**Solution:** Either consolidate tables into a single database, or enforce referential integrity at the application level.

---

## 6. Index conversion

### 6.1 Index type mapping

| MySQL index type          | Azure MySQL   | PostgreSQL                         | Azure SQL               | Notes                                 |
| ------------------------- | ------------- | ---------------------------------- | ----------------------- | ------------------------------------- |
| `PRIMARY KEY`             | Same          | Same                               | Same                    | Direct                                |
| `UNIQUE`                  | Same          | Same                               | Same                    | Direct                                |
| `INDEX` (B-tree)          | Same          | `CREATE INDEX` (B-tree default)    | Same                    | Direct                                |
| `FULLTEXT`                | Same          | `GIN` on `tsvector` column         | `CREATE FULLTEXT INDEX` | Moderate conversion for PG/SQL        |
| `SPATIAL`                 | Same (InnoDB) | `GiST` (PostGIS)                   | `CREATE SPATIAL INDEX`  | Moderate conversion                   |
| Prefix index `(col(10))`  | Same          | Expression index `(LEFT(col, 10))` | Not supported           | Moderate for PG                       |
| Invisible index           | Same          | Not available                      | Not available           | MySQL-specific                        |
| Multi-valued index (JSON) | Same          | `GIN` on `JSONB`                   | Computed column + index | Direct for MySQL; moderate for PG/SQL |

### 6.2 Full-text index conversion for PostgreSQL

```sql
-- MySQL
CREATE FULLTEXT INDEX ft_articles ON articles(title, body);
SELECT * FROM articles WHERE MATCH(title, body) AGAINST('search term');

-- PostgreSQL equivalent
-- Step 1: Add tsvector column
ALTER TABLE articles ADD COLUMN search_vector tsvector;

-- Step 2: Populate tsvector
UPDATE articles SET search_vector =
    to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(body, ''));

-- Step 3: Create GIN index
CREATE INDEX ft_articles ON articles USING GIN(search_vector);

-- Step 4: Create trigger to maintain tsvector on INSERT/UPDATE
CREATE FUNCTION articles_search_trigger() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := to_tsvector('english',
        COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.body, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tsvector_update BEFORE INSERT OR UPDATE
ON articles FOR EACH ROW EXECUTE FUNCTION articles_search_trigger();

-- Step 5: Query using tsquery
SELECT * FROM articles WHERE search_vector @@ to_tsquery('english', 'search & term');
```

---

## 7. Partitioning conversion

### 7.1 MySQL partitioning to PostgreSQL declarative partitioning

```sql
-- MySQL RANGE partitioning
CREATE TABLE orders (
    id INT AUTO_INCREMENT,
    order_date DATE,
    amount DECIMAL(10,2),
    PRIMARY KEY (id, order_date)
) PARTITION BY RANGE (YEAR(order_date)) (
    PARTITION p2023 VALUES LESS THAN (2024),
    PARTITION p2024 VALUES LESS THAN (2025),
    PARTITION p2025 VALUES LESS THAN (2026),
    PARTITION p_future VALUES LESS THAN MAXVALUE
);

-- PostgreSQL declarative partitioning equivalent
CREATE TABLE orders (
    id INTEGER GENERATED ALWAYS AS IDENTITY,
    order_date DATE NOT NULL,
    amount NUMERIC(10,2),
    PRIMARY KEY (id, order_date)
) PARTITION BY RANGE (order_date);

CREATE TABLE orders_2023 PARTITION OF orders
    FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');
CREATE TABLE orders_2024 PARTITION OF orders
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE orders_2025 PARTITION OF orders
    FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE orders_future PARTITION OF orders
    FOR VALUES FROM ('2026-01-01') TO ('9999-12-31');
```

### 7.2 MySQL partitioning to Azure SQL

Azure SQL Database supports table partitioning with partition functions and schemes:

```sql
-- Create partition function
CREATE PARTITION FUNCTION pf_order_date (DATE)
AS RANGE RIGHT FOR VALUES ('2024-01-01', '2025-01-01', '2026-01-01');

-- Create partition scheme
CREATE PARTITION SCHEME ps_order_date
AS PARTITION pf_order_date ALL TO ([PRIMARY]);

-- Create partitioned table
CREATE TABLE orders (
    id INT IDENTITY(1,1),
    order_date DATE NOT NULL,
    amount DECIMAL(10,2),
    CONSTRAINT pk_orders PRIMARY KEY (id, order_date)
) ON ps_order_date(order_date);
```

---

## 8. Views migration

### 8.1 Standard views

Most MySQL views migrate directly to all three targets with minimal syntax changes:

```sql
-- MySQL view
CREATE VIEW active_customers AS
SELECT c.id, c.name, c.email, COUNT(o.id) AS order_count
FROM customers c
LEFT JOIN orders o ON c.id = o.customer_id AND o.created_at > DATE_SUB(NOW(), INTERVAL 1 YEAR)
WHERE c.status = 'active'
GROUP BY c.id, c.name, c.email;

-- PostgreSQL equivalent
CREATE VIEW active_customers AS
SELECT c.id, c.name, c.email, COUNT(o.id) AS order_count
FROM customers c
LEFT JOIN orders o ON c.id = o.customer_id AND o.created_at > NOW() - INTERVAL '1 year'
WHERE c.status = 'active'
GROUP BY c.id, c.name, c.email;

-- Azure SQL equivalent
CREATE VIEW active_customers AS
SELECT c.id, c.name, c.email, COUNT(o.id) AS order_count
FROM customers c
LEFT JOIN orders o ON c.id = o.customer_id AND o.created_at > DATEADD(YEAR, -1, GETDATE())
WHERE c.status = 'active'
GROUP BY c.id, c.name, c.email;
```

### 8.2 MySQL-specific view features

| Feature                       | Azure MySQL                   | PostgreSQL                                             | Azure SQL                            |
| ----------------------------- | ----------------------------- | ------------------------------------------------------ | ------------------------------------ |
| `ALGORITHM = MERGE/TEMPTABLE` | Supported (optimizer hint)    | No equivalent (optimizer decides)                      | No equivalent                        |
| `WITH CHECK OPTION`           | Supported                     | Supported                                              | Supported                            |
| `DEFINER`                     | Supported                     | No DEFINER concept; views use invoker privileges       | No equivalent                        |
| Updatable views               | Supported (with restrictions) | Supported (with INSTEAD OF triggers for complex cases) | Supported (with INSTEAD OF triggers) |

---

## 9. Schema migration checklist

- [ ] Convert all non-InnoDB tables to InnoDB
- [ ] Map all data types to target platform (use tables in section 2)
- [ ] Convert AUTO_INCREMENT to target equivalent (SERIAL, IDENTITY)
- [ ] Standardize character sets to utf8mb4
- [ ] Map collations to target platform equivalents
- [ ] Export and validate all foreign key relationships
- [ ] Convert indexes (especially full-text and spatial for PG/SQL targets)
- [ ] Convert partitioned tables to target partitioning syntax
- [ ] Migrate views with syntax adjustments
- [ ] Convert stored procedures and functions (for PG/SQL targets)
- [ ] Convert triggers (for PG/SQL targets)
- [ ] Convert events to target scheduler (pg_cron, SQL Agent)
- [ ] Validate schema in target with empty tables before data migration
- [ ] Test application queries against target schema

---

**Next:** [Data Migration](data-migration.md) | [Flexible Server Migration](flexible-server-migration.md) | [PostgreSQL Migration](postgresql-migration.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
