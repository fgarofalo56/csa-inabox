# Tutorial: Oracle to PostgreSQL with ora2pg

**Step-by-step walkthrough: install ora2pg, analyze an Oracle schema, convert to PostgreSQL, deploy to Azure Database for PostgreSQL Flexible Server, and validate the migration.**

---

!!! info "Prerequisites" - Oracle Database 11g or later with read access - Azure Database for PostgreSQL Flexible Server provisioned - Linux workstation or VM (Ubuntu 20.04+ recommended) for ora2pg - Oracle Instant Client installed on the migration workstation - Perl DBI and DBD::Oracle modules - Network connectivity to both Oracle source and Azure PostgreSQL target

    **Time estimate:** 3-4 hours for a small database (< 100 tables, < 10 GB)

---

## Step 1: Set up the migration environment

### 1.1 Install Oracle Instant Client

```bash
# Download Oracle Instant Client for Linux
# https://www.oracle.com/database/technologies/instant-client/linux-x86-64-downloads.html

# Install basic + SDK packages
sudo mkdir -p /opt/oracle
cd /opt/oracle
unzip instantclient-basic-linux.x64-19.22.0.0.0dbru.zip
unzip instantclient-sdk-linux.x64-19.22.0.0.0dbru.zip

# Configure environment
echo 'export ORACLE_HOME=/opt/oracle/instantclient_19_22' >> ~/.bashrc
echo 'export LD_LIBRARY_PATH=$ORACLE_HOME:$LD_LIBRARY_PATH' >> ~/.bashrc
echo 'export PATH=$ORACLE_HOME:$PATH' >> ~/.bashrc
source ~/.bashrc

# Verify
sqlplus -V
```

### 1.2 Install Perl Oracle driver

```bash
# Install Perl and required modules
sudo apt-get update
sudo apt-get install -y perl libdbi-perl cpanminus libaio1

# Install DBD::Oracle
sudo cpanm DBD::Oracle

# Install DBD::Pg (for direct PostgreSQL connection)
sudo apt-get install -y libpq-dev
sudo cpanm DBD::Pg

# Verify
perl -e 'use DBD::Oracle; print "Oracle driver OK\n";'
perl -e 'use DBD::Pg; print "PostgreSQL driver OK\n";'
```

### 1.3 Install ora2pg

```bash
# Install from package manager
sudo apt-get install -y ora2pg

# Or install latest from source
git clone https://github.com/darold/ora2pg.git
cd ora2pg
perl Makefile.PL
make
sudo make install

# Verify
ora2pg --version
# Expected: Ora2Pg v24.x
```

---

## Step 2: Configure ora2pg

### 2.1 Create project directory

```bash
mkdir -p /opt/migration/feddb
cd /opt/migration/feddb

# Initialize ora2pg project
ora2pg --project_base /opt/migration --init_project feddb

# This creates:
# /opt/migration/feddb/
# ├── config/
# │   └── ora2pg.conf
# ├── data/
# ├── reports/
# ├── schema/
# │   ├── tables/
# │   ├── views/
# │   ├── sequences/
# │   ├── triggers/
# │   ├── functions/
# │   ├── procedures/
# │   ├── packages/
# │   ├── types/
# │   └── grants/
# └── sources/
```

### 2.2 Edit configuration

```bash
cat > /opt/migration/feddb/config/ora2pg.conf << 'CONF'
#---------------------------------------------------------------------
# Oracle source connection
#---------------------------------------------------------------------
ORACLE_HOME     /opt/oracle/instantclient_19_22
ORACLE_DSN      dbi:Oracle:host=oracle-prod.agency.gov;sid=FEDDB;port=1521
ORACLE_USER     migration_reader
ORACLE_PWD      ***

#---------------------------------------------------------------------
# Schema to migrate
#---------------------------------------------------------------------
SCHEMA          APP_SCHEMA
EXPORT_SCHEMA   1

#---------------------------------------------------------------------
# PostgreSQL target connection
#---------------------------------------------------------------------
PG_DSN          dbi:Pg:dbname=feddb;host=pg-flex.postgres.database.azure.com;port=5432;sslmode=require
PG_USER         migration_admin
PG_PWD          ***

#---------------------------------------------------------------------
# Conversion options
#---------------------------------------------------------------------
# Map Oracle schema to PostgreSQL schema
PG_SCHEMA       app_schema

# Data type mapping overrides
DATA_TYPE       DATE:timestamp,LONG:text,LONG RAW:bytea,CLOB:text,NCLOB:text,BLOB:bytea,BFILE:bytea

# Convert Oracle NUMBER to appropriate PostgreSQL types
DEFAULT_NUMERIC numeric
PG_INTEGER_TYPE 1
PG_NUMERIC_TYPE numeric

# PL/SQL conversion
PLSQL_PGSQL     1
NULL_EQUAL_EMPTY 1

#---------------------------------------------------------------------
# Performance options
#---------------------------------------------------------------------
DATA_LIMIT      10000
JOBS            4
ORACLE_COPIES   4
PG_COPIES       4
LONGREADLEN     1048576

#---------------------------------------------------------------------
# Output
#---------------------------------------------------------------------
OUTPUT_DIR      /opt/migration/feddb/schema
FILE_PER_TABLE  1
FILE_PER_FUNCTION 1
CONF
```

---

## Step 3: Run assessment report

### 3.1 Generate migration report

```bash
cd /opt/migration/feddb

# Generate assessment report
ora2pg -c config/ora2pg.conf -t SHOW_REPORT --estimate_cost \
    > reports/migration_assessment.txt

# View the report
cat reports/migration_assessment.txt
```

### 3.2 Interpreting the assessment

The report shows each object type with a migration cost estimate:

```
-----------------------------------------------
Migration level: B-5
-----------------------------------------------
Migration level: B-5 (moderate complexity)

Object type               Count  Cost   Details
---------------------------------------------------------
TABLE                     45     1.0    All tables convertible
VIEW                      12     1.5    3 views with Oracle-specific syntax
SEQUENCE                  15     0.5    Direct conversion
INDEX                     78     1.0    All standard indexes
CONSTRAINT                120    0.5    All constraints convertible
TRIGGER                   8      3.0    BEFORE triggers need conversion
FUNCTION                  25     2.0    Some DECODE/NVL patterns
PROCEDURE                 35     3.0    Complex PL/SQL in 8 procedures
PACKAGE                   5      5.0    Decompose to schemas + functions
TYPE                      3      2.0    Collection types need arrays
GRANT                     45     0.5    Role mapping needed
---------------------------------------------------------
Total estimated cost: 20.5 person-days
Migration level: B-5 (moderate, 15-30 days)
```

### 3.3 Complexity ratings

| Level      | Description     | Typical effort |
| ---------- | --------------- | -------------- |
| A-1 to A-3 | Trivial to easy | 1-5 days       |
| B-4 to B-6 | Moderate        | 5-30 days      |
| B-7 to B-9 | Difficult       | 30-60 days     |
| C-10+      | Very complex    | 60+ days       |

---

## Step 4: Convert schema objects

### 4.1 Convert each object type

```bash
cd /opt/migration/feddb

# Convert in recommended order
ora2pg -c config/ora2pg.conf -t SEQUENCE -o schema/sequences/sequences.sql
ora2pg -c config/ora2pg.conf -t TABLE -o schema/tables/tables.sql
ora2pg -c config/ora2pg.conf -t VIEW -o schema/views/views.sql
ora2pg -c config/ora2pg.conf -t FUNCTION -o schema/functions/functions.sql
ora2pg -c config/ora2pg.conf -t PROCEDURE -o schema/procedures/procedures.sql
ora2pg -c config/ora2pg.conf -t PACKAGE -o schema/packages/packages.sql
ora2pg -c config/ora2pg.conf -t TRIGGER -o schema/triggers/triggers.sql
ora2pg -c config/ora2pg.conf -t TYPE -o schema/types/types.sql
ora2pg -c config/ora2pg.conf -t GRANT -o schema/grants/grants.sql

echo "Schema conversion complete. Review output files."
```

### 4.2 Review converted SQL

```bash
# Check for conversion warnings
grep -rn "TODO" schema/
grep -rn "FIXME" schema/
grep -rn "ora2pg" schema/  # ora2pg leaves comments for manual fixes

# Review a converted procedure
cat schema/procedures/procedures.sql | head -100
```

### 4.3 Manual fixes for common issues

```sql
-- Fix 1: Oracle SYSDATE -> PostgreSQL now()
-- ora2pg usually handles this, but verify:
-- Before: WHERE created_date > SYSDATE - 30
-- After:  WHERE created_date > now() - interval '30 days'

-- Fix 2: CONNECT BY -> recursive CTE
-- ora2pg may leave a TODO comment for complex hierarchical queries
-- See schema-migration.md for conversion patterns

-- Fix 3: Package global variables
-- Oracle packages with state variables need redesign
-- Option A: Use a configuration table
-- Option B: Use session variables (SET/SHOW)
-- Option C: Use function parameters instead of global state

-- Fix 4: AUTONOMOUS_TRANSACTION
-- See schema-migration.md for dblink pattern
```

---

## Step 5: Create target database on Azure PostgreSQL

### 5.1 Provision Flexible Server (if not already done)

```bash
# Create resource group
az group create --name rg-oracle-migration --location eastus

# Create PostgreSQL Flexible Server
az postgres flexible-server create \
    --resource-group rg-oracle-migration \
    --name pg-flex-feddb \
    --location eastus \
    --admin-user migration_admin \
    --admin-password "***" \
    --sku-name Standard_D4ds_v5 \
    --tier GeneralPurpose \
    --storage-size 256 \
    --version 16 \
    --high-availability ZoneRedundant \
    --public-access None

# Configure private endpoint (if using VNet)
az network private-endpoint create \
    --resource-group rg-oracle-migration \
    --name pe-pg-flex-feddb \
    --vnet-name vnet-prod \
    --subnet snet-data \
    --private-connection-resource-id $(az postgres flexible-server show \
        --resource-group rg-oracle-migration --name pg-flex-feddb --query id -o tsv) \
    --group-id postgresqlServer \
    --connection-name pg-connection

# Enable required extensions
az postgres flexible-server parameter set \
    --resource-group rg-oracle-migration \
    --server-name pg-flex-feddb \
    --name azure.extensions \
    --value "pgcrypto,pg_cron,pgaudit,postgis,uuid-ossp"
```

### 5.2 Create database and schema

```bash
# Connect to PostgreSQL
psql "host=pg-flex-feddb.postgres.database.azure.com \
      dbname=postgres \
      user=migration_admin \
      sslmode=require"

# Create target database
CREATE DATABASE feddb WITH ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8';

# Connect to new database
\c feddb

# Create schema
CREATE SCHEMA IF NOT EXISTS app_schema;
```

---

## Step 6: Deploy schema to Azure PostgreSQL

### 6.1 Deploy in order

```bash
# Deploy schema objects in dependency order
psql "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
    -f schema/types/types.sql

psql "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
    -f schema/sequences/sequences.sql

psql "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
    -f schema/tables/tables.sql

psql "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
    -f schema/views/views.sql

psql "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
    -f schema/functions/functions.sql

psql "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
    -f schema/procedures/procedures.sql

psql "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
    -f schema/packages/packages.sql

psql "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
    -f schema/triggers/triggers.sql
```

### 6.2 Verify schema deployment

```sql
-- Check object counts
SELECT
    CASE c.relkind
        WHEN 'r' THEN 'TABLE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'i' THEN 'INDEX'
    END AS object_type,
    COUNT(*) AS count
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'app_schema'
  AND c.relkind IN ('r', 'v', 'S', 'i')
GROUP BY c.relkind
ORDER BY object_type;

-- Check functions and procedures
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'app_schema'
ORDER BY routine_type, routine_name;

-- Check triggers
SELECT trigger_name, event_object_table, action_timing, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'app_schema'
ORDER BY event_object_table, trigger_name;
```

---

## Step 7: Migrate data

### 7.1 Migrate data with ora2pg

```bash
# Migrate data using COPY mode (fastest)
ora2pg -c config/ora2pg.conf -t COPY -j 4 -o data/data_load.sql

# Monitor progress
# ora2pg shows per-table progress:
# [1/45] Exporting table EMPLOYEES (25,000 rows)...
# [2/45] Exporting table DEPARTMENTS (50 rows)...
# ...

# For very large tables, use direct PostgreSQL COPY
ora2pg -c config/ora2pg.conf -t COPY -j 4 --pg_dsn "dbi:Pg:dbname=feddb;host=pg-flex-feddb.postgres.database.azure.com;port=5432;sslmode=require"
```

### 7.2 Alternative: CSV export + COPY import

```bash
# For tables too large for ora2pg direct migration
# Step 1: Export from Oracle to CSV
sqlplus -S migration_reader/***@oracle-prod.agency.gov:1521/FEDDB << 'EOF'
SET COLSEP ','
SET PAGESIZE 0
SET LINESIZE 32767
SET FEEDBACK OFF
SET HEADING ON
SET TRIMSPOOL ON
SPOOL /opt/migration/feddb/data/transactions.csv
SELECT employee_id, department_id, salary, hire_date, name
FROM APP_SCHEMA.EMPLOYEES;
SPOOL OFF
EXIT;
EOF

# Step 2: Upload to Azure (if remote)
azcopy copy '/opt/migration/feddb/data/transactions.csv' \
    'https://stmigration.blob.core.windows.net/data/'

# Step 3: Import to PostgreSQL
psql "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
    -c "\COPY app_schema.employees(employee_id, department_id, salary, hire_date, name) FROM '/opt/migration/feddb/data/transactions.csv' WITH CSV HEADER"
```

---

## Step 8: Validate the migration

### 8.1 Row count comparison

```bash
# Create validation script
cat > /opt/migration/feddb/validate_counts.sh << 'SCRIPT'
#!/bin/bash
echo "=== Row Count Validation ==="
echo ""

TABLES="employees departments transactions audit_log documents"

for TABLE in $TABLES; do
    ORA_COUNT=$(sqlplus -S migration_reader/***@oracle-prod:1521/FEDDB << EOF
SET PAGESIZE 0 FEEDBACK OFF
SELECT COUNT(*) FROM APP_SCHEMA.$TABLE;
EXIT;
EOF
)
    PG_COUNT=$(psql -t -A \
        "host=pg-flex-feddb.postgres.database.azure.com dbname=feddb user=migration_admin sslmode=require" \
        -c "SELECT COUNT(*) FROM app_schema.$TABLE;")

    if [ "$ORA_COUNT" = "$PG_COUNT" ]; then
        echo "PASS: $TABLE - Oracle: $ORA_COUNT, PostgreSQL: $PG_COUNT"
    else
        echo "FAIL: $TABLE - Oracle: $ORA_COUNT, PostgreSQL: $PG_COUNT"
    fi
done
SCRIPT

chmod +x /opt/migration/feddb/validate_counts.sh
./validate_counts.sh
```

### 8.2 Data integrity checks

```sql
-- PostgreSQL: Verify data types
SELECT column_name, data_type, character_maximum_length,
       numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'app_schema' AND table_name = 'employees'
ORDER BY ordinal_position;

-- Verify foreign key integrity
SELECT tc.table_name, tc.constraint_name,
       kcu.column_name, ccu.table_name AS foreign_table
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'app_schema';
```

### 8.3 Functional testing

```sql
-- Test converted functions
SELECT app_schema.get_employee_salary(1001);

-- Test converted procedures
CALL app_schema.update_salary(1001, 85000.00);

-- Verify trigger behavior
INSERT INTO app_schema.employees (name, department_id, salary)
VALUES ('Test User', 10, 50000);
-- Check that audit trigger fired
SELECT * FROM app_schema.audit_log ORDER BY log_time DESC LIMIT 1;
```

---

## Step 9: Configure ADF pipeline for CSA-in-a-Box

```bash
# Create ADF linked service for PostgreSQL
# In Azure Portal: ADF > Manage > Linked Services > New
# Select "Azure Database for PostgreSQL"
# Configure connection to pg-flex-feddb

# Create pipeline to copy data to OneLake
# ADF > Author > New Pipeline > "PG_to_OneLake_Incremental"
# Add Copy Activity:
#   Source: Azure PostgreSQL (query with watermark)
#   Sink: Lakehouse Table (OneLake Delta)
# Schedule: Every 15 minutes for near-real-time
```

---

## Troubleshooting

| Issue                              | Cause                              | Resolution                                                    |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `DBD::Oracle install failed`       | Missing Oracle client libraries    | Ensure `ORACLE_HOME` and `LD_LIBRARY_PATH` are set            |
| `ORA-12154: TNS could not resolve` | Oracle connectivity issue          | Verify tnsnames.ora or host:port/sid syntax                   |
| `encoding mismatch`                | Oracle charset vs PostgreSQL UTF-8 | Set `NLS_LANG=AMERICAN_AMERICA.AL32UTF8` in environment       |
| `function body syntax error`       | PL/SQL not fully converted         | Review ora2pg TODO comments, apply manual fixes               |
| `COPY failed on large table`       | Memory or network timeout          | Reduce DATA_LIMIT, increase LONGREADLEN                       |
| `permission denied on extension`   | Extension not allow-listed         | Enable in Azure Portal > Server Parameters > azure.extensions |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
