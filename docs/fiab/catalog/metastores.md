# Catalog — Metastores

Inventory of every back-end the Unified Catalog federates over.

## Endpoint

- `GET /api/catalog/metastores` — list UC metastores (federated across workspaces, deduped by `metastore_id`), Fabric / OneLake workspaces, and the configured Purview account
- `POST /api/catalog/metastores` body `{ source: 'unity-catalog', hostname }` — **probe** a new Databricks workspace. Persistent registration still requires a bicep flip on `LOOM_DATABRICKS_HOSTNAMES`; the probe lets the admin pre-validate that the metastore admin group already includes the Loom UAMI before they push the bicep change.

## Multi-workspace federation

The console reads `LOOM_DATABRICKS_HOSTNAMES` (comma-separated) and falls back to `LOOM_DATABRICKS_HOSTNAME`. Each workspace gets a separate AAD token + REST call; results are deduped so a metastore shared across multiple workspaces appears once. When a workspace is unreachable a synthetic `ERROR_<hostname>` row is returned so the operator sees which workspace is misconfigured (versus a single global 500 hiding the cause).

## NotConfigured gates

- Unity → if `LOOM_DATABRICKS_HOSTNAMES`/`LOOM_DATABRICKS_HOSTNAME` is unset, the page shows the structured hint with the env var name + bicep module
- Fabric → if the UAMI is not in the Fabric service-principals tenant setting, the upstream 403 surfaces verbatim
- Purview → if `LOOM_PURVIEW_ACCOUNT` is unset, the page renders an account-not-configured MessageBar
