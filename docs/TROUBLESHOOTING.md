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

## ADF Pipeline Issues

### Pipeline stuck in "InProgress"

Check for long-running activities in Monitor > Pipeline runs:
```bash
az datafactory pipeline-run query-by-factory \
    --factory-name csadlzdevdf \
    --resource-group rg-csadlz-dev \
    --last-updated-after "2026-01-01T00:00:00Z" \
    --last-updated-before "2026-12-31T00:00:00Z" \
    --filters '[{"operand":"Status","operator":"Equals","values":["InProgress"]}]'
```

**Fix**: Cancel the run and check for:
- Databricks cluster that failed to start
- ADLS permission issues (managed identity needs `Storage Blob Data Contributor`)
- Timeout on Copy activities (increase in pipeline JSON)

### "LinkedServiceNotFound" error

The linked service must be deployed before the pipeline that references it.
Use the deployment script which handles ordering:
```bash
./scripts/deploy/deploy-adf.sh --factory-name <name> --resource-group <rg>
```

### Trigger not firing

1. Verify the trigger is started: `az datafactory trigger show --name tr_daily_medallion ...`
2. Check the trigger's `runtimeState` — must be `Started`
3. If `Stopped`, start it: `az datafactory trigger start --name tr_daily_medallion ...`

## Stream Analytics Issues

### "Input deserialization error"

The incoming event doesn't match the expected schema.
```kql
// Check for deserialization errors
AzureDiagnostics
| where Category == "Execution"
| where Level == "Error"
| project TimeGenerated, Message
```

**Fix**: Verify the event producer (`scripts/streaming/produce_events.py`)
output matches the SA job input schema. Common issues:
- Missing required fields
- Wrong data types (string vs number)
- Nested JSON not flattened

### "Output sink error" (Event Hub / ADX / Blob)

1. Verify the output connection string is valid
2. Check Event Hub namespace isn't throttled (quota exceeded)
3. For ADX: verify the table exists and streaming ingestion is enabled

### Query syntax error on deployment

Test queries locally before deploying:
```bash
# Validate ASAQL syntax
az stream-analytics query test --job-name <job> \
    --resource-group <rg> \
    --query-file scripts/streaming/queries/tumbling_window_event_counts.asaql
```

## Databricks Issues

See the detailed [DATABRICKS_GUIDE.md](DATABRICKS_GUIDE.md) for full
coverage. Quick fixes for common issues:

### "Cluster terminated unexpectedly"

Check the cluster event log for OOM or spot instance eviction:
```python
# In a Databricks notebook
events = dbutils.cluster.events(cluster_id, limit=20)
```

**Fix**: Increase driver/worker memory or switch from spot to on-demand.

### "Delta table version conflict"

Concurrent writes to the same Delta table from multiple jobs:
```
ConcurrentAppendException: Files were added by a concurrent update
```

**Fix**: Enable Delta auto-retry:
```
spark.databricks.delta.retryWriteConflict.enabled true
```

Or stagger job schedules to avoid overlap.

## Purview Issues

### "Scan failed: Access denied"

The Purview managed identity needs access to the data source:
1. Storage: Assign `Storage Blob Data Reader` to the Purview MI
2. Cosmos DB: Assign `Cosmos DB Account Reader` to the Purview MI
3. Databricks: Generate a PAT and store in Purview credentials

### "Classification rules not applied"

1. Verify custom classification rules are loaded:
   ```bash
   python scripts/purview/bootstrap_catalog.py --purview-account <name> --dry-run
   ```
2. Check that the scan ruleset includes the custom rules
3. Re-run the scan after updating classification rules

### "Lineage not showing"

For ADF-to-Purview lineage:
1. Verify `purviewAccountId` is set in the ADF Bicep parameters
2. Check that ADF's managed identity has `Purview Data Curator` role
3. Run a pipeline and wait 5-10 minutes for lineage to propagate

## Great Expectations Issues

### "No suites configured" warning

The GE runner found no suites in `quality-rules.yaml`:
1. Verify `quality-rules.yaml` has a `great_expectations.suites` section
2. Check for YAML syntax errors: `python -c "import yaml; yaml.safe_load(open('governance/dataquality/quality-rules.yaml'))"`

### "Checkpoint not found"

GE checkpoint YAMLs live in `great_expectations/checkpoints/`. Verify:
```bash
ls great_expectations/checkpoints/
# Should show: bronze_customers_checkpoint.yml, etc.
```

### "great_expectations not installed"

The GE package is optional (200MB+). Install via:
```bash
pip install great-expectations
```

Or use the in-memory fallback by passing `sample_data=` to `run_ge_checkpoints()`.

## Key Vault Issues

### "SecretNotFound" or "Forbidden"

1. Verify the secret exists: `az keyvault secret show --vault-name <vault> --name <secret>`
2. Check access policy: the calling identity needs `Get` permission on secrets
3. If using RBAC: verify the identity has `Key Vault Secrets User` role
4. Check if Key Vault is behind a private endpoint — the caller must be in the VNet

### "Key Vault is soft-deleted"

A previously deleted Key Vault with the same name blocks recreation:
```bash
az keyvault recover --name <vault>  # Recover it
# OR
az keyvault purge --name <vault>    # Permanently delete
```

## Cosmos DB Issues

### "Request rate too large" (429 throttling)

The container is exceeding its provisioned RU/s:
```kql
CDBDataPlaneRequests
| where StatusCode == 429
| summarize count() by bin(TimeGenerated, 5m)
```

**Fix**: Increase RU/s or enable autoscale:
```bash
az cosmosdb sql container throughput update \
    --account-name <account> --database-name <db> \
    --name <container> --max-throughput 10000
```

### "Partition key not found"

Verify the partition key path matches between the Bicep template and
the application code. The Cosmos Bicep module sets the partition key
during container creation.

## CI/CD Workflow Issues

### "OIDC token request failed"

The GitHub Actions OIDC federation to Azure failed:
1. Verify the federated credential exists on the service principal
2. Check the `subject` claim matches: `repo:<org>/<repo>:ref:refs/heads/main`
3. Verify the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` secrets

### Coverage gate failing

The `pytest --cov-fail-under=80` gate requires 80% coverage:
```bash
pytest tests/ --cov --cov-report=term-missing
```

Check which files are below threshold and add tests.

### Bicep what-if PR comment not appearing

1. The `bicep-whatif.yml` workflow requires Azure OIDC credentials
2. It only runs on PRs that modify `deploy/bicep/**` files
3. The bot needs write permissions on the PR — check `permissions: pull-requests: write`
