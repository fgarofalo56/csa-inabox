# azure-sql-database — parity with Azure SQL Database (Azure portal blade)

> **rev.2 — corrected against current code (2026-05-31, PR #541).** The prior
> revision (below) hinged on a "critical wiring gap": the registered
> `azure-sql-database` editor (`UnifiedSqlDatabaseEditor`) did **not** mount the
> rich `SqlDbTree` object navigator, nor the firewall / Entra-admin /
> geo-replication dialogs — so those real backends were unreachable from the
> editor a user actually opens. **That gap is now closed.** The Unified editor
> now mounts `SqlDbTree` in a **Schema** tab (real `sys.*` over TDS, via an
> explicit `?server=&database=` override the BFF guard supports) AND a **Server
> admin** tab (`SqlServerAdminPanel`) with firewall CRUD, Microsoft Entra admin
> get/set, and active geo-replication — all calling the pre-existing real ARM
> routes. The rows below are re-graded; the breadth gaps (scale, backups/PITR,
> export/import, monitoring) remain real and unbuilt.
>
> ---
> **Honest audit 2026-05-31 (rev.1 — superseded in part by rev.2 above).** The
> previous version of this doc graded itself A by inventorying only the 15 ARM
> operations the author chose to build, not the real Azure portal blade. It
> also claimed firewall / AAD-admin / geo-replication were "built" without
> noting they live in `AzureSqlServerEditor` / `AzureSqlDatabaseEditor` — which
> the registered `azure-sql-database` editor never mounts. Re-graded against the
> actual portal blade below.

**Source UI:** Azure portal SQL database blade + Query editor (preview)
- Overview / manage — https://learn.microsoft.com/azure/azure-sql/database/single-database-manage
- Query editor (preview) — https://learn.microsoft.com/azure/azure-sql/database/query-editor
- Connect & query (portal) — https://learn.microsoft.com/azure/azure-sql/database/connect-query-portal
- Compute & storage (scale) — https://learn.microsoft.com/azure/azure-sql/database/single-database-scale
- Networking / firewall — https://learn.microsoft.com/azure/azure-sql/database/firewall-configure
- Automated backups + restore — https://learn.microsoft.com/azure/azure-sql/database/automated-backups-overview
- Geo-replication — https://learn.microsoft.com/azure/azure-sql/database/active-geo-replication-overview

## Audited Loom code (2026-05-31)

- Registered editor for item type `azure-sql-database` → `apps/fiab-console/lib/editors/unified-sql-database-editor.tsx` (`UnifiedSqlDatabaseEditor`), confirmed `lib/editors/registry.ts:126`. Tabs: **Connect · Provision · Query · Schema · Catalog**.
- `lib/editors/azure-sql-editors.tsx` exports `AzureSqlServerEditor` (item `azure-sql-server` only), `AzureSqlDatabaseEditor` (**not registered to any item type**), `SqlManagedInstanceEditor`, `SqlServer2025VectorIndexEditor`.
- `lib/components/sqldb/sqldb-tree.tsx` (`SqlDbTree`) rich object navigator — mounted **only** by `SqlDatabaseEditor` (Fabric `sql-database` type), NOT by the registered Azure SQL editor.
- Backends: `lib/azure/azure-sql-client.ts` (TDS via `mssql` + AAD token; ARM REST), `lib/azure/sql-objects-client.ts` (`sys.*` over TDS), `lib/azure/postgres-flex-client.ts`.
- BFF routes: `app/api/items/sql-databases/route.ts`; `app/api/items/azure-sql-database/[id]/{query,create-db,connect,firewall,aad-admin,replication,mirroring,sql2025-features}/route.ts`; `app/api/items/azure-sql-server/...`; `app/api/sqldb/{tables,views,procedures,functions,schemas,table-types,columns}/route.ts`.

> **Critical wiring gap — RESOLVED in rev.2 (PR #541).** The audit originally
> hinged on this: `UnifiedSqlDatabaseEditor` did not mount `SqlDbTree` or the
> firewall / AAD-admin / geo-replication dialogs. As of PR #541 the Unified
> editor now mounts:
> - **Schema tab → `SqlDbTree`** (`unified-sql-database-editor.tsx:824-832`),
>   passing `server`/`database` so the BFF guard (`app/api/sqldb/_shared.ts:55-83`,
>   explicit `?server=&database=` override) resolves the user-selected Azure SQL
>   target. Real `sys.*` over TDS.
> - **Server admin tab → `SqlServerAdminPanel`** (`:168`, `:859-868`): firewall
>   list/add/delete → `/firewall`; Microsoft Entra admin get/set → `/aad-admin`;
>   active geo-replication → `/replication`. All real ARM routes.
>
> So firewall, Entra admin, geo-replication, and the rich object tree are now
> **reachable** from the registered editor. Fabric-mirroring and SQL-2025 remain
> separate (mirroring honest-gated; SQL-2025 is its own item type). Rows below
> are updated accordingly.

---

## Azure portal blade inventory → Loom coverage → backend

Legend: ✅ built (1:1 + real backend, reachable) · ⚠️ partial · ⚠️ honest-gate · ❌ MISSING

### A. Overview blade (toolbar + summary)
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Overview card (status, FQDN, tier, size, location, earliest restore point, connection mode) | ❌ MISSING | Connect tab grids servers/regions/FQDN; no per-DB overview |
| Toolbar **Copy** (database copy) | ❌ MISSING | no route |
| Toolbar **Restore** (PITR / new DB from backup) | ❌ MISSING | no route |
| Toolbar **Export** (.bacpac) | ❌ MISSING | no route |
| Toolbar **Import** | ❌ MISSING | — |
| Toolbar **Set server firewall** | ❌ MISSING (not reachable) | real `/firewall` route + `AzureSqlServerEditor` dialog, not mounted by this item |
| Toolbar **Delete** database | ❌ MISSING | no ARM DELETE on `azure-sql-database` |
| **Connect with…** (SSMS / VS Code / connection strings) | ❌ MISSING | no connection-strings panel |
| Move / Tags / JSON view / Feed | ❌ MISSING | generic ARM ops absent |

### B. Query editor (preview) — core data plane
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Sign-in (SQL auth / Entra "Continue as") | ⚠️ honest-gate | no interactive sign-in; uses console UAMI AAD token; gate fires if UAMI not Entra admin (not 1:1) |
| Run T-SQL, render Results grid | ✅ built | Query tab → `POST /azure-sql-database/[id]/query` → `executeQuery()` TDS. Real |
| T-SQL editor w/ highlight | ✅ built | `MonacoTextarea` lang `tsql` |
| Results: rowCount + exec-ms + truncation badge | ✅ built | route returns these (cap 5,000) |
| **Download results** CSV / JSON / XLSX | ❌ MISSING | render only |
| **Save query as view** | ❌ MISSING | — |
| Templates dropdown (new object scaffolds) | ⚠️ partial | only in `SqlDbTree` (Fabric editor), not this Query tab |
| **Open in** SSMS / VS Code | ❌ MISSING | — |
| Object Explorer tree beside query window | ✅ built | **Now reachable.** Schema tab mounts the rich `SqlDbTree` (tables + expandable columns, views, procs, functions, table types, schemas with counts; Select-top-1000 / EXEC template / Drop / New-object) over live `sys.*`-via-TDS (`unified-sql-database-editor.tsx:824-832`; routes `/api/sqldb/*`). Double-click loads a statement into the Query tab. INFORMATION_SCHEMA grid retained as a fallback below the tree |
| 5-min timeout / multi-statement last-result | ⚠️ partial | 60s timeout; single recordset |
| Cancel running query | ✅ built | Query tab **Cancel** button → `POST /azure-sql-database/[id]/query/cancel` with the client `requestId`. The BFF looks the in-flight `mssql.Request` up in `liveRequests` and calls `.cancel()`, sending a real **TDS ATTENTION** packet; SQL Server acks (err 3617) and the query rejects with `RequestError('Canceled.','ECANCEL')`, surfaced to the grid. Verified with `WAITFOR DELAY '00:00:30'` |
| Run query in background (survives tab switch/close) | ✅ built | `run()` delegates to module-scope `jobsStore.startSqlQuery()`; the fetch outlives the editor unmount. A backgrounded query that completes raises a Fluent completion toast naming the DB + row count/exec-ms via `GlobalJobToaster`. On remount the editor recovers the result from the store. (Portal Query editor has no equivalent — Loom exceeds parity here) |

### C. Settings → Compute & storage (scale)
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Change service tier (Basic/Std/Prem/GP/BC/Hyperscale) | ❌ MISSING | no update route; SKU is create-only |
| Change vCores / DTUs (slider) | ❌ MISSING | — |
| Serverless min/max vCores + auto-pause delay | ❌ MISSING | — |
| Max data size | ❌ MISSING | create-only (`maxSizeBytes`) |
| Backup storage redundancy (LRS/ZRS/GRS/GZRS) | ✅ built (create-time) | Provision tab dropdown → `requestedBackupStorageRedundancy` (Local/Zone/Geo/GeoZone) → ARM PUT. Post-create edit still MISSING |
| Zone redundant | ✅ built (create-time) | Provision tab checkbox → `zoneRedundant` → ARM PUT. Post-create edit still MISSING |

### D. Create / provision
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Create DB on existing server (name, SKU, tier, sample) | ✅ built | Provision tab → `POST /create-db` → ARM PUT `Microsoft.Sql/servers/databases`. Real |
| Seed AdventureWorksLT | ✅ built | `sampleName` → ARM |
| Collation (enumerated, default `SQL_Latin1_General_CP1_CI_AS`) | ✅ built | Provision tab dropdown → `collation` → ARM PUT. Validated client + route (`/^[A-Za-z0-9_]+$/`). Immutable after create |
| Maintenance window | ✅ built | Provision tab dropdown, options from `GET /maintenance-configs?location=` (ARM Maintenance API, scope=SQLDB) → `maintenanceConfigurationId` → ARM PUT. Empty region ⇒ System default only |
| Ledger / elastic-pool placement / workload env | ❌ MISSING | not yet surfaced |

### E. Security blade
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Server firewall rules (list/add/delete) | ✅ built | **Now reachable** in the Server admin tab (`SqlServerAdminPanel`): list + add (ARM upsert) + delete → `/api/items/azure-sql-database/[id]/firewall` (`list/upsert/deleteFirewallRule`, real ARM) |
| Microsoft Entra admin (get/set) | ✅ built | **Now reachable** in the Server admin tab: shows current admin + sets login/sid/tenant → `/api/items/azure-sql-database/[id]/aad-admin` (`get/setAadAdmin`, real ARM) |
| Networking (public/selected/Private endpoint/VNet/Allow-Azure-services) | ❌ MISSING | none in registered editor |
| TDE | ❌ MISSING | — |
| Microsoft Defender for SQL | ❌ MISSING | — |
| Auditing | ❌ MISSING | — |
| Dynamic data masking / Ledger / Always Encrypted | ❌ MISSING | — |
| DB users / roles management | ❌ MISSING | only via raw T-SQL |

### F. Data management — backups / restore / replicas
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Point-in-time restore | ❌ MISSING | no route |
| Geo-restore | ❌ MISSING | no route |
| Long-term retention policy | ❌ MISSING | no route |
| Active geo-replication (add secondary, list replicas, failover) | ⚠️ partial | **Add-secondary now reachable** in the Server admin tab: pick replica server/region/db/SKU → `/api/items/azure-sql-database/[id]/replication` (`enableReplication`, `createMode=Secondary`, real ARM). Still **no replica list / failover** (create-only) |
| Failover groups | ❌ MISSING | — |
| Database copy | ❌ MISSING | — |
| Export / Import bacpac | ❌ MISSING | — |

### G. Monitoring / performance / integrations
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Metrics charts (DTU/CPU/IO) | ❌ MISSING | — |
| Query Performance Insight | ❌ MISSING | — |
| Automatic tuning / recommendations | ❌ MISSING | — |
| Activity log / Diagnostic settings / Alerts | ❌ MISSING | — |
| Fabric mirroring toggle | ❌ MISSING (not reachable) + honest-gate | `enableMirroring` gated on `LOOM_AZURE_SQL_MIRRORING_LIVE`; UI tab in unwired `AzureSqlDatabaseEditor` — no mirroring control on registered surface |
| Purview/OneLake catalog register | ⚠️ partial / honest-gate | Catalog tab → `POST /api/catalog/register`; 501 honest-gate unless `LOOM_PURVIEW_ACCOUNT`. Real, but not a portal-native blade feature |
| SQL Server 2025 vector / feature probe | ⚠️ partial (separate item) | real `/sql2025-features` + vector-index editor — a **separate item type**, not the SQL DB blade |
| Get data / ingest into DB (Copy data, pipeline, dataflow) | ✅ built (Azure-native, no Fabric) | Ribbon **Get data ▾** + **Get data** tab → `POST /api/items/azure-sql-database/[id]/get-data`. `copy-data` returns the ADF Studio **Copy Data Tool** deep-link (this DB is the sink); `new-pipeline`/`new-dataflow` idempotently upsert an `AzureSqlDatabase` linked service (SystemAssignedManagedIdentity) + `AzureSqlTable` dataset + a Copy-activity pipeline / MappingDataFlow with that sink via real ARM (`upsertLinkedService`/`upsertDataset`/`upsertPipeline`/`upsertDataFlow`), then `window.open` the authoring canvas. Sovereign-aware (`adfStudioBase()` → `adf.azure.us` on Gov). Honest-gates: 503 naming the missing `LOOM_SUBSCRIPTION_ID`/`LOOM_DLZ_RG`/`LOOM_ADF_NAME`; warning when the factory is `publicNetworkAccess: Disabled`; one-time hint to grant the factory MI `db_datareader`+`db_datawriter`. Run receipt: paste ADF run id → COUNT(\*) template in Query tab |

### H. Object navigator — now reachable on the registered `azure-sql-database` editor (rev.2)
As of PR #541 the rich `SqlDbTree` is mounted by `UnifiedSqlDatabaseEditor` (Schema tab) **and** the Fabric `sql-database` editor; both share the same `sys.*`-over-TDS backend (`/api/sqldb/*`, with the Unified editor passing an explicit `?server=&database=` override):
| Capability | Loom | Backend |
| --- | --- | --- |
| Tables + expandable columns (type/PK/identity/nullable) | ✅ built (both editors) | `/api/sqldb/{tables,columns}` → `sys.tables/columns` |
| Views / Procs / Functions / Table types / Schemas + counts | ✅ built (both editors) | `/api/sqldb/*` → `sys.*` |
| Select-top-1000 / EXEC template / Drop (catalog-verified) / New-object template / filter | ✅ built (both editors) | `/api/sqldb/*` + client templates |
| Indexes / Keys & constraints / Edit-data grid / Query plan | ⚠️ honest-gate | "coming" rows naming the path |

---

## Backend reality (no-vaporware check)

Real backends confirmed — TDS via `mssql`+AAD, or ARM REST:
- Query exec (`executeQuery`), catalog enum (`sys.*`), drops — REAL TDS.
- ARM: list servers/databases/MIs, create DB (PUT), firewall CRUD, AAD-admin get/set, geo-replica create (`createMode=Secondary`) — REAL.
- PostgreSQL flex: list/create/databases/firewall REAL; **query gated** (`LOOM_POSTGRES_QUERY_LIVE`, no `pg` driver).
- Managed Instance: list-only REAL; query honest-gated (needs private endpoint).
- Mirroring honest-gated; Catalog register honest-gated.

No mock arrays / `return []` placeholders in the SQL backends. As of rev.2 the **reachability** problem is fixed: the object tree, firewall, Entra admin, and geo-replication are all mounted on the registered editor. The remaining vaporware-adjacent risk is **breadth** — large portal pillars (scale, backups/restore, monitoring, export/import) are still absent.

## Verdict — Grade C+ (rev.2, was C-)

The registered editor now delivers a real, working Query + Provision + **rich object tree (sys.* over TDS)** + **Server admin (firewall / Entra admin / geo-replica add)** + Catalog experience on a live TDS/ARM backend — and these are all reachable from the editor a user actually opens (the rev.1 reachability blocker is resolved by PR #541). Grade raised C- → C+. It still falls short of B: against the full Azure SQL Database portal blade the **majority of capabilities remain MISSING** (scale/compute, backups/PITR/LTR/restore, copy, export/import, networking, TDE/Defender/auditing, monitoring, QPI, connection strings, results export, replica list/failover). Feature completeness does not yet match. Revised counts: ~12 built, ~6 partial/gated, ~26 missing.

## Highest-value gaps (build first)
1. ~~Wire `SqlDbTree` into `UnifiedSqlDatabaseEditor`~~ — **DONE (PR #541)**, now in the Schema tab.
2. ~~Surface firewall + AAD-admin + geo-replication in the registered editor~~ — **DONE (PR #541)**, now in the Server admin tab. (Geo-replication still create-only — add replica list + failover.)
3. **Compute & storage (scale)** — add a `PATCH`/update route for tier / vCore / serverless / auto-pause / max-size / backup-redundancy.
4. **Backups & restore** — PITR + geo-restore + LTR policy routes.
5. **Results export (CSV/JSON/XLSX) + Save-as-view + connection-strings panel** in the Query editor.
6. **Lifecycle on the Azure SQL DB item** — Delete / Copy / Export-Import bacpac.
