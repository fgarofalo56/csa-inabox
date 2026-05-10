---
title: "Video Script: Power BI Reporting with Azure Synapse"
tags:
  - multimedia
  - video
---
# Video Script: Power BI Reporting with Azure Synapse

![Duration: 22 minutes](https://img.shields.io/badge/Duration-22%20minutes-blue)
![Level: Intermediate](https://img.shields.io/badge/Level-Intermediate-yellow)
![Version: 1.0](https://img.shields.io/badge/Version-1.0-blue)

## Video Metadata

- **Title**: Building Power BI Reports with Azure Synapse Analytics
- **Duration**: 22:00
- **Target Audience**: Business analysts, data analysts
- **Skill Level**: Intermediate
- **Prerequisites**:
  - Power BI Desktop installed
  - Azure Synapse workspace with data
  - Basic Power BI knowledge
  - Understanding of DAX basics

## Learning Objectives

1. Connect Power BI to Synapse SQL pools
2. Optimize DirectQuery performance
3. Create efficient data models
4. Build interactive dashboards
5. Implement row-level security
6. Publish and share reports

## Video Script

### Opening (0:00 - 1:00)

**NARRATOR**:
"Power BI and Azure Synapse Analytics are better together. In this tutorial, you'll learn how to build high-performance, interactive dashboards that bring your Synapse data to life for business users."

### Section 1: Connection Setup (1:00 - 5:00)

#### DirectQuery Connection (1:00 - 3:00)

```textPower BI Desktop Steps:
1. Home → Get Data → Azure → Azure Synapse Analytics SQL
2. Server: mysynapse.sql.azuresynapse.net
3. Database: DW
4. Data Connectivity mode: DirectQuery
5. Sign in with Azure AD
6. Select tables
```

**Connection String**:
```textData Source=mysynapse.sql.azuresynapse.net;
Initial Catalog=DW;
Authentication=Active Directory Integrated;
```

#### Import vs DirectQuery (3:00 - 5:00)

**DirectQuery Benefits**:
- Always current data
- Large datasets (> 1GB)
- Real-time dashboards

**Import Benefits**:
- Faster query performance
- More DAX features available
- Offline access

**Composite Model** (Best of both):
```textLarge fact tables: DirectQuery
Small dimensions: Import
Aggregations: Import
```

### Section 2: Data Modeling (5:00 - 11:00)

#### Star Schema Design (5:00 - 7:30)

```dax
// Date table
Date =
ADDCOLUMNS(
    CALENDAR(DATE(2020,1,1), DATE(2025,12,31)),
    "Year", YEAR([Date]),
    "Quarter", "Q" & QUARTER([Date]),
    "Month", FORMAT([Date], "MMMM"),
    "MonthNum", MONTH([Date])
)

// Relationships
Sales[DateKey] → Date[DateKey]
Sales[CustomerKey] → Customer[CustomerKey]
Sales[ProductKey] → Product[ProductKey]
```

#### Performance Optimization (7:30 - 9:00)

```dax
// Aggregate table for performance
SalesSummary =
SUMMARIZE(
    Sales,
    Date[Year],
    Date[Month],
    Product[Category],
    "TotalSales", SUM(Sales[Amount]),
    "TotalQuantity", SUM(Sales[Quantity])
)

// Use aggregations in DirectQuery
[Total Revenue] =
IF(
    ISFILTERED(Sales[TransactionID]),
    SUM(Sales[Amount]),
    SUMX(SalesSummary, [TotalSales])
)
```

#### Security Implementation (9:00 - 11:00)

```dax
// Row-level security role
[Region Security] =
FILTER(
    ALL(Territory[Region]),
    Territory[Region] = USERNAME()
)

// Dynamic security with table
[User Security] =
VAR CurrentUser = USERNAME()
VAR UserRegions =
    FILTER(
        UserSecurity,
        UserSecurity[UserEmail] = CurrentUser
    )
RETURN
    FILTER(
        ALL(Territory[Region]),
        Territory[Region] IN UserRegions[Region]
    )
```

### Section 3: DAX Measures (11:00 - 16:00)

#### Core Measures (11:00 - 13:00)

```dax
// Total Revenue
Total Revenue = SUM(Sales[Amount])

// Total Quantity
Total Quantity = SUM(Sales[Quantity])

// Average Order Value
Average Order Value =
DIVIDE(
    [Total Revenue],
    DISTINCTCOUNT(Sales[OrderID]),
    0
)

// YTD Revenue
YTD Revenue =
CALCULATE(
    [Total Revenue],
    DATESYTD(Date[Date])
)

// Previous Year Revenue
PY Revenue =
CALCULATE(
    [Total Revenue],
    SAMEPERIODLASTYEAR(Date[Date])
)

// YoY Growth
YoY Growth =
DIVIDE(
    [Total Revenue] - [PY Revenue],
    [PY Revenue],
    0
)

// Growth Percentage
YoY Growth % =
FORMAT([YoY Growth], "0.0%")
```

#### Advanced Measures (13:00 - 16:00)

```dax
// Running Total
Running Total =
CALCULATE(
    [Total Revenue],
    FILTER(
        ALLSELECTED(Date[Date]),
        Date[Date] <= MAX(Date[Date])
    )
)

// Top N Products
Top 10 Products Revenue =
CALCULATE(
    [Total Revenue],
    TOPN(
        10,
        ALL(Product[ProductName]),
        [Total Revenue],
        DESC
    )
)

// Customer Lifetime Value
Customer LTV =
SUMX(
    VALUES(Customer[CustomerID]),
    CALCULATE([Total Revenue])
)

// Cohort Analysis
Month 0 Revenue =
CALCULATE(
    [Total Revenue],
    DATESINPERIOD(
        Date[Date],
        MIN(Customer[FirstPurchaseDate]),
        1,
        MONTH
    )
)

// Pareto (80/20) Analysis
Cumulative % =
VAR CurrentRevenue = [Total Revenue]
VAR TotalRevenue =
    CALCULATE(
        [Total Revenue],
        ALLSELECTED(Product[ProductName])
    )
VAR ProductRank =
    RANKX(
        ALLSELECTED(Product[ProductName]),
        [Total Revenue],
        ,
        DESC
    )
RETURN
    DIVIDE(
        CALCULATE(
            SUM(Sales[Amount]),
            TOPN(
                ProductRank,
                ALLSELECTED(Product[ProductName]),
                [Total Revenue],
                DESC
            )
        ),
        TotalRevenue
    )
```

### Section 4: Visualization Best Practices (16:00 - 20:00)

#### Dashboard Design (16:00 - 18:00)

**Page 1: Executive Summary**
- KPI cards (Revenue, Orders, Customers)
- Revenue trend line chart
- Top 10 products bar chart
- Sales by region map
- YoY growth gauge

**Page 2: Sales Analysis**
- Sales by category (donut chart)
- Monthly trends (line + column chart)
- Top customers table
- Product matrix with drill-down

**Page 3: Customer Analytics**
- Customer segments (treemap)
- Cohort retention heatmap
- Customer lifetime value distribution
- Acquisition trends

#### Performance Tips (18:00 - 20:00)

```dax
// Avoid calculated columns in DirectQuery
// BAD
Product[FullName] = Product[Category] & " - " & Product[Name]

// GOOD (use measure instead)
Product Full Name =
SELECTEDVALUE(Product[Category]) & " - " &
SELECTEDVALUE(Product[Name])

// Avoid iterators on large tables
// BAD
Total Revenue =
SUMX(
    Sales,
    Sales[Quantity] * Sales[UnitPrice]
)

// GOOD (calculate in SQL)
Total Revenue = SUM(Sales[Amount])

// Use variables for complex calculations
Revenue Margin =
VAR Revenue = [Total Revenue]
VAR Cost = [Total Cost]
VAR Margin = Revenue - Cost
VAR MarginPct = DIVIDE(Margin, Revenue, 0)
RETURN MarginPct
```

### Section 5: Publishing and Sharing (20:00 - 22:00)

#### Publish to Service (20:00 - 21:00)

```textSteps:
1. File → Publish → Publish to Power BI
2. Select workspace
3. Configure refresh schedule
4. Set up gateway (if needed)
5. Configure RLS roles
6. Share with users
```

#### Performance Monitoring (21:00 - 22:00)

```textPower BI Service:
1. Workspace settings → Premium capacity metrics
2. Monitor query duration
3. Review refresh history
4. Check gateway health
5. Optimize based on usage patterns
```

## Best Practices

1. **Data Model**:
   - Use star schema design
   - Minimize table relationships
   - Remove unused columns
   - Use appropriate data types

2. **DAX**:
   - Use measures instead of calculated columns
   - Avoid complex iterators in DirectQuery
   - Leverage variables
   - Test performance with large datasets

3. **Visuals**:
   - Limit visuals per page (< 10)
   - Use appropriate chart types
   - Implement drill-through pages
   - Add helpful tooltips

4. **Security**:
   - Implement RLS at data source
   - Test RLS thoroughly
   - Use Azure AD groups
   - Document security model

## Related Resources

- [Synapse Fundamentals](synapse-fundamentals.md)
- [Performance Tuning](performance-tuning.md)
- [Monitoring Dashboards](monitoring-dashboards.md)

---

*Last Updated: January 2025*
