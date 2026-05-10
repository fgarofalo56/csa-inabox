# Alerting Strategies

> **[Home](../../../README.md)** | **[Best Practices](../README.md)** | **[Operational Excellence](README.md)** | **Alert Strategies**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-Operations-orange?style=flat-square)

Best practices for alerting across Azure analytics platforms.

---

## Overview

Effective alerting enables proactive issue detection while minimizing alert fatigue. This guide covers strategies for configuring meaningful alerts.

---

## Alert Hierarchy

### Severity Levels

| Severity | Response Time | Examples |
|----------|---------------|----------|
| Sev 0 (Critical) | Immediate | Data loss risk, security breach |
| Sev 1 (High) | < 1 hour | Pipeline failures, service degradation |
| Sev 2 (Medium) | < 4 hours | Performance degradation, warnings |
| Sev 3 (Low) | Next business day | Informational, capacity planning |

### Alert Categories

```yaml
categories:
  availability:
    - Service health
    - Endpoint connectivity
    - Resource availability

  performance:
    - Query latency
    - Throughput degradation
    - Resource utilization

  data_quality:
    - Schema violations
    - Null rate thresholds
    - Freshness SLAs

  security:
    - Authentication failures
    - Access anomalies
    - Compliance violations

  cost:
    - Budget thresholds
    - Anomalous spending
    - Resource waste
```

---

## Alert Configuration

### Azure Monitor Alerts

```json
{
    "type": "Microsoft.Insights/metricAlerts",
    "apiVersion": "2018-03-01",
    "name": "synapse-query-latency-alert",
    "properties": {
        "description": "Alert when query latency exceeds threshold",
        "severity": 2,
        "enabled": true,
        "scopes": ["/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Synapse/workspaces/{workspace}"],
        "evaluationFrequency": "PT5M",
        "windowSize": "PT15M",
        "criteria": {
            "odata.type": "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",
            "allOf": [
                {
                    "name": "QueryLatency",
                    "metricName": "IntegrationPipelineRunsEnded",
                    "dimensions": [
                        {
                            "name": "Result",
                            "operator": "Include",
                            "values": ["Failed"]
                        }
                    ],
                    "operator": "GreaterThan",
                    "threshold": 0,
                    "timeAggregation": "Total"
                }
            ]
        },
        "actions": [
            {
                "actionGroupId": "/subscriptions/{sub}/resourceGroups/{rg}/providers/microsoft.insights/actionGroups/data-platform-ops"
            }
        ]
    }
}
```

### Log-Based Alerts

```kql
// Pipeline failure alert query
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.SYNAPSE"
| where Category == "IntegrationPipelineRuns"
| where Status == "Failed"
| summarize FailureCount = count() by PipelineName, bin(TimeGenerated, 15m)
| where FailureCount > 0
```

---

## Alert Patterns

### Threshold-Based

```python
# Dynamic threshold calculation
def calculate_dynamic_threshold(
    metric_history: list,
    sensitivity: str = "medium"
) -> tuple:
    """Calculate dynamic alert thresholds based on historical data."""
    import numpy as np

    data = np.array(metric_history)
    mean = np.mean(data)
    std = np.std(data)

    multipliers = {
        "low": 3.0,      # Fewer alerts
        "medium": 2.0,   # Balanced
        "high": 1.5      # More sensitive
    }

    multiplier = multipliers.get(sensitivity, 2.0)

    upper_threshold = mean + (std * multiplier)
    lower_threshold = max(0, mean - (std * multiplier))

    return lower_threshold, upper_threshold
```

### Anomaly Detection

```kql
// Anomaly detection for query performance
let baseline =
    PerformanceMetrics
    | where TimeGenerated > ago(7d) and TimeGenerated < ago(1d)
    | summarize AvgLatency = avg(QueryLatencyMs), StdDev = stdev(QueryLatencyMs);
PerformanceMetrics
| where TimeGenerated > ago(1h)
| summarize CurrentLatency = avg(QueryLatencyMs) by bin(TimeGenerated, 5m)
| join baseline on $left.TimeGenerated != $right.TimeGenerated
| extend Zscore = (CurrentLatency - AvgLatency) / StdDev
| where abs(Zscore) > 3
| project TimeGenerated, CurrentLatency, Zscore, Alert = "Anomaly Detected"
```

### Composite Alerts

```json
{
    "type": "Microsoft.Insights/scheduledQueryRules",
    "properties": {
        "displayName": "Pipeline Health Composite Alert",
        "description": "Alert when multiple pipeline issues detected",
        "severity": 1,
        "enabled": true,
        "evaluationFrequency": "PT5M",
        "windowSize": "PT15M",
        "criteria": {
            "allOf": [
                {
                    "query": "AzureDiagnostics | where Category == 'PipelineRuns' | where Status == 'Failed' | summarize FailCount = count() | where FailCount > 3",
                    "timeAggregation": "Count",
                    "operator": "GreaterThan",
                    "threshold": 0
                }
            ]
        }
    }
}
```

---

## Alert Routing

### Action Groups

```bicep
resource actionGroup 'Microsoft.Insights/actionGroups@2022-06-01' = {
  name: 'ag-data-platform'
  location: 'global'
  properties: {
    groupShortName: 'DataPlatform'
    enabled: true

    emailReceivers: [
      {
        name: 'PlatformTeam'
        emailAddress: 'data-platform@company.com'
        useCommonAlertSchema: true
      }
    ]

    smsReceivers: [
      {
        name: 'OnCall'
        countryCode: '1'
        phoneNumber: '5551234567'
      }
    ]

    webhookReceivers: [
      {
        name: 'PagerDuty'
        serviceUri: 'https://events.pagerduty.com/integration/{key}/enqueue'
        useCommonAlertSchema: true
      }
      {
        name: 'Teams'
        serviceUri: 'https://outlook.office.com/webhook/{id}'
        useCommonAlertSchema: true
      }
    ]

    azureFunctionReceivers: [
      {
        name: 'AlertProcessor'
        functionAppResourceId: '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites/{app}'
        functionName: 'ProcessAlert'
        httpTriggerUrl: 'https://{app}.azurewebsites.net/api/ProcessAlert'
        useCommonAlertSchema: true
      }
    ]
  }
}
```

### Escalation Policy

```python
class AlertEscalation:
    """Manage alert escalation based on severity and age."""

    ESCALATION_RULES = {
        "sev0": {
            0: ["oncall_primary"],
            5: ["oncall_primary", "oncall_secondary"],
            15: ["oncall_primary", "oncall_secondary", "manager"],
            30: ["oncall_primary", "oncall_secondary", "manager", "director"]
        },
        "sev1": {
            0: ["team_channel"],
            30: ["oncall_primary"],
            60: ["oncall_primary", "manager"]
        }
    }

    def get_escalation_targets(self, severity: str, minutes_open: int) -> list:
        """Get notification targets based on alert age."""
        rules = self.ESCALATION_RULES.get(severity, {})
        targets = []
        for threshold, recipients in sorted(rules.items()):
            if minutes_open >= threshold:
                targets = recipients
        return targets
```

---

## Alert Suppression

### Maintenance Windows

```python
def should_suppress_alert(alert: dict, maintenance_schedule: dict) -> bool:
    """Check if alert should be suppressed during maintenance."""
    from datetime import datetime

    current_time = datetime.utcnow()

    for window in maintenance_schedule.get("windows", []):
        start = datetime.fromisoformat(window["start"])
        end = datetime.fromisoformat(window["end"])
        resources = window.get("resources", [])

        if start <= current_time <= end:
            if not resources or alert["resource"] in resources:
                return True

    return False
```

### Deduplication

```kql
// Deduplicate alerts by correlation ID
Alerts
| where TimeGenerated > ago(1h)
| summarize
    FirstOccurrence = min(TimeGenerated),
    LastOccurrence = max(TimeGenerated),
    Count = count()
    by AlertName, ResourceId, bin(TimeGenerated, 15m)
| where Count == 1 or TimeGenerated == FirstOccurrence
```

---

## Best Practices

### Alert Hygiene

| Practice | Description |
|----------|-------------|
| Review weekly | Check for noisy or ignored alerts |
| Document runbooks | Link alerts to remediation procedures |
| Test regularly | Verify alert routing works |
| Track MTTR | Measure mean time to resolution |
| Tune thresholds | Adjust based on false positive rate |

---

## Related Documentation

- [Monitoring Best Practices](monitoring.md)
- [Reliability Patterns](reliability.md)
- [Synapse Monitoring](../../../09-monitoring/service-monitoring/synapse/README.md)

---

*Last Updated: January 2025*
