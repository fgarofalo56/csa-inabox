# Parity gap — `adf-dataset`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Azure Data Factory Studio → Author → Datasets.
> Loom route: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/adf-dataset/new`.
> Editor source: `apps/fiab-console/lib/editors/azure-services-editors.tsx` (lines 967-1159).

## Phase 3 — gap matrix vs ADF Dataset editor

| # | ADF Studio dataset element | Loom present? | Severity |
|---|---|---|---|
| 1 | Dataset list tree + "+ New dataset" | Present (lines 1095-1112) | OK |
| 2 | Type selector (Parquet / Delimited Text / JSON / Avro / Azure SQL Table / Azure Blob + 50+ more) | Partial — 6 types in `ADF_DATASET_TYPES` (line 965). ADF supports ~80 type connectors. | MAJOR |
| 3 | Linked-service picker with type badge + reachability test | Partial — dropdown (lines 1132-1137) with type label. No test-connection button. | MAJOR |
| 4 | Path / Table-name editor with wildcard hints | Present (lines 1139-1142) | OK |
| 5 | Schema editor (import / map columns / set types) | **Read-only** — schema table renders existing columns but no Import-schema button, no edit (lines 1143-1154). Caption directs user to ADF Studio (line 1148: "Use ADF Studio 'Import schema' to populate"). | MAJOR (honest gate but functionality missing) |
| 6 | Preview data (sample 100 rows from path / table) | MISSING — ribbon claims "Preview data" (line 951) but no handler | MINOR (ribbon vapor) |
| 7 | Parameters tab | MISSING | MAJOR |
| 8 | Connection tab (compression, encoding, escape chars) | MISSING | MAJOR |
| 9 | Save button | Present (lines 1117-1119) — real PUT | OK |
| 10 | Status bar | MISSING | MINOR |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| Dataset list click | `setSelected(name)` → `loadDataset` (line 1000-1018) | Real |
| Type dropdown | `setType(...)` local state | Real |
| Linked-service dropdown | `setLinkedService(...)` local state | Real |
| Path input | `setPath(...)` local state | Real |
| **Save** | `save()` (line 1023-1065) — builds typeProperties per type, real `PUT /api/items/adf-dataset/{name}` | Real |
| **+ New dataset** | `createNew()` (line 1067-1093) — real `POST` | Real |
| Ribbon "Import schema" / "Preview data" | No handlers | **DEAD** — 2 ribbon vapor |

## Grade

**C** — Save / load / list / type-select / create-new are real-REST. The form correctly maps each dataset type to the right `typeProperties` shape (line 1031-1046), which is non-trivial.

But Schema editing is acknowledged-unimplemented (read-only with "use ADF Studio" caption — honest config gate but feature missing per Fabric parity). 6 dataset types vs ADF's 80+ is a MAJOR gap. No Preview, no Parameters, no Connection settings. 2 dead ribbon buttons.

Honest config-only gates align with `no-vaporware.md` so this isn't F or D. But it's a CRUD form against an ARM endpoint, not a Fabric-parity dataset editor.

