# Tutorial: Convert a Tableau Workbook to a Power BI Report (.pbix)

**A step-by-step, hands-on guide for converting a Tableau workbook end-to-end — from data source analysis through published report with RLS.**

---

## Prerequisites

- Tableau Desktop installed (to inspect the source workbook)
- Power BI Desktop installed (latest version)
- Access to the data sources used by the Tableau workbook
- Familiarity with the [Calculation Conversion Reference](calculation-conversion.md)
- Familiarity with the [Visualization Migration](visualization-migration.md) guide

**Estimated time:** 3-4 hours for a medium-complexity workbook (5-10 worksheets, 5-15 calculated fields, no LOD expressions). Add 2-4 hours for workbooks with LOD expressions or complex table calculations.

---

## Overview of the conversion process

```mermaid
flowchart LR
    A[Step 1<br/>Document] --> B[Step 2<br/>Connect Data]
    B --> C[Step 3<br/>Build Model]
    C --> D[Step 4<br/>Convert Calcs]
    D --> E[Step 5<br/>Build Visuals]
    E --> F[Step 6<br/>Format]
    F --> G[Step 7<br/>Configure RLS]
    G --> H[Step 8<br/>Publish]
```

---

## Step 1: Document the existing Tableau workbook

Before opening Power BI Desktop, thoroughly document the Tableau workbook you are converting. This inventory is the migration specification.

### 1.1 Workbook metadata

Create a document (spreadsheet or markdown) with:

```
Workbook Name: [e.g., "Regional Sales Dashboard"]
Tableau Server Location: [URL and project path]
Owner: [Who created/maintains it]
Last Modified: [Date]
Usage: [Views per week from Tableau Server admin]
Priority: [High / Medium / Low]
Complexity: [Simple / Medium / Complex]
```

### 1.2 Data source inventory

Open the workbook in Tableau Desktop and document each data source:

| Data source | Connection type                       | Server/file   | Database  | Tables used  | Custom SQL? | Extract or Live? |
| ----------- | ------------------------------------- | ------------- | --------- | ------------ | ----------- | ---------------- |
| [Name]      | [SQL Server / Snowflake / CSV / etc.] | [Server name] | [DB name] | [Table list] | [Yes/No]    | [Extract/Live]   |

### 1.3 Calculated field inventory

Document every calculated field in the data source:

| Field name | Type                  | Formula           | Complexity                  | DAX approach                          |
| ---------- | --------------------- | ----------------- | --------------------------- | ------------------------------------- |
| [Name]     | [Dimension / Measure] | [Tableau formula] | [Simple / LOD / Table Calc] | [Measure / Calc Column / Power Query] |

### 1.4 Worksheet inventory

Document each worksheet in the workbook:

| Worksheet | Chart type          | Rows shelf | Columns shelf | Color   | Size    | Detail   | Filters  | Table calc? |
| --------- | ------------------- | ---------- | ------------- | ------- | ------- | -------- | -------- | ----------- |
| [Name]    | [Bar / Line / etc.] | [Fields]   | [Fields]      | [Field] | [Field] | [Fields] | [Fields] | [Yes/No]    |

### 1.5 Dashboard inventory

Document each dashboard:

| Dashboard | Worksheets included | Actions (filter/highlight/URL) | Parameters       | Device layouts? |
| --------- | ------------------- | ------------------------------ | ---------------- | --------------- |
| [Name]    | [List]              | [Action details]               | [Parameter list] | [Yes/No]        |

!!! tip "This step feels slow but saves time overall"
Skipping documentation leads to discovering missing calculated fields and broken filters at the end of the conversion when fixing them is expensive. Invest 30-60 minutes upfront.

---

## Step 2: Connect Power BI to the same data sources

### 2.1 Open Power BI Desktop

Launch Power BI Desktop. Save the file immediately as `[WorkbookName].pbix` in your working directory.

### 2.2 Connect to data sources

For each data source in your inventory:

1. **Home** → **Get Data** → select the appropriate connector
2. Enter server, database, and credentials
3. Select the same tables used by the Tableau workbook
4. If the Tableau workbook uses Custom SQL, decide:
    - **Preferred:** Create a dbt view or database view with the same logic, then connect to the view
    - **Alternative:** Use Power Query's "Advanced Editor" to enter a native SQL query

### 2.3 Apply source-level filters

If the Tableau workbook has data source filters (e.g., date range filters), apply equivalent filters in Power Query:

```m
// Example: Filter to last 3 years of data
= Table.SelectRows(Source, each [OrderDate] >= Date.AddYears(DateTime.LocalNow(), -3))
```

### 2.4 Light data shaping in Power Query

Perform only minimal shaping in Power Query:

- Rename columns to business-friendly names
- Set correct data types (dates, numbers, text)
- Remove unnecessary columns
- Handle null values if needed

!!! warning "Do not put business logic in Power Query"
Business calculations belong in DAX measures, not Power Query. Power Query should handle data connectivity and basic shaping only.

---

## Step 3: Build the semantic model (tables and relationships)

### 3.1 Design the star schema

Tableau is forgiving with flat, denormalized tables. Power BI performs best with a proper star schema.

1. **Identify fact tables** — tables with numeric measures (sales transactions, events, logs)
2. **Identify dimension tables** — tables with descriptive attributes (customers, products, dates, regions)
3. **Create relationships** — in Model view, drag primary keys from dimensions to foreign keys in fact tables

```
// Star schema example:
//
//   [DimDate] ----1:*---- [FactSales] ----*:1---- [DimProduct]
//                              |
//                         *:1
//                              |
//                         [DimCustomer]
```

### 3.2 Create a date table

If the Tableau workbook uses date calculations, create a dedicated date table:

```dax
// In Power BI Desktop: Modeling → New Table
Calendar =
ADDCOLUMNS(
    CALENDARAUTO(),
    "Year", YEAR([Date]),
    "Quarter", "Q" & FORMAT([Date], "Q"),
    "Month Number", MONTH([Date]),
    "Month Name", FORMAT([Date], "MMMM"),
    "Month Short", FORMAT([Date], "MMM"),
    "Week Number", WEEKNUM([Date]),
    "Day of Week", FORMAT([Date], "dddd"),
    "Year-Month", FORMAT([Date], "YYYY-MM")
)
```

Mark the Calendar table as a Date table: select the table → Table tools → Mark as date table → select the Date column.

### 3.3 Define relationships

In Model view:

1. Create 1:many relationships from dimension primary keys to fact foreign keys
2. Set cross-filter direction to **Single** (dimension filters fact) unless you have a specific reason for bi-directional
3. Ensure no circular or ambiguous relationships exist

### 3.4 Hide technical columns

Hide columns that end users should not see in reports:

- Foreign key columns (e.g., CustomerID in the fact table when CustomerName is in the dimension)
- Technical columns (ETL timestamps, hash keys)
- Columns used only in relationships

Right-click the column → **Hide in report view**.

---

## Step 4: Convert calculations to DAX

### 4.1 Triage the calculations

Using your calculated field inventory from Step 1, categorize each calculation:

| Category                                     | Approach                                     | Priority           |
| -------------------------------------------- | -------------------------------------------- | ------------------ |
| Simple aggregates (SUM, AVG, COUNT)          | DAX measure                                  | Do first           |
| Row-level calculations (math, string, date)  | DAX calculated column or Power Query         | Do second          |
| LOD expressions (FIXED, INCLUDE, EXCLUDE)    | DAX measure with CALCULATE                   | Do third (hardest) |
| Table calculations (RUNNING_SUM, RANK, etc.) | DAX measure with WINDOW or time intelligence | Do fourth          |
| Parameters                                   | What-If parameters or field parameters       | Do last            |

### 4.2 Create base measures

Start with the simplest measures. Every semantic model needs these:

```dax
Total Sales = SUM(Sales[Amount])
Total Quantity = SUM(Sales[Quantity])
Total Profit = SUM(Sales[Profit])
Order Count = COUNTROWS(Sales)
Customer Count = DISTINCTCOUNT(Sales[CustomerID])
Avg Order Value = DIVIDE([Total Sales], [Order Count])
Profit Margin = DIVIDE([Total Profit], [Total Sales])
```

### 4.3 Convert LOD expressions

Refer to [Calculation Conversion Reference](calculation-conversion.md) Section 1 for patterns. Key approach:

```dax
// Tableau: { FIXED [Customer ID] : SUM([Sales]) }
// DAX:
Customer Total Sales =
CALCULATE(
    SUM(Sales[Amount]),
    ALLEXCEPT(Sales, Sales[CustomerID])
)
```

### 4.4 Convert table calculations

Refer to [Calculation Conversion Reference](calculation-conversion.md) Section 2 for patterns.

### 4.5 Validate each measure

For every converted measure:

1. Create a temporary table visual in Power BI with the same dimensions as the Tableau worksheet
2. Compare the Power BI measure values against the Tableau calculated field values
3. Spot-check at multiple grain levels (grand total, by region, by month, by product)
4. Document any discrepancies and investigate

!!! warning "Validate measures before building visuals"
Building visuals on incorrect measures creates rework. Validate every measure in a matrix or table visual first, then build the charts.

---

## Step 5: Rebuild visualizations

### 5.1 Create report pages

For each Tableau dashboard, create a Power BI report page:

1. Name the page to match the Tableau dashboard name
2. Set page size if the Tableau dashboard uses a fixed size (File → Page setup)
3. Consider Power BI's default 16:9 canvas or match the Tableau pixel dimensions

### 5.2 Build visuals

For each Tableau worksheet on the dashboard:

1. Refer to [Visualization Migration](visualization-migration.md) for the chart type mapping
2. Insert the appropriate Power BI visual
3. Drag fields to the correct wells (Axis, Values, Legend, Tooltips)
4. Apply the validated DAX measures from Step 4

### 5.3 Configure interactions

By default, Power BI cross-filters all visuals on a page. To match Tableau behavior:

1. Select a visual
2. **Format** → **Edit interactions**
3. For each target visual, choose:
    - **Filter** (matches Tableau filter action)
    - **Highlight** (matches Tableau highlight action)
    - **None** (no interaction)

### 5.4 Add drillthrough pages

For Tableau "Go to Sheet" actions:

1. Create a detail page
2. Add a field to the **Drillthrough** well on the detail page
3. Users right-click a data point on the source page → Drillthrough → detail page

### 5.5 Add slicers

Convert Tableau quick filters to Power BI slicers:

| Tableau filter        | Power BI slicer               |
| --------------------- | ----------------------------- |
| Single value dropdown | Slicer → Dropdown mode        |
| Multi-value checkbox  | Slicer → List mode            |
| Date range            | Slicer → Between (date range) |
| Relative date         | Slicer → Relative date        |
| Search box            | Slicer → enable Search        |

---

## Step 6: Apply formatting and interactivity

### 6.1 Apply a theme

Create or apply a Power BI theme that matches your organization's branding:

- **View** → **Themes** → **Browse for themes** → select a JSON theme file
- Or customize the default theme in View → Themes → Customize current theme

### 6.2 Format individual visuals

For each visual:

- Set title text and formatting
- Configure data labels (position, font, format)
- Set axis labels and ranges
- Configure legend position
- Apply conditional formatting where the Tableau workbook uses color encoding

### 6.3 Add interactivity features

| Feature               | How to add                                                   |
| --------------------- | ------------------------------------------------------------ |
| Bookmarks             | View → Bookmarks → Add bookmark for filter states            |
| Buttons               | Insert → Button → configure action (bookmark, page nav, URL) |
| Page tooltips         | Create a tooltip-type page, assign to visuals                |
| Report page navigator | Insert → Navigator → Page navigator                          |

---

## Step 7: Configure row-level security

If the Tableau workbook uses user-based data filtering:

### 7.1 Create RLS roles

1. **Modeling** → **Manage Roles**
2. Create a new role (e.g., "RegionFilter")
3. Select the table to filter
4. Enter the DAX filter expression:

```dax
// If Tableau uses: [Region] = USERNAME()
// Power BI RLS:
[Region] = USERPRINCIPALNAME()

// If Tableau uses group-based security:
CONTAINS(
    SecurityMapping,
    SecurityMapping[UserEmail], USERPRINCIPALNAME(),
    SecurityMapping[Region], Sales[Region]
)
```

### 7.2 Test RLS

1. **Modeling** → **View as** → select role
2. Verify that the report shows only the filtered data
3. Test with multiple roles and user combinations

---

## Step 8: Publish and validate

### 8.1 Publish to Power BI Service

1. **Home** → **Publish**
2. Select the target workspace
3. Wait for the upload to complete

### 8.2 Configure in Power BI Service

After publishing:

1. Navigate to the workspace in Power BI Service
2. Configure dataset settings:
    - Data source credentials
    - Gateway connection (if on-prem sources)
    - Scheduled refresh
3. Assign RLS roles to users/groups:
    - Dataset → Security → add members to roles

### 8.3 Side-by-side validation

Open both the Tableau dashboard and the Power BI report side by side:

- [ ] Grand total measures match
- [ ] Measures match by Region (or primary dimension)
- [ ] Measures match by Date (monthly, quarterly, yearly)
- [ ] Filter interactions produce the same results
- [ ] Drill-down behavior is correct
- [ ] RLS filters data correctly for test users
- [ ] Subscriptions and alerts are configured
- [ ] Mobile layout is acceptable

### 8.4 Get user sign-off

Before decommissioning the Tableau workbook:

1. Share the Power BI report with the workbook owner
2. Ask them to validate against their known-good numbers
3. Address any discrepancies
4. Get formal sign-off

### 8.5 Update navigation

1. If using a Power BI App, add the report to the App
2. Update any bookmarks, links, or portal pages that reference the Tableau workbook
3. Add a redirect notice on the Tableau workbook: "This dashboard has moved to Power BI"

---

## Common issues during conversion

| Issue                          | Cause                                                | Solution                                                                 |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Numbers don't match            | Different aggregation grain or filter context        | Use a matrix visual to compare at multiple grains; check CALCULATE usage |
| Visual looks different         | Tableau mark-based vs Power BI field-based rendering | Accept the difference; focus on analytical equivalence, not pixel parity |
| Performance is slow            | Too many visuals or large Import dataset             | Reduce visual count; use Direct Lake or aggregation tables               |
| DAX error: circular dependency | Calculated column references a measure               | Separate calculated columns (static) from measures (dynamic)             |
| Missing chart type             | No native Power BI visual for this chart             | Check AppSource for custom visuals                                       |
| Filter behavior is wrong       | Default cross-filter vs Tableau actions              | Configure Edit Interactions for each visual                              |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Calculation Conversion](calculation-conversion.md) | [Visualization Migration](visualization-migration.md) | [Feature Mapping](feature-mapping-complete.md) | [Migration Playbook](../tableau-to-powerbi.md)
