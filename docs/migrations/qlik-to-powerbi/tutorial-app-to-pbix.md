---
title: "Tutorial: Qlik Sense App to Power BI Report"
description: "Step-by-step tutorial converting a Qlik Sense app to a Power BI report — data model analysis, star schema rebuild, expression conversion, visualization recreation, and publishing."
---

# Tutorial: Converting a Qlik Sense App to a Power BI Report

**Duration:** 4-5 hours (hands-on)
**Prerequisites:** Power BI Desktop installed, access to a Qlik Sense app, access to the underlying data sources
**Skill level:** Intermediate (Qlik experience required, Power BI basics helpful)

---

## Overview

This tutorial walks through the complete conversion of a Qlik Sense sales analytics app to a Power BI report. You will:

1. Analyze the Qlik app's data model and expressions
2. Redesign the data model as a star schema
3. Build the semantic model in Power BI Desktop
4. Convert Qlik expressions to DAX measures
5. Recreate visualizations in Power BI
6. Configure security and publish to Power BI Service

The tutorial uses a representative sales app with 5 tables, 15 expressions (including Set Analysis), 3 sheets with 20+ visualizations, and Section Access for row-level security.

---

## Step 1: Analyze the Qlik app

### 1.1 Export the data model

Open the Qlik app in Qlik Sense. Navigate to the data model viewer (from the navigation bar, select the data model icon).

Document the following for each table:

| Table name | Row count | Key fields                              | Source              |
| ---------- | --------- | --------------------------------------- | ------------------- |
| Sales      | 1,200,000 | OrderID, CustomerID, ProductID, DateNum | SQL Server DB       |
| Customers  | 50,000    | CustomerID, RegionID                    | SQL Server DB       |
| Products   | 5,000     | ProductID, CategoryID                   | Excel file          |
| Calendar   | 3,650     | DateNum, Date, Year, Month              | Generated in script |
| Regions    | 50        | RegionID, Region, Country               | Inline in script    |

Note any synthetic keys (Qlik shows a warning icon) and circular references (Qlik shows a red line).

### 1.2 Export all expressions

Open each sheet and document every expression used in every visualization:

| Sheet  | Object          | Expression                                 | Type           |
| ------ | --------------- | ------------------------------------------ | -------------- |
| Sheet1 | KPI - Revenue   | `Sum(Amount)`                              | Basic agg      |
| Sheet1 | KPI - Orders    | `Count(DISTINCT OrderID)`                  | Distinct count |
| Sheet1 | Bar - By Region | `Sum(Amount)` by Region                    | Basic agg      |
| Sheet1 | Line - Trend    | `Sum(Amount)` by YearMonth                 | Time series    |
| Sheet2 | KPI - YTD       | `Sum({<Year={$(=Year(Today()))}>} Amount)` | Set Analysis   |
| Sheet2 | Table - Detail  | Multiple columns, conditional coloring     | Table          |
| Sheet3 | Pivot - Matrix  | `Sum(Amount)`, `Avg(UnitPrice)`, rank      | Pivot + calc   |

Also document master items (master dimensions and master measures) as these represent the governed definitions.

### 1.3 Document Section Access

If the app uses Section Access, document the access rules:

```
Section Access;
LOAD * INLINE [
    ACCESS, USERID, REGION
    USER, DOMAIN\alice, East
    USER, DOMAIN\bob, West
    USER, DOMAIN\carol, *
    ADMIN, DOMAIN\admin, *
];
```

---

## Step 2: Design the star schema

### 2.1 Identify facts and dimensions

From the Qlik data model, classify each table:

| Qlik table | Star schema role | Reason                                       |
| ---------- | ---------------- | -------------------------------------------- |
| Sales      | **Fact table**   | Contains numeric measures (Amount, Quantity) |
| Customers  | Dimension        | Descriptive attributes for customers         |
| Products   | Dimension        | Descriptive attributes for products          |
| Calendar   | Dimension        | Date attributes for time intelligence        |
| Regions    | Dimension        | Geographic attributes                        |

### 2.2 Design the target schema

```
                    DimCalendar
                        |
                        | DateKey
                        |
DimCustomer -------- FactSales -------- DimProduct
    CustomerID           |             ProductID
                         |
                    DimRegion
                    (via Customer)
```

**Key decisions:**

- **Flatten Customer + Region:** In the Qlik model, Region is a separate table joined through Customer. In the star schema, either (a) add Region attributes directly to DimCustomer (denormalize) or (b) keep DimRegion as a separate snowflake dimension. Option (a) is simpler and recommended for most scenarios.
- **Calendar granularity:** Create a proper date dimension with all time intelligence columns (Year, Quarter, Month, MonthName, Week, DayOfWeek, FiscalYear, IsWeekend, etc.).
- **Surrogate keys:** Create DateKey (integer YYYYMMDD format) for the Calendar join. Keep natural keys (CustomerID, ProductID) if they are clean integers.

### 2.3 Data source strategy

For CSA-in-a-Box, the data sources should come from the Gold layer (Delta tables in OneLake), not from the original SQL Server / Excel sources:

| Qlik source        | CSA-in-a-Box Gold table    | Connection method |
| ------------------ | -------------------------- | ----------------- |
| SQL Server (Sales) | `gold.fact_sales`          | Direct Lake       |
| SQL Server (Cust)  | `gold.dim_customer`        | Direct Lake       |
| Excel (Products)   | `gold.dim_product`         | Direct Lake       |
| Script (Calendar)  | `gold.dim_calendar`        | Direct Lake       |
| Inline (Regions)   | Included in `dim_customer` | Direct Lake       |

If Gold tables do not exist yet, create them as dbt models in the CSA-in-a-Box Silver/Gold layers before building the Power BI report.

---

## Step 3: Build the semantic model

### 3.1 Connect to data

1. Open Power BI Desktop
2. Select Get Data > Microsoft Fabric Lakehouse (or the appropriate Gold layer connection)
3. Select the Gold tables: `fact_sales`, `dim_customer`, `dim_product`, `dim_calendar`
4. Choose DirectQuery mode if using Direct Lake; Import mode if data volume is small (< 1 GB)

### 3.2 Define relationships

In the Model view, create relationships:

| From (Fact)           | To (Dimension)          | Cardinality | Cross-filter | Active |
| --------------------- | ----------------------- | ----------- | ------------ | ------ |
| FactSales[CustomerID] | DimCustomer[CustomerID] | Many-to-One | Single       | Yes    |
| FactSales[ProductID]  | DimProduct[ProductID]   | Many-to-One | Single       | Yes    |
| FactSales[DateKey]    | DimCalendar[DateKey]    | Many-to-One | Single       | Yes    |

### 3.3 Hide technical columns

Hide foreign key columns in the fact table (CustomerID, ProductID, DateKey) since users should access these attributes through the dimension tables. In the Model view, right-click each column and select "Hide in report view."

### 3.4 Create a Date table

If not using a Gold layer calendar, create one with DAX:

```dax
DimCalendar =
VAR MinDate = MIN(FactSales[OrderDate])
VAR MaxDate = MAX(FactSales[OrderDate])
RETURN
ADDCOLUMNS(
    CALENDAR(MinDate, MaxDate),
    "Year", YEAR([Date]),
    "Quarter", "Q" & FORMAT([Date], "Q"),
    "Month", FORMAT([Date], "MMMM"),
    "MonthNumber", MONTH([Date]),
    "YearMonth", FORMAT([Date], "YYYY-MM"),
    "WeekDay", FORMAT([Date], "dddd"),
    "IsWeekend", IF(WEEKDAY([Date], 2) > 5, TRUE(), FALSE())
)
```

Mark the calendar as a date table: select the table > Modeling > Mark as Date Table > set the Date column.

---

## Step 4: Convert expressions to DAX

### 4.1 Basic measures

```dax
// Qlik: Sum(Amount)
Total Revenue = SUM(FactSales[Amount])

// Qlik: Count(DISTINCT OrderID)
Total Orders = DISTINCTCOUNT(FactSales[OrderID])

// Qlik: Avg(UnitPrice)
Avg Unit Price = AVERAGE(FactSales[UnitPrice])

// Qlik: Sum(Quantity)
Total Units = SUM(FactSales[Quantity])

// Qlik: Sum(Amount) / Count(DISTINCT OrderID)
Avg Order Value =
DIVIDE(
    [Total Revenue],
    [Total Orders],
    0
)
```

### 4.2 Set Analysis measures

```dax
// Qlik: Sum({<Year={$(=Year(Today()))}>} Amount)
YTD Revenue =
CALCULATE(
    [Total Revenue],
    DimCalendar[Year] = YEAR(TODAY()),
    DATESYTD(DimCalendar[Date])
)

// Qlik: Sum({<Year={$(=Year(Today())-1}>} Amount)
Prior Year Revenue =
CALCULATE(
    [Total Revenue],
    SAMEPERIODLASTYEAR(DimCalendar[Date])
)

// Qlik: Sum({<Region={'East'}>} Amount)
East Revenue =
CALCULATE(
    [Total Revenue],
    DimCustomer[Region] = "East"
)

// Qlik: Sum({<Year={2025}, Region=>} Amount)
Revenue 2025 All Regions =
CALCULATE(
    [Total Revenue],
    DimCalendar[Year] = 2025,
    ALL(DimCustomer[Region])
)
```

### 4.3 Calculated measures

```dax
// Qlik: (Sum(Amount) - Above(Sum(Amount))) / Above(Sum(Amount))
MoM Growth % =
VAR CurrentMonth = [Total Revenue]
VAR PriorMonth =
    CALCULATE(
        [Total Revenue],
        PREVIOUSMONTH(DimCalendar[Date])
    )
RETURN
DIVIDE(
    CurrentMonth - PriorMonth,
    PriorMonth,
    BLANK()
)

// Qlik: Rank(Aggr(Sum(Amount), CustomerID))
Customer Rank =
RANKX(
    ALL(DimCustomer[CustomerName]),
    [Total Revenue],
    ,
    DESC
)
```

### 4.4 Create all measures in the semantic model

Create a "Measures" display folder in the model to organize all DAX measures. Do not create measures in individual report visuals -- always define them in the semantic model so they are reusable across all reports.

---

## Step 5: Recreate visualizations

### 5.1 Sheet 1 -- Overview dashboard

**Qlik KPI objects to Power BI cards:**

1. Insert a Card visual for each KPI (Total Revenue, Total Orders, Avg Order Value)
2. Drag the corresponding measure to the Fields well
3. Format: set category label, display units (K, M), decimal places

**Qlik bar chart to Power BI bar chart:**

1. Insert a Clustered Bar Chart
2. Y-axis: `DimCustomer[Region]`
3. X-axis (values): `[Total Revenue]`
4. Format: add data labels, sort descending

**Qlik line chart to Power BI line chart:**

1. Insert a Line Chart
2. X-axis: `DimCalendar[YearMonth]`
3. Y-axis (values): `[Total Revenue]`
4. Add `[Prior Year Revenue]` as a second line for comparison
5. Format: add markers, trend line via Analytics pane

### 5.2 Sheet 2 -- YTD analysis

**Convert Set Analysis-driven KPIs:**

1. Insert Card visuals for YTD Revenue, Prior Year Revenue
2. Use the DAX measures created in Step 4.2
3. Add a Card with the MoM Growth % measure, formatted as percentage

**Convert straight table to Power BI table:**

1. Insert a Table visual
2. Add columns: Customer Name, Region, Total Revenue, Total Orders, Avg Order Value
3. Apply conditional formatting: right-click a column > Conditional Formatting > Background Color > Rules

### 5.3 Sheet 3 -- Product analysis

**Convert pivot table to Power BI matrix:**

1. Insert a Matrix visual
2. Rows: `DimProduct[Category]`, `DimProduct[ProductName]`
3. Columns: `DimCalendar[Year]`
4. Values: `[Total Revenue]`
5. Enable row subtotals, column subtotals
6. Enable expand/collapse (+/-) on row headers

### 5.4 Recreate filter panes as slicers

Replace Qlik filter panes with Power BI slicers:

1. Insert Slicer visuals for Region, Year, Product Category
2. Configure slicer type (List, Dropdown, or Range for dates)
3. Enable "Search" on slicers for long lists
4. Use Slicer Sync (View > Sync Slicers) to sync across pages

---

## Step 6: Configure security and publish

### 6.1 Implement row-level security

Convert the Qlik Section Access to Power BI RLS:

1. In Power BI Desktop, go to Modeling > Manage Roles
2. Create a role "RegionFilter"
3. Add a DAX filter on the DimCustomer table:

```dax
// RLS expression
[Region] = LOOKUPVALUE(
    SecurityMapping[Region],
    SecurityMapping[UserEmail],
    USERPRINCIPALNAME()
)
```

Note: You need a SecurityMapping table in your model with UserEmail and Region columns. Import this from a governed source (e.g., a Gold layer security table).

4. Test RLS: Modeling > View As > select a role and enter a test user email

### 6.2 Publish to Power BI Service

1. Save the .pbix file
2. File > Publish > select the target workspace
3. Open the report in Power BI Service
4. Go to the dataset settings and configure:
    - Data source credentials (if not using Direct Lake)
    - Refresh schedule (if using Import mode)
    - RLS role membership (assign Entra ID users/groups to roles)

### 6.3 Create a Power BI app (optional)

For end-user distribution:

1. In the workspace, select "Create App"
2. Add the report and any related paginated reports
3. Configure the navigation (tab order, page visibility)
4. Set audience (specific Entra ID groups)
5. Publish the app

---

## Step 7: Validate

### 7.1 Number comparison

Run the Qlik app and Power BI report side-by-side. Compare:

| Metric              | Qlik value  | Power BI value | Match? |
| ------------------- | ----------- | -------------- | ------ |
| Total Revenue       | $45,230,100 | $45,230,100    | Yes    |
| Total Orders        | 125,450     | 125,450        | Yes    |
| YTD Revenue         | $12,450,300 | $12,450,300    | Yes    |
| East Region Revenue | $15,100,200 | $15,100,200    | Yes    |
| Top Customer        | Acme Corp   | Acme Corp      | Yes    |

### 7.2 Filter validation

Apply the same filters in both tools and verify results:

1. Select Region = "West" -- compare all KPIs
2. Select Year = 2025 -- compare all KPIs
3. Select Region = "West" AND Year = 2025 -- compare all KPIs
4. Clear all and verify totals match unfiltered Qlik values

### 7.3 RLS validation

Log in as each test user and verify they see only their authorized data region.

---

## Summary

You have now completed a full Qlik Sense app to Power BI report migration:

1. Analyzed the Qlik data model and documented all expressions
2. Redesigned the associative model as a star schema
3. Built the semantic model in Power BI Desktop with Direct Lake
4. Converted all Qlik expressions (including Set Analysis) to DAX
5. Recreated all visualizations in Power BI
6. Configured RLS and published to Power BI Service

For the next app, the process will be faster -- the data model and expression conversion patterns established here are reusable across all apps that share the same data domain.

---

## Cross-references

| Topic                              | Document                                                             |
| ---------------------------------- | -------------------------------------------------------------------- |
| Expression conversion reference    | [Expression Migration](expression-migration.md)                      |
| Expression tutorial (15+ examples) | [Tutorial: Expression Conversion](tutorial-expression-conversion.md) |
| Data model migration concepts      | [Data Model Migration](data-model-migration.md)                      |
| Visualization mapping              | [Visualization Migration](visualization-migration.md)                |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
