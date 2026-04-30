# Tutorial: Assess and Migrate with Azure Data Studio

**Duration:** 1-2 hours
**Prerequisites:** Azure Data Studio, on-premises SQL Server, Azure subscription
**Targets:** Azure SQL Database, Azure SQL Managed Instance, or SQL Server on Azure VM
**Migration type:** Assessment and offline/online migration

---

## What you will accomplish

In this tutorial, you will:

1. Install Azure Data Studio and the Azure SQL Migration extension
2. Connect to your on-premises SQL Server
3. Run a compatibility assessment for all three Azure SQL targets
4. Review SKU recommendations based on workload performance data
5. Generate a migration readiness report
6. Execute a migration to your chosen target

---

## Prerequisites

- [ ] On-premises SQL Server 2008 or later
- [ ] Azure subscription with Contributor access
- [ ] Azure Data Studio (latest version)
- [ ] Network connectivity between your workstation and the SQL Server instance
- [ ] An Azure SQL target provisioned (or willingness to provision one during the tutorial)

---

## Step 1: Install Azure Data Studio

### Download and install

Download Azure Data Studio from [https://learn.microsoft.com/azure-data-studio/download](https://learn.microsoft.com/azure-data-studio/download-azure-data-studio) for your platform (Windows, macOS, or Linux).

### Install the Azure SQL Migration extension

1. Open Azure Data Studio
2. Click the **Extensions** icon in the left sidebar (or press `Ctrl+Shift+X`)
3. Search for **Azure SQL Migration**
4. Click **Install**
5. Restart Azure Data Studio if prompted

!!! info "Extension version"
The Azure SQL Migration extension is actively developed. Ensure you have the latest version for the most accurate assessment and migration capabilities.

---

## Step 2: Connect to on-premises SQL Server

1. Click **New Connection** in Azure Data Studio
2. Enter your on-premises SQL Server connection details:
    - **Server:** `your-server-name` or `your-server-name\instance`
    - **Authentication:** Windows Authentication or SQL Login
    - **Database:** Leave blank to connect to the instance
3. Click **Connect**

---

## Step 3: Run assessment

### Start the migration wizard

1. Right-click the server connection in the **Connections** panel
2. Select **Manage**
3. In the management dashboard, find the **Azure SQL Migration** section
4. Click **Assess and Migrate**

### Select databases

1. The wizard displays all databases on the instance
2. Select the databases you want to assess (you can select multiple)
3. Click **Next**

### Select target platform

1. Choose your target:
    - **Azure SQL Database** -- for fully managed, database-level PaaS
    - **Azure SQL Managed Instance** -- for instance-level PaaS with near-100% compatibility
    - **SQL Server on Azure Virtual Machine** -- for full IaaS control
2. You can assess for multiple targets simultaneously
3. Click **Next** to start the assessment

### Review assessment results

The assessment report shows:

#### Assessment summary

- **Ready:** Databases with no blocking issues for the selected target
- **Ready with conditions:** Databases with minor issues that can be resolved
- **Not ready:** Databases with blocking issues requiring remediation

#### Issue details

For each database, the assessment lists:

| Issue severity  | Description                                         |
| --------------- | --------------------------------------------------- |
| **Error**       | Blocking issues that prevent migration              |
| **Warning**     | Non-blocking issues that may affect functionality   |
| **Information** | Feature parity differences (no impact on migration) |

#### Common issues and resolutions

| Issue                     | Target affected | Resolution                                 |
| ------------------------- | --------------- | ------------------------------------------ |
| Cross-database references | SQL DB          | Consolidate databases or use elastic query |
| CLR assemblies (UNSAFE)   | SQL DB, SQL MI  | Rewrite in T-SQL or convert to SAFE        |
| Linked servers            | SQL DB          | Use ADF or REST endpoints                  |
| FILESTREAM usage          | SQL DB, SQL MI  | Migrate files to Azure Blob Storage        |
| SQL Agent jobs            | SQL DB          | Convert to Elastic Jobs or ADF             |
| Windows authentication    | SQL DB          | Switch to Entra ID                         |
| Service Broker            | SQL DB          | Use Azure Service Bus                      |
| Database mail             | SQL DB          | Use Logic Apps or Azure Functions          |

---

## Step 4: Get SKU recommendations

### Collect performance data

The extension can collect performance data to recommend the right Azure SQL SKU:

1. In the assessment wizard, click **Get Azure recommendation**
2. Choose data collection method:
    - **Collect performance data now:** Runs a lightweight data collector on the source instance
    - **Import existing data:** Use previously collected performance data
3. For real-time collection, set the collection duration (recommended: 24+ hours for production workloads, 10 minutes minimum for this tutorial)
4. Click **Start**

### Review recommendations

After data collection, the extension recommends:

- **Target type:** SQL DB, SQL MI, or SQL on VM
- **Service tier:** General Purpose, Business Critical, or Hyperscale
- **Compute size:** vCores or DTUs based on CPU utilization
- **Storage size:** Based on current database size plus growth projections
- **Estimated monthly cost:** Including Azure Hybrid Benefit if applicable

```
Example recommendation output:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Database: AdventureWorks
Recommended target: Azure SQL Managed Instance
Service tier: General Purpose
Compute: 8 vCores (Gen5)
Storage: 256 GB
Estimated cost: $1,200/month (with AHB)
Confidence: High (based on 24h perf data)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

!!! tip "Collect data during peak hours"
For accurate SKU recommendations, collect performance data during representative workload periods including peak hours, batch jobs, and month-end processing.

---

## Step 5: Execute migration

### Configure target

1. Click **Migrate** on a database that passed assessment
2. Sign in to your Azure account
3. Select your target Azure SQL resource:
    - For SQL DB: Select the server and database
    - For SQL MI: Select the managed instance
    - For SQL on VM: Select the virtual machine
4. Enter target credentials

### Select migration mode

| Mode        | Downtime | Use when                                           |
| ----------- | -------- | -------------------------------------------------- |
| **Online**  | Minutes  | Production databases requiring minimal downtime    |
| **Offline** | Hours    | Dev/test or when a maintenance window is available |

### Configure data source

For online migration to SQL MI:

1. Select **Azure Blob Storage** as the backup location
2. Enter the storage account details and SAS token
3. The extension will guide you through backup configuration

For offline migration:

1. Select the migration method (BACPAC, backup/restore, or DMS)
2. Configure the source connection

### Start migration

1. Review the migration summary
2. Click **Start Migration**
3. Monitor progress in the Azure SQL Migration dashboard

---

## Step 6: Monitor and complete

### Monitor in Azure Data Studio

The Azure SQL Migration extension shows:

- **Migration status:** InProgress, ReadyForCutover, Succeeded, Failed
- **Backup restore progress:** Percentage of backups restored
- **Log shipping lag:** For online migrations, time lag between source and target
- **Pending log backups:** Number of log files waiting to be applied

### Complete cutover (online migration)

When the migration status shows **ReadyForCutover:**

1. Stop application writes to the source database
2. Wait for replication lag to reach zero
3. Click **Complete Cutover** in the migration dashboard
4. Update application connection strings
5. Verify application functionality

---

## Step 7: Validate migration

### Schema validation

```sql
-- On target: Compare object counts with source
SELECT type_desc, COUNT(*) AS cnt
FROM sys.objects
WHERE is_ms_shipped = 0
GROUP BY type_desc
ORDER BY type_desc;
```

### Data validation

```sql
-- Compare row counts for key tables
SELECT
    SCHEMA_NAME(t.schema_id) + '.' + t.name AS table_name,
    SUM(p.rows) AS row_count
FROM sys.tables t
JOIN sys.partitions p ON t.object_id = p.object_id
WHERE p.index_id IN (0, 1)
GROUP BY SCHEMA_NAME(t.schema_id), t.name
ORDER BY table_name;
```

### Application validation

1. Update connection strings in your application configuration
2. Run smoke tests against the migrated database
3. Monitor for errors in application logs
4. Compare query performance with baseline measurements

---

## Step 8: Export assessment report

Generate a report for stakeholders:

1. In the assessment results, click **Export Report**
2. Choose format: JSON or CSV
3. The report includes:
    - Database inventory
    - Compatibility assessment per target
    - Feature parity gaps
    - SKU recommendations
    - Estimated costs

---

## Troubleshooting

| Issue                                      | Resolution                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| Extension not showing in Azure Data Studio | Update Azure Data Studio to latest version and reinstall the extension        |
| Assessment shows no databases              | Check SQL Server connectivity and permissions (sysadmin or db_owner required) |
| Performance data collection fails          | Ensure the user has VIEW SERVER STATE permission                              |
| SKU recommendation shows "Low confidence"  | Collect performance data for a longer period (24+ hours recommended)          |
| Migration fails with permission error      | Ensure the Azure account has Contributor role on the target resource          |
| Online migration not available             | Online migration requires Premium DMS tier for SQL MI                         |

---

## Related

- [Schema Migration](schema-migration.md)
- [Data Migration](data-migration.md)
- [Tutorial: DMS Migration](tutorial-dms-migration.md)
- [Azure SQL DB Migration](azure-sql-db-migration.md)
- [Azure SQL MI Migration](azure-sql-mi-migration.md)
- [Best Practices](best-practices.md)

---

## References

- [Azure SQL Migration extension](https://learn.microsoft.com/azure-data-studio/extensions/azure-sql-migration-extension)
- [Azure Data Studio download](https://learn.microsoft.com/azure-data-studio/download-azure-data-studio)
- [SKU recommendations](https://learn.microsoft.com/azure/dms/ads-sku-recommend)
- [Assessment rules for SQL Database](https://learn.microsoft.com/azure/azure-sql/migration-guides/database/sql-server-to-sql-database-assessment-rules)
- [Assessment rules for SQL MI](https://learn.microsoft.com/azure/azure-sql/migration-guides/managed-instance/sql-server-to-sql-managed-instance-assessment-rules)
