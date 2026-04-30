# Tutorial: Offline Migration Using mysqldump and mysqlimport

**Step-by-step walkthrough: offline migration of a MySQL database to Azure Database for MySQL Flexible Server using mysqldump for export and mysqlimport for import, with parallel export using mydumper for larger databases.**

---

!!! info "Tutorial overview"
| Item | Details |
|---|---|
| **Duration** | 1-2 hours (for databases < 50 GB) |
| **Difficulty** | Beginner |
| **Source** | MySQL 5.7 or 8.0 (any edition) |
| **Target** | Azure Database for MySQL Flexible Server 8.0 |
| **Method** | Offline migration (mysqldump export + import) |
| **Downtime** | Hours (proportional to database size) |
| **Best for** | Small-medium databases (< 100 GB), dev/test, simple migrations |

---

## Prerequisites

- Source MySQL 5.7 or 8.0 with `mysqldump` client installed
- Azure subscription with an Azure Database for MySQL Flexible Server
- MySQL client (`mysql` CLI) on your workstation
- Network connectivity from workstation to both source and target
- Sufficient disk space for dump files (1.5x database size)

---

## Step 1: Create target Azure MySQL Flexible Server

If you have not already created the target server:

```bash
# Create resource group
az group create --name rg-mysql-migration --location eastus

# Create Flexible Server
az mysql flexible-server create \
  --resource-group rg-mysql-migration \
  --name myapp-mysql-target \
  --location eastus \
  --sku-name Standard_D2ds_v4 \
  --tier GeneralPurpose \
  --storage-size 128 \
  --version 8.0-lts \
  --admin-user mysqladmin \
  --admin-password 'TargetServer$trong2026!' \
  --public-access 0.0.0.0 \
  --yes

# Add your IP to firewall
az mysql flexible-server firewall-rule create \
  --resource-group rg-mysql-migration \
  --name myapp-mysql-target \
  --rule-name AllowMyIP \
  --start-ip-address <your-ip> \
  --end-ip-address <your-ip>

# Verify connectivity
mysql -h myapp-mysql-target.mysql.database.azure.com \
  -u mysqladmin -p \
  --ssl-mode=REQUIRED \
  -e "SELECT VERSION();"
```

---

## Step 2: Assess source database

```sql
-- Connect to source MySQL
mysql -h source-host -u root -p

-- Check database sizes
SELECT
    table_schema AS db_name,
    ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb,
    COUNT(*) AS table_count
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
GROUP BY table_schema;

-- Check storage engines (must be InnoDB for HA)
SELECT table_schema, table_name, engine
FROM information_schema.tables
WHERE table_schema = 'mydb'
  AND engine != 'InnoDB';

-- Check character sets
SELECT table_schema, table_name, table_collation
FROM information_schema.tables
WHERE table_schema = 'mydb';

-- Count stored objects
SELECT routine_type, COUNT(*) FROM information_schema.routines
WHERE routine_schema = 'mydb' GROUP BY routine_type;

SELECT COUNT(*) AS trigger_count FROM information_schema.triggers
WHERE trigger_schema = 'mydb';
```

Convert any non-InnoDB tables:

```sql
-- Convert MyISAM to InnoDB
ALTER TABLE mydb.legacy_table ENGINE = InnoDB;
```

---

## Step 3: Export with mysqldump

### 3.1 Full database export

```bash
# Create export directory
mkdir -p /backup/mysql-migration

# Full export with schema + data + routines + triggers + events
mysqldump -h source-host -u root -p \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  --max_allowed_packet=1G \
  --net_buffer_length=32768 \
  --default-character-set=utf8mb4 \
  --column-statistics=0 \
  --databases mydb \
  > /backup/mysql-migration/mydb_full.sql

# Check file size
ls -lh /backup/mysql-migration/mydb_full.sql
```

### 3.2 Split export (schema separately from data)

For more control, export schema and data separately:

```bash
# Schema only
mysqldump -h source-host -u root -p \
  --no-data \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  --databases mydb \
  > /backup/mysql-migration/mydb_schema.sql

# Data only (per table for parallel import)
for TABLE in customers orders products order_items inventory; do
  mysqldump -h source-host -u root -p \
    --no-create-info \
    --single-transaction \
    --set-gtid-purged=OFF \
    --max_allowed_packet=1G \
    mydb $TABLE \
    > /backup/mysql-migration/mydb_${TABLE}.sql &
done
wait
echo "All table exports complete"
```

### 3.3 Clean DEFINER clauses

Azure MySQL Flexible Server may reject DEFINER clauses that reference source-specific users:

```bash
# Remove DEFINER from dump files
sed -i 's/DEFINER=`[^`]*`@`[^`]*`//g' /backup/mysql-migration/mydb_full.sql

# Or replace with target admin user
sed -i 's/DEFINER=`[^`]*`@`[^`]*`/DEFINER=`mysqladmin`@`%`/g' /backup/mysql-migration/mydb_schema.sql
```

---

## Step 4: Import to Azure MySQL Flexible Server

### 4.1 Prepare target for faster import

```sql
-- Connect to target
mysql -h myapp-mysql-target.mysql.database.azure.com -u mysqladmin -p --ssl-mode=REQUIRED

-- Optimize import performance (temporary settings)
SET GLOBAL innodb_flush_log_at_trx_commit = 2;
SET GLOBAL sync_binlog = 0;
SET GLOBAL foreign_key_checks = 0;
SET GLOBAL unique_checks = 0;
SET GLOBAL max_allowed_packet = 1073741824;
```

### 4.2 Import the dump

```bash
# Full import
mysql -h myapp-mysql-target.mysql.database.azure.com \
  -u mysqladmin -p \
  --ssl-mode=REQUIRED \
  --max_allowed_packet=1G \
  < /backup/mysql-migration/mydb_full.sql

# Or import schema first, then data per table:
# Schema
mysql -h myapp-mysql-target.mysql.database.azure.com \
  -u mysqladmin -p --ssl-mode=REQUIRED \
  < /backup/mysql-migration/mydb_schema.sql

# Data (parallel import)
for TABLE in customers orders products order_items inventory; do
  mysql -h myapp-mysql-target.mysql.database.azure.com \
    -u mysqladmin -p'TargetServer$trong2026!' \
    --ssl-mode=REQUIRED \
    --max_allowed_packet=1G \
    mydb \
    < /backup/mysql-migration/mydb_${TABLE}.sql &
done
wait
echo "All table imports complete"
```

### 4.3 Restore safe settings

```sql
-- Restore production settings after import
SET GLOBAL innodb_flush_log_at_trx_commit = 1;
SET GLOBAL sync_binlog = 1;
SET GLOBAL foreign_key_checks = 1;
SET GLOBAL unique_checks = 1;
```

---

## Step 5: Alternative -- parallel export with mydumper

For databases larger than 10 GB, mydumper provides significantly faster export and import through parallelism.

### 5.1 Install mydumper

```bash
# Debian/Ubuntu
sudo apt-get install mydumper

# RHEL/CentOS
sudo yum install mydumper

# macOS
brew install mydumper

# Verify installation
mydumper --version
```

### 5.2 Export with mydumper

```bash
# Parallel export with 8 threads
mydumper \
  --host source-host \
  --user root \
  --password 'SourcePassword' \
  --database mydb \
  --outputdir /backup/mysql-migration/mydumper_output \
  --threads 8 \
  --rows 100000 \
  --compress \
  --routines \
  --triggers \
  --events \
  --verbose 3

# Check output
ls -la /backup/mysql-migration/mydumper_output/
# You will see:
# mydb-schema-create.sql     (CREATE DATABASE)
# mydb.customers-schema.sql  (CREATE TABLE for customers)
# mydb.customers.00000.sql   (data chunk 1)
# mydb.customers.00001.sql   (data chunk 2)
# ...
```

### 5.3 Import with myloader

```bash
# Parallel import with 8 threads
myloader \
  --host myapp-mysql-target.mysql.database.azure.com \
  --user mysqladmin \
  --password 'TargetServer$trong2026!' \
  --database mydb \
  --directory /backup/mysql-migration/mydumper_output \
  --threads 8 \
  --overwrite-tables \
  --verbose 3
```

### 5.4 Performance comparison

| Database size | mysqldump + mysql (single thread) | mydumper + myloader (8 threads) |
| ------------- | --------------------------------- | ------------------------------- |
| 1 GB          | ~5 min                            | ~2 min                          |
| 10 GB         | ~40 min                           | ~12 min                         |
| 50 GB         | ~3.5 hours                        | ~50 min                         |
| 100 GB        | ~7 hours                          | ~2 hours                        |

---

## Step 6: Validate migration

### 6.1 Row count comparison

```sql
-- Run on BOTH source and target, compare results
SELECT 'customers' AS tbl, COUNT(*) AS cnt FROM mydb.customers
UNION ALL SELECT 'orders', COUNT(*) FROM mydb.orders
UNION ALL SELECT 'products', COUNT(*) FROM mydb.products
UNION ALL SELECT 'order_items', COUNT(*) FROM mydb.order_items
UNION ALL SELECT 'inventory', COUNT(*) FROM mydb.inventory;
```

### 6.2 Checksum comparison

```sql
-- Run on BOTH source and target
CHECKSUM TABLE mydb.customers, mydb.orders, mydb.products, mydb.order_items;
```

### 6.3 Schema object validation

```sql
-- Verify stored procedures
SHOW PROCEDURE STATUS WHERE Db = 'mydb';

-- Verify functions
SHOW FUNCTION STATUS WHERE Db = 'mydb';

-- Verify triggers
SHOW TRIGGERS FROM mydb;

-- Verify views
SHOW FULL TABLES FROM mydb WHERE Table_type = 'VIEW';

-- Verify events
SHOW EVENTS FROM mydb;
```

### 6.4 Sample data validation

```sql
-- Compare sample data (first and last rows)
SELECT * FROM mydb.customers ORDER BY id ASC LIMIT 5;
SELECT * FROM mydb.customers ORDER BY id DESC LIMIT 5;

-- Verify auto_increment values
SELECT table_name, auto_increment
FROM information_schema.tables
WHERE table_schema = 'mydb'
  AND auto_increment IS NOT NULL;
```

---

## Step 7: Switch application

### 7.1 Update connection strings

```
# Old connection string
mysql://app_user:password@source-host:3306/mydb

# New connection string
mysql://mysqladmin:TargetServer$trong2026!@myapp-mysql-target.mysql.database.azure.com:3306/mydb?ssl-mode=REQUIRED
```

### 7.2 Test application

1. Start application with new connection string
2. Run smoke tests (login, basic CRUD operations)
3. Verify no SQL errors in application logs
4. Check query performance

### 7.3 Create application user

```sql
-- Create application-specific user (not admin)
CREATE USER 'app_user'@'%' IDENTIFIED BY 'AppUser$trong2026!';
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_user'@'%';
GRANT EXECUTE ON mydb.* TO 'app_user'@'%';
FLUSH PRIVILEGES;
```

---

## Step 8: Post-migration tasks

### 8.1 Analyze tables

```sql
-- Update optimizer statistics
ANALYZE TABLE mydb.customers;
ANALYZE TABLE mydb.orders;
ANALYZE TABLE mydb.products;
ANALYZE TABLE mydb.order_items;
ANALYZE TABLE mydb.inventory;
```

### 8.2 Enable monitoring

```bash
# Slow query log
az mysql flexible-server parameter set \
  --resource-group rg-mysql-migration \
  --server-name myapp-mysql-target \
  --name slow_query_log --value ON

az mysql flexible-server parameter set \
  --resource-group rg-mysql-migration \
  --server-name myapp-mysql-target \
  --name long_query_time --value 2
```

### 8.3 Configure backups

```bash
# Set backup retention to 14 days
az mysql flexible-server update \
  --resource-group rg-mysql-migration \
  --name myapp-mysql-target \
  --backup-retention 14

# Enable geo-redundant backup
az mysql flexible-server update \
  --resource-group rg-mysql-migration \
  --name myapp-mysql-target \
  --geo-redundant-backup Enabled
```

### 8.4 Clean up

```bash
# Remove temporary firewall rules
az mysql flexible-server firewall-rule delete \
  --resource-group rg-mysql-migration \
  --name myapp-mysql-target \
  --rule-name AllowMyIP --yes

# Delete dump files
rm -rf /backup/mysql-migration/
```

---

## Troubleshooting

| Issue                                    | Cause                            | Solution                                             |
| ---------------------------------------- | -------------------------------- | ---------------------------------------------------- |
| **Import fails with "Access denied"**    | SUPER privilege required by dump | Remove `DEFINER` clauses from dump file              |
| **Import fails with "Packet too large"** | `max_allowed_packet` too small   | Set `max_allowed_packet=1G` on target                |
| **Import very slow**                     | Default durability settings      | Set `innodb_flush_log_at_trx_commit=2` during import |
| **Character encoding issues**            | Mismatched charsets              | Add `--default-character-set=utf8mb4` to mysqldump   |
| **Foreign key constraint fails**         | Tables imported in wrong order   | Disable `foreign_key_checks` during import           |
| **Auto_increment gap**                   | Expected after migration         | Verify with `SELECT MAX(id) FROM table`              |
| **SSL connection error**                 | Missing or wrong CA certificate  | Download DigiCertGlobalRootCA.crt.pem                |
| **mysqldump hangs on large table**       | Memory exhaustion                | Add `--quick` flag to stream results                 |

---

**Next:** [Tutorial: DMS Online Migration](tutorial-dms-migration.md) | [Data Migration](data-migration.md) | [Best Practices](best-practices.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
