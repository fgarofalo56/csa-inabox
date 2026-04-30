# Complete Feature Mapping -- SQL Server to Azure SQL

**60+ SQL Server features mapped across Azure SQL Database, Azure SQL Managed Instance, and SQL Server on Azure VMs.**

---

## How to read this mapping

Each feature is rated for availability in each Azure SQL target:

- **Full** -- Feature is fully supported, functionally equivalent to on-premises
- **Partial** -- Feature is supported with limitations (noted in the migration guidance column)
- **Alternative** -- Feature is not available but a cloud-native alternative exists
- **Not available** -- Feature is not supported and no direct alternative exists in this target

---

## Database engine features

| #   | SQL Server feature         | Azure SQL Database        | Azure SQL Managed Instance | SQL Server on VM | Migration guidance                                        |
| --- | -------------------------- | ------------------------- | -------------------------- | ---------------- | --------------------------------------------------------- |
| 1   | **T-SQL language**         | Full (~95%)               | Full (~99%)                | Full (100%)      | Minor syntax differences in SQL DB; check with DMA        |
| 2   | **Stored procedures**      | Full                      | Full                       | Full             | Direct migration for all targets                          |
| 3   | **User-defined functions** | Full                      | Full                       | Full             | CLR UDFs require MI or VM (see CLR row)                   |
| 4   | **Triggers (DML/DDL)**     | Full (DML); Partial (DDL) | Full                       | Full             | SQL DB does not support server-scoped DDL triggers        |
| 5   | **Views**                  | Full                      | Full                       | Full             | Indexed views supported in all targets                    |
| 6   | **Indexes**                | Full                      | Full                       | Full             | Columnstore, spatial, full-text all supported             |
| 7   | **Partitioning**           | Full                      | Full                       | Full             | Table and index partitioning supported                    |
| 8   | **Temporary tables**       | Full                      | Full                       | Full             | Global temp tables have scoping differences in SQL DB     |
| 9   | **Cursors**                | Full                      | Full                       | Full             | Supported but consider set-based alternatives             |
| 10  | **JSON support**           | Full                      | Full                       | Full             | Enhanced JSON functions available in latest compat levels |
| 11  | **XML support**            | Full                      | Full                       | Full             | Including XQuery, XML indexes, FOR XML                    |
| 12  | **Spatial data types**     | Full                      | Full                       | Full             | Geometry and geography types supported                    |
| 13  | **Graph tables**           | Full                      | Full                       | Full             | NODE and EDGE tables with MATCH queries                   |
| 14  | **Sequences**              | Full                      | Full                       | Full             | Direct migration                                          |
| 15  | **Synonyms**               | Full                      | Full                       | Full             | Cross-database synonyms require MI or VM                  |

---

## Security features

| #   | SQL Server feature                    | Azure SQL Database        | Azure SQL Managed Instance | SQL Server on VM | Migration guidance                                                     |
| --- | ------------------------------------- | ------------------------- | -------------------------- | ---------------- | ---------------------------------------------------------------------- |
| 16  | **SQL authentication**                | Full                      | Full                       | Full             | Supported but Entra ID recommended                                     |
| 17  | **Windows authentication**            | Alternative (Entra ID)    | Partial (Entra + Kerberos) | Full             | SQL DB uses Entra ID; MI supports Kerberos for Windows auth            |
| 18  | **Entra ID (Azure AD) auth**          | Full                      | Full                       | Partial          | SQL DB and MI have native Entra; VM requires configuration             |
| 19  | **Transparent Data Encryption (TDE)** | Full (always on)          | Full (always on)           | Full             | TDE is mandatory in SQL DB and MI; certificate migration needed for VM |
| 20  | **Always Encrypted**                  | Full                      | Full                       | Full             | Column master key should migrate to Azure Key Vault                    |
| 21  | **Always Encrypted with enclaves**    | Full                      | Partial                    | Full             | SQL DB has full enclave support; MI support is evolving                |
| 22  | **Row-Level Security (RLS)**          | Full                      | Full                       | Full             | Direct migration; integrates with Entra ID in cloud                    |
| 23  | **Dynamic Data Masking**              | Full                      | Full                       | Full             | Direct migration; same T-SQL syntax                                    |
| 24  | **Column-level encryption**           | Full                      | Full                       | Full             | Direct migration                                                       |
| 25  | **Database audit**                    | Full (Azure Audit)        | Full (Azure Audit)         | Full (SQL Audit) | SQL DB/MI use Azure-native auditing to storage/Log Analytics           |
| 26  | **Server audit**                      | Not available             | Full                       | Full             | SQL DB has database-level audit only                                   |
| 27  | **Contained database users**          | Full                      | Full                       | Full             | Recommended pattern for SQL DB                                         |
| 28  | **Certificate-based auth**            | Partial                   | Full                       | Full             | SQL DB has limited certificate support                                 |
| 29  | **Extensible Key Management (EKM)**   | Alternative (Key Vault)   | Alternative (Key Vault)    | Full + Key Vault | Migrate EKM providers to Azure Key Vault                               |
| 30  | **SQL Server Audit**                  | Alternative (Azure Audit) | Full                       | Full             | MI preserves SQL Audit; SQL DB uses Azure-native auditing              |

---

## High availability and disaster recovery

| #   | SQL Server feature                  | Azure SQL Database            | Azure SQL Managed Instance    | SQL Server on VM               | Migration guidance                                      |
| --- | ----------------------------------- | ----------------------------- | ----------------------------- | ------------------------------ | ------------------------------------------------------- |
| 31  | **Always On Availability Groups**   | Alternative (built-in HA)     | Alternative (built-in HA)     | Full                           | SQL DB/MI have built-in HA; VM supports full AG         |
| 32  | **Failover Cluster Instance (FCI)** | Not available                 | Not available                 | Full (with Azure Shared Disks) | Only supported on VM with Azure Shared Disks or S2D     |
| 33  | **Log shipping**                    | Not available                 | Not available                 | Full                           | Use DMS or geo-replication instead                      |
| 34  | **Database mirroring**              | Alternative (geo-replication) | Alternative (failover groups) | Full (deprecated)              | Migrate to geo-replication or failover groups           |
| 35  | **Auto-failover groups**            | Full                          | Full                          | Not available (use AG)         | Cloud-native HA with single connection endpoint         |
| 36  | **Geo-replication**                 | Full                          | Full (via failover groups)    | Manual (AG across regions)     | Asynchronous replication to any Azure region            |
| 37  | **Point-in-time restore (PITR)**    | Full (1-35 days)              | Full (1-35 days)              | Manual (backup/restore)        | Automatic in SQL DB/MI; manual on VM                    |
| 38  | **Long-term retention (LTR)**       | Full (up to 10 years)         | Full (up to 10 years)         | Manual (Azure Backup)          | Automated in SQL DB/MI                                  |
| 39  | **Backup to URL (Azure Blob)**      | Automatic                     | Automatic                     | Full                           | VM uses backup-to-URL; SQL DB/MI handle automatically   |
| 40  | **Managed Instance Link**           | Not applicable                | Full                          | Not applicable                 | Live link from on-prem AG to MI for migration or hybrid |

---

## Performance features

| #   | SQL Server feature                 | Azure SQL Database          | Azure SQL Managed Instance  | SQL Server on VM         | Migration guidance                                        |
| --- | ---------------------------------- | --------------------------- | --------------------------- | ------------------------ | --------------------------------------------------------- |
| 41  | **In-Memory OLTP**                 | Full (Premium/BC/HS)        | Full                        | Full                     | Available in Business Critical and Hyperscale tiers       |
| 42  | **Columnstore indexes**            | Full                        | Full                        | Full                     | Direct migration; all tiers support columnstore           |
| 43  | **Query Store**                    | Full (enabled by default)   | Full (enabled by default)   | Full                     | Automatically enabled in SQL DB and MI                    |
| 44  | **Intelligent Query Processing**   | Full (latest features)      | Full (latest features)      | Full (version-dependent) | SQL DB/MI get IQP improvements first                      |
| 45  | **Automatic tuning**               | Full                        | Full                        | Not available            | Force plan, create index, drop index (SQL DB/MI only)     |
| 46  | **Resource Governor**              | Alternative (service tiers) | Full                        | Full                     | SQL DB uses service tier limits; MI has Resource Governor |
| 47  | **Database Engine Tuning Advisor** | Alternative (Azure Advisor) | Alternative (Azure Advisor) | Full                     | Use Azure Advisor and Query Performance Insight           |
| 48  | **Buffer pool extension**          | Not applicable              | Not applicable              | Full                     | SQL DB/MI manage memory automatically                     |
| 49  | **Batch mode on rowstore**         | Full                        | Full                        | Full (2019+)             | Available at compat level 150+                            |
| 50  | **Adaptive joins**                 | Full                        | Full                        | Full (2017+)             | Available at compat level 140+                            |

---

## Integration and ETL features

| #   | SQL Server feature                         | Azure SQL Database                 | Azure SQL Managed Instance         | SQL Server on VM | Migration guidance                                               |
| --- | ------------------------------------------ | ---------------------------------- | ---------------------------------- | ---------------- | ---------------------------------------------------------------- |
| 51  | **SQL Server Integration Services (SSIS)** | Alternative (Azure-SSIS IR in ADF) | Alternative (Azure-SSIS IR in ADF) | Full             | Lift-and-shift SSIS to Azure-SSIS IR; modernize to ADF/dbt       |
| 52  | **SQL Server Agent**                       | Alternative (Elastic Jobs)         | Full                               | Full             | MI preserves Agent jobs; SQL DB uses Elastic Jobs or ADF         |
| 53  | **Linked servers**                         | Not available                      | Full                               | Full             | MI supports linked servers; SQL DB requires alternative patterns |
| 54  | **Distributed transactions (MSDTC)**       | Partial (elastic transactions)     | Full (preview)                     | Full             | SQL DB has limited elastic transactions; MI adds MSDTC           |
| 55  | **Cross-database queries**                 | Partial (elastic query)            | Full                               | Full             | MI supports native cross-DB; SQL DB needs elastic query          |
| 56  | **Change Data Capture (CDC)**              | Full                               | Full                               | Full             | Direct migration; CDC works in SQL DB and MI                     |
| 57  | **Change tracking**                        | Full                               | Full                               | Full             | Direct migration                                                 |
| 58  | **Transactional replication**              | Full (subscriber)                  | Full (publisher + subscriber)      | Full             | SQL DB can be subscriber; MI can publish                         |
| 59  | **Merge replication**                      | Not available                      | Not available                      | Full             | Only supported on VM; consider alternatives                      |
| 60  | **Service Broker**                         | Not available                      | Partial (within instance)          | Full             | MI supports within-instance messaging; no cross-instance         |

---

## Reporting and analytics features

| #   | SQL Server feature                       | Azure SQL Database              | Azure SQL Managed Instance      | SQL Server on VM   | Migration guidance                                           |
| --- | ---------------------------------------- | ------------------------------- | ------------------------------- | ------------------ | ------------------------------------------------------------ |
| 61  | **SQL Server Reporting Services (SSRS)** | Alternative (Power BI)          | Alternative (Power BI)          | Full               | Migrate RDL reports to Power BI paginated reports            |
| 62  | **SQL Server Analysis Services (SSAS)**  | Alternative (Azure AS / Fabric) | Alternative (Azure AS / Fabric) | Full               | Migrate tabular models to Azure AS or Fabric semantic models |
| 63  | **Full-text search**                     | Full                            | Full                            | Full               | Direct migration; same T-SQL syntax                          |
| 64  | **Semantic search**                      | Not available                   | Not available                   | Full               | Only available on VM; consider Azure AI Search               |
| 65  | **PolyBase**                             | Not available                   | Not available                   | Full               | Use external tables or ADF for external data access          |
| 66  | **R/Python/Java extensibility**          | Not available                   | Not available                   | Full (ML Services) | Use Azure ML or Fabric notebooks for in-database ML          |
| 67  | **Data Quality Services (DQS)**          | Not available                   | Not available                   | Full               | Migrate to Azure Purview data quality or third-party tools   |

---

## Storage and data features

| #   | SQL Server feature                     | Azure SQL Database | Azure SQL Managed Instance | SQL Server on VM | Migration guidance                                          |
| --- | -------------------------------------- | ------------------ | -------------------------- | ---------------- | ----------------------------------------------------------- |
| 68  | **Filestream**                         | Not available      | Not available              | Full             | Migrate files to Azure Blob Storage; store URLs in database |
| 69  | **FileTable**                          | Not available      | Not available              | Full             | Migrate to Azure Blob + metadata tables                     |
| 70  | **Temporal tables (system-versioned)** | Full               | Full                       | Full             | Direct migration                                            |
| 71  | **Ledger tables**                      | Full               | Not available              | Full (2022+)     | Available in SQL DB; coming to MI                           |
| 72  | **Stretch Database**                   | Not available      | Not available              | Deprecated       | Migrate cold data to Azure Blob or OneLake                  |
| 73  | **Data compression**                   | Full               | Full                       | Full             | Row and page compression supported                          |
| 74  | **Sparse columns**                     | Full               | Full                       | Full             | Direct migration                                            |
| 75  | **Computed columns**                   | Full               | Full                       | Full             | Direct migration                                            |
| 76  | **User-defined types (T-SQL)**         | Full               | Full                       | Full             | Direct migration                                            |

---

## Programmability features

| #   | SQL Server feature                      | Azure SQL Database | Azure SQL Managed Instance | SQL Server on VM | Migration guidance                                                      |
| --- | --------------------------------------- | ------------------ | -------------------------- | ---------------- | ----------------------------------------------------------------------- |
| 77  | **CLR integration**                     | Not available      | Partial (SAFE assemblies)  | Full             | MI supports SAFE CLR; VM supports all permission sets                   |
| 78  | **Native compilation (In-Memory)**      | Full (Premium/BC)  | Full                       | Full             | Natively compiled stored procedures supported                           |
| 79  | **Extended stored procedures**          | Not available      | Not available              | Deprecated       | Migrate to CLR or external processes                                    |
| 80  | **Database mail**                       | Not available      | Full                       | Full             | MI supports Database Mail; SQL DB use Logic Apps/Functions              |
| 81  | **SQL Server Service Broker**           | Not available      | Partial                    | Full             | MI supports within-instance only                                        |
| 82  | **Event notifications**                 | Not available      | Partial                    | Full             | Use Azure Event Grid for event-driven patterns                          |
| 83  | **Policy-Based Management**             | Not available      | Not available              | Full             | Use Azure Policy and Defender for SQL                                   |
| 84  | **Data-tier applications (DACPAC)**     | Full               | Full                       | Full             | DACPACs work for schema deployment in all targets                       |
| 85  | **SQL Server Management Objects (SMO)** | Partial            | Full                       | Full             | Most SMO operations work; some server-level ops not available in SQL DB |

---

## Management and monitoring features

| #   | SQL Server feature                      | Azure SQL Database              | Azure SQL Managed Instance  | SQL Server on VM     | Migration guidance                                         |
| --- | --------------------------------------- | ------------------------------- | --------------------------- | -------------------- | ---------------------------------------------------------- |
| 86  | **SQL Server Management Studio (SSMS)** | Full                            | Full                        | Full                 | SSMS connects to all Azure SQL targets                     |
| 87  | **Azure Data Studio**                   | Full                            | Full                        | Full                 | Cross-platform management with SQL Migration extension     |
| 88  | **Dynamic Management Views (DMVs)**     | Full (subset)                   | Full                        | Full                 | SQL DB has database-scoped DMVs only                       |
| 89  | **Extended Events**                     | Full                            | Full                        | Full                 | SQL DB uses database-scoped XEvents                        |
| 90  | **SQL Profiler**                        | Deprecated (use XEvents)        | Deprecated (use XEvents)    | Full (deprecated)    | Migrate to Extended Events or Azure Monitor                |
| 91  | **Performance Monitor**                 | Alternative (Azure Monitor)     | Alternative (Azure Monitor) | Full + Azure Monitor | Use Azure Monitor metrics and Log Analytics                |
| 92  | **Maintenance plans**                   | Alternative (automatic)         | Partial                     | Full                 | SQL DB handles maintenance automatically; MI has some auto |
| 93  | **SQL Server error log**                | Alternative (Azure diagnostics) | Full                        | Full                 | MI preserves error log; SQL DB uses Azure diagnostics      |

---

## Feature availability summary

| Category            | Azure SQL DB | Azure SQL MI | SQL on VM    |
| ------------------- | ------------ | ------------ | ------------ |
| Core T-SQL          | 88/93 (95%)  | 90/93 (97%)  | 93/93 (100%) |
| Security            | 13/15        | 15/15        | 15/15        |
| HA/DR               | 7/10         | 8/10         | 10/10        |
| Performance         | 9/10         | 10/10        | 10/10        |
| Integration/ETL     | 7/10         | 9/10         | 10/10        |
| Reporting/Analytics | 3/7          | 3/7          | 7/7          |
| Storage/Data        | 7/9          | 7/9          | 9/9          |
| Programmability     | 4/9          | 7/9          | 9/9          |
| Management          | 6/8          | 8/8          | 8/8          |

---

## Common migration blockers and solutions

### CLR assemblies

**Problem:** Application uses CLR stored procedures or functions with EXTERNAL_ACCESS or UNSAFE permission sets.

**Solution by target:**

- **Azure SQL DB:** Not supported. Rewrite CLR logic in T-SQL, or move to Azure Functions called via `sp_invoke_external_rest_endpoint`.
- **Azure SQL MI:** SAFE assemblies supported. UNSAFE/EXTERNAL_ACCESS blocked by default. Some can be converted to SAFE.
- **SQL on VM:** Full support. Direct migration.

### Cross-database queries

**Problem:** Application queries across multiple databases on the same instance.

**Solution by target:**

- **Azure SQL DB:** Use elastic queries (limited performance). Better: consolidate databases or use application-level joins.
- **Azure SQL MI:** Full cross-database query support. Direct migration.
- **SQL on VM:** Full support. Direct migration.

### SQL Agent jobs

**Problem:** Dozens or hundreds of SQL Agent jobs for maintenance, ETL, and business logic.

**Solution by target:**

- **Azure SQL DB:** Migrate to Elastic Jobs, Azure Automation, or ADF pipeline triggers.
- **Azure SQL MI:** Full SQL Agent support. Direct migration.
- **SQL on VM:** Full support. Direct migration.

### Linked servers

**Problem:** Application uses linked servers to query other SQL instances, Oracle, or other data sources.

**Solution by target:**

- **Azure SQL DB:** Not supported. Use ADF or `sp_invoke_external_rest_endpoint` for external data access.
- **Azure SQL MI:** Full linked server support including OLEDB providers.
- **SQL on VM:** Full support. Direct migration.

### SSIS packages

**Problem:** Complex SSIS packages for ETL/ELT workloads.

**Solution by target:**

- **Azure SQL DB / MI:** Deploy Azure-SSIS Integration Runtime in ADF. Packages run unchanged. Alternatively, modernize to ADF pipelines with dbt (CSA-in-a-Box pattern).
- **SQL on VM:** Full SSIS support. Direct migration.

### Service Broker

**Problem:** Application uses Service Broker for asynchronous messaging.

**Solution by target:**

- **Azure SQL DB:** Not supported. Migrate to Azure Service Bus or Event Grid.
- **Azure SQL MI:** Within-instance Service Broker supported. Cross-instance not available.
- **SQL on VM:** Full support. Direct migration.

### Distributed transactions (MSDTC)

**Problem:** Application uses distributed transactions across multiple databases or services.

**Solution by target:**

- **Azure SQL DB:** Limited elastic transactions for cross-database scenarios within the same server.
- **Azure SQL MI:** Distributed transactions support (preview). Requires VNet peering between instances.
- **SQL on VM:** Full MSDTC support. Direct migration.

### Database Mail

**Problem:** Stored procedures and jobs send email notifications via Database Mail.

**Solution by target:**

- **Azure SQL DB:** Not supported. Use Azure Logic Apps, Azure Functions, or Azure Communication Services to send emails triggered by database events.
- **Azure SQL MI:** Full Database Mail support. Configure SMTP relay settings after migration.
- **SQL on VM:** Full support. Direct migration.

### SSRS reports

**Problem:** Organization has hundreds of SSRS reports deployed on-premises.

**Solution by target:**

- **Azure SQL DB / MI:** SSRS is not available as a managed service. Options:
    - Migrate RDL reports to **Power BI paginated reports** (recommended for cloud-native)
    - Deploy SSRS on a separate Azure VM
    - Use the **Power BI Report Builder** to recreate reports
- **SQL on VM:** Full SSRS support. Install SSRS on the same or separate VM.

### SSAS tabular/multidimensional models

**Problem:** SSAS cubes provide analytical capabilities for business users.

**Solution by target:**

- **Azure SQL DB / MI:** SSAS is not available. Options:
    - Migrate tabular models to **Azure Analysis Services** (supported in Gov regions)
    - Migrate to **Microsoft Fabric semantic models** with Direct Lake (CSA-in-a-Box recommended path)
    - Multidimensional models require SSAS on Azure VM or refactoring to tabular
- **SQL on VM:** Full SSAS support for both tabular and multidimensional.

### Filestream and FileTable

**Problem:** Database stores large binary files (documents, images) using FILESTREAM or FileTable.

**Solution by target:**

- **Azure SQL DB:** Not supported. Migrate files to **Azure Blob Storage** and store Blob URLs in the database. Use Azure Functions or application logic for file operations.
- **Azure SQL MI:** Not supported. Same remediation as SQL DB.
- **SQL on VM:** Full support. Direct migration.

```sql
-- Migration pattern: FILESTREAM to Azure Blob Storage
-- 1. Export files from FILESTREAM
-- 2. Upload to Azure Blob Storage
-- 3. Update table to store Blob URLs instead of FILESTREAM data

-- Before (FILESTREAM):
-- CREATE TABLE Documents (
--     DocId UNIQUEIDENTIFIER ROWGUIDCOL NOT NULL,
--     DocContent VARBINARY(MAX) FILESTREAM
-- );

-- After (Azure Blob Storage reference):
CREATE TABLE Documents (
    DocId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    DocBlobUrl NVARCHAR(500) NOT NULL,
    DocContentType NVARCHAR(100),
    DocSizeBytes BIGINT
);
```

---

## Migration complexity by feature combination

Common on-premises configurations and their migration complexity:

| Configuration                               | Recommended target            | Complexity       | Typical effort |
| ------------------------------------------- | ----------------------------- | ---------------- | -------------- |
| Single DB, T-SQL only, SQL auth             | Azure SQL Database            | Low              | 1-2 days       |
| Single DB with Always Encrypted             | Azure SQL Database            | Low-Medium       | 2-3 days       |
| Multiple DBs with cross-DB queries          | Azure SQL MI                  | Low              | 3-5 days       |
| Multiple DBs + SQL Agent + linked servers   | Azure SQL MI                  | Medium           | 1-2 weeks      |
| SQL Server + SSIS + SSRS                    | Azure SQL MI + ADF + Power BI | Medium-High      | 2-4 weeks      |
| SQL Server + CLR (UNSAFE) + FILESTREAM      | SQL Server on VM              | Low              | 1-3 days       |
| SQL Server + SSAS + SSRS + SSIS             | SQL Server on VM              | Low (lift-shift) | 3-5 days       |
| Distributed transactions + Service Broker   | SQL Server on VM              | Low              | 1-3 days       |
| Large estate (50+ databases mixed features) | Mixed targets                 | High             | 3-6 months     |

---

## Automation: Feature detection queries

Use these queries to automatically detect which features your databases use, helping classify each database to the right target:

```sql
-- Comprehensive feature usage detection
DECLARE @Features TABLE (Feature NVARCHAR(100), IsUsed BIT, Detail NVARCHAR(500));

-- CLR
INSERT @Features
SELECT 'CLR Assemblies', CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END,
       STRING_AGG(name + ' (' + permission_set_desc + ')', ', ')
FROM sys.assemblies WHERE is_user_defined = 1;

-- Service Broker
INSERT @Features
SELECT 'Service Broker', is_broker_enabled, name
FROM sys.databases WHERE database_id = DB_ID();

-- Change Data Capture
INSERT @Features
SELECT 'CDC', is_cdc_enabled, name
FROM sys.databases WHERE database_id = DB_ID();

-- In-Memory OLTP
INSERT @Features
SELECT 'In-Memory OLTP',
       CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END,
       CAST(COUNT(*) AS NVARCHAR) + ' memory-optimized tables'
FROM sys.tables WHERE is_memory_optimized = 1;

-- Temporal tables
INSERT @Features
SELECT 'Temporal Tables',
       CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END,
       CAST(COUNT(*) AS NVARCHAR) + ' temporal tables'
FROM sys.tables WHERE temporal_type = 2;

-- Columnstore indexes
INSERT @Features
SELECT 'Columnstore Indexes',
       CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END,
       CAST(COUNT(*) AS NVARCHAR) + ' columnstore indexes'
FROM sys.indexes WHERE type IN (5, 6);

-- Full-text search
INSERT @Features
SELECT 'Full-Text Search',
       CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END,
       CAST(COUNT(*) AS NVARCHAR) + ' full-text indexes'
FROM sys.fulltext_indexes;

-- TDE
INSERT @Features
SELECT 'TDE', is_encrypted, name
FROM sys.databases WHERE database_id = DB_ID();

-- Always Encrypted
INSERT @Features
SELECT 'Always Encrypted',
       CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END,
       CAST(COUNT(*) AS NVARCHAR) + ' encrypted columns'
FROM sys.columns WHERE encryption_type IS NOT NULL;

SELECT Feature, CASE WHEN IsUsed = 1 THEN 'YES' ELSE 'NO' END AS InUse, Detail
FROM @Features
ORDER BY IsUsed DESC, Feature;
```

---

## Related

- [Schema Migration](schema-migration.md)
- [Azure SQL DB Migration](azure-sql-db-migration.md)
- [Azure SQL MI Migration](azure-sql-mi-migration.md)
- [SQL on VM Migration](sql-on-vm-migration.md)
- [Migration Playbook](../sql-server-to-azure.md)

---

## References

- [Azure SQL Database features](https://learn.microsoft.com/azure/azure-sql/database/features-comparison)
- [Azure SQL MI T-SQL differences](https://learn.microsoft.com/azure/azure-sql/managed-instance/transact-sql-tsql-differences-sql-server)
- [SQL Server on Azure VM feature support](https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/sql-server-on-azure-vm-iaas-what-is-overview)
- [Data Migration Assistant](https://learn.microsoft.com/sql/dma/)
