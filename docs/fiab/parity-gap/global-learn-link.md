# Global parity gap: Learn link (top-right ?)

**Validated**: 2026-05-26  
**Surface**: Question-mark icon in top-bar actions, links to `/learn`  
**Component**: AnchorButton in `lib/components/app-shell.tsx` (line 144-146), page at `app/learn/page.tsx`  
**Fabric reference**: Fabric Help button opens flyout with "Help", "Tutorials", "Documentation", "Community" links  
**Backend probed**: Static page; no API

## What renders

- `Question24Regular` icon, `aria-label="Help — open Learn library"`, `<a href="/learn">`
- /learn page: grid of "Hand-authored quick-starts for each item type. The same content surfaces in the editor's Learn drawer."
- Grid cards per item type: Eventstream, Eventhouse, KQL database, KQL queryset, KQL dashboard, Activator, Event schema set, Lakehouse, Mirrored database, Mirrored Databricks catalog, Warehouse, Synapse Serverless SQL Pool, Synapse Dedicated SQL Pool, SQL database, Azure SQL Database, Azure SQL Server, Azure SQL Managed Instance, SQL Server 2025 vector index, Notebook, Data pipeline, …
- Each card: "Create →" link + "MS docs ↗" external link

## Functional probes (auth'd)

- Click `?` icon → routes to `/learn` — PASS
- Page renders ~20+ item-type cards — PASS
- "Create →" links navigate to /items/{type}/new — PASS
- "MS docs ↗" links to real Microsoft Learn URLs — PASS (sampled 2 cards)

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Help button | YES | — | |
| Documentation link | YES | — | Per-card "MS docs" link |
| Tutorials | YES | — | "Create →" pre-fills the item editor |
| Community / Q&A | NO | MINOR | |
| Keyboard shortcuts help | NO | MINOR | |
| Search within Learn | NO | MINOR | No filter on page |
| Editor in-context Learn drawer | YES (per page header copy) | — | "same content surfaces in the editor's Learn drawer" |

## Grade: **B+**

Real authored content, ~25+ item-type cards, links to Create + MS docs. Better than a stub. Missing: in-page search and community link.
