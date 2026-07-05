# Lakehouse — workload reference

!!! note "Superseded by the hands-on tutorial"
    This workload overview is superseded by the hands-on
    [Lakehouse tutorial](../tutorials/editor-lakehouse.md) (UAT-dated). See that
    guide for the current step-by-step.

> **Family:** Data Engineering
> **Loom slug:** `lakehouse`
> **Editor file:** `apps/fiab-console/lib/editors/lakehouse-editor.tsx`
> **BFF routes:** `app/api/lakehouse/{containers,paths,upload,preview,path,shortcuts,permissions}/**`
> **Parity spec:** [`fiab/lakehouse-parity-spec.md`](../lakehouse-parity-spec.md)

## Purpose

An **Azure-native** (ADLS Gen2 + Delta) lakehouse browser with a side-by-side
SQL analytics endpoint — no Microsoft Fabric required (per
`.claude/rules/no-fabric-dependency.md`). Surfaces every container the Console
UAMI can see, lets the user upload / create / delete files + folders, previews
tabular files via Synapse Serverless OPENROWSET, and exposes a SQL pane that
runs T-SQL against the same engine. Tables view enumerates Delta tables under
`/Tables/`. The **Shortcuts** pane creates ADLS-native shortcuts (Cosmos-backed
definitions bound by the Databricks/Synapse engines — `shortcut-engines.ts` +
`lakehouse-shortcuts.ts`) to other ADLS Gen2, S3, GCS, and SharePoint locations.

## Fabric-parity gap

| Fabric feature | Loom state |
|---|---|
| Lakehouse explorer (Tables + Files) | Shipped — real ADLS Gen2 listing |
| Delta table preview | Shipped — Synapse Serverless OPENROWSET FORMAT=PARQUET / DELTA |
| Open in notebook | Shipped — prefills code via `localStorage` handoff |
| Load to Tables | Shipped — generates `df.write.saveAsTable` and opens notebook |
| Shortcuts (ADLS / S3 / GCS / SharePoint) | Shipped — ADLS-native shortcut definitions via `app/api/lakehouse/shortcuts/**` (no Fabric) |
| Manage lakehouse security (RLS/CLS, ACLs) | Shipped — Storage RBAC + ACLs via `app/api/lakehouse/permissions/**` (no Fabric) |
| Get data | Power Query M ingest path is in the dataflow-gen2 editor |

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
