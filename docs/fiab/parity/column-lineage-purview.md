# column-lineage-purview — parity with Purview classic Data Map column lineage

**loom-next-level WS-L / L4.** Push Loom column lineage INTO Purview and read
Purview-native column lineage BACK — closing the metadata-plane loop
bidirectionally on the **classic Data Map** (Commercial + Gov). Builds on L1
(#2403) column facet + L3 (`columnMappings` from ADF Copy). The Loom-native
column model (L1/L5) remains the default and is fully functional without Purview
(`no-fabric-dependency`, `no-vaporware` honest-gate).

Source: Learn "Data lineage user guide for classic Data Catalog → Process column
lineage" (https://learn.microsoft.com/purview/data-gov-classic-lineage-user-guide#process-column-lineage)
and "Data lineage in classic Data Catalog → Column or attribute level lineage"
(https://learn.microsoft.com/purview/data-gov-classic-lineage#lineage-granularity).

## Azure/Fabric feature inventory (classic Data Map column lineage)

| # | Capability (Learn) | Atlas encoding |
|---|--------------------|----------------|
| 1 | **Process column lineage** — per-column arrows on a copy-activity/process node | Process entity `columnMapping` attribute (JSON string) |
| 2 | Column map block shape | `[{ DatasetMapping:{Source,Sink}, ColumnMapping:[{Source,Sink}] }]` |
| 3 | **Column sub-entities** under a dataset (hive_column-style children) | `POST /datamap/api/atlas/v2/entity/bulk` — `<datasetType>_column` with a `table` relationship |
| 4 | **Read** column lineage from a process | `GET /entity/guid/<proc>` → `attributes.columnMapping`; and inline on the lineage subgraph |
| 5 | Entity-grain lineage (upstream/downstream arrows) | Process `inputs[]`/`outputs[]` (GUID refs) |
| 6 | Soft-delete retains history (status DELETED, not purge) | `DELETE /entity/uniqueAttribute/type/<t>?attr:qualifiedName=<qn>` |

## Loom coverage

| # | Coverage | Where |
|---|----------|-------|
| 1 | ✅ push via `createAtlasColumnLineage` (stamps the `columnMapping` attribute on the Process) | `purview-client.ts` |
| 2 | ✅ `buildColumnMappingAttribute` emits the exact ADF-standard shape (pure, unit-tested) | `purview-client.ts` |
| 3 | ✅ `ensureColumnEntities` bulk-creates `<type>_column` children; best-effort (400 type-mismatch → no-op) | `purview-client.ts` + auto-registered on onboard (`purview-autoonboard.autoOnboardToPurview` when the item carries a schema) |
| 4 | ✅ read via `getLineageSubgraph` (inline `columnMapping` → `columnEdges`) + targeted `getProcessColumnMappings`; `parseAtlasColumnMapping` (pure) | `purview-client.ts` |
| 5 | ✅ pre-existing `createAtlasLineage` (entity-grain fallback when no resolvable column map) | `purview-client.ts` |
| 6 | ✅ LIN-GC purges column sub-entities per column, then the parent (`offboardFromPurview`) | `purview-autoonboard.ts` |
| — | ✅ **bidirectional merge into the `col:` identity model** — `recordThreadEdge` routes `columnMappings` → `createAtlasColumnLineage`; `unified-lineage.purviewGraph` folds Purview `columnEdges` into the shared `synthesizeColumnGraph` on the canonical `col:<table>::<column>` key | `thread-edges.ts`, `unified-lineage.ts` |

Zero ❌. No stub banners.

## Backend per control

- **Push (write)** — `POST /datamap/api/atlas/v2/entity` (Process w/ `columnMapping`
  attribute) + `POST /datamap/api/atlas/v2/entity/bulk` (column sub-entities).
  Fired best-effort / fire-and-forget from `recordThreadEdge` (never blocks a
  save), exactly like the existing entity-grain Purview mirror.
- **Read** — `GET /datamap/api/atlas/v2/lineage/<guid>` (inline column maps) +
  `GET /datamap/api/atlas/v2/entity/guid/<guid>` (`getProcessColumnMappings`).
- **Delete** — `DELETE /datamap/api/atlas/v2/entity/uniqueAttribute/...` per
  column, then the dataset.
- **Gate** — reuses the existing `svc-purview` gate; no new env var. When
  `LOOM_PURVIEW_ACCOUNT` is unset the whole block is a silent no-op and the
  Loom-native column model (L1/L5) renders unchanged (default-ON).

## Per-cloud

| Cloud | Status |
|-------|--------|
| **Commercial** | Live — classic Data Map, `<account>.purview.azure.com`. Post-roll receipt: a Weave edge carrying `columnMappings` produces a Purview Process with a `columnMapping` attribute visible in the portal lineage Columns panel + re-read by `getLineageSubgraph`. |
| **Gov (GCC-High)** | Live — classic Data Map (project memory), same Atlas REST on `<account>.purview.azure.us`; the endpoint is cloud-derived (`purview-endpoints.ts`). |
| **IL5** | Design-doc only. Metadata-plane only (no data movement); Purview classic Data Map is IL5-available. Distinction: the **classic** Data Map (not the unified catalog) is the column-lineage surface here. |

## Cost

**~$0.** Reuses the existing Purview account + the existing best-effort mirror
call path — a few extra Atlas REST calls per Weave edge / item onboard. No new
resource.
