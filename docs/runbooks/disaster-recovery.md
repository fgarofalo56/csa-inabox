# Disaster Recovery Runbook

## RTO / RPO Targets

| Service | RPO | RTO | Recovery Method |
|---------|-----|-----|-----------------|
| ADLS Gen2 (Data Lake) | 0 (GRS) | 4h | Failover to secondary |
| Databricks | N/A (compute) | 1h | Redeploy workspace |
| Synapse | 8h (restore point) | 2h | Restore from point |
| Cosmos DB | 0 (multi-region) | 0 (automatic) | Automatic failover |
| Key Vault | 0 (soft delete) | 30m | Recover from soft delete |
| ADF | N/A (metadata) | 1h | Redeploy from Git |

## Pre-Requisites

- [ ] GRS enabled on primary storage accounts
- [ ] Cosmos DB multi-region write configured
- [ ] Key Vault soft delete and purge protection enabled
- [ ] Bicep templates version-controlled in Git
- [ ] Parameter files for DR region available
- [ ] Action group contacts verified

## Failover Procedures

### Storage Account Failover
```powershell
# Initiate failover to secondary region
Invoke-AzStorageAccountFailover -ResourceGroupName "rg-storage" -AccountName "csadlzst" -Force
# Monitor: takes 1-2 hours
Get-AzStorageAccount -ResourceGroupName "rg-storage" -AccountName "csadlzst" | Select-Object StatusOfPrimary, StatusOfSecondary
```

### Databricks Workspace Recovery
```powershell
# Redeploy workspace from Bicep
az deployment group create `
    --resource-group "rg-databricks-dr" `
    --template-file "deploy/bicep/DLZ/modules/databricks/databricks.bicep" `
    --parameters "deploy/bicep/DLZ/params.dr.json"
```

### dbt Model Rebuild
```bash
# Full refresh all models in DR workspace
dbt run --full-refresh --target dr
dbt test --target dr
```

## Validation Checks

After failover:
- [ ] Storage accounts accessible via private endpoints
- [ ] Databricks workspace responds
- [ ] dbt compile succeeds against DR target
- [ ] ADF pipelines show in portal
- [ ] Key Vault secrets accessible
- [ ] Private DNS resolution working
- [ ] Monitor alerts firing correctly

## Failback Procedure

1. Resolve root cause in primary region
2. Resync data: `azcopy sync` from DR to primary
3. Validate primary environment
4. Update DNS / traffic routing
5. Decommission DR resources (if temporary)

---

*Test this runbook semi-annually*
*Last Updated: 2026-04-09*
