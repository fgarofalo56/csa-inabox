# Tutorial: Migrate Tableau Data Model to Power BI Semantic Model

**A hands-on guide for migrating Tableau data source structure — relationships, calculated fields, data source filters, and hierarchies — to a Power BI star-schema semantic model with DAX measures.**

---

## Prerequisites

- Tableau Desktop installed (to inspect the source data model)
- Power BI Desktop installed (latest version)
- Access to the data sources used by the Tableau data model
- Familiarity with the [Calculation Conversion Reference](calculation-conversion.md)

**Estimated time:** 2-3 hours for a data model with 3-8 tables and 10-20 calculated fields.

---

## Why this tutorial exists

Tableau and Power BI approach data modeling differently. Tableau uses a dual-layer model (logical and physical) with automatic joins and allows wide, denormalized tables. Power BI uses an explicit star schema with manually defined relationships and a Vertipaq columnar engine optimized for dimensional modeling. Migrating the data model correctly is the single most important factor in a successful Power BI report conversion.

---

## Step 1: Analyze the Tableau data model

### 1.1 Open the data source in Tableau Desktop

Open the Tableau workbook or published data source. Navigate to the **Data Source** tab to see the physical layer (joins, unions, custom SQL).

### 1.2 Document the physical layer

Record every table and how they are joined:

| Left table | Join type | Right table | Join condition | Notes |
|---|---|---|---|---|
| Orders | Left Join | Customers | Orders.CustomerID = Customers.CustomerID | |
| Orders | Left Join | Products | Orders.ProductID = Products.ProductID | |
| Orders | Inner Join | OrderLines | Orders.OrderID = OrderLines.OrderID | Line-item detail |

### 1.3 Document the logical layer (Tableau 2020.2+)

If the workbook uses Tableau's logical layer (relationships instead of joins):

| Table 1 | Relationship | Table 2 | Related fields | Cardinality |
|---|---|---|---|---|
| Orders | relates to | Customers | Orders.CustomerID = Customers.CustomerID | Many-to-One |
| Orders | relates to | Products | Orders.ProductID = Products.ProductID | Many-to-One |
| Orders | relates to | Returns | Orders.OrderID = Returns.OrderID | One-to-One |

### 1.4 Document calculated fields

List every calculated field in the data source:

| Field name | Formula | Type | Scope | Migration target |
|---|---|---|---|---|
| Profit Ratio | `[Profit] / [Sales]` | Measure | Row-level calc | DAX measure |
| Customer Segment | `IF [Sales] > 1000 THEN "High" ELSE "Low" END` | Dimension | Row-level calc | Calculated column |
| Total Sales FIXED Region | `{ FIXED [Region] : SUM([Sales]) }` | LOD | Fixed aggregate | DAX measure with CALCULATE |
| Running Total | `RUNNING_SUM(SUM([Sales]))` | Table calc | Table across dates | DAX measure with WINDOW |
| First Purchase Date | `{ FIXED [Customer ID] : MIN([Order Date]) }` | LOD | Used as dimension | Calculated column |

### 1.5 Document data source filters

| Filter field | Condition | Purpose |
|---|---|---|
| Order Date | >= 2022-01-01 | Limit to recent data |
| Status | != "Cancelled" | Exclude cancelled orders |
| Is Test | = FALSE | Exclude test data |

### 1.6 Document hierarchies

| Hierarchy name | Levels | Table |
|---|---|---|
| Location | Country → State → City | Customers |
| Product | Category → Sub-Category → Product Name | Products |
| Time | Year → Quarter → Month → Day | Orders (date field) |

---

## Step 2: Design the Power BI star schema

### 2.1 Identify fact and dimension tables

The most important design decision is identifying which tables are facts (events, transactions with numeric measures) and which are dimensions (entities with descriptive attributes).

**Fact tables** (the center of the star):

- Contain numeric columns that are aggregated (SUM, AVG, COUNT)
- Have date and foreign key columns
- Typically the largest tables by row count
- Examples: Orders, OrderLines, Transactions, Events

**Dimension tables** (the points of the star):

- Contain descriptive attributes used for filtering and grouping
- Have a primary key that relates to the fact table
- Typically smaller tables by row count
- Examples: Customers, Products, Dates, Regions, Employees

### 2.2 Common Tableau-to-Power BI modeling patterns

| Tableau pattern | Power BI pattern | Migration action |
|---|---|---|
| Single denormalized table | Split into fact + dimensions | Normalize the table in Power Query or at the source |
| Multi-table join in data source | Star schema with relationships | Define explicit relationships in Model view |
| Logical layer relationships | Model relationships | Map 1:1 (Tableau relationships are similar to PBI relationships) |
| Data blending | Composite model or consolidated model | Merge sources in the data layer, not the BI layer |
| Custom SQL with joins | dbt view or Power Query merge | Prefer dbt views for complex joins |
| Wide table with many columns | Fact + dimension split | Improves compression and performance |

### 2.3 Draw the star schema

Before building, sketch the target model:

```
                    [DimDate]
                        |
                       1:*
                        |
[DimCustomer] --*:1-- [FactOrders] --1:*-- [FactOrderLines]
                        |
                       *:1
                        |
                    [DimProduct]
                        |
                       *:1
                        |
                    [DimCategory]
```

---

## Step 3: Build the semantic model in Power BI

### 3.1 Connect to data sources

In Power BI Desktop:

1. **Home** → **Get Data** → select the appropriate connector
2. Connect to the same source databases/files as the Tableau data source
3. Select the tables identified in your star schema design

### 3.2 Shape tables in Power Query

For each table, apply minimal shaping:

```m
// Example: DimCustomer
let
    Source = Sql.Database("server", "database"),
    Customers = Source{[Schema="dbo", Item="Customers"]}[Data],
    RenamedColumns = Table.RenameColumns(Customers, {
        {"cust_id", "CustomerID"},
        {"cust_name", "CustomerName"},
        {"cust_segment", "Segment"}
    }),
    SetTypes = Table.TransformColumnTypes(RenamedColumns, {
        {"CustomerID", Int64.Type},
        {"CustomerName", type text},
        {"Segment", type text}
    }),
    RemovedUnneeded = Table.RemoveColumns(SetTypes, {"internal_flag", "etl_timestamp"})
in
    RemovedUnneeded
```

### 3.3 Apply data source filters

Migrate Tableau data source filters to Power Query:

```m
// Tableau filter: Order Date >= 2022-01-01
= Table.SelectRows(Source, each [OrderDate] >= #date(2022, 1, 1))

// Tableau filter: Status != "Cancelled"
= Table.SelectRows(Source, each [Status] <> "Cancelled")

// Tableau filter: Is Test = FALSE
= Table.SelectRows(Source, each [IsTest] = false)
```

### 3.4 Create the date table

```dax
Calendar =
ADDCOLUMNS(
    CALENDARAUTO(),
    "Year", YEAR([Date]),
    "Quarter Number", QUARTER([Date]),
    "Quarter", "Q" & FORMAT([Date], "Q") & " " & FORMAT([Date], "YYYY"),
    "Month Number", MONTH([Date]),
    "Month Name", FORMAT([Date], "MMMM"),
    "Month Short", FORMAT([Date], "MMM"),
    "Year-Month", FORMAT([Date], "YYYY-MM"),
    "Week Number", WEEKNUM([Date]),
    "Day of Week", FORMAT([Date], "dddd"),
    "Day of Week Number", WEEKDAY([Date]),
    "Is Weekend", IF(WEEKDAY([Date]) IN {1, 7}, TRUE(), FALSE())
)
```

Mark as date table: Select Calendar table → **Table tools** → **Mark as date table** → select Date column.

### 3.5 Create relationships

In **Model view**:

1. Drag `Calendar[Date]` to `FactOrders[OrderDate]` (1:Many)
2. Drag `DimCustomer[CustomerID]` to `FactOrders[CustomerID]` (1:Many)
3. Drag `DimProduct[ProductID]` to `FactOrders[ProductID]` (1:Many)

For each relationship:

- Set cardinality (1:Many is most common)
- Set cross-filter direction to **Single** (dimension → fact)
- Ensure "Make this relationship active" is checked

### 3.6 Create hierarchies

Recreate Tableau hierarchies in Power BI:

1. In the Fields pane, drag child fields onto parent fields within the same table
2. Or: right-click a field → **New hierarchy** → drag additional fields into it

| Tableau hierarchy | Power BI hierarchy |
|---|---|
| Location: Country → State → City | DimCustomer: Country → State → City |
| Product: Category → Sub-Category → Product Name | DimProduct: Category → SubCategory → ProductName |
| Time: Year → Quarter → Month → Day | Calendar: Year → Quarter → Month Name → Date |

---

## Step 4: Convert calculated fields to DAX

### 4.1 Simple row-level calculations → calculated columns

```dax
// Tableau: [Profit Ratio] = [Profit] / [Sales]
// Power BI: Calculated column on FactOrders table
Profit Ratio = DIVIDE(FactOrders[Profit], FactOrders[Sales])
```

!!! note "Use measures instead of calculated columns when possible"
    Calculated columns consume memory for every row. If the calculation is only used in aggregation (e.g., always summed or averaged), create it as a measure instead.

### 4.2 Aggregate calculations → measures

```dax
// Base measures
Total Sales = SUM(FactOrders[Sales])
Total Profit = SUM(FactOrders[Profit])
Total Quantity = SUM(FactOrders[Quantity])
Order Count = COUNTROWS(FactOrders)
Customer Count = DISTINCTCOUNT(FactOrders[CustomerID])

// Derived measures
Profit Margin = DIVIDE([Total Profit], [Total Sales])
Avg Order Value = DIVIDE([Total Sales], [Order Count])
Sales per Customer = DIVIDE([Total Sales], [Customer Count])
```

### 4.3 LOD expressions → CALCULATE measures

```dax
// Tableau: { FIXED [Region] : SUM([Sales]) }
Region Total Sales =
CALCULATE(
    [Total Sales],
    ALLEXCEPT(FactOrders, DimCustomer[Region])
)

// Tableau: { FIXED [Customer ID] : MIN([Order Date]) }
// As calculated column (used as dimension):
First Purchase Date =
CALCULATE(
    MIN(FactOrders[OrderDate]),
    ALLEXCEPT(FactOrders, FactOrders[CustomerID])
)
```

### 4.4 Conditional / bucketing → calculated columns

```dax
// Tableau: IF [Sales] > 1000 THEN "High" ELSE "Low" END
Customer Segment =
IF(FactOrders[Sales] > 1000, "High Value", "Standard")

// Tableau: More complex bucketing
Sales Tier =
SWITCH(
    TRUE(),
    FactOrders[Sales] >= 5000, "Enterprise",
    FactOrders[Sales] >= 1000, "Mid-Market",
    FactOrders[Sales] >= 100, "SMB",
    "Micro"
)
```

### 4.5 Time intelligence measures

```dax
// Year-over-year comparison
Prior Year Sales =
CALCULATE([Total Sales], SAMEPERIODLASTYEAR(Calendar[Date]))

YoY Growth =
DIVIDE([Total Sales] - [Prior Year Sales], [Prior Year Sales])

// Year-to-date
YTD Sales = TOTALYTD([Total Sales], Calendar[Date])

// Month-over-month
Prior Month Sales =
CALCULATE([Total Sales], PREVIOUSMONTH(Calendar[Date]))

MoM Change =
DIVIDE([Total Sales] - [Prior Month Sales], [Prior Month Sales])
```

### 4.6 Organize measures in display folders

Create a measures table to organize calculations:

1. Right-click in the Fields pane → **New measure table** (or create measures on the fact table)
2. Group related measures using Display Folders:
   - Right-click measure → **Properties** → **Display folder**
   - Example folders: "Sales Metrics", "Profitability", "Time Intelligence", "Customer Metrics"

---

## Step 5: Validate the semantic model

### 5.1 Create validation visuals

Create a temporary report page with matrix visuals that compare key measures across dimensions:

| Validation check | Visual configuration | Expected result |
|---|---|---|
| Grand totals | Card visuals for each base measure | Match Tableau grand totals |
| By region | Matrix: Region rows, measure columns | Match Tableau region breakdown |
| By month | Matrix: Month rows, measure columns | Match Tableau monthly totals |
| By product category | Matrix: Category rows, measure columns | Match Tableau category breakdown |
| Cross-tab (region x month) | Matrix: Region rows, Month columns, measure values | Match Tableau cross-tab |

### 5.2 Investigate discrepancies

Common causes of number mismatches:

| Symptom | Likely cause | Fix |
|---|---|---|
| Power BI total is higher | Missing filter (data source filter not migrated) | Add filter in Power Query |
| Power BI total is lower | Join type mismatch (inner vs left) | Check relationship type in Model view |
| Percentages differ | Different denominator scope | Check CALCULATE/ALL patterns vs Tableau context |
| Counts differ | Duplicate rows or different distinct count logic | Verify grain of the fact table |
| Dates off by one | Timezone or date boundary difference | Align date truncation in Power Query |

### 5.3 Performance check

Before publishing, check model performance:

1. **File** → **Options** → **Diagnostics** → **Enable tracing**
2. Review model size (File → Info → file size)
3. Ensure no unnecessary columns are loaded (remove in Power Query)
4. Check that relationships are correct (Model view → no warnings)

---

## Step 6: Publish and share

### 6.1 Publish the semantic model

1. **Home** → **Publish** → select the target workspace
2. If separating model from reports: publish the semantic model alone (delete all report pages, publish, then restore pages and publish as a separate report connected via live connection)

### 6.2 Certify the model

In Power BI Service:

1. Navigate to the semantic model in the workspace
2. **Settings** → **Endorsement** → **Certified**
3. Add a description and documentation link

### 6.3 Grant Build permission

For users who need to create reports on this semantic model:

1. Navigate to the semantic model
2. **Settings** → **Manage permissions** → **Build** → add users/groups

---

## Key differences to internalize

| Concept | Tableau data model | Power BI semantic model |
|---|---|---|
| **Schema design** | Flexible; flat tables work fine | Star schema required for optimal performance |
| **Joins** | Physical layer (eager joins) or logical layer (lazy joins) | Relationships (always lazy; joined at query time) |
| **Calculated fields** | Single concept: calculated field | Two concepts: measures (dynamic) and calculated columns (static) |
| **Aggregation** | Automatic based on field placement | Explicit: measures use aggregate functions, columns are pre-computed |
| **Filter context** | Implicit from the visualization | Explicit and modifiable with CALCULATE |
| **Reuse** | Published data source | Shared semantic model with Certified endorsement |
| **Version control** | Manual .tds export | Fabric Git integration (TMDL format) |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Calculation Conversion](calculation-conversion.md) | [Tutorial: Workbook to PBIX](tutorial-workbook-to-pbix.md) | [Data Source Migration](data-source-migration.md) | [Migration Playbook](../tableau-to-powerbi.md)
