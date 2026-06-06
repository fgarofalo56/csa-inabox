# lakehouse — parity with Fabric Lakehouse

Source UI: Fabric Lakehouse explorer — https://learn.microsoft.com/fabric/data-engineering/lakehouse-overview · https://learn.microsoft.com/fabric/data-engineering/navigate-lakehouse-explorer · https://learn.microsoft.com/fabric/data-engineering/lakehouse-shortcuts
Editor: `apps/fiab-console/lib/editors/lakehouse-editor.tsx`

## Fabric feature inventory (grounded in Learn)

| # | Capability | Where in Fabric |
|---|---|---|
| 1 | Two top-level folders: **Tables** (managed Delta) + **Files** (raw) | Explorer tree |
| 2 | Browse tables/files, expand folders, leaf preview | Explorer |
| 3 | Upload files / New folder | Files ribbon |
| 4 | File preview (sample rows) | Explorer leaf → preview |
| 5 | Query a file / table with T-SQL | SQL analytics endpoint |
| 6 | SQL analytics endpoint (read-only T-SQL over Delta) | "Analyze data with" dropdown |
| 7 | New shortcut (Tables: table/schema shortcut; Files: any folder) — ADLS Gen2 / S3 / GCS / Dataverse / internal Fabric | Explorer `...` → New shortcut |
| 8 | Load to Tables (file → Delta table) | Explorer context menu |
| 9 | Item Properties / Settings | Ribbon + side panel |
| 10 | Permissions on container/item | Manage |
| 11 | Refresh | Ribbon |
| 12 | Right-click context menu on objects | Explorer tree + grid |
| 13 | Download a file | Explorer context menu |
| 14 | Object Properties | Explorer context menu |
| 15 | List / delete existing shortcuts | Explorer (shortcuts appear as folders/tables) |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Tables + Files tabs/tree rendered |
| 2 | ✅ | ADLS Gen2 tree via lakehouse API |
| 3 | ✅ | New folder + upload wired (`canFileAction`) |
| 4 | ✅ | `preview` tab — sample rows |
| 5 | ✅ | `Query this file` → SQL tab, runs through serverless `/query` |
| 6 | ✅ (fixed) | T-SQL via the lakehouse's OWN route `/api/items/lakehouse/[id]/query` → Synapse Serverless (was wrongly POSTing to the synapse-serverless-sql-pool route with a lakehouse id → 404 HTML → JSON.parse crash). All `fetch().json()` now route through a `content-type`-sniffing `parseJsonOrError` guard. SQL endpoint shows a 503 MessageBar naming `LOOM_SYNAPSE_WORKSPACE` when unprovisioned. |
| 7 | ⚠️ (honest-gate) | Shortcuts tab renders an honest infra-gate `MessageBar intent="warning"`. The previous implementation bound to the **Fabric** OneLake Shortcuts REST (`/api/catalog/shortcut`) — a hard Fabric dependency the product must not have — and has been removed (no Fabric workspace/item binding, no Fabric POST, no dead controls). The Azure-native shortcut engine (ADLS Gen2 + Synapse Serverless / Databricks Unity Catalog external tables, Cosmos `lakehouse-shortcuts` registry, UAMI-backed) is a separately tracked build per `docs/fiab/design/lakehouse-shortcuts.md`. The gate names the exact engines/env vars and points to the design doc; the tab also offers the working zero-copy alternatives available today (Open-in-notebook `abfss://` + SQL `OPENROWSET`). |
| 8 | ✅ | Query-this-file load path + Load to Tables (Delta) deep-link |
| 9 | ✅ | `Settings` dialog + `ItemSidePanel` |
| 10 | ✅ | `Permissions` dialog (`openPerms`) |
| 11 | ✅ | `Refresh` wired (`refreshActive`) |
| 12 | ✅ (built) | `onContextMenu` → Fluent Menu anchored at cursor (`preventDefault`); distinct file vs folder command sets, each invoking the real backend. |
| 13 | ✅ (built) | Download via `/api/lakehouse/download` (ADLS byte passthrough, `attachment` disposition). |
| 14 | ✅ (built) | Properties dialog from the real ADLS metadata already in state. |
| 15 | ⚠️ (honest-gate) | Folds into row 7 — list/delete of native shortcuts ships with the Azure-native engine build (tracked design doc). No Fabric REST. |

## Backend per control
- Tree/preview/files → ADLS Gen2 data-plane (`@azure/storage-file-datalake`) via lakehouse API.
- T-SQL query → Synapse serverless TDS (`executeQuery` / `serverlessTarget`) via `/api/items/lakehouse/[id]/query`.
- Download → ADLS `readToBuffer` (`downloadFile`) via `/api/lakehouse/download`.
- Context-menu commands → reuse the above backends (no separate / dead paths).
- Settings → `defaultSparkPool` is an enumerated Dropdown bound to real Synapse Spark pools from `/api/loom/compute-targets` (no freeform compute input); honest empty-state when none deployed.
- Shortcuts → **no backend yet, by design.** Honest infra-gate only. The Azure-native engine (ADLS Gen2 + Synapse Serverless / Databricks UC + Cosmos registry) is tracked in `docs/fiab/design/lakehouse-shortcuts.md`. The prior Fabric REST path (`/api/catalog/shortcut`) was removed from this editor to eliminate the lakehouse's last hard Fabric dependency.

Grade: **A (every inventory row is built with a real backend or an honest infra-gate that names the exact remediation; the Shortcuts row is an intentional honest-gate pending the tracked Azure-native engine build — zero Fabric dependency, zero dead controls).**

## Settings — table optimization & acceleration (F12 / F22)

Source UI: Fabric Lakehouse table maintenance + Spark/Delta optimization —
https://learn.microsoft.com/azure/databricks/delta/clustering ·
https://learn.microsoft.com/fabric/data-engineering/delta-optimization-and-v-order ·
https://learn.microsoft.com/fabric/data-engineering/autotune ·
https://learn.microsoft.com/fabric/data-engineering/native-execution-engine-overview

Route: `apps/fiab-console/app/api/lakehouse/settings/route.ts` · Editor Settings dialog: `apps/fiab-console/lib/editors/lakehouse-editor.tsx` · Validation: `apps/fiab-console/lib/editors/lakehouse-spark-conf.ts`

| # | Capability | Status | Backend / disclosure |
|---|---|---|---|
| F12 | **Liquid clustering** — pick clustering columns for a Delta table | ✅ | Real `ALTER TABLE delta.\`abfss://…/Tables/<t>\` CLUSTER BY (<cols>)` via a Databricks SQL Warehouse (`executeStatement`). Azure-native, no Fabric. Table picker enumerated from the live `/Tables/` listing (+ bundle tables) — no freeform unless empty. Honest gate when `LOOM_DATABRICKS_HOSTNAME` unset / no warehouse exists; columns persist to Cosmos either way. Success MessageBar echoes the exact SQL and reminds to run `OPTIMIZE`. |
| F22a | **V-Order** toggle (`spark.sql.parquet.vorder.default`) | ⚠️ honest-gate | Persists preference to Cosmos. `MessageBar intent="warning"` states it is Fabric-Spark-only and that the Azure path (Synapse Spark / Databricks `OPTIMIZE`) runs standard Delta compaction without V-Order. No false "enabled-on-Azure" claim. |
| F22b | **Autotune** toggle (`spark.ms.autotune.enabled`) | ⚠️ honest-gate | Persists preference. Warning MessageBar: Fabric Runtime 1.2 only; key silently ignored on Synapse Spark / Databricks. |
| F22c | **Native execution engine** (Velox / Apache Gluten) | ⚠️ honest-gate | Persists preference. Warning MessageBar: Fabric Runtime 1.3 / 2.0 only; enabled at the capacity/runtime layer, not via a Spark config key. |
| F22d | **sparkConfig typo validation** | ✅ | `sparkConfigWarnings()` flags common typos (missing `spark.sql.` prefix, `BroadCast` casing, abbreviated `mem`, `enable`→`enabled`, legacy `vorder.enable`) as errors with the correct key + hint, and flags Fabric-only keys (`spark.ms.*`, `spark.sql.parquet.vorder.*`) as warnings. Unit-tested (`lib/editors/__tests__/lakehouse-spark-conf.test.ts`). |

Per-cloud honesty: the GET response returns the cloud boundary (commercial / gcc / gcch / il5, inferred from `AZURE_AUTHORITY_HOST` + `LOOM_GCCH`/`LOOM_IL5`); in GCC/GCC-High/IL5 the Fabric-only toggles append a note that there is no Fabric F-SKU / Fabric Spark path in that cloud so the preference has no runtime effect anywhere.

Bicep: `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` (optional warehouse pin, blank → first RUNNING warehouse) added to `platform/fiab/bicep/modules/admin-plane/main.bicep`. Liquid clustering reuses the already-deployed `LOOM_DATABRICKS_HOSTNAME` + Console UAMI Databricks workspace access.

Grade: **A+ (liquid clustering hits a real Databricks DDL backend; the three Fabric-only accelerators are honest persisted-preference gates with precise warning MessageBars — never a fake Azure "enabled"; sparkConfig validation is unit-tested; bicep-synced).**
