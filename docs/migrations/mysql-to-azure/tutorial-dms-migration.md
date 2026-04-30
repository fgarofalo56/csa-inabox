# Tutorial: Online Migration Using Azure DMS with Binlog Replication

**Step-by-step walkthrough: migrate a MySQL database to Azure Database for MySQL Flexible Server with minimal downtime using Azure Database Migration Service and binlog-based continuous sync.**

---

!!! info "Tutorial overview"
| Item | Details |
|---|---|
| **Duration** | 2-3 hours |
| **Difficulty** | Intermediate |
| **Source** | MySQL 8.0 on-premises or VM (InnoDB tables, binlog enabled) |
| **Target** | Azure Database for MySQL Flexible Server 8.0 |
| **Method** | Azure DMS online migration (full load + CDC via binlog) |
| **Downtime** | Minutes (cutover window only) |
| **Prerequisites** | Azure subscription, source MySQL with binlog enabled, network connectivity |

---

## Prerequisites

### Source MySQL server

- MySQL 5.7 or 8.0 (Community or Enterprise Edition)
- Binary logging enabled (`log_bin = ON`)
- `binlog_format = ROW`
- `binlog_row_image = FULL`
- All tables must use InnoDB storage engine
- A MySQL user with `REPLICATION SLAVE`, `REPLICATION CLIENT`, and `SELECT` privileges
- Network access from Azure to source MySQL (firewall, VPN, or public endpoint)

### Azure resources

- Azure subscription with sufficient quota
- Resource group for migration resources
- Azure Database for MySQL Flexible Server (target) -- created in this tutorial
- Azure Database Migration Service instance
- Azure VNet with subnet for DMS (if using private connectivity)

### Tools

- Azure CLI installed and authenticated (`az login`)
- MySQL client (`mysql` CLI or MySQL Workbench)
- Access to Azure Portal

---

## Step 1: Verify source MySQL configuration

Connect to your source MySQL server and verify the prerequisites.

```sql
-- 1.1 Check MySQL version
SELECT VERSION();
-- Expected: 5.7.x or 8.0.x

-- 1.2 Verify binary logging
SHOW VARIABLES LIKE 'log_bin';
-- Expected: ON

SHOW VARIABLES LIKE 'binlog_format';
-- Expected: ROW

SHOW VARIABLES LIKE 'binlog_row_image';
-- Expected: FULL

SHOW VARIABLES LIKE 'server_id';
-- Expected: >= 1

-- 1.3 Check GTID mode (recommended)
SHOW VARIABLES LIKE 'gtid_mode';
-- Recommended: ON

-- 1.4 Check storage engines
SELECT table_schema, table_name, engine
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND engine != 'InnoDB';
-- Expected: Empty result set (all tables should be InnoDB)
```

If binlog is not enabled, add these settings to your MySQL configuration (`my.cnf` or `my.ini`) and restart MySQL:

```ini
[mysqld]
log-bin = mysql-bin
binlog_format = ROW
binlog_row_image = FULL
server-id = 1
gtid_mode = ON
enforce-gtid-consistency = ON
binlog_expire_logs_seconds = 604800
```

If any tables use MyISAM or other non-InnoDB engines, convert them:

```sql
-- Convert MyISAM tables to InnoDB
ALTER TABLE mydb.non_innodb_table ENGINE = InnoDB;
```

---

## Step 2: Create migration user on source

```sql
-- 2.1 Create dedicated migration user
CREATE USER 'dms_migration'@'%' IDENTIFIED BY 'DmsMigration$trong2026!';

-- 2.2 Grant required privileges
GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'dms_migration'@'%';
GRANT SELECT ON *.* TO 'dms_migration'@'%';

-- 2.3 Flush privileges
FLUSH PRIVILEGES;

-- 2.4 Verify grants
SHOW GRANTS FOR 'dms_migration'@'%';
```

---

## Step 3: Capture source database metrics

Before migration, capture metrics for target sizing and post-migration validation.

```sql
-- 3.1 Database sizes
SELECT
    table_schema AS 'Database',
    ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) AS 'Size_GB',
    COUNT(*) AS 'Table_Count',
    SUM(table_rows) AS 'Approx_Row_Count'
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
GROUP BY table_schema
ORDER BY SUM(data_length + index_length) DESC;

-- 3.2 Largest tables
SELECT table_schema, table_name,
    ROUND((data_length + index_length) / 1024 / 1024, 2) AS 'Size_MB',
    table_rows AS 'Approx_Rows'
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
ORDER BY (data_length + index_length) DESC
LIMIT 20;

-- 3.3 Stored procedure and function count
SELECT routine_schema, routine_type, COUNT(*) AS count
FROM information_schema.routines
WHERE routine_schema NOT IN ('mysql', 'sys')
GROUP BY routine_schema, routine_type;

-- 3.4 Trigger count
SELECT trigger_schema, COUNT(*) AS count
FROM information_schema.triggers
WHERE trigger_schema NOT IN ('mysql', 'sys')
GROUP BY trigger_schema;

-- 3.5 Record row counts for validation
SELECT 'customers' AS tbl, COUNT(*) AS cnt FROM mydb.customers
UNION ALL SELECT 'orders', COUNT(*) FROM mydb.orders
UNION ALL SELECT 'products', COUNT(*) FROM mydb.products
UNION ALL SELECT 'order_items', COUNT(*) FROM mydb.order_items;
```

Save these results -- you will compare them against the target after migration.

---

## Step 4: Create Azure MySQL Flexible Server (target)

```bash
# 4.1 Create resource group (if not exists)
az group create \
  --name rg-mysql-migration \
  --location eastus

# 4.2 Create Azure MySQL Flexible Server
az mysql flexible-server create \
  --resource-group rg-mysql-migration \
  --name myapp-mysql-target \
  --location eastus \
  --sku-name Standard_D4ds_v4 \
  --tier GeneralPurpose \
  --storage-size 256 \
  --version 8.0-lts \
  --admin-user mysqladmin \
  --admin-password 'TargetServer$trong2026!' \
  --public-access 0.0.0.0 \
  --yes

# 4.3 Configure server parameters to match source
az mysql flexible-server parameter set \
  --resource-group rg-mysql-migration \
  --server-name myapp-mysql-target \
  --name sql_mode \
  --value "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION"

az mysql flexible-server parameter set \
  --resource-group rg-mysql-migration \
  --server-name myapp-mysql-target \
  --name character_set_server \
  --value utf8mb4

az mysql flexible-server parameter set \
  --resource-group rg-mysql-migration \
  --server-name myapp-mysql-target \
  --name collation_server \
  --value utf8mb4_0900_ai_ci

# 4.4 Add firewall rule to allow your IP (for testing)
az mysql flexible-server firewall-rule create \
  --resource-group rg-mysql-migration \
  --name myapp-mysql-target \
  --rule-name AllowMyIP \
  --start-ip-address <your-ip> \
  --end-ip-address <your-ip>

# 4.5 Verify connectivity
mysql -h myapp-mysql-target.mysql.database.azure.com \
  -u mysqladmin -p \
  --ssl-mode=REQUIRED \
  -e "SELECT VERSION();"
```

---

## Step 5: Migrate schema objects (pre-DMS)

DMS migrates data but not all schema objects. Export and apply schema objects separately.

```bash
# 5.1 Export schema from source (no data)
mysqldump -h source-mysql-host -u root -p \
  --no-data \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  --databases mydb > mydb_schema.sql

# 5.2 Clean up DEFINER clauses (replace with target admin)
sed -i 's/DEFINER=`[^`]*`@`[^`]*`/DEFINER=`mysqladmin`@`%`/g' mydb_schema.sql

# 5.3 Apply schema to target
mysql -h myapp-mysql-target.mysql.database.azure.com \
  -u mysqladmin -p \
  --ssl-mode=REQUIRED \
  < mydb_schema.sql

# 5.4 Verify schema was created
mysql -h myapp-mysql-target.mysql.database.azure.com \
  -u mysqladmin -p \
  --ssl-mode=REQUIRED \
  -e "USE mydb; SHOW TABLES; SHOW PROCEDURE STATUS WHERE Db='mydb';"
```

---

## Step 6: Create Azure DMS migration project

### 6.1 Using Azure Portal

1. Navigate to **Azure Portal** > **Azure Database Migration Service**
2. Click **+ Create** to create a new DMS instance
3. Configure:
    - **Resource group:** `rg-mysql-migration`
    - **Service name:** `dms-mysql-migration`
    - **Location:** Same region as target (e.g., East US)
    - **Pricing tier:** Standard (for online migrations)
    - **VNet:** Select your VNet if using private connectivity
4. Click **Create** and wait for deployment

### 6.2 Create migration project

1. Open the DMS instance
2. Click **+ New Migration Project**
3. Configure:
    - **Project name:** `mysql-to-flexibleserver`
    - **Source server type:** MySQL
    - **Target server type:** Azure Database for MySQL Flexible Server
    - **Migration activity type:** Online data migration
4. Click **Create and run activity**

### 6.3 Configure source connection

1. **Source server name:** `source-mysql-host` (hostname or IP)
2. **Port:** 3306
3. **User name:** `dms_migration`
4. **Password:** `DmsMigration$trong2026!`
5. **SSL mode:** Require (or Prefer, depending on source config)
6. Click **Test connection** to verify

### 6.4 Configure target connection

1. **Server name:** `myapp-mysql-target.mysql.database.azure.com`
2. **Port:** 3306
3. **User name:** `mysqladmin`
4. **Password:** `TargetServer$trong2026!`
5. Click **Test connection** to verify

### 6.5 Select databases and tables

1. Select the databases to migrate (e.g., `mydb`)
2. Select specific tables or all tables
3. DMS will show a mapping between source and target databases

### 6.6 Configure migration settings

1. **Migration mode:** Online
2. This enables continuous sync via binlog replication after initial data load

### 6.7 Start migration

1. Review the migration summary
2. Click **Run migration**
3. Monitor the migration activity in the DMS dashboard

---

## Step 7: Monitor migration progress

### 7.1 DMS dashboard

The DMS dashboard shows:

- **Full load status:** Tables being loaded, rows copied, duration
- **CDC status:** Binlog position, replication lag, events applied
- **Errors:** Any tables or rows that failed to migrate

### 7.2 Key metrics to monitor

| Metric                   | Target value            | Action if not met                     |
| ------------------------ | ----------------------- | ------------------------------------- |
| **Full load completion** | 100% for all tables     | Check DMS error logs                  |
| **CDC replication lag**  | < 5 seconds             | Check source IOPS, network bandwidth  |
| **CDC events applied**   | Increasing continuously | Verify binlog retention on source     |
| **Error count**          | 0                       | Review error details; fix and restart |

### 7.3 Monitor from target

```sql
-- Check table row counts on target (should match source)
SELECT 'customers' AS tbl, COUNT(*) AS cnt FROM mydb.customers
UNION ALL SELECT 'orders', COUNT(*) FROM mydb.orders
UNION ALL SELECT 'products', COUNT(*) FROM mydb.products
UNION ALL SELECT 'order_items', COUNT(*) FROM mydb.order_items;

-- Check for any gaps
SELECT MAX(id) FROM mydb.customers;
SELECT MAX(id) FROM mydb.orders;
```

---

## Step 8: Validate data before cutover

Before cutting over, validate that data on the target matches the source.

```sql
-- 8.1 Row count comparison (run on both source and target)
SELECT table_name, table_rows
FROM information_schema.tables
WHERE table_schema = 'mydb'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- 8.2 Checksum comparison (run on both source and target)
CHECKSUM TABLE mydb.customers, mydb.orders, mydb.products;

-- 8.3 Sample data comparison
-- Run the same query on both source and target and compare results
SELECT * FROM mydb.customers ORDER BY id LIMIT 10;
SELECT * FROM mydb.orders WHERE created_at > '2026-01-01' ORDER BY id LIMIT 10;

-- 8.4 Verify stored procedures exist
SHOW PROCEDURE STATUS WHERE Db = 'mydb';
SHOW FUNCTION STATUS WHERE Db = 'mydb';

-- 8.5 Verify triggers exist
SHOW TRIGGERS FROM mydb;

-- 8.6 Verify views exist
SHOW FULL TABLES FROM mydb WHERE Table_type = 'VIEW';
```

---

## Step 9: Execute cutover

### 9.1 Pre-cutover checklist

- [ ] Replication lag is consistently < 1 second
- [ ] Row counts match between source and target
- [ ] Schema objects (procedures, triggers, views) verified on target
- [ ] Application tested against target in read-only mode
- [ ] Rollback plan documented (reconnect to source MySQL)
- [ ] Maintenance window communicated to stakeholders
- [ ] DNS TTL reduced (if using DNS-based cutover)

### 9.2 Cutover procedure

```bash
# 9.2.1 Stop application writes to source
# -- Stop application servers or put into maintenance mode
# -- This prevents new writes during cutover

# 9.2.2 Wait for DMS replication to catch up
# In DMS dashboard, verify "Pending changes" = 0

# 9.2.3 Perform cutover in DMS
# In Azure Portal:
# 1. Go to DMS migration activity
# 2. Click "Start cutover"
# 3. Confirm cutover
# DMS will:
#   - Stop reading binlog from source
#   - Apply any remaining pending changes
#   - Mark migration as "Completed"

# 9.2.4 Update application connection strings
# Old: mysql://user:pass@source-mysql-host:3306/mydb
# New: mysql://mysqladmin:pass@myapp-mysql-target.mysql.database.azure.com:3306/mydb?ssl-mode=REQUIRED

# 9.2.5 Restart application servers

# 9.2.6 Verify application is working with new target
mysql -h myapp-mysql-target.mysql.database.azure.com \
  -u mysqladmin -p \
  --ssl-mode=REQUIRED \
  -e "SELECT COUNT(*) FROM mydb.customers; SELECT NOW();"
```

### 9.3 Post-cutover validation

```sql
-- Verify writes are landing on target
INSERT INTO mydb.customers (name, email) VALUES ('Test User', 'test@example.com');
SELECT * FROM mydb.customers ORDER BY id DESC LIMIT 1;
DELETE FROM mydb.customers WHERE email = 'test@example.com';

-- Verify auto_increment is correct
SELECT table_name, auto_increment
FROM information_schema.tables
WHERE table_schema = 'mydb' AND auto_increment IS NOT NULL;

-- Check for any application errors in Azure Monitor
-- Azure Portal > MySQL Flexible Server > Monitoring > Metrics
```

---

## Step 10: Post-migration optimization

### 10.1 Analyze tables

```sql
-- Update table statistics for query optimizer
ANALYZE TABLE mydb.customers;
ANALYZE TABLE mydb.orders;
ANALYZE TABLE mydb.products;
ANALYZE TABLE mydb.order_items;
```

### 10.2 Enable monitoring

```bash
# Enable slow query log
az mysql flexible-server parameter set \
  --resource-group rg-mysql-migration \
  --server-name myapp-mysql-target \
  --name slow_query_log \
  --value ON

az mysql flexible-server parameter set \
  --resource-group rg-mysql-migration \
  --server-name myapp-mysql-target \
  --name long_query_time \
  --value 2

# Enable audit logging
az mysql flexible-server parameter set \
  --resource-group rg-mysql-migration \
  --server-name myapp-mysql-target \
  --name audit_log_enabled \
  --value ON

az mysql flexible-server parameter set \
  --resource-group rg-mysql-migration \
  --server-name myapp-mysql-target \
  --name audit_log_events \
  --value "CONNECTION,QUERY_DDL,QUERY_DCL"
```

### 10.3 Configure HA (if not already)

```bash
# Enable zone-redundant HA
az mysql flexible-server update \
  --resource-group rg-mysql-migration \
  --name myapp-mysql-target \
  --high-availability ZoneRedundant
```

### 10.4 Configure Fabric Mirroring for CSA-in-a-Box

1. Open Microsoft Fabric portal (https://app.fabric.microsoft.com)
2. Create a new workspace or use existing CSA-in-a-Box workspace
3. Click **+ New** > **Mirrored Database** > **Azure MySQL**
4. Enter connection details for `myapp-mysql-target.mysql.database.azure.com`
5. Select tables to mirror
6. Start mirroring -- data flows to OneLake in near-real-time

---

## Step 11: Clean up

```bash
# Delete DMS instance (after successful migration)
az dms delete \
  --resource-group rg-mysql-migration \
  --name dms-mysql-migration \
  --yes

# Remove migration user from source (after decommission)
# mysql -h source-mysql-host -u root -p -e "DROP USER 'dms_migration'@'%';"

# Remove temporary firewall rules
az mysql flexible-server firewall-rule delete \
  --resource-group rg-mysql-migration \
  --name myapp-mysql-target \
  --rule-name AllowMyIP \
  --yes
```

---

## Troubleshooting

### Common issues

| Issue                              | Cause                                    | Solution                                                             |
| ---------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| **DMS cannot connect to source**   | Firewall, network, credentials           | Verify port 3306 is open; test with `mysql` CLI from Azure VM        |
| **Binlog not enabled**             | Source MySQL config                      | Enable `log_bin=ON` in my.cnf; restart MySQL                         |
| **Replication lag increasing**     | Source under heavy write load            | Increase target server tier; check IOPS                              |
| **Table migration fails**          | DEFINER issues, unsupported features     | Check DMS error log; fix DEFINER clauses                             |
| **Cutover fails**                  | Pending changes cannot be applied        | Wait for lag to reach zero; retry cutover                            |
| **Authentication error on target** | Wrong credentials or SSL mode            | Verify credentials; use `--ssl-mode=REQUIRED`                        |
| **Character set mismatch**         | Source and target use different charsets | Set `character_set_server` on target to match source                 |
| **GTID mismatch**                  | Mixed GTID modes                         | Use `--set-gtid-purged=OFF` in mysqldump; use binlog position in DMS |

---

**Next:** [Tutorial: mysqldump Migration](tutorial-mysqldump.md) | [Data Migration](data-migration.md) | [Best Practices](best-practices.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
