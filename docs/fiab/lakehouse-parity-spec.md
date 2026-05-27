# Loom Lakehouse Editor — Fabric-parity spec

> Reference: `lh_bronze` Lakehouse in `casino-fabric-poc` (F64), captured 2026-05-26 by the catalog agent (run `a4f93461062e0e80c`).

## What's there in Fabric

### Page chrome
- Page title shows the Lakehouse name (`lh_bronze`)
- Standard Fabric workspace breadcrumb + capacity badges + global action bar (search, account, settings, notifications)

### Explorer sidebar (left)
- Header: `lh_bronze` with collapse arrow
- **Tables** section — expandable, lists every Delta table in the lakehouse:
  - `bronze_compliance`, `bronze_financial`, `bronze_player_profile`, `bronze_security`, `bronze_slot_telemetry`, `bronze_table_games`
  - Each table has an icon + name + (on hover) a kebab menu
- **Files** section — ADLS Gen2 file browser
- "**Add lakehouses**" search input — lets you add additional lakehouses as data sources to view side-by-side
- Bottom: ability to add shortcut / Get data

### Main pane — Ribbon
| Button | Behavior |
|---|---|
| **Open notebook** | Opens an existing notebook attached to this lakehouse OR creates a new one already wired up with the lakehouse as default attachment |
| **Add to data agent** ▼ | Wires the lakehouse to a Copilot Studio data agent. Dropdown picks which agent. |
| **Manage OneLake security** | Opens permissions pane: role assignments on the lakehouse (Read, Write, Build reports, etc.) |
| **Update all variables** | Refreshes variable libraries attached to the lakehouse |

### Main pane — body
- **View toggle**: "Table view" (current) — switchable to other views via dropdown
- **Selected table data grid** (e.g. `bronze_compliance`):
  - Header: column names sortable
  - Row count: "Showing 1000 rows"
  - Up to 22 rows visible, scrollable
  - Columns: `filing_id`, `filing_type`, `filing_timestamp`, `amount`, `player_id`, `compliance_status`, `property_code`, `player_name`, `sSN_hash`, `sSN_masked`, etc.
- **Info banner** at the top: "A SQL analytics endpoint for SQL querying was created with this item." + link → **Switch to query with T-SQL** (loads the auto-paired SQL endpoint editor)

### Auto-pairing pattern
Every Fabric Lakehouse comes with a **sibling SQL Analytics Endpoint** item automatically created on provisioning. The two items share the same Delta files but expose different access modes:
- **Lakehouse**: Spark-native, table preview, file browser, append/overwrite via notebook
- **SQL Analytics Endpoint**: T-SQL read-only access via TDS, same underlying Delta tables

In the Fabric workspace tree, they appear as two siblings with the same display name but different icons (Lakehouse vs SQL endpoint).

### Right-click context menu (observed)
- Open in notebook
- New shortcut
- Open SQL endpoint
- Properties
- Refresh
- Maintain (Delta vacuum/optimize)
- Delete

## What Loom already has
- ✅ ADLS Gen2 container + path browse (`/api/lakehouse/containers`, `/api/lakehouse/paths`)
- ✅ Synapse Serverless SQL query backend (real T-SQL works)
- ✅ Sample preview (currently text-based, not full grid)

## What's missing for parity
1. **Auto-paired SQL endpoint sibling** — when user creates a Lakehouse in Loom, automatically also create a `synapse-serverless-sql-pool` item pointed at the same ADLS path. Both appear in the workspace tree.
2. **Ribbon command bar** — add Open notebook / Add to data agent / Manage OneLake security / Update all variables / Maintenance buttons
3. **Real Delta table list** — currently Loom doesn't enumerate Delta tables under a Lakehouse; needs to scan the ADLS path for `_delta_log/` and surface them
4. **Per-table data grid** with sortable columns + row count (not just text preview)
5. **"Open in notebook"** — drops user into the Notebook editor with the Lakehouse pre-attached as default source + a sample read cell
6. **"Switch to query with T-SQL"** toggle — switches the editor to the paired SQL endpoint without leaving the page
7. **OneLake security pane** — RBAC at the Lakehouse / Table level (maps to ADLS RBAC + Synapse SQL grants)
8. **Right-click context menus** on tables: Open in notebook · New shortcut · Properties · Refresh · Maintain · Delete
9. **Add lakehouses search** in Explorer — pin multiple lakehouses side-by-side

## Build plan

| Phase | Work |
|---|---|
| **Backend** | New `/api/lakehouse/[id]/tables` → scans ADLS for `_delta_log/` markers, returns table list with row counts (Synapse Serverless `COUNT(*)`). New `/api/lakehouse/[id]/preview?table=X` → SELECT TOP 1000 via Serverless SQL with column types. New `/api/lakehouse/[id]/pair-sql-endpoint` (POST) → creates the sibling synapse-serverless-sql-pool item in Cosmos pointing at same ADLS path. New `/api/lakehouse/[id]/onelake-security` (GET/PUT) → ADLS RBAC + Synapse SQL grants. |
| **Frontend** | Replace flat preview with **DataGrid** component (sortable, column types). Add ribbon command bar. Wire "Open in notebook" → creates notebook + pre-attaches Lakehouse via the existing attached-sources mechanism. Add right-click context menus on tables. Add Add-lakehouse search box in Explorer. |
| **Auto-pairing** | Update `/api/workspaces/[id]/items` POST for itemType=`lakehouse` to also auto-create a sibling `synapse-serverless-sql-pool` item in the same workspace, with `state.adlsPath` matching. |

## Estimated effort
1-2 focused sessions (Backend first, then Frontend, then E2E test).
