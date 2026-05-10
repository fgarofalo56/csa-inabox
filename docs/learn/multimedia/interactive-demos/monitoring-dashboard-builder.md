---
title: "Monitoring Dashboard Builder"
tags:
  - multimedia
  - demos
---
# 📊 Monitoring Dashboard Builder

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Interactive](https://img.shields.io/badge/Type-Interactive-purple)
![Difficulty: Intermediate](https://img.shields.io/badge/Difficulty-Intermediate-yellow)

## 📋 Overview

Build custom monitoring dashboards for Azure Synapse Analytics. Drag-and-drop widgets, configure metrics, set up alerts, and visualize performance in real-time.

**Duration:** 30-45 minutes | **Format:** Interactive dashboard designer | **Prerequisites:** Basic monitoring concepts

## 🎯 Learning Objectives

- Create custom monitoring dashboards
- Configure performance metrics and KPIs
- Set up alerts and notifications
- Visualize data with charts and graphs
- Export dashboard configurations
- Share dashboards with team members

## 🚀 Dashboard Builder Interface

### Available Widgets

```javascript
const dashboardWidgets = {
  performance: [
    { type: 'query-performance', title: 'Query Execution Time', metric: 'avg_execution_time' },
    { type: 'resource-utilization', title: 'DWU Utilization', metric: 'dwu_percentage' },
    { type: 'data-throughput', title: 'Data Processed', metric: 'data_mb_processed' }
  ],
  health: [
    { type: 'pool-status', title: 'Pool Health', metric: 'pool_status' },
    { type: 'failed-queries', title: 'Failed Queries', metric: 'error_count' },
    { type: 'wait-statistics', title: 'Query Waits', metric: 'wait_time_ms' }
  ],
  usage: [
    { type: 'active-sessions', title: 'Active Sessions', metric: 'session_count' },
    { type: 'storage-usage', title: 'Storage Consumed', metric: 'storage_gb' },
    { type: 'cost-tracker', title: 'Daily Cost', metric: 'cost_usd' }
  ]
};
```

### Sample Dashboard Configuration

```json
{
  "dashboard": {
    "name": "Production Monitoring",
    "refreshInterval": 60,
    "layout": [
      {
        "widget": "query-performance",
        "position": { "row": 0, "col": 0, "width": 6, "height": 4 },
        "config": {
          "timeRange": "last_hour",
          "aggregation": "avg",
          "threshold": { "warning": 30, "critical": 60 }
        }
      },
      {
        "widget": "resource-utilization",
        "position": { "row": 0, "col": 6, "width": 6, "height": 4 },
        "config": {
          "metric": "dwu_percentage",
          "visualization": "gauge"
        }
      }
    ]
  }
}
```

## 📊 Key Metrics

### Query Performance Metrics

```sql
-- Query performance monitoring
SELECT
    request_id,
    submit_time,
    start_time,
    end_time,
    DATEDIFF(second, start_time, end_time) AS duration_seconds,
    status,
    command,
    total_elapsed_time,
    resource_class
FROM sys.dm_pdw_exec_requests
WHERE submit_time >= DATEADD(hour, -1, GETUTC DATE())
ORDER BY submit_time DESC;
```

### Resource Utilization

```sql
-- DWU utilization tracking
SELECT
    GETDATE() AS sample_time,
    COUNT(*) AS active_queries,
    SUM(CASE WHEN status = 'Running' THEN 1 ELSE 0 END) AS running_queries,
    AVG(CAST(total_elapsed_time AS FLOAT)) AS avg_elapsed_time
FROM sys.dm_pdw_exec_requests
WHERE status IN ('Running', 'Suspended');
```

## 🔧 Troubleshooting

### Alert Configuration

```javascript
const alertRules = {
  highQueryDuration: {
    metric: 'query_duration',
    threshold: 300, // seconds
    action: 'email',
    recipients: ['dba@contoso.com']
  },
  poolPaused: {
    metric: 'pool_status',
    condition: 'equals',
    value: 'Paused',
    action: 'webhook',
    url: 'https://alerts.contoso.com/synapse'
  }
};
```

## 🔗 Embedded Demo Link

**Launch Dashboard Builder:** [https://demos.csa-inabox.com/dashboard-builder](https://demos.csa-inabox.com/dashboard-builder)

## 📚 Additional Resources

- [Monitoring Guide](../../09-monitoring/README.md)
- [Performance Optimization](../../05-best-practices/cross-cutting-concerns/performance/performance-optimization.md)

## 💬 Feedback

> **💡 How useful was the Dashboard Builder?**

- ✅ **Built useful dashboards** - [Share feedback](https://github.com/csa-inabox/docs/discussions)
- ⚠️ **Missing widgets** - [Request feature](https://github.com/csa-inabox/docs/issues/new)

---

*Last Updated: January 2025 | Version: 1.0.0*
