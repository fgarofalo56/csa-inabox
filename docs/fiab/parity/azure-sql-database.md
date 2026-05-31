# azure-sql-database — parity with Azure SQL Database (Azure portal blade)

> **Honest audit 2026-05-31 (supersedes the prior self-graded "A").** The
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

> **Critical wiring gap (the audit hinges on this):** when a user opens an
> **Azure SQL database** item they get `UnifiedSqlDatabaseEditor`. The firewall
> dialog, AAD-admin dialog, geo-replica dialog, Fabric-mirroring tab, SQL-2025
> tab, and the full object tree (`SqlDbTree`) all live in **components this item
> never mounts**. So even where a backend exists, the capability is **not
> reachable** from the registered editor. Rows below grade what the registered
> editor actually surfaces; where a capability exists only in an unwired
> sibling, it is `missing (not reachable)`.

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
| Object Explorer tree beside query window | ⚠️ partial | **Schema** tab = flat `INFORMATION_SCHEMA.TABLES` grid only (no tree, no views/procs/funcs, no columns, no actions). Rich `SqlDbTree` exists but only on Fabric `sql-database` editor |
| 5-min timeout / multi-statement last-result | ⚠️ partial | 60s timeout; single recordset |
| Cancel running query | ❌ MISSING | — |

### C. Settings → Compute & storage (scale)
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Change service tier (Basic/Std/Prem/GP/BC/Hyperscale) | ❌ MISSING | no update route; SKU is create-only |
| Change vCores / DTUs (slider) | ❌ MISSING | — |
| Serverless min/max vCores + auto-pause delay | ❌ MISSING | — |
| Max data size | ❌ MISSING | create-only (`maxSizeBytes`) |
| Backup storage redundancy (LRS/ZRS/GRS/GZRS) | ❌ MISSING | — |
| Zone redundant | ⚠️ partial | `createDatabase` accepts at create; no UI checkbox, no post-create edit |

### D. Create / provision
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Create DB on existing server (name, SKU, tier, sample) | ✅ built | Provision tab → `POST /create-db` → ARM PUT `Microsoft.Sql/servers/databases`. Real |
| Seed AdventureWorksLT | ✅ built | `sampleName` → ARM |
| Collation / maintenance window / Ledger / elastic-pool placement / workload env | ❌ MISSING | form is name+SKU+tier+sample only |

### E. Security blade
| Azure capability | Loom | Where / backend |
| --- | --- | --- |
| Server firewall rules (list/add/delete) | ❌ MISSING (not reachable) | real `/firewall` + `list/upsert/deleteFirewallRule`; UI in unwired `AzureSqlServerEditor` |
| Microsoft Entra admin (get/set) | ❌ MISSING (not reachable) | real `/aad-admin` + `get/setAadAdmin`; UI in unwired `AzureSqlServerEditor` |
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
| Active geo-replication (add secondary, list replicas, failover) | ❌ MISSING (not reachable) | real `enableReplication` (`createMode=Secondary`) + `/replication`; dialog in unwired `AzureSqlDatabaseEditor`; no replica list / failover anywhere |
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

### H. Object navigator — reachable ONLY via the Fabric `sql-database` editor
Fully built + real over TDS, but **not on the audited `azure-sql-database` editor** — recorded so a reviewer knows the rich tree is elsewhere:
| Capability | Loom | Backend |
| --- | --- | --- |
| Tables + expandable columns (type/PK/identity/nullable) | ✅ built (Fabric editor only) | `/api/sqldb/{tables,columns}` → `sys.tables/columns` |
| Views / Procs / Functions / Table types / Schemas + counts | ✅ built (Fabric editor only) | `/api/sqldb/*` → `sys.*` |
| Select-top-1000 / EXEC template / Drop (catalog-verified) / New-object template / filter | ✅ built (Fabric editor only) | `/api/sqldb/*` + client templates |
| Indexes / Keys & constraints / Edit-data grid / Query plan | ⚠️ honest-gate | "coming" rows naming the path |

---

## Backend reality (no-vaporware check)

Real backends confirmed — TDS via `mssql`+AAD, or ARM REST:
- Query exec (`executeQuery`), catalog enum (`sys.*`), drops — REAL TDS.
- ARM: list servers/databases/MIs, create DB (PUT), firewall CRUD, AAD-admin get/set, geo-replica create (`createMode=Secondary`) — REAL.
- PostgreSQL flex: list/create/databases/firewall REAL; **query gated** (`LOOM_POSTGRES_QUERY_LIVE`, no `pg` driver).
- Managed Instance: list-only REAL; query honest-gated (needs private endpoint).
- Mirroring honest-gated; Catalog register honest-gated.

No mock arrays / `return []` placeholders in the SQL backends. The vaporware risk here is **not fake data** — it is **breadth + reachability**: most of the portal blade is absent, and the strongest implemented features (object tree, firewall, AAD admin, geo-replication) are wired into siblings the `azure-sql-database` item never mounts.

## Verdict — Grade C-

The registered editor delivers a real, working Query + Provision + flat-Schema + Catalog experience on a live TDS/ARM backend — genuinely useful, not vaporware. But against the actual Azure SQL Database portal blade the **majority of capabilities are MISSING** (scale/compute, backups/PITR/LTR/restore, copy, export/import, networking, TDE/Defender/auditing, monitoring, QPI, connection strings, results export), and the strongest implemented features are **not reachable** from this editor. Feature completeness does not match. Counts: ~6 built, ~7 partial/gated, ~30 missing.

## Highest-value gaps (build first)
1. **Wire `SqlDbTree` into `UnifiedSqlDatabaseEditor`** — it already exists with a real `sys.*` backend; biggest parity jump for least work.
2. **Surface firewall + AAD-admin + geo-replication in the registered editor** — backends already exist, just not mounted.
3. **Compute & storage (scale)** — add a `PATCH`/update route for tier / vCore / serverless / auto-pause / max-size / backup-redundancy.
4. **Backups & restore** — PITR + geo-restore + LTR policy routes.
5. **Results export (CSV/JSON/XLSX) + Save-as-view + connection-strings panel** in the Query editor.
6. **Lifecycle on the Azure SQL DB item** — Delete / Copy / Export-Import bacpac.
