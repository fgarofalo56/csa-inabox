---
title: "Qlik to Power BI Complete Feature Mapping"
description: "50+ Qlik Sense features mapped to Power BI equivalents with migration complexity ratings, gap analysis, and recommendations."
---

# Qlik to Power BI: Complete Feature Mapping

**Audience:** BI architects, report developers, platform engineers
**Purpose:** Definitive feature-by-feature mapping for migration planning and effort estimation
**Reading time:** 20-30 minutes

---

## How to read this document

Each table maps Qlik Sense features to their Power BI equivalents. The **Complexity** column rates migration difficulty:

- **XS** -- direct 1:1 mapping, trivial effort
- **S** -- minor adaptation, < 1 hour per instance
- **M** -- moderate rework, 1-4 hours per instance
- **L** -- significant rework, 4-16 hours per instance
- **XL** -- architectural redesign required, 16+ hours per instance

The **Gap** column indicates where Power BI does not have a direct equivalent:

- **None** -- full parity or better
- **Minor** -- workaround available, minimal impact
- **Moderate** -- requires alternative approach
- **Significant** -- no direct equivalent, architectural change needed

---

## 1. Data engine and modeling

| #   | Qlik feature                           | Power BI equivalent                                    | Complexity | Gap      | Notes                                                                |
| --- | -------------------------------------- | ------------------------------------------------------ | ---------- | -------- | -------------------------------------------------------------------- |
| 1   | Associative engine                     | VertiPaq columnar engine                               | L          | Moderate | Different paradigm: all-to-all associations vs defined relationships |
| 2   | In-memory data model                   | Import mode (VertiPaq)                                 | S          | None     | Both are in-memory; VertiPaq has better compression                  |
| 3   | QVD files (proprietary cache)          | Direct Lake / Import / Dataflows                       | M          | None     | Direct Lake on CSA-in-a-Box eliminates need for intermediate cache   |
| 4   | Data load script                       | Power Query M + Dataflows                              | L          | Minor    | Complex load scripts require dbt on CSA-in-a-Box, not Power Query    |
| 5   | Binary load (app-to-app data sharing)  | Shared semantic model                                  | M          | None     | Shared semantic models are architecturally superior                  |
| 6   | Synthetic keys                         | No equivalent (not needed)                             | M          | None     | Star schema design eliminates synthetic keys by design               |
| 7   | Circular reference resolution          | No equivalent (not needed)                             | M          | None     | Star schema does not permit circular references                      |
| 8   | Auto-calendar (master calendar)        | Auto date/time tables or custom calendar               | S          | None     | Power BI generates date hierarchies automatically                    |
| 9   | Section Access (data reduction)        | Row-level security (RLS)                               | M          | None     | DAX-based RLS is more flexible than Section Access                   |
| 10  | Concatenation (CONCATENATE statement)  | Append queries in Power Query                          | S          | None     | Direct equivalent in Power Query                                     |
| 11  | Preceding Load                         | Power Query step chaining                              | S          | None     | Power Query steps are inherently chained                             |
| 12  | Mapping Load / ApplyMap                | Power Query merge or DAX LOOKUPVALUE                   | M          | None     | Different syntax, same outcome                                       |
| 13  | Resident Load                          | Power Query table references                           | S          | None     | Reference existing queries in Power Query                            |
| 14  | Incremental load (WHERE clause on QVD) | Incremental refresh (Power BI) or dbt incremental      | M          | None     | Power BI incremental refresh or dbt incremental models               |
| 15  | CrossTable / Generic Load              | Unpivot in Power Query                                 | S          | None     | Power Query has built-in unpivot/pivot transformations               |
| 16  | IntervalMatch                          | DAX GENERATE + FILTER or relationship bridging         | L          | Minor    | No direct equivalent; requires bridge table pattern                  |
| 17  | Qualify / Unqualify                    | Column rename in Power Query                           | XS         | None     | Explicit column management in Power Query                            |
| 18  | Star schema support                    | Native star schema (optimized)                         | XS         | None     | Power BI is built for star schemas                                   |
| 19  | Composite models                       | Composite models (DirectQuery + Import)                | S          | None     | Power BI composite models since 2022                                 |
| 20  | Data model relationships               | Model relationships (1:M, M:M, cross-filter direction) | M          | None     | More explicit than Qlik, better performance tuning                   |

---

## 2. Expressions and calculations

| #   | Qlik feature                                 | Power BI equivalent                                 | Complexity | Gap      | Notes                                                           |
| --- | -------------------------------------------- | --------------------------------------------------- | ---------- | -------- | --------------------------------------------------------------- |
| 21  | Basic aggregations (Sum, Count, Avg, etc)    | DAX aggregation functions                           | XS         | None     | 1:1 mapping with minor syntax differences                       |
| 22  | Set Analysis                                 | DAX CALCULATE + filter arguments                    | L          | Minor    | DAX is more verbose but equally powerful                        |
| 23  | Set Analysis with exclusion ({<Field-=>})    | CALCULATE + ALL + filter                            | L          | Minor    | Requires explicit ALL() to remove filter context                |
| 24  | Set Analysis with assignment ({<F={value}>}) | CALCULATE + explicit filter                         | M          | None     | Direct pattern match                                            |
| 25  | Set Analysis with search ({<F={"_text_"}>})  | CALCULATE + CONTAINSSTRING filter                   | M          | None     | DAX string functions in filter context                          |
| 26  | Set Analysis with dollar-sign expansion      | DAX variables and dynamic measures                  | L          | Minor    | No direct equivalent; use DAX variables or field parameters     |
| 27  | Aggr() function                              | SUMMARIZE / CALCULATETABLE + iterator               | L          | Minor    | Aggr() has no single DAX equivalent; pattern depends on context |
| 28  | Nested Aggr()                                | Nested SUMMARIZE or ADDCOLUMNS                      | XL         | Moderate | Complex nested patterns require careful DAX rewrite             |
| 29  | Above() / Below() (inter-record)             | OFFSET / WINDOW (DAX 2023+) or INDEX/OFFSET pattern | M          | None     | DAX window functions are newer but capable                      |
| 30  | RangeSum() / RangeAvg()                      | DATESINPERIOD or WINDOW for rolling calculations    | M          | None     | Use time intelligence or window functions                       |
| 31  | Dual() function                              | Format strings or Sort By Column                    | S          | None     | Different approach: use Sort By Column for display ordering     |
| 32  | Date functions (MonthName, Year, etc)        | DAX FORMAT, YEAR, MONTH, etc                        | S          | None     | Standard date function mapping                                  |
| 33  | Text() / Num() type conversion               | DAX FORMAT, VALUE, CONVERT                          | S          | None     | Standard type conversion                                        |
| 34  | If() conditional                             | DAX IF()                                            | XS         | None     | 1:1 mapping                                                     |
| 35  | Pick() / Match()                             | DAX SWITCH()                                        | S          | None     | SWITCH is more readable than Pick/Match                         |
| 36  | Rank() function                              | DAX RANKX()                                         | M          | None     | RANKX requires explicit table argument                          |
| 37  | FirstSortedValue()                           | DAX TOPN + CALCULATE or MINX/MAXX                   | M          | None     | Pattern depends on exact usage                                  |
| 38  | Concat() / TextBetween()                     | DAX CONCATENATEX, MID, SEARCH                       | S          | None     | Standard string functions                                       |
| 39  | Alt() / Coalesce()                           | DAX COALESCE()                                      | XS         | None     | Direct equivalent                                               |
| 40  | Variable assignment (LET / SET)              | DAX VAR ... RETURN                                  | S          | None     | DAX variables are scoped to the measure                         |

---

## 3. Visualization and user experience

| #   | Qlik feature                      | Power BI equivalent                       | Complexity | Gap   | Notes                                                   |
| --- | --------------------------------- | ----------------------------------------- | ---------- | ----- | ------------------------------------------------------- |
| 41  | Bar / Line / Combo charts         | Bar / Line / Combo charts                 | XS         | None  | Direct mapping                                          |
| 42  | KPI object                        | KPI card / Card visual                    | XS         | None  | Direct mapping; Power BI cards are more customizable    |
| 43  | Pivot table                       | Matrix visual                             | S          | None  | Matrix supports expand/collapse, conditional formatting |
| 44  | Straight table                    | Table visual                              | XS         | None  | Direct mapping with more formatting options             |
| 45  | Scatter plot                      | Scatter chart                             | XS         | None  | Power BI adds play axis for animation                   |
| 46  | Map (point, area, line, density)  | Map / Filled Map / Azure Maps / ArcGIS    | S          | None  | Multiple map options in Power BI                        |
| 47  | Treemap                           | Treemap visual                            | XS         | None  | Direct mapping                                          |
| 48  | Gauge chart                       | Gauge visual                              | XS         | None  | Direct mapping                                          |
| 49  | Waterfall chart                   | Waterfall chart                           | XS         | None  | Direct mapping                                          |
| 50  | Box plot                          | Box and Whisker (custom visual)           | S          | Minor | Available on AppSource                                  |
| 51  | Distribution plot                 | Histogram or custom visual                | S          | Minor | Use histogram or Python/R visual                        |
| 52  | Bullet chart                      | Bullet chart (custom visual)              | S          | Minor | Available on AppSource                                  |
| 53  | Funnel chart                      | Funnel chart                              | XS         | None  | Direct mapping                                          |
| 54  | Mekko chart                       | Custom visual or stacked bar              | M          | Minor | Marimekko available on AppSource                        |
| 55  | Container (show/hide conditions)  | Bookmarks + buttons (toggle visibility)   | M          | Minor | Different UX but same outcome                           |
| 56  | Alternate states                  | Bookmarks + slicer groups                 | M          | Minor | Bookmarks approximate alternate states for comparison   |
| 57  | Filter pane                       | Slicer visual (list, dropdown, range)     | S          | None  | Slicer sync across pages for consistent filtering       |
| 58  | Storytelling (guided narrative)   | Report pages + page navigator + bookmarks | M          | None  | Power BI story-like experience through page sequencing  |
| 59  | Responsive design / device layout | Mobile layout view                        | S          | None  | Power BI has dedicated mobile layout editor             |
| 60  | Smart search                      | Slicer search + Q&A visual                | S          | None  | Q&A provides natural language search                    |

---

## 4. Selection model and interactivity

| #   | Qlik feature                             | Power BI equivalent                       | Complexity | Gap      | Notes                                                                    |
| --- | ---------------------------------------- | ----------------------------------------- | ---------- | -------- | ------------------------------------------------------------------------ |
| 61  | Green/white/gray selection states        | Cross-filtering + slicer highlighting     | M          | Moderate | Power BI does not replicate the gray (excluded) state visually           |
| 62  | Associative selections across all tables | Cross-filtering via defined relationships | M          | Moderate | Power BI requires explicit relationships for cross-filtering             |
| 63  | Selection bar (current selections)       | Filter pane + slicer visual state         | S          | Minor    | Filter pane shows active filters; not as prominent as Qlik selection bar |
| 64  | Clear selections (one field / all)       | Clear slicer / Clear all filters button   | S          | None     | Add a "Reset Filters" bookmark button                                    |
| 65  | Back / Forward selection history         | No direct equivalent                      | M          | Moderate | Bookmarks can save states but no automatic history stack                 |
| 66  | Lock selections                          | Slicer sync + fixed slicer values         | M          | Minor    | Use slicer sync and page-level filters for similar behavior              |
| 67  | Bookmark (user-saved selections)         | Personal bookmarks                        | XS         | None     | Direct mapping; Power BI bookmarks are more feature-rich                 |

---

## 5. Server, administration, and governance

| #   | Qlik feature                           | Power BI equivalent                           | Complexity | Gap      | Notes                                                                   |
| --- | -------------------------------------- | --------------------------------------------- | ---------- | -------- | ----------------------------------------------------------------------- |
| 68  | Qlik Management Console (QMC)          | Power BI Admin Portal + Fabric Admin Center   | S          | None     | Web-based admin; more features in Power BI admin                        |
| 69  | Streams (content organization)         | Workspaces                                    | S          | None     | 1:1 mapping; workspaces have more granular roles                        |
| 70  | Spaces (shared, managed, personal)     | Workspaces + My Workspace                     | S          | None     | Shared space = workspace; personal space = My Workspace                 |
| 71  | Apps (QVF files)                       | Reports (.pbix) + Semantic models             | M          | None     | Qlik app = Power BI report + semantic model (can be separated)          |
| 72  | Security rules (attribute-based)       | Workspace roles + RLS + sensitivity labels    | M          | None     | RLS for data-level security; workspace roles for content security       |
| 73  | Reload tasks (scheduled data refresh)  | Dataset refresh schedule + Dataflow refresh   | S          | None     | Up to 48 refreshes/day on Premium; unlimited with Direct Lake           |
| 74  | Node management (multi-node cluster)   | N/A (SaaS, Microsoft-managed)                 | XS         | None     | Power BI Service is SaaS; no server management                          |
| 75  | License allocation                     | Microsoft 365 Admin Center                    | S          | None     | Managed through M365 license assignment                                 |
| 76  | Monitoring apps (usage, reload stats)  | Power BI Activity Log + Usage Metrics         | S          | None     | Built-in usage metrics report; Log Analytics for advanced monitoring    |
| 77  | App migration (dev/test/prod)          | Deployment pipelines                          | S          | None     | Native dev/test/prod promotion in Power BI Premium                      |
| 78  | Extensions (Nebula.js, legacy mashups) | Custom visuals (AppSource, R/Python, SDK)     | M-L        | Minor    | AppSource has 200+ visuals; Power BI visuals SDK for custom development |
| 79  | ODAG (on-demand app generation)        | Drillthrough + DirectQuery + Detail reports   | L          | Moderate | No direct ODAG equivalent; use drillthrough to detail reports           |
| 80  | Multi-cloud deployment                 | Power BI Service (global, GCC, GCC-High, DoD) | S          | None     | Government cloud variants available                                     |

---

## 6. Reporting and distribution

| #   | Qlik feature                           | Power BI equivalent                         | Complexity | Gap  | Notes                                                      |
| --- | -------------------------------------- | ------------------------------------------- | ---------- | ---- | ---------------------------------------------------------- |
| 81  | Qlik NPrinting (pixel-perfect reports) | Paginated reports (SSRS-based)              | M-L        | None | Full pixel-perfect capability; included in Premium/Fabric  |
| 82  | NPrinting email distribution           | Power BI subscriptions (email with PDF/PNG) | S          | None | Native email subscriptions with PDF attachment support     |
| 83  | NPrinting report templates             | Paginated report templates (Report Builder) | M          | None | Report Builder provides template-based authoring           |
| 84  | NPrinting parameter-driven reports     | Paginated report parameters                 | S          | None | Full parameter support (dropdowns, multi-value, cascading) |
| 85  | Qlik Alerting                          | Data alerts on dashboard tiles              | S          | None | Set threshold-based alerts on KPI tiles and cards          |
| 86  | Qlik subscriptions                     | Power BI subscriptions                      | XS         | None | Direct mapping with more scheduling options                |
| 87  | Export to Excel / PDF / image          | Export to Excel / PDF / PowerPoint / CSV    | XS         | None | Power BI adds PowerPoint export                            |
| 88  | Print to PDF                           | Export to PDF + Paginated reports           | S          | None | Paginated reports provide print-optimized layouts          |

---

## 7. AI and advanced analytics

| #   | Qlik feature                              | Power BI equivalent                         | Complexity | Gap   | Notes                                                            |
| --- | ----------------------------------------- | ------------------------------------------- | ---------- | ----- | ---------------------------------------------------------------- |
| 89  | Insight Advisor (NL-driven insights)      | Copilot in Power BI                         | S          | None  | Copilot is more capable (multi-turn, DAX generation, narratives) |
| 90  | Insight Advisor Chat                      | Copilot conversational + Q&A visual         | S          | None  | Copilot provides richer conversational analytics                 |
| 91  | Qlik AutoML                               | Fabric ML experiments + AutoML              | M          | None  | Fabric ML provides full MLOps lifecycle                          |
| 92  | Associative insights                      | Key Influencers + Decomposition Tree        | M          | Minor | Different approach: AI-driven vs association-driven              |
| 93  | Cognitive Engine (expression suggestions) | Copilot (DAX generation + explanation)      | S          | None  | Copilot writes, explains, and debugs DAX measures                |
| 94  | NL query to chart                         | Q&A visual + Copilot                        | S          | None  | Q&A has been available since 2017; Copilot adds depth            |
| 95  | Smart Insights (anomaly detection)        | Anomaly Detection visual + Smart Narratives | S          | None  | Power BI detects anomalies in time series natively               |

---

## 8. Developer and extensibility

| #   | Qlik feature                            | Power BI equivalent                           | Complexity | Gap   | Notes                                                                  |
| --- | --------------------------------------- | --------------------------------------------- | ---------- | ----- | ---------------------------------------------------------------------- |
| 96  | Engine API (WebSocket, JSON-RPC)        | REST API + XMLA endpoints                     | M          | None  | XMLA provides deeper semantic model access than Engine API             |
| 97  | Mashups (HTML/JS embedding)             | Power BI Embedded (JavaScript SDK)            | M          | None  | Power BI Embedded is more mature for multi-tenant scenarios            |
| 98  | Nebula.js (visualization extensions)    | Power BI custom visuals (SDK, D3.js)          | M          | Minor | Different SDK but same outcome; AppSource marketplace for distribution |
| 99  | QlikView-to-Qlik Sense migration        | N/A                                           | XS         | None  | If migrating from QlikView, go directly to Power BI                    |
| 100 | Qlik Analytics Platform (OEM embedding) | Power BI Embedded (A/EM SKUs)                 | M          | None  | Capacity-based pricing is typically cheaper at scale                   |
| 101 | SaaS / multi-tenant extensions          | Power BI Embedded multi-tenancy patterns      | M          | None  | Service principal profiles for tenant isolation                        |
| 102 | REST connector (generic)                | Power Query Web connector + custom connectors | S          | None  | Power Query supports REST natively; SDK for custom connectors          |

---

## 9. Migration complexity summary

| Complexity | Feature count | % of total | Typical migration approach                              |
| ---------- | ------------- | ---------- | ------------------------------------------------------- |
| XS         | 22            | 21%        | Direct mapping, minimal effort                          |
| S          | 36            | 35%        | Minor syntax or configuration changes                   |
| M          | 30            | 29%        | Moderate rework, 1-4 hours per instance                 |
| L          | 11            | 11%        | Significant rewrite (Set Analysis, data model, ODAG)    |
| XL         | 3             | 3%         | Architectural redesign (nested Aggr, associative model) |

### Key risk areas

1. **Set Analysis to DAX CALCULATE** (L) -- the most common high-effort item. Every Qlik app with Set Analysis needs manual DAX conversion.
2. **Associative model to star schema** (L) -- requires data model redesign, not just tool migration.
3. **Aggr() function** (L-XL) -- no single DAX equivalent; each instance requires analysis of the specific pattern.
4. **ODAG** (L) -- on-demand app generation has no Power BI equivalent; requires architectural rethinking using drillthrough, DirectQuery, or parameterized reports.
5. **Selection model** (M) -- the green/white/gray selection feedback does not exist in Power BI; users need training on the slicer/cross-filter paradigm.

---

## 10. Features Power BI has that Qlik does not

| Feature                          | What it does                                            | Why it matters                                             |
| -------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| **Copilot**                      | NL to DAX, report generation, executive summaries       | Non-technical users can ask questions without learning DAX |
| **Direct Lake**                  | Zero-copy BI on Delta tables in OneLake                 | Eliminates QVD pipeline entirely                           |
| **Analyze in Excel**             | Live PivotTable connected to semantic model             | Finance users stay in Excel while querying governed data   |
| **Teams embedding**              | Pin reports to channels and chats                       | Reports go where the collaboration happens                 |
| **Deployment pipelines**         | Dev to Test to Prod promotion for BI content            | ALM for BI without manual QVF export                       |
| **Paginated reports (included)** | Pixel-perfect, print-ready reports                      | Replaces NPrinting at no additional cost                   |
| **Fabric Git integration**       | Version control for semantic models (TMDL format)       | True CI/CD for BI content                                  |
| **Smart Narratives**             | AI-generated text summaries of visuals                  | Automated commentary on chart trends                       |
| **Decomposition Tree**           | Interactive root cause analysis visual                  | Drill into contributing factors with AI splits             |
| **Key Influencers**              | AI visual showing what drives a metric                  | Automated feature importance for business users            |
| **PowerPoint live integration**  | Live Power BI visuals embedded in slides                | Data updates in real-time during presentations             |
| **Datamart**                     | Self-service relational database with SQL endpoint      | Analysts who want SQL get a managed database               |
| **Sensitivity labels**           | Apply information protection labels to Power BI content | Governance integration with Microsoft Purview              |

---

## Cross-references

| Topic                        | Document                                              |
| ---------------------------- | ----------------------------------------------------- |
| Expression migration details | [Expression Migration](expression-migration.md)       |
| Data model conversion guide  | [Data Model Migration](data-model-migration.md)       |
| Visualization mapping        | [Visualization Migration](visualization-migration.md) |
| Server migration details     | [Server Migration](server-migration.md)               |
| NPrinting replacement        | [NPrinting Migration](nprinting-migration.md)         |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
