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
| 16 | **Get data** ribbon menu (Upload, New shortcut, New dataflow, New pipeline, New notebook, Copy activity) | Home ribbon → Get data ▼ |
| 17 | **Analyze data** ribbon menu (SQL endpoint, New/Existing notebook) | Home ribbon → Analyze data ▼ |
| 18 | **New semantic model** (DirectLake over Delta) | Home ribbon |
| 19 | **Share** the lakehouse | Home ribbon → Share |
| 20 | **Reference (secondary) lakehouse** is read-only — write commands gray out | Explorer "Add lakehouses" |

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
| 16 | ✅ (built) | `Get data ▼` Fluent Menu in the ribbon (`ribbon.tsx` `dropdownItems`). Upload → `onUploadClick`; New shortcut → `setTab('shortcuts')` + `openShortcutWizard()`; New dataflow/pipeline/notebook/Copy activity → `router.push('/items/<type>/new')` (real registered editors). Every item navigates to a real surface — no toast. Grays out on a reference lakehouse. |
| 17 | ✅ (built) | `Analyze data ▼` menu. SQL endpoint → `setTab('sql')` (Synapse Serverless OPENROWSET, row 6 backend); New notebook → `/items/notebook/new?lakehouse=`; Existing notebook → `/items/notebook/new`. |
| 18 | ⚠️ (honest-gate) | `New semantic model` opens a `MessageBar intent="warning"` dialog: Fabric DirectLake needs a Power BI/Fabric capacity (no Azure-native 1:1), documents the Synapse-Serverless + Power BI Desktop path, and offers an in-app "Open SQL endpoint" action. Strictly opt-in via `LOOM_LAKEHOUSE_BACKEND=fabric`; never gates the default Azure-native lakehouse. |
| 19 | ✅ (built) | `Share` dialog grants Entra principals container-scope RBAC via the existing `/api/lakehouse/permissions` POST (Storage Blob Data Reader/Contributor/Owner). Real ARM role assignment — no Fabric/Power BI workspace. |
| 20 | ✅ (built) | `isReferenceLakehouse = state.isReference === true` drives `writeBlocked`; Refresh, Get data, Settings disable with a "Read-only — reference lakehouse" tooltip. Analyze data, Preview, Query, Permissions, Share (read/admin) stay enabled, matching Fabric. |

## Backend per control
- Tree/preview/files → ADLS Gen2 data-plane (`@azure/storage-file-datalake`) via lakehouse API.
- T-SQL query → Synapse serverless TDS (`executeQuery` / `serverlessTarget`) via `/api/items/lakehouse/[id]/query`.
- Download → ADLS `readToBuffer` (`downloadFile`) via `/api/lakehouse/download`.
- Context-menu commands → reuse the above backends (no separate / dead paths).
- Settings → `defaultSparkPool` is an enumerated Dropdown bound to real Synapse Spark pools from `/api/loom/compute-targets` (no freeform compute input); honest empty-state when none deployed.
- Shortcuts → **no backend yet, by design.** Honest infra-gate only. The Azure-native engine (ADLS Gen2 + Synapse Serverless / Databricks UC + Cosmos registry) is tracked in `docs/fiab/design/lakehouse-shortcuts.md`. The prior Fabric REST path (`/api/catalog/shortcut`) was removed from this editor to eliminate the lakehouse's last hard Fabric dependency.
- Get data / Analyze data menus → client-side `router.push` to existing item editors (`/items/dataflow|data-pipeline|notebook|copy-job/new`) + tab switches (`setTab('sql'|'shortcuts')`); upload/shortcut reuse the existing ADLS/wizard handlers. No new BFF route.
- Share → existing `/api/lakehouse/permissions` POST (ARM `Microsoft.Authorization/roleAssignments` at the container scope) — same backend the Permissions dialog uses.
- New semantic model → no backend (intentional honest-gate). DirectLake is Fabric-capacity-only and strictly opt-in; the dialog points to the Synapse-Serverless + Power BI Desktop Azure-native path.

Grade: **A (every inventory row is built with a real backend or an honest infra-gate that names the exact remediation; the Shortcuts row is an intentional honest-gate pending the tracked Azure-native engine build — zero Fabric dependency, zero dead controls).**
