# Loom Power BI Dashboard Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent `fabric-parity-loop`. Source: Microsoft Learn — Power BI dashboards/tiles (`/power-bi/create-reports/service-dashboards`, `service-dashboard-edit-tile`, `service-dashboard-create`, `service-dashboard-add-widget`) and Power BI REST API (`Dashboards` operations, `CloneTile`, embed).

A Power BI **Dashboard** is a single-page canvas (not a report) that aggregates **tiles** pinned from one or more reports, Q&A, Excel, SSRS, or standalone widgets. Editing happens entirely in the Power BI service (no Desktop equivalent) and tiles are the unit of composition — designers pin visuals from underlying reports/semantic models, then arrange/resize/restyle the dashboard canvas.

## UI components

### Top action bar (above the canvas)
- **+ Add a tile** — opens the widget picker (Web content, Image, Text box, Video, Custom streaming data, Real-time data)
- **Ask a question** — Q&A natural-language query box pinned at the top of the dashboard
- **Comments** pane toggle
- **View** menu — Phone view layout · Web view layout · Full screen · Print
- **Share** — direct user share / link share
- **Subscribe** — email subscription with cadence
- **Set as featured** / **Pin to** / **Favorite**
- **File** menu — Save a copy · Settings · Refresh dashboard tiles · Delete · Move to workspace
- **Edit** (toggle) — switches the dashboard into Editing view where tile move/resize/edit handles appear

### Dashboard canvas
- Grid-based tile layout, 1×1 through 5×5 cells per tile
- Drag-drop tile reposition (handle on top edge)
- Drag-resize tile bottom-right corner
- Tile flow on/off (auto-reflow vs free placement)
- Background image / color via dashboard Settings
- Mobile (phone) layout designer — separate vertical stack

### Per-tile chrome (Editing view)
- Hover reveals **More options (…)** menu:
  - Edit details (Tile details dialog)
  - Pin tile (clone to another dashboard, same/different workspace)
  - Open in Focus mode
  - Export data (when backed by a report visual)
  - Delete tile
- Pencil / pin icons on hover

### Tile details dialog (per tile)
- Title (override) · Subtitle
- Functionality section:
  - Display **last refresh time**
  - **Set custom link** — link to another dashboard/report in current workspace, web URL, SSRS report
  - Disable default click behavior
- Alerts (numeric / KPI / card tiles only) — threshold + Teams/email notification

### Add a tile (widget) dialog
- **Web content** — HTML/iframe snippet
- **Image** — URL with optional title and link
- **Text box** — rich text with title
- **Video** — YouTube / Vimeo URL
- **Custom streaming data** — bind to a streaming dataset push endpoint
- **Real-time data** — pre-existing streaming dataset visual

### Pin source flows (driven from upstream items, not the dashboard editor itself)
- **Pin from report** — pin icon on any report visual; choose existing or new dashboard
- **Pin a live page** — pin an entire report page as one interactive tile
- **Pin from Q&A** — type a question, then pin the resulting visual
- **Pin from Excel** — pin a range / table / PivotTable from a OneDrive/SharePoint workbook
- **Pin from SSRS** — pin paginated-report tiles via the on-prem gateway

### Settings pane (File > Settings)
- Rename dashboard
- Q&A on / off
- Tile flow on / off
- Background image / color
- Theme

### Comments pane (right side)
- Threaded comments per dashboard
- @-mentions push notifications
- Reply / resolve

### Q&A bar
- Natural language input across all tiles' underlying semantic models
- Suggested questions
- Result preview rendered as a visual; can be pinned

### Right-rail Insights / Smart narrative
- Auto-generated insights against the dashboard's underlying semantic models (where enabled)

## What Loom has
- `DashboardEditor` (apps/fiab-console/lib/editors/phase3-editors.tsx:1649)
- Workspace picker, refresh button, dashboard list (left tree)
- Tile grid that renders each tile as a card showing `subTitle`, `title`, and `colSpan×rowSpan`
- Tile-detail card showing `id`, `reportId`, `datasetId`, `embedUrl` as raw fields
- Cosmos-backed listing via `/api/items/dashboard` (already wired to a backend per the BFF route shape)
- C-grade verdict — listing + metadata works, **no embedded canvas, no widget picker, no tile-detail dialog, no Q&A**

## Gaps for parity
1. **No embedded dashboard canvas** — Fabric renders the actual tiled dashboard via the embed JS SDK; Loom shows only metadata cards
2. **No "+ Add a tile" widget picker** (Web content / Image / Text box / Video / Streaming)
3. **No tile detail dialog** (rename, custom hyperlink, alert threshold, refresh time)
4. **No tile move / resize handles** — Fabric supports drag positioning and 1×1–5×5 sizing
5. **No mobile/phone view designer**
6. **No Q&A bar** at top of dashboard
7. **No Pin-from-report / Pin-from-Q&A / Pin-from-Excel** flows (these originate in other editors but must land in dashboards)
8. **No Comments pane**
9. **No Subscribe / Share / Featured** action bar
10. **No alert configuration** for KPI/card tiles
11. **No dashboard Settings** (Q&A toggle, tile flow, background)
12. **No clone-tile** flow (Fabric supports duplicating tiles within or across dashboards)

## Backend mapping
- **List dashboards**: `GET /v1.0/myorg/groups/{groupId}/dashboards` (already used by Loom's `/api/items/dashboard`)
- **List tiles**: `GET /v1.0/myorg/groups/{groupId}/dashboards/{dashboardId}/tiles`
- **Get tile**: `GET /v1.0/myorg/groups/{groupId}/dashboards/{dashboardId}/tiles/{tileId}`
- **Clone tile**: `POST /v1.0/myorg/groups/{groupId}/dashboards/{dashboardId}/tiles/{tileId}/Clone` (`CloneTileRequest` with targetDashboardId/targetWorkspaceId/targetReportId/targetDatasetId/positionConflictAction) — backed by `Microsoft.PowerBI.Api.IDashboardsOperations.CloneTile`
- **Create dashboard**: `POST /v1.0/myorg/groups/{groupId}/dashboards` with `{name}`
- **Delete dashboard**: `DELETE /v1.0/myorg/groups/{groupId}/dashboards/{dashboardId}`
- **Embed dashboard**: generate an embed token via `POST /v1.0/myorg/groups/{groupId}/dashboards/{dashboardId}/GenerateToken`, then render via `powerbi-client` JS SDK using `embedType: 'dashboard'` and the tile-level `GenerateToken` for focus-mode tile drill-in
- **No public REST surface** exists for "Add tile (widget)" — Web content / Image / Text box tiles can only be added through the Power BI service UI today. Loom must either iframe the Fabric dashboard edit URL or document this gap with a MessageBar
- **Pin operations** (`POST /reports/{id}/Clone`, `pinVisualToDashboard`) live on the **report** side, not the dashboard side

## Required Azure resources / tenant settings
- Power BI Premium / Premium-Per-User / Fabric capacity assigned to the workspace (embed requires capacity)
- Tenant setting **Embed content in apps** = enabled
- Tenant setting **Service principals can use Power BI APIs** = enabled (Loom's SP must be in the security group)
- Workspace role for the calling identity: **Member** or **Contributor** for edit; **Viewer** for read-only embed
- For streaming/real-time tiles: a Power BI **streaming dataset** push endpoint provisioned
- For Q&A: the underlying semantic model must have Q&A enabled and synonyms configured

## Estimated effort
**3-4 sessions.**

- **Phase 1 (1 session)** — Embed the actual dashboard via `powerbi-client` SDK + `GenerateToken`; replace the metadata-card grid with the live rendered canvas. Add a "Open in Power BI" deep link as fallback.
- **Phase 2 (1 session)** — Surface tile detail dialog (Edit details, custom hyperlink, alerts) by capturing tile-click events from the embedded client and rendering Loom-chrome panes around them. Wire **CloneTile** for tile-copy.
- **Phase 3 (1 session)** — Build the "Add tile" widget picker for the four widget types REST cannot create — implement by deep-linking into the Power BI service "Add a tile" dialog inside an iframe popout (the same pattern Fabric uses). Document the limitation with a MessageBar.
- **Phase 4 (optional)** — Q&A bar (`powerbi-client` exposes Q&A iframe component), Comments pane (REST: `/v1.0/myorg/dashboards/{id}/comments`), Subscribe (`/subscriptions`).

## Notes
- Loom will not reimplement the dashboard canvas from scratch; it embeds the PBI dashboard inside Loom chrome (same pattern as Report editor)
- Several tile widget types (Web content, Image, Text box, Video) have **no public REST API** for create/update — these must remain documented gaps until the Fabric REST surface catches up, with a MessageBar pointing the user to the Power BI service for those specific widget actions
- Phone-view layout and tile flow toggles are Power-BI-service-only and cannot be replicated through REST
