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
| 13 | Item / document data explorer | ⚠️ honest-gate | "coming" row — data-plane SDK + partition paging needed |
| 14 | Indexing policy editor | ⚠️ honest-gate | "coming" row |
| 15 | Conflict-resolution policy | ⚠️ honest-gate | "coming" row |
| 16 | Script authoring + execution | ⚠️ honest-gate | "coming" row — navigator lists scripts read-only |

Zero ❌. Items 13–16 are data-plane authoring surfaces disclosed as honest
`coming` rows under the tree's **Not yet wired** node (per `no-vaporware.md`),
each with a tooltip naming the exact REST/data-plane path required.

## Backend per control

| Control | Backend |
|---------|---------|
| Databases list / create / delete | ARM `…/sqlDatabases` (PUT/DELETE/GET 2024-11-15) |
| Containers list / create / delete | ARM `…/sqlDatabases/{db}/containers` |
| Throughput badges | ARM `…/throughputSettings/default` |
| Stored procedures / triggers / UDFs | ARM `…/containers/{c}/{storedProcedures\|triggers\|userDefinedFunctions}` |
| Account header | ARM GET `…/databaseAccounts/{acct}` |
| Auth | `ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID), DefaultAzureCredential)` → `https://management.azure.com/.default` |

## Infra gate (honest, per no-vaporware + ui-parity)

When the navigator account isn't configured every route returns
`503 { ok:false, code:'not_configured', missing, hint }` and the tree renders a
single Fluent `MessageBar intent="warning"` naming:

- env vars: `LOOM_COSMOS_ACCOUNT`, `LOOM_COSMOS_ACCOUNT_RG`, `LOOM_SUBSCRIPTION_ID`
- role: **Cosmos DB Operator** (or **DocumentDB Account Contributor**) at the account scope

403 from ARM (UAMI missing the role) is surfaced verbatim with that role hint.

## Files

- `lib/azure/cosmos-account-client.ts` — ARM client + `cosmosConfigGate()`
- `app/api/cosmos/{databases,containers,scripts,account}/route.ts` — session-guarded BFF
- `app/api/cosmos/_shared.ts` — session / gate / error helpers
- `lib/components/cosmos/cosmos-tree.tsx` — Fluent v9 Data Explorer tree
- `lib/editors/cosmos-account-editor.tsx` — host editor (`azure-cosmos-account` slug)

## Verification

- `pnpm build` exit 0.
- Functional E2E receipt (minted-session probe + real ARM response + screenshot)
  attaches to the PR per `no-vaporware.md` once a Cosmos account is pinned in the
  target deployment.
