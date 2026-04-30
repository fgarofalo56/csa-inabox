# MySQL to Azure Database for MySQL Flexible Server Migration

**Migrating MySQL Community or Enterprise Edition to Azure Database for MySQL Flexible Server: version compatibility, server parameter mapping, character set handling, storage configuration, IOPS tuning, and HA architecture.**

---

!!! abstract "Migration summary"
Azure Database for MySQL Flexible Server runs the same MySQL Community Edition engine as your source database. For MySQL 5.7 and 8.0 workloads, migration is a same-engine move -- no schema conversion, no SQL syntax changes, no stored procedure rewriting. The primary work involves parameter mapping, networking configuration, and data movement. MySQL 5.6 and earlier must upgrade to 5.7 or 8.0 before migrating.

---

## 1. Version compatibility

### 1.1 Supported versions on Azure MySQL Flexible Server

| MySQL version             | Azure MySQL Flexible Server support | End of life     | Notes                                                      |
| ------------------------- | ----------------------------------- | --------------- | ---------------------------------------------------------- |
| **MySQL 8.4 (LTS)**       | Supported                           | TBD (LTS track) | Long-term support version, recommended for new deployments |
| **MySQL 8.0**             | Supported                           | April 2026      | Most common production version; plan upgrade to 8.4        |
| **MySQL 5.7**             | End of support Oct 2025             | October 2025    | Migrate to 8.0 or 8.4 during migration to Azure            |
| **MySQL 5.6**             | Not supported                       | February 2021   | Must upgrade to 5.7 or 8.0 first                           |
| **MySQL 5.5 and earlier** | Not supported                       | December 2018   | Must upgrade through 5.6 -> 5.7 -> 8.0                     |

### 1.2 MariaDB version compatibility

MariaDB is not natively supported on Azure MySQL Flexible Server, but MariaDB 10.x workloads can migrate to Azure MySQL Flexible Server with caveats:

| MariaDB version        | Migration path                                 | Key considerations                                                        |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| **MariaDB 10.2-10.6**  | Migrate to Azure MySQL Flexible Server 8.0     | MariaDB-specific SQL (sequences, system versioning) must be converted     |
| **MariaDB 10.7-10.11** | Migrate to Azure MySQL Flexible Server 8.0/8.4 | Increasing divergence; test thoroughly                                    |
| **MariaDB 11.x**       | Evaluate case-by-case                          | Significant feature divergence; consider PostgreSQL as alternative target |

### 1.3 Pre-migration version upgrade path

If your source is MySQL 5.6 or earlier, follow this upgrade path before migrating to Azure:

```
MySQL 5.5 -> MySQL 5.6 -> MySQL 5.7 -> MySQL 8.0 -> Azure MySQL Flexible Server 8.0/8.4
```

Each version upgrade should be tested in a staging environment. Key upgrade considerations:

- **5.6 to 5.7:** `sql_mode` defaults change (STRICT_TRANS_TABLES, ONLY_FULL_GROUP_BY), `PASSWORD()` function removed, `mysql_old_password` plugin removed
- **5.7 to 8.0:** `utf8mb4` becomes default charset, `caching_sha2_password` becomes default auth plugin, query cache removed, `GROUP BY` implicit sorting removed
- **8.0 to 8.4:** Minor behavioral changes; LTS version with extended support

---

## 2. Server parameter mapping

### 2.1 Critical parameters

Azure MySQL Flexible Server exposes most MySQL server parameters through the Azure portal, CLI, or API. Some parameters are not configurable because they are managed by the service.

| Parameter                           | Self-hosted default             | Azure Flexible Server                   | Configurable           | Notes                                                       |
| ----------------------------------- | ------------------------------- | --------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| **innodb_buffer_pool_size**         | 128 MB (default) / tuned by DBA | Auto-sized based on SKU (50-80% of RAM) | Yes                    | Set via server parameter                                    |
| **innodb_buffer_pool_instances**    | 8 (when buffer pool > 1 GB)     | Auto-configured based on SKU            | No                     | Managed by service                                          |
| **innodb_log_file_size**            | 48 MB (default) / tuned by DBA  | Auto-sized based on SKU                 | No                     | Managed by service                                          |
| **innodb_flush_log_at_trx_commit**  | 1 (full durability)             | 1 (default, recommended)                | Yes                    | Set to 2 for performance (reduced durability)               |
| **innodb_flush_method**             | fsync (default)                 | O_DIRECT                                | No                     | Optimized by service                                        |
| **max_connections**                 | 151 (default)                   | SKU-based (varies by tier)              | Yes                    | Burstable: 50-800, GP: 100-5000, MO: 200-10000              |
| **max_allowed_packet**              | 64 MB                           | 64 MB (default)                         | Yes                    | Up to 1 GB                                                  |
| **wait_timeout**                    | 28800                           | 28800                                   | Yes                    | Reduce for connection-heavy workloads                       |
| **interactive_timeout**             | 28800                           | 28800                                   | Yes                    | Match wait_timeout                                          |
| **innodb_lock_wait_timeout**        | 50                              | 50                                      | Yes                    | Increase for long-running transactions                      |
| **sql_mode**                        | Varies by version               | MySQL 8.0 defaults                      | Yes                    | Match source sql_mode during migration                      |
| **character_set_server**            | varies                          | utf8mb4                                 | Yes                    | Match source; plan migration to utf8mb4                     |
| **collation_server**                | varies                          | utf8mb4_0900_ai_ci (8.0)                | Yes                    | Match source during migration                               |
| **lower_case_table_names**          | 0 (Linux) / 1 (Windows)         | 1 (default on Azure)                    | Yes (at creation only) | Must be set during server creation; cannot be changed later |
| **log_bin_trust_function_creators** | OFF                             | OFF                                     | Yes                    | Set to ON if using functions with deterministic issues      |
| **local_infile**                    | OFF                             | OFF                                     | Yes                    | Enable if using LOAD DATA LOCAL INFILE                      |
| **event_scheduler**                 | OFF                             | OFF                                     | Yes                    | Enable if using MySQL events                                |
| **binlog_expire_logs_seconds**      | 2592000 (30 days)               | Managed by service                      | No                     | Managed for replication                                     |
| **slow_query_log**                  | OFF                             | OFF (enable recommended)                | Yes                    | Enable for performance monitoring                           |
| **long_query_time**                 | 10                              | 10                                      | Yes                    | Reduce to 1-2 seconds for production monitoring             |

### 2.2 Parameters not available on Flexible Server

These parameters cannot be set because the service manages them:

| Parameter                     | Reason                               |
| ----------------------------- | ------------------------------------ |
| **basedir / datadir**         | Managed by service                   |
| **bind-address**              | Networking managed by Azure          |
| **skip-networking**           | Always network-enabled               |
| **innodb_data_file_path**     | Managed storage                      |
| **innodb_log_group_home_dir** | Managed storage                      |
| **pid-file**                  | Managed by service                   |
| **socket**                    | Managed by service                   |
| **tmpdir**                    | Managed by service                   |
| **secure-file-priv**          | Managed by service                   |
| **plugin_dir**                | Managed by service (limited plugins) |

### 2.3 Exporting current parameters

Capture your source server's parameter configuration before migration:

```sql
-- Export all global variables
SELECT @@global.variable_name, @@global.variable_value
FROM performance_schema.global_variables
ORDER BY variable_name;

-- Or use SHOW VARIABLES
SHOW GLOBAL VARIABLES;

-- Save to file
mysql -u root -p -e "SHOW GLOBAL VARIABLES" > /tmp/mysql_variables.txt

-- Key parameters to capture and map
SHOW VARIABLES LIKE 'innodb_%';
SHOW VARIABLES LIKE 'max_%';
SHOW VARIABLES LIKE 'character%';
SHOW VARIABLES LIKE 'collation%';
SHOW VARIABLES LIKE 'sql_mode';
SHOW VARIABLES LIKE 'lower_case%';
SHOW VARIABLES LIKE 'time_zone';
```

---

## 3. Character set and collation handling

### 3.1 Character set migration

| Source charset     | Target charset                   | Action required                               |
| ------------------ | -------------------------------- | --------------------------------------------- |
| **utf8mb4**        | utf8mb4                          | No change (recommended)                       |
| **utf8** (utf8mb3) | utf8mb4 (recommended) or utf8mb3 | Convert to utf8mb4 for full Unicode support   |
| **latin1**         | utf8mb4 (recommended) or latin1  | Convert to utf8mb4; watch for data truncation |
| **ascii**          | utf8mb4 or ascii                 | Convert to utf8mb4 (superset)                 |
| **binary**         | binary                           | No change                                     |

### 3.2 Collation mapping

| Source collation       | Target collation                         | Notes                                 |
| ---------------------- | ---------------------------------------- | ------------------------------------- |
| **utf8mb4_unicode_ci** | utf8mb4_unicode_ci or utf8mb4_0900_ai_ci | 0900 collation is faster on MySQL 8.0 |
| **utf8mb4_general_ci** | utf8mb4_general_ci or utf8mb4_0900_ai_ci | general_ci is faster but less correct |
| **utf8_general_ci**    | utf8mb4_general_ci                       | Convert charset simultaneously        |
| **latin1_swedish_ci**  | utf8mb4_0900_ai_ci (recommended)         | Full Unicode support                  |
| **binary**             | binary                                   | No change                             |

### 3.3 Converting character sets

```sql
-- Check current database character set
SELECT schema_name, default_character_set_name, default_collation_name
FROM information_schema.schemata;

-- Check table character sets
SELECT table_name, table_collation
FROM information_schema.tables
WHERE table_schema = 'your_database';

-- Check column character sets
SELECT table_name, column_name, character_set_name, collation_name
FROM information_schema.columns
WHERE table_schema = 'your_database'
  AND character_set_name IS NOT NULL;

-- Convert database
ALTER DATABASE your_database CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- Convert table
ALTER TABLE your_table CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- Convert specific column
ALTER TABLE your_table MODIFY column_name VARCHAR(255)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

---

## 4. Storage configuration

### 4.1 Storage tier selection

| Storage tier                           | IOPS (baseline)        | Max IOPS                      | Max storage | Best for                      |
| -------------------------------------- | ---------------------- | ----------------------------- | ----------- | ----------------------------- |
| **Premium SSD**                        | 3 IOPS/GB              | Up to 20,000 (storage-scaled) | 16 TB       | Standard production workloads |
| **Premium SSD + Pre-provisioned IOPS** | 3 IOPS/GB + additional | Up to 80,000                  | 16 TB       | I/O-intensive workloads       |

### 4.2 Sizing storage from source

```sql
-- Get total database size
SELECT
    table_schema AS 'Database',
    ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) AS 'Size (GB)',
    ROUND(SUM(data_length) / 1024 / 1024 / 1024, 2) AS 'Data (GB)',
    ROUND(SUM(index_length) / 1024 / 1024 / 1024, 2) AS 'Index (GB)'
FROM information_schema.tables
GROUP BY table_schema
ORDER BY SUM(data_length + index_length) DESC;

-- Get IOPS baseline (requires performance_schema or OS tools)
-- On Linux, use iostat:
-- iostat -x 1 60 | grep sda
-- Capture: r/s (reads/sec) + w/s (writes/sec) = total IOPS
```

**Sizing guideline:** Provision storage at **1.5x current data size** to account for growth, temporary tables, and InnoDB overhead. For IOPS, capture peak IOPS from your source server and provision accordingly.

### 4.3 Storage auto-grow

Enable storage auto-grow to prevent out-of-space failures:

```bash
# Azure CLI
az mysql flexible-server update \
  --resource-group myResourceGroup \
  --name myMySQLServer \
  --storage-auto-grow Enabled
```

Storage auto-grow increases storage in increments when free space falls below a threshold. Storage can only grow -- it cannot shrink. Plan initial sizing carefully to avoid paying for over-provisioned storage.

---

## 5. IOPS configuration

### 5.1 Understanding IOPS on Flexible Server

IOPS on Azure MySQL Flexible Server can be scaled in two ways:

1. **Storage-scaled IOPS:** 3 IOPS per GB of provisioned storage. A 1 TB server gets 3,000 IOPS baseline.
2. **Pre-provisioned IOPS:** Additional IOPS purchased independently of storage. Allows up to 80,000 IOPS regardless of storage size.

### 5.2 IOPS sizing from source workload

```sql
-- Check InnoDB I/O statistics
SHOW GLOBAL STATUS LIKE 'Innodb_data_reads';
SHOW GLOBAL STATUS LIKE 'Innodb_data_writes';
SHOW GLOBAL STATUS LIKE 'Innodb_data_fsyncs';
SHOW GLOBAL STATUS LIKE 'Innodb_os_log_written';

-- Query performance_schema for I/O wait events
SELECT event_name, count_star, sum_timer_wait/1000000000 AS total_wait_ms
FROM performance_schema.events_waits_summary_global_by_event_name
WHERE event_name LIKE 'wait/io/file/innodb/%'
ORDER BY sum_timer_wait DESC;
```

---

## 6. High availability architecture

### 6.1 HA options on Flexible Server

| HA mode               | Architecture                      | Failover time   | SLA    | Cost impact |
| --------------------- | --------------------------------- | --------------- | ------ | ----------- |
| **No HA**             | Single server                     | Manual recovery | 99.9%  | 1x compute  |
| **Same-zone HA**      | Primary + standby in same AZ      | 60-120 seconds  | 99.99% | 2x compute  |
| **Zone-redundant HA** | Primary + standby in different AZ | 60-120 seconds  | 99.99% | 2x compute  |

### 6.2 Mapping source HA to Azure HA

| Source HA pattern                             | Azure equivalent                       | Notes                                                              |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| **MySQL async replication** (manual failover) | Zone-redundant HA (automatic failover) | Significant improvement                                            |
| **MySQL semi-sync replication**               | Zone-redundant HA                      | Similar durability, automated failover                             |
| **MySQL Group Replication** (single-primary)  | Zone-redundant HA                      | Simplified, same or better availability                            |
| **MySQL InnoDB Cluster**                      | Zone-redundant HA                      | Service-managed, no MySQL Shell/Router needed                      |
| **MariaDB Galera Cluster** (multi-primary)    | Zone-redundant HA (single-primary)     | Multi-primary not supported; redesign for single-primary if needed |
| **ProxySQL + replication** (read/write split) | Primary + read replicas (up to 10)     | Application manages routing                                        |
| **MHA (Master High Availability)**            | Zone-redundant HA                      | Service-managed, MHA not needed                                    |
| **Orchestrator** (automated failover)         | Zone-redundant HA                      | Service-managed, Orchestrator not needed                           |
| **Keepalived + VIP**                          | Built-in DNS failover                  | No VIP management needed                                           |

### 6.3 HA configuration

```bash
# Create Flexible Server with zone-redundant HA
az mysql flexible-server create \
  --resource-group myResourceGroup \
  --name myMySQLServer \
  --location eastus \
  --sku-name Standard_D4ds_v4 \
  --tier GeneralPurpose \
  --storage-size 256 \
  --high-availability ZoneRedundant \
  --zone 1 \
  --standby-zone 2 \
  --admin-user myadmin \
  --admin-password 'ComplexPassword123!'

# Add read replicas for read scale-out
az mysql flexible-server replica create \
  --resource-group myResourceGroup \
  --name myMySQLReplica \
  --source-server myMySQLServer \
  --location eastus
```

---

## 7. Networking configuration

### 7.1 Connectivity options

| Option                                | Description                                  | Best for                                      |
| ------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| **Public access with firewall**       | Public endpoint with IP-based firewall rules | Dev/test, simple deployments                  |
| **Private access (VNet integration)** | Server deployed into a VNet subnet           | Production, compliance-sensitive workloads    |
| **Private Link**                      | Private endpoint in your VNet                | Hybrid connectivity, multi-VNet architectures |

### 7.2 VNet integration setup

```bash
# Create Flexible Server with VNet integration
az mysql flexible-server create \
  --resource-group myResourceGroup \
  --name myMySQLServer \
  --location eastus \
  --sku-name Standard_D8ds_v4 \
  --tier GeneralPurpose \
  --storage-size 512 \
  --vnet myVNet \
  --subnet mySubnet \
  --private-dns-zone myPrivateDnsZone
```

### 7.3 DNS configuration

Azure MySQL Flexible Server with VNet integration uses Azure Private DNS zones. Ensure your application DNS resolution points to the private DNS zone:

- **Private DNS zone format:** `<server-name>.private.mysql.database.azure.com`
- **Public endpoint format:** `<server-name>.mysql.database.azure.com`

---

## 8. Pre-migration checklist

- [ ] Verify source MySQL version is 5.7 or 8.0 (upgrade if earlier)
- [ ] Confirm all tables use InnoDB (convert MyISAM, Aria, MEMORY tables)
- [ ] Capture current server parameters (`SHOW GLOBAL VARIABLES`)
- [ ] Document character sets and collations for all databases, tables, columns
- [ ] Inventory stored procedures, triggers, events, and views
- [ ] Identify usage of SUPER privilege and refactor
- [ ] Test with `lower_case_table_names=1` if source uses case-sensitive table names
- [ ] Review application connection strings and SSL/TLS configuration
- [ ] Capture performance baselines (slow query log, IOPS, connection counts)
- [ ] Size target compute and storage based on source metrics
- [ ] Choose HA mode (no HA, same-zone, zone-redundant)
- [ ] Plan networking (public, VNet integration, Private Link)
- [ ] Configure Entra ID authentication if replacing MySQL passwords
- [ ] Schedule maintenance window for production cutover

---

**Next:** [Schema Migration](schema-migration.md) | [Data Migration](data-migration.md) | [Tutorial: DMS Online Migration](tutorial-dms-migration.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
