# Loom ADF Dataset Editor — Studio-parity spec

> Captured 2026-05-26 by catalog agent. Source: ADF Studio Author tab → Datasets + `learn.microsoft.com/azure/data-factory/concepts-datasets-linked-services` + `concepts-linked-services` + ARM template ref `Microsoft.DataFactory/factories/datasets` (2018-06-01) + Loom `AdfDatasetEditor` (apps/fiab-console/lib/editors/azure-services-editors.tsx:923) + `adf-client.ts`.

## Overview

A Dataset is a named, schema-bound view into a data store referenced by a Linked Service. Datasets are addressable on the ARM provider `Microsoft.DataFactory/factories/datasets`. Every Copy / Lookup / GetMetadata / Data Flow activity reads or writes via a Dataset. Loom exposes datasets on the same ADF instance Loom uses for pipelines (`loom-adf-default-<region>`); the dataset → linked-service → activity chain mirrors Microsoft's documented relationship diagram (`concepts-datasets-linked-services#overview`).

## UI components (ADF Studio Author tab → Datasets)

### Factory resources explorer (left pane)
- **Datasets** folder under the Author tab tree
- Plus sign (+) → **New dataset** launches the new-dataset wizard

### New dataset wizard (modal, three steps)
1. **Choose a data store / connector** — searchable gallery of 90+ ADF connectors (Azure Blob, ADLS Gen2, Azure SQL, Synapse, Cosmos, Snowflake, Salesforce, S3, REST, OData, Oracle, Postgres, etc.)
2. **Select format** — Parquet · DelimitedText (CSV/TSV) · JSON · Avro · ORC · XML · Binary · ExcelFormat (file connectors only; relational connectors skip this step)
3. **Set properties** — Name, Linked service dropdown (with **+ New**), File path / Table name, "Import schema" toggle (From connection / From sample file / None)

### Dataset designer (center, after creation)
- **Connection** tab
  - Linked service dropdown (filtered to compatible types) + **Open** (jump to linked service edit) + **+ New** (create linked service inline)
  - File path / Container / Folder / File name OR Schema · Table (relational) — supports parameterization with `@dataset().param`
  - Format-specific options: compression codec (gzip / bzip2 / deflate / zip / snappy / lz4), column delimiter, row delimiter, quote character, escape character, first row as header (DelimitedText)
  - **Test connection** button
  - **Preview data** button (server-side sample)
- **Schema** tab
  - Column grid: Name · Type · Description
  - **Import schema** dropdown — From connection/store · From sample file · From local file
  - **Clear** schema
- **Parameters** tab — dataset-level parameters (Name · Type {String/Int/Float/Bool/Array/Object/SecureString} · Default value). Used to make datasets reusable across file paths
- **Properties pane** (top-right) — Name, Description, Annotations, **Related** tab (activities and data flows that reference this dataset)

### Partition discovery (file-format datasets)
- For **Parquet / DelimitedText / Avro / ORC / JSON** with hierarchical folder layouts:
  - **Partition discovery** toggle in Copy activity source settings (not in the dataset itself)
  - Dataset's folder path supports `@formatDateTime(pipeline().parameters.windowStart, 'yyyy/MM/dd')` style parameter expressions
  - GetMetadata activity used to enumerate childItems for ForEach iteration

### Connection picker behavior
- Wizard linked-service dropdown is filtered to the chosen connector type (e.g., Parquet dataset → only Azure Storage / ADLS Gen2 / S3 / SFTP / FTP linked services)
- "+ New linked service" launches the linked-service designer in a side drawer (Management Hub also hosts it: `/manage/linkedservices`)

### Toolbar
- **Save all**, **Publish** (Git-mode), **Discard all**, **Validate**, **Code view** ({ } icon — raw JSON edit)

## What Loom has today

- `AdfDatasetEditor` (`apps/fiab-console/lib/editors/azure-services-editors.tsx:923`) — dataset list (tree), select-existing, type dropdown limited to 6 formats: Parquet · DelimitedText · Json · Avro · AzureSqlTable · AzureBlob, linked-service dropdown (real ADF list), file path field, Save
- Backend: `adf-client.ts:listDatasets / getDataset / upsertDataset / deleteDataset` (wired) + `listLinkedServices` (wired for the linked-service dropdown)
- Routes: `/api/items/adf-dataset` (GET list, POST create) + `/api/items/adf-dataset/[id]` (GET/PUT/DELETE)
- Ribbon stub: Schema group with Import schema / Preview data — buttons render but do not wire
- **No** schema grid, **no** Import schema, **no** Test connection, **no** Preview data, **no** parameters tab, **no** Related tab

## Gaps for Studio parity

1. **Connector gallery** — 90+ connector picker for new-dataset wizard (Loom only surfaces 6 hard-coded format types)
2. **Format step** — Parquet/Delimited/JSON/Avro/ORC/XML/Binary/Excel selector with per-format option panel
3. **Schema tab** — column grid (Name · Type · Description) with Import schema (from connection / sample file / local file) and Clear actions
4. **Test connection** button — backed by `POST /linkedservices/{name}/testConnection` or dataset-level connectivity check
5. **Preview data** — backed by the ADF data-plane preview endpoint (requires data flow debug session for some connectors)
6. **Parameters tab** — dataset parameters with `@dataset().param` references in file-path/table-name fields
7. **Properties pane** — Name / Description / Annotations + Related tab (which activities/data flows reference this dataset)
8. **Format-specific options panel** — column delimiter, quote, escape, first-row-as-header, compression codec
9. **Linked service inline creation** — "+ New linked service" drawer from inside the dataset designer
10. **Code view toggle** — raw JSON edit alongside the form (Loom has form only)
11. **Partition / parameterized folder path support** — UI hint that paths can use `@formatDateTime(...)` expressions

## Backend mapping

- ARM REST under `https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.DataFactory/factories/{factory}`:
  - `GET /datasets?api-version=2018-06-01` — list (wired in `adf-client.ts:listDatasets`)
  - `GET/PUT/DELETE /datasets/{name}?api-version=2018-06-01` — get/upsert/delete (wired)
  - `GET /linkedservices?api-version=2018-06-01` — list for the connection picker (wired in `listLinkedServices`)
  - `POST /linkedservices/{name}/testConnection` — connectivity check (gap)
  - Data preview requires a Data Flow debug session: `POST /createDataFlowDebugSession` then `POST /executeDataFlowDebugCommand` — heavyweight, defer
- Dataset JSON shape (per ARM template ref): `properties.type` (connector subtype) + `properties.linkedServiceName` (`LinkedServiceReference`) + `properties.typeProperties` (connector-specific config: `location`, `format`, `compression`, `columnDelimiter`, etc.) + optional `properties.schema[]` and `properties.parameters{}`

## Required Azure resources

- ADF instance (`Microsoft.DataFactory/factories`) — already provisioned as `loom-adf-default-<region>`
- UAMI granted **Data Factory Contributor** at factory scope (already wired)
- For each connector type used: a corresponding **linked service** with valid credentials (Loom assumes linked services are pre-provisioned by the platform — see API-First Data Strategy pillar for the linked-service catalog)
- Managed private endpoints from ADF to backing stores where the data-plane requires PE-only access (Storage, SQL, Synapse, Cosmos)
- For Test connection: outbound network reachability from ADF Integration Runtime to the data store

## Estimated effort

**3-4 sessions.** MVP (1.5 sessions): expand format dropdown to the full common-format set, add Schema tab with manual column add/remove, wire Test connection. Connector gallery + Import schema + Preview data are the heavy half (1.5-2 sessions); Preview data may need to remain best-effort until a debug-session manager is built.

## Notes

- Datasets are essentially "named projections" of linked-service data — the heavy lifting (auth, network, throughput) is on the linked service. Loom's API-First pillar already curates a linked-service starter catalog, so this editor can lean on those
- Linked-service editor is not yet a separate Loom catalog item; the New-linked-service drawer should be a future addition, surfaced from both this editor and the ADF Trigger / Pipeline editors
- The Management Hub also exposes datasets indirectly via integration runtime + linked-service config; Loom can park the Management Hub surface and concentrate on Author-tab parity
