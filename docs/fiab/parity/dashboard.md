# dashboard — parity with Power BI dashboard

Source UI: Power BI dashboard — https://learn.microsoft.com/power-bi/create-reports/service-dashboards
REST: https://learn.microsoft.com/rest/api/power-bi/dashboards
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` -> `DashboardEditor`

## Power BI feature inventory

| # | Capability | Where in Power BI |
|---|---|---|
| 1 | Dashboard list + select | Workspace content list |
| 2 | Live dashboard render | Dashboard canvas |
| 3 | Tiles list + tile metadata | Dashboard tiles |
| 4 | Tile drill to source report | Click tile -> opens report |
| 5 | Open in Power BI / copy link | More options |
| 6 | Refresh cache / reload | Dashboard toolbar |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | built | /api/items/dashboard list (groupIds), auto-select first |
| 2 | built | PowerBIEmbedFrame (embedType=dashboard) via /api/items/dashboard/[id]/embed-token |
| 3 | built | Tiles grid + tile detail (reportId, datasetId, embedUrl) from GET dashboard detail (/tiles) |
| 4 | built | Drill to report button opens the tile's reportId in Power BI (https://app.powerbi.com/groups/{ws}/reports/{reportId}) |
| 5 | built | Open in Power BI + Copy link from webUrl |
| 6 | built | Refresh reloads list + tiles |

## Backend per control
- List -> GET /groups/{ws}/dashboards; tiles -> GET /groups/{ws}/dashboards/{id}/tiles.
- Embed token -> POST /groups/{ws}/dashboards/{id}/GenerateToken.
- Drill -> opens the tile.reportId in the Power BI service.

## Honest gates
- Tile authoring (pin visual, new tile, theme) lives in Power BI Web; the info MessageBar discloses this. Drill-to-report uses a deep link rather than an in-place report embed swap (Power BI's own tile click also navigates to the report).

Grade: A — list/embed/tiles/drill all live REST; authoring honestly routed to Power BI Web.

## Per-cloud notes

List, tiles, embed token, and drill use Power BI REST; the sovereign host is resolved by `cloud-endpoints.ts`. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

| Cloud | Power BI REST host | Notes |
|---|---|---|
| Commercial | `api.powerbi.com` | Full coverage — list, embed, tiles, drill-to-report. Tile authoring honest-gated to Power BI Web. |
| GCC | `api.powerbigov.us` | Same coverage; tile-authoring honest-gate unchanged. |
| GCC-High / IL4 | `api.high.powerbigov.us` | Same coverage. |
| DoD / IL5 | `api.mil.powerbigov.us` | Same coverage. |
