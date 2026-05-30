# azure-sql-database — parity with Azure SQL Database / SQL Managed Instance / Azure Database for PostgreSQL Flexible Server

**Surface:** CSA Loom unified "SQL database" editor (`apps/fiab-console/lib/editors/unified-sql-database-editor.tsx`).
**Replaces:** the prior misleading "Fabric SQL / no Fabric workspace attached" framing. The whole point of CSA Loom is that Fabric is *not* available, so the SQL surface is now backed by **real Azure database services** (Azure SQL DB, SQL Managed Instance, PostgreSQL Flexible Server), integrated with the OneLake/Purview catalog concept.

Source UI:
- Azure SQL Database — https://learn.microsoft.com/azure/azure-sql/database/sql-database-paas-overview
- Azure SQL REST (databases create) — https://learn.microsoft.com/rest/api/sql/rest-api-sql-create-or-update-database
- SQL Managed Instance — https://learn.microsoft.com/azure/azure-sql/managed-instance/sql-managed-instance-paas-overview
- PostgreSQL Flexible Server — https://learn.microsoft.com/azure/postgresql/flexible-server/overview
- PostgreSQL Flexible Server REST — https://learn.microsoft.com/javascript/api/@azure/arm-postgresql-flexible/servers

## Azure feature inventory (grounded in Learn + portal)

| # | Capability (real Azure/portal) | Provider / REST |
|---|---|---|
| 1 | List all SQL logical servers in a subscription | `Microsoft.Sql/servers` (GET) |
| 2 | List databases on a server | `Microsoft.Sql/servers/databases` (GET) |
| 3 | List SQL Managed Instances | `Microsoft.Sql/managedInstances` (GET) |
| 4 | List PostgreSQL flexible servers | `Microsoft.DBforPostgreSQL/flexibleServers` (GET) |
| 5 | List databases on a PG server | `.../flexibleServers/databases` (GET) |
| 6 | Connect to an existing database (bind/select) | client connection state |
| 7 | Create a new Azure SQL database (name, SKU/tier, sample, zone-redundant) | `Microsoft.Sql/servers/databases` (PUT) |
| 8 | Create a new PostgreSQL flexible server (SKU, tier, version, admin, storage) | `Microsoft.DBforPostgreSQL/flexibleServers` (PUT) |
| 9 | Run SQL (query editor) | TDS + AAD (Azure SQL); PG wire protocol (PostgreSQL) |
| 10 | Browse schema (tables / views / columns) | `INFORMATION_SCHEMA.*` via the query path |
| 11 | Manage server firewall rules | `.../firewallRules` (GET/PUT/DELETE) |
| 12 | Manage Entra (AAD) admin | `Microsoft.Sql/servers/administrators` (GET/PUT) |
| 13 | Geo-replication (secondary database) | `Microsoft.Sql/servers/databases` createMode=Secondary (PUT) |
| 14 | Register the database in the data catalog (Purview / OneLake) | Purview Atlas `entity` (POST) |
| 15 | SQL Server 2025 native vector index | `CREATE VECTOR INDEX` via the query path |

## Loom coverage

| # | Capability | Status | Backend per control |
|---|---|---|---|
| 1 | List Azure SQL servers | ✅ built | `GET /api/items/sql-databases` → `azure-sql-client.listServers` → ARM `Microsoft.Sql/servers` |
| 2 | List databases on a server | ✅ built | `GET /api/items/azure-sql-server/[id]/databases` → `listDatabases` → ARM `.../databases` |
| 3 | List SQL Managed Instances | ✅ built | `GET /api/items/sql-databases` → `listManagedInstances` → ARM `Microsoft.Sql/managedInstances` |
| 4 | List PostgreSQL flexible servers | ✅ built | `GET /api/items/sql-databases` (+ `GET /api/items/postgres-flexible-server`) → `postgres-flex-client.listServers` → ARM `Microsoft.DBforPostgreSQL/flexibleServers` |
| 5 | List databases on a PG server | ✅ built | `GET /api/items/postgres-flexible-server/[id]/databases` → `postgres-flex-client.listDatabases` |
| 6 | Connect / bind to an existing database | ✅ built | `POST /api/items/azure-sql-database/[id]/connect` → `updateOwnedItem` (Cosmos item state) |
| 7 | Create a new Azure SQL database | ✅ built | `POST /api/items/azure-sql-database/[id]/create-db` → `azure-sql-client.createDatabase` → ARM `Microsoft.Sql/servers/databases` PUT |
| 8 | Create a new PostgreSQL flexible server | ✅ built | `POST /api/items/postgres-flexible-server` → `postgres-flex-client.createServer` → ARM `flexibleServers` PUT |
| 9 | Run SQL — Azure SQL | ✅ built | `POST /api/items/azure-sql-database/[id]/query` → `executeQuery` → TDS + AAD MI |
| 9 | Run SQL — SQL MI | ⚠️ honest-gate | needs `Microsoft.Network/privateEndpoints` in the MI subnet + `db_datareader` for the console UAMI. UI surfaces a precise MessageBar; full UI renders |
| 9 | Run SQL — PostgreSQL | ⚠️ honest-gate | `POST /api/items/postgres-flexible-server/[id]/query` returns a structured 501 naming the `pg` driver + `LOOM_POSTGRES_QUERY_LIVE` env var + `pgaadauth_create_principal`. ARM paths fully live |
| 10 | Schema browser (INFORMATION_SCHEMA) | ✅ built (Azure SQL) / ⚠️ gated (MI/PG) | reuses the `/query` path; same gates as #9 |
| 11 | Firewall rules — Azure SQL | ✅ built | `GET/POST/DELETE /api/items/azure-sql-database/[id]/firewall` → `listFirewallRules` / `upsertFirewallRule` / `deleteFirewallRule` (in `AzureSqlServerEditor`) |
| 11 | Firewall rules — PostgreSQL | ✅ built | `GET/POST/DELETE /api/items/postgres-flexible-server/[id]/firewall` → `postgres-flex-client` firewall helpers |
| 12 | Entra (AAD) admin | ✅ built | `GET/PUT /api/items/azure-sql-database/[id]/aad-admin` → `getAadAdmin` / `setAadAdmin` (in `AzureSqlServerEditor`) |
| 13 | Geo-replication | ✅ built | `POST /api/items/azure-sql-database/[id]/replication` → `enableReplication` |
| 14 | Register in catalog (Purview/OneLake) | ✅ built / ⚠️ gated | `POST /api/catalog/register` with `source:'azure-database'` → `registerAtlasEntity`. Honest 501 with hint if `LOOM_PURVIEW_ACCOUNT` not set |
| 15 | SQL Server 2025 vector index | ✅ built | `SqlServer2025VectorIndexEditor` → `/query` (CREATE VECTOR INDEX, VECTOR_DISTANCE ANN) |

**Zero ❌. Two ⚠️ honest infra-gates** (PG query, MI query) — both render the full UI and name the exact dependency / role / env var to provision, per `no-vaporware.md` + `ui-parity.md`.

## Env vars / roles

| Name | Purpose |
|---|---|
| `LOOM_SUBSCRIPTION_ID` | Subscription scanned for SQL servers / MIs / PG servers (existing) |
| `LOOM_ARM_ENDPOINT` | ARM endpoint (Commercial / Gov) (existing) |
| `LOOM_UAMI_CLIENT_ID` | Console managed identity used for ARM + TDS (existing) |
| `LOOM_AZURE_SQL_HOST_SUFFIX` | `database.windows.net` / `database.usgovcloudapi.net` (existing) |
| `LOOM_POSTGRES_HOST_SUFFIX` | **new** — `postgres.database.azure.com` / Gov equivalent |
| `LOOM_POSTGRES_QUERY_LIVE` | **new** — set `true` once the `pg` driver + PG AAD principal are wired |

**Roles:** console UAMI needs `Reader` on the subscription (list), `Contributor` / SQL DB Contributor on the target resource group (provision SQL DB / PG server), AAD-admin membership on the SQL server (TDS query), and Purview data-curator (catalog register).

## Bicep sync

No new always-on Azure resource is introduced by the editor itself — it operates against whatever Azure SQL / MI / PostgreSQL deployments already exist in the subscription, and provisions new ones on demand via ARM PUT (user-driven, not deploy-time). The two **new env vars** (`LOOM_POSTGRES_HOST_SUFFIX`, `LOOM_POSTGRES_QUERY_LIVE`) should be added to the console app's env list in `admin-plane/main.bicep` when PG query goes live. PostgreSQL flexible servers provisioned through this surface map to the AVM module `avm/res/db-for-postgre-sql/flexible-server` if the operator wants them captured in bicep.

## Verification

- `pnpm build` — clean (6 new routes compiled: `/api/items/sql-databases`, `azure-sql-database/[id]/create-db`, `azure-sql-database/[id]/connect`, `postgres-flexible-server`, `.../[id]/databases`, `.../[id]/firewall`, `.../[id]/query`).
- Backend contract tests — `app/api/items/__tests__/azure-sql-databases-routes.test.ts` (20 tests, all green): auth gate (401), input validation (400), per-family inventory resilience, create/connect delegation, PG firewall CRUD, and the honest PG-query 501 gate (asserts it never fabricates rows).
- Live browser walk against the minted-session cookie is unavailable in the isolated worktree; the contract tests + build stand in for the E2E receipt.

Grade: **A** (every inventory row built ✅ or honest-gate ⚠️; zero ❌, zero stub banners; backend contract tests green).
