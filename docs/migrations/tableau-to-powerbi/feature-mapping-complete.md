# Complete Feature Mapping: Tableau to Power BI

**A comprehensive reference mapping 50+ Tableau features to their Power BI equivalents, with migration complexity ratings and recommendations.**

---

## How to use this reference

Each feature is mapped from its Tableau implementation to the Power BI equivalent. The **complexity** column rates the migration effort: **Low** (direct mapping, minimal work), **Medium** (conceptual equivalent exists but requires redesign), **High** (significant rework or different approach needed).

---

## 1. Report and dashboard structure

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 1 | **Worksheet** (single chart/table) | Report page visual | Low | One worksheet becomes one or more visuals on a report page |
| 2 | **Dashboard** (multi-sheet layout) | Report page (multi-visual) | Low | Power BI report pages serve the same role as Tableau dashboards |
| 3 | **Story** (multi-page narrative) | Bookmarks + page navigator | Medium | Use bookmarks to create a guided narrative; page navigator bar provides tabs |
| 4 | **Dashboard containers** (horizontal/vertical) | Report page layout (free-form or snap-to-grid) | Low | Power BI uses free-form canvas positioning |
| 5 | **Dashboard text/image objects** | Text box, image, shape visuals | Low | Direct equivalents available |
| 6 | **Tooltip worksheets** (hover detail) | Report page tooltips | Low | Create a tooltip-type page with detail visuals |
| 7 | **Custom views** (user-saved filter state) | Personal bookmarks | Low | Users save their own bookmark of filter state |
| 8 | **Device layouts** (phone, tablet, desktop) | Mobile layout view | Medium | Power BI has a dedicated mobile layout designer per page |

---

## 2. Data connectivity and modeling

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 9 | **Data source** (connection to database/file) | Semantic model (dataset) | Low | Conceptually identical; semantic model is the Power BI data layer |
| 10 | **Tableau Extract** (.hyper file, import) | Import mode (Vertipaq) | Low | Functional equivalent; consider Direct Lake on Fabric instead |
| 11 | **Live connection** (real-time query) | DirectQuery | Low | Direct equivalent; same trade-offs (freshness vs performance) |
| 12 | **Direct Lake** (Fabric only) | N/A in Tableau | N/A | Power BI exclusive: zero-copy on Delta tables. No Tableau equivalent |
| 13 | **Published data source** (shared, governed) | Shared semantic model | Low | Create one semantic model per domain; endorse as Certified |
| 14 | **Data blending** (ad-hoc cross-source join) | Composite model or relationships | Medium | Data blending does not exist in Power BI; use composite models or consolidate in the semantic model |
| 15 | **Custom SQL** (query written in data source) | Native query in Power Query or DirectQuery | Low | Use Power Query native query or dbt views |
| 16 | **Federated / cross-database join** | Composite model (DirectQuery + Import) | Medium | Composite models mix DirectQuery and Import sources |
| 17 | **Relationships (logical model)** | Model relationships (star schema) | Medium | Tableau uses automatic relationships; Power BI requires explicit star-schema design |
| 18 | **Data source filters** (pre-filter at source) | Power Query filters or partition parameters | Low | Apply filters in Power Query before data loads |
| 19 | **Union** (append tables) | Append queries in Power Query | Low | `Table.Combine` in M language |
| 20 | **Join** (merge tables) | Merge queries in Power Query | Low | `Table.NestedJoin` in M language |
| 21 | **Pivot / Unpivot** | Pivot / Unpivot in Power Query | Low | Direct equivalent in Power Query UI and M |

---

## 3. Calculations and expressions

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 22 | **Calculated field** (row-level calculation) | Calculated column (DAX) | Low | Use `COLUMN = expression` in DAX; computed at refresh time |
| 23 | **Calculated field** (aggregate) | Measure (DAX) | Medium | DAX measures are the primary calculation mechanism; more powerful but require filter context understanding |
| 24 | **LOD — FIXED** | `CALCULATE` + `ALLEXCEPT` | High | Requires understanding DAX filter context |
| 25 | **LOD — INCLUDE** | `AVERAGEX` / `SUMX` over `VALUES` | High | Iterator functions with explicit dimension reference |
| 26 | **LOD — EXCLUDE** | `CALCULATE` + `ALL` on excluded dim | High | Remove dimension from filter context |
| 27 | **Table calculation — RUNNING_SUM** | `WINDOW` function or CALCULATE with ALL | High | DAX 2023+ WINDOW function or manual running total pattern |
| 28 | **Table calculation — RANK** | `RANKX` | Medium | `RANKX(ALL(Table), [Measure])` |
| 29 | **Table calculation — LOOKUP** | `CALCULATE` + time intelligence | Medium | `PREVIOUSMONTH`, `SAMEPERIODLASTYEAR`, etc. |
| 30 | **Table calculation — WINDOW_SUM/AVG** | `WINDOW` or `DATESINPERIOD` | High | Rolling window calculations |
| 31 | **Table calculation — PERCENT_DIFFERENCE** | Composed from base measures | Medium | `DIVIDE([Current] - [Previous], [Previous])` |
| 32 | **Table calculation — INDEX** | `INDEX` function (DAX 2023+) or `RANKX` | Medium | New DAX function simplifies row numbering |
| 33 | **Quick table calculation** | Quick measure | Low | Power BI quick measures provide guided measure creation |
| 34 | **Sets** (in/out grouping) | DAX calculated column or measure with `IF`+`RANKX` | Medium | No native set concept; replicate with DAX logic |
| 35 | **Groups** (ad-hoc dimension grouping) | Grouping in visual or calculated column | Low | Right-click group in visuals or create a mapping column |
| 36 | **Bins** (numeric ranges) | Grouping or calculated column | Low | Power BI Desktop has a "New Group" button for binning |
| 37 | **Parameters** (string/number) | What-If parameter or field parameter | Medium | What-If creates a disconnected table with a slicer |
| 38 | **Date parameter** (date range) | Relative date slicer | Low | Native relative date filtering in slicers |
| 39 | **Parameter actions** | Field parameter + slicer interaction | Medium | More limited than Tableau parameter actions |

For detailed conversion patterns with code examples, see [Calculation Conversion Reference](calculation-conversion.md).

---

## 4. Visualization types

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 40 | **Bar / Column chart** | Bar / Column chart | Low | Direct mapping |
| 41 | **Line chart** | Line chart | Low | Direct mapping |
| 42 | **Area chart** | Area chart | Low | Direct mapping |
| 43 | **Scatter plot** | Scatter chart | Low | Power BI adds Play axis for animation |
| 44 | **Pie / Donut** | Pie / Donut | Low | Direct mapping |
| 45 | **Treemap** | Treemap | Low | Direct mapping |
| 46 | **Heat map** (text table with color) | Matrix with conditional formatting | Medium | Use background color rules on matrix cells |
| 47 | **Packed bubble** | Custom visual (AppSource) | Medium | Not native; use treemap as alternative or import custom visual |
| 48 | **Box-and-whisker** | Custom visual (AppSource) | Medium | Import "Box and Whisker" from AppSource |
| 49 | **Gantt chart** | Custom visual (AppSource) | Medium | Import Gantt visual from AppSource |
| 50 | **Waterfall** | Waterfall chart | Low | Native in Power BI |
| 51 | **Funnel** | Funnel chart | Low | Native in Power BI |
| 52 | **Bullet chart** | Custom visual (AppSource) | Medium | Available on AppSource |
| 53 | **Dual-axis chart** | Combo chart (line + column) | Low | Supports two Y axes |
| 54 | **Reference lines / bands** | Analytics pane (constant, trend, average lines) | Low | Add via the Analytics pane on the visual |
| 55 | **Filled map** (choropleth) | Filled map / Shape map / Azure Maps | Low | Shape map for custom geo boundaries |
| 56 | **Symbol map** (point map) | Map visual / ArcGIS Maps | Low | ArcGIS for advanced geospatial |
| 57 | **Small multiples** (trellis) | Small multiples | Low | Native since 2021 |
| 58 | **Histogram** | Histogram (custom visual) or binned column chart | Medium | Create bins then chart |
| 59 | **Density / hex bin** | Custom visual or R/Python visual | High | Not native; use R/Python visual for advanced plots |

For chart-by-chart migration guidance, see [Visualization Migration](visualization-migration.md).

---

## 5. Interactivity and navigation

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 60 | **Filter action** (click to filter) | Cross-filtering (default behavior) | Low | Built-in; configure via Edit Interactions |
| 61 | **Highlight action** | Cross-highlighting (default) | Low | Toggle between filter and highlight in Edit Interactions |
| 62 | **URL action** | Button with URL or web URL visual | Low | Add button with dynamic URL using DAX |
| 63 | **Go to Sheet action** | Drillthrough or page navigation button | Low | Drillthrough for detail; buttons for navigation |
| 64 | **Set action** | Slicer + bookmark or field parameter | Medium | More limited; combine slicer with bookmarks |
| 65 | **Parameter action** | Field parameter with slicer | Medium | Available since 2023 |
| 66 | **Context filter** | Visual-level filter | Low | Apply as a visual-level or page-level filter |
| 67 | **Top N filter** | Top N filter in filter pane | Low | Native Top N filtering |
| 68 | **Conditional filter** | DAX measure filter | Medium | Create a measure and use as a visual-level filter |
| 69 | **Drill down** (dimension hierarchy) | Drill down / Drill up | Low | Built-in hierarchy drill in visuals |

---

## 6. Server and administration

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 70 | **Tableau Server** (on-premises) | Power BI Service (cloud) | Medium | Cloud-only; use Report Server for on-prem if required |
| 71 | **Tableau Cloud** (hosted) | Power BI Service (SaaS) | Low | Direct equivalent |
| 72 | **Site** (tenant isolation) | Fabric capacity + tenant | Medium | One capacity per isolated environment |
| 73 | **Project** (folder hierarchy) | Workspace | Low | One workspace per project |
| 74 | **Groups** | Entra ID security groups | Low | Use AAD/Entra groups for role assignment |
| 75 | **Site roles** (Creator, Explorer, Viewer) | Workspace roles (Admin, Member, Contributor, Viewer) | Low | See [Server Migration](server-migration.md) for mapping |
| 76 | **Row-level security** (user filters) | RLS in semantic model | Medium | Define DAX filter expressions per role |
| 77 | **Subscriptions** (scheduled email) | Power BI subscriptions | Low | Email with PNG/PDF attachment |
| 78 | **Schedules** (extract refresh) | Scheduled refresh | Low | Up to 48 refreshes/day on Premium |
| 79 | **Alerts** (data-driven) | Data alerts on dashboard tiles | Low | Set threshold alerts |
| 80 | **Favorites** | Favorites | Low | Direct mapping |
| 81 | **Collections** | Apps | Low | Package reports into apps for distribution |

---

## 7. Data preparation

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 82 | **Tableau Prep Builder** | Power Query (M language) | Medium | Different UX but similar capability; M is more powerful |
| 83 | **Prep Conductor** (scheduled flows) | Dataflow Gen2 (scheduled refresh) | Medium | Requires Fabric or Premium capacity |
| 84 | **Prep input step** | Power Query Get Data / source | Low | Connect to same sources |
| 85 | **Prep clean step** | Power Query transformations | Low | Column operations, filters, data type changes |
| 86 | **Prep join step** | Power Query Merge Queries | Low | `Table.NestedJoin` in M |
| 87 | **Prep union step** | Power Query Append Queries | Low | `Table.Combine` in M |
| 88 | **Prep pivot / unpivot** | Power Query Pivot / Unpivot | Low | Direct equivalent |
| 89 | **Prep aggregate step** | Power Query Group By | Low | `Table.Group` in M |

For complete Prep-to-Power Query migration, see [Prep Migration](prep-migration.md).

---

## 8. Collaboration and governance

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 90 | **Comments** (on views) | Comments on visuals | Low | Direct mapping |
| 91 | **Data source certification** | Endorsement (Certified / Promoted) | Low | Apply endorsement labels for discoverability |
| 92 | **Data Management add-on** (catalog) | Microsoft Purview (included) | Low | Purview provides catalog, lineage, classification |
| 93 | **Tableau Catalog** | Purview Data Catalog | Low | Metadata discovery and lineage |
| 94 | **Lineage** (within Tableau) | Purview end-to-end lineage | Low | Purview traces from source to report |
| 95 | **Version history** (manual .twbx) | Fabric Git integration (TMDL/.pbip) | Medium | True CI/CD for BI content |
| 96 | **Tableau REST API** | Power BI REST API + XMLA | Low | Similar breadth; XMLA adds deeper programmatic access |
| 97 | **Metadata API** | Scanner API + XMLA endpoints | Low | `POST /admin/workspaces/getInfo` |

---

## 9. AI and advanced analytics

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 98 | **Ask Data** (natural language query) | Q&A visual / Copilot | Low | Q&A is embedded in reports; Copilot adds generative AI |
| 99 | **Explain Data** | Key Influencers visual | Low | AI-driven root cause analysis |
| 100 | **Tableau Pulse** (metric monitoring) | Power BI Metrics + Data Activator | Medium | Data Activator adds automated triggering |
| 101 | **Einstein Discovery** (Salesforce) | Copilot in Power BI | Medium | Copilot generates DAX, visuals, and narratives |
| 102 | **R/Python integration** | R/Python visuals + Fabric notebooks | Low | Similar capability; Fabric notebooks add managed compute |
| 103 | **Trend lines / forecasting** | Analytics pane (forecast, trend) | Low | Built-in statistical overlays |
| 104 | **Clustering** | R/Python visual or Fabric ML | Medium | Not native in Power BI visuals; use Fabric ML or custom visual |

---

## 10. Mobile

| # | Tableau feature | Power BI equivalent | Complexity | Notes |
|---|---|---|---|---|
| 105 | **Tableau Mobile app** | Power BI Mobile app | Low | Direct equivalent; iOS, Android, Windows |
| 106 | **Mobile layout** (Tableau) | Mobile layout (Power BI) | Low | Dedicated mobile layout designer per report page |
| 107 | **Offline access** | Offline access (with caching) | Low | Similar capability |

---

## Migration complexity summary

| Complexity | Count | Examples |
|---|---|---|
| **Low** | ~65 features | Chart types, filters, subscriptions, server concepts |
| **Medium** | ~30 features | Parameters, sets, data blending, some chart types |
| **High** | ~10 features | LOD expressions, table calculations, advanced mark types |

The high-complexity items are concentrated in the calculation layer (LOD and table calculations) and a handful of visualization types (packed bubbles, density plots). Invest your migration time budget in these areas.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Calculation Conversion](calculation-conversion.md) | [Visualization Migration](visualization-migration.md) | [Migration Playbook](../tableau-to-powerbi.md)
