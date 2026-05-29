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
| 7 | ✅ (built) | Shortcuts tab is a working create/list/delete surface → `/api/catalog/shortcut` → Fabric `createOneLakeShortcut`/`listOneLakeShortcuts`/`deleteOneLakeShortcut`. Targets: ADLS Gen2, Amazon S3, OneLake. Honest-gate: requires a Fabric workspace id + lakehouse item id (ADLS-backed Loom lakehouse has no native binding) + the “Service principals can use Fabric APIs” tenant toggle + UAMI workspace membership + a cloud connection GUID for external targets — full dialog renders regardless. |
| 8 | ✅ | Query-this-file load path + Load to Tables (Delta) deep-link |
| 9 | ✅ | `Settings` dialog + `ItemSidePanel` |
| 10 | ✅ | `Permissions` dialog (`openPerms`) |
| 11 | ✅ | `Refresh` wired (`refreshActive`) |
| 12 | ✅ (built) | `onContextMenu` → Fluent Menu anchored at cursor (`preventDefault`); distinct file vs folder command sets, each invoking the real backend. |
| 13 | ✅ (built) | Download via `/api/lakehouse/download` (ADLS byte passthrough, `attachment` disposition). |
| 14 | ✅ (built) | Properties dialog from the real ADLS metadata already in state. |
| 15 | ✅ (built) | Shortcuts table lists + deletes via the Fabric REST. |

## Backend per control
- Tree/preview/files → ADLS Gen2 data-plane (`@azure/storage-file-datalake`) via lakehouse API.
- T-SQL query → Synapse serverless TDS (`executeQuery` / `serverlessTarget`) via `/api/items/lakehouse/[id]/query`.
- Download → ADLS `readToBuffer` (`downloadFile`) via `/api/lakehouse/download`.
- Context-menu commands → reuse the above backends (no separate / dead paths).
- Shortcuts → Fabric REST `GET/POST/DELETE /v1/workspaces/{ws}/items/{lakehouse}/shortcuts` via `/api/catalog/shortcut` (honest-gate naming the Fabric binding + tenant prerequisites).

Grade: **A (all inventory rows built + real backend; remaining non-functional states are honest infra-gates that still render the full UI).**
