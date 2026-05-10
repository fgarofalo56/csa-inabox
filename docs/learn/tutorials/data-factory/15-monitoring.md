---
title: "Monitoring & Alerting"
description: "__Implement comprehensive monitoring and alerting for Azure Data Factory pipelines using Azure Monitor and custom dashboards.__"
tags:
  - tutorials
  - data-factory
---
# 📊 Monitoring & Alerting

![Tutorial](https://img.shields.io/badge/Tutorial-Monitoring_Alerting-blue)
![Duration](https://img.shields.io/badge/Duration-20_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Implement comprehensive monitoring and alerting for Azure Data Factory pipelines using Azure Monitor and custom dashboards.__

## 📋 Table of Contents

- [Monitoring Overview](#monitoring-overview)
- [Pipeline Monitoring](#pipeline-monitoring)
- [Azure Monitor Integration](#azure-monitor-integration)
- [Custom Alerts](#custom-alerts)
- [Next Steps](#next-steps)

## 📊 Monitoring Overview

### Monitoring Capabilities

- Pipeline run history
- Activity-level metrics
- Integration runtime metrics
- Data movement statistics
- Error tracking and diagnostics

## 🔍 Pipeline Monitoring

### ADF Studio Monitoring

Navigate to __Monitor__ tab in ADF Studio to view:

- Pipeline runs
- Trigger runs
- Integration runtime status
- Data flow debug sessions

### Key Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| __Failed Runs__ | Number of pipeline failures | > 0 |
| __Duration__ | Pipeline execution time | > SLA |
| __Data Read/Written__ | Data volume processed | Unexpected changes |
| __DIU Hours__ | Data Integration Units consumed | Budget limits |

## 📈 Azure Monitor Integration

### Enable Diagnostic Settings

```bash
# Enable diagnostic settings
az monitor diagnostic-settings create \
  --name "ADF-Diagnostics" \
  --resource "/subscriptions/xxx/resourceGroups/xxx/providers/Microsoft.DataFactory/factories/xxx" \
  --workspace "/subscriptions/xxx/resourceGroups/xxx/providers/Microsoft.OperationalInsights/workspaces/xxx" \
  --logs '[{"category": "PipelineRuns", "enabled": true}, {"category": "ActivityRuns", "enabled": true}]' \
  --metrics '[{"category": "AllMetrics", "enabled": true}]'
```

### Log Analytics Queries

```kusto
// Failed pipeline runs in last 24 hours
ADFPipelineRun
| where TimeGenerated > ago(24h)
| where Status == "Failed"
| project TimeGenerated, PipelineName, Status, ErrorMessage
| order by TimeGenerated desc
```

## 🚨 Custom Alerts

### Create Alert Rule

```bash
# Create alert for pipeline failures
az monitor metrics alert create \
  --name "ADF-Pipeline-Failures" \
  --resource-group "rg-adf-tutorial-dev" \
  --scopes "/subscriptions/xxx/resourceGroups/xxx/providers/Microsoft.DataFactory/factories/xxx" \
  --condition "count PipelineFailedRuns > 0" \
  --window-size 5m \
  --evaluation-frequency 1m \
  --action-group "adf-alerts-action-group"
```

## 📚 Additional Resources

- [ADF Monitoring](https://docs.microsoft.com/azure/data-factory/monitor-visually)
- [Azure Monitor Integration](../../09-monitoring/README.md)

## 🚀 Next Steps

__→ [16. Performance Optimization](16-optimization.md)__

---

__Module Progress__: 15 of 18 complete

*Tutorial Version: 1.0*
*Last Updated: January 2025*
