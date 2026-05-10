---
title: "SQL Query Interactive Playground"
tags:
  - multimedia
  - demos
---
# 🎯 SQL Query Interactive Playground

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Interactive](https://img.shields.io/badge/Type-Interactive-purple)
![Difficulty: Beginner](https://img.shields.io/badge/Difficulty-Beginner-green)

## 📋 Overview

An interactive SQL query playground specifically designed for Azure Synapse Analytics. Experiment with T-SQL queries, explore serverless and dedicated SQL pool features, and learn optimization techniques in a safe, sandboxed environment.

**Duration:** Self-paced
**Format:** Live SQL editor with instant execution
**Prerequisites:** Basic SQL knowledge

## 🎯 Learning Objectives

- Write and execute T-SQL queries against sample databases
- Understand Synapse-specific SQL features and syntax
- Practice query optimization techniques
- Explore distributed query execution
- Learn table design patterns (distribution, partitioning, indexing)
- Compare serverless vs dedicated SQL pool performance

## 🚀 Prerequisites and Setup

### Access Requirements

- **Browser-Based:** No installation required
- **Sample Databases:** Pre-configured with realistic data
- **Query History:** Auto-saved for session
- **Export Results:** Download as CSV, JSON, or Excel

### Database Configuration

```sql
-- Available sample databases
USE AdventureWorksLT;
USE ContosoRetailDW;
USE SampleWarehouse;

-- Check available tables
SELECT
    s.name AS schema_name,
    t.name AS table_name,
    p.rows AS row_count
FROM sys.tables t
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
INNER JOIN sys.partitions p ON t.object_id = p.object_id
WHERE p.index_id IN (0, 1)
ORDER BY s.name, t.name;
```

## 🎮 Interactive Features

### SQL Editor Features

```javascript
// SQL Editor Configuration
const sqlEditorConfig = {
  theme: 'monokai',
  mode: 'text/x-mssql',
  lineNumbers: true,
  autoCloseBrackets: true,
  matchBrackets: true,
  indentWithTabs: false,
  tabSize: 2,

  // Syntax highlighting
  keywords: [
    'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING',
    'ORDER BY', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
    'INNER JOIN', 'OUTER JOIN', 'UNION', 'INTERSECT',
    'EXCEPT', 'WITH', 'INSERT', 'UPDATE', 'DELETE',
    'CREATE', 'ALTER', 'DROP', 'INDEX', 'VIEW'
  ],

  // Synapse-specific keywords
  synapseKeywords: [
    'DISTRIBUTION', 'HASH', 'ROUND_ROBIN', 'REPLICATE',
    'PARTITION', 'COLUMNSTORE', 'CLUSTERED', 'HEAP',
    'OPENROWSET', 'EXTERNAL', 'DATA_SOURCE'
  ],

  // Auto-completion
  hintOptions: {
    tables: true,
    columns: true,
    keywords: true,
    functions: true
  }
};
```

### Query Execution Features

```javascript
// Query execution with performance metrics
const executeQuery = async (sql) => {
  const startTime = performance.now();

  try {
    const result = await fetch('/api/query/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: sql,
        poolType: 'serverless' // or 'dedicated'
      })
    });

    const data = await result.json();
    const endTime = performance.now();

    return {
      rows: data.rows,
      rowCount: data.rowCount,
      executionTime: endTime - startTime,
      dataScanned: data.dataScanned,
      cost: data.estimatedCost,
      plan: data.executionPlan
    };
  } catch (error) {
    console.error('Query execution failed:', error);
    throw error;
  }
};
```

## 📚 Sample Queries and Tutorials

### Tutorial 1: Basic Queries

```sql
-- ============================================
-- Tutorial 1: Basic SELECT Queries
-- ============================================

-- 1. Simple SELECT
SELECT TOP 10 *
FROM Sales.SalesOrderHeader;

-- 2. SELECT specific columns
SELECT
    SalesOrderID,
    OrderDate,
    CustomerID,
    TotalDue
FROM Sales.SalesOrderHeader
ORDER BY OrderDate DESC;

-- 3. WHERE clause with conditions
SELECT
    ProductID,
    Name,
    ListPrice
FROM Production.Product
WHERE ListPrice > 1000
    AND Color = 'Red'
ORDER BY ListPrice DESC;

-- 4. LIKE operator for pattern matching
SELECT
    CustomerID,
    FirstName,
    LastName
FROM Sales.Customer
WHERE LastName LIKE 'S%'
ORDER BY LastName;

-- 5. IN operator
SELECT
    ProductID,
    Name,
    Color
FROM Production.Product
WHERE Color IN ('Black', 'Silver', 'Red')
ORDER BY Color, Name;

-- 6. BETWEEN operator
SELECT
    SalesOrderID,
    OrderDate,
    TotalDue
FROM Sales.SalesOrderHeader
WHERE OrderDate BETWEEN '2024-01-01' AND '2024-12-31'
ORDER BY OrderDate;

-- ✅ Exercise: Write a query to find all products
-- with 'Mountain' in the name and price between $500 and $1500
-- Write your code below:

```

### Tutorial 2: Joins and Relationships

```sql
-- ============================================
-- Tutorial 2: Joins
-- ============================================

-- 1. INNER JOIN - Only matching rows
SELECT
    soh.SalesOrderID,
    soh.OrderDate,
    c.FirstName,
    c.LastName,
    soh.TotalDue
FROM Sales.SalesOrderHeader soh
INNER JOIN Sales.Customer c
    ON soh.CustomerID = c.CustomerID
WHERE soh.OrderDate >= '2024-01-01'
ORDER BY soh.OrderDate DESC;

-- 2. LEFT JOIN - All rows from left table
SELECT
    p.ProductID,
    p.Name AS ProductName,
    pc.Name AS CategoryName
FROM Production.Product p
LEFT JOIN Production.ProductCategory pc
    ON p.ProductCategoryID = pc.ProductCategoryID
ORDER BY p.Name;

-- 3. Multiple joins
SELECT
    soh.SalesOrderID,
    soh.OrderDate,
    c.FirstName + ' ' + c.LastName AS CustomerName,
    p.Name AS ProductName,
    sod.OrderQty,
    sod.LineTotal
FROM Sales.SalesOrderHeader soh
INNER JOIN Sales.Customer c
    ON soh.CustomerID = c.CustomerID
INNER JOIN Sales.SalesOrderDetail sod
    ON soh.SalesOrderID = sod.SalesOrderID
INNER JOIN Production.Product p
    ON sod.ProductID = p.ProductID
WHERE soh.OrderDate >= '2024-01-01'
ORDER BY soh.OrderDate DESC, soh.SalesOrderID, sod.SalesOrderDetailID;

-- 4. Self-join - Find related products
SELECT
    p1.ProductID AS Product1ID,
    p1.Name AS Product1Name,
    p2.ProductID AS Product2ID,
    p2.Name AS Product2Name
FROM Production.Product p1
INNER JOIN Production.Product p2
    ON p1.ProductCategoryID = p2.ProductCategoryID
    AND p1.ProductID < p2.ProductID
WHERE p1.ProductCategoryID IS NOT NULL
ORDER BY p1.Name;

-- ✅ Exercise: Write a query joining SalesOrderHeader,
-- Customer, and SalesOrderDetail to show total revenue
-- per customer for 2024.
-- Write your code below:

```

### Tutorial 3: Aggregations and Grouping

```sql
-- ============================================
-- Tutorial 3: Aggregations
-- ============================================

-- 1. Basic aggregation functions
SELECT
    COUNT(*) AS TotalOrders,
    SUM(TotalDue) AS TotalRevenue,
    AVG(TotalDue) AS AverageOrderValue,
    MIN(TotalDue) AS MinimumOrder,
    MAX(TotalDue) AS MaximumOrder
FROM Sales.SalesOrderHeader
WHERE OrderDate >= '2024-01-01';

-- 2. GROUP BY with aggregations
SELECT
    YEAR(OrderDate) AS OrderYear,
    MONTH(OrderDate) AS OrderMonth,
    COUNT(*) AS OrderCount,
    SUM(TotalDue) AS MonthlyRevenue,
    AVG(TotalDue) AS AvgOrderValue
FROM Sales.SalesOrderHeader
GROUP BY YEAR(OrderDate), MONTH(OrderDate)
ORDER BY OrderYear DESC, OrderMonth DESC;

-- 3. HAVING clause - filter aggregated results
SELECT
    CustomerID,
    COUNT(*) AS OrderCount,
    SUM(TotalDue) AS TotalSpent
FROM Sales.SalesOrderHeader
WHERE OrderDate >= '2024-01-01'
GROUP BY CustomerID
HAVING COUNT(*) >= 5
ORDER BY TotalSpent DESC;

-- 4. GROUP BY with joins
SELECT
    pc.Name AS Category,
    COUNT(DISTINCT p.ProductID) AS ProductCount,
    AVG(p.ListPrice) AS AvgPrice,
    MIN(p.ListPrice) AS MinPrice,
    MAX(p.ListPrice) AS MaxPrice
FROM Production.Product p
INNER JOIN Production.ProductCategory pc
    ON p.ProductCategoryID = pc.ProductCategoryID
GROUP BY pc.Name
ORDER BY ProductCount DESC;

-- 5. GROUPING SETS - multiple grouping levels
SELECT
    YEAR(OrderDate) AS OrderYear,
    MONTH(OrderDate) AS OrderMonth,
    CustomerID,
    SUM(TotalDue) AS Revenue
FROM Sales.SalesOrderHeader
WHERE OrderDate >= '2023-01-01'
GROUP BY GROUPING SETS (
    (YEAR(OrderDate), MONTH(OrderDate)),
    (CustomerID),
    ()
)
ORDER BY OrderYear, OrderMonth, CustomerID;

-- 6. ROLLUP - hierarchical aggregations
SELECT
    pc.Name AS Category,
    p.Color,
    COUNT(*) AS ProductCount,
    AVG(p.ListPrice) AS AvgPrice
FROM Production.Product p
INNER JOIN Production.ProductCategory pc
    ON p.ProductCategoryID = pc.ProductCategoryID
GROUP BY ROLLUP(pc.Name, p.Color)
ORDER BY pc.Name, p.Color;

-- ✅ Exercise: Calculate total revenue and order count
-- by product category for Q1 2024. Show only categories
-- with revenue > $10,000.
-- Write your code below:

```

### Tutorial 4: Window Functions

```sql
-- ============================================
-- Tutorial 4: Window Functions
-- ============================================

-- 1. ROW_NUMBER - Assign unique sequential numbers
SELECT
    SalesOrderID,
    CustomerID,
    OrderDate,
    TotalDue,
    ROW_NUMBER() OVER (
        PARTITION BY CustomerID
        ORDER BY OrderDate DESC
    ) AS OrderSequence
FROM Sales.SalesOrderHeader
WHERE OrderDate >= '2024-01-01'
ORDER BY CustomerID, OrderDate DESC;

-- 2. RANK and DENSE_RANK
SELECT
    ProductID,
    Name,
    ListPrice,
    RANK() OVER (ORDER BY ListPrice DESC) AS PriceRank,
    DENSE_RANK() OVER (ORDER BY ListPrice DESC) AS DensePriceRank,
    NTILE(4) OVER (ORDER BY ListPrice DESC) AS PriceQuartile
FROM Production.Product
WHERE ListPrice > 0
ORDER BY ListPrice DESC;

-- 3. Running totals with SUM
SELECT
    OrderDate,
    SalesOrderID,
    TotalDue,
    SUM(TotalDue) OVER (
        ORDER BY OrderDate, SalesOrderID
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS RunningTotal
FROM Sales.SalesOrderHeader
WHERE OrderDate >= '2024-01-01'
ORDER BY OrderDate, SalesOrderID;

-- 4. Moving averages
SELECT
    OrderDate,
    TotalDue,
    AVG(TotalDue) OVER (
        ORDER BY OrderDate
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS MovingAvg7Day,
    AVG(TotalDue) OVER (
        ORDER BY OrderDate
        ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) AS MovingAvg30Day
FROM Sales.SalesOrderHeader
WHERE OrderDate >= '2024-01-01'
ORDER BY OrderDate;

-- 5. LAG and LEAD - Access previous/next rows
SELECT
    OrderDate,
    SalesOrderID,
    TotalDue,
    LAG(TotalDue, 1) OVER (ORDER BY OrderDate) AS PreviousOrderValue,
    LEAD(TotalDue, 1) OVER (ORDER BY OrderDate) AS NextOrderValue,
    TotalDue - LAG(TotalDue, 1) OVER (ORDER BY OrderDate) AS ValueChange
FROM Sales.SalesOrderHeader
WHERE OrderDate >= '2024-01-01'
ORDER BY OrderDate;

-- 6. FIRST_VALUE and LAST_VALUE
SELECT
    CustomerID,
    OrderDate,
    TotalDue,
    FIRST_VALUE(TotalDue) OVER (
        PARTITION BY CustomerID
        ORDER BY OrderDate
    ) AS FirstOrderValue,
    LAST_VALUE(TotalDue) OVER (
        PARTITION BY CustomerID
        ORDER BY OrderDate
        ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
    ) AS LastOrderValue
FROM Sales.SalesOrderHeader
WHERE OrderDate >= '2024-01-01'
ORDER BY CustomerID, OrderDate;

-- ✅ Exercise: Find the top 3 products by revenue in each
-- category. Show product name, category, revenue, and rank.
-- Write your code below:

```

### Tutorial 5: Common Table Expressions (CTEs)

```sql
-- ============================================
-- Tutorial 5: CTEs and Subqueries
-- ============================================

-- 1. Simple CTE
WITH MonthlySales AS (
    SELECT
        YEAR(OrderDate) AS OrderYear,
        MONTH(OrderDate) AS OrderMonth,
        SUM(TotalDue) AS MonthlyRevenue
    FROM Sales.SalesOrderHeader
    WHERE OrderDate >= '2023-01-01'
    GROUP BY YEAR(OrderDate), MONTH(OrderDate)
)
SELECT
    OrderYear,
    OrderMonth,
    MonthlyRevenue,
    AVG(MonthlyRevenue) OVER (
        PARTITION BY OrderYear
        ORDER BY OrderMonth
        ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
    ) AS ThreeMonthAvg
FROM MonthlySales
ORDER BY OrderYear DESC, OrderMonth DESC;

-- 2. Multiple CTEs
WITH CustomerRevenue AS (
    SELECT
        CustomerID,
        SUM(TotalDue) AS TotalRevenue,
        COUNT(*) AS OrderCount
    FROM Sales.SalesOrderHeader
    WHERE OrderDate >= '2024-01-01'
    GROUP BY CustomerID
),
CustomerSegments AS (
    SELECT
        CustomerID,
        TotalRevenue,
        OrderCount,
        CASE
            WHEN TotalRevenue >= 10000 THEN 'Premium'
            WHEN TotalRevenue >= 5000 THEN 'Gold'
            WHEN TotalRevenue >= 1000 THEN 'Silver'
            ELSE 'Bronze'
        END AS Segment
    FROM CustomerRevenue
)
SELECT
    Segment,
    COUNT(*) AS CustomerCount,
    AVG(TotalRevenue) AS AvgRevenue,
    SUM(TotalRevenue) AS TotalRevenue
FROM CustomerSegments
GROUP BY Segment
ORDER BY TotalRevenue DESC;

-- 3. Recursive CTE - Date dimension
WITH DateDimension AS (
    -- Anchor: starting date
    SELECT CAST('2024-01-01' AS DATE) AS DateValue

    UNION ALL

    -- Recursive: add one day
    SELECT DATEADD(day, 1, DateValue)
    FROM DateDimension
    WHERE DateValue < '2024-12-31'
)
SELECT
    DateValue,
    YEAR(DateValue) AS Year,
    MONTH(DateValue) AS Month,
    DAY(DateValue) AS Day,
    DATENAME(WEEKDAY, DateValue) AS DayOfWeek,
    DATEPART(WEEK, DateValue) AS WeekNumber
FROM DateDimension
OPTION (MAXRECURSION 366);

-- 4. CTE with joins
WITH ProductSales AS (
    SELECT
        p.ProductID,
        p.Name AS ProductName,
        pc.Name AS CategoryName,
        SUM(sod.LineTotal) AS TotalRevenue,
        SUM(sod.OrderQty) AS TotalQuantity
    FROM Production.Product p
    INNER JOIN Production.ProductCategory pc
        ON p.ProductCategoryID = pc.ProductCategoryID
    INNER JOIN Sales.SalesOrderDetail sod
        ON p.ProductID = sod.ProductID
    INNER JOIN Sales.SalesOrderHeader soh
        ON sod.SalesOrderID = soh.SalesOrderID
    WHERE soh.OrderDate >= '2024-01-01'
    GROUP BY p.ProductID, p.Name, pc.Name
)
SELECT
    CategoryName,
    ProductName,
    TotalRevenue,
    TotalQuantity,
    RANK() OVER (
        PARTITION BY CategoryName
        ORDER BY TotalRevenue DESC
    ) AS RevenueRankInCategory
FROM ProductSales
ORDER BY CategoryName, RevenueRankInCategory;

-- ✅ Exercise: Use CTEs to find customers who made purchases
-- in all months of Q1 2024 (January, February, March).
-- Write your code below:

```

### Tutorial 6: Synapse-Specific Features

```sql
-- ============================================
-- Tutorial 6: Synapse SQL Pool Features
-- ============================================

-- 1. Query external data with OPENROWSET (Serverless SQL)
SELECT TOP 10 *
FROM OPENROWSET(
    BULK 'https://yourstorage.dfs.core.windows.net/data/sales/*.parquet',
    FORMAT = 'PARQUET'
) AS sales_data;

-- 2. Create external table
CREATE EXTERNAL TABLE ext.SalesData
(
    SalesOrderID INT,
    OrderDate DATE,
    CustomerID INT,
    TotalDue DECIMAL(18,2)
)
WITH
(
    LOCATION = 'sales/data/',
    DATA_SOURCE = AzureDataLake,
    FILE_FORMAT = ParquetFormat
);

-- 3. Table distribution strategies (Dedicated SQL Pool)

-- Hash distribution (for large fact tables)
CREATE TABLE dbo.FactSales
(
    SalesOrderID INT NOT NULL,
    OrderDate DATE NOT NULL,
    CustomerID INT NOT NULL,
    ProductID INT NOT NULL,
    Revenue DECIMAL(18,2) NOT NULL
)
WITH
(
    DISTRIBUTION = HASH(SalesOrderID),
    CLUSTERED COLUMNSTORE INDEX
);

-- Round-robin distribution (for staging tables)
CREATE TABLE staging.SalesStaging
(
    SalesOrderID INT,
    OrderDate DATE,
    Revenue DECIMAL(18,2)
)
WITH
(
    DISTRIBUTION = ROUND_ROBIN,
    HEAP
);

-- Replicated distribution (for small dimension tables)
CREATE TABLE dbo.DimProduct
(
    ProductID INT NOT NULL,
    ProductName NVARCHAR(100),
    Category NVARCHAR(50)
)
WITH
(
    DISTRIBUTION = REPLICATE,
    CLUSTERED COLUMNSTORE INDEX
);

-- 4. Table partitioning
CREATE TABLE dbo.FactSalesPartitioned
(
    SalesOrderID INT NOT NULL,
    OrderDate DATE NOT NULL,
    Revenue DECIMAL(18,2)
)
WITH
(
    DISTRIBUTION = HASH(SalesOrderID),
    CLUSTERED COLUMNSTORE INDEX,
    PARTITION
    (
        OrderDate RANGE RIGHT FOR VALUES
        (
            '2024-01-01', '2024-02-01', '2024-03-01',
            '2024-04-01', '2024-05-01', '2024-06-01',
            '2024-07-01', '2024-08-01', '2024-09-01',
            '2024-10-01', '2024-11-01', '2024-12-01'
        )
    )
);

-- 5. Statistics management
CREATE STATISTICS stats_customer_id
ON dbo.FactSales (CustomerID);

UPDATE STATISTICS dbo.FactSales;

-- 6. Query performance monitoring
SELECT
    request_id,
    status,
    submit_time,
    start_time,
    end_time,
    total_elapsed_time,
    command
FROM sys.dm_pdw_exec_requests
WHERE session_id = SESSION_ID()
ORDER BY submit_time DESC;

-- ✅ Exercise: Design a partitioned and distributed table
-- for storing daily sales data with 2 years of history.
-- Write your DDL below:

```

## 💡 Query Optimization Tips

### Built-in Query Analyzer

```javascript
// Query performance analysis
const analyzeQuery = (sql) => {
  const analysis = {
    estimatedCost: 0,
    warnings: [],
    suggestions: [],
    executionPlan: null
  };

  // Check for common anti-patterns
  if (sql.includes('SELECT *')) {
    analysis.warnings.push({
      type: 'SELECT_STAR',
      message: 'Avoid SELECT * in production queries',
      suggestion: 'Specify only the columns you need'
    });
  }

  if (!sql.toUpperCase().includes('WHERE')) {
    analysis.warnings.push({
      type: 'MISSING_WHERE',
      message: 'Query scans entire table',
      suggestion: 'Add WHERE clause to filter data'
    });
  }

  if (sql.match(/LEFT JOIN.*WHERE.*IS NOT NULL/i)) {
    analysis.suggestions.push({
      type: 'JOIN_TYPE',
      message: 'LEFT JOIN with IS NOT NULL can be INNER JOIN',
      suggestion: 'Consider using INNER JOIN for better performance'
    });
  }

  return analysis;
};
```

### Performance Comparison Tool

```sql
-- Compare query performance
-- Original query (slow)
SET STATISTICS TIME, IO ON;

SELECT *
FROM Sales.SalesOrderHeader soh
LEFT JOIN Sales.Customer c ON soh.CustomerID = c.CustomerID
WHERE c.CustomerID IS NOT NULL;

-- Optimized query (faster)
SELECT
    soh.SalesOrderID,
    soh.OrderDate,
    soh.TotalDue,
    c.FirstName,
    c.LastName
FROM Sales.SalesOrderHeader soh
INNER JOIN Sales.Customer c ON soh.CustomerID = c.CustomerID;

SET STATISTICS TIME, IO OFF;
```

## 🔧 Troubleshooting

### Common SQL Errors

#### Error: Column Ambiguity

```sql
-- ❌ Error: Ambiguous column name
SELECT CustomerID, Name
FROM Sales.SalesOrderHeader soh
JOIN Sales.Customer c ON soh.CustomerID = c.CustomerID;

-- ✅ Solution: Qualify column names
SELECT
    soh.SalesOrderID,
    c.CustomerID,
    c.FirstName + ' ' + c.LastName AS CustomerName
FROM Sales.SalesOrderHeader soh
JOIN Sales.Customer c ON soh.CustomerID = c.CustomerID;
```

#### Error: Data Type Mismatch

```sql
-- ❌ Error: Cannot convert varchar to int
SELECT *
FROM Sales.SalesOrderHeader
WHERE CustomerID = '123ABC';

-- ✅ Solution: Use correct data type
SELECT *
FROM Sales.SalesOrderHeader
WHERE CustomerID = 123;
```

#### Error: Aggregate Function Misuse

```sql
-- ❌ Error: Column not in GROUP BY or aggregate
SELECT CustomerID, OrderDate, SUM(TotalDue)
FROM Sales.SalesOrderHeader
GROUP BY CustomerID;

-- ✅ Solution: Include all non-aggregated columns
SELECT
    CustomerID,
    SUM(TotalDue) AS TotalRevenue,
    COUNT(*) AS OrderCount
FROM Sales.SalesOrderHeader
GROUP BY CustomerID;
```

## 🔗 Embedded Demo Link

**Launch SQL Playground:** [https://demos.csa-inabox.com/sql-playground](https://demos.csa-inabox.com/sql-playground)

**Features:**

- Syntax highlighting and auto-completion
- Real-time query validation
- Performance metrics display
- Query history and favorites
- Share queries via URL
- Export results (CSV, JSON, Excel)

## 📚 Additional Resources

- [T-SQL Reference](https://docs.microsoft.com/sql/t-sql/)
- [Synapse SQL Best Practices](../../best-practices/sql-performance.md)
- [Query Optimization Guide](../../best-practices/performance-optimization.md)
- [Serverless SQL Pool Guide](../../architecture/serverless-sql/README.md)

## 💬 Feedback

> **💡 How helpful was the SQL Playground?**

- ✅ **Very useful** - [Star the project](https://github.com/csa-inabox/docs)
- ⚠️ **Found a bug** - [Report issue](https://github.com/csa-inabox/docs/issues/new)
- 💡 **Feature idea** - [Suggest enhancement](https://github.com/csa-inabox/docs/issues/new?title=[SQL]+Feature)

---

*Last Updated: January 2025 | Version: 1.0.0*
