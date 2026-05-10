---
title: "️ Interactive Schema Designer"
tags:
  - multimedia
  - demos
---
# 🗂️ Interactive Schema Designer

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Interactive](https://img.shields.io/badge/Type-Interactive-purple)
![Difficulty: Intermediate](https://img.shields.io/badge/Difficulty-Intermediate-yellow)

## 📋 Overview

Visual schema design tool for Azure Synapse SQL pools. Design tables, define relationships, configure distributions and partitions, and generate DDL scripts automatically.

**Duration:** 30-45 minutes | **Format:** Visual ER diagram designer | **Prerequisites:** Database design knowledge

## 🎯 Learning Objectives

- Design database schemas visually
- Configure table distributions for Synapse
- Define indexes and partitions
- Model relationships and foreign keys
- Generate optimized DDL scripts
- Validate schema designs

## 🚀 Schema Designer Features

### Table Configuration

```javascript
const tableDesigner = {
  table: {
    name: 'FactSales',
    schema: 'dbo',
    distribution: {
      type: 'HASH',
      column: 'SalesOrderID'
    },
    indexing: {
      type: 'CLUSTERED COLUMNSTORE INDEX'
    },
    partition: {
      column: 'OrderDate',
      type: 'RANGE RIGHT',
      values: ['2024-01-01', '2024-02-01', '2024-03-01']
    },
    columns: [
      { name: 'SalesOrderID', type: 'INT', nullable: false, pk: true },
      { name: 'OrderDate', type: 'DATE', nullable: false },
      { name: 'CustomerID', type: 'INT', nullable: false },
      { name: 'Revenue', type: 'DECIMAL(18,2)', nullable: false }
    ]
  }
};
```

### Generated DDL

```sql
-- Auto-generated from schema designer
CREATE TABLE dbo.FactSales
(
    SalesOrderID INT NOT NULL,
    OrderDate DATE NOT NULL,
    CustomerID INT NOT NULL,
    ProductID INT NOT NULL,
    Revenue DECIMAL(18,2) NOT NULL,
    Quantity INT NOT NULL
)
WITH
(
    DISTRIBUTION = HASH(SalesOrderID),
    CLUSTERED COLUMNSTORE INDEX,
    PARTITION
    (
        OrderDate RANGE RIGHT FOR VALUES
        ('2024-01-01', '2024-02-01', '2024-03-01',
         '2024-04-01', '2024-05-01', '2024-06-01',
         '2024-07-01', '2024-08-01', '2024-09-01',
         '2024-10-01', '2024-11-01', '2024-12-01')
    )
);

-- Statistics
CREATE STATISTICS stats_SalesOrderID ON dbo.FactSales (SalesOrderID);
CREATE STATISTICS stats_CustomerID ON dbo.FactSales (CustomerID);
CREATE STATISTICS stats_OrderDate ON dbo.FactSales (OrderDate);
```

## 📊 Schema Patterns

### Star Schema Design

```javascript
const starSchema = {
  factTables: [
    {
      name: 'FactSales',
      distribution: 'HASH(SalesOrderID)',
      partitioning: 'OrderDate'
    }
  ],
  dimensionTables: [
    {
      name: 'DimCustomer',
      distribution: 'REPLICATE',
      scdType: 2
    },
    {
      name: 'DimProduct',
      distribution: 'REPLICATE'
    },
    {
      name: 'DimDate',
      distribution: 'REPLICATE'
    }
  ]
};
```

## 🔧 Troubleshooting

### Schema Validation

```javascript
const schemaValidator = {
  rules: [
    {
      name: 'Large fact table distribution',
      check: (table) => table.estimatedRows > 1000000 && table.distribution === 'ROUND_ROBIN',
      message: 'Consider HASH distribution for large fact tables',
      severity: 'warning'
    },
    {
      name: 'Small dimension replication',
      check: (table) => table.estimatedRows < 100000 && table.distribution !== 'REPLICATE',
      message: 'Small dimensions should use REPLICATE distribution',
      severity: 'warning'
    }
  ]
};
```

## 🔗 Embedded Demo Link

**Launch Schema Designer:** [https://demos.csa-inabox.com/schema-designer](https://demos.csa-inabox.com/schema-designer)

## 📚 Additional Resources

- [Table Design Guide](../../05-best-practices/cross-cutting-concerns/performance/performance-optimization.md)
- [Distribution Strategies](../../03-architecture-patterns/reference-architectures/README.md)

## 💬 Feedback

> **💡 Schema Designer feedback**

- ✅ **Designed optimal schemas** - [Share success](https://github.com/csa-inabox/docs/discussions)
- ⚠️ **Feature request** - [Suggest improvement](https://github.com/csa-inabox/docs/issues/new)

---

*Last Updated: January 2025 | Version: 1.0.0*
