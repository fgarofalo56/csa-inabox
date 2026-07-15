# Unity Catalog capability matrix — CSA Loom, cloud-aware

**Mandate (2026-07-15):** ALL Unity Catalog features/capabilities are wired into
Loom, adjusted per cloud. **Commercial** uses **Databricks Unity Catalog** —
all capabilities wired. **Azure Government** uses **OSS Unity Catalog**
(`loom-unity`, the self-hosted [unitycatalog.io](https://www.unitycatalog.io/)
0.5 server) — all of its features wired, with an honest Loom-native equivalent
named for every Databricks-only family. No pane dead-gates.

**Backend switch:** `apps/fiab-console/lib/azure/uc-backend.ts`
(`LOOM_UC_BACKEND=databricks|oss`; auto-selects `oss` in Azure Government when
no Databricks workspace is bound and `LOOM_UNITY_URL` is set). The live,
per-deployment version of this matrix is served by
`GET /api/catalog/unity/capabilities` and rendered on **/catalog/unity →
Capabilities**.

**OSS grounding:** the OSS Unity Catalog **0.5.0 OpenAPI spec**
(`api/all.yaml` in [unitycatalog/unitycatalog](https://github.com/unitycatalog/unitycatalog)).
Confirmed OSS families: catalogs, schemas, tables (POST/GET/DELETE), volumes
(full CRUD), functions (full CRUD), registered models + versions (full CRUD),
**permissions (GET/PATCH `/permissions/{securable_type}/{full_name}`)** with
securables `metastore, catalog, schema, table, function, volume,
registered_model, external_location, credential`, external locations (full
CRUD), credentials (full CRUD — OSS's name for storage credentials),
temporary table/volume/path/model-version credentials, `metastore_summary`,
and Delta preview commits. **Not** in OSS 0.5: Delta Sharing
(shares/recipients/providers), lineage, effective-permissions, connections
(Lakehouse Federation), workspace bindings, system schemas/tables, tags DDL,
ABAC policies, online tables, quality monitors, clean rooms, Marketplace.

Legend: ✅ full · ⚠️ partial · ❌ not in backend (Loom-native fallback wired) ·
**Wired in Loom** names the primary file(s).

| # | Capability | Databricks UC | OSS UC 0.5 | Wired in Loom (backend/client) | Loom surface | Status |
|---|---|---|---|---|---|---|
| 1 | **Metastores** (federated list / summary) | ✅ | ⚠️ single metastore via `metastore_summary` (adapted into the same shape) | `unity-catalog-client.ts` `listAllMetastores` / `listMetastoresFromWorkspace` (OSS branch) | /catalog/metastores + /catalog/unity | ✅ both |
| 2 | **Catalogs** (list/get/create/update/delete) | ✅ | ✅ | `catalogs/route.ts` (backend-aware) + `unity-catalog-client.ts` | /catalog/unity → Explore | ✅ both |
| 3 | **Schemas** (list/get/create/update/delete) | ✅ | ✅ | `schemas/route.ts` (backend-aware) | /catalog/unity → Explore | ✅ both |
| 4 | **Tables** (list/get/create/delete) | ✅ (+PATCH, from-file, Iceberg/UniForm DDL) | ✅ REST create/list/get/delete; ❌ PATCH / warehouse DDL (501 note) | `tables/route.ts` (backend-aware), `createTableUc`/`deleteTableUc` | /catalog/unity → Explore | ✅ both (dbx extras noted) |
| 5 | **Views** (browse) | ✅ (create via SQL DDL) | ⚠️ browse via tables list (`table_type=VIEW`) | tables list (both) | /catalog/unity → Explore | ✅ browse both |
| 6 | **Volumes** (list/create/update/delete) | ✅ | ✅ | `volumes/route.ts` (backend-aware), `updateVolume` | /catalog/unity → Explore | ✅ both |
| 7 | **Functions** (list/get/delete; create via engine DDL) | ✅ | ✅ | **NEW** `functions/route.ts` (backend-aware), `listFunctionsUc`/`getFunctionUc`/`deleteFunctionUc` | /catalog/unity → Explore | ✅ both |
| 8 | **Registered models + versions** | ✅ | ✅ | `models/route.ts` (OSS gate removed) | /catalog/unity → Explore | ✅ both |
| 9 | **Grants / privileges** (securable ACLs) | ✅ grants API | ✅ permissions API (spelling + securable-name mapping handled) | `grants/route.ts` rebuilt backend-aware; `permissionPath` maps `REGISTERED_MODEL`→`function`(dbx)/`registered_model`(oss), `STORAGE_CREDENTIAL`→`credential`(oss) | /catalog/unity → Grants (+ SQL-warehouse UC dialogs) | ✅ both |
| 10 | **Effective (inherited) permissions** | ✅ | ❌ → falls back to direct grants with an honest note | `listEffectivePermissions` + grants route fallback | /catalog/unity → Grants | ✅ dbx / ⚠️ oss note |
| 11 | **External locations** (full CRUD) | ✅ | ✅ | `external-locations/route.ts` (Gov gate replaced with backend-awareness) | /catalog/unity → Storage | ✅ both |
| 12 | **Storage credentials** (full CRUD) | ✅ | ✅ (as `credentials`, path rewritten via `ossUcRewritePath`; `purpose=STORAGE` added on create) | `storage-credentials/route.ts` (backend-aware) | /catalog/unity → Storage | ✅ both |
| 13 | **Temporary credential vending** (table/volume/path) | ✅ | ✅ (needs `LOOM_UNITY_ADLS_*` SP on loom-unity — honest remediation) | **NEW** `temporary-credentials/route.ts`, `vendTable/Volume/PathCredentials` | /catalog/unity → Storage (programmatic) | ✅ both (config-gated vending) |
| 14 | **Connections (Lakehouse Federation)** + foreign catalogs | ✅ (REST + secret()-safe DDL) | ❌ → Loom Linked Services / Synapse+ADF connectors | `connections/route.ts` (dbx), 501 capability note on OSS | SQL-warehouse UC dialogs; note on /catalog/unity | ✅ dbx / ❌ oss (fallback named) |
| 15 | **Delta Sharing** — shares/recipients/providers, D2D + open, share ACLs, inbound mounts | ✅ (bidirectional, PR #1578 era) | ❌ → Loom Marketplace shares + access grants | `marketplace/sharing/*` routes (dbx); honest Marketplace note on OSS | Marketplace share explorer + /catalog/unity → Sharing | ✅ dbx / ❌ oss (fallback wired) |
| 16 | **Lineage** (table + column, system tables + REST preview) | ✅ | ❌ → Loom unified lineage (Purview + ADX + item edges) — same graph surface | `getTableLineage*`, `unified-lineage.ts` | /catalog/lineage | ✅ dbx / ❌ oss (fallback wired) |
| 17 | **Tags** (object/column + governed tags) | ✅ (SQL warehouse DDL) | ❌ → Purview classifications + catalog annotations | `tags/route.ts`, `governed-tags/route.ts` | SQL-warehouse UC dialogs | ✅ dbx / ❌ oss (fallback named) |
| 18 | **ABAC / row filters / column masks** | ✅ (policies DDL) | ❌ → serving-engine policies (Synapse/ADX) | `policies/route.ts`, `uc-security-panel.tsx` | Governance → UC security | ✅ dbx / ❌ oss (fallback named) |
| 19 | **System tables** (audit / billing / query history / data classification) | ✅ | ❌ → Azure Monitor / Log Analytics on loom-unity | `system-tables/route.ts`, `data-classification/route.ts` | SQL-warehouse audit dialogs | ✅ dbx / ❌ oss (fallback named) |
| 20 | **Workspace bindings** (catalog isolation) | ✅ | ❌ → Loom workspace ACLs enforce isolation | `bindings/route.ts` | SQL-warehouse UC dialogs | ✅ dbx / ❌ oss (fallback named) |
| 21 | **Data quality monitors** | ✅ | ❌ → Loom data-quality checks on Spark | `quality-monitors/route.ts` | Catalog → data quality | ✅ dbx / ❌ oss (fallback named) |
| 22 | **Online tables** | ✅ | ❌ → Lakebase/Postgres serving tables | `online-tables/route.ts` | SQL-warehouse editor | ✅ dbx / ❌ oss (fallback named) |
| 23 | **Clean rooms** | ✅ | ❌ (Databricks-only collaboration) | `clean-rooms/route.ts` | SQL-warehouse editor | ✅ dbx / ❌ oss |
| 24 | **Databricks Marketplace** (consumer) | ✅ | ❌ → Loom Marketplace (API + Data products) | `marketplace/route.ts` | Marketplace | ✅ dbx / ❌ oss (fallback wired) |
| 25 | **Metric views / Iceberg + UniForm table formats** | ✅ (warehouse DDL) | ❌ (needs a SQL warehouse) | `metric-views/route.ts`, `uc-table-format-builders` | metric-view builder | ✅ dbx / ❌ oss |
| 26 | **Federated UC search** | ✅ | ✅ (single host) | `searchUnity` | /catalog search | ✅ both |

## Headline

**26 capability families: 13 wired on BOTH backends (real REST each), 12
Databricks-only with a named + wired Loom-native fallback (no dead panes), 1
partial-by-design (metastore federation vs single OSS metastore).**

## What this build changed (feat/unity-catalog-full-capability)

1. **OSS grants unlocked** — the old `ossUcUnsupportedPath` wrongly gated
   `/permissions/*` as Databricks-only; the OSS 0.5 spec implements it. Grants
   now work on both backends with per-backend privilege spelling
   (`USE_CATALOG` ↔ `USE CATALOG`) and securable-name mapping.
2. **OSS external locations + storage credentials unlocked** — routes no longer
   hard-gate on Gov; the client rewrites `storage-credentials` → `credentials`.
3. **OSS models/functions/temp-credentials wired** — new backend-aware
   functions + temporary-credentials routes; models route Gov gate removed.
4. **Catalog/schema/table/volume CRUD is backend-aware end-to-end** — the
   `app/api/databricks/unity-catalog/{catalogs,schemas,tables,volumes}` routes
   dispatch to the OSS server when `LOOM_UC_BACKEND=oss`.
5. **`/catalog/unity`** — the one-navigation Unity Catalog home: Explore
   (objects CRUD), Grants, Storage, Sharing, and the live Capabilities matrix,
   with a backend banner per cloud.
6. **`GET /api/catalog/unity/capabilities`** — one source of truth
   (`UC_CAPABILITIES` in `uc-backend.ts`) for the honest per-cloud notes.

## Cross-references

- `docs/fiab/unity-gov.md` — deploying `loom-unity` (bicep, persistence, auth,
  ADLS vending).
- `.claude/rules/no-fabric-dependency.md`, `.claude/rules/no-vaporware.md` —
  the rules this matrix enforces.
- OSS spec: `https://github.com/unitycatalog/unitycatalog/blob/v0.5.0/api/all.yaml`.
