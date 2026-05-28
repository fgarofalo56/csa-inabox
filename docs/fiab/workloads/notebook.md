# Notebook — workload reference

> **Family:** Data Engineering
> **Loom slug:** `notebook`
> **Editor file:** `apps/fiab-console/lib/editors/notebook-editor.tsx`
> **BFF routes:** `app/api/items/notebook/**`
> **Parity spec:** [`fiab/notebook-parity-spec.md`](../notebook-parity-spec.md)

## Purpose

Loom-native interactive notebook with PySpark / SQL / Scala / R cells,
real cell execution against a user-selected compute target (Synapse
Spark pool via Livy or a Databricks job cluster), and per-cell history.
Notebook metadata + cell content live in Cosmos workspace-items; the
runtime is the customer's Azure-native Spark backend, not a Fabric
proxy.

## Fabric-parity gap

| Fabric feature | Loom state |
|---|---|
| Markdown + code cells | Shipped — Monaco editor with cell adder |
| Run cell / Run all | Shipped — dispatches to compute target via `/api/items/notebook/[id]/run` |
| Lakehouse attach | Shipped — left panel + default-source picker |
| Cell history | Shipped — `HistoryDrawer` from real job records |
| Real-time collab | Not wired — single-author editing only |
| `%pip install` magics | Honored on Databricks; Synapse path uses pool-level env |

## Real backend it calls

- Cosmos `items` container for the notebook document
- `/api/items/notebook/[id]/run` dispatches to:
  - Synapse Spark via Livy batch (`POST /livyApi/.../batches`)
  - OR Databricks Jobs API `runs/submit`
  Both targets are selected per-notebook in the compute picker.
- Lakehouse + Warehouse attach uses Cosmos `items` queries to surface
  the workspace's data sources.

## Sample usage

1. From a Loom workspace, click **New → Notebook**.
2. Pick a compute target (Synapse Spark pool or Databricks cluster).
3. Add cells, write Spark code, Run.
4. View history in the drawer to retrieve prior runs.

## Screenshots

Living screenshots: `docs/assets/images/fiab/notebook/`.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_SYNAPSE_WORKSPACE` | Synapse Spark dispatch | `platform/fiab/bicep/modules/landing-zone/synapse.bicep` |
| `LOOM_DATABRICKS_HOST` | Databricks dispatch | `platform/fiab/bicep/modules/landing-zone/databricks.bicep` |
| `LOOM_DATABRICKS_TOKEN_SECRET` | Databricks PAT (KV ref) | databricks SCIM bootstrap |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI for OBO | `identity.bicep` |
