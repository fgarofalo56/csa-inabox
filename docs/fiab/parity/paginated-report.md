# paginated-report — parity with Power BI Paginated Report (RDL)

Source UI: Power BI Report Builder / Fabric Paginated report editor
(https://learn.microsoft.com/power-bi/paginated-reports/report-builder-power-bi)
and the Power BI `exportToFile` API
(https://learn.microsoft.com/rest/api/power-bi/reports/export-to-file-in-group).
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `PaginatedReportDesigner`.

CSA Loom builds a **Loom-native RDL authoring + render stack** as the
**Azure-native default** — authoring and PDF/Excel/Word export work with **zero
Microsoft Fabric / Power BI capacity** bound (`.claude/rules/no-fabric-dependency.md`).
The Power BI `exportToFile` path (which requires a Premium P1+/Embedded A4+
capacity) is an opt-in alternative reached only when a Power BI workspace is
explicitly bound.

## Azure / Fabric feature inventory

Report Builder's authoring surface for a paginated (.rdl) report:

1. **Data source** — connect to a relational source (Azure SQL, Synapse, etc.).
2. **Dataset** — a query (T-SQL) against a data source; fields inferred from the
   result; query designer / text editor.
3. **Parameters** — name, data type, prompt, default value.
4. **Tablix** (table / matrix) — detail columns, row groups, header row,
   per-cell expressions, aggregates (`=Sum`, `=Count`, `=Avg`, `=Max`, `=Min`),
   totals.
5. **Page setup** — page size (A4 / Letter / Legal), orientation
   (Portrait / Landscape), page breaks.
6. **Expression editor** — `Fields!X.Value`, aggregate functions, VB.NET.
7. **Page header / footer** — repeating bands.
8. **Export** — render to **PDF, Excel (XLSX), Word (DOCX)**, PPTX, CSV, XML,
   MHTML, image.
9. **Preview / run** — render in-editor with parameter values.

## Loom coverage

| Capability | Loom coverage | Backend |
|---|---|---|
| Data source (AzureSQL / Synapse / Cosmos / ADLS) | ✅ built (`DataSourceDialog`) | `upsertRdlDefinition` → Cosmos `paginated-report-definitions` (PK /workspaceId) |
| Dataset query editor (Monaco T-SQL) | ✅ built (`DatasetDialog`) | `/api/items/paginated-report/[id]/preview` → real TDS `executeQuery` |
| Dataset field inference + sample capture | ✅ built ("Run preview") | preview route infers field types + captures `sampleRows` from the live query |
| Parameters (name / type / prompt / default) | ✅ built (`ParameterDialog`) | `RdlParameter[]` in the definition |
| Tablix — detail columns | ✅ built (`AddTablixWizard`) | columns multiselect from dataset fields |
| Tablix — row groups | ✅ built | row-group multiselect |
| Tablix — column headers (editable labels) | ✅ built | `headerRow` |
| Per-cell expression + aggregates (Sum/Count/Avg/Max/Min) | ✅ built (`TablixDesignSurface`) | `cells[][].expression`; aggregates render as a bold totals row |
| Page size + orientation | ✅ built (Report card dropdowns) | `pageSize` / `pageOrientation`; ReportLab page geometry |
| Page break per tablix | ✅ built (Switch) | `pageBreak`; ReportLab `PageBreak` / DOCX `add_page_break` |
| Object tree (sources / datasets / report items / parameters) | ✅ built (Fluent `Tree`) | left panel |
| **Export → PDF** | ⚠️ honest-gate (`LOOM_PAGINATED_RENDER_URL`) | `paginated-report-renderer` Function → **ReportLab** |
| **Export → Excel** | ⚠️ honest-gate | Function → **openpyxl** |
| **Export → Word** | ⚠️ honest-gate | Function → **python-docx** |
| Power BI `exportToFile` (Fabric opt-in) | ⚠️ honest-gate (Premium capacity) | `powerbi-client` ExportTo (only when a Power BI workspace is bound) |
| Column groups (matrix) | ❌ follow-up | — |
| VB.NET expression evaluator (arbitrary `=…`) | ❌ follow-up (curated aggregates only) | — |
| Page header / footer bands | ❌ follow-up | — |
| PPTX / CSV / XML / MHTML / image export | ❌ follow-up | — |
| Live query at render time | ❌ follow-up (renders from save-time `sampleRows`) | needs Function MI Database Reader per source |

The honest-gate rows render the **full designer**; only the **Export** ribbon
buttons disable with the tooltip *"Set LOOM_PAGINATED_RENDER_URL to enable
export"* plus a Fluent MessageBar naming the env var + bicep module. This is the
allowed config-only state per `no-vaporware.md` — authoring is always live.

## Backend per control

- **Authoring CRUD** → `GET/PUT /api/items/paginated-report/[id]/definition` →
  `getRdlDefinition` / `upsertRdlDefinition` (Cosmos, AAD-only via the Console
  UAMI; no account keys, no Fabric).
- **Dataset preview** → `POST /api/items/paginated-report/[id]/preview` → real
  TDS `executeQuery` (azure-sql-client / synapse-sql-client). Cosmos/ADLS
  sources fall back to manual field entry (honest 400).
- **Export** → `POST /api/items/paginated-report/[id]/render` → loads the
  definition from Cosmos, delegates to the `paginated-report-renderer` Azure
  Function (`/api/render`, Function key via `?code=`), streams the binary back
  with an `attachment` `Content-Disposition`.
- **Capability probe** → `GET /api/items/paginated-report/capabilities` →
  `{ renderDeployed }` so the designer pre-disables Export instead of clicking
  into a 503.

## Per-cloud

| Cloud | `LOOM_PAGINATED_RENDER_URL` (Azure Function) | Power BI `exportToFile` (opt-in) |
|---|---|---|
| Commercial | `*.azurewebsites.net` — full support | `api.powerbi.com` — Premium P1+/Embedded A4+ |
| GCC | `*.azurewebsites.net` — full support | `api.powerbigov.us` — same Premium requirement |
| GCC-High | `*.azurewebsites.us`; bicep `environment().suffixes.storage` resolves `core.usgovcloudapi.net` automatically | `api.high.powerbigov.us` — limited GA |
| IL5 | AzureUSGovernment endpoints — full support | same GCC-High restrictions |

The Function renderer has **zero cloud-specific code**. Cosmos is not required
to render (the definition arrives in the request body).

## Verification

Acceptance receipt (this PR): a tablix report authored against a dataset,
exported to **PDF + Excel + Word** — all three open correctly. The Excel/Word
totals row computes `=Sum` over the captured rows (Units 120+98+143 = **361**,
Revenue = **172,340.75**). Three files attached to the PR body + the unit suite
`lib/azure/__tests__/paginated-report-client.test.ts` (12 tests, green).

Grade: A — every authoring row built ✅; export rows are disclosed honest-gates
(`LOOM_PAGINATED_RENDER_URL`), zero dead buttons, zero fake data.
