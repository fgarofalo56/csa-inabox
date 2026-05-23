# Runbook — Purview scan stuck

## Symptom

A scheduled Purview scan (Databricks Hive, Synapse Serverless, ADLS
Gen2, Power BI) doesn't complete or shows `In Progress` for > 4 hours.

## Diagnosis

```bash
# 1. Purview Studio → Data Map → Sources → <source> → Scans
# Look at scan history; identify stuck scan

# 2. Check Purview managed VNet integration runtime status
# (Purview Studio → Management → Integration runtimes)

# 3. Check Purview MI role on target source
az role assignment list \
  --assignee <purview-account-mi-object-id> \
  --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/...

# 4. Check Purview scan log
# Purview Studio → Data Map → Activity Log
```

## Common causes + fixes

| Cause | Fix |
|---|---|
| Purview MI lacks read on target source | Assign Storage Blob Data Reader / Synapse SQL Admin / Databricks workspace access |
| Network egress from Purview managed VNet IR blocked | Allow Purview managed VNet IR egress to target storage / Synapse / Databricks endpoints |
| Source storage account has firewall enabled, Purview not in allow-list | Add Purview to firewall allow-list or use managed Private Endpoint |
| Scan ruleset misconfigured (too broad → timeout) | Narrow scan ruleset; partition large sources into multiple scans |
| Databricks Hive metastore not exposed externally | Use Databricks personal access token + REST scan target |
| Purview capacity throttling | Scale up Purview vCore allocation |

## Remediation

1. **Cancel the stuck scan** via Purview Studio
2. **Apply fix** per the table above
3. **Re-trigger** scan manually
4. **Verify** scan completes within expected window (typically 30 min
   - 2 hours for medium datasets)
5. **Validate** assets appear in Purview Data Map / Unified Catalog

## Prevention

- Schedule scans during off-hours (avoid contending with production
  load on source)
- Use **incremental scans** (Purview default) instead of full scans
  where possible
- Monitor scan SLAs via Purview Activity Log → LAW
- For large lakehouses, partition into multiple smaller scan targets
  (per workspace, per table-prefix)

## At IL5 (Atlas-on-AKS instead of Purview)

This runbook applies to Commercial / GCC / GCC-H. At IL5, the catalog
is self-hosted Apache Atlas — different troubleshooting:

| Atlas symptom | Fix |
|---|---|
| Atlas pod CrashLoopBackOff | Check pod logs; usually Solr / HBase / Kafka dependency issue |
| Custom ABFS scanner not finding new tables | Restart scanner CronJob; check ADLS RBAC |
| Atlas REST API slow | Scale Atlas pod; increase JVM heap |

See [Atlas troubleshooting (v1.1)](#) — pending v1.1 ship.

## Related

- Workload: [OneLake parity](../workloads/onelake-parity.md), [Data Engineering parity](../workloads/data-engineering.md)
- Governance: [Catalog](../governance/catalog.md)
- Parent runbook: [Purview Scan Failure](../../runbooks/purview-scan-failure.md)
