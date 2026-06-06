# Runbook — Spark notebook "Hive metastore" / abfss `InvalidAbfsRestOperationException`

## Symptom

A Loom **Notebook** (or any Synapse Spark session) fails on the first Spark SQL
statement (e.g. `SHOW NAMESPACES`, `SHOW DATABASES`, `CREATE DATABASE`) with:

```
org.apache.hadoop.hive.ql.metadata.HiveException: MetaException(message:Got exception:
  org.apache.hadoop.fs.azurebfs.contracts.exceptions.InvalidAbfsRestOperationException
  Status code: -1 error code: null error message: InvalidAbfsRestOperationException)
  ... HiveExternalCatalog.createDatabase ...
```

## Root cause

When a Synapse Spark session starts it initializes the **Hive external catalog**
and creates the default-database directory under the workspace's **default ADLS
Gen2 filesystem** (abfss). That write fails when either (or both):

1. **RBAC** — the Synapse workspace **managed identity** lacks `Storage Blob Data
   Contributor` on the default storage account (would surface as `403`).
2. **Network** — the workspace runs in a **managed VNet** with the default
   storage locked down (`publicNetworkAccess: Disabled` + `preventDataExfiltration:
   true`), and there is **no approved managed private endpoint** from the managed
   VNet to the storage `dfs`/`blob` endpoints. The ABFS driver can't reach the
   endpoint at all → **`Status code: -1`** (no HTTP response), which is the
   signature in the symptom above.

In CSA Loom's DLZ both can apply: `synapse.bicep` creates the workspace with
`managedVirtualNetwork: 'default'`, `publicNetworkAccess: 'Disabled'`, and
`preventDataExfiltration: true`, and (until the fix below) did not grant the
workspace MSI blob-data access nor create managed private endpoints to the
default storage.

## Fix (one-time, live deployment)

Run the durable script (idempotent — grants RBAC + creates & approves the
managed private endpoints):

```bash
./scripts/csa-loom/fix-synapse-spark-storage-access.sh
# or pin them explicitly:
SYNAPSE_WS=syn-loom-<domain>-<region> SYNAPSE_RG=<rg> \
STORAGE_ACCOUNT=<defaultSA> STORAGE_RG=<rg> \
  ./scripts/csa-loom/fix-synapse-spark-storage-access.sh
```

It performs:

1. `az role assignment create … "Storage Blob Data Contributor"` for the
   workspace MSI on the default storage account.
2. `az synapse managed-private-endpoints create` for `dfs` **and** `blob` from
   the Synapse managed VNet to the default storage account.
3. `az network private-endpoint-connection approve` for the pending connections
   on the storage side.

Then **restart the Spark session** (notebook → restart) and re-run.

> Approving private-endpoint connections and writing role assignments requires
> rights on the storage account. The `limitlessdata_deploy` SP can do this after
> the one-time human grant; otherwise an owner runs the script.

## Durable fix (new deployments)

- `platform/fiab/bicep/modules/landing-zone/synapse-storage-rbac.bicep` grants
  the workspace MSI `Storage Blob Data Contributor` on the default SA, wired into
  `synapse.bicep` (`grantSynapseStorageRole`, default **on**;
  `defaultStorageResourceGroup` defaults to the workspace RG).
- The **managed private endpoints** to the default storage are created + approved
  by the script above and the post-deploy bootstrap; managed-PE approval is a
  data-plane action on the storage account, not a clean `main.bicep` step, so it
  lives in the script/bootstrap rather than the workspace module.

## Verify

```bash
# RBAC present:
az role assignment list --assignee <workspaceMsiObjectId> \
  --scope <storageAccountId> --query "[?roleDefinitionName=='Storage Blob Data Contributor']"
# Managed PEs approved:
az synapse managed-private-endpoints list --workspace-name <ws> \
  --query "[].{name:name,status:properties.connectionState.status}"
```

In a notebook cell: `spark.sql("SHOW NAMESPACES").show()` returns without the
abfss error.
