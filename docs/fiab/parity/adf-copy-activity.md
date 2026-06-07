# adf-copy-activity — parity with Azure Data Factory Copy activity

Source UI: ADF Studio → Author → Pipeline → select a **Copy data** activity →
bottom configuration panel (Source / Sink / Mapping / Settings tabs).
- https://learn.microsoft.com/azure/data-factory/copy-activity-overview#configuration
- https://learn.microsoft.com/azure/data-factory/copy-activity-schema-and-type-mapping
- https://learn.microsoft.com/azure/data-factory/copy-activity-performance-features
- https://learn.microsoft.com/azure/data-factory/copy-activity-fault-tolerance
- Wire schema (api-version 2018-06-01): https://learn.microsoft.com/azure/templates/microsoft.datafactory/2018-06-01/factories/pipelines

Backend: the deployment-default Data Factory via ARM REST
(`Microsoft.DataFactory/factories`, api-version `2018-06-01`). Datasets +
linked services are read live through the existing BFF routes
`GET /api/adf/datasets` and `GET /api/adf/linked-services`; the activity config
round-trips on the pipeline `PUT`. **No real Microsoft Fabric / Power BI
dependency** — ADF is the Azure-native default (per `no-fabric-dependency.md`).

## What this replaces

Before this change a Copy activity fell back to the generic combined
**Source / Sink** tab (two dataset dropdowns + parallelCopies/recursive/
writeBehavior) plus a raw `typeProperties` JSON textarea for everything else
(mapping, staging, DIU, fault tolerance). That was a thin surface, not ADF
parity. Now a Copy node renders the **four real ADF tabs** with typed controls
and no JSON required for the happy path.

## ADF Copy-activity feature inventory (grounded in Learn)

### Source tab
- Source dataset picker (binds `inputs[0]` DatasetReference; sets `source.type`).
- Additional columns (`source.additionalColumns[]`: `$$FILEPATH`, `$$COLUMN:x`,
  expression, static).
- File connectors: recursive, wildcard folder/file path, modified-date range.
- SQL connectors: read mode (table / query / stored procedure), query text,
  query timeout, isolation level.

### Sink tab
- Sink dataset picker (binds `outputs[0]` DatasetReference; sets `sink.type`).
- Pre-copy script, max concurrent connections, table option (auto-create).
- SQL connectors: write behavior (Insert / Upsert / Stored proc), write batch
  size, disable metrics collection.
- File connectors: copy behavior (Preserve / Flatten / Merge hierarchy).

### Mapping tab
- Import schemas (derive columns from source/sink dataset schema).
- Explicit column mapping grid (source → sink, + type) with add/delete.
- Clear → default by-name mapping (`translator` omitted).

### Settings tab
- Data integration units (Auto / 2…256) → `dataIntegrationUnits`.
- Degree of copy parallelism → `parallelCopies`.
- Enable staging (+ linked service / path / compression) → `enableStaging` /
  `stagingSettings.*`.
- Fault tolerance: skip incompatible rows (+ redirect store / path) →
  `enableSkipIncompatibleRow` / `redirectIncompatibleRowSettings.*`.
- Data consistency verification → `validateDataConsistency`.

## Loom coverage

| ADF Copy capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| Source dataset picker → `inputs[0]` + `source.type` | ✅ built — `SourceTab` + `DatasetPicker` | `GET /api/adf/datasets` → list; persisted on pipeline `PUT` |
| Additional columns (`$$FILEPATH`/static/expr) | ✅ built — add/remove grid → `source.additionalColumns[]` | round-trips on PUT |
| File source: recursive / wildcard / modified-date | ✅ built — typed controls (shown for file connectors) | round-trips on PUT |
| SQL source: read mode / query / timeout / isolation | ✅ built — Select + ExpressionField (shown for SQL connectors) | round-trips on PUT |
| Sink dataset picker → `outputs[0]` + `sink.type` | ✅ built — `SinkTab` + `DatasetPicker` | `GET /api/adf/datasets`; PUT |
| Pre-copy script / max conns / table option | ✅ built — ExpressionField + typed controls | round-trips on PUT |
| SQL sink: write behavior / batch size / metrics | ✅ built | round-trips on PUT |
| File sink: copy behavior | ✅ built | round-trips on PUT |
| Mapping: Import schemas | ✅ built — derives from dataset `properties.schema`/`structure` (already-loaded list) | from `GET /api/adf/datasets` |
| Mapping: explicit grid + type | ✅ built — `MappingTab` → `translator` TabularTranslator | round-trips on PUT |
| Settings: Data integration units | ✅ built — Auto/2…256 Select → `dataIntegrationUnits` | round-trips on PUT |
| Settings: parallelism | ✅ built → `parallelCopies` | round-trips on PUT |
| Settings: staging (LS / path / compression) | ✅ built — staging LS picker filtered to Blob/ADLS | `GET /api/adf/linked-services`; PUT |
| Settings: fault tolerance (skip + redirect) | ✅ built — redirect LS picker | `GET /api/adf/linked-services`; PUT |
| Settings: data consistency | ✅ built → `validateDataConsistency` | round-trips on PUT |
| Activity policy (timeout/retry/secureOutput) | ✅ built — existing "Activity policy" tab (kept) | round-trips on PUT |
| Factory not configured | ⚠️ honest-gate — each tab renders + shows a `MessageBar intent="warning"` naming the missing `LOOM_SUBSCRIPTION_ID`/`LOOM_DLZ_RG`/`LOOM_ADF_NAME` (from the 503 route body) | n/a |

Zero ❌, zero stub banners. Advanced raw-JSON accordions remain on Source/Sink
as an escape hatch for exotic connectors — never required for the happy path.

## Backend per control

- Dataset dropdowns (Source/Sink, Mapping import): `listDatasets()` →
  `GET factories/{f}/datasets?api-version=2018-06-01`.
- Staging / redirect linked-service dropdowns: `listLinkedServices()` →
  `GET factories/{f}/linkedservices?api-version=2018-06-01` (staging filtered to
  `AzureBlobStorage` / `AzureBlobFS` / `AzureDataLakeStore`).
- All field edits patch the in-memory activity and persist with the pipeline on
  `PUT factories/{f}/pipelines/{name}` (existing pipeline-designer Save), then
  Run via the existing `createRun` path.

## Files

UI: `lib/components/pipeline/copy/{source-tab,sink-tab,mapping-tab,copy-settings-tab,use-copy-resources,copy-connector-map}.tsx?`,
`lib/components/pipeline/dataset-picker.tsx`; routing in
`lib/components/pipeline/properties-panel.tsx`; defaults in
`activity-catalog.ts`. No new API routes, env vars, or bicep — uses the
existing ADF datasets/linked-services routes and ADF deployment.

## Verification

- `npx tsc --noEmit` — new files clean (only pre-existing makeStyles px noise).
- `npx vitest run …/copy-connector-map.test.ts …/activities-roundtrip.test.ts`
  — 17/17 green.
- Live (operator): select a Copy node → Source tab pick a real dataset → Sink
  tab pick a real dataset → Save (PUT) → Run → Output shows rows copied. With
  `LOOM_*` ADF env unset, every tab renders and shows the honest infra-gate
  MessageBar instead of going blank.
