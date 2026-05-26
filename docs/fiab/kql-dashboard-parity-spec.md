# KQL Dashboard / Real-Time Dashboard Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Fabric Real-Time Intelligence docs) + inspection of `apps/fiab-console/lib/editors/phase3-editors.tsx` `KqlDashboardEditor`. No live Real-Time Dashboard in `casino-fabric-poc`, so spec is from Fabric docs + Loom editor source.

## Overview

The Fabric Real-Time Dashboard (formerly KQL Dashboard) is the visual analytics surface on top of an Eventhouse/KQL Database. It is a collection of **tiles**, optionally organized into **pages**, where each tile is backed by a KQL query and rendered as a chart, stat, table, map, etc. It targets near-real-time observability of streaming data already landed in Kusto and is the typical consumption layer for Eventstream→Eventhouse pipelines.

## Fabric UX

### Top-level chrome — view vs. edit mode
- **Viewing mode** (default): tiles render; parameter filter bar at top; manual refresh; share + export.
- **Editing mode** toggle (top-right): unlocks the ribbon, add-visual buttons, page management, parameters pane, base queries, data source registration.

### Ribbon — Home tab (edit mode)
- **New visual** (add tile) · **Add markdown** (text/headers box) · **Add alert** (Activator hand-off) · **Add data source** · **Add parameter**
- **Save** · **Refresh** (manual) · **Auto-refresh** policy
- **Editing/Viewing** mode toggle · **Share** · **Export to PDF**

### Ribbon — Manage tab
- **Parameters** manager
- **Base queries** (named query fragments reusable across tiles)
- **Refresh settings** (interval, minimum, default)
- **Data sources** (registered KQL databases, Azure Data Explorer clusters)

### Panes
- **Pages pane** (left): list of pages with `Add page`, rename, reorder; supports drillthrough targets
- **Parameters pane** (top filter bar): live filter chips for every active parameter
- **Tile editor pane** (right, when editing tile): three sub-panes — **Explorer** (schema), **Run query** (KQL editor), **Copilot** (NL2KQL preview)
- **Visual formatting pane** (right): Visual type · Data binding · Display options · Legend · X/Y axis · Colors · Conditional formatting · Interactions

### Tile types
Backed by the KQL `render` operator plus dashboard-specific visuals:

**KQL `render` visuals**: anomaly chart · area chart · bar chart · column chart · line chart · pie chart · scatter chart · time chart · table · card

**Dashboard-specific visuals** (only in Real-Time Dashboards / ADX dashboards):
- **Stat** — single big number (with optional sparkline / delta)
- **Multi Stat** — grid of stats (1×1 up to 5×5 slot configuration)
- **Map** — geo-point visualization with `Latitude/Longitude`, `Geo point`, or `Infer` location modes; size column; label column
- **Funnel chart** — sequential stage drop-off
- **Heatmap** — 2-D numeric matrix with color palette
- **Markdown box** — static text/header/links (not query-backed)

### Parameters pane
Five parameter types:
1. **Single-selection / multi-selection** (drop-down from a query)
2. **Free text** (string input)
3. **Time range** (with default `_startTime` / `_endTime` variables)
4. **Data source** (switch between registered Kusto databases at runtime)
5. **Drillthrough** (column-to-parameter binding from a source tile)

Each parameter has: label, variable name (used in KQL as `_var`), data type, default value, "Show on pages" scope.

### Drillthrough config
On any tile in edit mode → **Interactions** → toggle **Drillthrough on**:
- **Destination page** (one or more target pages within the same dashboard)
- **Column → Parameter** pairs (same data type required)
- Selecting a value in the source visual opens the destination page with the parameter pre-filled

### Refresh policy
Per-dashboard auto-refresh (managed in Manage tab):
- **Minimum refresh interval** (lower bound viewers can pick)
- **Default refresh interval** (5s · 10s · 30s · 1m · 5m · 15m · 30m · 1h · 2h · 12h · 24h · never)
- Auto-refresh can be **enforced** by editors or left **viewer-controlled**

### Base query editor
Reusable named KQL fragments. Pattern:
```kql
// base query "recentEvents"
RawData | where Timestamp > ago(_lookback)
```
Tiles then `union recentEvents` or `recentEvents | summarize ...`. Single definition, many consumers — reduces duplication and improves cache reuse.

### Sharing & export
- **Share** dashboard with users/groups (Fabric workspace RBAC)
- **Export to PDF** (full dashboard or current page)
- **Pin tile to Power BI** (creates Power BI report from tile query)
- **Save to dashboard** from a KQL Queryset — push a query result directly as a tile

## What Loom has today

From `apps/fiab-console/lib/editors/phase3-editors.tsx::KqlDashboardEditor` and `app/api/items/kql-dashboard/[id]/route.ts`:
- Tile array persisted in Cosmos (`tiles: [{ title, kql, viz, database? }]`)
- Three viz types: `table` · `line` · `bar`
- `Add tile` · `Delete tile` · inline editor (title + viz select + KQL textarea)
- `Re-run all` button executes every tile's KQL via `executeQuery` and stores results inline
- `Edit JSON` raw editor for bulk tile authoring
- Per-tile result preview (5 rows of raw KQL output as `|`-joined text)
- Ribbon stub only — no functional sub-tabs
- `Save` persists to Cosmos; no Fabric workspace push

## Gaps for parity

1. **Visual breadth** — Loom has table/line/bar only; missing stat, multi-stat, map, pie, area, column, scatter, funnel, heatmap, anomaly, time chart
2. **Visual formatting pane** — no per-tile config for legend, axis labels/scale, color series, conditional formatting, slot layout
3. **Pages** — single flat canvas; no page tabs, no drillthrough targets
4. **Parameters** — no parameter bar, no `_var` substitution at execution time, no time-range/free-text/data-source parameter types
5. **Drillthrough** — entirely missing
6. **Auto-refresh policy** — no per-dashboard refresh interval; only manual `Re-run all`
7. **Base queries** — no reusable KQL fragments
8. **Markdown tiles** — no static text/heading support
9. **Data source registration** — single hard-coded `database` field; no multi-cluster/multi-DB picker UI
10. **Copilot NL2KQL** — Loom has cross-item Copilot but not the in-tile authoring pane
11. **Add alert** — no hand-off to Loom Activator from a tile
12. **Export to PDF** — not implemented
13. **Editing vs. Viewing mode** — no mode toggle; the surface is always editable

## Backend mapping

All KQL execution uses the **ADX/Kusto cluster** already provisioned for Loom Eventhouse:
- Tile KQL → `executeQuery(database, kql)` via the existing Kusto data-plane client (proven in UAT)
- Parameters → inject `let _var = …;` declarations before the tile KQL at execution time
- Base queries → store as named entries in the dashboard's Cosmos doc; prefix concatenated at execution
- Auto-refresh → client-side `setInterval` driven by per-dashboard policy persisted in Cosmos
- Drillthrough → URL-state encoding (query string) so destination page reads parameter values from the URL
- Export to PDF → server-side render via headless Chromium (`puppeteer` or Playwright) of the viewing-mode URL
- Add-alert → POST to existing `/api/items/activator/{id}/rules` with the tile's KQL embedded as the rule's monitor query

## Required Azure resources

All present in current FiaB deployment:
- ADX/Kusto cluster (Eventhouse equivalent) — already deployed
- Cosmos DB (for dashboard config) — already deployed
- App Service / Container App running the Console — already deployed

No new resources required. Optional: a Playwright-capable container for PDF export.

## Estimated effort

3 sessions. Visual breadth + formatting pane is ~1 session. Pages + parameters + drillthrough is ~1 session (interlocking features). Auto-refresh + base queries + alert hand-off + PDF export is the third session. Copilot NL2KQL inside the tile is a stretch goal worth a fourth session if the cross-item Copilot can be embedded cleanly.
