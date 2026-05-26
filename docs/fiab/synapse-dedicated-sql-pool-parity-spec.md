# Loom Synapse Dedicated SQL Pool — Azure-Studio-parity spec

> Captured 2026-05-26. Source: Synapse Studio Develop hub (SQL scripts) + dedicated SQL pool management UX, plus `apps/fiab-console/lib/editors/synapse-sql-editors.tsx` (`SynapseDedicatedSqlPoolEditor`).

## Overview
Synapse Dedicated SQL Pool (formerly SQL DW) is the MPP T-SQL warehouse layer of an Azure Synapse Analytics workspace. It sits next to ADLS Gen2, Serverless SQL, and Apache Spark pools as the "provisioned" compute target — pay-per-DWU, pause/resume on demand, and reachable from Synapse Studio's **Develop** hub (SQL script tab) and the **Manage → SQL pools** blade. In the Azure-native data stack it's the equivalent slot to Fabric Warehouse but with explicit compute lifecycle.

## Synapse Studio UX

### Develop hub — SQL script tab
- **Top toolbar**: connection picker (workspace · pool), database picker, **Run** / **Run selection** / **Cancel**, **Publish** (saves script artifact), **Properties**, **Discard changes**
- **Estimated cost** indicator (DWU-seconds estimate before run)
- **Monaco T-SQL editor** with full intellisense from the live pool catalog (column auto-complete, function signatures, syntax errors inline)
- **Results / Messages tabs** below editor — Results grid sortable + filterable, **Export results** (CSV / JSON), **Chart** view (line/bar/pie quick viz), row count + elapsed time

### Data hub — Workspace tab
- Tree: **SQL databases → {pool} → Tables / Views / Stored procedures / External resources / Schemas**
- Right-click on a table: `New SQL script → SELECT TOP 100 / CREATE / DROP / Statistics`
- "Show top 1000" generates a script tab automatically

### Manage hub — SQL pools blade
- **Status** badge (Online / Paused / Pausing / Resuming / Scaling)
- **Pause** / **Resume** buttons
- **Scale**: DWU slider (DW100c → DW30000c), Save commits an ARM update
- **Geo-backup** toggle, **Restore points** list
- **Transparent Data Encryption** toggle, **Workload management** (workload groups, classifiers, importance)
- **Firewall and virtual networks**, **Private endpoint connections**
- **Microsoft Entra admin** for the workspace, **SQL Active Directory admin**

### Monitor hub — SQL requests
- Active requests table, **query plan** view, **DMV explorer** (sys.dm_pdw_*), waits + memory grants per request

## What Loom has today (`SynapseDedicatedSqlPoolEditor`)
- Full Fluent UI `ItemEditorChrome` with ribbon (Query · State · Manage tabs declared, primary actions wired)
- **State badge** (Online / Paused / Pausing / Resuming / Scaling) with semantic color via `poolBadgeColor()`
- **Pause** + **Resume** + **Refresh** buttons → real ARM REST through `synapse-pool-arm.ts` (`pausePool` / `resumePool` / `getPoolState` — api-version `2021-06-01`)
- Auto-polling at 5s during Resume; lights up schema + Run when Online
- **MessageBar** explainer when Paused (cost framing) or Resuming (ETA + auto-light-up)
- **T-SQL textarea** (Consolas, monospace, 200px min, vertical resize)
- **Run** → POST `/api/items/synapse-dedicated-sql-pool/[id]/query`, real TDS via `synapse-sql-client.ts` against `{ws}.sql.azuresynapse.net` with MI AAD token, 60s timeout, 5000-row truncation
- **Schema tree** — GET `/api/items/synapse-dedicated-sql-pool/[id]/schema` returns `{schemas: {schema: [{table, rows}]}}`; click on a table seeds `SELECT TOP 100 * FROM [schema].[table]` into the editor
- **Results grid** with columns + cells, **execution ms** badge, row count badge, "truncated at 5,000" badge, **error MessageBar** with SQL error code
- `409 + state` flow → editor surfaces "Pool is {state}. Click Resume." cleanly

## Gaps for parity (numbered)
1. **Multi-tab SQL editor** — single textarea today; Studio supports multiple parallel script tabs per pool
2. **Monaco intellisense** — currently a plain `<textarea>`; no auto-complete, syntax highlighting, or live error squiggles. Replacing with the `@monaco-editor/react` instance already used by other A-grade editors would close this
3. **Run selection** — Run executes the whole textarea; no shift-select-run subset
4. **Estimated cost preview** before run (DWU-seconds projection)
5. **Results export** — no CSV/JSON download from the grid (only display)
6. **Chart view** — no quick-viz toggle on result rows
7. **DWU scale control** — Manage hub exposes the DWU slider; Loom only has pause/resume, no scale-up/down verb. ARM endpoint is the same `sqlPools/{name}` PATCH with `sku.name = DW{n}c`
8. **Workload management** UI — workload groups + classifiers not surfaced
9. **Restore points** — geo-backup + point-in-time restore not visible
10. **Query history / active requests** — no Monitor hub equivalent; would query `sys.dm_pdw_exec_requests` via the existing TDS client
11. **Right-click context menus** on schema tree (SELECT TOP 100 is wired but no DROP / Statistics / column DDL)

## Backend mapping
| Capability | Backend module | Notes |
|---|---|---|
| Pool state / pause / resume | `lib/azure/synapse-pool-arm.ts` (`getPoolState`, `pausePool`, `resumePool`, `waitForOnline`) | ARM REST `Microsoft.Synapse/workspaces/{ws}/sqlPools/{pool}` api-version 2021-06-01 |
| T-SQL query | `lib/azure/synapse-sql-client.ts` (`executeQuery`, `dedicatedTarget`) | TDS via `mssql`, AAD access token from `ChainedTokenCredential(UAMI, DefaultAzureCredential)`, scope `https://database.windows.net/.default`, server `{ws}.sql.azuresynapse.net` |
| Schema browse | `app/api/items/synapse-dedicated-sql-pool/[id]/schema/route.ts` | INFORMATION_SCHEMA + sys.partitions row counts |
| Scale (not wired) | Would PATCH same ARM URL with `{ sku: { name: 'DW1000c' } }` | Same credential, same api-version |
| Workload mgmt (not wired) | T-SQL via existing client: `CREATE WORKLOAD GROUP` / classifier DDL | Surface as form → DDL generator |

## Required Azure resources
- Azure Synapse Analytics workspace (`Microsoft.Synapse/workspaces`)
- Dedicated SQL pool (`Microsoft.Synapse/workspaces/sqlPools`) — env `LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_POOL`
- Workspace AAD admin set to the Container App UAMI (`uami-loom-console-eastus2`)
- Private endpoints to `{ws}.sql.azuresynapse.net` (and dev/ondemand) on the spoke VNet
- Container App egress NSG allows 1433 to the SQL PE
- Synapse Administrator role for the UAMI at the workspace (needed for ARM pause/resume + AAD-admin SQL login)
- All wired in `platform/fiab/bicep/modules/synapse/*.bicep`

## Estimated effort to close remaining gaps
- Items 1–3 (multi-tab Monaco editor with Run-selection): **0.5 session** — pattern is already in Loom's notebook editor, lift it
- Items 5–6 (CSV/JSON export + chart toggle): **0.5 session** — server route streams `recordset` to format; chart toggle reuses the recharts wrapper from Power BI editor
- Item 7 (DWU scale slider): **0.5 session** — add `PATCH /api/items/synapse-dedicated-sql-pool/[id]/scale` + slider in Manage tab
- Items 4, 8, 9, 10, 11 (cost preview, workload mgmt, restore points, query history, context menus): **1 session combined** — all are read-mostly T-SQL or ARM list calls

**Total to A+**: ~2.5 sessions. Today's grade is honest A — the primary action (Run T-SQL against a real Dedicated pool with real pause/resume) works end-to-end; the gaps are convenience surface, not functional vaporware.
