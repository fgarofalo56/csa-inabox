# Troubleshooting Guide

## Bicep Deployment Issues

### "Resource provider not registered"
```
Error: Resource provider 'Microsoft.Purview' is not registered
```
**Fix**: Register the provider:
```bash
az provider register --namespace Microsoft.Purview
az provider register --namespace Microsoft.Databricks
az provider register --namespace Microsoft.Synapse
```

### "Template validation failed"
```
Error: Template validation failed
```
**Fix**: Run `bicep build` locally first:
```bash
bicep build deploy/bicep/DLZ/main.bicep
```

### "DeploymentFailed - PrivateEndpoint"
Private endpoints require:
1. The target VNet/subnet exists
2. The Private DNS Zone exists and is linked to the VNet
3. The subnet has `privateEndpointNetworkPolicies` set to `Disabled`

### "Conflict - RoleAssignment"
Safe to ignore on re-deployments. The role assignment already exists.

## dbt Issues

### "Connection refused" on dbt compile
Ensure your `profiles.yml` has correct Databricks connection info:
```yaml
csa_analytics:
  target: dev
  outputs:
    dev:
      type: databricks
      host: "your-workspace.azuredatabricks.net"
      http_path: "/sql/1.0/warehouses/your-warehouse-id"
      token: "{{ env_var('DBT_DATABRICKS_TOKEN') }}"
```

### "Catalog not found"
Run Unity Catalog setup first:
```
domains/shared/notebooks/databricks/unity_catalog_setup.py
```

## Data Quality Issues

### Volume check shows "warn" instead of "pass"
This means dbt CLI is not available in the current environment. Volume checks require dbt to query actual row counts. Install dbt: `pip install dbt-databricks`

### Freshness check times out
Increase the timeout in `run_quality_checks.py` or check network connectivity to Databricks.

## Azure Functions Issues

### "AI client not configured"
Set these environment variables in the Function App configuration:
- `AZURE_AI_ENDPOINT`: Your Azure AI Services endpoint URL
- `AZURE_AI_KEY`: Key Vault reference to your AI key

### "Event Hub connection failed"
Verify `EVENT_HUB_CONNECTION` app setting points to a valid Event Hub namespace connection string.

## Deployment Rollback

If a deployment landed broken state in Azure, see
[`ROLLBACK.md`](ROLLBACK.md) for the step-by-step rollback runbook. It
covers Bicep redeploy, ADF pipeline restore, dbt full-refresh, Cosmos DB
point-in-time restore, and storage account blob recovery.

## Regional Outage / Disaster Recovery

If the whole primary Azure region is down (not just a deploy gone bad),
see [`DR.md`](DR.md) for the failover runbook. It documents RPO/RTO
targets per service, the primary/secondary region pairs, and the
step-by-step failover and failback procedures.
