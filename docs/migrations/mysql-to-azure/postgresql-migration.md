# MySQL to Azure Database for PostgreSQL Migration

**When and how to switch engines: MySQL/MariaDB to Azure Database for PostgreSQL Flexible Server. Decision criteria, schema conversion, SQL syntax differences, stored procedure conversion, and tooling.**

---

!!! warning "Engine switch -- not a trivial migration"
Migrating from MySQL to PostgreSQL is a real engine change, not a version upgrade. SQL syntax, stored procedure language, data types, and tooling all change. This guide is for organizations that have decided the benefits of PostgreSQL (superior JSON support, PostGIS, Citus scale-out, community governance, extension ecosystem) justify the conversion effort. If minimizing migration risk is the priority, stay on MySQL and use [Azure MySQL Flexible Server](flexible-server-migration.md).

---

## 1. When to choose PostgreSQL over MySQL

### 1.1 Strong indicators for PostgreSQL

| Indicator                           | Why PostgreSQL is better                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Geospatial workloads**            | PostGIS is the industry standard for GIS databases; MySQL Spatial is limited by comparison         |
| **Advanced JSON/document model**    | JSONB with GIN indexing, path operators, and containment queries outperforms MySQL JSON            |
| **Horizontal scale-out needed**     | Citus extension provides transparent sharding within Azure PostgreSQL Flexible Server              |
| **Complex analytics queries**       | Richer window functions, CTEs, LATERAL joins, materialized views                                   |
| **Open-source governance priority** | PostgreSQL is community-governed; MySQL is Oracle-controlled                                       |
| **Extension ecosystem**             | 60+ extensions on Azure (pg_trgm, uuid-ossp, pgcrypto, hstore, PostGIS, Citus, pg_stat_statements) |
| **Row-level security**              | Native RLS policies (MySQL has no built-in RLS)                                                    |
| **Standards compliance**            | PostgreSQL is the most SQL-standard-compliant open-source database                                 |
| **Foreign data wrappers**           | Access external data sources (Oracle, MySQL, MongoDB, S3) as virtual tables                        |

### 1.2 Stay on MySQL when

| Indicator                                           | Why MySQL is better for your case              |
| --------------------------------------------------- | ---------------------------------------------- |
| Application is certified for MySQL only             | Regulatory or vendor certification requirement |
| Extensive MySQL stored procedures                   | Conversion cost exceeds benefit                |
| Team has deep MySQL expertise, no PostgreSQL skills | Training cost and risk                         |
| WordPress, Drupal, Magento, or MySQL-certified SaaS | Application requires MySQL specifically        |
| Minimal migration risk is the top priority          | Same-engine migration is always lower risk     |
| MariaDB migration with short timeline               | MySQL Flexible Server is faster to migrate to  |

---

## 2. Schema conversion tools

### 2.1 pgloader

pgloader is the primary tool for MySQL-to-PostgreSQL migration. It handles schema conversion and data loading in a single pass.

```bash
# Install pgloader
sudo apt-get install pgloader  # Debian/Ubuntu
# or
brew install pgloader          # macOS

# Basic migration command
pgloader mysql://user:password@source-host/source_db \
         postgresql://user:password@target-host/target_db

# With configuration file for fine-grained control
pgloader migration.load
```

**pgloader configuration file (`migration.load`):**

```lisp
LOAD DATABASE
    FROM mysql://root:password@source-mysql:3306/myapp
    INTO postgresql://admin:password@target-pg.postgres.database.azure.com:5432/myapp

WITH include drop, create tables, create indexes,
     reset sequences, downcase identifiers,
     uniquify index names

SET maintenance_work_mem to '512MB',
    work_mem to '128MB'

CAST type int with extra auto_increment
          to serial
     type bigint with extra auto_increment
          to bigserial
     type tinyint to smallint
     type mediumint to integer
     type float to real
     type double to double precision
     type tinytext to text
     type mediumtext to text
     type longtext to text
     type tinyblob to bytea
     type mediumblob to bytea
     type longblob to bytea
     type blob to bytea
     type binary to bytea
     type varbinary to bytea
     type datetime to timestamp
     type year to smallint
     type bit to boolean using pgloader.transforms::integer-to-boolean
     type enum to varchar

BEFORE LOAD DO
     $$ CREATE SCHEMA IF NOT EXISTS myapp; $$

AFTER LOAD DO
     $$ ALTER DATABASE myapp SET search_path TO myapp, public; $$
;
```

### 2.2 MySQL Workbench migration wizard

MySQL Workbench includes a migration wizard that can generate PostgreSQL DDL from MySQL schemas. It does not migrate data but is useful for reviewing schema differences.

### 2.3 AWS Schema Conversion Tool (SCT)

Though an AWS tool, SCT can convert MySQL schemas to PostgreSQL DDL and identify conversion issues. Use it as a supplementary assessment tool.

### 2.4 ora2pg (for MariaDB)

ora2pg supports MariaDB as a source and can generate PostgreSQL DDL with data type mapping.

```bash
# Install ora2pg
sudo apt-get install ora2pg

# Run assessment
ora2pg -t SHOW_REPORT --estimate_cost -c ora2pg_mysql.conf

# Generate schema
ora2pg -t TABLE -c ora2pg_mysql.conf -o tables.sql
ora2pg -t VIEW -c ora2pg_mysql.conf -o views.sql
ora2pg -t PROCEDURE -c ora2pg_mysql.conf -o procedures.sql
ora2pg -t FUNCTION -c ora2pg_mysql.conf -o functions.sql
ora2pg -t TRIGGER -c ora2pg_mysql.conf -o triggers.sql
```

---

## 3. SQL syntax differences

### 3.1 Core syntax mapping

| MySQL syntax                      | PostgreSQL syntax                                       | Notes                                              |
| --------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `` `backtick` `` identifiers      | `"double_quote"` identifiers                            | PostgreSQL folds unquoted identifiers to lowercase |
| `LIMIT offset, count`             | `LIMIT count OFFSET offset`                             | Different argument order                           |
| `IFNULL(a, b)`                    | `COALESCE(a, b)`                                        | COALESCE is SQL standard, works in both            |
| `IF(cond, a, b)`                  | `CASE WHEN cond THEN a ELSE b END`                      | Standard SQL CASE expression                       |
| `NOW()`                           | `NOW()` or `CURRENT_TIMESTAMP`                          | Both work in PostgreSQL                            |
| `CURDATE()`                       | `CURRENT_DATE`                                          | SQL standard                                       |
| `DATE_FORMAT(d, '%Y-%m-%d')`      | `TO_CHAR(d, 'YYYY-MM-DD')`                              | Different format specifiers                        |
| `STR_TO_DATE('...', '%Y-%m-%d')`  | `TO_DATE('...', 'YYYY-MM-DD')`                          | Different format specifiers                        |
| `UNIX_TIMESTAMP()`                | `EXTRACT(EPOCH FROM NOW())`                             | Returns seconds since epoch                        |
| `FROM_UNIXTIME(ts)`               | `TO_TIMESTAMP(ts)`                                      | Convert epoch to timestamp                         |
| `GROUP_CONCAT(col SEPARATOR ',')` | `STRING_AGG(col, ',')`                                  | Aggregate string concatenation                     |
| `CONCAT(a, b, c)`                 | `CONCAT(a, b, c)` or `a \|\| b \|\| c`                  | Both work; `\|\|` is standard                      |
| `FIND_IN_SET('a', 'a,b,c')`       | `'a' = ANY(STRING_TO_ARRAY('a,b,c', ','))`              | No direct equivalent                               |
| `RAND()`                          | `RANDOM()`                                              | Random number generator                            |
| `TRUNCATE TABLE t`                | `TRUNCATE TABLE t`                                      | Same syntax                                        |
| `SHOW TABLES`                     | `\dt` (psql) or query `information_schema.tables`       | Different metadata access                          |
| `SHOW DATABASES`                  | `\l` (psql) or query `pg_database`                      | Different metadata access                          |
| `DESCRIBE table`                  | `\d table` (psql) or query `information_schema.columns` | Different metadata access                          |
| `AUTO_INCREMENT`                  | `SERIAL` / `BIGSERIAL` / `GENERATED ALWAYS AS IDENTITY` | Different auto-increment mechanism                 |
| `UNSIGNED INT`                    | `INTEGER` with `CHECK (col >= 0)`                       | PostgreSQL has no unsigned types                   |
| `ENUM('a','b','c')`               | `CREATE TYPE enum_name AS ENUM ('a','b','c')`           | Custom type or CHECK constraint                    |
| `SET('a','b','c')`                | Array type `TEXT[]` or junction table                   | No direct SET equivalent                           |
| `REPLACE INTO`                    | `INSERT ... ON CONFLICT DO UPDATE` (UPSERT)             | Different syntax, same semantics                   |
| `INSERT IGNORE`                   | `INSERT ... ON CONFLICT DO NOTHING`                     | Different syntax                                   |
| `ON DUPLICATE KEY UPDATE`         | `ON CONFLICT (key) DO UPDATE SET ...`                   | Requires specifying conflict target                |

### 3.2 String differences

| MySQL                                | PostgreSQL                                           | Notes                                     |
| ------------------------------------ | ---------------------------------------------------- | ----------------------------------------- |
| `'string'` (single quotes)           | `'string'` (single quotes)                           | Same                                      |
| `"identifier"` or `` `identifier` `` | `"identifier"` only                                  | No backticks in PostgreSQL                |
| `LIKE` (case-insensitive by default) | `LIKE` (case-sensitive) / `ILIKE` (case-insensitive) | Use `ILIKE` for case-insensitive matching |
| `REGEXP` / `RLIKE`                   | `~` (match) / `~*` (case-insensitive match)          | Different regex operator syntax           |
| `SUBSTRING(str, pos, len)`           | `SUBSTRING(str FROM pos FOR len)`                    | Both syntaxes work in PostgreSQL          |

### 3.3 Date and time differences

| MySQL                           | PostgreSQL                                                  | Notes                                       |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| `DATETIME`                      | `TIMESTAMP`                                                 | PostgreSQL TIMESTAMP stores to microseconds |
| `TIMESTAMP` (auto-update)       | `TIMESTAMP` + trigger for auto-update                       | PostgreSQL does not auto-update timestamps  |
| `DATE_ADD(d, INTERVAL 1 DAY)`   | `d + INTERVAL '1 day'`                                      | PostgreSQL uses `+` operator                |
| `DATE_SUB(d, INTERVAL 1 MONTH)` | `d - INTERVAL '1 month'`                                    | PostgreSQL uses `-` operator                |
| `DATEDIFF(d1, d2)`              | `d1 - d2` (returns interval) or `DATE_PART('day', d1 - d2)` | Different return type                       |
| `YEAR(d)`, `MONTH(d)`, `DAY(d)` | `EXTRACT(YEAR FROM d)`, etc.                                | SQL standard extraction                     |
| `DATE_FORMAT(d, fmt)`           | `TO_CHAR(d, fmt)`                                           | Different format codes                      |

---

## 4. Stored procedure conversion

### 4.1 MySQL to PL/pgSQL conversion

MySQL stored procedures and functions must be rewritten in PL/pgSQL, PostgreSQL's procedural language.

**MySQL stored procedure:**

```sql
DELIMITER //
CREATE PROCEDURE get_customer_orders(IN p_customer_id INT, OUT p_total DECIMAL(10,2))
BEGIN
    DECLARE v_count INT DEFAULT 0;

    SELECT COUNT(*), COALESCE(SUM(total_amount), 0)
    INTO v_count, p_total
    FROM orders
    WHERE customer_id = p_customer_id
      AND status = 'completed';

    IF v_count = 0 THEN
        SET p_total = 0.00;
    END IF;
END //
DELIMITER ;
```

**PostgreSQL equivalent:**

```sql
CREATE OR REPLACE FUNCTION get_customer_orders(
    p_customer_id INTEGER,
    OUT p_total NUMERIC(10,2)
)
RETURNS NUMERIC AS $$
DECLARE
    v_count INTEGER := 0;
BEGIN
    SELECT COUNT(*), COALESCE(SUM(total_amount), 0)
    INTO v_count, p_total
    FROM orders
    WHERE customer_id = p_customer_id
      AND status = 'completed';

    IF v_count = 0 THEN
        p_total := 0.00;
    END IF;
END;
$$ LANGUAGE plpgsql;
```

### 4.2 Key conversion patterns

| MySQL pattern                           | PL/pgSQL equivalent                                         | Notes                                 |
| --------------------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| `DELIMITER //`                          | Not needed                                                  | PostgreSQL uses `$$` dollar quoting   |
| `DECLARE var TYPE DEFAULT val`          | `DECLARE var TYPE := val`                                   | Different assignment operator         |
| `SET var = value`                       | `var := value`                                              | `:=` assignment operator              |
| `SELECT INTO var`                       | `SELECT INTO var`                                           | Same syntax                           |
| `CURSOR DECLARE / OPEN / FETCH / CLOSE` | `DECLARE cur CURSOR FOR ...; OPEN cur; FETCH cur INTO ...;` | Similar but slightly different syntax |
| `HANDLER for SQLEXCEPTION`              | `EXCEPTION WHEN ... THEN`                                   | Different exception handling          |
| `LEAVE label`                           | `EXIT label`                                                | Different loop exit                   |
| `ITERATE label`                         | `CONTINUE label`                                            | Different loop continue               |
| `SIGNAL SQLSTATE`                       | `RAISE EXCEPTION`                                           | Different error raising               |

### 4.3 Trigger conversion

**MySQL trigger:**

```sql
CREATE TRIGGER update_timestamp
BEFORE UPDATE ON customers
FOR EACH ROW
BEGIN
    SET NEW.updated_at = NOW();
END;
```

**PostgreSQL equivalent:**

```sql
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_timestamp
BEFORE UPDATE ON customers
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();
```

Key difference: PostgreSQL triggers call a function (EXECUTE FUNCTION), while MySQL embeds the logic directly in the trigger body.

---

## 5. Data migration for engine switch

### 5.1 Using pgloader (recommended)

pgloader handles both schema conversion and data loading in a single operation:

```bash
# Full migration with pgloader
pgloader mysql://root:pass@mysql-host:3306/mydb \
         postgresql://admin:pass@pg-server.postgres.database.azure.com:5432/mydb

# pgloader automatically:
# - Maps MySQL data types to PostgreSQL types
# - Converts AUTO_INCREMENT to sequences
# - Handles character set conversion
# - Creates indexes and constraints
# - Loads data in parallel
```

### 5.2 Schema-first, then data

For more control, migrate schema and data separately:

```bash
# 1. Extract MySQL schema
mysqldump --no-data --routines --triggers mydb > schema.sql

# 2. Convert schema to PostgreSQL (manual or tool-assisted)
# Review and fix: data types, AUTO_INCREMENT, backticks, etc.

# 3. Create schema in PostgreSQL
psql -h pg-server.postgres.database.azure.com -U admin -d mydb -f schema_pg.sql

# 4. Migrate data with pgloader (data only)
pgloader --with "data only" \
  mysql://root:pass@mysql-host/mydb \
  postgresql://admin:pass@pg-server.postgres.database.azure.com/mydb

# 5. Reset sequences after data load
# pgloader handles this automatically, but verify
SELECT setval(pg_get_serial_sequence('tablename', 'id'),
              (SELECT MAX(id) FROM tablename));
```

### 5.3 Using Azure Data Factory for data movement

ADF can read from MySQL and write to PostgreSQL using the MySQL connector as source and PostgreSQL connector as sink. This is useful for incremental migrations or when pgloader cannot be used.

```json
{
    "name": "MySQL_to_PostgreSQL_Pipeline",
    "properties": {
        "activities": [
            {
                "name": "CopyFromMySQL",
                "type": "Copy",
                "inputs": [
                    {
                        "referenceName": "MySQLSource",
                        "type": "DatasetReference"
                    }
                ],
                "outputs": [
                    {
                        "referenceName": "PostgreSQLSink",
                        "type": "DatasetReference"
                    }
                ],
                "typeProperties": {
                    "source": {
                        "type": "MySqlSource",
                        "query": "SELECT * FROM customers"
                    },
                    "sink": {
                        "type": "PostgreSqlV2Sink",
                        "writeBatchSize": 10000
                    }
                }
            }
        ]
    }
}
```

---

## 6. Application code changes

### 6.1 Connection string changes

| MySQL connection string                                | PostgreSQL connection string                                   |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `mysql://user:pass@host:3306/db`                       | `postgresql://user:pass@host:5432/db`                          |
| `jdbc:mysql://host:3306/db`                            | `jdbc:postgresql://host:5432/db`                               |
| `Server=host;Port=3306;Database=db;Uid=user;Pwd=pass;` | `Host=host;Port=5432;Database=db;Username=user;Password=pass;` |

### 6.2 ORM configuration changes

| ORM                     | MySQL driver                       | PostgreSQL driver                       |
| ----------------------- | ---------------------------------- | --------------------------------------- |
| **SQLAlchemy (Python)** | `mysql+pymysql://`                 | `postgresql+psycopg2://`                |
| **Django**              | `django.db.backends.mysql`         | `django.db.backends.postgresql`         |
| **Entity Framework**    | `Pomelo.EntityFrameworkCore.MySql` | `Npgsql.EntityFrameworkCore.PostgreSQL` |
| **Hibernate**           | `com.mysql.cj.jdbc.Driver`         | `org.postgresql.Driver`                 |
| **Sequelize**           | `dialect: 'mysql'`                 | `dialect: 'postgres'`                   |
| **Prisma**              | `provider = "mysql"`               | `provider = "postgresql"`               |
| **TypeORM**             | `type: "mysql"`                    | `type: "postgres"`                      |

### 6.3 Common code changes

Most ORMs abstract SQL differences, but raw SQL queries need updates:

- Replace backtick quoting with double-quote quoting
- Replace `LIMIT offset, count` with `LIMIT count OFFSET offset`
- Replace `IFNULL()` with `COALESCE()`
- Replace `GROUP_CONCAT()` with `STRING_AGG()`
- Replace `RAND()` with `RANDOM()`
- Replace `NOW()` with `NOW()` (same, but verify timezone handling)
- Replace `LAST_INSERT_ID()` with `RETURNING id` clause or `currval()`

---

## 7. Testing strategy

### 7.1 Validation checklist

- [ ] All tables created with correct data types
- [ ] Row counts match between MySQL and PostgreSQL for every table
- [ ] Stored procedures / functions return identical results for test inputs
- [ ] Triggers fire correctly on INSERT, UPDATE, DELETE
- [ ] Indexes exist and are used by query planner (EXPLAIN ANALYZE)
- [ ] Character encoding preserved (especially multi-byte characters)
- [ ] NULL handling consistent between source and target
- [ ] Date/time values preserved (timezone awareness)
- [ ] Decimal precision preserved
- [ ] Application test suite passes against PostgreSQL backend
- [ ] Performance within acceptable range (compare EXPLAIN plans)
- [ ] Connection pooling configured (PgBouncer on Azure PostgreSQL)

### 7.2 Performance comparison

After migration, compare query performance:

```sql
-- PostgreSQL: Enable timing
\timing

-- Run representative queries and compare execution times
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT c.name, COUNT(o.id) AS order_count, SUM(o.total) AS total_spent
FROM customers c
JOIN orders o ON c.id = o.customer_id
WHERE o.created_at >= '2025-01-01'
GROUP BY c.name
ORDER BY total_spent DESC
LIMIT 20;
```

---

**Next:** [Schema Migration](schema-migration.md) | [Data Migration](data-migration.md) | [Feature Mapping](feature-mapping-complete.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
