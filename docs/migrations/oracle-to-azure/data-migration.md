# Oracle Data Migration to Azure

**Data movement strategies and tools: SSMA data migration, Azure DMS, Azure Data Factory, Oracle Data Pump + AzCopy, Fabric Mirroring for Oracle, and GoldenGate for CDC.**

---

!!! abstract "Choosing a data migration approach"
The right tool depends on data volume, downtime tolerance, and whether you need ongoing replication or a one-time migration.

    - **< 100 GB, downtime OK:** SSMA or ora2pg built-in data migration
    - **100 GB - 10 TB, minimal downtime:** Azure Database Migration Service (DMS)
    - **> 10 TB, complex:** Oracle Data Pump export + AzCopy + target import
    - **Zero downtime, ongoing replication:** GoldenGate or Fabric Mirroring
    - **Ongoing analytics replication:** Fabric Mirroring for Oracle or ADF CDC pipelines

---

## 1. Migration approach comparison

| Approach                  | Max data size | Downtime   | Complexity | Ongoing replication | Best for                             |
| ------------------------- | ------------- | ---------- | ---------- | ------------------- | ------------------------------------ |
| **SSMA data migration**   | ~100 GB       | Hours      | Low        | No                  | Small databases, SQL MI target       |
| **ora2pg data migration** | ~100 GB       | Hours      | Low        | No                  | Small databases, PostgreSQL target   |
| **Azure DMS (offline)**   | 10+ TB        | Hours-days | Medium     | No                  | Medium databases, one-time migration |
| **Azure DMS (online)**    | 10+ TB        | Minutes    | Medium     | During migration    | Medium databases, minimal downtime   |
| **Data Pump + AzCopy**    | 50+ TB        | Hours-days | Medium     | No                  | Very large databases, bulk migration |
| **Azure Data Factory**    | Unlimited     | Variable   | Medium     | Yes (scheduled)     | Batch replication, ETL integration   |
| **Fabric Mirroring**      | Varies        | Near-zero  | Low        | Yes (continuous)    | Analytics replication to OneLake     |
| **GoldenGate**            | Unlimited     | Near-zero  | High       | Yes (continuous)    | Zero-downtime, Oracle-to-Oracle      |

---

## 2. SSMA data migration

SSMA for Oracle includes built-in data migration for Azure SQL MI targets.

### 2.1 Data migration workflow

```
Oracle Source ──► SSMA Client ──► Azure SQL MI Target
                     │
              ┌──────┴──────┐
              │             │
         Client-side    Server-side
         (small DBs)    (large DBs)
```

### 2.2 Configuration

```
# In SSMA Project Settings > Migration:
# - Migration Engine: Server Side Data Migration (for databases > 10 GB)
# - Batch Size: 10000 (adjust based on row size)
# - Parallel Data Migration: Enable
# - Number of Parallel Processes: 4 (adjust based on network bandwidth)
# - Extended Data Migration Options:
#   - Truncate target tables before migration: Yes (for fresh migration)
#   - Retain identity values: Yes
```

### 2.3 Running data migration

```
# In SSMA:
# 1. Ensure schema is already converted and deployed to target
# 2. Right-click source schema in Oracle Metadata Explorer
# 3. Select "Migrate Data"
# 4. Monitor progress in the Migration Report
# 5. Review error log for failed rows
```

---

## 3. Azure Database Migration Service (DMS)

Azure DMS provides managed data migration with both offline and online modes.

### 3.1 Offline migration (one-time)

```bash
# Create DMS instance
az dms create \
    --resource-group rg-migration \
    --name dms-oracle-migration \
    --location eastus \
    --sku-name Standard_4vCores

# Create migration project
az dms project create \
    --resource-group rg-migration \
    --service-name dms-oracle-migration \
    --name oracle-to-sqlmi \
    --source-platform Oracle \
    --target-platform SQLMI

# Create and run migration task
# (Use Azure Portal for GUI-based task creation, or REST API)
```

### 3.2 Online migration (continuous sync)

Online migration uses Oracle LogMiner to capture changes during migration:

```
Phase 1: Full load (bulk copy of existing data)
    Oracle ──► DMS ──► Azure SQL MI

Phase 2: Incremental sync (LogMiner CDC)
    Oracle ──► LogMiner ──► DMS ──► Azure SQL MI
    (Continuous until cutover)

Phase 3: Cutover
    Stop application writes to Oracle
    Wait for DMS sync to complete
    Switch application to Azure SQL MI
```

### 3.3 DMS requirements for Oracle source

```sql
-- On Oracle source: Enable supplemental logging
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA (ALL) COLUMNS;

-- Create migration user with required privileges
CREATE USER dms_user IDENTIFIED BY "***";
GRANT CREATE SESSION TO dms_user;
GRANT SELECT ANY TABLE TO dms_user;
GRANT SELECT ANY TRANSACTION TO dms_user;
GRANT SELECT ON V_$ARCHIVED_LOG TO dms_user;
GRANT SELECT ON V_$LOG TO dms_user;
GRANT SELECT ON V_$LOGFILE TO dms_user;
GRANT SELECT ON V_$DATABASE TO dms_user;
GRANT SELECT ON V_$THREAD TO dms_user;
GRANT SELECT ON V_$PARAMETER TO dms_user;
GRANT SELECT ON V_$NLS_PARAMETERS TO dms_user;
GRANT SELECT ON V_$TIMEZONE_NAMES TO dms_user;
GRANT SELECT ON ALL_INDEXES TO dms_user;
GRANT SELECT ON ALL_OBJECTS TO dms_user;
GRANT SELECT ON ALL_TABLES TO dms_user;
GRANT SELECT ON ALL_USERS TO dms_user;
GRANT SELECT ON ALL_TAB_COLUMNS TO dms_user;
GRANT SELECT ON DBA_OBJECTS TO dms_user;
GRANT LOGMINING TO dms_user;  -- Oracle 12c+
```

---

## 4. Oracle Data Pump + AzCopy

For very large databases (10+ TB), Oracle Data Pump export followed by AzCopy to Azure Blob and target import provides the fastest bulk transfer.

### 4.1 Export with Data Pump

```bash
# Create directory object for export
sqlplus / as sysdba << 'EOF'
CREATE OR REPLACE DIRECTORY dp_export_dir AS '/opt/oracle/export';
GRANT READ, WRITE ON DIRECTORY dp_export_dir TO migration_user;
EXIT;
EOF

# Full database export (parallel)
expdp migration_user/*** \
    DIRECTORY=dp_export_dir \
    DUMPFILE=feddb_%U.dmp \
    LOGFILE=feddb_export.log \
    SCHEMAS=APP_SCHEMA \
    PARALLEL=8 \
    FILESIZE=10G \
    COMPRESSION=ALL \
    EXCLUDE=STATISTICS

# Table-level export for largest tables
expdp migration_user/*** \
    DIRECTORY=dp_export_dir \
    DUMPFILE=large_table_%U.dmp \
    LOGFILE=large_table_export.log \
    TABLES=APP_SCHEMA.TRANSACTIONS \
    PARALLEL=8 \
    QUERY="WHERE transaction_date >= TO_DATE('2020-01-01','YYYY-MM-DD')"
```

### 4.2 Transfer with AzCopy

```bash
# Install AzCopy
# Download from https://aka.ms/downloadazcopy-v10-linux

# Upload to Azure Blob Storage
azcopy copy '/opt/oracle/export/feddb_*.dmp' \
    'https://stmigration.blob.core.windows.net/oracle-export/?sv=...' \
    --recursive \
    --put-md5 \
    --log-level INFO

# For large transfers, use multiple streams
azcopy copy '/opt/oracle/export/' \
    'https://stmigration.blob.core.windows.net/oracle-export/' \
    --recursive \
    --cap-mbps 5000
```

### 4.3 Import to target

For Azure SQL MI:

```bash
# Convert Data Pump format to SQL MI-compatible format
# Use SSMA or BCP for bulk import after schema conversion

# BCP bulk import (per table)
bcp dbo.transactions in /mnt/export/transactions.csv \
    -S mi-instance.database.windows.net \
    -d FEDDB \
    -U migration_admin \
    -c -t "," -r "\n" \
    -b 50000 \
    -h "TABLOCK"
```

For Azure PostgreSQL:

```bash
# Use pg_restore for Data Pump → PostgreSQL conversion
# (Requires intermediate conversion with ora2pg)

# Or use COPY command for CSV data
psql -h pg-flex.postgres.database.azure.com \
     -U migration_admin \
     -d feddb \
     -c "\COPY app_schema.transactions FROM '/mnt/export/transactions.csv' WITH CSV HEADER"
```

---

## 5. Azure Data Factory for ongoing replication

ADF provides scheduled batch replication from Oracle sources to Azure targets and OneLake.

### 5.1 Oracle source linked service

```json
{
    "name": "OracleSource",
    "properties": {
        "type": "Oracle",
        "typeProperties": {
            "connectionString": "Host=oracle-prod.agency.gov;Port=1521;SID=FEDDB;User Id=adf_reader;Password=***;"
        }
    }
}
```

### 5.2 Incremental copy pipeline

```json
{
    "name": "Oracle_Incremental_Copy",
    "properties": {
        "activities": [
            {
                "name": "LookupWatermark",
                "type": "Lookup",
                "typeProperties": {
                    "source": {
                        "type": "AzureSqlSource",
                        "sqlReaderQuery": "SELECT watermark_value FROM watermark_table WHERE table_name = 'transactions'"
                    },
                    "dataset": { "referenceName": "WatermarkDataset" }
                }
            },
            {
                "name": "CopyOracleToOneLake",
                "type": "Copy",
                "dependsOn": [
                    {
                        "activity": "LookupWatermark",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "source": {
                        "type": "OracleSource",
                        "oracleReaderQuery": {
                            "value": "SELECT * FROM APP_SCHEMA.TRANSACTIONS WHERE UPDATED_AT > TO_TIMESTAMP('@{activity('LookupWatermark').output.firstRow.watermark_value}', 'YYYY-MM-DD HH24:MI:SS.FF')",
                            "type": "Expression"
                        }
                    },
                    "sink": {
                        "type": "LakehouseTableSink",
                        "tableActionOption": "Append"
                    }
                }
            },
            {
                "name": "UpdateWatermark",
                "type": "SqlServerStoredProcedure",
                "dependsOn": [
                    {
                        "activity": "CopyOracleToOneLake",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "storedProcedureName": "sp_update_watermark",
                    "storedProcedureParameters": {
                        "table_name": { "value": "transactions" },
                        "watermark_value": { "value": "@{utcNow()}" }
                    }
                }
            }
        ],
        "parameters": {}
    }
}
```

---

## 6. Fabric Mirroring for Oracle

Fabric Mirroring for Oracle (preview) provides near-real-time replication from Oracle databases to OneLake.

### 6.1 Supported sources

| Source                                  | Mirroring support |
| --------------------------------------- | ----------------- |
| Oracle Database@Azure                   | Preview           |
| Azure SQL MI                            | GA                |
| Azure SQL Database                      | GA                |
| Cosmos DB                               | GA                |
| On-premises Oracle (via Self-hosted IR) | Roadmap           |

### 6.2 Setup in Fabric portal

```
1. Navigate to Fabric workspace
2. New > Mirrored Database > Oracle Database
3. Provide connection details:
   - Host: <exadata-ip-or-hostname>
   - Port: 1521
   - Service Name: FEDDB
   - Authentication: Username/Password or Managed Identity
4. Select tables to mirror
5. Configure mirroring options:
   - Initial snapshot: Yes
   - Continuous replication: Yes
6. Start mirroring
```

### 6.3 CSA-in-a-Box integration

Once mirrored, Oracle tables appear as Delta Lake tables in OneLake:

```python
# In a Fabric notebook or dbt model, reference mirrored data
# dbt source definition:
# sources:
#   - name: oracle_mirror
#     schema: oracle_feddb
#     tables:
#       - name: transactions
#       - name: employees
#       - name: departments

# Fabric notebook (PySpark)
df = spark.read.format("delta").load(
    "abfss://workspace@onelake.dfs.fabric.microsoft.com/oracle_mirror.Lakehouse/Tables/transactions"
)
df.createOrReplaceTempView("transactions")
spark.sql("SELECT department_id, SUM(amount) FROM transactions GROUP BY department_id").show()
```

---

## 7. GoldenGate for CDC (Oracle-to-Oracle)

For Oracle Database@Azure migrations, GoldenGate provides real-time replication with zero downtime.

### 7.1 Architecture

```
Source Oracle ──► GoldenGate Extract ──► Trail Files ──► GoldenGate Replicat ──► Oracle DB@Azure
                                                │
                                       (Optional: to Kafka/Event Hubs
                                        for Azure analytics integration)
```

### 7.2 GoldenGate for heterogeneous targets

GoldenGate also supports replication to non-Oracle targets:

| Target             | GoldenGate support            | Use case                       |
| ------------------ | ----------------------------- | ------------------------------ |
| Oracle DB@Azure    | Full (native)                 | Oracle-to-Oracle migration     |
| Azure SQL MI       | Via GoldenGate for SQL Server | Heterogeneous replication      |
| Azure PostgreSQL   | Via GoldenGate for PostgreSQL | Heterogeneous replication      |
| Kafka / Event Hubs | Via GoldenGate for Big Data   | Analytics pipeline integration |

---

## 8. Data validation

### 8.1 Row count validation

```sql
-- Oracle source
SELECT table_name, num_rows
FROM all_tables
WHERE owner = 'APP_SCHEMA'
ORDER BY table_name;

-- Azure SQL MI target
SELECT t.name AS table_name,
       SUM(p.rows) AS row_count
FROM sys.tables t
JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0,1)
GROUP BY t.name
ORDER BY t.name;

-- PostgreSQL target
SELECT schemaname, relname AS table_name, n_live_tup AS row_count
FROM pg_stat_user_tables
WHERE schemaname = 'app_schema'
ORDER BY relname;
```

### 8.2 Checksum validation

```sql
-- Oracle: Generate table checksum
SELECT ORA_HASH(
    LISTAGG(employee_id || '|' || NVL(TO_CHAR(salary), 'NULL') || '|' || name, ',')
    WITHIN GROUP (ORDER BY employee_id)
) AS table_checksum
FROM employees;

-- Azure SQL MI: Generate comparable checksum
SELECT CHECKSUM_AGG(CHECKSUM(employee_id, salary, name)) AS table_checksum
FROM employees;
```

### 8.3 Business rule validation

```sql
-- Validate critical business aggregates match between source and target
-- Example: Total revenue by month should match exactly

-- Oracle source
SELECT TO_CHAR(transaction_date, 'YYYY-MM') AS month,
       SUM(amount) AS total_amount,
       COUNT(*) AS transaction_count
FROM transactions
GROUP BY TO_CHAR(transaction_date, 'YYYY-MM')
ORDER BY month;

-- Azure SQL MI target
SELECT FORMAT(transaction_date, 'yyyy-MM') AS month,
       SUM(amount) AS total_amount,
       COUNT(*) AS transaction_count
FROM transactions
GROUP BY FORMAT(transaction_date, 'yyyy-MM')
ORDER BY month;
```

---

## 9. Data migration best practices

1. **Migrate schema first, data second.** Convert and validate the schema before moving data.
2. **Disable indexes and constraints during bulk load.** Re-enable after data migration for faster loading.
3. **Parallelize large table migrations.** Split large tables by partition key or date range.
4. **Validate incrementally.** Do not wait until all data is migrated to start validation.
5. **Plan for LOBs separately.** BLOB and CLOB columns require special handling and are significantly slower to migrate.
6. **Test with production-scale data.** Migration tools that work on 10 GB often fail at 1 TB.
7. **Keep Oracle read-only during cutover.** Use `ALTER DATABASE OPEN READ ONLY` during final sync.
8. **Document the watermark.** Record the exact timestamp or SCN used for the final incremental sync.

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
