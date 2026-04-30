# Oracle to Azure Database for PostgreSQL Migration

**When to choose PostgreSQL, how to use ora2pg for assessment and conversion, PL/SQL to PL/pgSQL conversion patterns, extension ecosystem, and Citus for horizontal scaling.**

---

!!! abstract "When to choose Azure PostgreSQL"
Choose Azure Database for PostgreSQL Flexible Server when your organization has an open-source mandate or preference, cost sensitivity is a primary driver (zero license cost), the application can adapt to PL/pgSQL (syntactically closer to PL/SQL than T-SQL), or you need advanced spatial (PostGIS), vector search (pgvector), or horizontal scale-out (Citus) capabilities.

---

## 1. Azure Database for PostgreSQL for Oracle DBAs

PostgreSQL is the world's most advanced open-source relational database. Azure Database for PostgreSQL Flexible Server provides a fully managed deployment with enterprise features.

| Oracle concept          | PostgreSQL equivalent                          |
| ----------------------- | ---------------------------------------------- |
| Oracle Instance         | PostgreSQL server (cluster)                    |
| Oracle Database         | Database                                       |
| Schema                  | Schema (same concept)                          |
| Tablespace              | Tablespace (similar, less commonly used)       |
| PL/SQL                  | PL/pgSQL (similar syntax)                      |
| Oracle packages         | Schemas + functions/procedures                 |
| SQL\*Plus               | psql                                           |
| RMAN                    | Automated backups (Azure-managed)              |
| Data Guard              | Zone-redundant HA + read replicas              |
| RAC                     | Citus extension (distributed)                  |
| Oracle Text             | Full-text search (tsvector/tsquery)            |
| Oracle Spatial          | PostGIS extension                              |
| Oracle Advanced Queuing | LISTEN/NOTIFY + Azure Service Bus              |
| DBMS_SCHEDULER          | pg_cron extension                              |
| AWR / ASH               | pg_stat_statements + Query Performance Insight |
| Enterprise Manager      | Azure Portal + pgAdmin                         |

---

## 2. ora2pg assessment and conversion

### 2.1 What is ora2pg

ora2pg is the primary open-source tool for Oracle-to-PostgreSQL migration. It performs:

- **Schema analysis** with complexity scoring
- **Schema conversion** (tables, views, sequences, indexes, constraints, triggers, procedures, functions, packages, types)
- **Data migration** with parallel export/import
- **PL/SQL to PL/pgSQL** automated conversion

### 2.2 Installing ora2pg

```bash
# On Ubuntu/Debian (recommended for migration workstation)
sudo apt-get update
sudo apt-get install -y ora2pg

# On RHEL/CentOS
sudo yum install -y ora2pg

# From source (latest version)
git clone https://github.com/darold/ora2pg.git
cd ora2pg
perl Makefile.PL
make && sudo make install

# Verify installation
ora2pg --version
```

### 2.3 Running an assessment

```bash
# Create ora2pg configuration
mkdir -p /opt/ora2pg/migration
cat > /opt/ora2pg/migration/ora2pg.conf << 'EOF'
ORACLE_HOME /usr/lib/oracle/19.0/client64
ORACLE_DSN  dbi:Oracle:host=oracle-prod.agency.gov;sid=FEDDB;port=1521
ORACLE_USER migration_reader
ORACLE_PWD  ***

# Assessment mode
EXPORT_SCHEMA 0
SCHEMA        APP_SCHEMA

# Output
OUTPUT_DIR    /opt/ora2pg/migration/output
DEBUG         0
EOF

# Run assessment report
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t SHOW_REPORT

# Generate detailed migration report
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t SHOW_REPORT --estimate_cost
```

### 2.4 ora2pg complexity scoring

ora2pg rates migration complexity from A (trivial) to C (complex):

| Rating | Description                                  | Typical effort per object | Auto-conversion rate |
| ------ | -------------------------------------------- | ------------------------- | -------------------- |
| **A**  | Simple objects, direct translation           | Minutes                   | 90%+                 |
| **B-** | Moderate complexity, some manual fixes       | Hours                     | 70-90%               |
| **B+** | Significant PL/SQL, Oracle-specific features | Days                      | 50-70%               |
| **C**  | Complex packages, Oracle-specific features   | Weeks                     | 30-50%               |

### 2.5 Schema conversion

```bash
# Convert all schema objects
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t TABLE -o tables.sql
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t VIEW -o views.sql
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t SEQUENCE -o sequences.sql
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t TRIGGER -o triggers.sql
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t FUNCTION -o functions.sql
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t PROCEDURE -o procedures.sql
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t PACKAGE -o packages.sql
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t TYPE -o types.sql
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t GRANT -o grants.sql

# Or convert everything at once
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t ALL -o full_schema.sql
```

---

## 3. PL/SQL to PL/pgSQL conversion patterns

PL/pgSQL is syntactically closer to PL/SQL than T-SQL, making PostgreSQL a natural migration target for PL/SQL-heavy codebases.

### 3.1 Function conversion

```sql
-- Oracle PL/SQL
CREATE OR REPLACE FUNCTION get_employee_salary(
    p_emp_id IN NUMBER
) RETURN NUMBER IS
    v_salary NUMBER(10,2);
BEGIN
    SELECT salary INTO v_salary
    FROM employees
    WHERE employee_id = p_emp_id;

    RETURN v_salary;
EXCEPTION
    WHEN NO_DATA_FOUND THEN
        RETURN NULL;
    WHEN TOO_MANY_ROWS THEN
        RAISE_APPLICATION_ERROR(-20001, 'Multiple employees found');
END get_employee_salary;
/
```

```sql
-- PL/pgSQL (Azure PostgreSQL)
CREATE OR REPLACE FUNCTION get_employee_salary(
    p_emp_id integer
) RETURNS numeric AS $$
DECLARE
    v_salary numeric(10,2);
BEGIN
    SELECT salary INTO STRICT v_salary
    FROM employees
    WHERE employee_id = p_emp_id;

    RETURN v_salary;
EXCEPTION
    WHEN NO_DATA_FOUND THEN
        RETURN NULL;
    WHEN TOO_MANY_ROWS THEN
        RAISE EXCEPTION 'Multiple employees found' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
```

Key differences:

| PL/SQL                             | PL/pgSQL                                           | Notes               |
| ---------------------------------- | -------------------------------------------------- | ------------------- |
| `RETURN type` (function signature) | `RETURNS type`                                     | Plural form         |
| `IS` / `AS`                        | `AS $$` ... `$$ LANGUAGE plpgsql`                  | Dollar-quoted body  |
| `NUMBER(p,s)`                      | `numeric(p,s)`                                     | Data type name      |
| `VARCHAR2(n)`                      | `varchar(n)`                                       | Data type name      |
| `IN` / `OUT` parameter modes       | Same (IN/OUT/INOUT)                                | Same concept        |
| `RAISE_APPLICATION_ERROR`          | `RAISE EXCEPTION`                                  | Error handling      |
| `DBMS_OUTPUT.PUT_LINE`             | `RAISE NOTICE`                                     | Debug output        |
| `SQL%ROWCOUNT`                     | `GET DIAGNOSTICS row_count = ROW_COUNT` or `FOUND` | Row count after DML |
| `EXECUTE IMMEDIATE`                | `EXECUTE`                                          | Dynamic SQL         |

### 3.2 Package conversion

Oracle packages have no direct PostgreSQL equivalent. Convert to schemas with individual functions/procedures.

```sql
-- Oracle package spec
CREATE OR REPLACE PACKAGE hr_pkg AS
    c_max_salary CONSTANT NUMBER := 500000;

    FUNCTION validate_salary(p_salary NUMBER) RETURN BOOLEAN;
    PROCEDURE give_raise(p_emp_id NUMBER, p_pct NUMBER);
END hr_pkg;
/

CREATE OR REPLACE PACKAGE BODY hr_pkg AS
    FUNCTION validate_salary(p_salary NUMBER) RETURN BOOLEAN IS
    BEGIN
        RETURN p_salary > 0 AND p_salary <= c_max_salary;
    END;

    PROCEDURE give_raise(p_emp_id NUMBER, p_pct NUMBER) IS
        v_new_salary NUMBER;
    BEGIN
        SELECT salary * (1 + p_pct/100) INTO v_new_salary
        FROM employees WHERE employee_id = p_emp_id;

        IF NOT validate_salary(v_new_salary) THEN
            RAISE_APPLICATION_ERROR(-20002, 'Salary exceeds maximum');
        END IF;

        UPDATE employees SET salary = v_new_salary
        WHERE employee_id = p_emp_id;
    END;
END hr_pkg;
/
```

```sql
-- PL/pgSQL equivalent
CREATE SCHEMA IF NOT EXISTS hr_pkg;

-- Package constants become a configuration table or function
CREATE OR REPLACE FUNCTION hr_pkg.max_salary()
RETURNS numeric AS $$
BEGIN
    RETURN 500000;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION hr_pkg.validate_salary(p_salary numeric)
RETURNS boolean AS $$
BEGIN
    RETURN p_salary > 0 AND p_salary <= hr_pkg.max_salary();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE PROCEDURE hr_pkg.give_raise(
    p_emp_id integer,
    p_pct numeric
) AS $$
DECLARE
    v_new_salary numeric;
BEGIN
    SELECT salary * (1 + p_pct/100.0) INTO v_new_salary
    FROM employees WHERE employee_id = p_emp_id;

    IF NOT hr_pkg.validate_salary(v_new_salary) THEN
        RAISE EXCEPTION 'Salary exceeds maximum' USING ERRCODE = 'P0002';
    END IF;

    UPDATE employees SET salary = v_new_salary
    WHERE employee_id = p_emp_id;
END;
$$ LANGUAGE plpgsql;
```

### 3.3 Collection types

```sql
-- Oracle: Nested table type
CREATE OR REPLACE TYPE number_list AS TABLE OF NUMBER;
/

CREATE OR REPLACE FUNCTION sum_numbers(p_numbers number_list)
RETURN NUMBER IS
    v_sum NUMBER := 0;
BEGIN
    FOR i IN 1..p_numbers.COUNT LOOP
        v_sum := v_sum + p_numbers(i);
    END LOOP;
    RETURN v_sum;
END;
/
```

```sql
-- PL/pgSQL: Use arrays
CREATE OR REPLACE FUNCTION sum_numbers(p_numbers numeric[])
RETURNS numeric AS $$
DECLARE
    v_sum numeric := 0;
    v_num numeric;
BEGIN
    FOREACH v_num IN ARRAY p_numbers LOOP
        v_sum := v_sum + v_num;
    END LOOP;
    RETURN v_sum;
END;
$$ LANGUAGE plpgsql;

-- Or simpler with built-in aggregate:
-- SELECT sum(unnest) FROM unnest(p_numbers);
```

---

## 4. Extension ecosystem

PostgreSQL's extension ecosystem provides capabilities that Oracle charges separately for or does not offer.

| Capability           | PostgreSQL extension          | Oracle equivalent              | Oracle cost                        |
| -------------------- | ----------------------------- | ------------------------------ | ---------------------------------- |
| Spatial / GIS        | PostGIS                       | Oracle Spatial                 | $17,500/processor                  |
| Full-text search     | Built-in (tsvector)           | Oracle Text                    | Included (EE)                      |
| Vector search / AI   | pgvector                      | Oracle AI Vector Search (23ai) | Included (23ai only)               |
| Time-series          | TimescaleDB                   | Manual partitioning            | Partitioning option ($11,500/proc) |
| Job scheduling       | pg_cron                       | DBMS_SCHEDULER                 | Included                           |
| Horizontal scale-out | Citus                         | RAC                            | $23,000/processor                  |
| Columnar storage     | citus_columnar                | In-Memory option               | $23,000/processor                  |
| Graph                | Apache AGE                    | Graph (23c+)                   | Included (23c only)                |
| Foreign data access  | postgres_fdw, oracle_fdw      | Database Links                 | Included                           |
| Audit logging        | pgAudit                       | Fine-Grained Auditing          | Included (EE)                      |
| Password management  | Custom pg_hba.conf + Entra ID | Oracle profiles                | Included                           |

### 4.1 Enabling extensions on Azure PostgreSQL

```sql
-- Enable extensions (Azure PostgreSQL Flexible Server)
-- Some extensions are pre-installed, others need allow-listing in Azure Portal

-- Check available extensions
SELECT * FROM pg_available_extensions ORDER BY name;

-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- Enable pgvector for AI/RAG patterns
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_cron for scheduling
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Enable pgAudit for audit logging
-- (Must be enabled in server parameters first via Azure Portal)
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- Enable Citus for distributed tables
-- (Available on Citus-enabled server configuration)
CREATE EXTENSION IF NOT EXISTS citus;
```

---

## 5. Citus for horizontal scaling

For Oracle RAC workloads that need horizontal scale-out, Citus on Azure PostgreSQL provides distributed table capabilities.

### 5.1 Citus architecture

```
                   ┌─────────────────┐
                   │   Coordinator   │
                   │   (Routes SQL)  │
                   └────────┬────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
    ┌───────┴──────┐ ┌──────┴───────┐ ┌─────┴──────┐
    │  Worker 1    │ │  Worker 2    │ │  Worker 3  │
    │  (Shards)    │ │  (Shards)    │ │  (Shards)  │
    └──────────────┘ └──────────────┘ └────────────┘
```

### 5.2 Converting Oracle RAC workloads to Citus

```sql
-- Distribute a high-volume table across workers
SELECT create_distributed_table('transactions', 'tenant_id');

-- Reference tables (small lookup tables replicated to all workers)
SELECT create_reference_table('transaction_types');
SELECT create_reference_table('currencies');

-- Queries run in parallel across all workers
SELECT tenant_id, COUNT(*), SUM(amount)
FROM transactions
WHERE transaction_date >= '2024-01-01'
GROUP BY tenant_id;
-- Citus automatically parallelizes and aggregates
```

---

## 6. Data migration with ora2pg

```bash
# Configure data migration in ora2pg.conf
# Add to existing config:
cat >> /opt/ora2pg/migration/ora2pg.conf << 'EOF'

# Data migration settings
PG_DSN     dbi:Pg:dbname=feddb;host=pg-flex.postgres.database.azure.com;port=5432
PG_USER    migration_admin
PG_PWD     ***

# Performance tuning
DATA_LIMIT     10000
JOBS           4
ORACLE_COPIES  4
PG_COPIES      4
DROP_FKEY      1
TRUNCATE_TABLE 1
EOF

# Migrate data (parallel)
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t COPY -j 4

# Or use INSERT mode for complex data types
ora2pg -c /opt/ora2pg/migration/ora2pg.conf -t INSERT -j 4
```

---

## 7. CSA-in-a-Box integration

### 7.1 ADF pipeline for PostgreSQL ingestion

Azure Database for PostgreSQL integrates with CSA-in-a-Box through Azure Data Factory pipelines.

```json
{
    "name": "PostgreSQL_to_OneLake",
    "properties": {
        "activities": [
            {
                "name": "CopyPostgreSQLToLakehouse",
                "type": "Copy",
                "inputs": [
                    {
                        "referenceName": "AzurePostgreSQLSource",
                        "type": "DatasetReference"
                    }
                ],
                "outputs": [
                    {
                        "referenceName": "OneLakeDelta",
                        "type": "DatasetReference"
                    }
                ],
                "typeProperties": {
                    "source": {
                        "type": "AzurePostgreSqlSource",
                        "query": "SELECT * FROM app_schema.employees WHERE updated_at >= '@{pipeline().parameters.watermark}'"
                    },
                    "sink": {
                        "type": "LakehouseTableSink",
                        "tableActionOption": "Append"
                    }
                }
            }
        ]
    }
}
```

### 7.2 dbt source configuration

```yaml
# domains/shared/dbt/models/sources.yml
sources:
    - name: oracle_migrated_pg
      description: "Oracle workloads migrated to Azure PostgreSQL"
      database: feddb
      schema: app_schema
      tables:
          - name: employees
            description: "Employee records (migrated from Oracle HR)"
            columns:
                - name: employee_id
                  tests: [not_null, unique]
          - name: departments
            description: "Department hierarchy (migrated from Oracle HR)"
          - name: transactions
            description: "Financial transactions (migrated from Oracle EBS)"
```

---

## 8. Post-migration validation

```sql
-- PostgreSQL: Validate row counts against Oracle source
SELECT schemaname, relname AS table_name,
       n_live_tup AS approximate_row_count
FROM pg_stat_user_tables
WHERE schemaname = 'app_schema'
ORDER BY relname;

-- Validate data types were correctly mapped
SELECT column_name, data_type, character_maximum_length,
       numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'app_schema' AND table_name = 'employees'
ORDER BY ordinal_position;

-- Performance baseline
SELECT query, calls, mean_exec_time, total_exec_time,
       rows, shared_blks_hit, shared_blks_read
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
