---
title: "Tutorial: Qlik Expression to DAX Conversion Workshop"
description: "15+ common Qlik expressions with full DAX equivalents and explanations — YTD sales, rolling averages, Set Analysis with exclusions, comparative periods, top N, ranking."
---

# Tutorial: Qlik Expression to DAX Conversion Workshop

**Duration:** 2-3 hours (hands-on)
**Prerequisites:** Understanding of Qlik expressions and basic DAX syntax
**Skill level:** Intermediate to Advanced

---

## Workshop setup

This workshop uses a sales dataset with the following tables:

- **FactSales**: OrderID, CustomerID, ProductID, DateKey, Amount, Quantity, UnitPrice
- **DimCustomer**: CustomerID, CustomerName, Region, Segment
- **DimProduct**: ProductID, ProductName, Category, SubCategory
- **DimCalendar**: DateKey, Date, Year, Quarter, Month, MonthNumber, YearMonth

All exercises provide the Qlik expression, the DAX equivalent, and a conceptual explanation of why the conversion works the way it does.

---

## Exercise 1: Year-to-date sales

**Business question:** What are total sales from January 1 of the current year through today?

```
// Qlik
Sum({<Year={$(=Year(Today()))}, Date={"<=$(=Today())"}>} Amount)
```

```dax
// DAX
YTD Sales =
TOTALYTD(
    SUM(FactSales[Amount]),
    DimCalendar[Date]
)
```

**Explanation:** Qlik uses Set Analysis to filter the selection state to the current year and dates up to today. DAX provides the `TOTALYTD` time intelligence function that handles this natively. TOTALYTD automatically filters the date table from January 1 of the year context through the latest date in the current filter context.

---

## Exercise 2: Same period last year

**Business question:** What were sales for the same calendar period last year?

```
// Qlik
Sum({<Year={$(=Year(Today())-1)}>} Amount)
```

```dax
// DAX
SPLY Sales =
CALCULATE(
    SUM(FactSales[Amount]),
    SAMEPERIODLASTYEAR(DimCalendar[Date])
)
```

**Explanation:** `SAMEPERIODLASTYEAR` shifts the entire current date context back by one year. If a slicer selects "March 2025," the measure returns March 2024 sales. This is more robust than the Qlik approach because it respects whatever date range the user has selected, not just the current year.

---

## Exercise 3: Year-over-year growth percentage

**Business question:** What is the percentage change vs the same period last year?

```
// Qlik
(Sum(Amount) - Sum({<Year={$(=Year(Today())-1)}>} Amount))
  / Sum({<Year={$(=Year(Today())-1)}>} Amount)
```

```dax
// DAX
YoY Growth % =
VAR CurrentSales = SUM(FactSales[Amount])
VAR PriorYearSales =
    CALCULATE(
        SUM(FactSales[Amount]),
        SAMEPERIODLASTYEAR(DimCalendar[Date])
    )
RETURN
DIVIDE(
    CurrentSales - PriorYearSales,
    PriorYearSales,
    BLANK()
)
```

**Explanation:** DAX variables (`VAR`) prevent recalculating the same expression multiple times. `DIVIDE` handles division by zero gracefully (returns BLANK instead of error). This is cleaner and more performant than the Qlik pattern of repeating the Set Analysis expression twice.

---

## Exercise 4: Rolling 3-month average

**Business question:** What is the average monthly sales over the last 3 months?

```
// Qlik (in a chart with Month dimension)
RangeAvg(Above(Sum(Amount), 0, 3))
```

```dax
// DAX
Rolling 3M Avg =
AVERAGEX(
    DATESINPERIOD(
        DimCalendar[Date],
        MAX(DimCalendar[Date]),
        -3,
        MONTH
    ),
    CALCULATE(SUM(FactSales[Amount]))
)
```

**Explanation:** Qlik's `RangeAvg(Above(...))` operates on the visual table's row order. DAX's `DATESINPERIOD` creates a rolling window based on actual dates, which is more robust -- it works regardless of how the visual is sorted or filtered.

---

## Exercise 5: Set Analysis with exclusion

**Business question:** What are total sales ignoring any Region selection the user has made?

```
// Qlik
Sum({<Region=>} Amount)
```

```dax
// DAX
Sales All Regions =
CALCULATE(
    SUM(FactSales[Amount]),
    ALL(DimCustomer[Region])
)
```

**Explanation:** In Qlik, `<Region=>` clears the Region selection from the set, showing total sales regardless of what the user selected. In DAX, `ALL(DimCustomer[Region])` removes the Region filter from the evaluation context. Both achieve the same result: ignoring user selections on Region.

---

## Exercise 6: Set Analysis with specific exclusion

**Business question:** What are total sales excluding the "Other" category?

```
// Qlik
Sum({<Category-={'Other'}>} Amount)
```

```dax
// DAX
Sales Excl Other =
CALCULATE(
    SUM(FactSales[Amount]),
    DimProduct[Category] <> "Other"
)
```

**Explanation:** Qlik's `-=` operator removes specific values from the current selection. DAX uses a filter predicate within CALCULATE. The result is the same: sales for all categories except "Other."

---

## Exercise 7: Set Analysis with intersection

**Business question:** What are 2025 sales for the Enterprise segment?

```
// Qlik
Sum({<Year={2025}, Segment={'Enterprise'}>} Amount)
```

```dax
// DAX
Enterprise 2025 Sales =
CALCULATE(
    SUM(FactSales[Amount]),
    DimCalendar[Year] = 2025,
    DimCustomer[Segment] = "Enterprise"
)
```

**Explanation:** Multiple filter arguments in CALCULATE are intersected (AND logic), just like multiple field constraints in Qlik Set Analysis.

---

## Exercise 8: Top N customers

**Business question:** Who are the top 10 customers by revenue?

```
// Qlik (as a dimension limit or calculated dimension)
// Dimension: CustomerName
// Limitation: Fixed number = 10, based on Sum(Amount) descending
```

```dax
// DAX: Use as a visual-level filter
Top 10 Flag =
IF(
    RANKX(
        ALL(DimCustomer[CustomerName]),
        [Total Revenue],
        ,
        DESC,
        DENSE
    ) <= 10,
    1,
    0
)
// Apply as visual filter: Top 10 Flag = 1

// Alternative: Use visual-level Top N filter
// In the Filters pane, drag CustomerName to visual-level filter
// Select "Top N" > Top 10 > By value: Total Revenue
```

**Explanation:** Qlik handles Top N as a dimension limitation on the chart. Power BI provides two approaches: a DAX measure used as a filter, or the visual-level Top N filter (which is simpler and requires no DAX).

---

## Exercise 9: Customer ranking

**Business question:** What is each customer's rank by total revenue?

```
// Qlik
Rank(Sum(Amount))
```

```dax
// DAX
Customer Revenue Rank =
RANKX(
    ALL(DimCustomer[CustomerName]),
    [Total Revenue],
    ,
    DESC,
    DENSE
)
```

**Explanation:** Qlik's `Rank()` operates on the current chart context. DAX's `RANKX` requires explicit specification of the table to rank over (`ALL(DimCustomer[CustomerName])`) and the value expression. The fifth parameter controls rank ties (DENSE for no gaps, SKIP for gaps).

---

## Exercise 10: Percentage of total

**Business question:** What percentage of total revenue does each region represent?

```
// Qlik
Sum(Amount) / Sum({1} Amount)
// or
Sum(Amount) / Sum(TOTAL Amount)
```

```dax
// DAX
Revenue % of Total =
DIVIDE(
    SUM(FactSales[Amount]),
    CALCULATE(
        SUM(FactSales[Amount]),
        ALL(DimCustomer[Region])
    )
)
```

**Explanation:** Qlik's `{1}` set identifier represents the full dataset (ignoring all selections). DAX's `ALL()` on the dimension table removes the filter context for that dimension, giving the grand total as the denominator.

---

## Exercise 11: Conditional aggregation

**Business question:** What are sales only for orders above $1,000?

```
// Qlik
Sum({<Amount={">1000"}>} Amount)
```

```dax
// DAX
Large Order Sales =
CALCULATE(
    SUM(FactSales[Amount]),
    FactSales[Amount] > 1000
)
```

**Explanation:** Qlik uses Set Analysis with a value-based search string on the measure field. DAX applies a filter predicate on the fact table column within CALCULATE.

---

## Exercise 12: Distinct count with filter

**Business question:** How many unique customers purchased in 2025?

```
// Qlik
Count({<Year={2025}>} DISTINCT CustomerID)
```

```dax
// DAX
Customers 2025 =
CALCULATE(
    DISTINCTCOUNT(FactSales[CustomerID]),
    DimCalendar[Year] = 2025
)
```

---

## Exercise 13: Weighted average

**Business question:** What is the quantity-weighted average unit price?

```
// Qlik
Sum(Quantity * UnitPrice) / Sum(Quantity)
```

```dax
// DAX
Weighted Avg Price =
DIVIDE(
    SUMX(FactSales, FactSales[Quantity] * FactSales[UnitPrice]),
    SUM(FactSales[Quantity])
)
```

**Explanation:** DAX's `SUMX` is a row-by-row iterator -- it evaluates the expression for each row in the table and sums the results. This is the DAX pattern for any calculation that requires row-level multiplication before aggregation.

---

## Exercise 14: Running total (cumulative)

**Business question:** What is the cumulative revenue by month?

```
// Qlik (in a chart with YearMonth dimension)
RangeSum(Above(Sum(Amount), 0, RowNo()))
```

```dax
// DAX
Cumulative Revenue =
CALCULATE(
    SUM(FactSales[Amount]),
    FILTER(
        ALL(DimCalendar[YearMonth]),
        DimCalendar[YearMonth] <= MAX(DimCalendar[YearMonth])
    )
)
```

**Explanation:** Qlik's `RangeSum(Above(..., 0, RowNo()))` sums all rows from the first row to the current row in the visual table. DAX achieves this by filtering the calendar to all months up to and including the current month in the filter context.

---

## Exercise 15: New customers (first-time buyers)

**Business question:** How many customers made their first-ever purchase this month?

```
// Qlik
Count(DISTINCT {<Date={"=$(=MonthStart(Today()))">="}>}
    {<Date={"<$(=MonthStart(Today()))"}>} CustomerID)
// (This is complex in Qlik and often done with flag fields)
```

```dax
// DAX
New Customers =
COUNTROWS(
    FILTER(
        VALUES(DimCustomer[CustomerID]),
        CALCULATE(
            MIN(FactSales[DateKey])
        ) >= MIN(DimCalendar[DateKey])
        &&
        CALCULATE(
            MIN(FactSales[DateKey])
        ) <= MAX(DimCalendar[DateKey])
    )
)
```

**Explanation:** This pattern identifies customers whose first-ever purchase date falls within the current filter context period. In Qlik, this is often pre-calculated as a flag field in the data load script. In DAX, it can be expressed as a measure, though for performance, it is better to create a "first purchase date" column in the dbt Gold layer and filter on it.

---

## Exercise 16: Market basket (co-occurrence)

**Business question:** How many customers who bought Product A also bought Product B?

```
// Qlik
Count(DISTINCT {<ProductName={'Product A'}>} CustomerID)
- Count(DISTINCT {<ProductName={'Product A'}> - <ProductName={'Product B'}>} CustomerID)
// (Qlik approach is indirect; typically uses set intersection)
```

```dax
// DAX
Customers Bought Both =
VAR CustomersA =
    CALCULATETABLE(
        VALUES(FactSales[CustomerID]),
        DimProduct[ProductName] = "Product A"
    )
VAR CustomersB =
    CALCULATETABLE(
        VALUES(FactSales[CustomerID]),
        DimProduct[ProductName] = "Product B"
    )
RETURN
COUNTROWS(
    INTERSECT(CustomersA, CustomersB)
)
```

**Explanation:** DAX's `INTERSECT` function provides clean set intersection logic. `CALCULATETABLE` with `VALUES` creates a table of distinct customer IDs for each product. The `INTERSECT` returns only customers present in both tables.

---

## Workshop summary

| Exercise | Qlik concept                   | DAX concept                | Difficulty |
| -------- | ------------------------------ | -------------------------- | ---------- |
| 1        | Set Analysis (date range)      | TOTALYTD                   | Easy       |
| 2        | Set Analysis (prior year)      | SAMEPERIODLASTYEAR         | Easy       |
| 3        | YoY calculation                | VAR + DIVIDE               | Medium     |
| 4        | RangeAvg + Above               | DATESINPERIOD + AVERAGEX   | Medium     |
| 5        | Set exclusion (clear field)    | ALL()                      | Easy       |
| 6        | Set exclusion (specific value) | Filter predicate           | Easy       |
| 7        | Set intersection               | Multiple CALCULATE filters | Easy       |
| 8        | Top N dimension                | RANKX or visual filter     | Medium     |
| 9        | Rank                           | RANKX                      | Easy       |
| 10       | % of total                     | ALL() in denominator       | Medium     |
| 11       | Conditional aggregation        | CALCULATE with predicate   | Easy       |
| 12       | Distinct count with filter     | CALCULATE + DISTINCTCOUNT  | Easy       |
| 13       | Weighted average               | SUMX (row iterator)        | Medium     |
| 14       | Running total                  | Cumulative filter pattern  | Medium     |
| 15       | New customers                  | MIN date + filter          | Hard       |
| 16       | Market basket                  | INTERSECT + CALCULATETABLE | Hard       |

---

## Next steps

After completing this workshop:

1. Practice on your own Qlik expressions using the patterns learned here
2. Use DAX Studio (free tool) to test and debug DAX expressions before adding them to reports
3. Refer to the [Expression Migration Reference](expression-migration.md) for the complete mapping table
4. Proceed to the [Tutorial: App to PBIX](tutorial-app-to-pbix.md) for a full end-to-end app conversion

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
