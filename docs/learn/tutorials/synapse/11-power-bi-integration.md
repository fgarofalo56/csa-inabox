# Tutorial 11: Power BI Integration

## Overview

This tutorial covers integrating Azure Synapse Analytics with Power BI for creating interactive dashboards and reports. Learn to connect Power BI to both serverless and dedicated SQL pools, implement DirectQuery and Import modes, and optimize for performance.

## Prerequisites

- Completed [Tutorial 10: Dedicated SQL Pools](10-dedicated-sql.md)
- Power BI Desktop installed
- Power BI Pro or Premium license
- Azure Synapse workspace with data

## Learning Objectives

By the end of this tutorial, you will be able to:

- Connect Power BI to Synapse SQL pools
- Choose between DirectQuery and Import modes
- Create optimized data models
- Implement row-level security
- Build interactive dashboards
- Publish and share reports

---

## Section 1: Connection Methods

### Connecting to Serverless SQL Pool

**In Power BI Desktop:**

1. Click **Get Data** > **Azure** > **Azure Synapse Analytics SQL**
2. Enter the serverless endpoint:
   ```
   yourworkspace-ondemand.sql.azuresynapse.net
   ```
3. Select **DirectQuery** or **Import**
4. Authenticate with Azure AD

**Connection String:**
```
Server=yourworkspace-ondemand.sql.azuresynapse.net;Database=your_database;
```

### Connecting to Dedicated SQL Pool

**In Power BI Desktop:**

1. Click **Get Data** > **Azure** > **Azure Synapse Analytics SQL**
2. Enter the dedicated pool endpoint:
   ```
   yourworkspace.sql.azuresynapse.net
   ```
3. Select database (your dedicated pool name)
4. Choose connectivity mode

**Connection String:**
```
Server=yourworkspace.sql.azuresynapse.net;Database=your_dedicated_pool;
```

### DirectQuery vs Import Mode

| Feature | DirectQuery | Import |
|---------|-------------|--------|
| Data Freshness | Real-time | Scheduled refresh |
| Data Size | Unlimited | Limited by capacity |
| Performance | Query-time | Cached |
| DAX Support | Limited | Full |
| Use Case | Large datasets, real-time | Historical analysis |

```
DirectQuery Mode:
┌──────────────┐     Query      ┌──────────────┐
│   Power BI   │───────────────▶│    Synapse   │
│   Report     │◀───────────────│   SQL Pool   │
└──────────────┘    Results     └──────────────┘

Import Mode:
┌──────────────┐    Refresh     ┌──────────────┐
│   Power BI   │───────────────▶│    Synapse   │
│   Dataset    │◀───────────────│   SQL Pool   │
│   (Cached)   │    Full Data   └──────────────┘
└──────────────┘
```

---

## Section 2: Data Modeling for Power BI

### Creating Views for Reporting

```sql
-- Create reporting schema
CREATE SCHEMA reporting;
GO

-- Aggregated sales view (optimized for Power BI)
CREATE VIEW reporting.vw_SalesSummary
AS
SELECT
    d.FullDate AS SaleDate,
    d.Year,
    d.Quarter,
    d.MonthName AS Month,
    d.DayName AS DayOfWeek,
    p.Category,
    p.SubCategory,
    p.Brand,
    c.Segment AS CustomerSegment,
    c.Region,
    c.Country,
    COUNT(*) AS TransactionCount,
    SUM(f.Quantity) AS TotalQuantity,
    SUM(f.TotalAmount) AS TotalSales,
    SUM(f.DiscountAmount) AS TotalDiscount,
    AVG(f.UnitPrice) AS AvgUnitPrice
FROM fact.Sales f
JOIN dim.DateDimension d ON f.DateKey = d.DateKey
JOIN dim.Product p ON f.ProductKey = p.ProductKey
JOIN dim.Customer c ON f.CustomerKey = c.CustomerKey
GROUP BY
    d.FullDate, d.Year, d.Quarter, d.MonthName, d.DayName,
    p.Category, p.SubCategory, p.Brand,
    c.Segment, c.Region, c.Country;
GO

-- Customer analytics view
CREATE VIEW reporting.vw_CustomerAnalytics
AS
SELECT
    c.CustomerKey,
    c.CustomerID,
    c.CustomerName,
    c.Segment,
    c.Region,
    c.Country,
    MIN(d.FullDate) AS FirstPurchaseDate,
    MAX(d.FullDate) AS LastPurchaseDate,
    COUNT(DISTINCT f.SaleID) AS TotalOrders,
    SUM(f.TotalAmount) AS LifetimeValue,
    AVG(f.TotalAmount) AS AvgOrderValue,
    DATEDIFF(day, MIN(d.FullDate), MAX(d.FullDate)) AS CustomerTenureDays
FROM fact.Sales f
JOIN dim.Customer c ON f.CustomerKey = c.CustomerKey
JOIN dim.DateDimension d ON f.DateKey = d.DateKey
GROUP BY
    c.CustomerKey, c.CustomerID, c.CustomerName,
    c.Segment, c.Region, c.Country;
GO

-- Product performance view
CREATE VIEW reporting.vw_ProductPerformance
AS
SELECT
    p.ProductKey,
    p.ProductID,
    p.ProductName,
    p.Category,
    p.SubCategory,
    p.Brand,
    SUM(f.Quantity) AS TotalUnitsSold,
    SUM(f.TotalAmount) AS TotalRevenue,
    COUNT(DISTINCT f.CustomerKey) AS UniqueCustomers,
    COUNT(DISTINCT f.SaleID) AS TotalTransactions,
    AVG(f.UnitPrice) AS AvgSellingPrice
FROM fact.Sales f
JOIN dim.Product p ON f.ProductKey = p.ProductKey
GROUP BY
    p.ProductKey, p.ProductID, p.ProductName,
    p.Category, p.SubCategory, p.Brand;
GO
```

### Star Schema Best Practices

```sql
-- Ensure dimension tables have unique keys
ALTER TABLE dim.Product ADD CONSTRAINT PK_Product PRIMARY KEY (ProductKey);
ALTER TABLE dim.Customer ADD CONSTRAINT PK_Customer PRIMARY KEY (CustomerKey);
ALTER TABLE dim.DateDimension ADD CONSTRAINT PK_Date PRIMARY KEY (DateKey);

-- Add relationships hints for Power BI
-- (These become relationships in the Power BI model)

-- Create indexes on frequently filtered columns
CREATE NONCLUSTERED INDEX IX_Date_Year ON dim.DateDimension(Year);
CREATE NONCLUSTERED INDEX IX_Product_Category ON dim.Product(Category);
CREATE NONCLUSTERED INDEX IX_Customer_Region ON dim.Customer(Region);
```

---

## Section 3: DirectQuery Optimization

### Query Reduction Settings

In Power BI Desktop:
1. **File** > **Options and settings** > **Options**
2. **Current File** > **Query reduction**
3. Enable:
   - "Reduce number of queries sent by"
   - Apply button for slicers
   - Apply button for filters

### Aggregations for DirectQuery

```sql
-- Create aggregation table for common queries
CREATE TABLE agg.SalesByDayCategory
WITH (
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
)
AS
SELECT
    DateKey,
    Category,
    SUM(TotalAmount) AS TotalSales,
    SUM(Quantity) AS TotalQuantity,
    COUNT(*) AS TransactionCount
FROM fact.Sales f
JOIN dim.Product p ON f.ProductKey = p.ProductKey
GROUP BY DateKey, Category;

-- Create aggregation table for region summary
CREATE TABLE agg.SalesByMonthRegion
WITH (
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
)
AS
SELECT
    d.Year,
    d.Month,
    c.Region,
    SUM(f.TotalAmount) AS TotalSales,
    COUNT(DISTINCT f.CustomerKey) AS UniqueCustomers
FROM fact.Sales f
JOIN dim.DateDimension d ON f.DateKey = d.DateKey
JOIN dim.Customer c ON f.CustomerKey = c.CustomerKey
GROUP BY d.Year, d.Month, c.Region;
```

### Setting Up Aggregations in Power BI

1. Import both detail and aggregation tables
2. Right-click aggregation table > **Manage aggregations**
3. Configure mappings:

| Aggregation Column | Summarization | Detail Table | Detail Column |
|-------------------|---------------|--------------|---------------|
| TotalSales | Sum | fact.Sales | TotalAmount |
| TotalQuantity | Sum | fact.Sales | Quantity |
| TransactionCount | Count | fact.Sales | SaleID |
| DateKey | GroupBy | fact.Sales | DateKey |
| Category | GroupBy | dim.Product | Category |

---

## Section 4: Row-Level Security

### Synapse RLS Implementation

```sql
-- Create security schema and tables
CREATE SCHEMA security;
GO

-- User-to-region mapping table
CREATE TABLE security.UserRegionMapping
(
    UserEmail VARCHAR(200),
    Region VARCHAR(50)
)
WITH (DISTRIBUTION = REPLICATE);

-- Insert user mappings
INSERT INTO security.UserRegionMapping VALUES
('sales.north@company.com', 'North America'),
('sales.europe@company.com', 'Europe'),
('sales.apac@company.com', 'Asia Pacific'),
('manager@company.com', NULL);  -- NULL means all regions

-- Create security predicate function
CREATE FUNCTION security.fn_RegionFilter(@Region VARCHAR(50))
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
    SELECT 1 AS result
    WHERE @Region IN (
        SELECT Region FROM security.UserRegionMapping
        WHERE UserEmail = USER_NAME()
    )
    OR EXISTS (
        SELECT 1 FROM security.UserRegionMapping
        WHERE UserEmail = USER_NAME() AND Region IS NULL
    );
GO

-- Apply security policy
CREATE SECURITY POLICY security.RegionSecurityPolicy
ADD FILTER PREDICATE security.fn_RegionFilter(Region)
ON reporting.vw_SalesSummary
WITH (STATE = ON);
GO
```

### Power BI RLS Implementation

**Define Roles in Power BI Desktop:**

1. **Modeling** > **Manage roles**
2. Create role: "RegionalSales"
3. Add DAX filter:

```dax
// Filter by user's region
[Region] = LOOKUPVALUE(
    UserMapping[Region],
    UserMapping[Email],
    USERPRINCIPALNAME()
)
```

**Alternative: Dynamic RLS with USERNAME()**

```dax
// On Customer dimension table
PATHCONTAINS(
    [RegionPath],
    USERPRINCIPALNAME()
)
```

---

## Section 5: Building Reports

### DAX Measures for Analytics

```dax
// Sales Measures
Total Sales = SUM(Sales[TotalAmount])

Total Quantity = SUM(Sales[Quantity])

Avg Order Value = DIVIDE([Total Sales], COUNTROWS(Sales), 0)

// Time Intelligence
Sales YTD = TOTALYTD([Total Sales], 'Date'[FullDate])

Sales Previous Year = CALCULATE(
    [Total Sales],
    SAMEPERIODLASTYEAR('Date'[FullDate])
)

Sales YoY Growth =
DIVIDE(
    [Total Sales] - [Sales Previous Year],
    [Sales Previous Year],
    0
)

Sales Rolling 3 Month =
CALCULATE(
    [Total Sales],
    DATESINPERIOD('Date'[FullDate], MAX('Date'[FullDate]), -3, MONTH)
)

// Customer Measures
Unique Customers = DISTINCTCOUNT(Sales[CustomerKey])

New Customers =
CALCULATE(
    DISTINCTCOUNT(Sales[CustomerKey]),
    FILTER(
        Sales,
        Sales[CustomerKey] IN
        VALUES(Customer[CustomerKey]) &&
        CALCULATE(MIN(Sales[SaleDate])) = MAX('Date'[FullDate])
    )
)

Customer Retention Rate =
VAR CurrentPeriodCustomers = [Unique Customers]
VAR PreviousPeriodCustomers = CALCULATE(
    [Unique Customers],
    DATEADD('Date'[FullDate], -1, MONTH)
)
VAR ReturningCustomers =
CALCULATE(
    DISTINCTCOUNT(Sales[CustomerKey]),
    FILTER(
        Sales,
        CALCULATE(COUNT(Sales[SaleID]), DATEADD('Date'[FullDate], -1, MONTH)) > 0
    )
)
RETURN
DIVIDE(ReturningCustomers, PreviousPeriodCustomers, 0)

// Product Measures
Product Count = DISTINCTCOUNT(Product[ProductKey])

Avg Units Per Transaction = DIVIDE([Total Quantity], COUNTROWS(Sales), 0)

Top Product Category =
TOPN(1, VALUES(Product[Category]), [Total Sales], DESC)
```

### Report Layout Best Practices

```
┌────────────────────────────────────────────────────────────────┐
│  [Logo]  Sales Dashboard                    [Date Slicer]      │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌───────────┐│
│  │ Total Sales │ │   Orders    │ │  Customers  │ │ Avg Order ││
│  │   $2.5M     │ │   15,234    │ │    4,521    │ │   $164    ││
│  │  +12% YoY   │ │  +8% YoY    │ │  +15% YoY   │ │  +5% YoY  ││
│  └─────────────┘ └─────────────┘ └─────────────┘ └───────────┘│
│                                                                 │
│  ┌─────────────────────────────┐ ┌─────────────────────────┐  │
│  │                             │ │                         │  │
│  │   Sales Trend Line Chart    │ │  Sales by Category      │  │
│  │   (Month over Month)        │ │  (Donut Chart)          │  │
│  │                             │ │                         │  │
│  └─────────────────────────────┘ └─────────────────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │            Sales by Region (Map Visual)                 │  │
│  │                                                         │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Top Products Table                                     │  │
│  │  Product | Category | Sales | Qty | Growth              │  │
│  └─────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

---

## Section 6: Publishing and Sharing

### Publish to Power BI Service

1. **Home** > **Publish**
2. Select workspace
3. Configure dataset settings:
   - Gateway connection (if needed)
   - Credentials
   - Scheduled refresh

### Setting Up Scheduled Refresh

**For Import Mode:**

1. Go to Power BI Service > Workspace
2. Click dataset **Settings**
3. **Scheduled refresh**:
   - Enable
   - Frequency: Daily
   - Time: Off-peak hours
   - Configure credentials

**For DirectQuery:**

1. Dataset auto-refreshes on query
2. Configure cache refresh if needed

### Embedding in Applications

```html
<!-- Power BI Embedded iframe -->
<iframe
    title="Sales Dashboard"
    width="1140"
    height="541.25"
    src="https://app.powerbi.com/reportEmbed?reportId=YOUR_REPORT_ID&groupId=YOUR_GROUP_ID"
    frameborder="0"
    allowFullScreen="true">
</iframe>
```

```javascript
// Power BI JavaScript API
var embedConfig = {
    type: 'report',
    id: reportId,
    embedUrl: embedUrl,
    accessToken: accessToken,
    tokenType: models.TokenType.Embed,
    settings: {
        filterPaneEnabled: false,
        navContentPaneEnabled: true
    }
};

var report = powerbi.embed(embedContainer, embedConfig);
```

---

## Section 7: Performance Tuning

### Query Performance Analyzer

1. **View** > **Performance analyzer**
2. Start recording
3. Interact with visuals
4. Analyze results:
   - DAX query time
   - Visual render time
   - Direct query time

### Optimization Checklist

**Data Model:**
- [ ] Remove unnecessary columns
- [ ] Use appropriate data types
- [ ] Create relationships correctly
- [ ] Hide technical columns from users

**DAX:**
- [ ] Use variables for repeated calculations
- [ ] Avoid FILTER when CALCULATE works
- [ ] Use SUMMARIZE instead of GROUPBY when possible
- [ ] Test measures with DAX Studio

**Visuals:**
- [ ] Limit visuals per page (< 15)
- [ ] Use bookmarks for multiple views
- [ ] Implement drillthrough instead of many visuals
- [ ] Use aggregations for large datasets

---

## Exercises

### Exercise 1: Build Sales Dashboard
Create a complete sales dashboard with KPIs, trends, and drill-through capabilities.

### Exercise 2: Implement RLS
Set up row-level security for a multi-region sales team.

### Exercise 3: Optimize DirectQuery
Take a slow DirectQuery report and optimize it using aggregations.

---

## Best Practices Summary

| Practice | Recommendation |
|----------|----------------|
| Mode Selection | DirectQuery for real-time, Import for complex DAX |
| Data Model | Star schema with clear relationships |
| Measures | Create explicit measures, avoid implicit |
| Security | Implement RLS at source when possible |
| Performance | Use aggregations, limit visuals |
| Refresh | Schedule during off-peak hours |

---

## Next Steps

- Continue to [Tutorial 12: Security Configuration](12-security.md)
- Explore [Power BI Best Practices](../../best-practices/power-bi-optimization.md)
- Review [Power BI Troubleshooting](../../troubleshooting/power-bi-troubleshooting.md)
