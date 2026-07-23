# column-lineage-adf — parity with ADF / Synapse Copy-activity column lineage

**loom-next-level WS-L / L3.** Derive column-level lineage from completed ADF /
Synapse pipeline **Copy-activity** runs (the no-code ingestion path where
OpenLineage isn't emitted) and write it into the Loom L1 column model
(`thread-edges.columnMappings`). Azure-native; no Microsoft Fabric dependency.

Source UI / spec: Azure Data Factory **Copy activity → Mapping tab** and the
Learn reference "Schema and data type mapping in copy activity"
(https://learn.microsoft.com/azure/data-factory/copy-activity-schema-and-type-mapping).
Synapse pipelines share the identical Copy-activity `translator` shape.

## Azure/Fabric feature inventory (Copy-activity column mapping, grounded in Learn)

| # | Capability (Learn) | Encoding in the pipeline JSON |
|---|--------------------|-------------------------------|
| 1 | **Explicit mapping (new model)** — per-column source→sink map | `typeProperties.translator = { type:'TabularTranslator', mappings:[{ source:{name\|ordinal\|path,type?}, sink:{name\|ordinal\|path,type?} }] }` |
| 2 | **Type change / cast** across a mapped column | `source.type ≠ sink.type` on a `mappings[]` entry |
| 3 | **Default mapping (no translator)** — map by column name | `translator` absent → columns come from the source/sink dataset `structure[]` |
| 4 | **Legacy string model** | `translator.columnMappings = "src: dst, src2: dst2"` |
| 5 | **Legacy object model** | `translator.schemaMapping = { "src":"dst", … }` |
| 6 | **Parameterized mapping** (`@pipeline().parameters.mapping`) | `translator = { value:'@…', type:'Expression' }` — resolves only at run time |
| 7 | **Ordinal columns** (delimited text, no header) | `source/sink.ordinal` (1-based) instead of `name` |
| 8 | **Source ⇄ sink dataset references** | Copy activity `inputs[0]` / `outputs[0]` `DatasetReference` |

## Loom coverage

| # | Coverage | Where |
|---|----------|-------|
| 1 | ✅ parsed → `columnMappings` `confidence:'declared'` | `copy-column-mappings.ts` `mappingsFromTranslator` (console) + `extract.ts` (job) |
| 2 | ✅ surfaced as `transform:'CAST(<src>→<sink>)'` on the mapping | `transformFor()` |
| 3 | ✅ auto-map by name when dataset structures are available → `confidence:'derived'` | `deriveByName()`; job resolves `structure[]` via `datasetMatchKeys()` |
| 4 | ✅ parsed → `declared` | `parseLegacyColumnMappings()` |
| 5 | ✅ parsed → `declared` | `schemaMapping` branch |
| 6 | ✅ honest table-grain-only (`mappingKind:'none'`) — no fabricated columns | `mappingsFromTranslator` value-guard |
| 7 | ✅ ordinal token (`#<n>`) used as a stable column id when no name | `columnId()` |
| 8 | ✅ dataset → Loom item resolution (annotation `loomItemId:` first, then physical-endpoint match); both-endpoints-resolve gate | `clients.resolveDataset` + `extract.extractLineageEdges` |

Zero ❌. No stub banners — a Copy with no resolvable column map still records the
item→item (table-grain) edge; an unresolved endpoint is honestly skipped (no
fabricated edges, `no-vaporware`).

## Backend per control

- **Run discovery** — `POST …/queryPipelineRuns` (ADF `2018-06-01` / Synapse
  `2020-12-01`), `Status = Succeeded`, since a Cosmos-persisted watermark.
- **Definitions** — `GET …/pipelines/<name>` + `GET …/datasets/<name>`.
- **Item resolution** — Cosmos `items` container query (`loomItemId` annotation
  or `state.lineageEndpointKeys` physical match).
- **Persistence** — Cosmos `thread-edges` UPSERT with the deterministic
  `edge_<tenant>_<from>_<to>_<action>` id (idempotent; re-processing a run never
  duplicates). Column mappings ride the L1 `columnMappings` facet.
- **Compute host** — in-VNet **Container App Job** (Schedule trigger, default
  `*/15 * * * *`), `modules/admin-plane/lineage-extractor-job.bicep`, wired via
  `observabilityConfig.lineageExtractorEnabled` (default-ON, opt-out).

## Estate deviation from the L3 spec (recorded)

The L3 spec text called for a **Y1 Linux Consumption Function**. Per the
2026-07-23 estate finding, Y1 Functions are structurally broken on this estate
(Azure Policy seals the storage data-plane — `publicNetworkAccess=Disabled`,
AAD-only, no PE — and the multitenant Y1 runtime is not a trusted service, so
host keys / timer leases fail). The extractor is therefore an **in-VNet ACA Job**
(the `synthetic-monitor-job.bicep` precedent, proven live by loom-uat /
gh-aca-runner). Same behavior, same cron cadence, managed-identity only (no
storage account, no keys — strictly better than the Y1 design).

## Per-cloud

| Cloud | Status |
|-------|--------|
| **Commercial** | Live — ADF/Synapse + Container Apps Jobs + Cosmos all GA. Post-roll receipt: seed a SQL→lakehouse Copy with an explicit mapping, run it, confirm `columnMappings` on `GET /api/catalog/lineage?...&columns=true`. |
| **Gov (GCC-High)** | Live — Container Apps Jobs, ADF, Synapse, Cosmos all GA in Gov; `.usgovcloudapi.net` ARM + `dev.azuresynapse.usgovcloudapi.net` Synapse-dev endpoints resolved from `environment()`. |
| **IL5** | Design-constraint documentation only (no live run). Metadata-plane only — the extractor reads pipeline/run/dataset **definitions** + writes lineage metadata to Cosmos; it moves **no data**. All dependencies (ACA Jobs, ADF, Synapse, Cosmos) are IL5-authorized; the ACA-job pattern is the IL5-safe path (no Y1). |

## Cost

~$0. Scale-to-zero scheduled ACA Job: idle $0/mo; a 15-min pass consumes a few
vCPU-seconds (0.5 vCPU / 1 GiB) — cents/month. No storage account. Tagged
`loom-next-level` so the program budget bounds it.
