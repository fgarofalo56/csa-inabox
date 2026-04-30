---
title: "Qlik to Power BI Expression Migration"
description: "Converting Qlik Sense expressions to DAX — Set Analysis, Aggr(), inter-record functions, conditionals, and date functions with 20+ side-by-side examples."
---

# Qlik to Power BI: Expression Migration

**Audience:** BI developers, report developers, DAX practitioners
**Purpose:** Definitive reference for converting Qlik expressions to DAX with conceptual explanations
**Reading time:** 25-30 minutes

---

## Understanding the paradigm shift

Qlik expressions and DAX measures both calculate aggregated values, but they operate on fundamentally different models:

**Qlik expressions** operate on the **associative selection state**. When a user selects "California" in a filter pane, the selection state changes globally, and every expression recalculates based on the new selection. Set Analysis overrides or modifies this selection state inline.

**DAX measures** operate on **filter context**. Filter context is the set of filters applied to the data model at the time the measure is evaluated. CALCULATE modifies the filter context. Every visual cell creates its own filter context based on the row/column/slicer values.

The key mental model shift: **In Qlik, you think about selections. In DAX, you think about filter context.**

---

## 1. Basic aggregations

These are straightforward mappings with minor syntax differences.

### Sum

```
// Qlik
Sum(Sales)

// DAX
Total Sales = SUM(Sales[Amount])
```

### Count

```
// Qlik
Count(OrderID)

// DAX
Order Count = COUNT(Sales[OrderID])
```

### Count Distinct

```
// Qlik
Count(DISTINCT CustomerID)

// DAX
Unique Customers = DISTINCTCOUNT(Sales[CustomerID])
```

### Average

```
// Qlik
Avg(UnitPrice)

// DAX
Avg Price = AVERAGE(Sales[UnitPrice])
```

### Min / Max

```
// Qlik
Min(OrderDate)
Max(OrderDate)

// DAX
First Order = MIN(Sales[OrderDate])
Last Order = MAX(Sales[OrderDate])
```

---

## 2. Set Analysis to DAX CALCULATE

Set Analysis is the most distinctive Qlik feature and the most time-consuming to convert. Every Set Analysis expression maps to a `CALCULATE` + filter argument pattern in DAX.

### Basic set with field value

```
// Qlik: Sum sales for year 2025 only
Sum({<Year={2025}>} Sales)

// DAX
Sales 2025 =
CALCULATE(
    SUM(Sales[Amount]),
    Calendar[Year] = 2025
)
```

### Set with multiple field values

```
// Qlik: Sum sales for Q1 and Q2
Sum({<Quarter={'Q1','Q2'}>} Sales)

// DAX
Sales Q1 Q2 =
CALCULATE(
    SUM(Sales[Amount]),
    Calendar[Quarter] IN {"Q1", "Q2"}
)
```

### Set with exclusion (remove a field from selection)

```
// Qlik: Sum sales ignoring any Region selection
Sum({<Region=>} Sales)

// DAX
Sales All Regions =
CALCULATE(
    SUM(Sales[Amount]),
    ALL(Geography[Region])
)
```

### Set with exclusion of specific values

```
// Qlik: Sum sales excluding USA
Sum({<Region-={'USA'}>} Sales)

// DAX
Sales Excl USA =
CALCULATE(
    SUM(Sales[Amount]),
    Geography[Region] <> "USA"
)
```

### Set with value assignment and exclusion combined

```
// Qlik: Sum 2025 sales, ignoring region selection
Sum({<Year={2025}, Region=>} Sales)

// DAX
Sales 2025 All Regions =
CALCULATE(
    SUM(Sales[Amount]),
    Calendar[Year] = 2025,
    ALL(Geography[Region])
)
```

### Set with wildcard search

```
// Qlik: Sum sales for products containing "Widget"
Sum({<ProductName={"*Widget*"}>} Sales)

// DAX
Widget Sales =
CALCULATE(
    SUM(Sales[Amount]),
    FILTER(
        ALL(Products[ProductName]),
        CONTAINSSTRING(Products[ProductName], "Widget")
    )
)
```

### Set with dollar-sign expansion (dynamic values)

```
// Qlik: Sum sales for the selected year (variable)
// SET vYear = Year(Today());
Sum({<Year={$(vYear)}>} Sales)

// DAX: Use SELECTEDVALUE or a slicer-connected measure
Sales Selected Year =
CALCULATE(
    SUM(Sales[Amount]),
    Calendar[Year] = SELECTEDVALUE(Calendar[Year])
)
```

### Set with alternate set identifier

```
// Qlik: Sum sales using bookmark state "BM01"
Sum({BM01} Sales)

// DAX: No direct equivalent. Use bookmarks in the report
// to capture the filter state, or create explicit measures
// for each comparison scenario.
```

### Set with intersection (AND)

```
// Qlik: Sum sales for 2025 AND Region = East
Sum({<Year={2025}, Region={'East'}>} Sales)

// DAX
Sales 2025 East =
CALCULATE(
    SUM(Sales[Amount]),
    Calendar[Year] = 2025,
    Geography[Region] = "East"
)
```

### Set with union (OR across sets)

```
// Qlik: Sum sales for (Year=2025 OR Region=East)
Sum({<Year={2025}> + <Region={'East'}>} Sales)

// DAX
Sales 2025 Or East =
CALCULATE(
    SUM(Sales[Amount]),
    FILTER(
        ALL(Sales),
        RELATED(Calendar[Year]) = 2025
        || RELATED(Geography[Region]) = "East"
    )
)
```

---

## 3. Aggr() function to DAX iterators

The Aggr() function in Qlik recalculates an expression at a different granularity than the current visualization. It is one of the hardest Qlik constructs to port to DAX because there is no single DAX equivalent -- the pattern depends on the context.

### Simple Aggr (aggregate at a different grain)

```
// Qlik: Average of sales per customer (customer-level average, not row-level)
Avg(Aggr(Sum(Sales), CustomerID))

// DAX
Avg Sales Per Customer =
AVERAGEX(
    VALUES(Customers[CustomerID]),
    CALCULATE(SUM(Sales[Amount]))
)
```

### Aggr with NODISTINCT

```
// Qlik: Count of orders per customer, then average
Avg(Aggr(Count(OrderID), CustomerID))

// DAX
Avg Orders Per Customer =
AVERAGEX(
    VALUES(Customers[CustomerID]),
    CALCULATE(COUNT(Sales[OrderID]))
)
```

### Nested Aggr

```
// Qlik: Max of (sum of sales per product per region)
Max(Aggr(Sum(Sales), ProductID, Region))

// DAX
Max Product Region Sales =
MAXX(
    ADDCOLUMNS(
        CROSSJOIN(
            VALUES(Products[ProductID]),
            VALUES(Geography[Region])
        ),
        "ProductRegionSales", CALCULATE(SUM(Sales[Amount]))
    ),
    [ProductRegionSales]
)
```

### Aggr for ranking

```
// Qlik: Rank customers by total sales
Rank(Aggr(Sum(Sales), CustomerID))

// DAX
Customer Rank =
RANKX(
    ALL(Customers[CustomerID]),
    CALCULATE(SUM(Sales[Amount])),
    ,
    DESC
)
```

---

## 4. Inter-record functions

Qlik's inter-record functions (Above, Below, Previous) reference other rows in the current visualization's table order. DAX handles this with window functions (introduced in 2023) or traditional offset patterns.

### Above (previous row value)

```
// Qlik: Previous month's sales
Above(Sum(Sales))

// DAX (using OFFSET, available in DAX 2023+)
Previous Month Sales =
CALCULATE(
    SUM(Sales[Amount]),
    OFFSET(
        -1,
        ALLSELECTED(Calendar[YearMonth]),
        ORDERBY(Calendar[YearMonth], ASC)
    )
)

// DAX (traditional, using time intelligence)
Previous Month Sales =
CALCULATE(
    SUM(Sales[Amount]),
    PREVIOUSMONTH(Calendar[Date])
)
```

### Running sum (cumulative total)

```
// Qlik
RangeSum(Above(Sum(Sales), 0, RowNo()))

// DAX (using WINDOW, available in DAX 2023+)
Running Total =
CALCULATE(
    SUM(Sales[Amount]),
    WINDOW(
        1, ABS,
        0, REL,
        ALLSELECTED(Calendar[YearMonth]),
        ORDERBY(Calendar[YearMonth], ASC)
    )
)

// DAX (traditional)
Running Total =
CALCULATE(
    SUM(Sales[Amount]),
    FILTER(
        ALL(Calendar[Date]),
        Calendar[Date] <= MAX(Calendar[Date])
    )
)
```

### Below (next row value)

```
// Qlik
Below(Sum(Sales))

// DAX (using OFFSET)
Next Month Sales =
CALCULATE(
    SUM(Sales[Amount]),
    OFFSET(
        1,
        ALLSELECTED(Calendar[YearMonth]),
        ORDERBY(Calendar[YearMonth], ASC)
    )
)
```

### Period-over-period (month over month)

```
// Qlik
Sum(Sales) - Above(Sum(Sales))

// DAX
MoM Change =
VAR CurrentSales = SUM(Sales[Amount])
VAR PriorSales =
    CALCULATE(
        SUM(Sales[Amount]),
        PREVIOUSMONTH(Calendar[Date])
    )
RETURN
CurrentSales - PriorSales
```

### Moving average (rolling 3-month)

```
// Qlik
RangeAvg(Above(Sum(Sales), 0, 3))

// DAX
Rolling 3M Avg =
AVERAGEX(
    DATESINPERIOD(
        Calendar[Date],
        MAX(Calendar[Date]),
        -3,
        MONTH
    ),
    CALCULATE(SUM(Sales[Amount]))
)
```

---

## 5. Conditional expressions

### If / Else

```
// Qlik
If(Sum(Sales) > 100000, 'High', 'Low')

// DAX
Sales Category =
IF(
    SUM(Sales[Amount]) > 100000,
    "High",
    "Low"
)
```

### Nested If

```
// Qlik
If(Sum(Sales) > 100000, 'High',
   If(Sum(Sales) > 50000, 'Medium', 'Low'))

// DAX
Sales Tier =
SWITCH(
    TRUE(),
    SUM(Sales[Amount]) > 100000, "High",
    SUM(Sales[Amount]) > 50000, "Medium",
    "Low"
)
```

### Pick / Match to SWITCH

```
// Qlik
Pick(Match(Status, 'Open', 'Closed', 'Pending'), 'Active', 'Done', 'Waiting')

// DAX
Status Label =
SWITCH(
    SELECTEDVALUE(Orders[Status]),
    "Open", "Active",
    "Closed", "Done",
    "Pending", "Waiting",
    "Unknown"
)
```

---

## 6. Date functions

| Qlik function             | DAX equivalent                     | Example                                           |
| ------------------------- | ---------------------------------- | ------------------------------------------------- |
| `Year(Date)`              | `YEAR(date_column)`                | `YEAR(Sales[OrderDate])`                          |
| `Month(Date)`             | `MONTH(date_column)`               | `MONTH(Sales[OrderDate])`                         |
| `Day(Date)`               | `DAY(date_column)`                 | `DAY(Sales[OrderDate])`                           |
| `MonthName(Date)`         | `FORMAT(date, "MMMM")`             | `FORMAT(Sales[OrderDate], "MMMM")`                |
| `WeekDay(Date)`           | `WEEKDAY(date_column)`             | `WEEKDAY(Sales[OrderDate])`                       |
| `Today()`                 | `TODAY()`                          | `TODAY()`                                         |
| `Now()`                   | `NOW()`                            | `NOW()`                                           |
| `AddMonths(Date, N)`      | `EDATE(date_column, N)`            | `EDATE(Sales[OrderDate], 3)`                      |
| `YearStart(Date)`         | `STARTOFYEAR(date_column)`         | `STARTOFYEAR(Calendar[Date])`                     |
| `MonthEnd(Date)`          | `ENDOFMONTH(date_column)`          | `ENDOFMONTH(Calendar[Date])`                      |
| `InYear(Date, BaseDate)`  | Time intelligence filter           | `CALCULATE(..., YEAR(Calendar[Date]) = ...)`      |
| `InMonth(Date, BaseDate)` | Time intelligence filter           | `CALCULATE(..., MONTH(Calendar[Date]) = ...)`     |
| `NetWorkDays(start,end)`  | Custom DAX with COUNTROWS + FILTER | Filter calendar for non-weekend, non-holiday days |

---

## 7. Dual() function

Qlik's `Dual()` function associates a text representation with a numeric value, allowing sorting by number while displaying text.

```
// Qlik
Dual(MonthName(Date), Month(Date))
// Displays "January" but sorts as 1

// Power BI: Sort By Column
// 1. Create a MonthName column: FORMAT(Calendar[Date], "MMMM")
// 2. Create a MonthNumber column: MONTH(Calendar[Date])
// 3. In the model, set MonthName "Sort By Column" = MonthNumber
// This achieves the same result through the modeling layer.
```

---

## 8. String functions

| Qlik function                        | DAX equivalent                                       |
| ------------------------------------ | ---------------------------------------------------- | ----------- |
| `Len(string)`                        | `LEN(column)`                                        |
| `Left(string, n)`                    | `LEFT(column, n)`                                    |
| `Right(string, n)`                   | `RIGHT(column, n)`                                   |
| `Mid(string, start, len)`            | `MID(column, start, len)`                            |
| `Upper(string)`                      | `UPPER(column)`                                      |
| `Lower(string)`                      | `LOWER(column)`                                      |
| `Trim(string)`                       | `TRIM(column)`                                       |
| `Replace(string, from, to)`          | `SUBSTITUTE(column, old, new)`                       |
| `SubField(string, delimiter, index)` | `PATHITEM(SUBSTITUTE(column, delim, "                | "), index)` |
| `Index(string, substring)`           | `SEARCH(substring, column)` (case-insensitive)       |
| `TextBetween(string, start, end)`    | `MID(column, SEARCH(...)+LEN(...), SEARCH(...)-...)` |
| `Capitalize(string)`                 | No native; use Power Query for proper case           |
| `KeepChar(string, chars)`            | No native; use Power Query or regex                  |
| `PurgeChar(string, chars)`           | `SUBSTITUTE` chained                                 |

---

## 9. Null handling

```
// Qlik: IsNull()
If(IsNull(Field), 'Missing', Field)

// DAX: ISBLANK() or COALESCE()
Null Check =
IF(ISBLANK(Sales[Amount]), "Missing", FORMAT(Sales[Amount], "#,##0"))

// Or more concisely:
Safe Amount = COALESCE(Sales[Amount], 0)
```

---

## 10. Expression migration checklist

- [ ] **Catalog all expressions** -- export from Qlik (Master Items + inline expressions in each sheet object)
- [ ] **Classify by complexity** -- basic aggregation (XS), Set Analysis simple (M), Set Analysis complex (L), Aggr (L), nested Aggr (XL)
- [ ] **Convert basic aggregations first** -- these are mechanical and can be done rapidly
- [ ] **Convert Set Analysis patterns** -- use the mapping table in Section 2; test each in DAX Studio
- [ ] **Convert Aggr() patterns** -- analyze each instance individually; no mechanical conversion possible
- [ ] **Convert inter-record functions** -- use DAX window functions (2023+) or time intelligence
- [ ] **Define all measures in the semantic model** -- do not put calculations in individual reports
- [ ] **Validate** -- compare Qlik and Power BI results at multiple aggregation levels; spot-check specific records
- [ ] **Document** -- add descriptions to every DAX measure (Power BI supports measure descriptions)

---

## Cross-references

| Topic                                 | Document                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| Tutorial with 15+ worked examples     | [Tutorial: Expression Conversion](tutorial-expression-conversion.md) |
| Feature mapping (expressions section) | [Feature Mapping](feature-mapping-complete.md)                       |
| Data model context                    | [Data Model Migration](data-model-migration.md)                      |
| Full migration playbook               | [Migration Playbook](../qlik-to-powerbi.md)                          |

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
