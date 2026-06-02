# data-api-builder — parity with the Microsoft Data API builder (DAB) config UX

> Brutally-honest 1:1 parity audit (2026-06-01). Grading per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`. Graded
> conservatively; when in doubt, graded DOWN.
>
> Scope: the **Data API Builder config editor** — a WYSIWYG builder for a canonical
> `dab-config.json` (data-source, entities → REST + GraphQL, per-role permissions
> with field/row security, relationships, runtime/host), plus validate / download /
> preview / APIM-publish.
>
> Parity note: DAB has no single first-party "portal UI" — its authoring surface is
> the `dab` CLI + the hand-edited `dab-config.json` schema. So "1:1 parity" here is
> measured against the **full configuration schema** (every section the CLI / config
> exposes), which is the right `ui-parity.md` bar for this object.

**Source UI / config (grounded in Microsoft Learn, not memory):**
- DAB configuration reference (the schema this builder emits): https://learn.microsoft.com/azure/data-api-builder/configuration/
- Entities (source, REST, GraphQL, permissions, relationships, mappings, cache): https://learn.microsoft.com/azure/data-api-builder/configuration/entities
- Runtime & host (rest/graphql/host mode, auth provider, cache, pagination): https://learn.microsoft.com/azure/data-api-builder/configuration/runtime
- Database-object permissions (actions, fields include/exclude, database policy): https://learn.microsoft.com/azure/data-api-builder/concept/database-objects
- Relationships (cardinality, source/target fields, linking object): https://learn.microsoft.com/azure/data-api-builder/concept/relationships

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/data-api-builder-editor.tsx` — staged builder
  (Data source · Entities · Runtime & host · Preview & publish · Config) with
  `SourceStage`, `EntitiesStage` (general/rest/graphql/fields/permissions/relationships/cache
  tabs), `RuntimeStage`, `PreviewStage`.
- Config model: `apps/fiab-console/app/api/dab/_lib/dab-config-model.ts`.
- BFF: `apps/fiab-console/app/api/dab/{create,sources,[id]/config,[id]/validate,
  [id]/download,[id]/preview/*,[id]/publish}/route.ts`.

**Backend reality check.** Source schema is introspected from a **real Azure SQL
database** (`/api/dab/sources/mssql/schema` + `/columns` over `sys.*`). The builder
emits the **real canonical `dab-config.json`** (downloadable + persisted to the Loom
Cosmos config store) referencing `@env('DATABASE_CONNECTION_STRING')` — never a
literal secret. Validate / REST-preview / GraphQL-preview / APIM-publish call a
**real DAB runtime** when `LOOM_DAB_PREVIEW_URL` is set; otherwise an honest
MessageBar names the env var and the full builder still renders. No `return []`, no
`MOCK_`, no `useState(SAMPLE)`.

---

## Config schema inventory → Loom coverage → backend

Legend: built ✅ · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Data source

| # | DAB config capability | Loom | Where / backend |
|---|---|---|---|
| A1 | Database type (mssql / postgresql / mysql / cosmosdb_nosql / cosmosdb_pg) | ✅ built | `SourceStage` kind dropdown |
| A2 | Connection string via `@env(...)` (no literal secret) | ✅ built | emitted as `@env('DATABASE_CONNECTION_STRING')` |
| A3 | mssql server + database (for `sys.*` introspection) | ✅ built | server/database inputs → `/api/dab/sources/mssql/schema` |
| A4 | Cosmos NoSQL GraphQL schema (`.gql`) | ✅ built | `graphqlSchema` textarea |
| A5 | Source options (set-session-context etc.) | ⚠️ partial | core fields only; not every db-specific option |

### B. Entities

| # | DAB config capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Add entity from a DB object (table / view / stored-procedure) | ✅ built | `EntitiesStage`; schema list from `sys.*` introspection |
| B2 | Per-entity **REST**: enabled, path, methods | ✅ built | rest tab (methods incl. SP get/post) |
| B3 | Per-entity **GraphQL**: enabled, singular/plural, query/mutation op | ✅ built | graphql tab |
| B4 | **Fields** mapping / column list (lazy from columns introspection) | ✅ built | fields tab → `/sources/mssql/columns` |
| B5 | Per-entity **cache** | ✅ built | cache tab |
| B6 | Remove entity | ✅ built | entity row delete |
| B7 | Field **mappings** (db column → exposed name aliasing) | ⚠️ partial | field list present; alias-rename depth not full |
| B8 | Stored-procedure parameters | ⚠️ partial | SP entity supported; parameter editor thin |

### C. Permissions (per-role security)

| # | DAB config capability | Loom | Where / backend |
|---|---|---|---|
| C1 | Per-role permissions (anonymous / authenticated / custom role) | ✅ built | permissions tab; X-MS-API-ROLE note |
| C2 | Actions (read/create/update/delete; execute for SP) | ✅ built | action set per role |
| C3 | **Field-level** security (include / exclude) | ✅ built | exclude-fields input → `actions[].fields.exclude` |
| C4 | **Row-level** security (database policy, OData over `@item.*`/`@claims.*`) | ✅ built | policyDatabase input |
| C5 | Add / remove roles | ✅ built | add-role / remove-role buttons |
| C6 | Per-action policy (different policy per action) | ⚠️ partial | policy applied broadly; not strictly per-action granular |

### D. Relationships

| # | DAB config capability | Loom | Where / backend |
|---|---|---|---|
| D1 | Define relationship (name, cardinality one/many, target entity) | ✅ built | relationships tab |
| D2 | Source / target join fields | ✅ built | source/target field inputs |
| D3 | Many-to-many **linking object** + linking source/target fields | ✅ built | linking-object inputs (conditional) |
| D4 | Remove relationship | ✅ built | remove button |

### E. Runtime & host

| # | DAB config capability | Loom | Where / backend |
|---|---|---|---|
| E1 | REST: enabled, base path, request-body-strict | ✅ built | RuntimeStage REST card |
| E2 | GraphQL: enabled, base path, allow-introspection | ✅ built | GraphQL card |
| E3 | Host mode (development / production) | ✅ built | host mode dropdown |
| E4 | Auth provider (EntraId / Custom / others) + JWT audience/issuer | ✅ built | auth provider + JWT fields |
| E5 | Global cache (enable + TTL) + pagination (default/max page size) | ✅ built | cache + pagination card |
| E6 | CORS / telemetry / health-check / mode-specific host settings | ❌ MISSING | not surfaced |

### F. Validate · download · preview · publish

| # | DAB capability | Loom | Where / backend |
|---|---|---|---|
| F1 | **Validate** config | ✅ built | ribbon Validate → `POST …/[id]/validate` |
| F2 | **Download** canonical `dab-config.json` | ✅ built | ribbon Download → `…/[id]/download` |
| F3 | View full config (live JSON) | ✅ built | Config stage |
| F4 | Save config to the Loom config store | ✅ built | Save → `…/[id]/config` (Cosmos) |
| F5 | **Probe** a running DAB runtime | ✅ built / ⚠️ gate | `…/preview/probe`; honest gate names `LOOM_DAB_PREVIEW_URL` |
| F6 | **REST tester** (entity, role, filter → live request) | ✅ built / ⚠️ gate | `…/preview/rest` (live when runtime set) |
| F7 | **GraphQL tester** (query, role → live request) | ✅ built / ⚠️ gate | `…/preview/graphql` |
| F8 | **Publish through APIM** (apiId, path) | ✅ built / ⚠️ gate | `…/[id]/publish` |
| F9 | `dab validate` line-level error mapping into the editor | ⚠️ partial | validation result shown; not inline-annotated per field |

---

## Coverage tally

- **built ✅: 30**
- **partial ⚠️: 6** (incl. the 4 preview/publish controls that are fully built but
  runtime-gated)
- **honest-gate ⚠️: 1** (the `LOOM_DAB_PREVIEW_URL` runtime gate covers F5–F8)
- **MISSING ❌: 1**

## Honest grade: **B+**

This is a strong, **production-grade** WYSIWYG builder that genuinely covers the DAB
configuration schema end-to-end: data-source (5 db types, `@env` connection string),
entities with full **REST + GraphQL + fields + permissions + relationships + cache**
tabs, **field-level and row-level security**, runtime/host (auth provider, cache,
pagination), and it **introspects a real Azure SQL schema** and **emits the real
canonical `dab-config.json`** (downloadable + persisted) — secret-safe. Validate /
REST-test / GraphQL-test / APIM-publish all call a real DAB runtime when provisioned,
and degrade to a precise, allowed infra-gate when not. **No vaporware.**

Held just under A by `ui-parity.md`: the **preview/test/publish loop is
runtime-gated** in this deployment (correct and disclosed, but it means the
execute-and-publish half isn't exercisable without `LOOM_DAB_PREVIEW_URL`), a few
schema corners are thin (field **alias mappings**, **per-action policies**, **SP
parameters**, **CORS/telemetry/health host settings**), and validation isn't
**inline-annotated per field**. As a config-authoring surface it's near-complete;
the gap is depth on a handful of advanced schema sections + a live runtime.

## Highest-value gaps to build first

1. **Provision a DAB preview runtime** (set `LOOM_DAB_PREVIEW_URL`) so F5–F8
   exercise live — the single biggest lift for this surface.
2. **Inline per-field validation annotations** (F9).
3. **Field alias mappings** (B7) + **SP parameters** (B8).
4. **Per-action database policies** (C6).
5. **Host CORS / telemetry / health-check settings** (E6).

## Backend per control

| Control | BFF route | Backend |
|---|---|---|
| Create config | `POST /api/dab/create` | Cosmos config store |
| Load / save config | `GET`/`PUT /api/dab/[id]/config` | Cosmos config store |
| Source DB list | `GET /api/dab/sources?kind=` | provider list |
| mssql schema / columns | `GET /api/dab/sources/mssql/{schema,columns}` | Azure SQL `sys.*` over TDS |
| Validate | `POST /api/dab/[id]/validate` | DAB runtime validate |
| Download config | `GET /api/dab/[id]/download` | canonical `dab-config.json` |
| Probe runtime | `GET /api/dab/[id]/preview/probe` | DAB runtime health (gated on `LOOM_DAB_PREVIEW_URL`) |
| REST / GraphQL test | `POST /api/dab/[id]/preview/{rest,graphql}` | DAB runtime data path |
| Publish to APIM | `POST /api/dab/[id]/publish` | APIM import |

## Bicep / env sync

- Env var consumed: **`LOOM_DAB_PREVIEW_URL`** (DAB runtime base URL). Without it the
  builder renders + saves + downloads; preview/publish show the honest gate.
- Source: a reachable Azure SQL database for `sys.*` introspection (server/database
  fields). Connection string supplied as `@env('DATABASE_CONNECTION_STRING')` at
  runtime, never on disk.
- Role: APIM publish needs API Management Service Contributor on the target instance.
- Cosmos: a DAB config container in the Loom config store.

## Verification

- Per `no-vaporware.md`: schema introspection hits real Azure SQL; the emitted JSON
  is the real canonical config; preview/publish are honest runtime-gates.
- Live `pnpm uat` side-by-side: **pending** for the preview/publish loop (needs
  `LOOM_DAB_PREVIEW_URL`). The builder/validate/download path is exercisable now;
  confirm the runtime loop once provisioned per the no-scaffold rule.

## Data-source kinds (2026-06 update)

Grounded in Microsoft Learn
([data-source](https://learn.microsoft.com/azure/data-api-builder/configuration/data-source),
[feature-availability](https://learn.microsoft.com/azure/data-api-builder/feature-availability),
[database-specific-features](https://learn.microsoft.com/azure/data-api-builder/reference-database-specific-features#azure-synapse-analytics-dedicated-sql-pool)).

| Source kind (UI) | DAB `database-type` | Status | Notes |
|---|---|---|---|
| Azure SQL / SQL Server | `mssql` | built ✅ | `sys.*` introspection over TDS |
| Azure Synapse — Dedicated SQL pool | `dwsql` | built ✅ | Real DAB support; tables/views/SPs; same `sys.*` introspection over the `<ws>.sql.azuresynapse.net` endpoint |
| Azure Synapse — Serverless SQL | — | honest-gate ⚠️ | **DAB does NOT support serverless SQL pool.** Surfaced for object exploration (introspection works via `<ws>-ondemand…`), but the config validator emits a hard error so it can't be published. Alternative: dedicated pool, or mirror to Azure SQL |
| Databricks SQL Warehouse | — | honest-gate ⚠️ | **DAB has NO Databricks connector.** MessageBar names the supported path (mirror Delta to Azure SQL / Synapse Dedicated, or use the Databricks SQL editor). Switching to mssql/dwsql continues the build |
| PostgreSQL | `postgresql` | built ✅ | manual server/db entry + emit |
| Cosmos DB NoSQL | `cosmosdb_nosql` | built ✅ | schema-less; `.gql` required |

`LOOM_SYNAPSE_WORKSPACE` (and `LOOM_SYNAPSE_DEDICATED_POOL`) drive Synapse source
discovery (`GET /api/dab/sources?kind=dwsql`). Serverless `database` resolves to
`master`; dedicated resolves to the pool name. Both endpoints are typed +
introspected via the existing `sql-objects-client` `sys.*` path — only the FQDN
differs (`azure-sql-client.getPool` connects directly to a fully-qualified server).

## Deploy a new data source

`POST /api/dab/deploy-source` — the Data-source stage exposes a "Deploy a new
data source" panel when no SQL/PostgreSQL/Cosmos is discoverable (or on demand).

| Target | What runs | Real vs gated |
|---|---|---|
| Azure SQL Database | `createDatabase` (ARM PUT, GP_S serverless SKU, optional AdventureWorksLT sample) on an existing logical server | **Real** when `LOOM_SUBSCRIPTION_ID` + a logical server exist; else honest-gated to the deploy-planner sql knob |
| Grant deploying user/group SQL admin | `setAadAdmin` (ARM PUT) — group object id if supplied, else the session `oid` | **Real** (gated only if the session has no `oid` and no group id) |
| Console UAMI data-plane role | `CREATE USER … FROM EXTERNAL PROVIDER` + `db_datareader/db_datawriter` | **Honest-gated** — a one-time in-DB SQL action the new admin runs (named exactly, with `LOOM_UAMI_NAME`) |
| Register in Purview | `registerDataSource` (PUT `/scan/datasources/{name}`, kind `AzureSqlDatabase`) | **Real** when `LOOM_PURVIEW_ACCOUNT` set; else honest-gated. Scan run is left to Admin → Purview → Scans |
| Create Unity Catalog | `createUcCatalog` (POST `/api/2.1/unity-catalog/catalogs`) | **Real** when `LOOM_DATABRICKS_HOSTNAME` set; else honest-gated |
| PostgreSQL / Cosmos | — | **Honest bicep handoff** — names `postgresEnabled` knob / core Cosmos + the `az deployment sub create` command + deploy-planner link. No fake create |

On SQL success the new `{ kind: 'mssql', server, database }` is registered onto
the editor's `sourceRef` so it's immediately usable as a DAB source; each
registration/permission step is reported with a `done | gated | error | skipped`
badge so nothing is claimed that didn't run.
