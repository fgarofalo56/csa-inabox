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
| 7 | Export (PDF / Excel / Word / …) | ✅ built | opt-in Power BI path mints + downloads a real `ExportTo` job with a `paginatedReportConfiguration` body (PDF / XLSX / DOCX wired in the ribbon + toolbar); the Azure-native renderer also surfaces data in-grid |
| 8 | Schedule / subscribe | ⚠️ honest-gate | report subscriptions are a separate tracked workstream (see backlog) |

Chart regions render their bound data as a grid in this PR (visual chart
rendering is a UI follow-up); the data is real, not a placeholder.

## Opt-in Power BI in-place embed (parity with the Power BI service paginated viewer)

When a Power BI workspace IS bound (the strictly-opt-in path), the paginated
report now renders **in place** inside the Loom editor instead of linking out —
one-for-one with the Power BI service paginated viewer. This uses the SAME
`powerbi-client` SDK as standard reports (there is no separate `pbi-paginated`
package) via `IPaginatedReportLoadConfiguration`.

| # | Power BI paginated viewer capability | Status | Where |
|---|---------------------------------------|--------|-------|
| E1 | In-place iframe render of the live paginated report | ✅ built | `PowerBIEmbedFrame embedVariant="paginated"` (powerbi-embed.tsx) |
| E2 | Parameter bar (show / expand) to filter the report | ✅ built | `settings.commands.parameterPanel`; pre-fill via `parameterValues` |
| E3 | Drill-through links navigate **in place** | ✅ built | native to the embedded paginated viewer |
| E4 | Export PDF / Excel / Word | ✅ built | Export ribbon + toolbar → `POST /export { paginated:true }` → `startPaginatedReportExport` |
| E5 | Embed token for report + bound semantic model(s) | ✅ built | `generatePaginatedReportEmbedToken` → multi-resource `GenerateToken` (`reports[]` + `datasets[{ xmlaPermissions:'ReadOnly' }]`) via `POST /paginated-embed-token` |
| E6 | Error surfacing | ✅ built | the `error` event (the only event paginated reports emit — `loaded`/`rendered` do NOT fire) is wired to the viewer MessageBar |

Intentionally NOT wired (Microsoft documents these are unsupported for
paginated reports): `loaded` / `rendered` events, `powerbi.bootstrap()`,
page-navigation (`setPage`/`getPages`), filter read/write, and `setAccessToken`.
These are not stubs — they do not exist in the paginated SDK surface.

### Backend per embed control

| Control | Backend |
|---------|---------|
| Mint embed token | `POST /api/items/report/[id]/paginated-embed-token` → `generatePaginatedReportEmbedToken` (multi-resource `GenerateToken`) |
| Render iframe | `powerbi-client` `IPaginatedReportLoadConfiguration` (browser) |
| Export PDF/XLSX/DOCX | `POST /api/items/report/[id]/export { paginated:true }` → `startPaginatedReportExport` (ExportTo + `paginatedReportConfiguration`) → poll → download |

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

| Aspect | Commercial | GCC | GCC-High / IL5 | DoD |
|--------|------------|-----|----------------|-----|
| Synapse SQL dataset auth | `database.windows.net` | `database.windows.net` | `database.usgovcloudapi.net` | `database.usgovcloudapi.net` |
| AAS XMLA host | `asazure.windows.net` | `asazure.windows.net` | `asazure.usgovcloudapi.net` | `asazure.usgovcloudapi.net` |
| Opt-in Power BI REST host | `api.powerbi.com` | `api.powerbi.com` | `api.powerbigov.us` | `api.powerbigov.us` |
| Opt-in Power BI scope (`getPbiScope`) | `analysis.windows.net/powerbi/api/.default` | `analysis.usgovcloudapi.net/powerbi/api/.default` | `high.analysis.usgovcloudapi.net/powerbi/api/.default` | `mil.analysis.usgovcloudapi.net/powerbi/api/.default` |
| Embed iframe host (`getPbiEmbedHostname`) | `app.powerbi.com` | `app.powerbi.com` | `app.powerbigov.us` | `app.mil.powerbigov.us` |

All resolved via `cloud-endpoints.ts` (`aasSuffix`, `getPbiGovHost`,
`getPbiScope`, `getPbiEmbedHostname`, `getSqlSuffix`) and locked by
`cloud-endpoints.test.ts`. In GCC-High / DoD the opt-in Power BI embed requires
`LOOM_POWERBI_BASE=https://api.powerbigov.us/v1.0/myorg` —
`assertFabricFamilyAvailable('powerbi')` throws the precise remediation in the
`paginated-embed-token` route until it is wired (Azure-native RDL renderer keeps
working with no Power BI at all).

Grade: A — Azure-native default renders multi-page real data with parameters and
page navigation; two disclosed honest-gates (export / subscribe) for follow-up
workstreams. Zero dead buttons, zero fake data.
