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

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | ✅ | Tables + Files tabs/tree rendered |
| 2 | ✅ | ADLS Gen2 tree via lakehouse API |
| 3 | ✅ | New folder + upload wired (`canFileAction`) |
| 4 | ✅ | `preview` tab — sample rows |
| 5 | ✅ | `Query this file` → SQL tab, runs through serverless `/query` |
| 6 | ✅ | T-SQL via `/api/items/synapse-serverless-sql-pool/[id]/query` |
| 7 | ⚠️ honest-gate | Shortcuts tab renders a MessageBar naming the exact route (`/api/items/lakehouse/[id]/shortcuts`), Fabric REST endpoint, and UAMI workspace-membership requirement to provision. Full surface still renders. |
| 8 | ✅ | Query-this-file load path + SQL CTAS |
| 9 | ✅ | `Settings` dialog + `ItemSidePanel` |
| 10 | ✅ | `Permissions` dialog (`openPerms`) |
| 11 | ✅ | `Refresh` wired (`refreshActive`) |

## Backend per control
- Tree/preview/files → ADLS Gen2 data-plane (`@azure/storage-file-datalake`) via lakehouse API.
- T-SQL query → Synapse serverless TDS (`executeQuery` / `serverlessTarget`).
- Shortcuts → Fabric REST `POST /v1/workspaces/{ws}/items/{lakehouse}/shortcuts` (honest-gate; requires UAMI workspace membership).

Grade: **A− (one honest infra-gate on shortcuts; everything else built + real backend).**
