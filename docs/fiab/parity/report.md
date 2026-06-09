# report — parity with Power BI report (service viewer)

Source UI: Power BI service report viewer — https://learn.microsoft.com/power-bi/consumer/end-user-reading-view ·
REST: https://learn.microsoft.com/rest/api/power-bi/reports
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `ReportLikeEditor` (`ReportEditor`)
Embed: `apps/fiab-console/lib/components/embed/powerbi-embed.tsx`

## Power BI feature inventory

| # | Capability | Where in Power BI |
|---|---|---|
| 1 | Workspace + report list, open report | Workspace content list |
| 2 | Live report render | Report canvas |
| 3 | Page navigation (tabs) | Page tabs / pages pane |
| 4 | Bookmarks — view, apply, capture personal | View ribbon -> Bookmarks |
| 5 | Refresh visuals | Report toolbar -> Refresh |
| 6 | Edit / Reading view toggle | Report toolbar -> Edit |
| 7 | Export to PDF / PPTX / PNG | Export menu |
| 8 | Refresh underlying data (semantic model) | Dataset -> Refresh now |
| 9 | Open in Power BI / copy link | More options |
| 10 | Filter pane | Right pane |
| 11 | Bookmark slideshow (View) | View -> Bookmarks -> View (play) |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | built | usePowerBiWorkspaces() (groupIds) + /api/items/report list, auto-select first |
| 2 | built | PowerBIEmbedFrame (embedType=report) via /api/items/report/[id]/embed-token |
| 3 | built | Pages panel from GET /api/items/report/[id]/pages; click -> embed setPage(name); pageChanged event syncs |
| 4 | built | Bookmarks panel — report.bookmarksManager getBookmarks/apply/capture (embed JS API) |
| 5 | built | Refresh visuals -> report.refresh() (embed JS API) |
| 6 | built | View/Edit Switch — re-mints embed token at Edit access level + report.switchMode() |
| 7 | built | Export PDF/PPTX/PNG -> POST /api/items/report/[id]/export (async ExportTo + poll + download) |
| 8 | built | Refresh data -> POST /api/items/report/[id]/refresh (resolves datasetId, queues dataset refresh) |
| 9 | built | Open in Power BI + Copy link from report.webUrl |
| 10 | built | Filter pane visible in the embed config |
| 11 | built (NEW) | Play/Stop bookmarks slideshow -> report.bookmarksManager.play(On/Off) (embed JS API); ribbon View group + bookmarks panel button |

## Backend per control
- Pages -> Power BI REST GET /groups/{ws}/reports/{id}/pages (getReportPages).
- Export -> POST /groups/{ws}/reports/{id}/ExportTo -> poll exports/{id} -> exports/{id}/file.
- Refresh data -> GET report for datasetId -> POST /datasets/{id}/refreshes.
- Embed token (View/Edit) -> POST /groups/{ws}/reports/{id}/GenerateToken.
- Pages / bookmarks / refresh-visuals / view-mode -> powerbi-client embed JS API (client-side, against the live embed session).

## Honest gates
- Edit mode requires the embed token minted with accessLevel: Edit, which requires the UAMI to have Member/Contributor on the workspace; a 401/403 surfaces verbatim in the embed MessageBar.

Grade: A — every inventory row built against the real Power BI REST API + embed JS API; backend contract tests in lib/azure/__tests__/powerbi-client-parity.test.ts + app/api/items/__tests__/powerbi-parity-routes.test.ts.

## Per-cloud notes

All capabilities use Power BI REST + the embed JS API; the sovereign host is resolved by `cloud-endpoints.ts`. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

| Cloud | Power BI REST host | Notes |
|---|---|---|
| Commercial | `api.powerbi.com` | Full coverage — render, pages, bookmarks, slideshow, refresh, view/edit, export (PDF/PPTX/PNG). |
| GCC | `api.powerbigov.us` | Full coverage. `ExportTo` (PDF/PPTX/PNG) is available in GCC. Embed renders against the Gov embed host. |
| GCC-High / IL4 | `api.high.powerbigov.us` | Full coverage. |
| DoD / IL5 | `api.mil.powerbigov.us` | Full coverage. |
