# Best Practices -- SQL Server to Azure SQL Migration

**Audience:** DBAs, data engineers, migration architects, project managers
**Scope:** Assessment workflow, compatibility testing, migration waves, application testing, rollback planning, cost optimization, and CSA-in-a-Box integration

---

## Assessment best practices

### Assess everything before migrating anything

Run assessment tools across the entire SQL Server estate before committing to a migration plan. Discovery often reveals unknown instances, undocumented dependencies, and configuration details that affect target selection.

**Recommended assessment workflow:**

1. **Estate discovery:** Run Azure Migrate appliance for agentless discovery of all SQL Server instances
2. **Database assessment:** Run DMA or Azure Data Studio extension against every database
3. **Workload analysis:** Collect 24-72 hours of performance data for SKU recommendations
4. **Dependency mapping:** Document application-to-database, database-to-database, and SSIS/Agent dependencies
5. **Feature inventory:** Catalog usage of CLR, linked servers, Service Broker, SSIS, SSRS, SSAS across all instances
6. **Size and growth:** Calculate current size and 12-month growth projections

```sql
-- Comprehensive database inventory query
SELECT
    SERVERPROPERTY('ServerName') AS server_name,
    SERVERPROPERTY('ProductVersion') AS sql_version,
    SERVERPROPERTY('Edition') AS edition,
    d.name AS database_name,
    d.compatibility_level,
    d.recovery_model_desc,
    d.is_encrypted,
    d.collation_name,
    (SELECT SUM(size * 8.0 / 1024) FROM sys.master_files WHERE database_id = d.database_id AND type = 0) AS data_size_mb,
    (SELECT SUM(size * 8.0 / 1024) FROM sys.master_files WHERE database_id = d.database_id AND type = 1) AS log_size_mb,
    d.create_date,
    (SELECT MAX(backup_finish_date) FROM msdb.dbo.backupset WHERE database_name = d.name AND type = 'D') AS last_full_backup
FROM sys.databases d
WHERE d.database_id > 4
ORDER BY d.name;
```

### Classify databases into migration waves

| Wave                    | Criteria                                              | Databases       | Timeline   |
| ----------------------- | ----------------------------------------------------- | --------------- | ---------- |
| **Wave 0: Pilot**       | Dev/test, non-critical, simple schema                 | 2-5 databases   | Week 1-2   |
| **Wave 1: Low risk**    | Small production, few dependencies, simple apps       | 5-15 databases  | Week 3-5   |
| **Wave 2: Medium risk** | Medium production, moderate dependencies              | 10-20 databases | Week 6-9   |
| **Wave 3: High risk**   | Large production, complex dependencies, critical apps | 5-10 databases  | Week 10-14 |
| **Wave 4: Analytics**   | Reporting databases, data warehouse integration       | 5-10 databases  | Week 15-18 |

---

## Compatibility testing

### Create a compatibility testing environment

Before migrating production databases, validate compatibility in an isolated test environment:

1. Provision Azure SQL target (SQL DB, MI, or VM) in a non-production subscription
2. Migrate a copy of the production database to the test environment
3. Run the full application test suite against the migrated database
4. Capture query plans and performance metrics for comparison

### Automated regression testing

```sql
-- Use Query Store to capture baseline query plans on-premises
ALTER DATABASE [AdventureWorks] SET QUERY_STORE = ON (
    OPERATION_MODE = READ_WRITE,
    DATA_FLUSH_INTERVAL_SECONDS = 900,
    INTERVAL_LENGTH_MINUTES = 30,
    MAX_STORAGE_SIZE_MB = 1024,
    CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = 30),
    SIZE_BASED_CLEANUP_MODE = AUTO
);

-- After migration, compare query performance
SELECT TOP 20
    qt.query_sql_text,
    rs.avg_duration / 1000.0 AS avg_duration_ms,
    rs.avg_cpu_time / 1000.0 AS avg_cpu_ms,
    rs.avg_logical_io_reads,
    rs.count_executions
FROM sys.query_store_query_text qt
JOIN sys.query_store_query q ON qt.query_text_id = q.query_text_id
JOIN sys.query_store_plan p ON q.query_id = p.query_id
JOIN sys.query_store_runtime_stats rs ON p.plan_id = rs.plan_id
JOIN sys.query_store_runtime_stats_interval rsi ON rs.runtime_stats_interval_id = rsi.runtime_stats_interval_id
WHERE rsi.start_time >= DATEADD(hour, -24, GETUTCDATE())
ORDER BY rs.avg_duration DESC;
```

### Common compatibility issues and fixes

| Issue                        | Detection               | Fix                                            |
| ---------------------------- | ----------------------- | ---------------------------------------------- |
| Cross-database queries       | DMA assessment          | Consolidate, elastic query, or app-level joins |
| Deprecated syntax            | DMA compatibility check | Update T-SQL to current syntax                 |
| CLR assemblies               | `sys.assemblies` query  | Rewrite in T-SQL or downgrade to SAFE          |
| Windows auth only            | Login audit             | Add Entra ID authentication                    |
| Hardcoded connection strings | Code search             | Use config files with new endpoints            |
| Local file path references   | Agent job review        | Update to Azure Blob Storage URLs              |

---

## Application testing

### Connection string migration checklist

- [ ] Update server name to Azure SQL endpoint
- [ ] Change authentication method (SQL auth to Entra ID recommended)
- [ ] Add `Encrypt=True;TrustServerCertificate=False` for TLS
- [ ] Implement retry logic for transient faults
- [ ] Update connection timeout (Azure SQL may need higher values)
- [ ] Test failover group endpoint if using auto-failover

### Performance testing

- [ ] Run load tests against the migrated database
- [ ] Compare response times with on-premises baseline
- [ ] Test peak load scenarios (2-3x normal load)
- [ ] Validate batch job execution times
- [ ] Test concurrent user limits

### Functional testing

- [ ] Execute full regression test suite
- [ ] Test all CRUD operations
- [ ] Validate stored procedure outputs
- [ ] Test reporting queries and exports
- [ ] Validate scheduled jobs (Agent or Elastic Jobs)
- [ ] Test backup and restore procedures

---

## Rollback planning

### Define rollback criteria

Before each migration wave, define clear rollback triggers:

| Criteria                 | Threshold                            | Action             |
| ------------------------ | ------------------------------------ | ------------------ |
| Data loss detected       | Any confirmed data loss              | Immediate rollback |
| Application errors       | Error rate > 5% for 30 minutes       | Evaluate rollback  |
| Query performance        | P95 latency > 3x baseline for 1 hour | Evaluate rollback  |
| Connection failures      | > 10% failure rate for 15 minutes    | Evaluate rollback  |
| Business process failure | Critical business process blocked    | Immediate rollback |

### Rollback procedures

#### Rollback from Azure SQL Database

```bash
# If using DMS online migration with continuous sync:
# 1. Switch application back to on-premises connection string
# 2. Source database still has all data (sync was one-way)
# 3. No data loss

# If using BACPAC import:
# 1. Switch application back to on-premises
# 2. On-premises database still has all data (point-in-time snapshot)
# 3. Apply any transactions that occurred during the migration window
```

#### Rollback from Azure SQL MI

```bash
# If using MI Link:
# 1. Fail back to on-premises primary
# 2. Application reconnects to on-premises
# 3. MI remains as secondary

# If using DMS/LRS:
# 1. Switch application to on-premises
# 2. On-premises database is the last known good state
```

### Maintain parallel running period

Keep the on-premises SQL Server running for 72 hours minimum after cutover:

- Monitor for issues that only appear under production load
- Provides immediate rollback capability
- Allows gradual confidence building
- Decommission only after validation period passes

---

## Cost optimization

### Azure Hybrid Benefit

Apply Azure Hybrid Benefit (AHB) from day one of migration:

```bash
# Apply AHB to Azure SQL Database
az sql db update --resource-group myRG --server myserver --name myDB \
  --license-type BasePrice

# Apply AHB to SQL MI
az sql mi update --resource-group myRG --name myMI \
  --license-type BasePrice

# Apply AHB to SQL on VM
az sql vm update --resource-group myRG --name myVM \
  --license-type AHUB
```

### Reserved instances

After migration stabilizes (30-60 days), purchase reserved instances:

| Reservation strategy     | When to use                                    |
| ------------------------ | ---------------------------------------------- |
| 1-year reservation       | Uncertain about long-term sizing               |
| 3-year reservation       | Confident in workload sizing (maximum savings) |
| Mix of 1-year and 3-year | Some workloads stable, others evolving         |

### Right-sizing schedule

| Timeline            | Action                                      |
| ------------------- | ------------------------------------------- |
| Migration + 2 weeks | Review initial sizing, address hot spots    |
| Migration + 30 days | Analyze Azure Advisor recommendations       |
| Migration + 90 days | Right-size based on actual utilization data |
| Quarterly           | Review and adjust reservations              |
| Annually            | Comprehensive cost optimization review      |

---

## CSA-in-a-Box integration

### Post-migration analytics integration

After databases are running on Azure SQL, integrate with the CSA-in-a-Box platform for analytics:

#### Step 1: Register in Microsoft Purview

```bash
# Register Azure SQL as a Purview data source
# Configure scanning schedule (weekly recommended)
# Review and approve auto-classifications
```

#### Step 2: Create ADF pipelines to OneLake

```json
{
    "name": "SQL-to-OneLake",
    "properties": {
        "activities": [
            {
                "name": "CopyToOneLake",
                "type": "Copy",
                "inputs": [{ "referenceName": "AzureSqlSource" }],
                "outputs": [{ "referenceName": "OneLakeSink" }],
                "typeProperties": {
                    "source": { "type": "AzureSqlSource" },
                    "sink": {
                        "type": "LakehouseSink",
                        "storeSettings": { "type": "OneLakeWriteSettings" },
                        "formatSettings": { "type": "DeltaFormatWriteSettings" }
                    }
                }
            }
        ]
    }
}
```

#### Step 3: Build dbt models

Create dbt models in the CSA-in-a-Box `domains/` structure to transform migrated SQL data through the medallion architecture:

- **Bronze:** Raw replica of Azure SQL tables in Delta Lake format
- **Silver:** Cleaned, deduplicated, business-validated data
- **Gold:** Aggregated, enriched data optimized for analytics

#### Step 4: Deploy Power BI reports

Connect Power BI to Fabric semantic models built on the gold layer. Use Direct Lake mode for sub-second query performance without data duplication.

#### Step 5: Enable AI integration

Once data flows through the CSA-in-a-Box pipeline, enable AI capabilities:

- Azure OpenAI for natural-language queries over migrated data
- AI enrichment pipelines for classification and anomaly detection
- Copilot in Azure SQL for query optimization

---

## Migration project management

### RACI matrix

| Activity           | DBA | App dev | Cloud arch | Security | PM  |
| ------------------ | --- | ------- | ---------- | -------- | --- |
| Assessment         | R   | C       | A          | C        | I   |
| Target selection   | C   | C       | R/A        | C        | I   |
| Schema migration   | R/A | C       | I          | I        | I   |
| Data migration     | R/A | I       | C          | I        | I   |
| Security migration | C   | I       | C          | R/A      | I   |
| App testing        | C   | R/A     | I          | C        | I   |
| Cutover            | R   | R       | A          | C        | C   |
| Validation         | R   | R       | A          | C        | I   |
| Rollback           | R/A | R       | C          | I        | C   |

### Communication plan

| Audience            | Frequency          | Content                                             |
| ------------------- | ------------------ | --------------------------------------------------- |
| Executive sponsors  | Bi-weekly          | Migration status, risk summary, cost tracking       |
| Application owners  | Weekly             | Wave schedule, testing requirements, cutover plans  |
| DBA team            | Daily during waves | Technical status, issue triage, runbook updates     |
| End users           | Before each wave   | Maintenance window notification, expected impact    |
| Security/compliance | Monthly            | Security posture update, ATO documentation progress |

---

## Monitoring after migration

### Key metrics to track

| Metric                  | Target             | Alert threshold      |
| ----------------------- | ------------------ | -------------------- |
| DTU/vCore utilization   | < 80% sustained    | > 90% for 15 minutes |
| Connection success rate | > 99.9%            | < 99%                |
| Query duration (P95)    | Within 2x baseline | > 3x baseline        |
| Storage utilization     | < 85%              | > 90%                |
| Deadlock rate           | < 1/hour           | > 5/hour             |
| Backup status           | All successful     | Any failure          |

```bash
# Set up Azure Monitor alerts
az monitor metrics alert create \
  --resource-group myRG \
  --name "High CPU Alert" \
  --scopes "/subscriptions/{sub}/resourceGroups/myRG/providers/Microsoft.Sql/servers/myserver/databases/myDB" \
  --condition "avg cpu_percent > 90" \
  --window-size 15m \
  --evaluation-frequency 5m \
  --action-group myActionGroup
```

---

## Related

- [Migration Playbook](../sql-server-to-azure.md)
- [Migration Center](index.md)
- [TCO Analysis](tco-analysis.md)
- [Benchmarks](benchmarks.md)
- [Federal Migration Guide](federal-migration-guide.md)
- [Security Migration](security-migration.md)

---

## References

- [Azure SQL migration best practices](https://learn.microsoft.com/azure/azure-sql/migration-guides/database/sql-server-to-sql-database-overview)
- [Data Migration Assistant best practices](https://learn.microsoft.com/sql/dma/dma-bestpractices)
- [Azure Advisor for SQL](https://learn.microsoft.com/azure/advisor/advisor-performance-recommendations)
- [Azure SQL monitoring](https://learn.microsoft.com/azure/azure-sql/database/monitor-tune-overview)
- [Query Store best practices](https://learn.microsoft.com/sql/relational-databases/performance/best-practice-with-the-query-store)
- [Azure cost optimization](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-opt-recommendations)
