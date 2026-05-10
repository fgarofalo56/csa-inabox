---
title: "️ Data Flow Interactive Designer"
tags:
  - multimedia
  - demos
---
# 🗺️ Data Flow Interactive Designer

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Interactive](https://img.shields.io/badge/Type-Interactive-purple)
![Difficulty: Advanced](https://img.shields.io/badge/Difficulty-Advanced-red)

## 📋 Overview

Interactive visual designer for creating Azure Synapse Mapping Data Flows. Build complex ETL transformations using a code-free, drag-and-drop interface with real-time data preview and optimization suggestions.

**Duration:** 45-60 minutes
**Format:** Visual transformation designer
**Prerequisites:** Understanding of ETL concepts and data transformations

## 🎯 Learning Objectives

- Design data transformations visually without code
- Implement common ETL patterns (SCD, deduplication, aggregations)
- Optimize data flows for performance
- Debug and preview data at each transformation step
- Export data flow definitions for deployment
- Understand Spark execution behind data flows

## 🚀 Prerequisites and Setup

### Access Requirements

- **Browser-Based:** HTML5-compatible browser
- **Sample Data:** Pre-loaded datasets for testing
- **Real-Time Preview:** Data sampling at each step
- **Validation:** Automatic schema and logic checking

### Transformation Components

```javascript
const transformationComponents = {
  sources: ['Azure SQL', 'Data Lake', 'Blob Storage', 'Cosmos DB'],
  destinations: ['Azure SQL', 'Data Lake', 'Synapse SQL Pool'],
  rowModifier: ['Filter', 'Select', 'Derived Column', 'Surrogate Key'],
  schemaModifier: ['Pivot', 'Unpivot', 'Flatten', 'Parse'],
  multipleInputs: ['Join', 'Union', 'Exists', 'Lookup'],
  rowset: ['Aggregate', 'Sort', 'Window', 'Rank'],
  formatters: ['Stringify', 'Flatten', 'Assert']
};
```

## 🎨 Designer Interface

### Transformation Patterns

#### Pattern 1: Slowly Changing Dimension (Type 2)

```json
{
  "name": "SCD_Type2_Customer",
  "transformations": [
    {
      "name": "SourceCustomers",
      "type": "source",
      "dataset": "CustomerDelta"
    },
    {
      "name": "CurrentDimension",
      "type": "source",
      "dataset": "DimCustomer"
    },
    {
      "name": "DeriveHashKey",
      "type": "derivedColumn",
      "columns": [
        {
          "name": "HashKey",
          "expression": "sha2(256, concat(CustomerName, Address, City))"
        }
      ]
    },
    {
      "name": "Lookup",
      "type": "lookup",
      "leftStream": "DeriveHashKey",
      "rightStream": "CurrentDimension",
      "lookupConditions": ["CustomerID == CustomerID"],
      "multiple": false
    },
    {
      "name": "DeriveAction",
      "type": "derivedColumn",
      "columns": [
        {
          "name": "Action",
          "expression": "iif(isNull(DimCustomerID), 'INSERT', iif(HashKey != CurrentHashKey, 'UPDATE', 'NOCHANGE'))"
        }
      ]
    },
    {
      "name": "FilterChanges",
      "type": "filter",
      "condition": "Action != 'NOCHANGE'"
    },
    {
      "name": "SetDates",
      "type": "derivedColumn",
      "columns": [
        {
          "name": "EffectiveDate",
          "expression": "currentTimestamp()"
        },
        {
          "name": "IsActive",
          "expression": "true()"
        }
      ]
    },
    {
      "name": "SinkDimension",
      "type": "sink",
      "dataset": "DimCustomer",
      "updateMethod": "upsert",
      "keys": ["CustomerID"]
    }
  ]
}
```

#### Pattern 2: Deduplication

```json
{
  "name": "DeduplicateRecords",
  "transformations": [
    {
      "name": "Source",
      "type": "source"
    },
    {
      "name": "Window",
      "type": "window",
      "over": "CustomerID",
      "orderBy": "LastModifiedDate desc",
      "windowColumns": [
        {
          "name": "RowNumber",
          "windowFunction": "rowNumber()"
        }
      ]
    },
    {
      "name": "FilterFirst",
      "type": "filter",
      "condition": "RowNumber == 1"
    },
    {
      "name": "Sink",
      "type": "sink"
    }
  ]
}
```

## 📚 Tutorial Examples

### Tutorial 1: Basic Transformations

**Step 1: Filter and Select**

```javascript
// Visual configuration translates to:
df = df.filter(col("Revenue") > 1000)
  .select("CustomerID", "OrderDate", "Revenue");
```

**Step 2: Derived Columns**

```javascript
// Add calculated fields
df = df.withColumn("TaxAmount", col("Revenue") * 0.08)
  .withColumn("TotalWithTax", col("Revenue") + col("TaxAmount"));
```

**Step 3: Aggregate**

```javascript
// Group and aggregate
df = df.groupBy("CustomerID", "OrderMonth")
  .agg(
    sum("Revenue").alias("TotalRevenue"),
    count("*").alias("OrderCount")
  );
```

### Tutorial 2: Advanced Joins

**Multiple Join Types:**

```json
{
  "joins": [
    {
      "type": "inner",
      "left": "Orders",
      "right": "Customers",
      "condition": "Orders.CustomerID == Customers.CustomerID"
    },
    {
      "type": "left",
      "left": "Orders",
      "right": "Products",
      "condition": "Orders.ProductID == Products.ProductID"
    }
  ]
}
```

## 💡 Performance Optimization Features

### Auto-Optimization Suggestions

```javascript
const optimizationRules = {
  partitioning: {
    rule: 'Large dataset without partitioning',
    suggestion: 'Add hash partitioning on join keys',
    impact: 'High - 40-60% improvement'
  },
  broadcasting: {
    rule: 'Small dimension table in join',
    suggestion: 'Enable broadcast join',
    impact: 'High - Eliminates shuffle'
  },
  caching: {
    rule: 'Data flow reused multiple times',
    suggestion: 'Enable sink caching',
    impact: 'Medium - Reduces recomputation'
  }
};
```

### Data Preview and Debugging

```javascript
// Preview data at any transformation step
const previewData = {
  sampleSize: 100,
  refreshInterval: 5000, // 5 seconds
  showSchema: true,
  showStatistics: true
};

// Debug mode features
const debugMode = {
  rowLimits: true,
  maxRows: 1000,
  enableLogging: true,
  showExecutionPlan: true
};
```

## 🔧 Troubleshooting

### Common Issues

**Issue: Schema Mismatch**

```javascript
// Auto-fix suggestions
const schemaFix = {
  issue: 'Column type mismatch in join',
  source1: 'CustomerID (string)',
  source2: 'CustomerID (int)',
  suggestion: 'Add cast transformation',
  autoFix: 'toInteger(CustomerID)'
};
```

**Issue: Performance Bottleneck**

```javascript
// Identify bottlenecks
const performanceAnalysis = {
  slowStage: 'Join operation',
  cause: 'Data skew on join key',
  solution: 'Add salt key for distribution',
  implementation: 'concat(JoinKey, "_", rand() % 10)'
};
```

## 🔗 Embedded Demo Link

**Launch Data Flow Designer:** [https://demos.csa-inabox.com/dataflow-designer](https://demos.csa-inabox.com/dataflow-designer)

## 📚 Additional Resources

- [Data Flow Transformations Reference](../../code-examples/integration-guide.md)
- [Performance Tuning Guide](../../best-practices/performance-optimization.md)
- [ETL Best Practices](../../best-practices/README.md)

## 💬 Feedback

> **💡 Rate the Data Flow Designer experience**

- ✅ **Built successful data flows** - [Share feedback](https://github.com/csa-inabox/docs/discussions)
- ⚠️ **Encountered issues** - [Report problem](https://github.com/csa-inabox/docs/issues/new)
- 💡 **Feature request** - [Suggest improvement](https://github.com/csa-inabox/docs/issues/new?title=[DataFlow]+Feature)

---

*Last Updated: January 2025 | Version: 1.0.0*
