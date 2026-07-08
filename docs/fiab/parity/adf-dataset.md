# adf-dataset — parity with Azure Data Factory **datasets**

> **Scope note — this is an ADF sub-feature, not a standalone service.** In the
> real product, datasets are authored *inside* Azure Data Factory Studio under
> **Author → Datasets** (and referenced by pipeline activities and mapping data
> flows). In Loom the same object is a first-class catalog item
> (`slug: adf-dataset`, `restType: AdfDataset`, category **Azure Data Factory**)
> whose editor (`AdfDatasetEditor`) lives in
> `apps/fiab-console/lib/editors/azure-services-editors.tsx`. It is a peer of
> [`adf-data-factory.md`](./adf-data-factory.md) (the whole Studio),
> [`adf-pipeline.md`](./adf-pipeline.md), [`adf-trigger.md`](./adf-trigger.md),
> and [`adf-factory-resources.md`](./adf-factory-resources.md), which remain the
> authoritative docs for the surfaces around it.

**Catalog description:** "Typed dataset over linked services — JSON, Parquet,
Delimited, SQL, REST, etc."

**No-Fabric note:** datasets are a *pure Azure* object — they live on
`Microsoft.DataFactory/factories/{f}/datasets`. There is no Fabric dependency
on any code path; the backend is always ARM Data Factory REST.

Source UI: **Azure Data Factory Studio → Author → Datasets** (`https://adf.azure.com`)
- Datasets & linked services concepts: <https://learn.microsoft.com/azure/data-factory/concepts-datasets-linked-services>
- Dataset REST (`Datasets - Create Or Update`): <https://learn.microsoft.com/rest/api/datafactory/datasets/create-or-update>
- Delimited text / Parquet / JSON dataset properties: <https://learn.microsoft.com/azure/data-factory/format-delimited-text>
- Schema & data-type mapping: <https://learn.microsoft.com/azure/data-factory/copy-activity-schema-and-type-mapping>

## Azure/ADF feature inventory (Author → Datasets)

| # | Capability in ADF Studio | Notes |
|---|--------------------------|-------|
| 1 | **New dataset wizard** — pick connector store (Blob/ADLS/SQL/REST/Cosmos/Dynamics/…), then format (DelimitedText, Parquet, JSON, Avro, ORC, Binary) | data-store gallery of 90+ connectors |
| 2 | **Linked service reference** — bind the dataset to an existing linked service (or create one inline) | `linkedServiceName` |
| 3 | **Connection / Location** — file system (container) / folder / file name; SQL schema+table; REST relative URL; Cosmos collection; Dynamics entity | connector-specific `typeProperties` |
| 4 | **Format settings** — column delimiter, row delimiter, encoding, escape/quote chars, compression codec, first-row-as-header, null value | delimited-text/format panels |
| 5 | **Schema tab** — import schema (from connection / sample file), add/remove/rename columns, set column data types, clear schema | `structure` / `schema` array |
| 6 | **Parameters tab** — dataset parameters + reference them via `@dataset().param` in location/filename | dynamic content |
| 7 | **Preview data** — sample rows from the store (requires an active debug/IR session) | live preview |
| 8 | **Save / Publish** — persist to the factory (Git-mode: commit; Live-mode: publish) | source control |
| 9 | **Dataset list tree** grouped by connector; open / clone / delete | Author tree |
| 10 | REST-method + pagination rule (REST dataset); compression for file datasets | connector detail |

## Loom coverage

Backend factory reached via ARM REST (`Microsoft.DataFactory/factories/{name}/datasets`,
api-version pinned in `adf-client.ts`) through the Loom BFF
(`/api/items/adf-dataset` GET/POST, `/api/items/adf-dataset/[id]` GET/PUT/DELETE).
Factory coordinates come from `LOOM_ADF_NAME` + `LOOM_SUBSCRIPTION_ID`/`LOOM_ADF_SUB`
+ `LOOM_DLZ_RG`/`LOOM_ADF_RG`; when unset the editor renders and shows an honest
`BackendStateBar` naming the missing env var.

| # | Capability | Status | Detail |
|---|-----------|--------|--------|
| 1 | New dataset (type picker) | built ✅ | `+ New dataset` → seeds a DelimitedText dataset; **Type** dropdown covers `ADF_DATASET_TYPES` (DelimitedText, Parquet, Json, Avro, Orc, Binary, AzureSqlTable, Cosmos, RestResource, Dynamics…) |
| 2 | Linked-service reference | built ✅ | **Linked service** dropdown populated live from `/api/adf/linked-services`; container-label derives from the LS connector type |
| 3 | Location (file/SQL/REST/Cosmos/Dynamics) | built ✅ | guided fields per type family — `FILE_DS_TYPES` (container/folder/file/compression), `TABLE_DS_TYPES` (schema/table), `REST_DS_TYPES` (relativeUrl/method/pagination), `COSMOS_DS_TYPES` (collection), `DYNAMICS_DS_TYPES` (entity). **No raw `typeProperties` JSON** (`loom_no_freeform_config`) — `buildDatasetTypeProperties`/`readDatasetTypeProperties` round-trip it |
| 4 | Delimited-text format settings | built ✅ | column/row delimiter dropdowns, encoding, quote & escape chars, compression codec, first-row-as-header switch |
| 5 | Schema editing | built ✅ | inline schema table: add column, edit name, pick type (String/Int32/Int64/Decimal/Double/Boolean/DateTime/Date/Guid/Binary), delete, clear — persisted with the dataset PUT |
| 5a | **Import schema from connection/sample** | honest-gate ⚠️ | ADF's "Import schema" needs an interactive debug/IR session; the editor states this and offers manual column typing instead |
| 7 | Preview data | MISSING ❌ | no in-editor row preview (same debug-session limitation); not exposed |
| 6 | Dataset parameters (`@dataset().x`) | honest-gate ⚠️ | filename accepts `@dataset().fileName` expressions (persisted verbatim), but there is no dedicated Parameters tab/repeater |
| 8 | Save / Publish | built ✅ (Save) / n-a | **Save** (+ Ctrl+S) PUTs the whole dataset (schema included) via ADF REST — Live-mode publish; Git-mode Publish/PR flow is a factory-wide gap tracked in `adf-data-factory.md` |
| 9 | Dataset list + open/delete | built ✅ (list/open) / partial | left `Tree` lists datasets; DELETE route exists (`deleteDataset`); no clone-in-UI |
| 10 | REST method + pagination, compression | built ✅ | REST resource section (relative URL, GET/POST, pagination next-URL); compression dropdown for file datasets |

## Backend per control

| Loom control | Route | Azure backend |
|--------------|-------|---------------|
| Dataset list | `GET /api/items/adf-dataset` → `listDatasets()` | ARM `GET …/factories/{f}/datasets` |
| Open dataset | `GET /api/items/adf-dataset/{id}` → `getDataset()` | ARM `GET …/datasets/{name}` |
| Save / create | `PUT`/`POST /api/items/adf-dataset[/{id}]` → `upsertDataset()` | ARM `PUT …/datasets/{name}` |
| Delete | `DELETE /api/items/adf-dataset/{id}` → `deleteDataset()` | ARM `DELETE …/datasets/{name}` |
| Linked-service dropdown | `GET /api/adf/linked-services` | ARM `GET …/linkedservices` |

**Grade: B.** Full typed-dataset authoring (create/edit/schema/save/delete) on real
ADF REST with guided (non-JSON) config for the major connector families. The
honest gaps are the two capabilities ADF itself gates behind an interactive
debug/IR session — **Import schema** and **Preview data** — plus a dedicated
Parameters tab and Git-mode Publish (a factory-wide item, not a dataset one).
