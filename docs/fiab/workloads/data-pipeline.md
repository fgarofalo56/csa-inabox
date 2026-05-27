# Data pipeline — workload reference

> **Family:** Data Engineering
> **Loom slug:** `data-pipeline`
> **Editor file:** `apps/fiab-console/lib/editors/data-pipeline-editor.tsx`
> **BFF routes:** `app/api/items/data-pipeline/**`
> **Parity spec:** [`fiab/data-pipeline-parity-spec.md`](../data-pipeline-parity-spec.md)

## Purpose

Fabric-parity data pipeline backed by the loom-managed Azure Data
Factory. The Loom workspace-item stores the pipeline reference + Loom
metadata; the runtime is ADF. Editor surfaces the JSON pipeline
definition (`pipeline-content.json` inline) and a DAG view; **Run**
triggers an ADF run and **Runs** lists `queryPipelineRuns` results.

## Fabric-parity gap

| Fabric feature | Loom state |
|---|---|
| Activity DAG (Wait, Copy, ForEach, etc.) | Shipped — extracted from JSON |
| Save | Shipped — PUTs pipeline-content.json |
| Run | Shipped — POST `pipeline/{name}/createRun` |
| Runs / history | Shipped — `queryPipelineRuns` |
| Visual designer (drag-drop) | Gated — JSON authoring is shipped; visual editor deferred |

## Real backend it calls

- `@/lib/azure/adf-client.ts` — ARM REST against
  `Microsoft.DataFactory/factories/{LOOM_ADF_NAME}` using the Console
  UAMI's "Data Factory Contributor" role assignment.
- Cosmos `items` for the Loom workspace association.

## Sample usage

1. Open `/items/data-pipeline/new?workspaceId=…`.
2. Edit the JSON pipeline body (Wait → Copy → notebook activity etc).
3. **Save** → PUT to ADF.
4. **Run** → starts an ADF pipeline run; results appear in the **Runs** tab.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_ADF_NAME` | ADF factory name | `platform/fiab/bicep/modules/landing-zone/adf.bicep` |
| `LOOM_DLZ_RG` | DLZ RG containing ADF | `landing-zone/main.bicep` |
| `LOOM_SUBSCRIPTION_ID` | Sub ID | top-level params |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI | `identity.bicep` |
