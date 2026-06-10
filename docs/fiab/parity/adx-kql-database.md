# adx-kql-database — parity with Azure Data Explorer / Fabric Eventhouse (KQL database object navigator)

> **rev.2 — corrected against current code (PR #536).** The navigator now has a
> real read-only **Database policies** group (db-level retention / caching /
> sharding / mergepolicy / streamingingestion via `.show database <db> policy
> <kind>` through `/api/adx/policies`). The two policy rows below were flipped
> from "coming" to reflect that db-level policies are now genuinely **read** in
> the tree; per-table & inline-`.alter` authoring stays an honest ⚠️ gate.

Source UI: the **Azure Data Explorer web UI** (`https://dataexplorer.azure.com`)
and **Microsoft Fabric Eventhouse → KQL database** schema tree. Once a KQL
database is open, its left pane is a typed navigator of the database's objects
(Tables, Functions, Materialized views, Ingestion mappings, …) with per-group
counts, ＋ New, a filter, and per-object open/delete actions. The Loom
equivalent (`apps/fiab-console/lib/components/adx/adx-database-tree.tsx`) is
wired into the KQL database editor's left pane
(`lib/editors/phase3-editors.tsx → KqlDatabaseEditor`). This is the ADX/Kusto
sibling of the Synapse Workspace Resources and Databricks workspace navigators
(parity wave 3). Grounded in Microsoft Learn:

- Tables management (`.create table` / `.drop table` / `.show tables details`):
  https://learn.microsoft.com/kusto/management/tables
- Functions (`.create-or-alter function` / `.drop function` / `.show functions`):
  https://learn.microsoft.com/kusto/management/functions
- Materialized views (`.create materialized-view` / `.drop materialized-view` / `.show materialized-views`):
  https://learn.microsoft.com/kusto/management/materialized-views/materialized-view-create
- Ingestion mappings (`.create-or-alter … ingestion <kind> mapping` / `.drop … ingestion mapping` / `.show ingestion mappings`):
  https://learn.microsoft.com/kusto/management/mappings
- Database schema (`.show database schema as json`):
  https://learn.microsoft.com/kusto/management/show-schema-database
- Continuous data export (`.show continuous-exports` — read-only here):
  https://learn.microsoft.com/kusto/management/data-export/continuous-data-export
- Update policy / retention / caching / row-level-security policies (deferred authoring):
  https://learn.microsoft.com/kusto/management/update-policy ,
  https://learn.microsoft.com/kusto/management/retention-policy ,
  https://learn.microsoft.com/kusto/management/cache-policy ,
  https://learn.microsoft.com/kusto/management/row-level-security-policy

Data-plane host: **`https://<cluster>.kusto.windows.net`** (or Fabric
`https://<…>.kusto.fabric.microsoft.com`). Object enumeration + mutation is via
**control commands** POSTed to **`/v1/rest/mgmt`** with a `{ db, csl }` body.
Token scope: **`<cluster-uri>/.default`**. Auth:
`ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
DefaultAzureCredential)` — the same credential the existing `kusto-client.ts`
already uses (the Loom UAMI holds AllDatabasesAdmin on the shared cluster). The
target **database is item-scoped**: each `kql-database` Cosmos item carries its
own `state.databaseName`, resolved + tenant-verified via `loadKustoItem` (same
resolution the existing `/api/items/kql-database/[id]` routes use). The
navigator passes the item id to every BFF call as `?id=`.

## Azure / Fabric feature inventory

For the ADX web UI / Fabric KQL database schema tree, each object type exposes a
**list with count**, a **＋ New** wizard, a **filter**, and per-object
**open (load into query) / delete** actions:

| # | ADX/Fabric object | Capabilities in the real UI |
|---|-------------------|------------------------------|
| 1 | **Tables** | list w/ count + row count + size, New (column schema builder / `.create table`), open (take 100), drop, table schema |
| 2 | **Functions** | list w/ count, New + **Edit** (params grid `name:type` + KQL body / `.create-or-alter function`), open (invoke), drop |
| 3 | **Materialized views** | list w/ count, New (source table + aggregation query / `.create materialized-view`), open, drop |
| 4 | **Ingestion mappings** | list w/ count (csv/tsv/psv/json/avro/parquet/orc), **New mapping wizard** (format selector + sample-file schema auto-detect + source→column→datatype grid / `.create-or-alter … mapping`), drop |
| 5 | **Database schema** | view the flat schema (`.show database schema [as json]`) |
| 6 | **Continuous export** | list jobs (`.show continuous-exports`), create over an external table, enable/disable, drop |
| 7 | **Update policies** | per-table transform-on-ingest (`.alter table T policy update`) |
| 8 | **Retention / caching policies** | per-table & per-db hot-cache + soft-delete (`.alter … policy retention/caching`) |
| 9 | **Row-level security** | per-table RLS predicate (`.alter table T policy row_level_security`) |
| 10 | **External tables** | Blob/ADLS/SQL external tables (`.create external table`) — continuous-export targets |
| 11 | **Security — database roles** | RBAC principals per role (`.show/.add/.drop database <db> <role> ('fqn')`): admins, users, viewers, unrestrictedviewers, ingestors, monitors |
| — | Top toolbar | **New** menu, **Filter objects by name** |

## Loom coverage

Built ✅ / honest-gate ⚠️ / MISSING ❌. Surface:
`apps/fiab-console/lib/components/adx/adx-database-tree.tsx`, wired into the KQL
database editor's left pane. Selecting a table/MV/function loads a query into
the existing Monaco KQL editor + focuses it (existing Run flow). Pre-save
(`id === 'new'`) shows an honest "save first" MessageBar.

| Capability | Status | Notes |
|------------|--------|-------|
| KQL-database typed navigator (groups + live counts) | ✅ | Fluent `Tree`, one branch per object type, count from real `.show` |
| Filter objects by name | ✅ | top `Input` filters every group client-side |
| New menu (top) + ＋ New per group | ✅ | Fluent `Menu` → Table / Function / Materialized view / Ingestion mapping |
| **Tables** — list / count / row-count / size | ✅ | `GET /api/adx/tables` → `.show tables details` |
| **Tables** — New (schema builder textarea) | ✅ | `POST /api/adx/tables` → `.create table T (col:type, …)` |
| **Tables** — open (take 100) | ✅ | row click loads `["T"] \| take 100` into the editor |
| **Tables** — drop | ✅ | `DELETE /api/adx/tables?name=` → `.drop table T ifexists` |
| **Functions** — list / count / open / **create + edit + drop** | ✅ | structured stored-function editor (name field, **params grid** `name:type` with a typed dropdown, **Monaco KQL body**, save + delete, success receipt) owned by `KqlDatabaseEditor`, opened from the ribbon (New → Function) and the navigator's per-row **Edit** action. `GET/POST/DELETE /api/adx/functions` → `.show functions` (Body surfaced for edit) / `.create-or-alter function NAME(args){body}` / `.drop function` |
| **Materialized views** — list / count / open / create / drop | ✅ | `GET/POST/DELETE /api/adx/materialized-views` → `.show materialized-views` / `.create materialized-view NAME on table SRC {query}` / `.drop materialized-view` |
| **Materialized views** — backfill on create | ✅ | Backfill toggle in the create wizard → `POST .../materialized-views {backfill:true}` → `.create async materialized-view with (backfill=true) NAME on table SRC {query}`; receipt notes the async operation. Source-table picker + monaco-kusto KQL body in the KqlDatabaseEditor ribbon wizard. |
| **Ingestion mappings** — list / count / drop | ✅ | `GET/DELETE /api/adx/ingestion-mappings` → `.show ingestion mappings` / `.drop <table\|database> … ingestion <kind> mapping "N"` |
| **Ingestion mappings** — New **mapping wizard** (format + auto-detect grid) | ✅ | Two-step `IngestionMappingWizardDialog` (`ingestion-mapping-wizard.tsx`): format selector (CSV/TSV/PSV/JSON/Parquet/Avro/ORC), upload a sample file → client-side `detectSchema` populates a source→column→datatype grid (Ordinal for tabular, `$.path` for JSON/ORC/Parquet, Field for Avro), `POST /api/adx/ingestion-mappings` → `.create-or-alter table T ingestion <kind> mapping "N" 'json'`. On create, injects a `.show table T ingestion mappings` + test-`.ingest` snippet into the editor. Wire format grounded in Learn (`kusto/management/mappings`) |
| **Get data** — ingest a file with format + mapping reference | ✅ | KQL-database ribbon **Data → Get data** wizard: format selector + optional `ingestionMappingReference`; small text files (≤5 MB) → real `.ingest inline into table T with (format=…, ingestionMappingReference=…)`; Parquet/Avro/ORC → generates the real `.ingest into … from @'blob'` command template (inline unsupported for binary) |
| **Database schema** — show full schema | ✅ | branch row loads `.show database schema` into the editor; `GET /api/adx/overview` also returns `.show database schema as json` |
| **Continuous export** — list (read-only) | ✅ | `GET /api/adx/overview` → `.show continuous-exports`; status badge (running/disabled/last-result) |
| **Continuous export** — create / enable / disable / drop | ⚠️ | honest "coming" row — authoring needs an external table + Database Admin (`.create-or-alter continuous-export over (T) to ExternalTable <\| query`); listed read-only above |
| **Database policies** — list (read-only) | ✅ | **Now built (PR #536).** A **Policies group** lists db-level retention/caching/sharding/mergepolicy/streamingingestion via `GET /api/adx/policies` → `showDatabasePolicies()` → real `.show database <db> policy <kind>` (`kusto-client.ts:342`, tree `:423-440`); raw policy JSON in a tooltip |
| **Update policies** | ⚠️ | honest "coming" row — `.alter table T policy update`; the KQL database **ribbon** (New → Update policy) already authors these via the query route, not the navigator yet |
| **Retention / caching policies** (authoring) | ⚠️ | db-level retention/caching are now **read** in the Policies group above (✅, real `.show database … policy`); per-table & inline-`.alter` **authoring** remains an honest "coming" row — `.alter table T policy retention` / `.alter database policy caching` (the latter authored today from the Eventhouse "Data policies" dialog) |
| **Database role assignment (RBAC)** — list / add / drop principals | ✅ | **Built (audit-T20).** A **Security → Database roles** sub-group lists principals via `GET /api/adx/roles` → `.show database ["db"] principals`; an **Add principal** dialog (role dropdown, principal type User/Group/App, UPN/object-id/app-id + optional tenant + description) posts `POST /api/adx/roles {action:'add'}` → `.add database ["db"] <role> ('aaduser=…')`; per-row Remove → `{action:'drop'}` → `.drop database …`. Six roles: admins, users, viewers, unrestrictedviewers, ingestors, monitors. Database Admin required. |
| **Row-level security** — per-table policy show + alter | ✅ | **Built (audit-T20).** A **Security → Row-level security** sub-group lists tables; each opens an `RlsPolicyDialog` that pre-loads via `GET /api/adx/rls?table=T` → `.show table ["T"] policy row_level_security`, with an enable/disable Switch + KQL predicate `Textarea`, saving via `POST /api/adx/rls` → `.alter table ["T"] policy row_level_security enable\|disable "query"`. Table/Database Admin required; success receipt shown. |
| **External tables** — list + create (Delta + Storage) + drop | ✅ | **Built (audit-T20).** An **External tables** group lists via `GET /api/adx/external-tables` → `.show external tables` (type badge, open `external_table("N")`, drop). A **New external table** wizard creates **Delta** (abfss URI, schema auto-inferred) or **Azure Storage** (column grid + data-format dropdown + `h@'…'` connection string) via `POST /api/adx/external-tables` → `.create-or-alter external table … kind=delta\|storage`; drop → `DELETE … → .drop external table N ifexists`. SQL external tables remain ⚠️ (need a secrets surface). |
| Honest infra-gate when cluster unconfigured | ✅ | routes 503 `not_configured` → whole navigator shows one `MessageBar` naming `LOOM_KUSTO_CLUSTER_URI` + the Database Admin / AllDatabasesAdmin role |

Zero ❌. Every un-built ADX/Fabric capability is an honest ⚠️ "coming" row whose
tooltip names the exact control command + role required — never a fake list.

## Backend per control

Every count and action issues a real Kusto control command to `/v1/rest/mgmt`
via `lib/azure/kusto-client.ts` (`executeMgmtCommand`). BFF routes are
session-guarded, apply the `LOOM_KUSTO_CLUSTER_URI` config gate (503
`not_configured`), resolve the database from `?id=<kql-database item>`, and
return `{ ok, … }` JSON. Shared plumbing: `app/api/adx/_shared.ts`.

| Control | BFF route | client fn | control command (POST /v1/rest/mgmt) |
|---------|-----------|-----------|--------------------------------------|
| Tables list | `GET /api/adx/tables` | `listTableDetails` | `.show tables details` |
| Table create | `POST /api/adx/tables` | `createTable` | `.create table ["N"] (schema)` |
| Table drop | `DELETE /api/adx/tables` | `dropTable` | `.drop table ["N"] ifexists` |
| Functions list | `GET /api/adx/functions` | `listFunctions` | `.show functions` |
| Function create | `POST /api/adx/functions` | `createFunction` | `.create-or-alter function … N(args){body}` |
| Function drop | `DELETE /api/adx/functions` | `dropFunction` | `.drop function N ifexists` |
| MViews list | `GET /api/adx/materialized-views` | `listMaterializedViews` | `.show materialized-views` |
| MView create | `POST /api/adx/materialized-views` | `createMaterializedView` | `.create [async] materialized-view [with (backfill=true)] N on table ["SRC"] {query}` |
| MView drop | `DELETE /api/adx/materialized-views` | `dropMaterializedView` | `.drop materialized-view N ifexists` |
| Mappings list | `GET /api/adx/ingestion-mappings` | `listIngestionMappings` | `.show ingestion mappings` |
| Mapping create | `POST /api/adx/ingestion-mappings` | `createIngestionMapping` | `.create-or-alter table ["T"] ingestion <kind> mapping "N" 'json'` |
| Mapping drop | `DELETE /api/adx/ingestion-mappings` | `dropIngestionMapping` | `.drop <table\|database> … ingestion <kind> mapping "N"` |
| Schema + continuous-exports (read-only) | `GET /api/adx/overview` | `getDatabaseSchemaJson` / `listContinuousExports` | `.show database ["db"] schema as json` / `.show continuous-exports` |
| Database principals list | `GET /api/adx/roles` | `listDatabasePrincipals` | `.show database ["db"] principals` |
| Database principal grant | `POST /api/adx/roles {action:'add'}` | `addDatabasePrincipal` | `.add database ["db"] <role> ('<fqn>') '<desc>'` |
| Database principal revoke | `POST /api/adx/roles {action:'drop'}` | `dropDatabasePrincipal` | `.drop database ["db"] <role> ('<fqn>')` |
| RLS policy show | `GET /api/adx/rls?table=T` | `showTableRlsPolicy` | `.show table ["T"] policy row_level_security` |
| RLS policy alter | `POST /api/adx/rls` | `setTableRlsPolicy` | `.alter table ["T"] policy row_level_security enable\|disable "query"` |
| External tables list | `GET /api/adx/external-tables` | `listExternalTables` | `.show external tables` |
| External table create (Delta) | `POST /api/adx/external-tables {kind:'delta'}` | `createOrAlterExternalTableDelta` | `.create-or-alter external table ["N"] kind=delta (h@'abfss…;impersonate')` |
| External table create (Storage) | `POST /api/adx/external-tables {kind:'storage'}` | `createExternalStorageTable` | `.create-or-alter external table ["N"] (schema) kind=storage dataformat=<fmt> (h@'conn')` |
| External table drop | `DELETE /api/adx/external-tables` | `dropExternalTable` | `.drop external table ["N"] ifexists` |

## Deferred (explicit follow-ups, not half-built)

- **Continuous-export authoring** — `.create-or-alter continuous-export` over an
  external table (needs an external table + Database Admin). Listed read-only.
- **Update policies in the navigator** — `.alter table T policy update`; today
  the KQL database **ribbon** (New → Update policy) authors these against the
  same query route.
- **Retention / caching policies** — `.alter table T policy retention` /
  `.alter database policy caching`; db-level details surfaced read-only today.
- **SQL external tables** — `.create external table … kind=sql`; needs a
  `SqlConnectionString` with embedded credentials / managed identity, which Loom
  has no secrets surface for yet. Delta + Azure-Storage external tables ARE
  built (audit-T20).
- **Mapping editor (visual column builder)** — today the create dialog takes the
  mapping definition as a validated JSON array (`[{ column, datatype?,
  Properties }]`), which is exactly the value `.create-or-alter … mapping`
  expects; a per-column visual builder is a follow-up.

## Bicep / env sync

- Env var consumed: **`LOOM_KUSTO_CLUSTER_URI`** (already used by the existing
  KQL editors / `kusto-client.ts`; the explicit-presence check is the honest
  config gate). Also reads the existing `LOOM_KUSTO_DEFAULT_DB`,
  `LOOM_UAMI_CLIENT_ID`. No new app-env entry required.
- Role: the Loom UAMI needs at least **Database Admin** on the target database
  (or **AllDatabasesAdmin** on the cluster) to create/drop tables, functions,
  materialized views, and ingestion mappings — the role the cluster bootstrap
  already grants (`az kusto cluster-principal-assignment create`).
- No new Azure resource or Cosmos container (the `kql-database` item +
  `loom-items` index already exist).

## Verification

- `cd apps/fiab-console && pnpm build` → **Compiled successfully, exit 0**.
- The five `/api/adx/*` routes register in the build route table
  (`/api/adx/tables`, `/api/adx/functions`, `/api/adx/materialized-views`,
  `/api/adx/ingestion-mappings`, `/api/adx/overview`).
- Per `no-vaporware.md`: every list/create/drop hits a real Kusto control
  command; the honest infra-gate renders when `LOOM_KUSTO_CLUSTER_URI` is unset.
- Live `pnpm uat` side-by-side against the ADX web UI / Fabric Eventhouse:
  pending (no minted session in this worktree).
- **audit-T20** added Security (RBAC + RLS) + External tables (Delta + Storage):
  `kusto-security.test.ts` (11 cases) GREEN; `/api/adx/roles`, `/api/adx/rls`,
  `/api/adx/external-tables` register; tsc on touched files clean (px-noise only).

## Per-cloud matrix (audit-T20 additions)

| Concern | Commercial | GCC | GCC-High / IL5 | DoD (IL6) |
|---------|-----------|-----|----------------|-----------|
| Kusto data-plane host | `<c>.<r>.kusto.windows.net` | same | `<c>.<r>.kusto.usgovcloudapi.net` | `<c>.<r>.kusto.usgovcloudapi.net` |
| `.show/.add/.drop database … principals`, `.alter table … policy row_level_security`, `.create-or-alter external table` | ✅ | ✅ | ✅ | ✅ |
| Principal FQN format (`aaduser=UPN`, `aadgroup=OID;tenant`, `aadapp=clientId;tenant`) | identical across all clouds — cloud-agnostic at the Kusto layer | | | |
| External-table storage auth (`managed_identity=system`) | cluster MI needs Storage Blob Data Reader on the ADLS/Blob account | same | same | same |
| Fabric dependency | **none** — ADX-native only; no OneLake / `api.fabric.microsoft.com` on any path | N/A | no Fabric in GCC-High (per `no-fabric-dependency.md`) | N/A |

No cloud-conditional code is needed: the existing `kustoClusterUri()` /
`kustoSuffix()` helpers in `cloud-endpoints.ts` already pick the right host
suffix; the new control commands are byte-identical across sovereign clouds.
