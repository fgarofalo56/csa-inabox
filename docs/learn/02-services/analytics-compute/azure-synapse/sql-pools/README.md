---
title: "️ Azure Synapse SQL Pools"
description: "SQL Pools in Azure Synapse provide both serverless and dedicated SQL compute options for data warehousing and analytics workloads."
tags:
  - services
  - synapse
  - sql-pools
---
# 🗄️ Azure Synapse SQL Pools

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Tier](https://img.shields.io/badge/Tier-Enterprise-purple?style=flat-square)

SQL Pools in Azure Synapse provide both serverless and dedicated SQL compute options for data warehousing and analytics workloads.

---

## 🌟 Overview

Azure Synapse SQL Pools offer two distinct compute models to meet different analytical needs:

- __Serverless SQL Pools__: Pay-per-query model for ad-hoc analytics
- __Dedicated SQL Pools__: Reserved capacity for consistent, high-performance workloads

Both share T-SQL compatibility and seamless integration with Azure data services.

---

## 📊 SQL Pool Types Comparison

| Feature | Serverless SQL | Dedicated SQL |
|---------|----------------|---------------|
| __Pricing Model__ | Pay per TB processed | Reserved DWUs |
| __Infrastructure__ | No management | Managed capacity |
| __Use Case__ | Ad-hoc queries | Data warehousing |
| __Scale__ | Automatic | Manual/Scheduled |
| __Performance__ | Variable | Predictable |
| __Storage__ | Data Lake | Internal + External |
| __Startup Time__ | Instant | Minutes |
| __Best For__ | Exploration, BI | Production DW |

---

## 🎯 Pool Selection Guide

### Choose Serverless SQL When

- Querying data lake files (Parquet, CSV, JSON)
- Exploratory data analysis
- Cost optimization for variable workloads
- No infrastructure management needed
- Prototyping and development
- Infrequent query patterns

### Choose Dedicated SQL When

- Consistent high-performance requirements
- Enterprise data warehousing
- Complex ETL/ELT workflows
- Predictable workload patterns
- Advanced performance tuning needed
- Regulatory compliance requiring dedicated resources

---

## 🗂️ Pool Components

### ⚡ [Serverless SQL Pools](serverless-sql/README.md)

![Pay-per-Query](https://img.shields.io/badge/Pricing-Pay%20per%20Query-blue?style=flat-square)

Query data in your data lake without provisioning infrastructure.

__Key Features__:
- Automatic scaling
- T-SQL support for file formats
- No infrastructure to manage
- Integration with data lake

__[📖 Complete Guide →](serverless-sql/README.md)__

---

### 🏢 [Dedicated SQL Pools](dedicated-sql/README.md)

![Reserved Capacity](https://img.shields.io/badge/Pricing-Reserved%20Capacity-purple?style=flat-square)

Enterprise-grade data warehousing with predictable performance.

__Key Features__:
- Massively Parallel Processing (MPP)
- Advanced performance features
- Enterprise security
- Predictable performance

__[📖 Complete Guide →](dedicated-sql/README.md)__

---

## 🚀 Quick Start Examples

### Serverless SQL: Query Data Lake

```sql
-- Query Parquet files directly
SELECT
    ProductID,
    ProductName,
    SUM(Quantity) as TotalQuantity,
    SUM(Revenue) as TotalRevenue
FROM OPENROWSET(
    BULK 'https://myaccount.dfs.core.windows.net/sales/year=2024/*/*.parquet',
    FORMAT = 'PARQUET'
) AS sales
GROUP BY ProductID, ProductName
ORDER BY TotalRevenue DESC;
```

### Dedicated SQL: Create Warehouse Table

```sql
-- Create distributed table
CREATE TABLE dbo.FactSales
(
    SalesKey BIGINT NOT NULL,
    DateKey INT NOT NULL,
    CustomerKey INT NOT NULL,
    ProductKey INT NOT NULL,
    Quantity INT NOT NULL,
    Amount DECIMAL(19,4) NOT NULL
)
WITH
(
    DISTRIBUTION = HASH(CustomerKey),
    CLUSTERED COLUMNSTORE INDEX
);
```

---

*Last Updated: 2025-01-28*
*Service Version: General Availability*
*Documentation Status: Complete*
