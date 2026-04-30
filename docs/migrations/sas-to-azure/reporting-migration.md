# SAS Reporting Migration: SAS Visual Analytics to Power BI

**Audience:** Report Developers, Business Analysts, SAS VA Administrators
**Purpose:** Migrate SAS Visual Analytics reports, SAS Stored Processes, ODS output, and SAS/GRAPH visualizations to Power BI, Power BI paginated reports, and Fabric notebooks.

---

## 1. Overview

SAS Visual Analytics (VA) is SAS's self-service BI and data exploration tool. Power BI is the Azure-native replacement that integrates with Fabric lakehouses, Azure ML, and the broader Microsoft ecosystem. This migration is typically the **lowest-risk, highest-ROI** first step in a SAS-to-Azure journey because Power BI is a mature product with no code conversion required --- reports are rebuilt, not translated.

| SAS VA concept        | Power BI equivalent                            | Notes                                              |
| --------------------- | ---------------------------------------------- | -------------------------------------------------- |
| VA Report             | Power BI Report (.pbix)                        | Rebuilt in Power BI Desktop or Power BI Service    |
| VA Exploration        | Power BI Explore / Analyze in Excel            | Self-service data exploration                      |
| VA Data Source        | Semantic Model (Direct Lake or Import)         | Direct Lake over Fabric lakehouses is preferred    |
| VA Prompt (parameter) | Power BI Slicer / Filter                       | Slicers provide equivalent filtering               |
| VA Geographic Map     | Power BI Map / Azure Maps visual               | Built-in map visuals                               |
| VA Network Diagram    | Power BI custom visuals (Force-Directed Graph) | Requires AppSource custom visual                   |
| VA Word Cloud         | Power BI Word Cloud visual                     | AppSource custom visual                            |
| VA Gauge              | Power BI Gauge / KPI visual                    | Built-in                                           |
| VA Waterfall Chart    | Power BI Waterfall Chart                       | Built-in                                           |
| VA Heat Map           | Power BI Matrix with conditional formatting    | Built-in                                           |
| SAS Stored Process    | Power BI Paginated Report (SSRS-based)         | Parameterized, scheduled, pixel-perfect output     |
| ODS HTML output       | Power BI web report / notebook HTML export     | Power BI is interactive; notebooks for static HTML |
| ODS PDF output        | Power BI paginated report (PDF export)         | Paginated reports export to PDF natively           |
| ODS RTF output        | Power BI paginated report (Word export)        | Paginated reports export to Word/PDF               |
| ODS Excel output      | Power BI Export to Excel / Analyze in Excel    | Native Excel integration                           |

---

## 2. Migration approach

### 2.1 Report inventory

Before migrating, inventory all SAS VA reports:

```
For each SAS VA report, document:
- Report name and description
- Data source (SAS table, LASR table, CAS table)
- Number of pages/sections
- Visual types used (bar, line, scatter, map, table, etc.)
- Prompts/parameters
- Filters (global, section, visual)
- Calculated columns / derived items
- User count (consumers and editors)
- Refresh frequency
- Distribution method (email, web, mobile)
- Criticality (high / medium / low)
```

### 2.2 Priority framework

| Priority                 | Report characteristics                                                               | Migration order |
| ------------------------ | ------------------------------------------------------------------------------------ | --------------- |
| **High (migrate first)** | Simple bar/line/table reports, few prompts, standard data sources, many consumers    | Weeks 1--4      |
| **Medium**               | Complex visuals, multiple data sources, calculated items, moderate prompt complexity | Weeks 4--8      |
| **Low (migrate last)**   | Custom SAS VA objects, network diagrams, complex interactions, few consumers         | Weeks 8--12+    |

---

## 3. Visual object mapping

### 3.1 Standard visuals

| SAS VA visual     | Power BI visual                    | Configuration notes                           |
| ----------------- | ---------------------------------- | --------------------------------------------- |
| Bar Chart         | Bar Chart (Clustered/Stacked)      | Drag fields to Axis, Values, Legend           |
| Line Chart        | Line Chart                         | Axis = date/category, Values = measure        |
| Pie Chart / Donut | Pie Chart / Donut Chart            | Category = Legend, Value = Values             |
| Scatter Plot      | Scatter Chart                      | X Axis, Y Axis, Size, Color (Legend)          |
| Bubble Plot       | Scatter Chart (with Size field)    | Add Size field for bubble sizing              |
| Treemap           | Treemap                            | Group = category, Values = measure            |
| Crosstab / Table  | Table / Matrix                     | Rows, Columns, Values; Matrix for pivot-style |
| List Table        | Table visual                       | Simple row/column table                       |
| Geographic Map    | Map / Filled Map / Azure Maps      | Latitude/Longitude or geographic hierarchy    |
| Gauge             | Gauge / KPI                        | Value, Target, Min/Max                        |
| Text Object       | Text Box / Card visual             | Static text or measure display                |
| Container         | Visual Container / Bookmark groups | Group visuals together                        |
| Button            | Button / Bookmark navigator        | Navigation and interactivity                  |

### 3.2 SAS VA calculated items to DAX measures

**SAS VA calculated item (profit margin):**

```
Name: Profit_Margin
Expression: (Revenue - Cost) / Revenue
Format: PERCENT8.1
```

**Power BI DAX measure:**

```dax
Profit Margin =
DIVIDE(
    SUM('Sales'[Revenue]) - SUM('Sales'[Cost]),
    SUM('Sales'[Revenue]),
    0
)
```

**SAS VA calculated item (year-over-year growth):**

```
Name: YoY_Growth
Expression: (Current_Year_Revenue - Prior_Year_Revenue) / Prior_Year_Revenue
```

**Power BI DAX measure:**

```dax
YoY Growth =
VAR CurrentYear = SUM('Sales'[Revenue])
VAR PriorYear =
    CALCULATE(
        SUM('Sales'[Revenue]),
        SAMEPERIODLASTYEAR('Calendar'[Date])
    )
RETURN
    DIVIDE(CurrentYear - PriorYear, PriorYear, 0)
```

**SAS VA running total:**

```
Name: Running_Total
Expression: Running total of Revenue by Date
```

**Power BI DAX:**

```dax
Running Total =
CALCULATE(
    SUM('Sales'[Revenue]),
    FILTER(
        ALL('Calendar'[Date]),
        'Calendar'[Date] <= MAX('Calendar'[Date])
    )
)
```

---

## 4. SAS VA prompts to Power BI slicers

### 4.1 Dropdown prompt to slicer

**SAS VA prompt:**

```
Prompt Name: Select Region
Type: Drop-down list
Data Source: DISTINCT region FROM fact_sales
Default: All
Multi-select: Yes
```

**Power BI:**

1. Add a Slicer visual to the report page
2. Drag the `Region` field to the slicer
3. Format: Dropdown style, multi-select enabled
4. Set "Select all" option to enabled

### 4.2 Date range prompt to date slicer

**SAS VA:**

```
Prompt Name: Date Range
Type: Date range
Default: Current fiscal year
```

**Power BI:**

1. Add a Slicer visual
2. Drag `Date` field
3. Format: Between (date range slider)
4. Add relative date filtering: "is in the last 1 fiscal year"

### 4.3 Cascading prompts to synced slicers

**SAS VA cascading prompts:**

```
Prompt 1: Select State -> filters available Cities
Prompt 2: Select City (filtered by State)
```

**Power BI:**
Cascading is automatic in Power BI. When `State` slicer filters the data model, the `City` slicer automatically shows only cities in selected states. No additional configuration needed --- this is a core Power BI behavior.

---

## 5. SAS Stored Processes to Power BI paginated reports

SAS Stored Processes are parameterized server-side programs that generate formatted output (HTML, PDF, Excel). The Power BI equivalent is **Paginated Reports** (based on SQL Server Reporting Services / SSRS engine).

### 5.1 Feature mapping

| SAS Stored Process feature | Paginated Report equivalent                        |
| -------------------------- | -------------------------------------------------- |
| Input parameters           | Report Parameters                                  |
| HTML/PDF/RTF/Excel output  | Export to PDF, Excel, Word, HTML, CSV, XML         |
| Scheduled execution        | Power BI subscriptions (email delivery)            |
| Web URL invocation         | Direct URL with parameter query string             |
| SAS code execution         | Dataset query (SQL, DAX, or stored procedure)      |
| ODS formatting             | Report Builder formatting (tables, charts, images) |
| Server-side caching        | Report caching in Power BI Premium                 |

### 5.2 Migration steps

1. **Identify the data query** in the SAS Stored Process (the PROC SQL or DATA Step that generates data)
2. **Recreate the query** as a SQL query against the Fabric lakehouse or Azure SQL database
3. **Build the report layout** in Power BI Report Builder
4. **Map parameters** from SAS prompts to paginated report parameters
5. **Configure subscriptions** for scheduled email delivery
6. **Publish** to Power BI Premium workspace

---

## 6. Data source migration

### 6.1 SAS VA data sources to Power BI semantic models

| SAS VA data source              | Power BI semantic model approach                        |
| ------------------------------- | ------------------------------------------------------- |
| SAS dataset (SAS7BDAT in LASR)  | Direct Lake over Fabric lakehouse Delta table           |
| CAS table (in-memory)           | Direct Lake (Fabric handles caching)                    |
| SAS data view                   | dbt model materialized as Delta table, then Direct Lake |
| External database (via LIBNAME) | DirectQuery or Import mode                              |
| SAS Information Map             | Power BI semantic model (star schema)                   |

### 6.2 Direct Lake semantic model (recommended)

```
Architecture:
  SAS Data --> Delta Table (Fabric Lakehouse) --> Direct Lake Semantic Model --> Power BI Report
```

Direct Lake provides:

- No data movement (reads Delta files directly from OneLake)
- Near-real-time refresh (as Delta tables update, reports reflect changes)
- VertiPaq performance with lakehouse-scale data
- Single source of truth shared with notebooks, Azure ML, and SAS (via SAS on Fabric)

---

## 7. SAS/GRAPH to Python visualization

For reports that include SAS/GRAPH output embedded in ODS documents, the equivalent in csa-inabox is matplotlib/seaborn/plotly in Fabric notebooks.

### 7.1 PROC SGPLOT to matplotlib

**SAS:**

```sas
proc sgplot data=work.quarterly;
  vbar quarter / response=revenue group=region groupdisplay=cluster;
  xaxis label="Quarter";
  yaxis label="Revenue ($M)" grid;
  keylegend / title="Region" position=topright;
  title "Quarterly Revenue by Region";
run;
```

**Python (matplotlib):**

```python
import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots(figsize=(12, 6))

quarters = df['quarter'].unique()
regions = df['region'].unique()
x = np.arange(len(quarters))
width = 0.8 / len(regions)

for i, region in enumerate(regions):
    region_data = df[df['region'] == region]
    values = [region_data[region_data['quarter'] == q]['revenue'].sum()
              for q in quarters]
    ax.bar(x + i * width, values, width, label=region)

ax.set_xlabel('Quarter')
ax.set_ylabel('Revenue ($M)')
ax.set_title('Quarterly Revenue by Region')
ax.set_xticks(x + width * (len(regions) - 1) / 2)
ax.set_xticklabels(quarters)
ax.legend(title='Region', loc='upper right')
ax.grid(axis='y', alpha=0.3)
plt.tight_layout()
plt.show()
```

### 7.2 PROC SGPANEL to seaborn FacetGrid

**SAS:**

```sas
proc sgpanel data=work.clinical;
  panelby treatment / columns=2;
  scatter x=baseline_score y=outcome / group=sex;
  reg x=baseline_score y=outcome / group=sex;
  rowaxis label="Outcome Score";
  colaxis label="Baseline Score";
run;
```

**Python (seaborn):**

```python
import seaborn as sns

g = sns.FacetGrid(df, col='treatment', col_wrap=2, height=5)
g.map_dataframe(sns.scatterplot, x='baseline_score', y='outcome', hue='sex')
g.map_dataframe(sns.regplot, x='baseline_score', y='outcome',
                scatter=False, ci=None)
g.add_legend()
g.set_axis_labels('Baseline Score', 'Outcome Score')
plt.tight_layout()
plt.show()
```

---

## 8. Migration timeline

For a typical SAS VA estate with 30--80 reports:

| Week   | Activity                              | Deliverables                                  |
| ------ | ------------------------------------- | --------------------------------------------- |
| 1      | Report inventory and prioritization   | Inventory spreadsheet, priority tiers         |
| 2--3   | Semantic model design                 | Star schema design, Direct Lake configuration |
| 3--5   | High-priority reports (top 10)        | Power BI reports published to workspace       |
| 5--8   | Medium-priority reports (next 20)     | Power BI reports published                    |
| 8--10  | Stored Processes to paginated reports | Paginated reports published                   |
| 10--12 | Low-priority reports + validation     | Remaining reports; user acceptance            |
| 12--14 | Training and cutover                  | User training; SAS VA decommission            |

---

## 9. Power BI advantages over SAS VA

| Capability           | SAS VA                                 | Power BI                                                        | Advantage                 |
| -------------------- | -------------------------------------- | --------------------------------------------------------------- | ------------------------- |
| Natural language Q&A | Limited NLQ                            | Copilot + Q&A visual                                            | Power BI                  |
| Mobile experience    | SAS VA mobile app                      | Power BI mobile app (iOS/Android)                               | Comparable                |
| Embedded analytics   | SAS VA SDK                             | Power BI Embedded (REST API)                                    | Power BI (richer API)     |
| Real-time dashboards | SAS ESP integration                    | Direct Lake + streaming datasets                                | Power BI                  |
| Row-level security   | SAS VA RLS                             | Power BI RLS (DAX-based)                                        | Comparable                |
| Excel integration    | Limited                                | Analyze in Excel (live connection)                              | Power BI                  |
| Teams integration    | None                                   | Power BI in Teams tabs/chat                                     | Power BI                  |
| AI visuals           | SAS forecasting visual                 | Smart narrative, decomposition tree, anomaly detection, Copilot | Power BI                  |
| Licensing            | Per-user or capacity ($200K--$500K/yr) | Power BI Pro ($10/user/mo) or Premium/Fabric capacity           | Power BI (far lower cost) |
| Copilot              | None                                   | Power BI Copilot (natural language report creation)             | Power BI                  |

---

## 10. Validation checklist

| Check                  | Method                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| Visual accuracy        | Side-by-side comparison of SAS VA and Power BI for the same date range     |
| Data accuracy          | Compare aggregate values (sums, counts, averages) between SAS and Power BI |
| Filter/slicer behavior | Test each prompt/slicer combination; verify consistent filtering           |
| Drill-down paths       | Verify hierarchy navigation matches SAS VA interaction                     |
| Parameter passing      | Test all parameter combinations for paginated reports                      |
| Mobile rendering       | Test on iOS and Android devices                                            |
| Performance            | Page load time under 3 seconds for typical reports                         |
| Security               | Verify RLS rules match SAS VA data-level security                          |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
