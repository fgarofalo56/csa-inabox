# Copy Job — workload reference

> **Family:** Data Engineering
> **Loom slug:** `copy-job`
> **Editor file:** `apps/fiab-console/lib/editors/phase2-misc-editors.tsx`
> **BFF routes:** `app/api/items/copy-job/**`
> **Parity spec:** [`fiab/copy-job-parity-spec.md`](../copy-job-parity-spec.md)

## Purpose

Simple source-to-sink data movement backed by an auto-generated ADF
pipeline. The editor's form captures source linked service / dataset
config + sink linked service / dataset config; **Save** persists the
spec to Cosmos, **Run** materialises an ADF pipeline (single Copy
activity) and triggers it. Runs list comes from `queryPipelineRuns`.

## Fabric-parity gap

| Fabric feature | Loom state |
|---|---|
| Linked-service picker | Shipped — `/api/adf/linked-services` |
| Source + sink config | Shipped |
| Run | Shipped — ADF pipeline materialise + run |
| Runs / history | Shipped — `queryPipelineRuns` |
| Mapping (column-level) | Gated — surfaced as `MessageBar` link to ADF Studio |

## Real backend it calls

- `adf-client.ts` (linked services + pipeline materialise + run + query).
- Cosmos `items` for the copy-job spec.

## Sample usage

1. Open `/items/copy-job/<id>`.
2. Pick the source linked service (e.g. `AzureBlob_src`) and folder.
3. Pick the sink linked service (e.g. `AzureSql_sink`) and table.
4. **Save** then **Run**.
5. Inspect the Runs tab for the materialised ADF pipeline run.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_ADF_NAME` | ADF factory | `landing-zone/adf.bicep` |
| `LOOM_DLZ_RG` | RG | `landing-zone/main.bicep` |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI | `identity.bicep` |
