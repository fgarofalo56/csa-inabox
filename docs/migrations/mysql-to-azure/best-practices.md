# MySQL to Azure Migration -- Best Practices

**Version compatibility checklist, parameter tuning for Azure MySQL Flexible Server, connection pooling, monitoring with slow query log and Performance Insights, and CSA-in-a-Box integration patterns using Fabric Mirroring for MySQL and ADF MySQL connector.**

---

## 1. Assessment methodology

### 1.1 Discovery phase

Before any migration work begins, conduct a thorough MySQL estate discovery:

```sql
-- Inventory all databases and sizes
SELECT
    table_schema AS db_name,
    ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) AS size_gb,
    COUNT(*) AS table_count,
    SUM(table_rows) AS approx_rows
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
GROUP BY table_schema
ORDER BY SUM(data_length + index_length) DESC;

-- Check MySQL version
SELECT VERSION();

-- Check storage engines in use
SELECT engine, COUNT(*) AS table_count,
    ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS total_size_mb
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
GROUP BY engine;

-- Check for stored procedures, functions, triggers, events
SELECT routine_schema, routine_type, COUNT(*)
FROM information_schema.routines
WHERE routine_schema NOT IN ('mysql', 'sys')
GROUP BY routine_schema, routine_type;

SELECT trigger_schema, COUNT(*)
FROM information_schema.triggers
WHERE trigger_schema NOT IN ('mysql', 'sys')
GROUP BY trigger_schema;

SELECT event_schema, COUNT(*)
FROM information_schema.events
GROUP BY event_schema;

-- Check character sets and collations
SELECT character_set_name, collation_name, COUNT(*) AS column_count
FROM information_schema.columns
WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
  AND character_set_name IS NOT NULL
GROUP BY character_set_name, collation_name
ORDER BY column_count DESC;
```

### 1.2 Complexity scoring

| Dimension                  | Low complexity       | Medium complexity            | High complexity                                 |
| -------------------------- | -------------------- | ---------------------------- | ----------------------------------------------- |
| **Database size**          | < 10 GB              | 10-500 GB                    | > 500 GB                                        |
| **Table count**            | < 50                 | 50-500                       | > 500                                           |
| **Storage engines**        | InnoDB only          | InnoDB + MyISAM              | Multiple engines (Aria, ColumnStore, FEDERATED) |
| **Stored procedures**      | None                 | < 50                         | > 50 or complex logic                           |
| **Triggers**               | None                 | < 20                         | > 20 or cross-table triggers                    |
| **Character sets**         | utf8mb4 only         | Mixed (utf8, latin1)         | Multiple non-UTF8 charsets                      |
| **Replication**            | None or simple async | Semi-sync                    | Group Replication / Galera                      |
| **MySQL version**          | 8.0                  | 5.7                          | 5.6 or earlier                                  |
| **MariaDB features**       | None                 | Sequences, CHECK constraints | System versioning, ColumnStore                  |
| **Cross-database queries** | None                 | Simple JOINs                 | Complex cross-DB dependencies                   |

---

## 2. Version compatibility checklist

### 2.1 Pre-migration compatibility check

- [ ] **MySQL version:** Confirm source is 5.7 or 8.0 (required for Azure MySQL Flexible Server)
- [ ] **sql_mode:** Document current `sql_mode` and set identically on target
- [ ] **lower_case_table_names:** Must be set during target server creation (cannot change later)
- [ ] **character_set_server:** Document and match on target (recommend utf8mb4)
- [ ] **collation_server:** Document and match on target
- [ ] **time_zone:** Document and configure on target
- [ ] **innodb_strict_mode:** Verify and match
- [ ] **explicit_defaults_for_timestamp:** Verify and match
- [ ] **default_authentication_plugin:** caching_sha2_password on MySQL 8.0
- [ ] **All tables InnoDB:** Convert MyISAM, Aria, MEMORY tables before migration

### 2.2 Breaking changes by version

| Upgrade path         | Breaking changes                                                                                        | Mitigation                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **5.7 to 8.0**       | Query cache removed, GROUP BY implicit sort removed, `utf8mb4` default, `caching_sha2_password` default | Test queries, update GROUP BY with ORDER BY, update client drivers |
| **8.0 to 8.4**       | Minor behavioral changes, deprecations                                                                  | Review MySQL 8.4 release notes                                     |
| **MariaDB to MySQL** | Sequences removed, system versioning removed, Aria engine not supported                                 | Convert to MySQL-compatible equivalents                            |

---

## 3. Parameter tuning for Azure MySQL Flexible Server

### 3.1 Essential parameters to configure

```sql
-- Buffer pool: Set to maximum available (auto-sized but verify)
-- Azure auto-sizes to 50-80% of RAM
SHOW VARIABLES LIKE 'innodb_buffer_pool_size';

-- Connection limits: Size based on expected concurrency
-- Rule of thumb: 4x number of application server threads
SET GLOBAL max_connections = 500;  -- Adjust based on tier

-- Slow query logging: Enable for monitoring
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 2;  -- Log queries > 2 seconds

-- Wait timeout: Reduce from default 28800 to prevent stale connections
SET GLOBAL wait_timeout = 600;       -- 10 minutes
SET GLOBAL interactive_timeout = 600;

-- Temporary tables: Size based on query complexity
SET GLOBAL tmp_table_size = 67108864;      -- 64 MB
SET GLOBAL max_heap_table_size = 67108864; -- 64 MB

-- Sort buffer: Increase for ORDER BY / GROUP BY heavy workloads
SET GLOBAL sort_buffer_size = 4194304;  -- 4 MB (per connection)

-- Join buffer: Increase for JOIN-heavy queries without indexes
SET GLOBAL join_buffer_size = 4194304;  -- 4 MB (per connection)

-- Thread cache: Reduce connection overhead
SET GLOBAL thread_cache_size = 50;  -- Reuse threads
```

### 3.2 Parameters by workload type

| Workload                             | Key parameters                                                               | Recommended values                       |
| ------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------- |
| **Web application (OLTP)**           | `innodb_flush_log_at_trx_commit`, `max_connections`, `wait_timeout`          | 1 (full durability), 200-500, 300        |
| **Reporting / Analytics**            | `tmp_table_size`, `sort_buffer_size`, `join_buffer_size`, `read_buffer_size` | 128 MB, 8 MB, 8 MB, 1 MB                 |
| **High-write ingestion**             | `innodb_flush_log_at_trx_commit`, `innodb_io_capacity`, pre-provisioned IOPS | 2 (reduced durability OK), 2000+, 10000+ |
| **WordPress / CMS**                  | `query_cache_size` (5.7 only), `max_connections`, `table_open_cache`         | 64 MB, 100, 2000                         |
| **Connection-heavy (microservices)** | `max_connections`, `wait_timeout`, `thread_cache_size`                       | 1000+, 60, 100                           |

### 3.3 Parameters to avoid changing

| Parameter                 | Why not to change                              |
| ------------------------- | ---------------------------------------------- |
| `innodb_buffer_pool_size` | Auto-sized by Azure; changing may cause issues |
| `innodb_log_file_size`    | Managed by service                             |
| `innodb_flush_method`     | Optimized for Azure storage                    |
| `innodb_file_per_table`   | Always ON on Flexible Server                   |

---

## 4. Connection pooling

### 4.1 Why connection pooling matters on Azure MySQL

Each MySQL connection consumes ~10 MB of RAM and a server thread. Without pooling, applications that create/destroy connections frequently waste resources and hit `max_connections` limits.

### 4.2 Application-level pooling recommendations

**Python (SQLAlchemy):**

```python
from sqlalchemy import create_engine

engine = create_engine(
    "mysql+pymysql://admin:password@server.mysql.database.azure.com/mydb",
    pool_size=20,           # Persistent connections
    max_overflow=10,         # Additional connections under load
    pool_timeout=30,         # Wait time for available connection
    pool_recycle=1800,       # Recycle connections every 30 min
    pool_pre_ping=True,      # Verify connection before use
    connect_args={
        "ssl": {"ca": "/path/to/DigiCertGlobalRootCA.crt.pem"}
    }
)
```

**Java (HikariCP):**

```java
HikariConfig config = new HikariConfig();
config.setJdbcUrl("jdbc:mysql://server.mysql.database.azure.com:3306/mydb?useSSL=true&requireSSL=true");
config.setUsername("admin");
config.setPassword("password");
config.setMaximumPoolSize(20);
config.setMinimumIdle(5);
config.setConnectionTimeout(30000);
config.setIdleTimeout(600000);
config.setMaxLifetime(1800000);
config.setLeakDetectionThreshold(60000);
```

**Node.js (mysql2):**

```javascript
const mysql = require("mysql2");

const pool = mysql.createPool({
    host: "server.mysql.database.azure.com",
    user: "admin",
    password: "password",
    database: "mydb",
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
    ssl: { ca: fs.readFileSync("/path/to/DigiCertGlobalRootCA.crt.pem") },
});
```

### 4.3 Connection pool sizing formula

```
Pool size = (Number of app server instances) * (Threads per instance) * 0.5
```

Example: 4 app servers with 10 threads each = 4 _ 10 _ 0.5 = 20 connections per pool.

Total connections = 4 servers \* 20 pool connections = 80 active connections.

Ensure `max_connections` on Azure MySQL is set higher than total expected connections (add 20% buffer).

---

## 5. Monitoring

### 5.1 Slow query log

Enable and configure the slow query log for ongoing performance monitoring:

```bash
# Enable via Azure CLI
az mysql flexible-server parameter set \
  --resource-group myResourceGroup \
  --server-name myMySQLServer \
  --name slow_query_log --value ON

az mysql flexible-server parameter set \
  --resource-group myResourceGroup \
  --server-name myMySQLServer \
  --name long_query_time --value 2

az mysql flexible-server parameter set \
  --resource-group myResourceGroup \
  --server-name myMySQLServer \
  --name log_slow_admin_statements --value ON

az mysql flexible-server parameter set \
  --resource-group myResourceGroup \
  --server-name myMySQLServer \
  --name log_queries_not_using_indexes --value ON
```

### 5.2 Performance Insights

Azure MySQL Flexible Server provides Query Performance Insights in the Azure Portal:

| Feature                  | What it shows                                 | How to use                            |
| ------------------------ | --------------------------------------------- | ------------------------------------- |
| **Long-running queries** | Top queries by duration                       | Identify queries needing optimization |
| **Wait statistics**      | What queries are waiting on (I/O, locks, CPU) | Identify bottlenecks                  |
| **Query store**          | Execution plan history                        | Detect plan regressions               |
| **Active queries**       | Currently executing queries                   | Real-time troubleshooting             |

### 5.3 Azure Monitor metrics

Key metrics to monitor and alert on:

| Metric                        | Warning threshold | Critical threshold | Action                                   |
| ----------------------------- | ----------------- | ------------------ | ---------------------------------------- |
| **CPU percentage**            | > 70%             | > 90%              | Scale up compute tier                    |
| **Memory percentage**         | > 80%             | > 95%              | Scale up or optimize queries             |
| **Storage percentage**        | > 75%             | > 90%              | Enable auto-grow or provision more       |
| **IOPS percentage**           | > 70%             | > 90%              | Add pre-provisioned IOPS                 |
| **Active connections**        | > 70% of max      | > 90% of max       | Increase max_connections or scale up     |
| **Replication lag (seconds)** | > 5 seconds       | > 30 seconds       | Scale up replica or reduce write load    |
| **Aborted connections**       | > 10/min          | > 50/min           | Fix client SSL config or connection pool |
| **Slow queries**              | > 10/min          | > 50/min           | Review slow query log; optimize queries  |

```bash
# Create alert rule for high CPU
az monitor metrics alert create \
  --name "MySQL-High-CPU" \
  --resource-group myResourceGroup \
  --scopes "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DBforMySQL/flexibleServers/myMySQLServer" \
  --condition "avg cpu_percent > 90" \
  --window-size 5m \
  --evaluation-frequency 1m \
  --action "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Insights/actionGroups/myActionGroup"
```

### 5.4 Diagnostic logging

```bash
# Enable diagnostic settings
az monitor diagnostic-settings create \
  --resource "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DBforMySQL/flexibleServers/myMySQLServer" \
  --name "MySQLDiagnostics" \
  --workspace "<log-analytics-workspace-id>" \
  --logs '[
    {"category": "MySqlSlowLogs", "enabled": true},
    {"category": "MySqlAuditLogs", "enabled": true}
  ]' \
  --metrics '[{"category": "AllMetrics", "enabled": true}]'
```

---

## 6. CSA-in-a-Box integration

### 6.1 Fabric Mirroring for Azure MySQL

Fabric Mirroring for Azure MySQL enables near-real-time replication of MySQL tables into Microsoft Fabric's OneLake as Delta Lake tables. This is the recommended integration pattern for analytics on MySQL data within the CSA-in-a-Box platform.

**How it works:**

1. Fabric Mirroring reads the MySQL binlog (similar to a replica)
2. Changes are streamed to OneLake as Delta Lake tables
3. dbt models in CSA-in-a-Box transform data through medallion layers (Bronze/Silver/Gold)
4. Power BI with Direct Lake serves analytics with zero data movement
5. Microsoft Purview catalogs and classifies the mirrored data

**Setup steps:**

1. Ensure binlog is enabled on Azure MySQL Flexible Server (default for HA-enabled servers)
2. In Microsoft Fabric portal, create a new Mirrored Database
3. Select "Azure Database for MySQL" as the source type
4. Enter connection details (server name, database, credentials)
5. Select tables to mirror (start with a subset, expand later)
6. Configure mirroring schedule (continuous or periodic)
7. Start mirroring and verify data appears in OneLake

**Best practices for Fabric Mirroring:**

- Start with the most analytically valuable tables (e.g., orders, customers, products)
- Avoid mirroring large BLOB/TEXT columns unless needed for analytics
- Monitor mirroring lag in Fabric portal
- Use dbt models to transform mirrored data (do not query raw mirrored tables directly for analytics)

### 6.2 Azure Data Factory MySQL connector

For batch data integration or when Fabric Mirroring is not suitable, ADF provides a MySQL connector:

```json
{
    "name": "MySQLToOneLake",
    "properties": {
        "activities": [
            {
                "name": "CopyMySQLToLakehouse",
                "type": "Copy",
                "typeProperties": {
                    "source": {
                        "type": "MySqlSource",
                        "query": "SELECT * FROM orders WHERE updated_at > '@{pipeline().parameters.lastWatermark}'"
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

**When to use ADF vs Fabric Mirroring:**

| Scenario                                      | Use Fabric Mirroring | Use ADF                   |
| --------------------------------------------- | -------------------- | ------------------------- |
| Near-real-time analytics                      | Yes                  | No (batch only)           |
| Complex data transformations during ingestion | No                   | Yes (with data flows)     |
| Multiple source types in same pipeline        | No                   | Yes                       |
| On-premises MySQL (not on Azure)              | No                   | Yes (with self-hosted IR) |
| MariaDB sources                               | No                   | Yes (MariaDB connector)   |
| Selective column projection                   | Limited              | Yes                       |
| Data quality checks during ingestion          | No                   | Yes (with data flows)     |

### 6.3 Microsoft Purview integration

After migrating MySQL to Azure and connecting to CSA-in-a-Box:

1. **Register Azure MySQL Flexible Server as a data source** in Microsoft Purview
2. **Configure scanning** to discover metadata (tables, columns, data types)
3. **Apply classifications** for sensitive data (PII, CUI, PHI)
4. **Enable lineage tracking** from MySQL through Fabric to Power BI
5. **Set up access policies** based on data sensitivity

```bash
# Register MySQL source in Purview (via API or Portal)
# Portal: Purview Studio > Data Map > Register > Azure Database for MySQL
# Provide: server name, database name, collection assignment
```

---

## 7. Operational best practices

### 7.1 Maintenance windows

```bash
# Set custom maintenance window (e.g., Sunday 2:00 AM - 3:00 AM UTC)
az mysql flexible-server update \
  --resource-group myResourceGroup \
  --name myMySQLServer \
  --maintenance-window "Sun:02:00"
```

### 7.2 Backup strategy

| Backup type         | Configuration                               | Recovery scenario                            |
| ------------------- | ------------------------------------------- | -------------------------------------------- |
| **Automated daily** | Default (1-35 day retention)                | Point-in-time restore for accidental changes |
| **Geo-redundant**   | Enable for DR                               | Cross-region recovery                        |
| **Logical backup**  | mysqldump to Azure Blob Storage (scheduled) | Application-consistent backup for compliance |
| **Long-term**       | ADF pipeline to ADLS Gen2 (archive tier)    | Regulatory retention (7+ years)              |

### 7.3 Scaling guidelines

| Trigger                   | Action                                   | How                                                           |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| CPU consistently > 80%    | Scale up compute tier                    | `az mysql flexible-server update --sku-name Standard_D8ds_v4` |
| Memory consistently > 85% | Scale to Memory Optimized tier           | `az mysql flexible-server update --sku-name Standard_E8ds_v4` |
| IOPS consistently > 80%   | Add pre-provisioned IOPS                 | `az mysql flexible-server update --iops <value>`              |
| Storage > 80%             | Enable auto-grow or provision more       | `az mysql flexible-server update --storage-size <value>`      |
| Connections > 70% of max  | Implement connection pooling or scale up | Application-level pooling configuration                       |

### 7.4 Security hardening post-migration

- [ ] Remove all public firewall rules (use Private Link / VNet integration)
- [ ] Migrate all users to Entra ID authentication
- [ ] Enable customer-managed keys for encryption at rest
- [ ] Enable audit logging with at least CONNECTION and DDL/DCL events
- [ ] Enable Azure Defender for MySQL
- [ ] Review and restrict database privileges (least privilege)
- [ ] Disable `local_infile` unless specifically needed
- [ ] Set `require_secure_transport = ON` (default)
- [ ] Configure password expiration policies via Entra ID

---

## 8. Common pitfalls and how to avoid them

| Pitfall                              | Impact                                      | Prevention                                                             |
| ------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| **Not converting MyISAM to InnoDB**  | HA cannot be enabled; data integrity risk   | Convert all tables before migration                                    |
| **Ignoring lower_case_table_names**  | Cannot be changed after server creation     | Set correctly during `az mysql flexible-server create`                 |
| **Using root/admin for application** | Security risk, over-privileged              | Create dedicated application users with least privilege                |
| **No connection pooling**            | Connection exhaustion, poor performance     | Implement application-level connection pooling                         |
| **Ignoring slow query log**          | Undetected performance degradation          | Enable slow query log from day one                                     |
| **Over-provisioning compute**        | Wasted spend                                | Start small, scale up based on monitoring data                         |
| **Under-provisioning IOPS**          | Write bottleneck, high latency              | Monitor IOPS usage; add pre-provisioned IOPS for write-heavy workloads |
| **Not testing cutover**              | Extended downtime during production cutover | Practice cutover in staging at least twice                             |
| **Skipping DEFINER cleanup**         | Stored procedures/views fail on target      | Remove or replace DEFINER clauses in dump files                        |
| **Not updating SSL certificates**    | Connection failures after migration         | Download and configure Azure CA certificate in all applications        |

---

## 9. Post-migration optimization timeline

| Timeframe     | Activities                                                                |
| ------------- | ------------------------------------------------------------------------- |
| **Day 1-7**   | Monitor slow query log, CPU, memory, IOPS; tune top slow queries          |
| **Week 2-4**  | Review connection pooling effectiveness; adjust max_connections           |
| **Month 1-2** | Evaluate tier sizing (scale down if over-provisioned, scale up if needed) |
| **Month 2-3** | Configure Fabric Mirroring or ADF pipelines for CSA-in-a-Box              |
| **Month 3-6** | Enable reserved capacity (1-year) after confirming stable workload        |
| **Month 6+**  | Evaluate 3-year reserved capacity; review for cost optimization           |

---

**Next:** [Migration Playbook](../mysql-to-azure.md) | [Index](index.md) | [Benchmarks](benchmarks.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
