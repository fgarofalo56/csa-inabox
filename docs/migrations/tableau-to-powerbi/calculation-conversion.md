# Calculation Conversion Reference: Tableau to DAX

**A deep-dive reference for converting Tableau calculated fields, LOD expressions, table calculations, and functions to DAX equivalents in Power BI.**

---

## How to use this reference

This document provides 30+ conversion patterns organized by category. Each pattern shows the Tableau calculation on the left and the DAX equivalent on the right, with an explanation of the conceptual differences. For a hands-on workshop format, see [Tutorial: Calculation Conversion](tutorial-calc-conversion.md).

!!! warning "Do not translate line-by-line"
LOD expressions and DAX operate on fundamentally different paradigms. LOD expressions manipulate the level of detail relative to the visualization. DAX operates on filter context. Learn the DAX paradigm first, then map concepts — do not attempt mechanical syntax translation.

---

## 1. LOD expressions to DAX

### 1.1 FIXED — Aggregate at a fixed grain

FIXED ignores the visualization's level of detail and computes at the specified dimension(s).

**Pattern 1: FIXED with one dimension**

```
// Tableau
{ FIXED [Region] : SUM([Sales]) }
```

```dax
// DAX measure
Region Sales =
CALCULATE(
    SUM(Sales[Amount]),
    ALLEXCEPT(Sales, Sales[Region])
)
```

**Explanation:** `ALLEXCEPT` removes all filters from the Sales table except the Region column, effectively fixing the grain at Region regardless of what other dimensions are in the visual.

**Pattern 2: FIXED with multiple dimensions**

```
// Tableau
{ FIXED [Region], [Category] : SUM([Sales]) }
```

```dax
// DAX measure
Region Category Sales =
CALCULATE(
    SUM(Sales[Amount]),
    ALLEXCEPT(Sales, Sales[Region], Sales[Category])
)
```

**Pattern 3: FIXED at grand total (no dimensions)**

```
// Tableau
{ FIXED : SUM([Sales]) }
```

```dax
// DAX measure
Grand Total Sales =
CALCULATE(
    SUM(Sales[Amount]),
    ALL(Sales)
)
```

**Explanation:** `ALL(Sales)` removes all filters from the Sales table, returning the grand total regardless of any slicer or visual filter.

**Pattern 4: FIXED with MIN/MAX**

```
// Tableau — First purchase date per customer
{ FIXED [Customer ID] : MIN([Order Date]) }
```

```dax
// DAX calculated column (on Sales table)
First Purchase Date =
CALCULATE(
    MIN(Sales[OrderDate]),
    ALLEXCEPT(Sales, Sales[CustomerID])
)
```

!!! tip "Calculated column vs measure"
When a FIXED LOD is used as a dimension (e.g., to filter or group by first purchase date), create it as a calculated column. When it is used as a value to aggregate, create it as a measure. This distinction does not exist in Tableau but is critical in DAX.

**Pattern 5: FIXED for customer lifetime value ranking**

```
// Tableau
// Step 1: { FIXED [Customer ID] : SUM([Sales]) }
// Step 2: RANK on the FIXED field
```

```dax
// DAX
Customer Lifetime Value =
CALCULATE(
    SUM(Sales[Amount]),
    ALLEXCEPT(Sales, Sales[CustomerID])
)

Customer Rank =
RANKX(
    ALL(Sales[CustomerID]),
    [Customer Lifetime Value],
    ,
    DESC
)
```

### 1.2 INCLUDE — Add a dimension to the grain

INCLUDE computes at the visualization's grain plus an additional dimension.

**Pattern 6: INCLUDE with AVG**

```
// Tableau — Average price including Product, even if Product is not in the viz
{ INCLUDE [Product] : AVG([Price]) }
```

```dax
// DAX measure
Avg Price Including Product =
AVERAGEX(
    VALUES(Products[Product]),
    CALCULATE(AVERAGE(Sales[Price]))
)
```

**Explanation:** `VALUES(Products[Product])` iterates over each product in the current filter context. `AVERAGEX` computes the average of each product's average price, effectively including the Product dimension.

**Pattern 7: INCLUDE with COUNT DISTINCT**

```
// Tableau
{ INCLUDE [Order ID] : COUNTD([Product]) }
```

```dax
// DAX measure
Products Per Order =
AVERAGEX(
    VALUES(Sales[OrderID]),
    CALCULATE(DISTINCTCOUNT(Sales[ProductID]))
)
```

### 1.3 EXCLUDE — Remove a dimension from the grain

EXCLUDE computes at the visualization's grain minus a specified dimension.

**Pattern 8: EXCLUDE a time dimension**

```
// Tableau — Total sales excluding month (annual total in a monthly viz)
{ EXCLUDE [Month] : SUM([Sales]) }
```

```dax
// DAX measure
Annual Sales =
CALCULATE(
    SUM(Sales[Amount]),
    ALL(Calendar[Month])
)
```

**Explanation:** `ALL(Calendar[Month])` removes the Month filter, so the measure returns the annual total even when the visual is sliced by month.

**Pattern 9: EXCLUDE for percent of parent**

```
// Tableau — Percent of category total (exclude subcategory)
SUM([Sales]) / { EXCLUDE [Sub-Category] : SUM([Sales]) }
```

```dax
// DAX measure
Pct of Category =
DIVIDE(
    SUM(Sales[Amount]),
    CALCULATE(
        SUM(Sales[Amount]),
        ALL(Products[SubCategory])
    )
)
```

---

## 2. Table calculations to DAX

### 2.1 Running totals

**Pattern 10: RUNNING_SUM**

```
// Tableau
RUNNING_SUM(SUM([Sales]))
// Compute using: Table (across dates)
```

```dax
// DAX measure (using WINDOW function — DAX 2023+)
Running Total =
CALCULATE(
    SUM(Sales[Amount]),
    WINDOW(1, ABS, 0, REL, ORDERBY(Calendar[Date]))
)

// Alternative (pre-2023 DAX)
Running Total Alt =
CALCULATE(
    SUM(Sales[Amount]),
    FILTER(
        ALL(Calendar),
        Calendar[Date] <= MAX(Calendar[Date])
    )
)
```

### 2.2 Previous value / period comparison

**Pattern 11: LOOKUP(-1) — Previous period**

```
// Tableau
LOOKUP(SUM([Sales]), -1)
```

```dax
// DAX measure (monthly grain)
Previous Month Sales =
CALCULATE(
    SUM(Sales[Amount]),
    PREVIOUSMONTH(Calendar[Date])
)

// DAX measure (year-over-year)
Previous Year Sales =
CALCULATE(
    SUM(Sales[Amount]),
    SAMEPERIODLASTYEAR(Calendar[Date])
)
```

**Pattern 12: PERCENT_DIFFERENCE — Period-over-period change**

```
// Tableau
(ZN(SUM([Sales])) - ZN(LOOKUP(SUM([Sales]), -1))) / ABS(ZN(LOOKUP(SUM([Sales]), -1)))
```

```dax
// DAX measure
MoM Change % =
VAR CurrentSales = SUM(Sales[Amount])
VAR PrevSales = CALCULATE(SUM(Sales[Amount]), PREVIOUSMONTH(Calendar[Date]))
RETURN
    DIVIDE(CurrentSales - PrevSales, PrevSales)
```

### 2.3 Moving averages and windows

**Pattern 13: WINDOW_AVG — 3-period moving average**

```
// Tableau
WINDOW_AVG(SUM([Sales]), -2, 0)
```

```dax
// DAX measure (using WINDOW — DAX 2023+)
Moving Avg 3M =
AVERAGEX(
    WINDOW(-2, REL, 0, REL, ORDERBY(Calendar[MonthNum])),
    [Total Sales]
)

// Alternative (pre-2023)
Moving Avg 3M Alt =
AVERAGEX(
    DATESINPERIOD(Calendar[Date], MAX(Calendar[Date]), -3, MONTH),
    [Total Sales]
)
```

**Pattern 14: WINDOW_SUM — Rolling sum**

```
// Tableau
WINDOW_SUM(SUM([Sales]), -11, 0)  // Rolling 12 months
```

```dax
// DAX measure
Rolling 12M Sales =
CALCULATE(
    SUM(Sales[Amount]),
    DATESINPERIOD(Calendar[Date], MAX(Calendar[Date]), -12, MONTH)
)
```

### 2.4 Ranking

**Pattern 15: RANK**

```
// Tableau
RANK(SUM([Sales]))
```

```dax
// DAX measure
Sales Rank =
RANKX(
    ALL(Products[Category]),
    [Total Sales],
    ,
    DESC,
    DENSE
)
```

**Pattern 16: RANK_UNIQUE**

```
// Tableau
RANK_UNIQUE(SUM([Sales]))
```

```dax
// DAX measure
Sales Rank Unique =
RANKX(
    ALL(Products[Category]),
    [Total Sales],
    ,
    DESC,
    SKIP
)
```

### 2.5 Row number / Index

**Pattern 17: INDEX()**

```
// Tableau
INDEX()
```

```dax
// DAX measure (DAX 2023+)
Row Number =
INDEX(1, ORDERBY(Calendar[Date], ASC))

// Alternative
Row Number Alt =
RANKX(
    ALLSELECTED(Calendar[Date]),
    Calendar[Date],
    ,
    ASC
)
```

### 2.6 Percent of total

**Pattern 18: Percent of total table calculation**

```
// Tableau
SUM([Sales]) / TOTAL(SUM([Sales]))
```

```dax
// DAX measure
Pct of Total =
DIVIDE(
    SUM(Sales[Amount]),
    CALCULATE(SUM(Sales[Amount]), ALL(Products[Category]))
)

// Or for percent of grand total
Pct of Grand Total =
DIVIDE(
    SUM(Sales[Amount]),
    CALCULATE(SUM(Sales[Amount]), ALL(Sales))
)
```

---

## 3. String functions

| #   | Tableau function                    | DAX equivalent                                    | Example                         |
| --- | ----------------------------------- | ------------------------------------------------- | ------------------------------- |
| 19  | `LEFT([Name], 3)`                   | `LEFT(Table[Name], 3)`                            | First 3 characters              |
| 20  | `RIGHT([Name], 3)`                  | `RIGHT(Table[Name], 3)`                           | Last 3 characters               |
| 21  | `MID([Name], 2, 5)`                 | `MID(Table[Name], 2, 5)`                          | Substring                       |
| 22  | `LEN([Name])`                       | `LEN(Table[Name])`                                | Length                          |
| 23  | `UPPER([Name])`                     | `UPPER(Table[Name])`                              | Uppercase                       |
| 24  | `LOWER([Name])`                     | `LOWER(Table[Name])`                              | Lowercase                       |
| 25  | `TRIM([Name])`                      | `TRIM(Table[Name])`                               | Remove whitespace               |
| 26  | `CONTAINS([Name], "abc")`           | `CONTAINSSTRING(Table[Name], "abc")`              | Substring search                |
| 27  | `REPLACE([Name], "old", "new")`     | `SUBSTITUTE(Table[Name], "old", "new")`           | Replace text                    |
| 28  | `SPLIT([Name], "-", 1)`             | `PATHITEM(SUBSTITUTE(Table[Name], "-", "\|"), 1)` | Split by delimiter (workaround) |
| 29  | `REGEXP_MATCH([Email], ".*@(.*)$")` | No native regex; use Power Query or Python        | DAX has no regex support        |

!!! note "String functions are mostly 1:1"
Most string functions have direct DAX equivalents with the same name and parameters. The notable exceptions are `SPLIT` (which requires a workaround in DAX) and `REGEXP_MATCH` (which has no DAX equivalent — handle in Power Query M).

---

## 4. Date and time functions

| #   | Tableau function                  | DAX equivalent                            | Notes                           |
| --- | --------------------------------- | ----------------------------------------- | ------------------------------- |
| 30  | `DATEPART('year', [Date])`        | `YEAR(Table[Date])`                       | Extract year                    |
| 31  | `DATEPART('month', [Date])`       | `MONTH(Table[Date])`                      | Extract month                   |
| 32  | `DATEPART('day', [Date])`         | `DAY(Table[Date])`                        | Extract day                     |
| 33  | `DATEPART('quarter', [Date])`     | `QUARTER(Table[Date])`                    | Extract quarter                 |
| 34  | `DATEPART('week', [Date])`        | `WEEKNUM(Table[Date])`                    | Week number                     |
| 35  | `DATEDIFF('day', [Start], [End])` | `DATEDIFF(Table[Start], Table[End], DAY)` | Date difference                 |
| 36  | `DATEADD('month', 3, [Date])`     | `EDATE(Table[Date], 3)`                   | Add months                      |
| 37  | `DATENAME('month', [Date])`       | `FORMAT(Table[Date], "MMMM")`             | Month name                      |
| 38  | `TODAY()`                         | `TODAY()`                                 | Current date                    |
| 39  | `NOW()`                           | `NOW()`                                   | Current date/time               |
| 40  | `MAKEDATE(2024, 1, 15)`           | `DATE(2024, 1, 15)`                       | Construct date                  |
| 41  | `ISDATE([Field])`                 | No direct equivalent                      | Check in Power Query with `try` |

### DAX time intelligence functions (no Tableau equivalent)

DAX provides built-in time intelligence that has no direct Tableau equivalent:

```dax
// Year-to-date
YTD Sales = TOTALYTD(SUM(Sales[Amount]), Calendar[Date])

// Quarter-to-date
QTD Sales = TOTALQTD(SUM(Sales[Amount]), Calendar[Date])

// Month-to-date
MTD Sales = TOTALMTD(SUM(Sales[Amount]), Calendar[Date])

// Same period last year
SPLY Sales = CALCULATE(SUM(Sales[Amount]), SAMEPERIODLASTYEAR(Calendar[Date]))

// Year-over-year growth
YoY Growth =
VAR CurrentYear = SUM(Sales[Amount])
VAR PriorYear = CALCULATE(SUM(Sales[Amount]), SAMEPERIODLASTYEAR(Calendar[Date]))
RETURN DIVIDE(CurrentYear - PriorYear, PriorYear)
```

!!! tip "Time intelligence is a Power BI strength"
DAX time intelligence functions (TOTALYTD, SAMEPERIODLASTYEAR, PREVIOUSMONTH, etc.) are more elegant than the equivalent Tableau table calculations. A properly modeled date table in Power BI unlocks these functions automatically. Build your date table first.

---

## 5. Logical functions

| #   | Tableau function                               | DAX equivalent                                                        | Notes                 |
| --- | ---------------------------------------------- | --------------------------------------------------------------------- | --------------------- |
| 42  | `IF [Sales] > 1000 THEN "High" ELSE "Low" END` | `IF(Sales[Amount] > 1000, "High", "Low")`                             | Simple conditional    |
| 43  | `IIF([Sales] > 1000, "High", "Low")`           | `IF(Sales[Amount] > 1000, "High", "Low")`                             | Inline IF             |
| 44  | `CASE [Region] WHEN "East" THEN 1 ... END`     | `SWITCH(Sales[Region], "East", 1, "West", 2, 0)`                      | Multi-way conditional |
| 45  | `IFNULL([Sales], 0)`                           | `COALESCE(Sales[Amount], 0)`                                          | Null replacement      |
| 46  | `ZN([Sales])`                                  | `Sales[Amount] + 0` or `IF(ISBLANK(Sales[Amount]), 0, Sales[Amount])` | Zero for null         |
| 47  | `ISNULL([Field])`                              | `ISBLANK(Table[Field])`                                               | Null check            |
| 48  | `[Sales] > 0 AND [Profit] > 0`                 | `Sales[Amount] > 0 && Sales[Profit] > 0`                              | Logical AND           |
| 49  | `[Sales] > 0 OR [Profit] > 0`                  | `Sales[Amount] > 0 \|\| Sales[Profit] > 0`                            | Logical OR            |
| 50  | `NOT [IsReturned]`                             | `NOT(Sales[IsReturned])`                                              | Logical NOT           |

---

## 6. Aggregate functions

| #   | Tableau function            | DAX equivalent                                | Notes                       |
| --- | --------------------------- | --------------------------------------------- | --------------------------- |
| 51  | `SUM([Sales])`              | `SUM(Sales[Amount])`                          | Sum                         |
| 52  | `AVG([Sales])`              | `AVERAGE(Sales[Amount])`                      | Average                     |
| 53  | `MIN([Sales])`              | `MIN(Sales[Amount])`                          | Minimum                     |
| 54  | `MAX([Sales])`              | `MAX(Sales[Amount])`                          | Maximum                     |
| 55  | `COUNT([Sales])`            | `COUNT(Sales[Amount])`                        | Count non-blank             |
| 56  | `COUNTD([Customer])`        | `DISTINCTCOUNT(Sales[CustomerID])`            | Distinct count              |
| 57  | `MEDIAN([Sales])`           | `MEDIAN(Sales[Amount])`                       | Median                      |
| 58  | `PERCENTILE([Sales], 0.95)` | `PERCENTILEX.INC(Sales, Sales[Amount], 0.95)` | Percentile                  |
| 59  | `STDEV([Sales])`            | `STDEV.S(Sales[Amount])`                      | Standard deviation (sample) |
| 60  | `ATTR([Region])`            | `SELECTEDVALUE(Sales[Region], "Multiple")`    | Attribute (single value)    |

---

## 7. Type conversion

| #   | Tableau function         | DAX equivalent                                          | Notes              |
| --- | ------------------------ | ------------------------------------------------------- | ------------------ |
| 61  | `INT([Sales])`           | `INT(Sales[Amount])`                                    | Convert to integer |
| 62  | `FLOAT([Quantity])`      | `CONVERT(Sales[Quantity], DOUBLE)`                      | Convert to decimal |
| 63  | `STR([Sales])`           | `FORMAT(Sales[Amount], "#,##0.00")`                     | Convert to string  |
| 64  | `DATE(STR([DateField]))` | `DATEVALUE(Table[DateString])`                          | String to date     |
| 65  | `DATETIME([DateStr])`    | `DATEVALUE(Table[DateStr]) + TIMEVALUE(Table[TimeStr])` | String to datetime |

---

## 8. Advanced patterns

### Pattern 26: Nested LOD (LOD inside another LOD)

```
// Tableau — Average of customer totals
AVG({ FIXED [Customer ID] : SUM([Sales]) })
```

```dax
// DAX measure
Avg Customer Total =
AVERAGEX(
    VALUES(Sales[CustomerID]),
    CALCULATE(SUM(Sales[Amount]))
)
```

### Pattern 27: Conditional LOD

```
// Tableau — Sum of sales only for first-time customers
{ FIXED [Customer ID] : MIN([Order Date]) } = [Order Date]
// Then SUM([Sales]) filtered to TRUE
```

```dax
// DAX measure
First Purchase Sales =
CALCULATE(
    SUM(Sales[Amount]),
    FILTER(
        Sales,
        Sales[OrderDate] = CALCULATE(
            MIN(Sales[OrderDate]),
            ALLEXCEPT(Sales, Sales[CustomerID])
        )
    )
)
```

### Pattern 28: Table calculation with FIXED anchor

```
// Tableau — Percent of first period
SUM([Sales]) / LOOKUP(SUM([Sales]), FIRST())
```

```dax
// DAX measure
Pct of First Period =
VAR FirstDate = CALCULATE(MIN(Calendar[Date]), ALL(Calendar))
VAR FirstPeriodSales = CALCULATE(SUM(Sales[Amount]), Calendar[Date] = FirstDate)
RETURN DIVIDE(SUM(Sales[Amount]), FirstPeriodSales)
```

### Pattern 29: Cohort analysis with LOD

```
// Tableau
// Cohort = { FIXED [Customer ID] : MIN(DATETRUNC('month', [Order Date])) }
// Then use Cohort as a dimension
```

```dax
// DAX calculated column (on Customer table or Sales table)
Cohort Month =
CALCULATE(
    MIN(Sales[OrderDate]),
    ALLEXCEPT(Sales, Sales[CustomerID])
)
// Then: FORMAT([Cohort Month], "YYYY-MM")
```

### Pattern 30: Dynamic Top N with parameter

```
// Tableau
// Parameter: Top N (integer, range 5-50)
// Set: Top N Customers by Sales
// Filter to IN the set
```

```dax
// DAX (with What-If parameter "TopNValue" range 5-50)
In Top N =
IF(
    RANKX(
        ALL(Customers[CustomerName]),
        [Total Sales],
        ,
        DESC
    ) <= SELECTEDVALUE('TopNValue'[TopNValue Value]),
    1,
    0
)
// Apply as visual-level filter: In Top N = 1
```

---

## 9. Key conceptual differences

| Concept                         | Tableau                                            | DAX / Power BI                                          |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| **Evaluation model**            | Row-level or aggregate depending on context        | Always explicit: measures vs calculated columns         |
| **Grain control**               | LOD expressions (FIXED, INCLUDE, EXCLUDE)          | CALCULATE with ALL / ALLEXCEPT / filter modifiers       |
| **Table calculations**          | Compute on visual results (post-aggregate)         | Measures compute in filter context (pre-visual)         |
| **Direction of computation**    | Table across, table down, pane, cell               | ORDERBY in WINDOW functions; no "direction" concept     |
| **Addressing and partitioning** | Table calc addressing/partitioning (Compute Using) | No equivalent concept; use ALLSELECTED, ALLEXCEPT       |
| **Dimensions vs measures**      | Any field can be either depending on placement     | Explicit: columns are dimensions, measures are measures |
| **Filter context**              | Implicit in the visualization                      | Explicit and modifiable with CALCULATE                  |

!!! info "The mental model shift"
The biggest learning curve in moving from Tableau to DAX is not syntax — it is the mental model. In Tableau, the visualization defines the grain and calculations respond to it. In DAX, the filter context defines the grain and you explicitly modify it with CALCULATE. Once a Tableau user understands filter context, DAX becomes logical rather than mysterious.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Tutorial: Calculation Conversion](tutorial-calc-conversion.md) | [Feature Mapping](feature-mapping-complete.md) | [Migration Playbook](../tableau-to-powerbi.md)
