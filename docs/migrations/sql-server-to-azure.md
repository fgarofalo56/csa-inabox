# Migrating SQL Server On-Premises to Azure SQL

**Status:** Authored 2026-04-30
**Audience:** Database administrators, data engineers, cloud architects, and IT leadership
**Scope:** Full migration from on-premises SQL Server to Azure SQL Database, Azure SQL Managed Instance, or SQL Server on Azure VMs, with CSA-in-a-Box integration for analytics and governance.

---

!!! tip "Expanded Migration Center Available"
This playbook is the core migration reference. For the complete SQL Server-to-Azure migration package -- including target-specific guides, tutorials, benchmarks, and federal-specific guidance -- visit the **[SQL Server Migration Center](sql-server-to-azure/index.md)**.

    **Quick links:**

    - [Why Azure SQL (Executive Brief)](sql-server-to-azure/why-azure-sql.md)
    - [Total Cost of Ownership Analysis](sql-server-to-azure/tco-analysis.md)
    - [Complete Feature Mapping (60+ features)](sql-server-to-azure/feature-mapping-complete.md)
    - [Federal Migration Guide](sql-server-to-azure/federal-migration-guide.md)
    - [Tutorials & Walkthroughs](sql-server-to-azure/index.md#tutorials)
    - [Benchmarks & Performance](sql-server-to-azure/benchmarks.md)
    - [Best Practices](sql-server-to-azure/best-practices.md)

    **Migration guides by target:** [Azure SQL Database](sql-server-to-azure/azure-sql-db-migration.md) | [Azure SQL Managed Instance](sql-server-to-azure/azure-sql-mi-migration.md) | [SQL Server on VM](sql-server-to-azure/sql-on-vm-migration.md) | [Schema Migration](sql-server-to-azure/schema-migration.md) | [Data Migration](sql-server-to-azure/data-migration.md) | [Security](sql-server-to-azure/security-migration.md) | [HA/DR](sql-server-to-azure/ha-dr-migration.md)

---

## 1. Executive summary

SQL Server is the world's most widely deployed relational database engine, with millions of instances running on-premises across enterprises, government agencies, and defense organizations. Microsoft offers three Azure-native targets for SQL Server workloads, each optimized for different migration scenarios: **Azure SQL Database** (fully managed PaaS), **Azure SQL Managed Instance** (near-100% compatibility), and **SQL Server on Azure VMs** (full IaaS control).

CSA-in-a-Box serves as the analytics landing zone for migrated SQL data. Once databases move to Azure, CSA-in-a-Box connects them to Microsoft Fabric for lakehouse analytics, Microsoft Purview for governance and lineage, Power BI for reporting, and Azure AI for intelligent workloads. The migration is not just a database lift-and-shift -- it is the first step toward a modern, governed data platform.

This playbook is designed for organizations with SQL Server 2012 through 2022 on-premises, running a mix of OLTP, reporting, ETL, and analytics workloads. It addresses the most common migration blockers (CLR assemblies, cross-database queries, SQL Agent jobs, linked servers, SSIS packages) and provides honest guidance on which target fits each workload.

---

## 2. Decision matrix -- choose your Azure SQL target

| Criteria                   | Azure SQL Database                               | Azure SQL Managed Instance                  | SQL Server on Azure VM                            |
| -------------------------- | ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------- |
| **Best for**               | New cloud-native apps, single-database workloads | Lift-and-shift with near-100% compatibility | Full SQL Server feature set, third-party software |
| **Compatibility**          | ~95% T-SQL surface area                          | ~99% T-SQL surface area                     | 100% (same engine)                                |
| **Management overhead**    | Minimal (fully managed)                          | Low (managed instance)                      | Full (you manage the OS and SQL)                  |
| **Cross-database queries** | Elastic queries (limited)                        | Native cross-database queries               | Native cross-database queries                     |
| **SQL Agent**              | Not available (use Elastic Jobs)                 | Full SQL Agent                              | Full SQL Agent                                    |
| **CLR assemblies**         | Not supported                                    | Supported (SAFE only by default)            | Full CLR support                                  |
| **Linked servers**         | Not supported                                    | Supported                                   | Full support                                      |
| **SSIS**                   | Not available (use ADF)                          | Not native (use ADF or Azure-SSIS IR)       | Full SSIS support                                 |
| **SSRS**                   | Not available (use Power BI)                     | Not native (use Power BI or SSRS on VM)     | Full SSRS support                                 |
| **SSAS**                   | Not available (use Azure AS or Fabric)           | Not available (use Azure AS or Fabric)      | Full SSAS support                                 |
| **Service Broker**         | Not supported                                    | Supported (within instance)                 | Full support                                      |
| **Filestream/FileTable**   | Not supported                                    | Not supported                               | Full support                                      |
| **Max database size**      | 100 TB (Hyperscale)                              | 16 TB                                       | Storage limited                                   |
| **Pricing model**          | DTU or vCore                                     | vCore only                                  | VM + SQL license                                  |
| **Azure Hybrid Benefit**   | Yes                                              | Yes                                         | Yes                                               |
| **FedRAMP High**           | Yes (Gov regions)                                | Yes (Gov regions)                           | Yes (Gov regions)                                 |

---

## 3. Migration approach by workload type

### OLTP workloads (line-of-business applications)

For transactional workloads with moderate schema complexity, **Azure SQL Database** is the default target. It offers built-in high availability, automated backups, point-in-time restore, and elastic scaling. Applications require connection string changes and may need updates for unsupported features (cross-database queries, CLR). If the application uses many SQL Server-specific features, **Azure SQL Managed Instance** provides near-100% compatibility with minimal application changes.

### Data warehousing and analytics

SQL Server data warehouses should evaluate **Microsoft Fabric** (via CSA-in-a-Box) as the long-term analytics target. For databases that must remain in SQL Server format, **Azure SQL Managed Instance** or **SQL Server on Azure VM** can serve as intermediate targets while data is mirrored into the Fabric lakehouse through ADF or Fabric Data Factory pipelines.

### SSIS/ETL workloads

SSIS packages can run on the **Azure-SSIS Integration Runtime** within Azure Data Factory, providing a lift-and-shift path. For modernization, convert SSIS to ADF pipelines with dbt transformations (the CSA-in-a-Box default pattern).

### Reporting workloads (SSRS)

SSRS reports should migrate to **Power BI** for cloud-native reporting with Fabric Direct Lake integration. For paginated reports, Power BI Premium supports RDL rendering. If pixel-perfect SSRS compatibility is required, deploy SSRS on a SQL Server Azure VM.

### Mixed workloads with complex dependencies

When workloads depend on CLR, Service Broker, distributed transactions, linked servers, or third-party software installed on the SQL Server host, **SQL Server on Azure VM** provides the fastest migration path with zero compatibility issues.

---

## 4. Phased migration plan

### Phase 1: Assess (weeks 1-4)

1. Run **Azure Migrate** with the database assessment tool across all SQL Server instances
2. Run **Data Migration Assistant (DMA)** or the **Azure SQL Migration extension** in Azure Data Studio against each database
3. Inventory all databases by size, compatibility level, feature usage, and workload type
4. Map dependencies: applications, SSIS packages, linked servers, SQL Agent jobs, SSRS reports
5. Classify each database into a target: Azure SQL DB, SQL MI, or SQL on VM
6. Estimate costs using the [TCO Calculator](https://azure.microsoft.com/pricing/tco/calculator/)

### Phase 2: Prepare (weeks 5-8)

1. Deploy CSA-in-a-Box landing zone with networking, identity, and governance
2. Provision Azure SQL targets (databases, managed instances, or VMs)
3. Configure networking: VNet integration, private endpoints, ExpressRoute/VPN connectivity
4. Set up Azure Database Migration Service (DMS) instances
5. Remediate schema compatibility issues identified by DMA
6. Configure Entra ID authentication and migrate security principals

### Phase 3: Migrate (weeks 9-16)

Execute migration waves, starting with non-production environments:

1. **Wave 0 -- Dev/Test:** Validate migration tooling and runbooks
2. **Wave 1 -- Low-risk production:** Small databases, non-critical applications
3. **Wave 2 -- Medium-risk production:** Core LOB databases
4. **Wave 3 -- High-risk production:** Large databases, complex dependencies
5. **Wave 4 -- Analytics integration:** Connect migrated databases to CSA-in-a-Box

For each wave:

- Execute schema migration (DMA or Azure Data Studio extension)
- Execute data migration (DMS online mode for minimal downtime)
- Update application connection strings
- Validate application functionality
- Monitor performance for 48-72 hours
- Switch DNS/load balancer to Azure target
- Decommission on-premises source after validation window

### Phase 4: Optimize (weeks 17-20)

1. Enable Azure Hybrid Benefit and reserved instances for cost optimization
2. Configure Microsoft Defender for SQL
3. Set up Azure Monitor alerts and diagnostics
4. Connect Azure SQL to CSA-in-a-Box:
    - Register databases in Microsoft Purview for governance and lineage
    - Create ADF or Fabric Data Factory pipelines to mirror data to OneLake
    - Build dbt models for analytics on migrated data
    - Deploy Power BI reports with Direct Lake semantic models
5. Decommission on-premises SQL Server infrastructure

---

## 5. CSA-in-a-Box integration

Once SQL databases are running on Azure, CSA-in-a-Box unlocks the full analytics and governance stack:

| CSA-in-a-Box component | Integration with Azure SQL                                                  | Value                                                              |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Microsoft Purview**  | Auto-scan Azure SQL databases for classification, lineage, and data catalog | Governance and compliance visibility across all migrated databases |
| **Azure Data Factory** | Pipeline from Azure SQL to OneLake (Delta Lake)                             | Feed the medallion architecture (bronze/silver/gold)               |
| **dbt**                | Transform Azure SQL data in the lakehouse                                   | Governed, version-controlled analytics transformations             |
| **Microsoft Fabric**   | Direct Lake semantic models over OneLake                                    | Sub-second analytics without data duplication                      |
| **Power BI**           | Reports and dashboards connected to Fabric semantic models                  | Self-service BI for business users                                 |
| **Azure AI / OpenAI**  | AI enrichment on data flowing from Azure SQL through the lakehouse          | Intelligent workloads on migrated data                             |
| **Azure Monitor**      | Centralized monitoring of Azure SQL + platform health                       | Unified observability                                              |

---

## 6. End-of-support timeline

Migrating SQL Server is increasingly urgent as older versions lose support:

| SQL Server version | Mainstream support ended | Extended support ends | Extended Security Updates        |
| ------------------ | ------------------------ | --------------------- | -------------------------------- |
| SQL Server 2012    | 2017-07-11               | 2022-07-12            | ESU ended 2025-07-08             |
| SQL Server 2014    | 2019-07-09               | 2024-07-09            | ESU available through 2027-07-09 |
| SQL Server 2016    | 2021-07-13               | 2026-07-14            | ESU available through 2029-07-14 |
| SQL Server 2017    | 2022-10-11               | 2027-10-12            | ESU TBD                          |
| SQL Server 2019    | 2025-02-28               | 2030-01-08            | ESU TBD                          |
| SQL Server 2022    | 2028-01-11               | 2033-01-11            | N/A                              |

!!! warning "SQL Server 2016 extended support ends July 2026"
Organizations running SQL Server 2016 should prioritize migration planning. After July 2026, no security patches will be provided without purchasing Extended Security Updates. Migrating to Azure SQL automatically provides free ESU coverage for SQL Server on Azure VMs.

---

## 7. Quick-start commands

### Assess with Azure SQL Migration extension

```bash
# Install Azure Data Studio and the SQL Migration extension
# Then run assessment from the GUI, or use Azure CLI:

az datamigration sql-server-schema \
  --action MigrateSqlServerSchema \
  --src-sql-connection-str "Server=onprem-sql;Database=AdventureWorks;Trusted_Connection=True" \
  --tgt-sql-connection-str "Server=myserver.database.windows.net;Database=AdventureWorks;Authentication=Active Directory Default"
```

### Provision Azure SQL Database with Bicep

```bicep
resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlServerName
  location: location
  properties: {
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
  }
  identity: {
    type: 'SystemAssigned'
  }
}

resource sqlDatabase 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: databaseName
  location: location
  sku: {
    name: 'GP_Gen5'
    tier: 'GeneralPurpose'
    capacity: 4
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: 34359738368  // 32 GB
    zoneRedundant: true
  }
}
```

---

## 8. Related resources

- [SQL Server Migration Center (expanded)](sql-server-to-azure/index.md)
- [Azure SQL Guide](../guides/azure-sql.md)
- [SQL Server Integration Guide](../guides/sql-server-integration.md)
- [ADF Setup](../ADF_SETUP.md)
- [Microsoft Purview Guide](../guides/purview.md)
- [Power BI Guide](../guides/power-bi.md)
- [Federal Migration Guide](sql-server-to-azure/federal-migration-guide.md)

---

## 9. References

- [Azure SQL migration documentation](https://learn.microsoft.com/azure/azure-sql/migration-guides/)
- [Azure Database Migration Service](https://learn.microsoft.com/azure/dms/)
- [Data Migration Assistant](https://learn.microsoft.com/sql/dma/)
- [Azure SQL Migration extension for Azure Data Studio](https://learn.microsoft.com/azure-data-studio/extensions/azure-sql-migration-extension)
- [Azure Hybrid Benefit for SQL Server](https://learn.microsoft.com/azure/azure-sql/azure-hybrid-benefit)
- [SQL Server end-of-support options](https://learn.microsoft.com/sql/sql-server/end-of-support/sql-server-end-of-support-overview)
