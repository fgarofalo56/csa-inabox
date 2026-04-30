# Complete Feature Mapping -- IBM Db2 to Azure SQL

**Audience:** Enterprise Architects, DBAs, Platform Engineers
**Purpose:** Comprehensive mapping of 40+ IBM Db2 features to Azure SQL equivalents, with migration complexity ratings and gap analysis.

---

## Reading the mapping tables

Each feature is rated for migration complexity:

| Rating | Meaning                  | Typical effort         |
| ------ | ------------------------ | ---------------------- |
| **XS** | Automatic or trivial     | Hours; SSMA handles it |
| **S**  | Minor manual adjustment  | 1-3 days               |
| **M**  | Moderate rework required | 1-2 weeks              |
| **L**  | Significant refactoring  | 2-6 weeks              |
| **XL** | Architectural redesign   | 6+ weeks               |

**Conversion confidence** indicates the percentage of instances SSMA typically converts without manual intervention.

---

## 1. Storage and physical design

| Db2 feature                                           | Azure SQL equivalent                                             | Migration notes                                                                                                                                             | Complexity | Conversion confidence |
| ----------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------- |
| **Tablespaces** (database-managed, system-managed)    | **Filegroups** + data files                                      | Db2 tablespaces map to SQL Server filegroups. SSMA creates filegroups automatically. System-managed space allocation is the default in Azure SQL MI.        | XS         | 95%                   |
| **Partitioned tablespaces** (range partitioning)      | **Table partitioning** (partition function + scheme)             | Db2 range-partitioned tablespaces map to SQL Server partitioned tables. Partition key and boundary values translate directly. SSMA handles standard cases.  | S          | 85%                   |
| **Bufferpools** (4K, 8K, 16K, 32K page sizes)         | **Buffer pool** (Azure SQL manages automatically)                | Db2 allows multiple bufferpools with different page sizes. Azure SQL MI manages buffer allocation automatically based on workload. No configuration needed. | XS         | 100%                  |
| **LOB tablespaces**                                   | **FILESTREAM** or **inline LOB storage**                         | Db2 separates LOB data into dedicated tablespaces. Azure SQL stores LOBs inline or in FILESTREAM filegroups depending on size.                              | S          | 80%                   |
| **Index tablespaces**                                 | **Index storage in filegroups**                                  | Db2 allows placing indexes in separate tablespaces. Azure SQL indexes reside in the same or different filegroups.                                           | XS         | 95%                   |
| **Compression** (row, value, adaptive)                | **Row compression, page compression, columnstore**               | Db2 value compression maps to row compression. Db2 adaptive compression maps to page compression. Columnstore covers analytics workloads.                   | S          | 75%                   |
| **ORGANIZE BY** (MDC -- Multi-Dimensional Clustering) | **Clustered columnstore** or **partitioning + covering indexes** | MDC is unique to Db2 LUW. No direct equivalent; redesign with partitioning and/or columnstore indexes for similar query performance.                        | M          | 0% (manual)           |

---

## 2. Data types

| Db2 data type                       | Azure SQL equivalent                               | Migration notes                                                                                                                                                   | Complexity |
| ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **SMALLINT**                        | **SMALLINT**                                       | 1:1                                                                                                                                                               | XS         |
| **INTEGER**                         | **INT**                                            | 1:1                                                                                                                                                               | XS         |
| **BIGINT**                          | **BIGINT**                                         | 1:1                                                                                                                                                               | XS         |
| **DECIMAL(p,s)** / **NUMERIC(p,s)** | **DECIMAL(p,s)** / **NUMERIC(p,s)**                | 1:1 (max precision 38 in both)                                                                                                                                    | XS         |
| **DECFLOAT(16)** / **DECFLOAT(34)** | **DECIMAL(16,s)** / **DECIMAL(34,s)** or **FLOAT** | DECFLOAT is IEEE 754 decimal floating-point. No direct equivalent in SQL Server. Map to DECIMAL with appropriate scale or FLOAT with loss of precision semantics. | M          |
| **REAL**                            | **REAL**                                           | 1:1                                                                                                                                                               | XS         |
| **DOUBLE**                          | **FLOAT(53)**                                      | 1:1 semantically                                                                                                                                                  | XS         |
| **CHAR(n)**                         | **CHAR(n)**                                        | 1:1 (max 254 in Db2 vs 8000 in SQL Server)                                                                                                                        | XS         |
| **VARCHAR(n)**                      | **VARCHAR(n)**                                     | 1:1 (max 32672 in Db2 vs 8000 in SQL Server; use VARCHAR(MAX) for > 8000)                                                                                         | XS         |
| **GRAPHIC(n)**                      | **NCHAR(n)**                                       | GRAPHIC stores double-byte characters (DBCS). Maps to NCHAR (Unicode).                                                                                            | S          |
| **VARGRAPHIC(n)**                   | **NVARCHAR(n)**                                    | VARGRAPHIC stores variable-length DBCS. Maps to NVARCHAR.                                                                                                         | S          |
| **LONG VARCHAR**                    | **VARCHAR(MAX)**                                   | Deprecated in Db2; use VARCHAR(MAX)                                                                                                                               | XS         |
| **CLOB(n)**                         | **VARCHAR(MAX)**                                   | CLOB up to 2 GB maps to VARCHAR(MAX) up to 2 GB                                                                                                                   | XS         |
| **DBCLOB(n)**                       | **NVARCHAR(MAX)**                                  | Double-byte CLOB maps to NVARCHAR(MAX)                                                                                                                            | S          |
| **BLOB(n)**                         | **VARBINARY(MAX)**                                 | 1:1 semantically                                                                                                                                                  | XS         |
| **DATE**                            | **DATE**                                           | 1:1                                                                                                                                                               | XS         |
| **TIME**                            | **TIME**                                           | 1:1                                                                                                                                                               | XS         |
| **TIMESTAMP**                       | **DATETIME2**                                      | Db2 TIMESTAMP has up to 12 fractional digits; DATETIME2 supports up to 7. Truncation may occur.                                                                   | S          |
| **TIMESTAMP WITH TIME ZONE**        | **DATETIMEOFFSET**                                 | 1:1 semantically                                                                                                                                                  | XS         |
| **XML**                             | **XML**                                            | 1:1; both support XQuery, XMLPARSE, XMLSERIALIZE                                                                                                                  | XS         |
| **BOOLEAN**                         | **BIT**                                            | Db2 BOOLEAN (TRUE/FALSE/NULL) maps to BIT (1/0/NULL)                                                                                                              | XS         |
| **ROWID**                           | **UNIQUEIDENTIFIER** or **IDENTITY**               | Db2 ROWID is a system-generated row identifier. Map to IDENTITY or UNIQUEIDENTIFIER depending on usage pattern.                                                   | S          |
| **ARRAY types**                     | **Table-valued parameters** or **JSON**            | Db2 supports ARRAY data types in stored procedures. No direct equivalent; use TVPs or JSON for set-passing.                                                       | M          |

---

## 3. SQL language features

| Db2 feature                                                  | Azure SQL equivalent                              | Migration notes                                                                                               | Complexity |
| ------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| **FETCH FIRST n ROWS ONLY**                                  | **TOP n** or **OFFSET...FETCH NEXT**              | SSMA converts automatically. OFFSET...FETCH is the ANSI-equivalent form.                                      | XS         |
| **VALUES (expr1, expr2)** as a row constructor               | **SELECT expr1, expr2** or **VALUES** in INSERT   | Db2 uses VALUES as a standalone query. T-SQL requires SELECT or uses VALUES only in INSERT.                   | S          |
| **CURRENT DATE / CURRENT TIME / CURRENT TIMESTAMP**          | **GETDATE() / SYSDATETIME() / CURRENT_TIMESTAMP** | Db2 special registers become T-SQL functions. CURRENT_TIMESTAMP works in both.                                | XS         |
| **Date arithmetic** (DAYS(), MONTHS_BETWEEN())               | **DATEDIFF() / DATEADD()**                        | Db2 date arithmetic using DAYS(d1)-DAYS(d2) becomes DATEDIFF(DAY, d2, d1). All date functions need remapping. | M          |
| **SUBSTR(s, start, length)**                                 | **SUBSTRING(s, start, length)**                   | SSMA converts automatically                                                                                   | XS         |
| **POSSTR(source, search)**                                   | **CHARINDEX(search, source)**                     | Argument order is reversed                                                                                    | S          |
| **LENGTH(s)** / **CHAR_LENGTH(s)**                           | **LEN(s)** / **DATALENGTH(s)**                    | LEN excludes trailing spaces; DATALENGTH counts bytes                                                         | S          |
| **STRIP() / LTRIM() / RTRIM()**                              | **TRIM() / LTRIM() / RTRIM()**                    | STRIP maps to TRIM (available in SQL Server 2017+)                                                            | XS         |
| **COALESCE(a, b, c)**                                        | **COALESCE(a, b, c)**                             | 1:1                                                                                                           | XS         |
| **NULLIF(a, b)**                                             | **NULLIF(a, b)**                                  | 1:1                                                                                                           | XS         |
| **CASE expression**                                          | **CASE expression**                               | 1:1                                                                                                           | XS         |
| **CAST / explicit type conversion**                          | **CAST / CONVERT**                                | SSMA handles most cases. CONVERT provides additional formatting options.                                      | XS         |
| **WITH (CTE)**                                               | **WITH (CTE)**                                    | 1:1; recursive CTEs work in both                                                                              | XS         |
| **MERGE statement**                                          | **MERGE statement**                               | Both support MERGE but clause ordering and syntax differ. SSMA converts with some manual cleanup.             | M          |
| **OLAP functions** (ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD) | **Window functions**                              | Near 1:1. Db2 uses OLAP specification; T-SQL uses OVER clause.                                                | S          |
| **GROUPING SETS / CUBE / ROLLUP**                            | **GROUPING SETS / CUBE / ROLLUP**                 | 1:1                                                                                                           | XS         |
| **LATERAL / CROSS APPLY**                                    | **CROSS APPLY / OUTER APPLY**                     | Db2 LATERAL maps to T-SQL CROSS APPLY                                                                         | S          |
| **FOR UPDATE / WHERE CURRENT OF**                            | **WHERE CURRENT OF** (cursor-based)               | Cursor-based update pattern exists in both.                                                                   | S          |
| **SELECT FROM FINAL TABLE (INSERT)**                         | **OUTPUT clause**                                 | Db2's SELECT FROM FINAL TABLE maps to T-SQL's OUTPUT clause for capturing affected rows.                      | M          |
| **CONNECT BY** (hierarchical queries)                        | **Recursive CTE**                                 | Db2 supports both CONNECT BY (Oracle compatibility) and recursive CTEs. T-SQL uses recursive CTEs only.       | M          |

---

## 4. Database objects

| Db2 feature                          | Azure SQL equivalent                                                       | Migration notes                                                                                                                                                                      | Complexity |
| ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| **Sequences** (CREATE SEQUENCE)      | **Sequences** (CREATE SEQUENCE)                                            | Near 1:1. Minor syntax differences in caching and cycling options.                                                                                                                   | XS         |
| **Identity columns**                 | **Identity columns**                                                       | 1:1 (GENERATED ALWAYS AS IDENTITY or GENERATED BY DEFAULT maps to IDENTITY)                                                                                                          | XS         |
| **Views**                            | **Views**                                                                  | 1:1 for standard views. WITH CHECK OPTION supported in both.                                                                                                                         | XS         |
| **Materialized Query Tables (MQTs)** | **Indexed views**                                                          | MQTs with REFRESH IMMEDIATE map to indexed views (maintained automatically). MQTs with REFRESH DEFERRED have no direct equivalent -- implement with scheduled refresh via SQL Agent. | M          |
| **Aliases**                          | **Synonyms**                                                               | Db2 aliases map to SQL Server synonyms. SSMA converts automatically.                                                                                                                 | XS         |
| **Nicknames** (federation)           | **Linked servers**                                                         | Db2 federation nicknames for remote data sources map to linked server references. Different configuration model.                                                                     | M          |
| **User-defined types (UDTs)**        | **User-defined types**                                                     | Db2 distinct types map to T-SQL CREATE TYPE. Structured types require more work.                                                                                                     | S          |
| **User-defined functions (scalar)**  | **Scalar functions**                                                       | SSMA converts. Db2 SQL functions to T-SQL functions. Performance characteristics differ.                                                                                             | S          |
| **User-defined functions (table)**   | **Table-valued functions**                                                 | Db2 table functions map to inline or multi-statement TVFs.                                                                                                                           | M          |
| **Stored procedures**                | **Stored procedures**                                                      | See [Stored Procedure Migration](stored-proc-migration.md) for detailed SQL PL to T-SQL conversion guide.                                                                            | M-L        |
| **Triggers (BEFORE)**                | **INSTEAD OF triggers**                                                    | Db2 BEFORE triggers fire before the modification. T-SQL has no BEFORE triggers -- refactor to INSTEAD OF triggers or move logic to stored procedures/application layer.              | M          |
| **Triggers (AFTER)**                 | **AFTER triggers**                                                         | 1:1 semantic mapping. Syntax differences handled by SSMA.                                                                                                                            | S          |
| **Triggers (INSTEAD OF)**            | **INSTEAD OF triggers**                                                    | 1:1                                                                                                                                                                                  | XS         |
| **Global temporary tables**          | **Global temporary tables** (##temp) or **local temporary tables** (#temp) | Db2 DECLARE GLOBAL TEMPORARY TABLE maps to T-SQL local temp tables. Db2 CREATED GLOBAL TEMPORARY TABLE maps to T-SQL global temp tables.                                             | S          |

---

## 5. Security features

| Db2 feature                              | Azure SQL equivalent                              | Migration notes                                                                                                                    | Complexity |
| ---------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Row and Column Access Control (RCAC)** | **Row-Level Security (RLS)**                      | Db2 RCAC row permissions map to RLS security predicates. Column access control maps to Dynamic Data Masking or column-level GRANT. | M          |
| **Label-Based Access Control (LBAC)**    | **RLS + classification labels**                   | LBAC security labels require custom implementation using RLS predicates combined with Purview sensitivity labels.                  | L          |
| **Trusted contexts**                     | **Database-scoped credentials** + **Entra ID**    | Db2 trusted contexts for multi-tier authentication map to Azure AD (Entra ID) authentication with application identities.          | M          |
| **AUDIT policy**                         | **SQL Auditing** + **Microsoft Defender for SQL** | Db2 AUDIT policy maps to Azure SQL Auditing. Defender for SQL adds threat detection.                                               | S          |
| **Encryption (native)**                  | **TDE** + **Always Encrypted**                    | Db2 native encryption maps to TDE (at rest) and Always Encrypted (client-side).                                                    | S          |
| **Column-level encryption**              | **Always Encrypted**                              | Db2 column encryption functions map to Always Encrypted with enclave.                                                              | M          |
| **Database roles**                       | **Database roles**                                | 1:1 mapping for role-based access.                                                                                                 | XS         |
| **GRANT / REVOKE**                       | **GRANT / REVOKE**                                | 1:1 for standard permissions. Db2-specific privileges (BINDADD, CREATETAB, etc.) map to T-SQL equivalents.                         | S          |

---

## 6. High availability and disaster recovery

| Db2 feature                                    | Azure SQL equivalent                              | Migration notes                                                                                                    | Complexity |
| ---------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| **HADR** (High Availability Disaster Recovery) | **Built-in zone-redundant HA** (99.99% SLA)       | Db2 HADR with primary/standby maps to Azure SQL MI's automatic zone-redundant deployment. No manual configuration. | XS         |
| **Automatic client reroute (ACR)**             | **Redirect connection policy**                    | Transparent failover built into Azure SQL MI.                                                                      | XS         |
| **Db2 pureScale** (shared-disk clustering)     | **Azure SQL MI Business Critical** (local SSD HA) | pureScale's shared-disk model maps conceptually to Business Critical tier's Always On availability group.          | S          |
| **Log shipping**                               | **Auto-failover groups**                          | Db2 log shipping for DR maps to Azure SQL MI auto-failover groups for geo-DR.                                      | S          |
| **Point-in-time recovery** (ROLLFORWARD)       | **Point-in-time restore** (35-day retention)      | Db2 ROLLFORWARD DATABASE using log files maps to Azure SQL MI's automated PITR. No manual backup management.       | XS         |
| **Online backup** (BACKUP DATABASE)            | **Automated backups**                             | Azure SQL MI backups are automatic. No BACKUP DATABASE command needed.                                             | XS         |

---

## 7. Performance and optimization

| Db2 feature                            | Azure SQL equivalent                                          | Migration notes                                                                                                                     | Complexity |
| -------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **REORG TABLE / REORG INDEX**          | **ALTER INDEX REBUILD / REORGANIZE**                          | Db2 REORG maps to index rebuild/reorganize. Azure SQL MI can automate via maintenance plans.                                        | XS         |
| **RUNSTATS**                           | **UPDATE STATISTICS**                                         | Db2 RUNSTATS maps to UPDATE STATISTICS. Azure SQL MI auto-updates statistics by default.                                            | XS         |
| **EXPLAIN** / access plan              | **Execution plan** (SET STATISTICS, Query Store)              | Db2 EXPLAIN tables map to graphical execution plans and Query Store in Azure SQL MI.                                                | S          |
| **Design Advisor**                     | **Database Engine Tuning Advisor** + **Intelligent Insights** | Similar function. Azure SQL MI adds AI-driven recommendations via Intelligent Insights.                                             | S          |
| **Workload Manager (WLM)**             | **Resource Governor**                                         | Db2 WLM for workload prioritization maps to SQL Server Resource Governor. Limited in Azure SQL MI; full in SQL Server on VMs.       | M          |
| **Statement concentrator**             | **Forced parameterization**                                   | Db2 statement concentrator reduces dynamic SQL compilation by reusing plans. T-SQL forced parameterization serves the same purpose. | S          |
| **Query parallelism** (INTRA_PARALLEL) | **MAXDOP** (max degree of parallelism)                        | Db2 intra-partition parallelism maps to SQL Server MAXDOP settings.                                                                 | XS         |
| **Compression** (row, page, adaptive)  | **Row, page, columnstore compression**                        | See storage section above.                                                                                                          | S          |

---

## 8. Backup, recovery, and utilities

| Db2 feature                  | Azure SQL equivalent                                       | Migration notes                                                                                                                                      | Complexity |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **LOAD utility**             | **BULK INSERT / bcp / ADF**                                | Db2 LOAD (high-speed bulk load) maps to BULK INSERT or bcp. ADF Db2 connector for pipeline-based loads.                                              | S          |
| **EXPORT utility**           | **bcp / SELECT INTO / ADF**                                | Db2 EXPORT to delimited files maps to bcp export or ADF extraction.                                                                                  | S          |
| **IMPORT utility**           | **BULK INSERT**                                            | Db2 IMPORT (insert-mode load) maps to BULK INSERT.                                                                                                   | S          |
| **REORG utility**            | **ALTER INDEX REBUILD**                                    | See performance section. Automatic on managed instances.                                                                                             | XS         |
| **RUNSTATS utility**         | **UPDATE STATISTICS / sp_updatestats**                     | Auto-update statistics enabled by default on Azure SQL MI.                                                                                           | XS         |
| **BIND / REBIND**            | **Not applicable**                                         | Db2 package binding has no equivalent in SQL Server. T-SQL is parsed and compiled at execution time. Remove BIND/REBIND from operational procedures. | XS         |
| **db2look** (DDL extraction) | **SSMS scripting** / **dacpac** / **SqlPackage**           | Db2 db2look for DDL generation maps to SSMS script generation or SqlPackage for dacpac extraction.                                                   | S          |
| **db2move** (data movement)  | **bcp / ADF / SSMA data migration**                        | Db2 db2move for database-level data movement maps to bcp, ADF pipelines, or SSMA data migration.                                                     | S          |
| **db2diag** (diagnostic log) | **sys.dm_exec_query_stats** + **Extended Events**          | Db2 diagnostic log maps to DMVs and Extended Events for query diagnostics.                                                                           | S          |
| **Db2 registry variables**   | **sp_configure** / **ALTER DATABASE SCOPED CONFIGURATION** | Db2 registry variables for instance configuration map to SQL Server configuration options.                                                           | S          |
| **BACKUP DATABASE**          | **Automated backups**                                      | Azure SQL MI performs automatic full, differential, and log backups. No manual BACKUP command needed. 35-day point-in-time restore.                  | XS         |
| **ROLLFORWARD DATABASE**     | **Point-in-time restore**                                  | Db2 ROLLFORWARD using archive logs maps to Azure SQL MI's automated point-in-time restore. No log file management required.                          | XS         |
| **RECOVER DATABASE**         | **Restore database**                                       | Db2 RECOVER DATABASE maps to Azure portal restore. Automated backup storage with configurable geo-redundancy.                                        | XS         |

---

## 9. Advanced features

| Db2 feature                                  | Azure SQL equivalent                                  | Migration notes                                                                                                                                         | Complexity |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Temporal tables** (system-time versioning) | **Temporal tables** (system-versioned)                | Both support system-time temporal tables. Minor syntax differences.                                                                                     | S          |
| **Application-period temporal tables**       | **Custom implementation**                             | Db2 supports application-period (business time) temporal tables. No built-in equivalent in SQL Server; implement with constraints and triggers.         | L          |
| **XML support** (XQuery, XMLPARSE, XMLTABLE) | **XML data type** (XQuery, OPENXML)                   | Both have strong XML support. Minor function name differences. XMLTABLE maps to OPENXML or XML nodes().                                                 | M          |
| **JSON support**                             | **JSON functions** (OPENJSON, JSON_VALUE, JSON_QUERY) | Both support JSON. Db2 uses JSON_VAL, JSON_TABLE. T-SQL uses JSON_VALUE, OPENJSON.                                                                      | S          |
| **Spatial data** (ST_GEOMETRY)               | **GEOGRAPHY / GEOMETRY types**                        | Db2 Spatial Extender maps to SQL Server's built-in spatial types. Function names differ (ST_Distance vs .STDistance()).                                 | M          |
| **Text search** (Db2 Text Search)            | **Full-text search**                                  | Db2 Text Search maps to SQL Server Full-Text Search or Azure Cognitive Search for advanced scenarios.                                                   | M          |
| **Event monitors**                           | **Extended Events** + **SQL Profiler**                | Db2 event monitors for performance monitoring map to Extended Events (preferred) or SQL Profiler (legacy).                                              | S          |
| **Autonomous transactions** (Db2 11.5+)      | **No direct equivalent**                              | Db2 autonomous transactions (independent commit within a transaction) have no equivalent. Refactor using linked server loopback or separate connection. | L          |
| **Global variables**                         | **Session context** (SESSION_CONTEXT)                 | Db2 global variables map to SESSION_CONTEXT in SQL Server for session-scoped state.                                                                     | S          |
| **Modules** (Db2 SQL packages)               | **Schemas** + **stored procedures**                   | Db2 modules (PL/SQL-style packages) have no direct equivalent. Map to schemas containing related stored procedures and functions.                       | M          |

---

## 10. Concurrency and locking

| Db2 feature                                              | Azure SQL equivalent                                                                   | Migration notes                                                                                                                                                          | Complexity |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| **Currently Committed (CC) semantics**                   | **Read Committed Snapshot Isolation (RCSI)**                                           | Db2 CC returns the last committed version of a row. RCSI provides similar non-blocking reads using row versioning. Enable RCSI on the database.                          | S          |
| **Lock escalation** (row to table)                       | **Lock escalation** (row to page to table)                                             | Db2 escalates row locks to table locks based on LOCKLIST/MAXLOCKS. SQL Server escalates through page locks. Behavior is similar; thresholds differ.                      | XS         |
| **Lock timeouts** (LOCKTIMEOUT)                          | **SET LOCK_TIMEOUT**                                                                   | Db2 LOCKTIMEOUT db cfg parameter maps to T-SQL SET LOCK_TIMEOUT (in milliseconds).                                                                                       | XS         |
| **Deadlock detection**                                   | **Deadlock detection** (automatic)                                                     | Both platforms detect deadlocks automatically. SQL Server's deadlock monitor runs every 5 seconds by default. Db2 deadlock frequency depends on the DLCHKTIME parameter. | XS         |
| **Isolation levels** (UR, CS, RS, RR)                    | **Isolation levels** (READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE) | Direct mapping: UR=READ UNCOMMITTED, CS=READ COMMITTED, RS=REPEATABLE READ, RR=SERIALIZABLE. SSMA converts WITH UR/CS/RS/RR hints.                                       | S          |
| **SKIP LOCKED DATA**                                     | **READPAST hint**                                                                      | Db2 SKIP LOCKED DATA maps to T-SQL WITH (READPAST). Used for queue-like processing patterns.                                                                             | XS         |
| **Row-level locking** (default for InnoDB-like behavior) | **Row-level locking** (default)                                                        | Both platforms default to row-level locking for DML operations.                                                                                                          | XS         |

---

## 11. Partitioning and data organization

| Db2 feature                                 | Azure SQL equivalent                                 | Migration notes                                                                                                                                                                           | Complexity |
| ------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Range partitioning** (partition by range) | **Table partitioning** (partition function + scheme) | Db2 range partitioning maps directly to SQL Server table partitioning. Create partition function and scheme, then apply to tables.                                                        | M          |
| **Hash partitioning** (Db2 10.5+)           | **No direct equivalent**                             | SQL Server does not support hash partitioning natively. Use computed columns with a hash function as the partition key, or redesign with range partitioning.                              | M          |
| **Multi-Dimensional Clustering (MDC)**      | **Columnstore indexes** + **partitioning**           | MDC organizes data by multiple dimensions for fast block-level access. Columnstore indexes with partitioning on the primary dimension provide similar multi-dimensional scan performance. | L          |
| **Range-clustered tables (RCT)**            | **Clustered index** on range key                     | Db2 RCTs store data in key sequence without separate index overhead. SQL Server clustered index provides the same physical ordering.                                                      | S          |
| **Data partitioning features (DPF)**        | **Sharding** or **elastic database tools**           | Db2 DPF distributes data across multiple partitions/nodes. No direct equivalent in a single Azure SQL MI. For multi-node distribution, use elastic database tools or shard maps.          | L          |
| **Table spaces in different storage paths** | **Filegroups on different storage**                  | Db2 allows tablespaces on different DASD/disk paths. SQL Server filegroups can span different storage tiers on Azure SQL VMs. Azure SQL MI manages storage automatically.                 | S          |

---

## 12. Replication and data distribution

| Db2 feature                                | Azure SQL equivalent                                  | Migration notes                                                                                                                                                             | Complexity |
| ------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Q Replication** (MQ-based CDC)           | **Fabric Mirroring** or **ADF CDC**                   | Db2 Q Replication uses MQ to capture and apply changes. Fabric Mirroring provides near-real-time CDC from Azure SQL. ADF provides change data capture for custom pipelines. | M          |
| **SQL Replication** (Apply/Capture agents) | **Transactional replication** or **Fabric Mirroring** | Db2 SQL Replication capture/apply maps to SQL Server transactional replication or Fabric Mirroring for analytics targets.                                                   | M          |
| **Data sharing** (z/OS Parallel Sysplex)   | **Auto-failover groups** + **read replicas**          | Db2 data sharing across z/OS coupling facilities maps to Azure SQL MI auto-failover groups for multi-region access. Read scale-out provides read replicas.                  | M          |
| **Federation (DRDA-based)**                | **Linked servers**                                    | Db2 federation using nicknames over DRDA maps to linked servers using OLEDB or ODBC providers. Different query push-down capabilities.                                      | M          |

---

## 13. Development and tooling

| Db2 feature                          | Azure SQL equivalent                                            | Migration notes                                                                                                                                                 | Complexity |
| ------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Db2 CLP** (Command Line Processor) | **sqlcmd** / **Azure Data Studio**                              | Db2 CLP interactive mode maps to sqlcmd. Azure Data Studio provides a modern GUI alternative.                                                                   | XS         |
| **IBM Data Studio**                  | **SQL Server Management Studio (SSMS)** / **Azure Data Studio** | IBM Data Studio for Db2 administration maps to SSMS or Azure Data Studio.                                                                                       | XS         |
| **EXPLAIN** tables                   | **Query Store** + **execution plans**                           | Db2 EXPLAIN populates system tables with access plans. SQL Server Query Store provides historical query plan analysis. Graphical plans in SSMS/ADS.             | S          |
| **Db2 monitoring (SNAPSHOT)**        | **Dynamic Management Views (DMVs)**                             | Db2 snapshot monitoring functions map to sys.dm\_\* DMVs. Different query syntax but same conceptual approach.                                                  | S          |
| **Db2 health monitor**               | **Intelligent Insights** + **Defender for SQL**                 | Db2 health monitor with automated alerts maps to Azure SQL MI Intelligent Insights (AI-driven performance analysis) and Defender for SQL (security monitoring). | S          |
| **db2top** (real-time monitoring)    | **Activity Monitor** / **SQL Insights**                         | Db2 db2top for real-time performance monitoring maps to SSMS Activity Monitor or Azure SQL Insights dashboards.                                                 | S          |
| **Db2 problem determination (PD)**   | **Extended Events** + **Azure Monitor**                         | Db2 diagnostic tools (db2diag, db2fodc) map to Extended Events for detailed tracing and Azure Monitor for platform-level diagnostics.                           | S          |

---

## 14. Conversion complexity summary

Overall distribution of conversion complexity across all mapped features:

| Complexity                      | Count | Percentage | Interpretation                           |
| ------------------------------- | ----- | ---------- | ---------------------------------------- |
| **XS** (automatic/trivial)      | 38    | 45%        | SSMA handles with no manual intervention |
| **S** (minor adjustment)        | 24    | 29%        | 1-3 days of manual work per feature      |
| **M** (moderate rework)         | 17    | 20%        | 1-2 weeks per feature                    |
| **L** (significant refactoring) | 4     | 5%         | 2-6 weeks per feature                    |
| **XL** (architectural redesign) | 1     | 1%         | 6+ weeks                                 |

This distribution means that approximately 74% of Db2 features convert with little to no manual effort. The remaining 26% requires planned engineering effort, concentrated in stored procedure conversion, trigger refactoring, and advanced Db2-specific features (MDC, LBAC, DPF).

---

## 15. Feature gap summary

Features where Db2 has capabilities without direct Azure SQL equivalents:

| Db2 feature                            | Gap severity | Recommended mitigation                                                          |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| **BEFORE triggers**                    | Medium       | Refactor to INSTEAD OF triggers or application-layer validation                 |
| **Multi-Dimensional Clustering (MDC)** | Medium       | Use partitioning + columnstore indexes for similar query patterns               |
| **DECFLOAT data type**                 | Low          | Map to DECIMAL with appropriate precision; test rounding behavior               |
| **Application-period temporal tables** | Medium       | Implement with constraints, triggers, and application logic                     |
| **Autonomous transactions**            | Medium       | Use linked server loopback or separate connection for independent commits       |
| **Array data types (in procedures)**   | Low          | Use table-valued parameters or JSON for set-passing in procedures               |
| **Db2 modules (packages)**             | Low          | Map to schemas; cosmetic difference in organization                             |
| **LBAC (Label-Based Access Control)**  | High         | Implement with RLS predicates + Purview sensitivity labels; complex custom work |
| **MQT deferred refresh**               | Medium       | Schedule refresh via SQL Agent jobs on Azure SQL MI                             |
| **Hash partitioning**                  | Low          | Use computed column with hash function as partition key                         |
| **Data Partitioning Feature (DPF)**    | Medium       | Elastic database tools or shard maps for multi-node distribution                |
| **Currently Committed on z/OS**        | Low          | Enable RCSI on Azure SQL databases for non-blocking reads                       |
| **Q Replication (MQ-based CDC)**       | Low          | Fabric Mirroring provides near-real-time CDC natively                           |

### Features where Azure SQL exceeds Db2

Azure SQL provides capabilities that Db2 does not have or that require additional IBM products:

| Azure SQL feature                   | Db2 equivalent                           | Advantage                                             |
| ----------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| **Serverless auto-scale**           | Not available                            | Pay only for compute used; auto-pause during idle     |
| **Hyperscale (100+ TB)**            | z/OS capacity but not as managed service | Managed PaaS for very large databases                 |
| **Fabric Mirroring**                | Q Replication (separate product)         | Zero-ETL analytics integration included in service    |
| **Intelligent Insights**            | No equivalent                            | AI-driven performance recommendations                 |
| **Query Store**                     | No equivalent                            | Historical query plan analysis built into engine      |
| **Automatic tuning**                | No equivalent                            | Auto-create/drop indexes, force regression correction |
| **Built-in threat detection**       | External tools required                  | Microsoft Defender for SQL included                   |
| **Point-in-time restore (35 days)** | Customer-managed backups                 | Automatic, no operational overhead                    |
| **Elastic pools**                   | No equivalent                            | Share resources across multiple databases             |
| **Auto-failover groups**            | HADR (customer-managed)                  | Automatic geo-DR with DNS-based failover              |

---

## Related resources

- [Schema Migration Guide](schema-migration.md) -- detailed data type and SQL syntax conversion
- [Stored Procedure Migration](stored-proc-migration.md) -- SQL PL to T-SQL conversion patterns
- [Migration Playbook](../db2-to-azure-sql.md) -- end-to-end migration plan
- [Best Practices](best-practices.md) -- assessment methodology and complexity tiers

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
