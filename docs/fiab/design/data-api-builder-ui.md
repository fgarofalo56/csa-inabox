# CSA Loom — WYSIWYG Data API Builder (DAB) UI — Design

> Status: **DESIGN** (no feature code yet). Author: research agent, 2026-05-31.
> Scope: a new Loom item type `data-api` — a WYSIWYG editor that builds Microsoft
> [Data API Builder](https://github.com/Azure/data-api-builder) REST + GraphQL
> APIs over Loom's existing data sources, previews/tests them against a live DAB
> runtime, publishes them to Loom's APIM, and registers them as a **data-product
> catalog item**. Honors `.claude/rules/no-vaporware.md` + `ui-parity.md`:
> every control calls a real backend or shows an honest infra-gate MessageBar.

---

## 0. TL;DR for the operator

Microsoft DAB is "a CRUD data-API engine in a container" — point it at a SQL /
Cosmos / PostgreSQL / MySQL database, declare *entities* (table/view/SP/container
→ API object) in a `dab-config.json`, and it serves `GET/POST/PUT/PATCH/DELETE
/api/{entity}` REST **and** a `/graphql` endpoint, plus an OpenAPI doc at
`/api/openapi` and a GraphQL SDL — all generated, no codegen. It ships as
`mcr.microsoft.com/azure-databases/data-api-builder` and is driven by the `dab`
CLI (`dab init` / `dab add` / `dab start`).

**The single biggest accelerator:** the live DLZ sub
(`363ef5d1-…`, RG `rg-dlz-dab-dev-eastus2`) **already contains a working DAB
reference deployment** we can reuse wholesale (see §4.1): an ACR with a built
`dab:latest` image, a Container Apps Environment, a running DAB Container App on
port 5000, an Azure SQL DB seeded for DAB, App Insights, Front Door, and storage.
We do not need to invent the hosting pattern — we lift it.

Loom already owns every other moving part: source clients
(`azure-sql-client`, `sql-objects-client`, `cosmos-data-client`,
`postgres-flex-client`), the **APIM client with `importApiFromOpenApi` +
`testApiCall` already implemented**, a Container-Apps ARM client, a Cosmos
config store, an item-type catalog + editor registry, and a catalog/register
flow. This feature is ~80% wiring of existing primitives.

---

## 1. Microsoft Data API Builder — grounded reference

Sources: `github.com/Azure/data-api-builder`, Microsoft Learn
`/azure/data-api-builder/{configuration,concept/rest,concept/graphql,
command-line,deployment/azure-container-apps}`.

### 1.1 Supported backends (`data-source.database-type`)
| Value | Backend | Loom client that already talks to it |
| --- | --- | --- |
| `mssql` | Azure SQL DB / SQL Server / SQL DW | `azure-sql-client.ts`, `sql-objects-client.ts` |
| `cosmosdb_nosql` | Cosmos DB NoSQL | `cosmos-account-client.ts`, `cosmos-data-client.ts` |
| `postgresql` | PostgreSQL (incl. Flexible Server) | `postgres-flex-client.ts` |
| `mysql` | MySQL | *(no Loom client yet — out of scope v1)* |

`cosmosdb_nosql` additionally needs a GraphQL schema file (`.gql`) — Cosmos is
schema-less so DAB cannot introspect columns; the user supplies the type. MSSQL
also supports `autoentities` (pattern-based bulk exposure, e.g. `dbo.%`).

### 1.2 `dab-config.json` schema (the shape the editor authors)
```jsonc
{
  "$schema": "https://github.com/Azure/data-api-builder/releases/latest/download/dab.draft.schema.json",
  "data-source": {
    "database-type": "mssql | postgresql | mysql | cosmosdb_nosql",
    "connection-string": "@env('DATABASE_CONNECTION_STRING')",   // NEVER literal
    "options": { "database": "...", "schema": "...", "graphql-schema": "schema.gql" } // cosmos
  },
  "runtime": {
    "rest":    { "enabled": true, "path": "/api", "request-body-strict": true },
    "graphql": { "enabled": true, "path": "/graphql", "allow-introspection": true },
    "host": {
      "mode": "development | production",
      "cors": { "origins": ["https://loom…"], "allow-credentials": false },
      "authentication": {
        "provider": "StaticWebApps | AppService | AzureAD | Jwt | Simulator",
        "jwt": { "audience": "<app-id>", "issuer": "https://login.microsoftonline.com/<tid>/v2.0" }
      }
    },
    "cache": { "enabled": true, "ttl-seconds": 5 },
    "pagination": { "default-page-size": 100, "max-page-size": 100000 },
    "telemetry": { "application-insights": { "connection-string": "@env('APPLICATIONINSIGHTS_CONNECTION_STRING')" } }
  },
  "entities": {
    "Book": {
      "source": { "object": "dbo.books", "type": "table | view | stored-procedure", "key-fields": ["id"] },
      "rest":    { "enabled": true, "path": "/book", "methods": ["get","post","put","patch","delete"] },
      "graphql": { "enabled": true, "type": { "singular": "Book", "plural": "Books" }, "operation": "query|mutation" },
      "permissions": [
        { "role": "anonymous",     "actions": ["read"] },
        { "role": "authenticated", "actions": [ { "action": "*",
            "fields": { "include": ["*"], "exclude": ["ssn"] },
            "policy": { "database": "@item.owner_id eq @claims.oid" } } ] }
      ],
      "relationships": {
        "author": { "cardinality": "one|many", "target.entity": "Author",
                    "source.fields": ["author_id"], "target.fields": ["id"],
                    "linking.object": "dbo.book_author" }   // for many-to-many
      },
      "mappings": { "id": "BookId" },                        // column → exposed field alias
      "cache": { "enabled": true, "ttl-seconds": 30 }
    }
  }
}
```

### 1.3 Generated endpoints (per running DAB instance, base `{base}`)
- REST: `GET {base}/api/{entity}`, `GET {base}/api/{entity}/{pk-col}/{pk-val}`,
  `POST/PUT/PATCH/DELETE` per permitted actions. Query keywords: `$select`,
  `$filter` (OData-ish: `eq ne gt ge lt le and or`), `$orderby`, `$first`,
  `$after` (continuation token in `nextLink`). Response = `{ "value": [...], "nextLink"? }`.
- GraphQL: single endpoint `POST {base}/graphql`; per entity DAB generates a
  `query` (`book_by_pk`, `books(filter,orderBy,first,after)`) + `mutation`
  (`createBook`/`updateBook`/`deleteBook`). Relationships become nested fields.
- OpenAPI: `GET {base}/api/openapi` (v3 doc, **permission-aware** in 2.0 — only
  methods the role can use appear). `GET {base}/swagger` (Dev mode only).
- GraphQL SDL via introspection; Nitro/Banana Cake Pop UI at `/graphql` in Dev.
- Health: `GET {base}/health` and `GET {base}/` (returns version + status).

### 1.4 Hosting & CLI
- Container image `mcr.microsoft.com/azure-databases/data-api-builder:<tag>`.
  Mount/copy `dab-config.json`; pass secrets via env (`@env('NAME')`). Default
  container port **5000** (the live ref app uses 5000). Learn's canonical deploy
  target is **Azure Container Apps** — exactly Loom's runtime.
- CLI: `dab init --database-type … --connection-string "@env('…')"`,
  `dab add <Entity> --source <schema.obj> --permissions "role:actions"`,
  `dab validate`, `dab start`. We generate the JSON directly (no CLI dependency
  in the BFF) but mirror `dab validate` semantics client + server side.

### 1.5 Auth model
- Roles: system `anonymous` + `authenticated`, plus custom roles. The caller
  selects a role per request via the **`X-MS-API-ROLE`** header; DAB authorizes
  the action against that role's `permissions`. 2.0 adds role inheritance
  (`named → authenticated → anonymous`).
- Providers: `Jwt`/`AzureAD` (validate Entra bearer tokens — what Loom/APIM will
  front), `StaticWebApps`/`AppService` EasyAuth, or `Simulator` (dev: treats all
  requests as authenticated — handy for the in-Loom preview runtime).
- Field-level include/exclude + row-level `policy.database` (OData predicate over
  `@claims.*` / `@item.*`) give column- and row-security per role.

---

## 2. Mapping to Loom's existing data sources

The editor's **Source** step reuses Loom's source navigators verbatim:

| DAB `database-type` | Loom picker source | Schema introspection used by the entity-picker |
| --- | --- | --- |
| `mssql` | `azure-sql-client.listServers/listDatabases` → server+db | `sql-objects-client`: `listSchemas`, `listTables`, `listViews`, `listProcedures`, `listColumns` — these feed the **entity tree** (table/view/SP → entity) and per-entity field list/keys directly |
| `postgresql` | `postgres-flex-client.listServers/listDatabases` | reuse `sql-objects-client`-style `information_schema` queries (new thin `pg-objects` helper, or `executeQuery` against `information_schema`) |
| `cosmosdb_nosql` | `cosmos-account-client` (account) + `cosmos-data-client` (db/container) | container list = entities; no column introspection — user supplies/imports a `.gql` type (sample a few docs via `cosmos-data-client.queryItems` to scaffold it) |

**Connection-string handling (vaporware-safe):** the editor never stores a
literal connection string in `dab-config.json`. It stores a **source reference**
(`{kind, serverId, database}`) in Cosmos; at deploy time the BFF resolves the
actual connection string from the source (or a Key Vault secret / APIM named
value) and injects it as the `DATABASE_CONNECTION_STRING` env var on the DAB
Container App, with `@env('DATABASE_CONNECTION_STRING')` in the JSON.

**Reusable existing primitives (grepped, confirmed present):**
- APIM: `lib/azure/apim-client.ts` already exports `importApiFromOpenApi(...)`,
  `testApiCall(...)`, `upsertApi`, `listApis`, `upsertProduct`, `addApiToProduct`,
  `createSubscription`, `getSubscriptionKeys`, `upsertPolicy`. The publish flow
  is essentially **already built** — `POST /api/apim/import` exists today.
- Container Apps: `lib/azure/container-apps-arm-client.ts`
  (`listContainerApps`, `getContainerApp`, `updateContainerAppScale`) — extend
  with `updateContainerAppEnv` + `restartContainerApp` (new revision).
- Cosmos config store: `lib/azure/cosmos-client.ts` `getContainer(id, pk)` +
  `itemsContainer()`; `app/api/items/_lib/item-crud.ts`
  (`createOwnedItem`/`updateOwnedItem`/`loadOwnedItem`) is the canonical
  tenant-scoped persistence helper — `data-api` configs persist through it.
- Catalog: `lib/catalog/fabric-item-types.ts` (item registration) +
  `lib/editors/registry.ts` (editor wiring); `app/api/catalog/register/route.ts`
  (Purview/Atlas registration) for the data-product step.

---

## 3. WYSIWYG UX spec (Fluent v9, Loom tokens)

New item type **`data-api`** ("Data API"), category **`APIs and functions`**.
Editor `DataApiBuilderEditor` in `lib/editors/data-api-editor.tsx`, wrapped in
`ItemEditorChrome` with a left **entity tree** + right **detail pane** + a
ribbon, mirroring the Azure-services editors already in the repo. Five-stage
left-rail wizard (all stages always rendered; gates shown inline):

### Stage 1 — Data source
- **Controls:** `database-type` `Dropdown` (mssql / postgresql / cosmosdb_nosql);
  cascading source pickers reusing existing navigators (server `Combobox` →
  database `Combobox`; Cosmos: account → db). "Test connection" `Button`.
  Runtime `host.mode` toggle (development/production), CORS origins `TagInput`,
  auth provider `Dropdown` (Simulator for in-Loom preview, AzureAD for published).
- **Backends:** `azure-sql-client.listServers/listDatabases`,
  `postgres-flex-client.*`, `cosmos-account-client.*`. Test-connection runs a
  cheap probe (`sql-objects-client.listSchemas` / `cosmos-data-client.queryItems
  TOP 1`). Honest gate: if `LOOM_SUBSCRIPTION_ID` / source RG env unset →
  `MessageBar intent="warning"` naming the exact var.

### Stage 2 — Entities (the WYSIWYG core)
- **Left tree:** schema → tables / views / stored-procedures (SQL) or containers
  (Cosmos), checkbox-multiselect. "Add as entities" bulk action; MSSQL also gets
  an **"Auto-expose pattern"** dialog (`autoentities`, e.g. include `dbo.%`).
- **Per-entity detail (tabs):**
  - **General:** entity name (alias), source object (read-only), source `type`
    (table/view/stored-procedure), key-fields multiselect (prefilled from
    `listColumns` PK detection).
  - **REST:** enabled `Switch`, `path` `Input` (default `/{entity}`), methods
    `CheckboxGroup` (get/post/put/patch/delete).
  - **GraphQL:** enabled `Switch`, singular/plural type names, operation
    (query/mutation) for SP-backed entities.
  - **Fields/mappings:** grid of columns (from `listColumns`) with alias `Input`
    + include/exclude toggles.
  - **Permissions:** per-role rows (`role` Combobox: anonymous/authenticated/
    custom) × `actions` (create/read/update/delete/*) checkboxes; optional
    field include/exclude and a `policy.database` predicate `Input` with a
    `@claims.*`/`@item.*` helper.
  - **Cache:** enabled + ttl-seconds.
- **Relationships sub-tab:** visual relationship builder — pick target entity,
  cardinality (one/many), source/target fields (column dropdowns), optional
  linking object for many-to-many. Renders a small relationship graph
  (reuse the `@xyflow/react` canvas already in the repo per the React-Flow memo)
  so users *see* the entity graph — true Azure-portal-parity affordance.
- **Backends:** `sql-objects-client.listColumns/listTables/...`,
  `cosmos-data-client.queryItems` (sample docs → scaffold `.gql`). All edits
  mutate an in-memory `DabConfig` object; **"Validate"** ribbon button runs a
  server-side `dab validate`-equivalent (schema + reference checks).

### Stage 3 — Preview / Test (live request-response)
- **Provision-preview** `Button` → spins up (or reuses) a **preview DAB runtime**
  (§4.2) bound to this config with `Simulator`/`anonymous` auth, returns its
  internal FQDN. Status `Badge` (provisioning / running / failed).
- **REST tester:** entity dropdown → method + path are prefilled; `$filter`/
  `$select`/`$orderby`/`$first` builder inputs; `X-MS-API-ROLE` role dropdown;
  "Send" shows status, headers, and the JSON `value`/`nextLink` (Monaco
  read-only, already self-hosted per repo memo). This is a **real fetch** to the
  live preview DAB through the BFF (server-side fetch avoids CORS/secret leak).
- **GraphQL tester:** Monaco GraphQL editor seeded with a generated sample query
  per entity + a "schema" panel (SDL via introspection). "Run" posts to
  `{preview}/graphql`.
- **OpenAPI/SDL preview:** pull `{preview}/api/openapi` + GraphQL SDL; render the
  raw OpenAPI in Monaco; this exact OpenAPI is what Stage 4 publishes.
- **Backends:** new `lib/azure/dab-client.ts` (provision/restart/fetch-schema/
  proxy-request) calling `container-apps-arm-client` + server-side `fetch`.

### Stage 4 — Publish to APIM
- **Controls:** API id/displayName/path `Input`s (default from item name);
  "Import REST (OpenAPI)" + "Import GraphQL" buttons; product dropdown
  (`listProducts`) with "create product"; subscription-required `Switch`;
  optional policy snippet (`set-backend-service` to the DAB gateway, JWT
  validate) editable in Monaco; "Publish" `Button`.
- **Flow (all real, mostly already wired):**
  1. Fetch `{dab}/api/openapi` → `importApiFromOpenApi({apiId, path, format:
     'openapi+json', value})` (`POST /api/apim/import` exists today).
  2. Rewrite the API's backend to the DAB Container App gateway URL
     (`upsertApi` + `upsertPolicy set-backend-service`).
  3. GraphQL: APIM supports GraphQL APIs — import via `apiType: graphql` with
     the SDL (new branch in `importApiFromOpenApi`/`upsertApi`).
  4. Add to product (`addApiToProduct`), create subscription
     (`createSubscription`), surface keys (`getSubscriptionKeys`).
  5. "Test through APIM" reuses `testApiCall(...)` (already implemented).
- **Honest gate:** APIM unconfigured → the existing `apimConfigGate` 503 surfaces
  as a `MessageBar` naming `LOOM_SUBSCRIPTION_ID` / `LOOM_APIM_NAME`.

### Stage 5 — Register as a data product
- **Controls:** display name, domain (`/api/catalog/domains`), owner, description,
  classifications, glossary terms; "endpoints" auto-filled (APIM gateway REST +
  GraphQL URLs); "Register" `Button`.
- **Flow:** create/patch the Loom `data-api` item (carrying the published API id,
  gateway URLs, source ref, and the `dab-config`), then call
  `POST /api/catalog/register` (extend `source` union with `'data-api'`) to
  upsert an Atlas/Purview entity + lineage edge (DAB API ⇐ source DB). Stamp the
  item with `dataProduct: true` so it appears in the data-product catalog and is
  AI-Search-indexed (loom-items index per repo memo).

**Ribbon (all stages):** Save · Validate · Provision preview · Publish to APIM ·
Register data product · Learn (popup grounded in DAB Learn docs).

---

## 4. Hosting design

### 4.1 Reuse the live `rg-dlz-dab-dev-eastus2` reference (verified via `az`)
Live inventory (DLZ sub `<subscription-id>`):
| Resource | Name | Reuse |
| --- | --- | --- |
| Container Registry | `acrdabdemodev` (repos `dab`, `dab-frontend`, `frontend`) | **`dab:latest` image already built** — re-tag into Loom ACR, or pull through. Saves building/curating the DAB image. |
| Container Apps Env | `dabdemo-dev-cae` | proves CAE hosting pattern; Loom uses its own CAE (`loom…-cae`). |
| DAB Container App | `dabdemo-dev-ca-dab` (image `acrdabdemodev.azurecr.io/dab:latest`, **port 5000**, external ingress, env: `ASPNETCORE_ENVIRONMENT`, `DATABASE_CONNECTION_STRING`, `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `ALLOWED_ORIGINS`, min 1 / max 10) | **exact Container-App template** for Loom's DAB host — copy its env contract + ingress + scale verbatim into bicep. |
| Azure SQL | `dabdemo-dev-sql` / db `dabdemo-dev-db` (admin `sqladmin`) | live DAB-backing DB for E2E receipts + the preview source. |
| App Insights | `dabdemo-dev-appinsights` | telemetry wiring reference. |
| Front Door + Storage + EventGrid | `dabdemo-dev-fd`, `stdabdemodev` | front-end hosting pattern (not needed — Loom fronts via APIM). |

**Takeaway:** the env-var contract and ingress/scale shape are *known-good* from a
running app. We mirror them rather than guess.

### 4.2 Two DAB runtime tiers inside Loom
1. **Shared preview runtime** (one per Loom deployment): a single long-lived DAB
   Container App `loom-dab-preview` in the Loom admin/ACA RG, running with
   `host.mode=development` + `Simulator` auth. The editor pushes the *draft*
   config to it (mounted from Cosmos via a startup init container or a config
   reload), restarts the revision, and tests against it. Cheap, always-on,
   min-replicas 1. Used for Stage 3.
2. **Per-product published runtime** (created at publish/register time): a
   dedicated DAB Container App `loom-dab-<product-slug>` with `host.mode=
   production`, `AzureAD` auth, the real source connection string injected as a
   secret env var, scaled 1→N. APIM's backend points at this app's internal
   ingress FQDN. One per data product = clean blast-radius + independent scaling.

### 4.3 Config storage & push
- **Storage:** the `dab-config.json` (minus secrets) lives in Cosmos as the
  `data-api` item document (tenant/workspace-partitioned, via `item-crud`). A
  thin `dab-config` derivation function emits the canonical JSON.
- **Push to runtime:** BFF writes the JSON to a mounted volume / config secret
  and triggers a **new Container-App revision** (`container-apps-arm-client` +
  new `restartContainerApp`/`updateContainerAppEnv`). Connection string +
  App-Insights string are injected as Container-App **secrets**, referenced by
  `@env(...)` in the JSON — secrets never touch Cosmos or the browser.

---

## 5. BFF routes (real backends)

All under `app/api/data-api/`. Session-cookie auth, `{ok,data,error}` envelope,
honest 503 gates. ("✅ reuses existing" = the underlying client already exists.)

| Route | Method | Real backend |
| --- | --- | --- |
| `/api/data-api/sources` | GET | list candidate sources (sql/pg/cosmos) ✅ existing clients |
| `/api/data-api/sources/[kind]/schema` | GET | `sql-objects-client.listSchemas/Tables/Views/Procedures` / cosmos container list ✅ |
| `/api/data-api/sources/[kind]/columns` | GET | `sql-objects-client.listColumns` (+ pg `information_schema`) ✅ |
| `/api/data-api/[id]/config` | GET/PUT | load/save `dab-config` via `item-crud` ✅ |
| `/api/data-api/[id]/validate` | POST | server-side schema + reference validation (`dab validate` parity) |
| `/api/data-api/[id]/preview/provision` | POST | ensure/refresh `loom-dab-preview` revision with this config (`container-apps-arm-client` + new restart/env) |
| `/api/data-api/[id]/preview/rest` | POST | server-side fetch `{preview}/api/{entity}` with `X-MS-API-ROLE` (new `dab-client.proxyRest`) |
| `/api/data-api/[id]/preview/graphql` | POST | server-side POST `{preview}/graphql` (new `dab-client.proxyGraphql`) |
| `/api/data-api/[id]/preview/schema` | GET | fetch `{preview}/api/openapi` + GraphQL SDL (`dab-client.fetchSchemas`) |
| `/api/data-api/[id]/publish` | POST | `importApiFromOpenApi` + `upsertApi` + `upsertPolicy` + `addApiToProduct` + `createSubscription` ✅ (apim-client) |
| `/api/data-api/[id]/deploy` | POST | create/refresh per-product `loom-dab-<slug>` Container App (new bicep-equivalent ARM PUT in `dab-client.deployRuntime`) |
| `/api/data-api/[id]/register` | POST | mark item `dataProduct:true` + `catalog/register` (extend `source:'data-api'`) ✅ register flow |
| `/api/data-api/[id]/status` | GET | `getContainerApp` health + APIM api/subscription state ✅ |

New client module: `lib/azure/dab-client.ts` (provision/restart/env-update,
proxyRest, proxyGraphql, fetchSchemas, deployRuntime) — the only genuinely new
backend code; everything else composes existing clients.

---

## 6. Bicep / Container-App needs (per `no-vaporware.md` §Bicep-sync)

1. **`platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep`** — new module
   modeled on `presidio-sidecar.bicep`: a `Microsoft.App/containerApps` resource
   (image `${acr}/data-api-builder:<tag>`, port **5000**, internal ingress, UAMI
   for ACR pull, env `DATABASE_CONNECTION_STRING`/`AZURE_AD_TENANT_ID`/
   `AZURE_AD_CLIENT_ID`/`APPLICATIONINSIGHTS_CONNECTION_STRING`/`ALLOWED_ORIGINS`
   — mirroring the verified live `dabdemo-dev-ca-dab` contract). Deploys the
   **shared preview** app; the per-product apps are created at runtime via ARM
   (or this module parameterized in a loop).
2. **DAB image** → add `data-api-builder` to the Loom ACR import/build step
   (re-tag from `mcr.microsoft.com/azure-databases/data-api-builder` or pull from
   `acrdabdemodev`). Boundary-local availability per the Presidio precedent.
3. **Env vars** → add to the `loom-console` `apps[].env` in
   `admin-plane/main.bicep`: `LOOM_DAB_PREVIEW_APP` (preview CA name),
   `LOOM_DAB_RG`, `LOOM_DAB_ACR`, `LOOM_DAB_CAE_ID`, `LOOM_DAB_UAMI_CLIENT_ID`.
4. **Role assignments** → Loom Console UAMI needs **Container Apps Contributor**
   on the DAB RG (create/restart apps + update env) and **AcrPull** for the DAB
   image; the DAB apps' UAMI needs read on the chosen source (SQL `db_datareader`
   /`db_datawriter`, Cosmos data-plane role, or pg login). APIM RBAC already
   granted (`grant-apim-rbac.sh`).
5. **Cosmos** → no new container (configs live in the existing `items` container
   via `item-crud`); ensure the `data-api` type is allowed.
6. **Catalog item type** → add `{ slug:'data-api', category:'APIs and functions',
   restType:'DataApi' }` to `fabric-item-types.ts`; register the editor in
   `registry.ts`; write parity doc `docs/fiab/parity/data-api.md`.

Acceptance (per the rule): `az deployment sub create … commercial-full` + the
post-deploy bootstrap must stand up the shared preview DAB app, and the editor
must build→preview→publish→register against it end-to-end (or show the exact
infra-gate MessageBar).

---

## 7. APIM-publish + catalog-data-product flow (end to end)

```
[Editor draft] --PUT--> /api/data-api/{id}/config --> Cosmos (item-crud)
      |
      v  Provision preview
[loom-dab-preview CA] <--config push (restart revision)-- BFF
      |  Stage-3 testers fetch /api/{e} and /graphql (server-side proxy)
      v  Publish
fetch {dab}/api/openapi --> importApiFromOpenApi --> APIM API (REST)
fetch {dab} GraphQL SDL --> upsertApi(apiType:graphql) --> APIM API (GraphQL)
   upsertPolicy(set-backend-service -> per-product DAB FQDN)
   addApiToProduct + createSubscription --> keys surfaced
      |  Register
mark item dataProduct:true (+ published api id, gateway URLs, source ref)
POST /api/catalog/register {source:'data-api'} --> Atlas/Purview entity + lineage
   --> appears in data-product catalog, AI-Search loom-items indexed
```

---

## 8. PR-sized build plan

- **PR 1 — Item type + editor shell + config model.** Add `data-api` to
  `fabric-item-types.ts` + `registry.ts`; `lib/dab/config-model.ts` (typed
  `DabConfig` + JSON emit + client validate); `data-api-editor.tsx` shell with
  the 5-stage rail + Source stage wired to existing source clients;
  `/api/data-api/sources*` routes. Parity doc skeleton. *Receipt: source pickers
  list real servers/dbs; honest gate when sub unset.*
- **PR 2 — Entity designer.** Entity tree + per-entity tabs (REST/GraphQL/fields/
  permissions/cache) + relationship builder (xyflow); `/config` GET/PUT +
  `/validate`. *Receipt: introspect a real Azure SQL db, author entities, save to
  Cosmos, re-open.*
- **PR 3 — DAB runtime + preview.** `dab-runtime.bicep` (shared preview app) +
  ACR image import + env/RBAC bicep sync; `lib/azure/dab-client.ts`;
  `/preview/provision|rest|graphql|schema`; Stage-3 REST + GraphQL testers.
  *Receipt: live REST + GraphQL responses from the preview DAB over a real DB.*
- **PR 4 — Publish to APIM.** `/publish` composing existing apim-client calls
  (REST import done; add GraphQL import branch); per-product runtime `/deploy`;
  Stage-4 UI + "test through APIM" via `testApiCall`. *Receipt: API visible in
  APIM, gateway call returns real data.*
- **PR 5 — Data-product registration + polish.** `/register` (+ `catalog/register`
  `data-api` source + lineage); Stage-5 UI; `dataProduct:true`; Learn popup;
  AI-Search indexing; complete `docs/fiab/parity/data-api.md`; Vitest + Playwright.
  *Receipt: data product in catalog with lineage; full teardown→redeploy walk.*

---

## 9. Biggest technical risks

1. **Pushing config into a running DAB Container App without a rebuild.** DAB
   reads `dab-config.json` at startup; there's no hot-reload API. Options:
   (a) bake config into a per-revision env/secret + a tiny init step that writes
   the file then starts DAB, triggering a new revision on each save (clean but
   ~10–30s per preview update); (b) a small wrapper that polls a mounted Azure
   Files share. Revision-restart (a) is the honest, simplest path; the preview
   UX must show a "provisioning" state and not pretend it's instant.
2. **Secret hygiene for connection strings.** Must inject as Container-App
   secrets + `@env()`, never persist in Cosmos or return to the browser — and the
   preview/per-product UAMI must have least-privilege DB access. Misdesign here
   is both a security bug and a `no-vaporware` violation.

Secondary: GraphQL-in-APIM import is less battle-tested than OpenAPI import (may
need `upsertApi apiType:graphql` rather than the OpenAPI path); Cosmos entities
need a user-supplied `.gql` (no introspection) so the Cosmos path is thinner in v1.
