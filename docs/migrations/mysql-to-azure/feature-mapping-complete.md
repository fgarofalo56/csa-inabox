# MySQL / MariaDB Feature Mapping to Azure

**40+ MySQL and MariaDB features mapped to Azure Database for MySQL Flexible Server, Azure Database for PostgreSQL Flexible Server, and Azure SQL Database equivalents. Capability parity analysis with honest gap assessment.**

---

!!! info "How to use this mapping"
This document maps MySQL/MariaDB features to their Azure equivalents across three target platforms. Use it to identify feature gaps, plan conversion effort, and validate that your target platform supports your workload requirements. Features are organized by category with migration complexity ratings: **Direct** (same or equivalent), **Moderate** (configuration or minor code changes), **Complex** (significant redesign), or **Not Available** (no equivalent).

---

## 1. Storage engines

| MySQL/MariaDB feature                        | Azure MySQL Flexible Server                 | Azure PostgreSQL                                         | Azure SQL Database                       | Migration complexity             |
| -------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| **InnoDB** (default transactional engine)    | InnoDB (default, fully supported)           | PostgreSQL heap tables (MVCC-based, similar semantics)   | Clustered indexes (default)              | Direct / Direct / Moderate       |
| **MyISAM** (non-transactional, read-heavy)   | Supported but must convert to InnoDB for HA | PostgreSQL unlogged tables (similar performance profile) | Heap tables                              | Moderate (convert to InnoDB)     |
| **MEMORY / HEAP** (in-memory tables)         | Supported (server restart clears data)      | PostgreSQL unlogged tables or `pg_prewarm`               | In-Memory OLTP (memory-optimized tables) | Direct / Moderate / Moderate     |
| **ARCHIVE** (compressed, insert-only)        | Not supported on Flexible Server            | No direct equivalent; use partitioning + compression     | Columnstore indexes for archive          | Moderate (redesign)              |
| **CSV** (comma-separated values)             | Supported                                   | `file_fdw` foreign data wrapper                          | BULK INSERT from CSV                     | Direct / Moderate / Moderate     |
| **BLACKHOLE** (dev/null, replication filter) | Not supported on Flexible Server            | No equivalent                                            | No equivalent                            | Complex (redesign replication)   |
| **FEDERATED** (remote table access)          | Not supported                               | `postgres_fdw` (foreign data wrapper)                    | Linked servers / Elastic query           | Complex / Moderate / Moderate    |
| **MariaDB Aria** (crash-safe MyISAM)         | Not supported (convert to InnoDB)           | PostgreSQL heap tables                                   | Standard tables                          | Moderate (convert to InnoDB)     |
| **MariaDB ColumnStore** (analytics)          | Not supported                               | PostgreSQL with columnar extensions                      | Columnstore indexes                      | Complex (redesign for analytics) |
| **NDB Cluster** (distributed)                | Not supported                               | Citus extension (distributed PostgreSQL)                 | Elastic pools / Hyperscale               | Complex (architectural change)   |

---

## 2. Replication and high availability

| MySQL/MariaDB feature                 | Azure MySQL Flexible Server                                        | Azure PostgreSQL                           | Azure SQL Database            | Migration complexity            |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ----------------------------- | ------------------------------- |
| **Asynchronous replication** (binlog) | Read replicas (up to 10, cross-region)                             | Read replicas (up to 5)                    | Active geo-replication        | Direct                          |
| **Semi-synchronous replication**      | Zone-redundant HA (stronger guarantee)                             | Synchronous commit (configurable)          | Built-in HA (synchronous)     | Direct (upgraded)               |
| **Group Replication** (multi-primary) | Not supported; use zone-redundant HA                               | No direct equivalent; Citus for multi-node | Failover groups               | Moderate (architectural change) |
| **MariaDB Galera Cluster**            | Not supported; use zone-redundant HA                               | No direct equivalent; Citus                | Failover groups               | Moderate (architectural change) |
| **GTID (Global Transaction ID)**      | Supported (MySQL GTID format)                                      | PostgreSQL LSN (Log Sequence Number)       | Built-in transaction tracking | Direct / Moderate / Direct      |
| **MariaDB GTID**                      | Not supported (different format); use binlog position              | N/A                                        | N/A                           | Moderate (use binlog position)  |
| **MySQL Router** (connection routing) | Built-in connection management                                     | Built-in PgBouncer                         | Built-in connection pooling   | Direct                          |
| **ProxySQL** (query routing, pooling) | Not needed; built-in read/write splitting possible via application | PgBouncer (built-in)                       | Built-in                      | Direct (simplified)             |
| **Automatic failover**                | Built-in (zone-redundant HA, 60-120s)                              | Built-in (zone-redundant, 60-120s)         | Built-in (automatic, < 30s)   | Direct (improved)               |
| **Read/write splitting**              | Application-level (primary + replica endpoints)                    | Application-level                          | Built-in read scale-out       | Direct                          |

---

## 3. Authentication and user management

| MySQL/MariaDB feature                         | Azure MySQL Flexible Server          | Azure PostgreSQL                  | Azure SQL Database          | Migration complexity            |
| --------------------------------------------- | ------------------------------------ | --------------------------------- | --------------------------- | ------------------------------- |
| **mysql_native_password**                     | Supported (legacy)                   | N/A (PostgreSQL uses md5/scram)   | N/A (SQL authentication)    | Direct / Complex / Complex      |
| **caching_sha2_password** (MySQL 8.0 default) | Supported (default)                  | N/A                               | N/A                         | Direct                          |
| **sha256_password**                           | Supported                            | N/A                               | N/A                         | Direct                          |
| **PAM authentication**                        | Not supported                        | PAM supported                     | Not supported               | Not Available                   |
| **LDAP authentication**                       | Not supported; use Entra ID          | LDAP supported; prefer Entra ID   | Not supported; use Entra ID | Moderate (switch to Entra ID)   |
| **Entra ID (Azure AD) authentication**        | Supported (recommended)              | Supported (recommended)           | Supported (recommended)     | New capability                  |
| **Managed Identity**                          | Supported (system and user-assigned) | Supported                         | Supported                   | New capability                  |
| **Role-based privileges**                     | MySQL roles (8.0+) supported         | PostgreSQL roles (rich model)     | Database roles              | Direct                          |
| **Row-level security**                        | Not available in MySQL               | Row-level security (RLS) policies | Row-level security (RLS)    | Not Available / Direct / Direct |
| **Dynamic privileges** (MySQL 8.0)            | Supported (most privileges)          | PostgreSQL privilege system       | T-SQL permissions           | Direct / Moderate / Moderate    |
| **SUPER privilege**                           | Not available (managed service)      | `SUPERUSER` not available         | `sa` not available          | Moderate (refactor)             |

---

## 4. Data types

| MySQL/MariaDB feature                             | Azure MySQL Flexible Server                   | Azure PostgreSQL                                 | Azure SQL Database                        | Migration complexity                  |
| ------------------------------------------------- | --------------------------------------------- | ------------------------------------------------ | ----------------------------------------- | ------------------------------------- |
| **INT / BIGINT / TINYINT / SMALLINT / MEDIUMINT** | All supported                                 | INTEGER, BIGINT, SMALLINT (no TINYINT/MEDIUMINT) | All supported                             | Direct / Moderate / Direct            |
| **DECIMAL / NUMERIC**                             | Supported                                     | NUMERIC / DECIMAL                                | DECIMAL / NUMERIC                         | Direct                                |
| **FLOAT / DOUBLE**                                | Supported                                     | REAL / DOUBLE PRECISION                          | FLOAT / REAL                              | Direct                                |
| **CHAR / VARCHAR**                                | Supported (max 65,535 bytes)                  | CHARACTER / VARCHAR (max 1 GB)                   | CHAR / VARCHAR (max 8,000) / VARCHAR(MAX) | Direct                                |
| **TEXT / MEDIUMTEXT / LONGTEXT**                  | Supported                                     | TEXT (unlimited)                                 | VARCHAR(MAX) / NVARCHAR(MAX)              | Direct / Direct / Moderate            |
| **BLOB / MEDIUMBLOB / LONGBLOB**                  | Supported                                     | BYTEA (max 1 GB)                                 | VARBINARY(MAX)                            | Direct / Moderate / Moderate          |
| **JSON**                                          | Native JSON type (binary storage, MySQL 8.0+) | JSONB (binary, indexed, superior)                | JSON (text-based, with T-SQL functions)   | Direct / Direct (improved) / Moderate |
| **ENUM**                                          | Supported                                     | Custom type or CHECK constraint                  | CHECK constraint                          | Direct / Moderate / Moderate          |
| **SET**                                           | Supported                                     | Array type or junction table                     | Junction table                            | Direct / Moderate / Complex           |
| **DATE / DATETIME / TIMESTAMP**                   | Supported                                     | DATE / TIMESTAMP / TIMESTAMPTZ                   | DATE / DATETIME / DATETIME2               | Direct                                |
| **TIME**                                          | Supported                                     | TIME / TIMETZ                                    | TIME                                      | Direct                                |
| **YEAR**                                          | Supported                                     | SMALLINT or custom domain                        | SMALLINT                                  | Direct / Moderate / Moderate          |
| **GEOMETRY / POINT / POLYGON**                    | MySQL Spatial types supported                 | PostGIS types (industry standard, superior)      | Spatial types (geometry/geography)        | Direct / Direct (improved) / Moderate |
| **BIT**                                           | Supported                                     | BIT / BIT VARYING                                | BIT                                       | Direct                                |
| **BOOLEAN**                                       | TINYINT(1) alias                              | Native BOOLEAN                                   | BIT                                       | Direct                                |
| **AUTO_INCREMENT**                                | Supported                                     | SERIAL / GENERATED ALWAYS AS IDENTITY            | IDENTITY                                  | Direct / Moderate / Moderate          |
| **UNSIGNED integers**                             | Supported                                     | Not supported (use CHECK constraint)             | Not supported (use CHECK)                 | Direct / Moderate / Moderate          |

---

## 5. SQL features

| MySQL/MariaDB feature              | Azure MySQL Flexible Server                    | Azure PostgreSQL                                           | Azure SQL Database                           | Migration complexity              |
| ---------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------- | --------------------------------- |
| **Stored procedures**              | Supported (MySQL syntax)                       | PL/pgSQL (different syntax)                                | T-SQL (different syntax)                     | Direct / Complex / Complex        |
| **Stored functions**               | Supported                                      | PL/pgSQL functions                                         | T-SQL functions                              | Direct / Complex / Complex        |
| **Triggers**                       | Supported (BEFORE/AFTER, INSERT/UPDATE/DELETE) | Supported (BEFORE/AFTER/INSTEAD OF, per-row/per-statement) | Supported (AFTER only, INSTEAD OF for views) | Direct / Moderate / Moderate      |
| **Events (scheduled tasks)**       | Supported (MySQL Event Scheduler)              | `pg_cron` extension                                        | SQL Agent (MI) or Elastic Jobs (DB)          | Direct / Moderate / Moderate      |
| **Views**                          | Supported                                      | Supported (with materialized views)                        | Supported (with indexed views)               | Direct                            |
| **Materialized views**             | Not available in MySQL                         | Supported (MATERIALIZED VIEW)                              | Indexed views (similar)                      | Not Available / Direct / Moderate |
| **Common Table Expressions (CTE)** | Supported (MySQL 8.0+)                         | Supported (recursive CTEs)                                 | Supported (recursive CTEs)                   | Direct                            |
| **Window functions**               | Supported (MySQL 8.0+)                         | Supported (richer set)                                     | Supported (full set)                         | Direct                            |
| **LATERAL joins**                  | Supported (MySQL 8.0.14+)                      | Supported                                                  | CROSS APPLY / OUTER APPLY                    | Direct / Direct / Moderate        |
| **EXPLAIN / EXPLAIN ANALYZE**      | Supported (EXPLAIN FORMAT=JSON/TREE)           | EXPLAIN ANALYZE (richer output)                            | Query execution plans (graphical)            | Direct                            |
| **Prepared statements**            | Supported                                      | Supported                                                  | Supported                                    | Direct                            |
| **User-defined variables**         | Supported (@var)                               | Not directly supported (use DO blocks)                     | @var in T-SQL                                | Direct / Moderate / Moderate      |
| **HANDLER statement**              | Supported                                      | No equivalent                                              | No equivalent                                | Not Available                     |
| **LOAD DATA INFILE**               | Supported (with `local_infile` parameter)      | COPY command                                               | BULK INSERT                                  | Direct / Moderate / Moderate      |
| **SELECT INTO OUTFILE**            | Not supported (managed service)                | COPY TO                                                    | BCP / OPENROWSET                             | Moderate (use alternative export) |
| **REPLACE INTO**                   | Supported                                      | INSERT ON CONFLICT (UPSERT)                                | MERGE                                        | Direct / Moderate / Moderate      |
| **INSERT IGNORE**                  | Supported                                      | INSERT ON CONFLICT DO NOTHING                              | TRY/CATCH or MERGE                           | Direct / Moderate / Moderate      |
| **ON DUPLICATE KEY UPDATE**        | Supported                                      | INSERT ON CONFLICT DO UPDATE                               | MERGE                                        | Direct / Moderate / Moderate      |

---

## 6. Indexing

| MySQL/MariaDB feature             | Azure MySQL Flexible Server    | Azure PostgreSQL                         | Azure SQL Database       | Migration complexity                  |
| --------------------------------- | ------------------------------ | ---------------------------------------- | ------------------------ | ------------------------------------- |
| **B-tree indexes**                | Supported (default)            | Supported (default)                      | Supported (default)      | Direct                                |
| **Hash indexes** (MEMORY engine)  | Supported (MEMORY tables only) | Hash indexes (any table)                 | Not directly available   | Direct / Direct / Moderate            |
| **Full-text indexes** (InnoDB)    | Supported (InnoDB full-text)   | tsvector/tsquery (more powerful)         | Full-text indexes        | Direct / Moderate / Moderate          |
| **Spatial indexes** (R-tree)      | Supported (InnoDB)             | GiST indexes (PostGIS, superior)         | Spatial indexes          | Direct / Direct (improved) / Moderate |
| **Prefix indexes**                | Supported                      | Not supported (use expression index)     | Not supported            | Direct / Moderate / Moderate          |
| **Invisible indexes**             | Supported (MySQL 8.0+)         | Not directly available; use CONCURRENTLY | Not available            | Direct / Moderate / Not Available     |
| **Descending indexes**            | Supported (MySQL 8.0+)         | Supported                                | Supported                | Direct                                |
| **Functional/expression indexes** | Supported (MySQL 8.0.13+)      | Supported                                | Computed columns + index | Direct / Direct / Moderate            |
| **Covering indexes** (INCLUDE)    | Supported (MySQL 8.0+)         | Supported (INCLUDE)                      | Supported (INCLUDE)      | Direct                                |
| **Adaptive hash index** (InnoDB)  | Automatic (InnoDB internal)    | N/A (different architecture)             | N/A                      | Direct (automatic)                    |
| **Multi-valued indexes** (JSON)   | Supported (MySQL 8.0.17+)      | GIN indexes on JSONB                     | Computed column + index  | Direct / Direct / Moderate            |

---

## 7. Partitioning

| MySQL/MariaDB feature           | Azure MySQL Flexible Server                | Azure PostgreSQL               | Azure SQL Database               | Migration complexity              |
| ------------------------------- | ------------------------------------------ | ------------------------------ | -------------------------------- | --------------------------------- |
| **RANGE partitioning**          | Supported                                  | Declarative partitioning (10+) | Table partitioning               | Direct                            |
| **LIST partitioning**           | Supported                                  | Supported                      | Table partitioning (range-based) | Direct / Direct / Moderate        |
| **HASH partitioning**           | Supported                                  | Hash partitioning (11+)        | Not directly supported           | Direct / Direct / Moderate        |
| **KEY partitioning**            | Supported                                  | Hash partitioning (similar)    | Not supported                    | Direct / Moderate / Not Available |
| **Sub-partitioning**            | Supported (RANGE/LIST + HASH)              | Multi-level partitioning (13+) | Not supported                    | Direct / Direct / Not Available   |
| **Partition pruning**           | Supported                                  | Supported (partition pruning)  | Partition elimination            | Direct                            |
| **Partition exchange**          | Supported (ALTER TABLE EXCHANGE PARTITION) | Attach/detach partitions       | Switch partitions                | Direct / Moderate / Moderate      |
| **Online partition management** | Supported (MySQL 8.0+)                     | Supported                      | Online operations                | Direct                            |

---

## 8. Full-text search

| MySQL/MariaDB feature                | Azure MySQL Flexible Server      | Azure PostgreSQL                    | Azure SQL Database      | Migration complexity              |
| ------------------------------------ | -------------------------------- | ----------------------------------- | ----------------------- | --------------------------------- |
| **FULLTEXT index** (InnoDB)          | Supported                        | tsvector/tsquery (more powerful)    | Full-text index         | Direct / Moderate / Moderate      |
| **MATCH AGAINST** (natural language) | Supported                        | `to_tsvector` + `to_tsquery` + `@@` | CONTAINS / FREETEXT     | Direct / Moderate / Moderate      |
| **Boolean mode**                     | Supported                        | tsquery with operators              | CONTAINS with operators | Direct / Moderate / Moderate      |
| **Query expansion**                  | Supported (WITH QUERY EXPANSION) | Custom dictionaries, thesaurus      | Thesaurus files         | Direct / Moderate / Moderate      |
| **Stopwords**                        | Configurable                     | Custom stop word dictionaries       | System stopword list    | Direct                            |
| **CJK support** (ngram parser)       | Supported                        | `pg_bigm` or `pgroonga` extensions  | Word breaker            | Direct / Moderate / Moderate      |
| **MeCab parser** (Japanese)          | Supported                        | `pgroonga` extension                | Not available           | Direct / Moderate / Not Available |

---

## 9. JSON support

| MySQL/MariaDB feature             | Azure MySQL Flexible Server         | Azure PostgreSQL                              | Azure SQL Database       | Migration complexity                  |
| --------------------------------- | ----------------------------------- | --------------------------------------------- | ------------------------ | ------------------------------------- |
| **JSON data type**                | Native binary JSON (MySQL 8.0+)     | JSONB (binary, indexed, superior)             | JSON (text-based)        | Direct / Direct (improved) / Moderate |
| **JSON path expressions**         | `$`, `$.key`, `$[0]` (MySQL syntax) | `->`, `->>`, `#>`, `#>>`, `@>`, `?` operators | JSON_VALUE, JSON_QUERY   | Direct / Moderate / Moderate          |
| **JSON_EXTRACT / ->**             | Supported                           | `->` and `->>` operators                      | JSON_VALUE               | Direct / Direct / Moderate            |
| **JSON_SET / JSON_REPLACE**       | Supported                           | `jsonb_set` function                          | JSON_MODIFY              | Direct / Moderate / Moderate          |
| **JSON_TABLE**                    | Supported (MySQL 8.0.4+)            | `jsonb_to_recordset`                          | OPENJSON                 | Direct / Moderate / Moderate          |
| **JSON indexing**                 | Multi-valued indexes (8.0.17+)      | GIN / GiST indexes on JSONB (superior)        | Computed column + index  | Direct / Direct (improved) / Moderate |
| **JSON aggregation**              | JSON_ARRAYAGG, JSON_OBJECTAGG       | json_agg, jsonb_agg, jsonb_object_agg         | JSON_QUERY with FOR JSON | Direct / Moderate / Moderate          |
| **JSON validation**               | JSON_VALID function                 | `IS JSON` predicate                           | ISJSON function          | Direct / Direct / Direct              |
| **JSON schema validation**        | Not available                       | `jsonb_matches_schema` (extension)            | Not available            | Not Available                         |
| **MariaDB JSON** (LONGTEXT alias) | Convert to native JSON type         | JSONB (requires data migration)               | JSON (text-based)        | Moderate / Moderate / Moderate        |

---

## 10. GIS / Spatial features

| MySQL/MariaDB feature         | Azure MySQL Flexible Server                | Azure PostgreSQL                              | Azure SQL Database               | Migration complexity                |
| ----------------------------- | ------------------------------------------ | --------------------------------------------- | -------------------------------- | ----------------------------------- |
| **Spatial data types**        | GEOMETRY, POINT, LINESTRING, POLYGON, etc. | PostGIS types (industry standard, far richer) | geometry / geography             | Direct / Moderate / Moderate        |
| **Spatial reference systems** | SRS support (MySQL 8.0+)                   | PostGIS SRID support (4,000+ SRS)             | SRID support                     | Direct / Direct / Moderate          |
| **Spatial indexes**           | R-tree (InnoDB)                            | GiST (PostGIS, superior)                      | Spatial index                    | Direct / Direct / Moderate          |
| **ST_Distance**               | Supported                                  | ST_Distance (with geography support)          | STDistance                       | Direct                              |
| **ST_Contains / ST_Within**   | Supported                                  | Supported (with additional functions)         | STContains / STWithin            | Direct                              |
| **ST_Buffer / ST_Union**      | Supported                                  | Supported (richer function set)               | STBuffer / STUnion               | Direct                              |
| **GeoJSON support**           | ST_AsGeoJSON / ST_GeomFromGeoJSON          | ST_AsGeoJSON / ST_GeomFromGeoJSON             | Not native (workaround via JSON) | Direct / Direct / Moderate          |
| **Spatial aggregates**        | Limited                                    | Rich spatial aggregation (PostGIS)            | Limited                          | Direct / Direct (improved) / Direct |

---

## 11. Performance and monitoring

| MySQL/MariaDB feature                 | Azure MySQL Flexible Server                     | Azure PostgreSQL                 | Azure SQL Database            | Migration complexity         |
| ------------------------------------- | ----------------------------------------------- | -------------------------------- | ----------------------------- | ---------------------------- |
| **Slow query log**                    | Supported (configurable threshold)              | `log_min_duration_statement`     | Query Store                   | Direct / Direct / Moderate   |
| **performance_schema**                | Supported (most instruments)                    | `pg_stat_statements` extension   | Dynamic Management Views      | Direct / Moderate / Moderate |
| **INFORMATION_SCHEMA**                | Supported                                       | Supported (different tables)     | Supported (SQL Server schema) | Direct / Moderate / Moderate |
| **SHOW STATUS / SHOW VARIABLES**      | Supported                                       | `pg_settings`, `pg_stat_*` views | `sys.configurations`, DMVs    | Direct / Moderate / Moderate |
| **SHOW PROCESSLIST**                  | Supported                                       | `pg_stat_activity`               | `sys.dm_exec_requests`        | Direct / Moderate / Moderate |
| **Binary log (binlog)**               | Supported (for replication, DMS)                | WAL (Write-Ahead Log)            | Transaction log               | Direct / Moderate / Moderate |
| **InnoDB buffer pool monitoring**     | Supported (buffer pool metrics)                 | `shared_buffers` metrics         | Buffer pool metrics           | Direct                       |
| **Query profiling**                   | EXPLAIN ANALYZE (MySQL 8.0.18+)                 | EXPLAIN ANALYZE (richer output)  | Execution plan + statistics   | Direct                       |
| **MySQL Enterprise Monitor**          | Azure Monitor + Performance Insights (included) | Azure Monitor + Query Store      | Azure Monitor + Query Store   | Direct (upgraded, free)      |
| **Percona Monitoring and Management** | Azure Monitor replaces need                     | Azure Monitor replaces need      | Azure Monitor replaces need   | Direct (simplified)          |

---

## 12. Security features

| MySQL/MariaDB feature                           | Azure MySQL Flexible Server                | Azure PostgreSQL              | Azure SQL Database            | Migration complexity                   |
| ----------------------------------------------- | ------------------------------------------ | ----------------------------- | ----------------------------- | -------------------------------------- |
| **TLS/SSL connections**                         | TLS 1.2/1.3 enforced                       | TLS 1.2/1.3 enforced          | TLS 1.2/1.3 enforced          | Direct                                 |
| **Data-at-rest encryption** (InnoDB tablespace) | AES-256 (service or customer-managed keys) | AES-256 (service or CMK)      | TDE (service or CMK)          | Direct (upgraded)                      |
| **Audit logging**                               | Audit log plugin (server parameter)        | `pgaudit` extension           | SQL Audit                     | Direct                                 |
| **MySQL Enterprise Firewall**                   | Azure Firewall + Private Link + NSG        | Azure Firewall + Private Link | Azure Firewall + Private Link | Direct (upgraded)                      |
| **Connection encryption**                       | Enforced by default                        | Enforced by default           | Enforced by default           | Direct                                 |
| **Password validation**                         | `validate_password` component              | `passwordcheck` extension     | Password policy               | Direct                                 |
| **Data masking**                                | Not available (Enterprise only)            | Not available natively        | Dynamic data masking          | Not Available / Not Available / Direct |
| **mysql_firewall plugin**                       | Not supported; use Azure networking        | Not applicable                | Not applicable                | Moderate (Azure Firewall)              |

---

## 13. Backup and recovery

| MySQL/MariaDB feature         | Azure MySQL Flexible Server               | Azure PostgreSQL                | Azure SQL Database           | Migration complexity         |
| ----------------------------- | ----------------------------------------- | ------------------------------- | ---------------------------- | ---------------------------- |
| **mysqldump**                 | Available via client tools                | pg_dump (different syntax)      | bacpac / bcp                 | Direct / Moderate / Moderate |
| **mysqlpump** (parallel dump) | Available via client tools                | pg_dump (with directory format) | Not applicable               | Direct                       |
| **Percona XtraBackup**        | Not needed (automated backups)            | Not applicable                  | Not applicable               | Direct (simplified)          |
| **Point-in-time restore**     | Built-in (any second, 1-35 day retention) | Built-in (1-35 days)            | Built-in (1-35 days)         | Direct (upgraded)            |
| **Automated backups**         | Daily full + continuous binlog            | Daily full + continuous WAL     | Automated (full/diff/log)    | Direct (automated)           |
| **Geo-redundant backups**     | Geo-redundant backup storage              | Geo-redundant backup storage    | Geo-redundant backup storage | Direct                       |
| **Cross-region restore**      | Geo-restore to paired region              | Geo-restore                     | Geo-restore                  | Direct                       |
| **Logical backup/restore**    | mysqldump/mysqlimport via client          | pg_dump/pg_restore              | bacpac import/export         | Direct / Moderate / Moderate |

---

## 14. Additional MySQL-specific features

| MySQL/MariaDB feature                  | Azure MySQL Flexible Server             | Azure PostgreSQL                      | Azure SQL Database      | Migration complexity               |
| -------------------------------------- | --------------------------------------- | ------------------------------------- | ----------------------- | ---------------------------------- |
| **MySQL Shell**                        | Supported (client tool)                 | psql (different tool)                 | sqlcmd / SSMS           | Direct / Moderate / Moderate       |
| **X Protocol / Document Store**        | Supported (MySQL 8.0+)                  | JSONB provides similar document model | No equivalent           | Direct / Moderate / Not Available  |
| **MySQL Workbench**                    | Supported (client tool)                 | pgAdmin, DBeaver                      | SSMS, Azure Data Studio | Direct                             |
| **InnoDB Cluster**                     | Not supported (use zone-redundant HA)   | Not applicable                        | Not applicable          | Moderate (use managed HA)          |
| **Clone plugin**                       | Not supported (use managed replication) | Not applicable                        | Not applicable          | Moderate (use managed replication) |
| **Resource groups**                    | Supported (MySQL 8.0+)                  | Resource groups extension             | Resource Governor       | Direct / Moderate / Moderate       |
| **Character sets** (utf8mb4)           | Supported (utf8mb4 default on 8.0+)     | UTF-8 natively                        | UTF-8 (nvarchar)        | Direct                             |
| **Collations**                         | Supported (100+ collations)             | ICU collations (PostgreSQL 15+)       | SQL Server collations   | Direct / Moderate / Moderate       |
| **Generated columns** (virtual/stored) | Supported                               | Supported (generated columns)         | Computed columns        | Direct                             |
| **CHECK constraints**                  | Enforced (MySQL 8.0.16+)                | Enforced                              | Enforced                | Direct                             |
| **DEFAULT expressions**                | Supported (MySQL 8.0.13+)               | Supported                             | Supported               | Direct                             |
| **Instant ADD COLUMN**                 | Supported (InnoDB, MySQL 8.0+)          | No lock for many DDL operations       | Online index operations | Direct                             |

---

**Next:** [Flexible Server Migration](flexible-server-migration.md) | [Schema Migration](schema-migration.md) | [Migration Playbook](../mysql-to-azure.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
