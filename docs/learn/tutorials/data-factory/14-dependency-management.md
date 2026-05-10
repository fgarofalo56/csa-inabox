---
title: "Pipeline Dependency Management"
description: "__Manage complex pipeline dependencies, activity chaining, and conditional execution for robust data workflows.__"
tags:
  - tutorials
  - data-factory
---
# 🔗 Pipeline Dependency Management

![Tutorial](https://img.shields.io/badge/Tutorial-Dependency_Management-blue)
![Duration](https://img.shields.io/badge/Duration-10_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Manage complex pipeline dependencies, activity chaining, and conditional execution for robust data workflows.__

## 📋 Table of Contents

- [Activity Dependencies](#activity-dependencies)
- [Dependency Conditions](#dependency-conditions)
- [Parallel Execution](#parallel-execution)
- [Next Steps](#next-steps)

## 🔗 Activity Dependencies

### Sequential Execution

```json
{
  "name": "Activity2",
  "type": "Copy",
  "dependsOn": [
    {
      "activity": "Activity1",
      "dependencyConditions": ["Succeeded"]
    }
  ]
}
```

### Multiple Dependencies

```json
{
  "name": "FinalActivity",
  "type": "Copy",
  "dependsOn": [
    {"activity": "Activity1", "dependencyConditions": ["Succeeded"]},
    {"activity": "Activity2", "dependencyConditions": ["Succeeded"]},
    {"activity": "Activity3", "dependencyConditions": ["Succeeded"]}
  ]
}
```

## 🎯 Dependency Conditions

Available conditions:

- `Succeeded`: Activity completed successfully
- `Failed`: Activity failed
- `Skipped`: Activity was skipped
- `Completed`: Activity completed (success or failure)

## ⚡ Parallel Execution

Execute activities in parallel when no dependencies exist.

## 📚 Additional Resources

- [Pipeline Execution](https://docs.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers)

## 🚀 Next Steps

__→ [15. Monitoring & Alerting](15-monitoring.md)__

---

__Module Progress__: 14 of 18 complete

*Tutorial Version: 1.0*
*Last Updated: January 2025*
