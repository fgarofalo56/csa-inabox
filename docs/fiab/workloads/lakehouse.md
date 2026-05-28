# Lakehouse — workload reference

> **Family:** Data Engineering
> **Loom slug:** `lakehouse`
> **Editor file:** `apps/fiab-console/lib/editors/lakehouse-editor.tsx`
> **BFF routes:** `app/api/lakehouse/{containers,paths,upload,preview,path}/**`
> **Parity spec:** [`fiab/lakehouse-parity-spec.md`](../lakehouse-parity-spec.md)

## Purpose

Fabric-parity ADLS Gen2 browser with a side-by-side SQL analytics
endpoint. Surfaces every container the Console UAMI can see, lets the
user upload / create / delete files + folders, previews tabular files
via Synapse Serverless OPENROWSET, and exposes a SQL pane that runs
T-SQL against the same engine. Tables view enumerates Delta tables
under `/Tables/`. Shortcuts pane is gated honestly until the Fabric
REST shortcut endpoint is wired (see MessageBar in the editor).

## Fabric-parity gap

| Fabric feature | Loom state |
|---|---|
| Lakehouse explorer (Tables + Files) | Shipped — real ADLS Gen2 listing |
| Delta table preview | Shipped — Synapse Serverless OPENROWSET FORMAT=PARQUET / DELTA |
| Open in notebook | Shipped — prefills code via `localStorage` handoff |
| Load to Tables | Shipped — generates `df.write.saveAsTable` and opens notebook |
| Manage OneLake security | Gated — Fabric REST shortcut/role assignment route not wired |
| Get data | Gated — Power Query M ingest path is in dataflow-gen2 editor |

## Real backend it calls

- ADLS Gen2 via `@azure/storage-file-datalake` against the
  `loom-*` storage account using ChainedTokenCredential (UAMI →
  DefaultAzureCredential).
- Synapse Serverless via the existing `synapse-dev-client` (TDS over
  the workspace dev endpoint) for the Preview + SQL tabs.

## Sample usage

1. Open `/items/lakehouse/<workspaceId>` (or `new`).
2. Pick a container in the left tree.
3. Upload a Parquet file via the toolbar.
4. Right-click the file → **Preview** to render the first 100 rows.
5. Switch to **SQL** to refine the OPENROWSET query and **Run**.

## Screenshots

Reference screenshots live alongside the parity-spec under
`docs/assets/images/fiab/lakehouse/`. Add new captures via the
`atlas-tools/` screenshot pipeline; do not commit raw portal screenshots
without redaction.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_STORAGE_ACCOUNT` | DLZ storage account name | `platform/fiab/bicep/modules/landing-zone/storage.bicep` |
| `LOOM_SYNAPSE_WORKSPACE` | Workspace for Serverless preview | `platform/fiab/bicep/modules/landing-zone/synapse.bicep` |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI for OBO | `platform/fiab/bicep/modules/admin-plane/identity.bicep` |

Role grants (`Storage Blob Data Contributor` on the DLZ storage,
`Synapse SQL Administrator` on the workspace) are issued by the
storage and synapse bicep modules.
