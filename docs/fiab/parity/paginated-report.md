# paginated-report — parity with Power BI / SSRS Paginated Reports (RDL)

Source UI: Power BI Report Builder / SSRS report viewer
- https://learn.microsoft.com/power-bi/paginated-reports/paginated-reports-report-builder-power-bi
- https://learn.microsoft.com/power-bi/paginated-reports/report-builder-parameters
- https://learn.microsoft.com/sql/reporting-services/report-design/tables-tablix-region-report-builder

Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `PaginatedReportEditor`

CSA Loom renders paginated reports **Azure-native by default** — no Microsoft
Fabric / Power BI workspace is required (per `no-fabric-dependency.md`). An RDL
authored in Report Builder / SSRS is imported into the Loom item, parsed, and
rendered over Synapse Serverless SQL (or Azure Analysis Services for
`asazure://` datasets). Power BI is a strictly opt-in alternative source.

## Power BI / SSRS feature inventory

| # | Capability (real Report Builder / RDL viewer) | Notes |
|---|-----------------------------------------------|-------|
| 1 | Open / load a report definition (.rdl)        | Report Builder opens .rdl; the service hosts a published report |
| 2 | Report parameters surfaced as a prompt bar    | typed inputs, dropdowns from valid-value lists, defaults, Boolean toggles |
| 3 | Run report with chosen parameter values       | dataset queries re-execute with the bound parameters |
| 4 | Multi-page layout (tablix / table / list / chart, matrix) | data regions paginate at the RDL page height |
| 5 | Page navigation (first / prev / next / last, page N of M) | viewer pager |
| 6 | Datasets execute against the report's data source | SQL / DAX / OData etc. |
| 7 | Export (PDF / Excel / Word / CSV / image)     | viewer export menu |
| 8 | Schedule / subscribe                          | delivery to email / file share |

## Loom coverage

| # | Capability | Status | Where |
|---|-----------|--------|-------|
| 1 | Import .rdl definition (file upload → stored on the item) | ✅ built | `PaginatedReportEditor` (Import .rdl) → `PUT /api/items/paginated-report/[id]/definition` → Cosmos `state.rdlXml` |
| 2 | Parameter prompt panel (typed Input / number / datetime, valid-value Dropdown, Boolean Switch, defaults seeded) | ✅ built | left panel, driven by `extractParams()` over the parsed RDL |
| 3 | Run report with parameter values (injection-safe `@Name` binds) | ✅ built | `renderPaginatedReport` → `resolveParamValues` → Synapse `executeQuery(..., binds)` |
| 4 | Multi-page tablix / table / list / chart layout | ✅ built | `buildSections` + `paginateSections` (rows-per-page from RDL / `LOOM_RDL_ROWS_PER_PAGE`) |
| 5 | Page navigation (Page N of M, Prev / Next) | ✅ built | main panel pager; server-side pagination returns one page per request |
| 6 | Datasets execute against a real Azure backend | ✅ built | Synapse Serverless SQL (default), Azure Analysis Services XMLA for `asazure://` (`aas-client`), or Power BI executeQueries (opt-in) |
| 7 | Export (PDF / Excel / …) | ⚠️ honest-gate | opt-in Power BI path can call ExportTo; the Azure-native renderer surfaces data in-grid. Tracked for a follow-up renderer-side PDF export. |
| 8 | Schedule / subscribe | ⚠️ honest-gate | report subscriptions are a separate tracked workstream (see backlog) |

Chart regions render their bound data as a grid in this PR (visual chart
rendering is a UI follow-up); the data is real, not a placeholder.

## Backend per control

| Control | Backend |
|---------|---------|
| Import .rdl | `PUT /api/items/paginated-report/[id]/definition` → `saveItemState` (Cosmos) |
| Load params | `GET /api/items/paginated-report/[id]/definition` → `parseRdlMetadata` |
| Run / page nav | `POST /api/items/paginated-report/[id]/render` → `renderPaginatedReport` |
| SQL dataset | `synapse-sql-client.executeQuery` (TDS, parameter binds) |
| DAX dataset (`asazure://`) | `aas-client.executeDaxQuery` (AAS XMLA) |
| DAX dataset (opt-in Power BI) | `powerbi-client.executeDatasetQueries` |
| Opt-in RDL pull | `powerbi-client.downloadReportDefinition` (Power BI REST, opt-in only) |

## No-Fabric verification

With `LOOM_DEFAULT_FABRIC_WORKSPACE` and `LOOM_PAGINATED_REPORT_BACKEND` unset
(or `azure`), the editor imports an .rdl, builds the parameter form, runs, and
renders multi-page tablix data from Synapse — the Power BI REST host is never
called on this path (`downloadReportDefinition` runs only when the backend is
explicitly `powerbi`/`fabric` with a bound workspace). When Synapse is not yet
provisioned the route returns an honest infra gate naming `LOOM_SYNAPSE_WORKSPACE`.

## Sovereign-cloud matrix

| Aspect | Commercial / GCC | GCC-High / IL5 / DoD |
|--------|------------------|----------------------|
| Synapse SQL dataset auth | `database.windows.net` | `database.usgovcloudapi.net` |
| AAS XMLA host | `asazure.windows.net` | `asazure.usgovcloudapi.net` |
| Opt-in Power BI REST host | `api.powerbi.com` | `api.powerbigov.us` |
| Opt-in Power BI scope | `analysis.windows.net/powerbi/api` | `analysis.usgovcloudapi.net/powerbi/api` |

All resolved via `cloud-endpoints.ts` (`aasSuffix`, `pbiApiBase`, `pbiApiScope`,
`getSqlSuffix`) and locked by `cloud-matrix.test.ts`.

Grade: A — Azure-native default renders multi-page real data with parameters and
page navigation; two disclosed honest-gates (export / subscribe) for follow-up
workstreams. Zero dead buttons, zero fake data.
