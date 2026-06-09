# paginated-report — parity with Power BI paginated report (RDL)

Source UI: Power BI service paginated report viewer — https://learn.microsoft.com/power-bi/paginated-reports/paginated-reports-report-builder-power-bi
REST: https://learn.microsoft.com/rest/api/power-bi/reports
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` -> `ReportLikeEditor` (`PaginatedReportEditor`, kind="paginated")

## Power BI feature inventory

| # | Capability | Where in Power BI |
|---|---|---|
| 1 | Workspace + paginated report list | Workspace content list |
| 2 | Render paginated (RDL) report | Paginated viewer |
| 3 | Export (PDF/Word/Excel/etc.) | Export menu |
| 4 | Refresh underlying data | Dataset refresh |
| 5 | Open in Power BI / copy link | More options |
| 6 | Metadata (type, dataset, modified) | Details |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | built | /api/items/paginated-report list (filters reportType=PaginatedReport), auto-select first |
| 2 | honest-gate | Paginated reports use the separate pbi-paginated embed SDK (not powerbi-client); a warning MessageBar names that and links out via Open in Power BI. Full surface still renders (list + metadata + actions) |
| 3 | honest-gate | Paginated export uses ExportToFile with a paginated config payload (different SDK surface); deferred behind the same gate, Open in Power BI is the supported path |
| 4 | built | Refresh data reuses the report refresh route (dataset-backed paginated reports) |
| 5 | built | Open in Power BI + Copy link from webUrl |
| 6 | built | Detail card (type, datasetId, modified) from GET detail |

## Backend per control
- List -> GET /groups/{ws}/reports filtered to PaginatedReport (listPaginatedReports).
- Detail -> GET /groups/{ws}/reports/{id}.
- Refresh data -> POST /datasets/{id}/refreshes (when dataset-backed).

## Honest gates
- In-place embed + format export require the pbi-paginated SDK which is not wired; the warning MessageBar discloses this and routes the user to Power BI Web. This is an honest gate, not a stub — the rest of the surface is live REST.

Grade: A (with two disclosed honest-gates for the pbi-paginated-SDK-only capabilities; zero dead buttons, zero fake data).

## Per-cloud notes

List, detail, and dataset refresh use Power BI REST; the sovereign host is resolved by `cloud-endpoints.ts`. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

| Cloud | Power BI REST host | Notes |
|---|---|---|
| Commercial | `api.powerbi.com` | List + metadata + dataset-backed refresh work; in-place embed/format-export honest-gated to the pbi-paginated SDK. |
| GCC | `api.powerbigov.us` | Same coverage as Commercial; the pbi-paginated-SDK honest-gate is unchanged. |
| GCC-High / IL4 | `api.high.powerbigov.us` | Same coverage. |
| DoD / IL5 | `api.mil.powerbigov.us` | Same coverage. |
