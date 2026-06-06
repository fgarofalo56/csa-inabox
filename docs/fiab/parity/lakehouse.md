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
| 16 | **Reference / add another lakehouse** to the explorer for read-only side-by-side browse + preview; primary distinguished; writes blocked on references | Lakehouse explorer "Add lakehouse" (reference lakehouses) |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Tables + Files tabs/tree rendered. The **Tables** tree is the live Delta catalog (real `_delta_log` scan), grouped by schema, with Delta/non-Delta icons and broken/empty status badges. |
| 2 | ✅ | ADLS Gen2 tree via lakehouse API. Tables tab additionally renders a per-schema grid: format, status (ok/broken/empty), Delta version, row count, size, last-modified — all from the live scan. |
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
| 16 | ✅ (built) | **Reference Lakehouses federation (F8).** Left explorer shows the **primary lakehouse (bold)** plus a **References** section; the **+** picker lists in-workspace lakehouses (from Cosmos `items`) and adds them via `/api/lakehouse/references` (persisted on `state.referencedLakehouseIds` — no new container). Each reference is an expandable tree node (containers → real ADLS files via the **read-only** `/api/lakehouse/references/paths` route). Selecting a reference file runs a real OPENROWSET preview through the account-scoped `/api/lakehouse/preview?...&account=` route (pass-through RBAC). **Write actions (Upload / New folder / Delete) render disabled with a Tooltip** in the reference pane — there is no write BFF route for references, so the disable is enforced, not cosmetic. Unreachable references (UAMI lacks Storage Blob Data Reader) show an error icon + the exact remediation tooltip. Zero Fabric dependency — same-account refs use the primary LOOM ADLS account; cross-account refs use the lakehouse's `state.storageAccount`. |

## Backend per control
- Tree/preview/files → ADLS Gen2 data-plane (`@azure/storage-file-datalake`) via lakehouse API.
- **Live Tables catalog** → `GET /api/lakehouse/tables` → `synapse-catalog-client.scanLakehouseTables`: ADLS Gen2 directory scan of each container's `Tables/` dir + `_delta_log` read for Delta detection / latest commit version / status, parquet-byte size aggregation, and optional Synapse Serverless `OPENROWSET COUNT(*)` row counts (`rowCounts=true`). Row counts are `null` — never a fabricated 0 — when Serverless is offline. No Fabric / OneLake dependency. Requires the Console UAMI hold **Storage Blob Data Reader** on the lakehouse storage account (granted by `synapse-storage-rbac.bicep` via the `consolePrincipalId` param). Honest-empty `{ ok: true, tables: [], gate }` when no `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL` is set.
- T-SQL query → Synapse serverless TDS (`executeQuery` / `serverlessTarget`) via `/api/items/lakehouse/[id]/query`.
- Download → ADLS `readToBuffer` (`downloadFile`) via `/api/lakehouse/download`.
- Context-menu commands → reuse the above backends (no separate / dead paths).
- Settings → `defaultSparkPool` is an enumerated Dropdown bound to real Synapse Spark pools from `/api/loom/compute-targets` (no freeform compute input); honest empty-state when none deployed.
- Shortcuts → **no backend yet, by design.** Honest infra-gate only. The Azure-native engine (ADLS Gen2 + Synapse Serverless / Databricks UC + Cosmos registry) is tracked in `docs/fiab/design/lakehouse-shortcuts.md`. The prior Fabric REST path (`/api/catalog/shortcut`) was removed from this editor to eliminate the lakehouse's last hard Fabric dependency.
- Reference Lakehouses (F8) → `/api/lakehouse/references` (GET list + workspace picker, POST add/remove) over Cosmos `items` (`state.referencedLakehouseIds`, validated to the same workspace to prevent reference-injection); `/api/lakehouse/references/paths` (GET only — read-only ADLS `listPaths` with optional `state.storageAccount`); read-only preview via `/api/lakehouse/preview?...&account=` (account-scoped OPENROWSET, validated `^[a-z0-9]{3,24}$`). Cross-account references require the Console UAMI to hold **Storage Blob Data Reader** on the referenced storage account — see `docs/fiab/v3-tenant-bootstrap.md#reference-lakehouse-cross-account-rbac`. Same-account references work out of the box (the UAMI already holds Storage Blob Data Contributor on the primary LOOM ADLS account).

Grade: **A (every inventory row is built with a real backend or an honest infra-gate that names the exact remediation; the Shortcuts row is an intentional honest-gate pending the tracked Azure-native engine build — zero Fabric dependency, zero dead controls).**
