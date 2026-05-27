# Global parity gap: New-item dialog

**Validated**: 2026-05-26  
**Surface**: `+ New item` button on home page and `+ New workspace` on Workspaces; opens modal with item-type picker  
**Component**: `apps/fiab-console/lib/components/new-item-dialog.tsx` (per the rendered DOM and project structure)  
**Fabric reference**: Fabric "New item" modal grouped by Workload (Data Engineering, Data Factory, Data Warehouse, Databases, Real-Time Intelligence, Data Science, Power BI, Industry, …) with item cards per group  
**Backend probed**: Static catalog from `lib/catalog/fabric-item-types.ts`

## What renders (probed live)

- Click "+ New item" → modal dialog opens
- Dialog header: "New item"
- 20 category tabs in left rail:
  - Data Engineering
  - Data Factory
  - Data Warehouse
  - Databases
  - Real-Time Intelligence
  - Data Science
  - Fabric IQ
  - Power BI
  - APIs and functions
  - Synapse Analytics
  - Azure Databricks
  - Azure Data Factory
  - Azure Data Lake Analytics
  - Azure AI Foundry
  - Azure SQL Database
  - Azure Geoanalytics
  - Azure Graph + Vector
  - CSA Data Products
  - Copilot Studio
  - Power Platform
  - AI & Agents
- Right pane: grid of item-type cards per category (e.g., Lakehouse, Notebook, Spark job definition under Data Engineering, each with description and category badge)

## Functional probes

- Click "+ New item" — modal opens — PASS
- Categories render with real Fabric workload names + Azure-extension workloads (Synapse, ADB, ADF) — PASS
- Clicking a card routes to `/items/{slug}/new` — PASS (visible behavior across tabs)
- Category coverage exceeds Fabric (CSA Data Products, Copilot Studio, Power Platform are Loom-specific additions)

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| New-item modal | YES | — | Clean, scannable |
| Workload categories | YES + EXTENDED | — | 20 vs Fabric's ~10; includes Azure extensions and CSA additions |
| Item cards with description | YES | — | Name + category + description |
| Click → editor | YES | — | Routes to /items/{slug}/new |
| Search within picker | NOT SEEN | MINOR | Fabric has a search-in-dialog |
| Recent / pinned types | NO | MINOR | |
| Workload-hub browse | NO (but home does it) | — | The home page already has the workload chips |

## Grade: **A**

This is the strongest chrome surface in Loom. Real catalog, sensible grouping, more comprehensive than Fabric's stock picker. Only minor gaps (search-in-dialog, recent types).
