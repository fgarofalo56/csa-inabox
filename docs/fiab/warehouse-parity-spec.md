# Loom Warehouse Editor — Fabric-parity spec

> Captured 2026-05-26. Source: Fabric Data Warehouse documentation. Note: catalog agent `a25d745464518b765` mistakenly documented Eventhouse (KQL DB) — those findings went into `eventhouse-parity-spec.md`. This file documents the actual **Fabric Data Warehouse** UI.

## Overview
Fabric Data Warehouse = lake-centric distributed T-SQL warehouse (Polaris engine, similar to Synapse Serverless behavior). Loom's equivalent = the existing Synapse **Dedicated** SQL Pool editor (better Loom-equivalent for "warehouse-shaped" workloads).

## Fabric Warehouse UX

### Top toolbar
- **Tabs**: switches between Object Explorer modes (Schema view, Model view, Query view)
- **+ New SQL query** (opens new query tab)
- **Save / Save as / Share** buttons
- **Refresh** schema cache
- **Settings** / Workspace context

### Left — Object Explorer
- **Schemas** (dbo, custom)
  - **Tables** (each: schema icon, table name, expandable to columns with types + nullability)
  - **Views**
  - **Stored procedures**
  - **Functions** (scalar + table-valued)
  - **Types** (user-defined)
- Right-click on any item: Query top 100 · Drop · Properties · Refresh · Create stored proc with this · ...
- "Search objects" box at top

### Main pane — Query view
- **Monaco-based SQL editor** with T-SQL grammar + intellisense (column auto-complete from schema)
- **Run** button + dropdown (Run query / Run selection / Explain plan)
- **Cancel query** button when active
- **Results grid** below editor:
  - Column types annotation in headers (varchar, int, datetime, etc.)
  - Sortable + filterable columns
  - **Export** menu: CSV / JSON / Parquet
  - **Visualize** toggle (renders quick chart from results)
  - Row count + execution time
- **Messages tab** alongside Results (errors, warnings, info, query plan output)

### Main pane — Model view (relationships)
- Canvas with table cards + relationship lines
- Drag to create FK relationships
- Right-side properties pane for selected relationship (cardinality, cross-filter direction)

### Main pane — Visual Query Designer
- Drag-and-drop query builder (like SSIS query designer)
- Joins via canvas
- Generates T-SQL behind the scenes

### Settings tab
- Workspace context, capacity binding
- Refresh policies
- Security: workspace roles, RLS, column-level security, dynamic data masking

## What Loom has
- ✅ `synapse-dedicated-sql-pool` editor with: Run T-SQL · Resume-on-demand · Auto-pause Logic App
- ✅ `/api/items/synapse-dedicated-sql-pool/{id}/query` (real T-SQL)
- ✅ `/api/items/synapse-dedicated-sql-pool/{id}/schema` (schema browser)
- ✅ `/api/items/warehouse/[id]/query` (proxy to dedicated pool)
- ⚠️ Warehouse editor in `phase3-editors.tsx` is a thin wrapper, missing the rich Object Explorer + Visual Query Designer + Model view

## Gaps for parity
1. **Object Explorer tree** — currently flat list, needs Schemas → Tables/Views/Procs/Funcs hierarchy
2. **Multi-tab SQL editor** — only one query window at a time today
3. **Results grid features** — column types in header, sort/filter, export to CSV/JSON/Parquet, visualize toggle
4. **Messages tab** — separate pane for errors/warnings/plan
5. **Model view** — relationship canvas (Power BI-style)
6. **Visual Query Designer** — drag-drop query builder

## Backend
All Synapse Dedicated SQL Pool calls already work. New BFF routes needed:
- `/api/items/warehouse/[id]/object-tree` — full Schemas→Tables→Columns tree via INFORMATION_SCHEMA queries
- `/api/items/warehouse/[id]/export?format=csv|json|parquet` — stream query results to format
- `/api/items/warehouse/[id]/relationships` — read sys.foreign_keys for Model view

## Estimated effort
3 sessions: Object Explorer + multi-tab + Results enhancements is 1 session; Model view is 1; Visual Query Designer is 1 (or scope-cut to "view T-SQL of selected tables" if budget tight).
