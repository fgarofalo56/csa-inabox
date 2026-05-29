# Loom Paginated Report Editor — Fabric-parity spec

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


> Captured 2026-05-26 by catalog agent `fabric-parity-loop`. Source: Microsoft Learn — Power BI Report Builder (`/power-bi/paginated-reports/paginated-reports-report-design-view`, `report-builder-power-bi`, `web-authoring/paginated-formatted-table`, `paginated-reports-edit-service`) and Report Definition Language (`/power-bi/paginated-reports/report-definition-language`).

A **Paginated Report** is an RDL-based pixel-perfect report — an XML report definition (`.rdl`) authored in **Power BI Report Builder** (Windows desktop) or the **paginated report web authoring** experience (Power BI service, currently Preview, limited to formatted tables on a single semantic model). Paginated reports are designed for printable / multi-page / fixed-layout output (invoices, statements, regulatory PDFs), in contrast to interactive Power BI (`.pbix`) reports.

## UI components

### Ribbon (Report Builder desktop)
- **File** menu — New · Open · Save · Save As · Publish (to Power BI service workspace) · Account · Options · Enable/Disable preview features · Recent
- **Home** tab — Run (preview) · Paste · Cut/Copy · Font · Paragraph · Border · Number format (Default / Currency / Percent / Scientific / Custom) · Layout · Placeholder style toggle (Sample Values / Field Names)
- **Insert** tab — Table · Matrix · List · Chart · Gauge · Map · Data Bar · Sparkline · Indicator · Image · Text Box · Line · Rectangle · Subreport · Header · Footer · Page Break · Page Number
- **View** tab — Show/Hide group: Report Data · Properties · Grouping · Parameters · Ruler · Tooltips
- **Run** (preview mode) tab — Print · Print Layout · Page Setup · Export (PDF, Word, Excel, PowerPoint, CSV, XML, MHTML, TIFF, JSON) · First/Previous/Next/Last page · Refresh · Stop · Document Map · Parameters · Find

### Report Data pane (left)
- **Built-in Fields** — ExecutionTime, ReportName, ReportFolder, OverallPageNumber, OverallTotalPages, PageNumber, TotalPages, UserID, Language
- **Parameters** — define typed parameters (Boolean / DateTime / Integer / Float / String); single-value or multi-value; available values list (static / query); default values
- **Images** — embedded image resources
- **Data Sources** — connection definitions to SQL Server, Azure SQL, Synapse, Power BI semantic models (XMLA), Power BI dataflows, OData, Oracle, Teradata, Snowflake (via Power Query), Databricks (via Power Query), files
- **Datasets** — query against a data source (T-SQL, DAX, MDX, M / Power Query Mashup); field list with data types

### Report design surface (center)
- WYSIWYG canvas with page boundaries and margins drawn
- Header / Body / Footer bands (right-click → Add Page Header / Add Page Footer)
- Rulers (top + left)
- Drag-drop report items: Table / Matrix / List / Chart / Gauge / Map / Image / Text Box / Line / Rectangle / Subreport / Tablix
- Right-click context menus on body / header / footer / item → Properties dialog
- Snap-to-grid alignment

### Properties pane (right)
- Categorized / Alphabetized property list for the selected item
- Sections: Action, Border, Fill, Font, General, Layout, Visibility, Misc
- Every value supports literal OR `<Expression>` (VB.NET expression editor with `Fields!`, `Parameters!`, `Globals!`, `User!`, custom code)
- Property Pages button → opens the full Properties dialog for the item

### Grouping pane (bottom)
- Row groups + column groups for the active Tablix
- Drag fields to create groups; right-click → Group Properties (group on expression, sort, filters, page breaks)
- Adjacent vs nested grouping

### Parameters pane (top, optional)
- Visual layout of report parameters as displayed at run time
- Drag to reposition; add/remove columns and rows
- Right-click parameter → Parameter Properties (visibility, data type, available values, default values, prompt label)

### Tablix / Chart wizards
- **Table wizard** / **Matrix wizard** / **Chart wizard** / **Map wizard** — guided creation: choose dataset → drag fields to row/column/value buckets → pick layout → pick style → finish
- Map wizard supports SQL spatial, ESRI shapefile, Bing map tiles

### Expression editor
- VB.NET-based expression language
- IntelliSense for Fields collection, Parameters, Globals, User, ReportItems
- Categories: Constants, Built-in Fields, Parameters, Fields, Datasets, Operators, Common Functions (Text, Date & Time, Math, Inspection, Program Flow, Aggregate, Financial, Conversion, Miscellaneous)
- Custom Code tab (Report Properties > Code) for embedded VB.NET helper functions; Reference tab for assembly references

### Report Properties dialog
- Page Setup (size, margins, orientation, columns)
- Code (custom VB.NET)
- References (.NET assemblies)
- Variables (report-scoped variables)

### Run / Preview mode
- Renders the report inline with the configured rendering extension
- Parameter prompts at top
- Document Map navigation (for grouped reports)
- Find / Find Next
- Page navigation toolbar
- Export to: PDF, Microsoft Word, Microsoft Excel, Microsoft PowerPoint, CSV, XML, Data Feed, MHTML / Web Archive, TIFF, JSON

### Web authoring experience (Preview, Power BI service)
- Browser-based editor, available in any workspace (no capacity required)
- Limited to a single Power BI semantic model as the source
- **Build** pane — Format tab (style dropdown), Fields tab, Filters tab
- **Editor ribbon** — Insert tab (text box, image, header, footer), Format tab
- Inline column rename, resize, sort
- Save / Publish back to the same workspace
- "Edit in Power BI Report Builder" hand-off

## What Loom has
- `PaginatedReportEditor` (apps/fiab-console/lib/editors/phase3-editors.tsx:1639) — wraps the shared `ReportLikeEditor` with `kind="paginated"`, `listPath="/api/items/paginated-report"`
- Workspace picker, left tree of paginated reports, refresh button
- Right-side metadata card: name, `reportType` (defaults to `PaginatedReport`), datasetId, modified date/by, "Open in Power BI" link
- "Embed preview" placeholder card explicitly labeled `v2.1: showing metadata only — full embed via Power BI Embed SDK lands in v2.2`
- C-grade verdict — listing + metadata works, **no design surface, no parameter pane, no run/preview, no RDL edit, no publish**

## Gaps for parity
1. **No design surface** — neither the Report Builder canvas nor the web-authoring canvas is present
2. **No Report Data pane** (Built-in Fields / Parameters / Images / Data Sources / Datasets)
3. **No Properties pane** for selected items
4. **No Grouping pane**
5. **No Parameters pane** for at-runtime parameter layout
6. **No ribbon** (Home / Insert / View / Run)
7. **No RDL XML editor** for direct edit-the-source workflow
8. **No expression editor**
9. **No Run / Preview** — cannot render the report
10. **No export** to PDF / Word / Excel / PowerPoint / CSV / XML / TIFF / JSON
11. **No parameter prompt** UI
12. **No "Edit in Report Builder" hand-off** (deep link to launch desktop Report Builder with the rdl pre-loaded)
13. **No publish-back** flow for an edited RDL
14. **No web-authoring create-from-scratch** flow

## Backend mapping
- **List paginated reports**: `GET /v1.0/myorg/groups/{groupId}/reports?$filter=reportType eq 'PaginatedReport'` (Loom already calls this through `/api/items/paginated-report`)
- **Get report**: `GET /v1.0/myorg/groups/{groupId}/reports/{reportId}` — returns `webUrl`, `embedUrl`, `datasetId`, `reportType`
- **Download RDL**: `GET /v1.0/myorg/groups/{groupId}/reports/{reportId}/Export` → returns `.rdl` file bytes
- **Upload / Update RDL**: `POST /v1.0/myorg/groups/{groupId}/imports?datasetDisplayName={name}.rdl&nameConflict=Overwrite` with multipart body containing the rdl bytes
- **Clone report**: `POST /v1.0/myorg/groups/{groupId}/reports/{reportId}/Clone`
- **Delete report**: `DELETE /v1.0/myorg/groups/{groupId}/reports/{reportId}`
- **Update data source bindings**: `POST /v1.0/myorg/groups/{groupId}/reports/{reportId}/Default.UpdateDatasources` with `updateDetails` array
- **Embed paginated report** (for run/preview): generate embed token via `POST /v1.0/myorg/groups/{groupId}/reports/{reportId}/GenerateToken`, then render via `powerbi-client` SDK with `type: 'report'` + `reportType: 'PaginatedReport'` (the SDK supports paginated embed)
- **Export to file** (server-side render): `POST /v1.0/myorg/groups/{groupId}/reports/{reportId}/ExportTo` with `{format: 'PDF' | 'WORD' | 'EXCEL' | 'PPTX' | 'CSV' | 'XML' | 'IMAGE' | 'MHTML'}` → returns export id; poll `GET .../exports/{exportId}` until status `Succeeded`, then `GET .../exports/{exportId}/file` for the binary
- **"Edit in Report Builder" deep link**: `pbirsrb://...` URI scheme; web-authoring URL is `https://app.powerbi.com/groups/{groupId}/rdlreports/{reportId}/edit`
- **RDL schema** is XML validated against the Microsoft RDL XSD — Loom can generate / mutate RDL using any XML library; the schema is documented on Microsoft Learn

## Required Azure resources / tenant settings
- Power BI Pro license OR Premium-Per-User OR a workspace on a Power BI Premium / Fabric capacity for non-My-Workspace publishing
- Tenant setting **Paginated reports** = enabled
- Tenant setting **Service principals can use Power BI APIs** = enabled
- Tenant setting **Export reports as PDF / Word / Excel / PowerPoint / CSV / XML / Image** = enabled (individual toggles)
- Workspace role: **Contributor** or higher to publish; **Build permission** on the source semantic model
- For data-gateway-bound sources (on-prem SQL, file shares): an **On-premises data gateway** registered and bound to the data source
- For Snowflake / Databricks / Oracle via Power Query: the **VNet data gateway** (for cloud sources behind a VNet) or the on-prem gateway

## Estimated effort
**4-5 sessions.**

- **Phase 1 (1 session)** — Embed the rendered paginated report via `powerbi-client` SDK + `GenerateToken` (read-only Run/Preview parity). Replace the metadata placeholder card.
- **Phase 2 (1 session)** — Wire **ExportTo** for PDF / Word / Excel / PowerPoint exports; surface as ribbon actions; show export-job progress.
- **Phase 3 (1-2 sessions)** — Build a parameter prompt panel by reading parameter definitions from the rdl XML (`<ReportParameters>`); pass values into embed config.
- **Phase 4 (1 session)** — "Edit in Report Builder" deep-link + an "Edit in Web Authoring" iframe redirect to `app.powerbi.com/.../rdlreports/{id}/edit`. Document that Loom does **not** attempt to reimplement Report Builder's design surface.
- **Phase 5 (optional)** — Direct RDL XML editor with Monaco + schema validation against the RDL XSD for power users.

## Notes
- Loom will **not** reimplement Report Builder — the desktop tool is a large WPF application with no realistic web port; even Microsoft's web authoring is limited to single-table formatted tables on a single semantic model
- The realistic Loom parity story is: list + embed-preview + parameter prompts + ExportTo + deep-link to Report Builder for edit, plus an optional Monaco-based RDL XML editor for advanced users
- The web-authoring experience is currently **Preview** with a narrow scope (single semantic model, single formatted table) — Loom should embed it where available rather than replicate
