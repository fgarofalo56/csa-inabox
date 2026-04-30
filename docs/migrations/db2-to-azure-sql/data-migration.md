# Data Migration -- IBM Db2 to Azure SQL

**Audience:** DBAs, Data Engineers, Migration Engineers
**Purpose:** Comprehensive guide for moving data from IBM Db2 (z/OS and LUW) to Azure SQL, covering SSMA data migration, Db2 utilities, Azure Data Factory, bulk insert, and BCP for large tables.

---

## Data migration strategy overview

Data migration from Db2 to Azure SQL follows one of four patterns depending on data volume, acceptable downtime, and source platform:

| Strategy                              | Data volume   | Downtime tolerance                  | Best for                                        |
| ------------------------------------- | ------------- | ----------------------------------- | ----------------------------------------------- |
| **SSMA data migration**               | < 100 GB      | Hours                               | Small databases, initial migrations, validation |
| **Db2 EXPORT + AzCopy + BULK INSERT** | 100 GB - 5 TB | Extended window (overnight/weekend) | Large tables, batch migration                   |
| **Azure Data Factory Db2 connector**  | Any           | Minimal (incremental)               | Ongoing replication, phased cutover             |
| **BCP + parallel load**               | 1 TB+         | Extended window                     | Very large tables, maximum throughput           |

---

## 1. SSMA data migration

SSMA for Db2 includes integrated data migration that reads source data via DRDA or native client and writes to the target Azure SQL database via bulk operations.

### When to use SSMA data migration

- Databases under 100 GB total size
- Initial proof-of-concept or pilot migrations
- Small-to-medium tables where simplicity matters
- Validation testing alongside schema conversion

### Configuration for data migration

In SSMA Project Settings, configure data migration parameters:

| SSMA setting                | Recommended value    | Notes                                                               |
| --------------------------- | -------------------- | ------------------------------------------------------------------- |
| Batch size                  | 10,000               | Rows per batch; increase for simple schemas, decrease for wide rows |
| Extended data migration     | Enable               | Uses client-side data pump for better performance                   |
| Parallel data migration     | Enable (4-8 threads) | Migrates multiple tables simultaneously                             |
| Table lock during migration | Enable               | Improves insert throughput via TABLOCK hint                         |
| Data migration timeout      | 7200 (seconds)       | Increase for very large tables                                      |

### Running SSMA data migration

1. Complete schema conversion and apply to target database.
2. In SSMA, right-click the source database and select **Migrate Data**.
3. SSMA reads source tables via the Db2 connection and performs bulk insert into target tables.
4. Monitor progress in the SSMA output window. Failed rows are logged with error details.
5. After completion, review the data migration report for table-level row counts and error summaries.

### Handling SSMA data migration errors

Common errors and resolutions:

| Error                 | Cause                                       | Resolution                                                        |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| String truncation     | Source data exceeds target column width     | Increase target column width or use VARCHAR(MAX)                  |
| Code page conversion  | EBCDIC characters without Unicode mapping   | Map problematic characters; see mainframe guide                   |
| Arithmetic overflow   | DECFLOAT values exceeding DECIMAL precision | Increase target DECIMAL precision or use FLOAT                    |
| Foreign key violation | Parent table not yet migrated               | Migrate parent tables first or disable FK constraints during load |
| Timeout               | Large table exceeds default timeout         | Increase timeout setting; consider alternative strategy           |

---

## 2. Db2 EXPORT + AzCopy + BULK INSERT

For tables exceeding 100 GB or when SSMA throughput is insufficient, export data from Db2 to flat files, transfer to Azure, and bulk-load into Azure SQL.

### Step 1: Export from Db2

```sql
-- Db2 EXPORT command for delimited format
EXPORT TO /data/export/transactions.csv OF DEL
    MODIFIED BY COLDEL| CHARDEL"" TIMESTAMPFORMAT="YYYY-MM-DD HH:MM:SS.UUUUUU"
    MESSAGES /data/export/transactions.msg
    SELECT * FROM finance.transactions;
```

**Export options explained:**

- `OF DEL` -- delimited format (pipe-delimited recommended for data containing commas)
- `COLDEL|` -- column delimiter (pipe character avoids conflicts with data)
- `CHARDEL""` -- character delimiter (double-quote for strings)
- `TIMESTAMPFORMAT` -- ensures consistent timestamp format for SQL Server import
- `MESSAGES` -- captures row counts and warnings

For z/OS, use the Db2 UNLOAD utility or DSNTIAUL instead of EXPORT:

```jcl
//UNLOAD   EXEC PGM=IKJEFT01
//SYSTSIN  DD *
  DSN SYSTEM(DB2P)
  RUN PROGRAM(DSNTIAUL) PLAN(DSNTIAUL) -
      PARMS('/UNICODE')
  END
//SYSIN    DD *
  SELECT * FROM FINANCE.TRANSACTIONS;
/*
```

### Step 2: Transfer to Azure with AzCopy

```bash
# Install AzCopy (if not already available)
# Transfer exported files to Azure Blob Storage
azcopy copy "/data/export/transactions.csv" \
    "https://migrationstorage.blob.core.usgovcloudapi.net/db2-export/transactions.csv" \
    --put-md5

# For large exports with multiple files, copy the entire directory
azcopy copy "/data/export/" \
    "https://migrationstorage.blob.core.usgovcloudapi.net/db2-export/" \
    --recursive \
    --put-md5
```

**For z/OS data:** Use IBM z/OS Connect, Sterling File Gateway, or a mainframe FTP exit to transfer files from the mainframe to an intermediary server, then AzCopy to Azure. Direct AzCopy from z/OS is not supported.

### Step 3: BULK INSERT into Azure SQL

```sql
-- Create a database-scoped credential for Blob Storage access
CREATE DATABASE SCOPED CREDENTIAL BlobCredential
WITH IDENTITY = 'SHARED ACCESS SIGNATURE',
SECRET = '<SAS-token>';

-- Create an external data source
CREATE EXTERNAL DATA SOURCE BlobStorage
WITH (
    TYPE = BLOB_STORAGE,
    LOCATION = 'https://migrationstorage.blob.core.usgovcloudapi.net/db2-export',
    CREDENTIAL = BlobCredential
);

-- BULK INSERT with format options matching Db2 EXPORT
BULK INSERT finance.transactions
FROM 'transactions.csv'
WITH (
    DATA_SOURCE = 'BlobStorage',
    FORMAT = 'CSV',
    FIELDTERMINATOR = '|',
    ROWTERMINATOR = '\n',
    FIELDQUOTE = '"',
    FIRSTROW = 1,
    TABLOCK,
    BATCHSIZE = 100000,
    MAXERRORS = 100
);
```

### Performance tuning for BULK INSERT

| Technique            | Impact             | How                                                        |
| -------------------- | ------------------ | ---------------------------------------------------------- |
| TABLOCK hint         | 30-50% faster      | Minimizes row-level locking                                |
| Batch size 100K-500K | Optimal throughput | Balance between transaction log usage and commit frequency |
| Minimal logging      | 2-5x faster        | Set database recovery model to BULK_LOGGED during load     |
| Disable indexes      | 20-40% faster      | Drop non-clustered indexes, load, rebuild                  |
| Disable constraints  | 10-20% faster      | Disable FK checks during load with `ALTER TABLE NOCHECK`   |
| Split large files    | Better parallelism | Split into 1 GB files and load in parallel                 |

---

## 3. Azure Data Factory Db2 connector

ADF provides a native Db2 connector that reads data from Db2 for LUW and Db2 for z/OS (via DRDA). This is the recommended approach for ongoing data movement, incremental loads, and phased cutover migrations.

### Setting up the Db2 linked service

```json
{
    "name": "Db2LinkedService",
    "type": "Microsoft.DataFactory/factories/linkedservices",
    "properties": {
        "type": "Db2",
        "typeProperties": {
            "connectionString": "Server=db2server.example.com;Database=FINANCEDB;AuthenticationType=Basic",
            "username": "db2admin",
            "password": {
                "type": "AzureKeyVaultSecret",
                "store": {
                    "referenceName": "KeyVaultLinkedService",
                    "type": "LinkedServiceReference"
                },
                "secretName": "db2-admin-password"
            }
        },
        "connectVia": {
            "referenceName": "SelfHostedIR",
            "type": "IntegrationRuntimeReference"
        }
    }
}
```

**Integration runtime:** For Db2 on-premises or in a government data center, deploy a Self-Hosted Integration Runtime (SHIR) in the network where Db2 is accessible. See `docs/SELF_HOSTED_IR.md` for SHIR deployment patterns.

### Copy activity for full table migration

```json
{
    "name": "CopyTransactions",
    "type": "Copy",
    "inputs": [
        {
            "referenceName": "Db2TransactionsDataset",
            "type": "DatasetReference"
        }
    ],
    "outputs": [
        {
            "referenceName": "AzureSqlTransactionsDataset",
            "type": "DatasetReference"
        }
    ],
    "typeProperties": {
        "source": {
            "type": "Db2Source",
            "query": "SELECT * FROM FINANCE.TRANSACTIONS WHERE TRANS_DATE >= '2025-01-01'"
        },
        "sink": {
            "type": "AzureSqlSink",
            "writeBehavior": "insert",
            "sqlWriterUseTableLock": true,
            "disableMetricsCollection": false
        },
        "enableStaging": true,
        "stagingSettings": {
            "linkedServiceName": {
                "referenceName": "StagingBlobStorage",
                "type": "LinkedServiceReference"
            },
            "path": "adf-staging"
        },
        "parallelCopies": 8
    }
}
```

### Incremental load pattern

For phased cutover, use watermark-based incremental loads:

```json
{
    "name": "IncrementalLoadTransactions",
    "type": "Copy",
    "typeProperties": {
        "source": {
            "type": "Db2Source",
            "query": {
                "value": "SELECT * FROM FINANCE.TRANSACTIONS WHERE LAST_MODIFIED > '@{activity('GetWatermark').output.firstRow.watermark}'",
                "type": "Expression"
            }
        },
        "sink": {
            "type": "AzureSqlSink",
            "writeBehavior": "upsert",
            "upsertSettings": {
                "useTempDB": true,
                "keys": ["TRANS_ID"]
            }
        }
    }
}
```

### ADF performance tuning

| Setting                      | Recommended value | Impact                             |
| ---------------------------- | ----------------- | ---------------------------------- |
| Parallel copies              | 4-16              | Parallel read/write threads        |
| DIU (Data Integration Units) | 16-64             | Cloud compute for data movement    |
| Staging via Blob             | Enabled           | Enables PolyBase-like bulk loading |
| Batch size                   | 100,000           | Rows per batch write               |
| Table lock                   | Enabled           | Reduces lock contention            |

---

## 4. BCP for large table migration

For the largest tables (40M+ rows, 500 GB+), BCP (Bulk Copy Program) provides maximum throughput with fine-grained control.

### Export from Db2 to BCP-compatible format

First, export from Db2 to a delimited format that BCP can read:

```bash
# Db2 CLP export
db2 "EXPORT TO /data/export/large_table.dat OF DEL \
    MODIFIED BY COLDEL0x7C NOCHARDEL \
    TIMESTAMPFORMAT=\"YYYY-MM-DD HH:MM:SS.UUUUUU\" \
    SELECT * FROM SCHEMA.LARGE_TABLE"
```

### BCP import to Azure SQL MI

```bash
# BCP import with pipe delimiter
bcp "SCHEMA.LARGE_TABLE" in /data/export/large_table.dat \
    -S "sqlmi-instance.database.usgovcloudapi.net" \
    -d "TargetDB" \
    -U "sqladmin" \
    -P "$DB_PASSWORD" \
    -t "|" \
    -b 100000 \
    -h "TABLOCK" \
    -a 65535 \
    -e /data/export/large_table_errors.log
```

**BCP parameter reference:**

| Parameter | Value      | Purpose                   |
| --------- | ---------- | ------------------------- |
| `-t`      | `"\|"`     | Field terminator (pipe)   |
| `-b`      | 100000     | Batch size                |
| `-h`      | "TABLOCK"  | Table lock hint           |
| `-a`      | 65535      | Network packet size (max) |
| `-e`      | error file | Error output file         |

### Parallel BCP for maximum throughput

Split large exports into range-based partitions and load in parallel:

```bash
#!/bin/bash
# Parallel BCP load for partitioned data

TABLE="SCHEMA.LARGE_TABLE"
TARGET_DB="TargetDB"
SERVER="sqlmi.database.usgovcloudapi.net"

# Split by date range (or any partition key)
for YEAR in 2020 2021 2022 2023 2024 2025; do
    echo "Loading year $YEAR..."
    bcp "$TABLE" in "/data/export/large_table_${YEAR}.dat" \
        -S "$SERVER" -d "$TARGET_DB" \
        -U "sqladmin" -P "$DB_PASSWORD" \
        -t "|" -b 100000 -h "TABLOCK" -a 65535 \
        -e "/data/export/errors_${YEAR}.log" &
done

wait
echo "All partitions loaded."
```

---

## 5. Data validation and reconciliation

### Row count validation

```sql
-- Run on Db2
SELECT 'TRANSACTIONS' AS table_name, COUNT(*) AS row_count
FROM FINANCE.TRANSACTIONS
UNION ALL
SELECT 'ACCOUNTS', COUNT(*) FROM FINANCE.ACCOUNTS
UNION ALL
SELECT 'CUSTOMERS', COUNT(*) FROM FINANCE.CUSTOMERS;

-- Run on Azure SQL and compare
SELECT 'TRANSACTIONS' AS table_name, COUNT(*) AS row_count
FROM FINANCE.TRANSACTIONS
UNION ALL
SELECT 'ACCOUNTS', COUNT(*) FROM FINANCE.ACCOUNTS
UNION ALL
SELECT 'CUSTOMERS', COUNT(*) FROM FINANCE.CUSTOMERS;
```

### Checksum validation

```sql
-- Db2: aggregate checksum for numeric columns
SELECT
    COUNT(*) AS row_count,
    SUM(CAST(amount AS DECIMAL(31,2))) AS total_amount,
    MIN(trans_date) AS min_date,
    MAX(trans_date) AS max_date
FROM FINANCE.TRANSACTIONS;

-- Azure SQL: same query for comparison
SELECT
    COUNT(*) AS row_count,
    SUM(CAST(amount AS DECIMAL(31,2))) AS total_amount,
    MIN(trans_date) AS min_date,
    MAX(trans_date) AS max_date
FROM FINANCE.TRANSACTIONS;
```

### Sampling validation

For very large tables, validate a random sample:

```sql
-- Azure SQL: validate random sample
SELECT TOP 1000 *
FROM FINANCE.TRANSACTIONS
ORDER BY NEWID();

-- Compare specific rows by primary key against source Db2
```

### Character encoding validation

Critical for z/OS migrations where EBCDIC-to-Unicode conversion may introduce issues:

```sql
-- Azure SQL: find rows with replacement characters (encoding issues)
SELECT *
FROM FINANCE.CUSTOMERS
WHERE name LIKE '%' + NCHAR(0xFFFD) + '%'   -- Unicode replacement character
   OR address LIKE '%' + NCHAR(0xFFFD) + '%';
```

---

## 6. Cutover strategies

### Big-bang cutover

1. Freeze Db2 writes (application downtime).
2. Run final data migration (delta since last sync).
3. Validate row counts and checksums.
4. Switch application connection strings to Azure SQL.
5. Monitor for 24-48 hours before decommissioning Db2.

**Best for:** Small databases (< 50 GB), short acceptable downtime windows.

### Phased cutover with dual-write

1. Set up ADF incremental pipeline from Db2 to Azure SQL.
2. Run dual-write period: application writes to Db2, ADF replicates to Azure SQL.
3. Validate Azure SQL data continuously during dual-write.
4. Switch read queries to Azure SQL first (read traffic cutover).
5. Switch write queries to Azure SQL (write traffic cutover).
6. Maintain Db2 as read-only fallback for 2-4 weeks.
7. Decommission Db2 after validation period.

**Best for:** Large databases, minimal downtime requirements.

### Table-by-table cutover

1. Migrate and cut over individual tables/domains independently.
2. Use linked servers or ADF for cross-database queries during transition.
3. Complete migration when all tables are on Azure SQL.

**Best for:** Complex databases with independent table groups.

---

## 7. Post-migration data integration with CSA-in-a-Box

After data migration to Azure SQL, establish the analytics integration:

1. **Enable Fabric Mirroring** from Azure SQL MI or Azure SQL DB to bring data into OneLake as Delta tables.
2. **Configure Purview scanning** to classify and catalog the migrated data.
3. **Build Power BI semantic models** over the mirrored Delta tables using Direct Lake mode.
4. **Set up ADF pipelines** for any incremental data feeds that continue from the Db2 environment during the transition period.

---

## Related resources

- [Schema Migration](schema-migration.md) -- prepare the target schema first
- [Tutorial: SSMA Migration](tutorial-ssma-migration.md) -- step-by-step SSMA walkthrough
- [Mainframe Considerations](mainframe-considerations.md) -- z/OS-specific data movement
- [Best Practices](best-practices.md) -- validation methodology

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
