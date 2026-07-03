# Parity gap — `adf-dataset`

> v2 fabric-parity-loop validator, run 2026-05-26.
> **Updated 2026-06-11 (audit-T96):** the freeform Path field was replaced with a
> guided location/format builder (`lib/azure/adf-dataset-builder.ts`), shared with
> the Manage-hub dataset dialog. Resolves the `loom_no_freeform_config` violation
> and adds Connection settings (compression / delimiter / encoding / quote / escape /
> first-row-as-header) + relational schema+table inputs. See rows 2, 4, 8 below.
> Reference target: Azure Data Factory Studio → Author → Datasets.
> Loom route: `https://<your-console-hostname>/items/adf-dataset/new`.
> Editor source: `apps/fiab-console/lib/editors/azure-services-editors.tsx` (AdfDatasetEditor).

## Phase 3 — gap matrix vs ADF Dataset editor

| # | ADF Studio dataset element | Loom present? | Severity |
|---|---|---|---|
| 1 | Dataset list tree + "+ New dataset" | Present | OK |
| 2 | Type selector (Parquet / Delimited Text / JSON / Avro / ORC / Binary / Azure SQL / SQL DW + 50+ more) | Built — 8 common file + relational types via shared `DS_TYPES`. ADF supports ~80 connector types; common set covered. | MINOR (long-tail connectors deferred) |
| 3 | Linked-service picker with type badge + reachability test | Partial — dropdown with type label. No test-connection button. | MAJOR |
| 4 | Location / format builder (container/folder/file + format options) | **Built** — guided per-connector location (fileSystem/bucketName/container) + folder + file, no raw JSON. | OK |
| 5 | Schema editor (import / map columns / set types) | Functional — add/edit/clear columns inline, saved via PUT. Import-schema needs an interactive debug session (honest gate). | OK (honest gate) |
| 6 | Preview data (sample 100 rows from path / table) | MISSING — no dead ribbon button (removed) | MINOR |
| 7 | Parameters tab | MISSING | MAJOR |
| 8 | Connection tab (compression, encoding, escape chars) | **Built** — compression codec, column/row delimiter, encoding, quote/escape, first-row-as-header for DelimitedText. | OK |
| 9 | Save button | Present — real PUT | OK |
| 10 | Status bar | MISSING | MINOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| Dataset list click | `setSelected(name)` → `loadDataset` | Real |
| Type dropdown | `setType(...)` local state | Real |
| Linked-service dropdown | `setLinkedService(...)` local state | Real |
| Location/format builder | container/folder/file + format-option state → `buildDatasetTypeProperties()` | Real |
| **Save** | `save()` — builds typeProperties via shared builder, real `PUT /api/items/adf-dataset/{name}` | Real |
| **+ New dataset** | `createNew()` — real `POST` | Real |

## Grade

**B** — Save / load / list / type-select / create-new / schema-edit are real-REST, and
typeProperties is now produced by a typed guided builder (no freeform path / implicit JSON),
emitting the correct per-connector `location.type` + per-format options. Confirmed against
the `Microsoft.DataFactory/factories/datasets@2018-06-01` ARM schema and unit-tested.

Remaining gaps to A: per-dataset Parameters tab, test-connection, and the long-tail of
~80 ADF connector types (common file + relational set is covered).


