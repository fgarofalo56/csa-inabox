# Tutorial: Calculation Conversion Workshop

**A hands-on workshop converting 15 common Tableau calculations to DAX, with detailed explanations of the conceptual differences between Tableau's level-of-detail model and DAX's filter context model.**

---

## Prerequisites

- Basic familiarity with Tableau calculated fields
- Power BI Desktop installed
- A sample dataset loaded (Superstore or similar sales dataset works well)
- Read the [Calculation Conversion Reference](calculation-conversion.md) for the full pattern library

**Estimated time:** 2-3 hours if working through all 15 exercises.

---

## Understanding the paradigm shift

Before converting any calculation, you need to understand the fundamental conceptual difference between Tableau and DAX.

### Tableau's model: Level of Detail

In Tableau, the visualization defines the grain. A bar chart grouped by Region has a "level of detail" of Region. Calculated fields operate at the visualization's grain by default. LOD expressions (FIXED, INCLUDE, EXCLUDE) let you override this grain.

### DAX's model: Filter Context

In DAX, every measure evaluates within a **filter context** — the set of active filters from slicers, visual axes, report filters, and the CALCULATE function. There is no implicit "level of detail." You explicitly define what filters apply using CALCULATE, ALL, ALLEXCEPT, and filter modification functions.

### The key insight

Tableau: "The viz determines the grain; I use LOD to override it."
DAX: "The filter context determines the result; I use CALCULATE to modify it."

Once you internalize this distinction, DAX conversion becomes systematic rather than mysterious.

---

## Exercise 1: Basic aggregate measure

### Tableau

```
// Calculated field: Total Sales
SUM([Sales])
```

### DAX

```dax
Total Sales = SUM(Sales[Amount])
```

### Explanation

This is the simplest conversion. In both Tableau and DAX, SUM aggregates the field across all rows in the current context. The syntax is nearly identical.

**Key difference:** In Tableau, this field automatically aggregates based on the visualization. In DAX, this is a **measure** — it always aggregates. If you need a row-level value, use a calculated column instead.

---

## Exercise 2: Calculated ratio

### Tableau

```
// Calculated field: Profit Margin
SUM([Profit]) / SUM([Sales])
```

### DAX

```dax
Profit Margin = DIVIDE(SUM(Sales[Profit]), SUM(Sales[Amount]))
```

### Explanation

Use `DIVIDE` instead of the `/` operator in DAX. `DIVIDE` handles division by zero gracefully (returns BLANK instead of an error). The Tableau equivalent would be `ZN(SUM([Profit]) / SUM([Sales]))`.

---

## Exercise 3: Conditional logic

### Tableau

```
// Calculated field: Sales Tier
IF [Sales] > 5000 THEN "Enterprise"
ELSEIF [Sales] > 1000 THEN "Mid-Market"
ELSEIF [Sales] > 100 THEN "SMB"
ELSE "Micro"
END
```

### DAX

```dax
// As a calculated column (row-level):
Sales Tier =
SWITCH(
    TRUE(),
    Sales[Amount] >= 5000, "Enterprise",
    Sales[Amount] >= 1000, "Mid-Market",
    Sales[Amount] >= 100, "SMB",
    "Micro"
)
```

### Explanation

DAX `SWITCH(TRUE(), ...)` is the pattern for multi-condition logic. It evaluates conditions in order and returns the first match. This is equivalent to Tableau's cascading IF/ELSEIF.

**When to use calculated column vs measure:** If the result is used as a filter or grouping dimension (e.g., you want a bar chart with "Enterprise", "Mid-Market", etc. on the axis), use a calculated column. If the result is displayed as a value, use a measure.

---

## Exercise 4: FIXED LOD — Aggregate at a fixed grain

### Tableau

```
// Calculated field: Region Total Sales
{ FIXED [Region] : SUM([Sales]) }
```

### DAX

```dax
Region Total Sales =
CALCULATE(
    SUM(Sales[Amount]),
    ALLEXCEPT(Sales, Sales[Region])
)
```

### Explanation

`FIXED [Region]` tells Tableau to ignore the visualization's grain and compute SUM(Sales) at the Region level. In DAX, `ALLEXCEPT(Sales, Sales[Region])` removes all filters from the Sales table except Region — achieving the same effect.

**Conceptual mapping:**

- FIXED dimensions = the dimensions you keep (inside ALLEXCEPT)
- Dimensions NOT in FIXED = the dimensions that get removed (ALL removes them)

**Verify:** Create a matrix with Region and Month on rows, Total Sales and Region Total Sales as values. Total Sales should vary by month, but Region Total Sales should be the same for every month within a region.

---

## Exercise 5: FIXED LOD — Grand total

### Tableau

```
// Grand total regardless of viz grain
{ FIXED : SUM([Sales]) }
```

### DAX

```dax
Grand Total Sales =
CALCULATE(
    SUM(Sales[Amount]),
    ALL(Sales)
)
```

### Explanation

A FIXED LOD with no dimensions computes at the table level (grand total). In DAX, `ALL(Sales)` removes all filters from the Sales table, returning the grand total regardless of any slicer or visual filter.

---

## Exercise 6: Percent of total using LOD

### Tableau

```
// Percent of grand total
SUM([Sales]) / { FIXED : SUM([Sales]) }
```

### DAX

```dax
Pct of Grand Total =
DIVIDE(
    SUM(Sales[Amount]),
    CALCULATE(SUM(Sales[Amount]), ALL(Sales))
)
```

### Explanation

The pattern is: current context value divided by grand total. In DAX, the numerator (`SUM(Sales[Amount])`) respects the current filter context (e.g., a single region). The denominator uses `CALCULATE` with `ALL` to ignore filters and get the grand total.

**Variation: Percent of parent (region total)**

```dax
Pct of Region =
DIVIDE(
    SUM(Sales[Amount]),
    CALCULATE(SUM(Sales[Amount]), ALLEXCEPT(Sales, Sales[Region]))
)
```

---

## Exercise 7: INCLUDE LOD — Add a dimension

### Tableau

```
// Average sales including Product, even if Product is not in the viz
{ INCLUDE [Product] : AVG([Sales]) }
```

### DAX

```dax
Avg Sales by Product =
AVERAGEX(
    VALUES(Products[Product]),
    CALCULATE(AVERAGE(Sales[Amount]))
)
```

### Explanation

INCLUDE tells Tableau to compute at the viz grain PLUS an additional dimension. In DAX, `AVERAGEX` iterates over each distinct Product in the current filter context and computes the average of each product's average sales. This effectively "includes" the Product dimension in the calculation.

---

## Exercise 8: EXCLUDE LOD — Remove a dimension

### Tableau

```
// Total sales excluding Month (annual total in a monthly chart)
{ EXCLUDE [Month] : SUM([Sales]) }
```

### DAX

```dax
Annual Sales =
CALCULATE(
    SUM(Sales[Amount]),
    ALL(Calendar[Month])
)
```

### Explanation

EXCLUDE removes a dimension from the viz grain. In DAX, `ALL(Calendar[Month])` removes the Month filter while keeping all other filters intact. The result is the annual total displayed on every month row.

---

## Exercise 9: Running total (table calculation)

### Tableau

```
// Table calculation: RUNNING_SUM(SUM([Sales]))
// Compute using: Table (across dates)
```

### DAX

```dax
// Using WINDOW function (DAX 2023+)
Running Total =
CALCULATE(
    SUM(Sales[Amount]),
    WINDOW(1, ABS, 0, REL, ORDERBY(Calendar[Date]))
)

// Pre-2023 approach
Running Total Legacy =
CALCULATE(
    SUM(Sales[Amount]),
    FILTER(
        ALL(Calendar),
        Calendar[Date] <= MAX(Calendar[Date])
    )
)
```

### Explanation

Tableau table calculations operate on the visual result set (post-aggregation). DAX measures operate on the data model (pre-visual). To create a running total in DAX, you must explicitly define the window: "all rows from the beginning up to the current row, ordered by Date."

The WINDOW function (available since DAX 2023) simplifies this significantly. The legacy approach uses FILTER on ALL(Calendar) to build the window manually.

---

## Exercise 10: Ranking

### Tableau

```
// Table calculation: RANK(SUM([Sales]))
```

### DAX

```dax
Sales Rank =
RANKX(
    ALL(Products[Category]),
    [Total Sales],
    ,
    DESC,
    DENSE
)
```

### Explanation

`RANKX` takes five arguments:

1. The table to rank over (`ALL(Products[Category])` — all categories regardless of filters)
2. The expression to rank by (`[Total Sales]`)
3. Value (optional, for comparison)
4. Order (DESC = highest first)
5. Tie handling (DENSE = no gaps in rank numbers)

**Common pitfall:** Forgetting `ALL()` around the ranking table. Without ALL, the rank is always 1 because the filter context contains only the current category.

---

## Exercise 11: Year-over-year comparison

### Tableau

```
// Table calculation: LOOKUP(SUM([Sales]), -4) for quarterly YoY
// Or Quick Table Calc: Year over Year Growth
```

### DAX

```dax
Prior Year Sales =
CALCULATE(
    SUM(Sales[Amount]),
    SAMEPERIODLASTYEAR(Calendar[Date])
)

YoY Growth % =
VAR Current = SUM(Sales[Amount])
VAR Prior = [Prior Year Sales]
RETURN DIVIDE(Current - Prior, Prior)
```

### Explanation

DAX time intelligence functions (`SAMEPERIODLASTYEAR`, `PREVIOUSMONTH`, `PREVIOUSQUARTER`) are purpose-built for period comparisons. They require a properly configured date table (marked as a date table in Power BI). This is more elegant than Tableau's LOOKUP table calculation approach.

---

## Exercise 12: Moving average

### Tableau

```
// Table calculation: WINDOW_AVG(SUM([Sales]), -2, 0)
// 3-period moving average
```

### DAX

```dax
Moving Avg 3 Months =
AVERAGEX(
    DATESINPERIOD(
        Calendar[Date],
        MAX(Calendar[Date]),
        -3,
        MONTH
    ),
    [Total Sales]
)
```

### Explanation

`DATESINPERIOD` generates a set of dates: from MAX(Calendar[Date]) going back 3 months. `AVERAGEX` iterates over this date set and computes the average of Total Sales for each period. The result is a rolling 3-month average.

---

## Exercise 13: Top N with dynamic parameter

### Tableau

```
// Parameter: Top N (integer, 5-50)
// Set: Top N Products
// Condition: By SUM(Sales), Top [Top N] parameter
```

### DAX

```dax
// Step 1: Create a What-If parameter
// Modeling → New Parameter → Name: "Top N", Min: 5, Max: 50, Increment: 5

// Step 2: Create ranking measure
Product Sales Rank =
RANKX(
    ALL(Products[ProductName]),
    [Total Sales],
    ,
    DESC
)

// Step 3: Create Top N filter measure
In Top N =
IF(
    [Product Sales Rank] <= SELECTEDVALUE('Top N'[Top N Value]),
    1,
    0
)

// Step 4: Add In Top N as a visual-level filter = 1
```

### Explanation

Tableau parameters with sets provide a dynamic Top N filter. In Power BI, combine a What-If parameter (which creates a slicer) with a RANKX measure and a visual-level filter. The user slides the Top N slicer, and the visual shows only the top N products.

---

## Exercise 14: Cohort analysis

### Tableau

```
// Cohort calculated field:
// { FIXED [Customer ID] : MIN(DATETRUNC('month', [Order Date])) }
// Use as dimension for cohort grouping
```

### DAX

```dax
// Calculated column on Customer table (or add to fact table via relationship)
Cohort Month =
VAR FirstDate =
    CALCULATE(
        MIN(Sales[OrderDate]),
        ALLEXCEPT(Sales, Sales[CustomerID])
    )
RETURN
    EOMONTH(FirstDate, -1) + 1
// Returns the first day of the customer's first purchase month

// Display measure:
Cohort Label =
IF(
    HASONEVALUE(Customers[Cohort Month]),
    FORMAT(SELECTEDVALUE(Customers[Cohort Month]), "MMM YYYY"),
    "Multiple"
)
```

### Explanation

Cohort analysis requires a FIXED LOD to find each customer's first purchase date, then truncates to month. In DAX, create this as a calculated column on the Customer dimension table. Use ALLEXCEPT to fix the grain at the customer level. Then use this column as a dimension in visuals for cohort-based analysis.

---

## Exercise 15: Nested LOD — Average of customer totals

### Tableau

```
// Two-step calculation:
// Step 1: { FIXED [Customer ID] : SUM([Sales]) }  → Customer Total
// Step 2: AVG([Customer Total])  → Average customer value
```

### DAX

```dax
Avg Customer Value =
AVERAGEX(
    VALUES(Customers[CustomerID]),
    CALCULATE(SUM(Sales[Amount]))
)
```

### Explanation

This is a nested aggregation: SUM at the customer level, then AVG across all customers. In DAX, `AVERAGEX` iterates over each distinct customer and computes the sum of their sales. The result is the average customer lifetime value.

`AVERAGEX` is the key function for INCLUDE-style LODs and nested aggregations. The pattern is: `AVERAGEX(distinct dimension values, CALCULATE(aggregation))`.

---

## Summary: Conversion pattern cheat sheet

| Tableau pattern | DAX pattern | Key function |
|---|---|---|
| Simple aggregate | `SUM(Table[Column])` | SUM, AVERAGE, COUNT |
| Row-level calc | Calculated column | Direct formula |
| Conditional logic | `SWITCH(TRUE(), ...)` | SWITCH, IF |
| FIXED LOD | `CALCULATE(agg, ALLEXCEPT(table, dims))` | CALCULATE + ALLEXCEPT |
| INCLUDE LOD | `AVERAGEX(VALUES(dim), CALCULATE(agg))` | Iterator + CALCULATE |
| EXCLUDE LOD | `CALCULATE(agg, ALL(excluded_dim))` | CALCULATE + ALL |
| Running total | `WINDOW(1, ABS, 0, REL, ORDERBY(col))` | WINDOW |
| Rank | `RANKX(ALL(table), measure, , DESC)` | RANKX |
| YoY comparison | `CALCULATE(agg, SAMEPERIODLASTYEAR(dates))` | Time intelligence |
| Moving average | `AVERAGEX(DATESINPERIOD(...), measure)` | DATESINPERIOD |
| Top N | `RANKX` + What-If parameter + visual filter | RANKX + SELECTEDVALUE |
| Percent of total | `DIVIDE(agg, CALCULATE(agg, ALL(table)))` | DIVIDE + ALL |
| Cohort | Calculated column with ALLEXCEPT | Calculated column |
| Nested LOD | `AVERAGEX(VALUES(dim), CALCULATE(agg))` | Iterator + CALCULATE |

---

## Next steps

1. Practice these 15 patterns on your own data
2. Reference the full [Calculation Conversion Reference](calculation-conversion.md) for additional patterns
3. Use DAX Studio for debugging and performance testing
4. Read Microsoft Learn's [DAX function reference](https://learn.microsoft.com/dax/) for comprehensive documentation
5. Proceed to [Tutorial: Workbook to PBIX](tutorial-workbook-to-pbix.md) for a complete end-to-end conversion

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Calculation Conversion Reference](calculation-conversion.md) | [Tutorial: Workbook to PBIX](tutorial-workbook-to-pbix.md) | [Feature Mapping](feature-mapping-complete.md) | [Migration Playbook](../tableau-to-powerbi.md)
