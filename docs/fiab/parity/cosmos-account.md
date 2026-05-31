# cosmos-account — parity with Azure Cosmos DB (NoSQL / Core SQL API)

Source UI: Azure portal → Cosmos DB account → **Data Explorer**
Learn: <https://learn.microsoft.com/azure/templates/microsoft.documentdb/2024-11-15/databaseaccounts>
Control-plane REST: `Microsoft.DocumentDB/databaseAccounts/{acct}` (ARM api-version **2024-11-15**)

This surface navigates a **user-selected** Cosmos DB account named by
`LOOM_COSMOS_ACCOUNT` — **distinct from Loom's own internal store**
(`LOOM_COSMOS_ENDPOINT`, handled by `lib/azure/cosmos-client.ts`). It is the
Cosmos peer of the ADF / Synapse / Databricks / APIM navigators (parity wave 7).

## Azure feature inventory (Data Explorer, grounded in Learn + portal)

| # | Capability | Notes |
|---|-----------|-------|
| 1 | List SQL (NoSQL) databases | `…/sqlDatabases` |
| 2 | Create database (+ optional shared throughput, manual/autoscale) | PUT `…/sqlDatabases/{db}` with `options.throughput` / `options.autoscaleSettings` |
| 3 | Delete database | DELETE `…/sqlDatabases/{db}` |
| 4 | List containers in a database | `…/sqlDatabases/{db}/containers` |
| 5 | Create container (partition key + manual/autoscale RU/s) | PUT `…/containers/{c}` with `resource.partitionKey` |
| 6 | Delete container | DELETE `…/containers/{c}` |
| 7 | Container partition key shown | `resource.partitionKey.paths[0]` |
| 8 | Database / container throughput (RU/s) shown | `…/throughputSettings/default` (manual / autoscale / serverless) |
| 9 | List stored procedures | `…/containers/{c}/storedProcedures` |
| 10 | List triggers (type + operation) | `…/containers/{c}/triggers` |
| 11 | List user-defined functions | `…/containers/{c}/userDefinedFunctions` |
| 12 | Account header (name, region, serverless, free-tier) | GET `…/databaseAccounts/{acct}` |
| 13 | Item / document data explorer (browse + edit JSON docs) | data-plane `dbs/{db}/colls/{c}/docs` |
| 14 | Indexing policy editor | `resource.indexingPolicy` |
| 15 | Conflict-resolution policy | `resource.conflictResolutionPolicy` |
| 16 | Stored procedure / trigger / UDF authoring + execution | data-plane JS editor |

## Loom coverage

| # | Capability | Status | Where |
|---|-----------|--------|-------|
| 1 | List databases | ✅ built | `GET /api/cosmos/databases` |
| 2 | Create database (+ throughput) | ✅ built | `POST /api/cosmos/databases` → tree ＋ New |
| 3 | Delete database | ✅ built | `DELETE /api/cosmos/databases?db=` |
| 4 | List containers | ✅ built | `GET /api/cosmos/containers?db=` (lazy-expand) |
| 5 | Create container (pk + RU/s) | ✅ built | `POST /api/cosmos/containers` → tree ＋ New |
| 6 | Delete container | ✅ built | `DELETE /api/cosmos/containers?db=&container=` |
| 7 | Partition key shown | ✅ built | container row Caption1 |
| 8 | Throughput (RU/s) shown | ✅ built | `withThroughput` read of `throughputSettings/default`; serverless mapped honestly |
| 9 | Stored procedures list | ✅ built | `GET /api/cosmos/scripts` |
| 10 | Triggers list | ✅ built | `GET /api/cosmos/scripts` |
| 11 | UDFs list | ✅ built | `GET /api/cosmos/scripts` |
| 12 | Account header chip | ✅ built | `GET /api/cosmos/account` |
| 13 | Item / document data explorer | ✅ built | "Data Explorer (Items)" tab — real data plane (see below) |
| 14 | Indexing policy editor | ⚠️ honest-gate | "coming" row |
| 15 | Conflict-resolution policy | ⚠️ honest-gate | "coming" row |
| 16 | Script authoring + execution | ⚠️ honest-gate | "coming" row — navigator lists scripts read-only |

Zero ❌. Item 13 (the Items Data Explorer) is now built on the **real Cosmos
data plane**: a Monaco SQL query box (default `SELECT * FROM c`, Execute), a
results grid (id + partition-key value + per-row JSON viewer), an RU-charge +
doc-count readout with continuation-token paging, and New / Edit (Monaco JSON) /
Delete item actions. Items 14–16 remain data-plane authoring surfaces disclosed
as honest `coming` rows under the tree's **Not yet wired** node (per
`no-vaporware.md`), each tooltip naming the exact REST/data-plane path required.

### Item Data Explorer — data-plane REST (grounded in Microsoft Learn)

| Operation | REST | Key headers |
|-----------|------|-------------|
| Query | `POST https://<acct>.documents.azure.com/dbs/{db}/colls/{coll}/docs` | `x-ms-documentdb-isquery: true`, `Content-Type: application/query+json`, `x-ms-documentdb-query-enablecrosspartition: true`, `x-ms-max-item-count`, `x-ms-continuation`; body `{ query, parameters }` |
| Get item | `GET …/docs/{id}` | `x-ms-documentdb-partitionkey: ["<pk>"]` |
| Upsert | `POST …/docs` | `x-ms-documentdb-is-upsert: true`, `x-ms-documentdb-partitionkey: ["<pk>"]` |
| Delete | `DELETE …/docs/{id}` | `x-ms-documentdb-partitionkey: ["<pk>"]` |

Auth is the **AAD/RBAC** scheme (NOT the HMAC master-key scheme): the
`Authorization` header is the URL-encoded string
`type=aad&ver=1.0&sig=<oauth token>`, where the OAuth token is acquired for the
account's data-plane scope (`https://<acct>.documents.azure.com/.default`) via
the same `ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
DefaultAzureCredential)` as the control-plane client. RU charge comes from the
`x-ms-request-charge` response header; the continuation token from
`x-ms-continuation`. Sources:
[access-control](https://learn.microsoft.com/rest/api/cosmos-db/access-control-on-cosmosdb-resources#authorization-header),
[query-documents](https://learn.microsoft.com/rest/api/cosmos-db/query-documents#request),
[get-a-document](https://learn.microsoft.com/rest/api/cosmos-db/get-a-document),
[delete-a-document](https://learn.microsoft.com/rest/api/cosmos-db/delete-a-document).

A **403** from the data plane (substatus 5300, "cannot be authorized by AAD
token in data plane") means the UAMI has a control-plane role but is missing the
data-plane RBAC assignment. The Items tab honest-gates with a Fluent
`MessageBar intent="warning"` naming the exact role — **Cosmos DB Built-in Data
Contributor**, granted via a Cosmos `sqlRoleAssignments`
(`Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments`) at the account
scope — and the full Data Explorer surface still renders.

## Backend per control

| Control | Backend |
|---------|---------|
| Databases list / create / delete | ARM `…/sqlDatabases` (PUT/DELETE/GET 2024-11-15) |
| Containers list / create / delete | ARM `…/sqlDatabases/{db}/containers` |
| Throughput badges | ARM `…/throughputSettings/default` |
| Stored procedures / triggers / UDFs | ARM `…/containers/{c}/{storedProcedures\|triggers\|userDefinedFunctions}` |
| Account header | ARM GET `…/databaseAccounts/{acct}` |
| Items: query / get / upsert / delete | Cosmos **data plane** `…/dbs/{db}/colls/{coll}/docs[/{id}]` via `lib/azure/cosmos-data-client.ts` (`POST /api/cosmos/items`, `POST /api/cosmos/items/action`) |
| Control-plane auth | `ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID), DefaultAzureCredential)` → `https://management.azure.com/.default` |
| Data-plane auth | same credential → `https://<acct>.documents.azure.com/.default`; `Authorization: type=aad&ver=1.0&sig=<token>` (URL-encoded) |

## Infra gate (honest, per no-vaporware + ui-parity)

When the navigator account isn't configured every route returns
`503 { ok:false, code:'not_configured', missing, hint }` and the tree renders a
single Fluent `MessageBar intent="warning"` naming:

- env vars: `LOOM_COSMOS_ACCOUNT`, `LOOM_COSMOS_ACCOUNT_RG`, `LOOM_SUBSCRIPTION_ID`
- role: **Cosmos DB Operator** (or **DocumentDB Account Contributor**) at the account scope

403 from ARM (UAMI missing the role) is surfaced verbatim with that role hint.

## Files

- `lib/azure/cosmos-account-client.ts` — ARM control-plane client + `cosmosConfigGate()`
- `lib/azure/cosmos-data-client.ts` — **data-plane** client (query / get / upsert / delete; AAD auth; `CosmosDataPlaneRbacError`)
- `app/api/cosmos/{databases,containers,scripts,account}/route.ts` — session-guarded control-plane BFF
- `app/api/cosmos/items/route.ts` — data-plane query (POST) + get (GET)
- `app/api/cosmos/items/action/route.ts` — data-plane upsert / delete
- `app/api/cosmos/_shared.ts` — session / gate / error helpers (incl. 403 data-plane RBAC gate)
- `lib/components/cosmos/cosmos-tree.tsx` — Fluent v9 Data Explorer tree
- `lib/components/cosmos/cosmos-data-explorer.tsx` — Items query grid + Monaco JSON item editor
- `lib/editors/cosmos-account-editor.tsx` — host editor (`azure-cosmos-account` slug); Properties + Data Explorer (Items) tabs
- `lib/azure/__tests__/cosmos-data-client.test.ts` — data-plane REST + AAD-header + 403-gate contract tests

## Verification

- `pnpm build` exit 0.
- Functional E2E receipt (minted-session probe + real ARM response + screenshot)
  attaches to the PR per `no-vaporware.md` once a Cosmos account is pinned in the
  target deployment.
