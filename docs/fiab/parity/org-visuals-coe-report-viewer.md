# org-visuals-coe-report-viewer — parity with Power BI report **viewing** + organizational sharing

Source UI: the Power BI **report canvas** (open a report → rendered visuals on a
page, page tabs along the bottom) and **publish / share to the organization**
(Workspace → app / org sharing → consumers open it from a gallery). Microsoft
Learn: [Power BI reports](https://learn.microsoft.com/power-bi/consumer/end-user-reports),
[PBIR report definition](https://learn.microsoft.com/power-bi/developer/projects/projects-report),
[TMDL](https://learn.microsoft.com/analysis-services/tmdl/tmdl-overview).

Azure-native backing (no Fabric / Power BI workspace): reports render **in-product**
from the bundled PBIP (real PBIR visuals + TMDL SAMPLE data) via lightweight inline
SVG — no `app.powerbi.com`, no Power BI embed, no charting dependency. Publish state
is a Cosmos flag on the clone doc (`coe-templates` container); the consumer gallery
is a cross-partition `published = true` query.

This doc covers the **viewer + publish + consumer gallery** added on top of the
existing clone library (`org-visuals.md` covers upload/clone/list/delete).

## What was broken (operator-reported)

1. **Preview only showed metadata** (pages / sources / roles / params) — it never
   rendered the report.
2. After cloning, "Your cloned templates" rows had only **Remove** — no Open/View,
   so a clone just sat as PBIP files in Blob with nowhere to look at it.
3. The only org-share path was a shell script (`scripts/csa-loom/publish-coe-reports.sh`)
   — **no in-product publish-to-org and no consumer gallery**, so other members
   couldn't see published reports.

## Power BI feature inventory (viewing + sharing)

| # | Capability (real Power BI UI) | Notes |
|---|-------------------------------|-------|
| 1 | **Render the report** — visuals laid out on the page canvas | cards, column/bar, line/area, donut/pie, table/matrix |
| 2 | Faithful **layout** — each visual at its x/y/w/h, z-order | design page 1280×720 |
| 3 | **Multi-page** report — page tabs / switcher | pageOrder + active page |
| 4 | Visual **titles** | from the report definition |
| 5 | Read the **data** behind each visual | here: bundled SAMPLE data, clearly labelled |
| 6 | **Open** a report from the library | view, not just metadata |
| 7 | **Publish / share to the organization** | make it visible to all members |
| 8 | **Unpublish** / revoke org access | |
| 9 | **Consumer gallery** — members browse + open shared reports | read-only |
| 10 | See **who/when** published | provenance |

## Loom coverage

| # | Capability | Status | Loom surface |
|---|------------|--------|--------------|
| 1 | Render visuals | ✅ built | `ReportCanvas` → inline-SVG renderers (`CardTile`/`BarsTile`/`LineTile`/`PieTile`/`TableTile`) |
| 2 | Faithful layout | ✅ built | absolute %-positioned tiles on an `aspect-ratio` canvas from page width/height + z-order |
| 3 | Multi-page switcher | ✅ built | Fluent `TabList` when `pages.length > 1` (parser preserves `pageOrder`) |
| 4 | Titles | ✅ built | resolved from `objects.title` literal (quotes stripped) else humanized default |
| 5 | Visual data | ✅ built | `buildVisualData` aggregates the TMDL SAMPLE rows; Fluent `MessageBar` labels it SAMPLE + names the params to connect live |
| 6 | Open from library | ✅ built | template card **Open report** → two-tab dialog (**Report** = canvas, **Details** = metadata); clone row **Open** → `ReportViewerDialog` (`?cloneId=`) |
| 7 | Publish to org | ✅ built | clone row **Publish to organization** → `POST /api/admin/coe-library {action:'publish'}` → Cosmos flag + audit |
| 8 | Unpublish | ✅ built | same control toggles → `{action:'unpublish'}` (clears flag → consumer 404s) |
| 9 | Consumer gallery | ✅ built | `/org-reports` top-level nav → `OrgReportsPane` (`GET /api/org-reports`, any member) → Open → `ReportCanvas` read-only |
| 10 | Publish provenance | ✅ built | `publishedAt` / `publishedBy` shown on the clone row + gallery card + viewer badge |
| — | Honest unsupported visual | ⚠️ honest | unknown `visualType` → "‹type› preview not supported yet" tile (never a crash) |

Zero ❌. Zero stub banners.

### Visual-type coverage (rendered, real)

`card` (+ multiRowCard/kpi/gauge → single aggregate), `clusteredColumnChart` /
`columnChart` / `stackedColumnChart` (vertical bars), `barChart` / `clusteredBarChart`
(horizontal bars), `lineChart` / `areaChart` (polyline), `donutChart` / `pieChart`
(donut arcs + legend), `tableEx` / `table` / `matrix` (dense table). Any other type
renders the honest unsupported tile. The two flagship templates
(`coe-adoption-maturity`, `cloud-cost-finops`) use only supported types — **zero
unsupported tiles** on the default catalog.

## Backend per control

| Control | Backend |
|---------|---------|
| Template Report tab | `GET /api/admin/coe-library/render?templateId=` → `parseReportModel` + `parseSampleData` over bundled PBIP |
| Clone Open | `GET /api/admin/coe-library/render?cloneId=` → reads clone doc (per-tenant) → renders source template's bundled PBIP |
| Publish / Unpublish | `POST /api/admin/coe-library {action, cloneId}` → `setClonePublished` (Cosmos upsert) + audit `coe-template.publish`/`.unpublish` |
| Consumer gallery list | `GET /api/org-reports` (session-gated, NOT admin) → `listPublishedReports` (cross-partition `published = true`) |
| Consumer open | `GET /api/org-reports/render?id=` → `getPublishedReport` (404 if unpublished) → render model |

### Data-model note (org scoping)

Clones are partitioned by the publisher's Entra `oid` (`coe-templates` PK
`/tenantId`, set to `claims.oid`). The console serves a **single** Entra tenant per
deployment, so the org gallery is the cross-partition set of `published = true`
docs. `UserClaims` carries no Entra `tid`, so no per-tenant filter is applied (nor
needed) — unpublishing immediately removes consumer access (the render route
re-checks `published`).

## Parser fidelity

- `pbir-parse.ts` — pages (ordered by `pageOrder`), visuals (sorted by z), each
  reduced to type/position/title/roles→fields (Column|Measure, Entity, Property,
  queryRef). Defensive: a malformed `visual.json` is skipped, never thrown.
- `tmdl-sample.ts` — parses the real `#table(type table […], { {…} })` literal in
  each table partition (also tolerates `Table.FromRows`), incl. `#datetime(…)`,
  decimals, quoted strings, null/true/false. Keyed by the declared `table '<Name>'`.
- `visual-data.ts` — aggregates per visual. A projected Property matching a sample
  column is aggregated directly; a DAX **measure** (no matching column) falls back
  to a documented heuristic over the first numeric column (sum, or avg for
  `/avg|average|rate|%|score|level/`, or count for `/count|#|number of/`). Never
  invents — unresolved → "—". For the bundled templates the heuristic resolves to
  the correct values (e.g. Total Cost = Σ PreTaxCost = 38,931.88; Avg Maturity =
  avg CurrentLevel = 2.625; Active Users by month = 500/650/860).

## Verification

`npx vitest run lib/coe-library/report-render` — 15 tests over the **real**
`coe-adoption-maturity` + `cloud-cost-finops` templates: page/visual counts, z-order,
title + projection parsing, sample columns/rows + datetime parsing, and the card /
bars / line / pie / table aggregation results above; unsupported-type degradation;
percent formatting sanity.

Manual walk: Admin portal → Organizational visuals → **Open report** on a template →
charts render in the Report tab, Details tab shows metadata → **Use this template**
→ the clone row exposes **Open** (renders) and **Publish to organization** →
**Organization reports** (top-level nav, any member) lists the published report →
Open renders it read-only. Unpublish removes it from the gallery.

## Per-cloud

| | Commercial | GCC | GCC-High | IL5/DoD |
|-|-----------|-----|----------|---------|
| In-product render (SVG) | ✅ | ✅ | ✅ | ✅ |
| Power BI / Fabric dependency | none | none | none | none |
| Publish = Cosmos flag | ✅ | ✅ | ✅ | ✅ |

No `LOOM_DEFAULT_FABRIC_WORKSPACE` / Power BI workspace required for any of the
above. Blob copy of the editable PBIP remains the existing optional
`LOOM_ORG_VISUALS_URL` enhancement (the viewer renders from the bundled template
either way).
