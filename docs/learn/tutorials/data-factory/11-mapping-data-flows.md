# 🎨 Mapping Data Flows

![Tutorial](https://img.shields.io/badge/Tutorial-Mapping_Data_Flows-blue)
![Duration](https://img.shields.io/badge/Duration-25_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Master visual data transformation using Mapping Data Flows for complex ETL logic without writing code.__

## 📋 Table of Contents

- [Data Flow Basics](#data-flow-basics)
- [Transformation Types](#transformation-types)
- [Next Steps](#next-steps)

## 🎯 Data Flow Basics

Mapping Data Flows provide a code-free, visual way to design data transformations that execute on Spark clusters.

### Create Data Flow

```json
{
  "name": "SalesDataFlow",
  "properties": {
    "type": "MappingDataFlow",
    "typeProperties": {
      "sources": [
        {
          "name": "SalesSource",
          "dataset": {"referenceName": "SalesDataset"}
        }
      ],
      "sinks": [
        {
          "name": "CleanedSalesSink",
          "dataset": {"referenceName": "OutputDataset"}
        }
      ],
      "transformations": []
    }
  }
}
```

## 🔄 Transformation Types

### Filter Transformation

Remove rows based on conditions.

### Derived Column

Create calculated fields.

### Aggregate

Group and summarize data.

### Join

Combine multiple datasets.

## 📚 Additional Resources

- [Mapping Data Flows](https://docs.microsoft.com/azure/data-factory/concepts-data-flow-overview)
- [Data Flow Performance](https://docs.microsoft.com/azure/data-factory/concepts-data-flow-performance)

## 🚀 Next Steps

__→ [12. Wrangling Data Flows](12-wrangling-data-flows.md)__

---

__Module Progress__: 11 of 18 complete

*Tutorial Version: 1.0*
*Last Updated: January 2025*
