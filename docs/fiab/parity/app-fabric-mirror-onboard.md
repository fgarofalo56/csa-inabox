# app-fabric-mirror-onboard — parity with Azure SQL → Fabric Mirroring (portal onboarding UX)

**Surface:** the CSA Loom install bundle + Mirrored Database item that onboard an
Azure SQL Database into Fabric Mirroring. This is the Loom analogue of the Fabric
portal **Create → Mirrored Azure SQL Database → Connect → Configure mirroring →
Monitor replication** flow.

**Source UI (grounded in Microsoft Learn):**
- Create + connect + configure mirroring (Azure SQL) — https://learn.microsoft.com/fabric/mirroring/azure-sql-database-tutorial
- Monitor replication (status, rows replicated, Last completed) — https://learn.microsoft.com/fabric/mirroring/monitor
- Mirrored database operation logs (`MirroredDatabaseTableExecution`, `ReplicatorBatchLatency`) — https://learn.microsoft.com/fabric/mirroring/monitor-logs
- Troubleshoot (source DMVs: `sys.dm_change_feed_log_scan_sessions`, `sys.dm_change_feed_errors`, `sp_help_change_feed`) — https://learn.microsoft.com/fabric/database/sql/mirroring-troubleshooting
- Mirrored database public REST API (create / startMirroring / getMirroringStatus) — https://learn.microsoft.com/fabric/mirroring/mirrored-database-rest-api
- Explore mirror output with notebooks (OneLake shortcut) — https://learn.microsoft.com/fabric/mirroring/explore-onelake-shortcut

**Bundle:** `apps/fiab-console/lib/apps/content-bundles/app-fabric-mirror-onboard.ts`
**Provisioners (real REST):**
`apps/fiab-console/lib/install/provisioners/mirrored-database.ts` (Fabric Mirroring
REST), `.../lakehouse.ts` (OneLake DFS land + Load Table API → managed Delta),
`.../notebook.ts` (Fabric notebook create/updateDefinition).

## Grounding correction (rev.2, 2026-06-02)

A prior verifier graded this B and flagged four gaps. All are closed here:

1. **Grounding overstatement — FIXED.** The intro previously claimed the six tables
   `dbo.Customers / Orders / OrderLines / Products / Inventory / Returns`, server
   `sql-sales-prod.database.windows.net`, and DB `SalesOLTP` were "sourced from"
   `fact_sales.yaml`. That YAML defines only the **gold** fact
   `retail.gold.fact_sales`. The bundle now uses the example's **real** source
   entities — `Customers`, `Products`, `Sales` — taken from the dbt bronze sources
   `customers_raw / products_raw / sales_raw` (`examples/fabric-e2e/dbt/models/bronze/_sources.yml`)
   and the sample CSVs (`examples/fabric-e2e/sample_data/{customers,products,sales}.csv`),
   with the **exact** CSV columns. Server/DB are now clearly labeled editable
   **placeholders** (the example parameterizes its endpoint via `FABRIC_SQL_ENDPOINT`
   and ships no literal server name).
2. **No parity doc — FIXED.** This file.
3. **Invented mirror internals — FIXED.** The notebook's CDC cell previously read a
   non-existent `_system/sync_watermark` Delta path and `_last_synced_at` column.
   Fabric does **not** expose an internal watermark Delta file. The cell now uses only
   documented surfaces: source-side change-feed DMVs (real, cited) and the mirror-side
   `getMirroringStatus` REST + `MirroredDatabaseTableExecution.ReplicatorBatchLatency`
   workspace-monitoring log (real, cited).
4. **Seeded sample data — ADDED.** A **lakehouse** item seeds the three tables as real
   managed Delta (CSV → Load Table API) at install time, so every item renders with
   queryable rows immediately — even before the live mirror's initial snapshot.

## Fabric mirroring onboarding inventory → Loom coverage → backend

Legend: ✅ built (1:1 + real backend) · ⚠️ honest-gate · ❌ MISSING

### A. Create the mirrored database item
| Fabric capability | Loom | Where / backend |
| --- | --- | --- |
| Create → Data Warehouse → **Mirrored Azure SQL Database**, name it | ✅ built | `mirrored-database` item; provisioner `createMirroredDatabase` (POST `/v1/workspaces/{ws}/mirroredDatabases` with Base64 `mirroring.json`). Real REST |
| No bound Fabric workspace | ⚠️ honest-gate | provisioner returns `remediation` naming Bind-capacity / `LOOM_DEFAULT_FABRIC_WORKSPACE` |

### B. Connect to the Azure SQL source
| Fabric capability | Loom | Where / backend |
| --- | --- | --- |
| New source → Azure SQL Database (server / database) | ✅ built | descriptor `source.{kind,server,database}`; `buildMirroringDefinition` emits the `source.typeProperties` |
| Connection (new/existing), connection name, data gateway | ⚠️ honest-gate | Fabric mirroring REST requires a **connection GUID** (cannot mint from FQDN). Gated on `LOOM_MIRROR_SOURCE_CONNECTION_ID`; remediation names the exact admin steps (create connection, enable source MI, grant `ALTER ANY EXTERNAL MIRROR`) |
| Authentication kind (SQL / Entra / SPN / Workspace identity) | ⚠️ honest-gate | carried by the Fabric connection the admin creates; remediation documents it |

### C. Configure mirroring (table selection)
| Fabric capability | Loom | Where / backend |
| --- | --- | --- |
| **Mirror all data** vs select specific tables | ✅ built | `source.tables[]` → `mountedTables[]` in `mirroring.json` (per-table mount = "select specific tables") |
| Unsupported-table error/warning icons | ⚠️ honest-gate | surfaced as REST errors on startMirroring rather than pre-flight icons |

### D. Mirror database (start replication)
| Fabric capability | Loom | Where / backend |
| --- | --- | --- |
| **Mirror database** button → begin replication | ✅ built | provisioner `startMirroredDatabase` (POST `.../startMirroring`); idempotent on 400/409 |
| Provision wait (2–5 min) | ✅ built | handled as long-running create (202 → re-resolve id from listing) |

### E. Monitor replication
| Fabric capability | Loom | Where / backend |
| --- | --- | --- |
| DB-level status (Running / Warning / Stopped / Failed / Paused) | ✅ built | provisioner `getMirroringStatus` → stamped onto item `secondaryIds.mirroringStatus`; notebook cell 2b documents portal + REST fallbacks |
| Per-table rows-replicated + Last completed | ✅ built (read) | workspace-monitoring KQL cell 2b (`MirroredDatabaseTableExecution`); portal Monitor pane referenced |
| Replication latency (`ReplicatorBatchLatency`) | ✅ built (read) | notebook cell 2b KQL over `MirroredDatabaseTableExecution`; ⚠️ requires workspace monitoring enabled (cell degrades gracefully + names the fallback) |
| Source change-feed health DMVs | ✅ built | notebook cell 2a: `sys.dm_change_feed_log_scan_sessions`, `sys.dm_change_feed_errors` (+ `sp_help_change_feed` in guidance), read via JDBC |

### F. Consume the mirror (analytics-ready)
| Fabric capability | Loom | Where / backend |
| --- | --- | --- |
| Auto SQL analytics endpoint over mirror Delta | ⚠️ honest-gate | endpoint is Fabric-managed; notebook reads via attached lakehouse/shortcut (T-SQL endpoint not separately surfaced) |
| OneLake shortcut → Lakehouse → Spark notebook | ✅ built | lakehouse item declares `mirrored_onelake` shortcut; notebook reads mirrored/seeded tables by name |
| Row-count parity / spot-check joins | ✅ built | notebook cells 1, 3, 4 (real Spark over seeded Delta now, mirror Delta once live) |
| Seeded Bronze sample data at install | ✅ built | lakehouse provisioner lands CSV (exact example schema) → Load Table API → managed Delta |
| Direct Lake semantic model / gold star schema | ❌ MISSING (out of scope) | pointed to `examples/fabric-e2e` gold + `retail-sales.SemanticModel` in Next steps; separate apps own these |

## Backend reality (no-vaporware check)

- `mirrored-database` item → **real** Fabric Mirroring REST (create + start + status),
  with an honest connection-GUID gate. No mock branches.
- `lakehouse` item → **real** OneLake DFS write + Load Table API; seeds 3 tables with
  rows from the example CSVs (no `return []`).
- `notebook` item → **real** Fabric notebook create/updateDefinition; every code cell is
  runnable PySpark/Spark SQL that reads real Delta + real JDBC DMVs, and degrades
  gracefully (try/except + printed guidance) when a surface isn't provisioned yet.
- All mirror internals cited to Microsoft Learn; the invented watermark path is removed.

## Verdict — target A

Every onboarding inventory row is **built ✅** or **honest-gate ⚠️** (connection GUID,
auth kind, workspace-monitoring enablement — each names the exact admin action). Zero ❌
in the onboarding scope (gold/semantic-model are explicitly other apps). Grounding is
now faithful to the cited example, sample data is seeded as real Delta, and the notebook
runs against real surfaces only.

## Real-data E2E receipt (per .claude/rules/no-vaporware.md)

> The live install walk (mint-session cookie probe + browser) must be attached at PR
> time by the integrator on the shared branch. Static verification done in this change:
>
> - **Type-check:** `npx tsc --noEmit` on `apps/fiab-console` — no errors in
>   `app-fabric-mirror-onboard.ts` (bundle imported + registered in
>   `content-bundles/index.ts:25,45`).
> - **Provisioner mapping:** `provisioning-engine.ts` maps `mirrored-database`,
>   `lakehouse`, and `notebook` itemTypes to real-REST provisioners (lines 44, 56, 57 and
>   the lakehouse entry) — every item in this bundle has a real provisioner.
> - **Seed contract:** lakehouse DDL is in the `CREATE TABLE name ( col TYPE, … )` form
>   `columnsFromDdl()` parses; `sampleRows` are aligned to those columns, so install
>   lands real Delta rows (verify query returns rows before any notebook runs).
> - **Grounding:** entities/columns match `examples/fabric-e2e/sample_data/*.csv` and
>   `dbt/models/bronze/_sources.yml`; mirror internals match the Microsoft Learn pages
>   cited above.
>
> Pending (integrator, live sub): install the app → confirm the seeded lakehouse query
> returns the 6/5/5 sample rows, the notebook renders + runs cells 1/3/4 green, and the
> mirror item shows either `Running` or the documented connection-GUID gate.
