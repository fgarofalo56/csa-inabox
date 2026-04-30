# Alerting Migration: Alert Rules, On-Call, and Incident Management

**Audience:** SREs, Platform Engineers, DevOps Leads
**Source platforms:** Datadog Monitors, New Relic Alerts, Splunk Observability Detectors
**Target:** Azure Monitor Alerts, Action Groups, Alert Processing Rules
**Last updated:** 2026-04-30

---

## Overview

Alert rules are the operational backbone of any observability platform. Migrating alerts requires converting both the detection logic (what triggers) and the notification routing (who gets notified). This guide covers migrating alert rules, on-call integrations, escalation policies, and maintenance windows from third-party platforms to Azure Monitor.

Azure Monitor provides three alert types:

1. **Metric alerts** -- evaluate Azure Monitor Metrics or custom metrics at 1-minute minimum frequency. Support static thresholds, dynamic thresholds (ML-based), and multi-resource targeting.
2. **Log search alerts** -- evaluate KQL queries against Log Analytics or Application Insights data. Support frequency from 1 minute to 24 hours.
3. **Activity log alerts** -- trigger on Azure control plane events (resource creation, deletion, health events). Used for infrastructure lifecycle monitoring.

---

## Alert type mapping

| Source alert type           | Datadog           | New Relic            | Splunk Observability    | Azure Monitor equivalent                        |
| --------------------------- | ----------------- | -------------------- | ----------------------- | ----------------------------------------------- |
| Metric threshold            | Metric Monitor    | NRQL Alert (metric)  | Detector (static)       | Metric alert (static threshold)                 |
| Metric anomaly              | Anomaly Monitor   | Baseline Alert       | Detector (dynamic)      | Metric alert (dynamic threshold)                |
| Log query                   | Log Monitor       | NRQL Alert (log)     | Log Observer Alert      | Log search alert                                |
| APM error rate              | APM Monitor       | APM Alert            | APM Detector            | Log search alert on AppRequests                 |
| APM latency                 | APM Monitor       | APM Alert            | APM Detector            | Metric alert on Application Insights            |
| Host availability           | Host Monitor      | Host Not Reporting   | Infrastructure Detector | Metric alert (heartbeat)                        |
| Process / service check     | Process Monitor   | N/A                  | N/A                     | Log search alert (Heartbeat table)              |
| Composite (multi-condition) | Composite Monitor | NRQL multi-condition | Detector + Muting       | Log search alert (KQL with multiple conditions) |
| Forecast                    | Forecast Monitor  | N/A                  | N/A                     | Dynamic threshold (learns trend)                |
| SLO burn rate               | SLO Alert         | SLI Alert            | SLO Detector            | Log search alert (custom SLO KQL)               |
| Event / webhook             | Event Monitor     | Webhook Alert        | N/A                     | Activity log alert + Logic App                  |

---

## Creating Azure Monitor alerts

### Metric alert: High CPU

=== "Azure CLI"

    ```bash
    az monitor metrics alert create \
      --name "high-cpu" \
      --resource-group rg-observability \
      --scopes "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{vm}" \
      --condition "avg Percentage CPU > 90" \
      --window-size 5m \
      --evaluation-frequency 1m \
      --severity 2 \
      --action "/subscriptions/{sub}/resourceGroups/{rg}/providers/microsoft.insights/actionGroups/{ag}"
    ```

=== "Bicep"

    ```bicep
    resource cpuAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
      name: 'high-cpu'
      location: 'global'
      properties: {
        severity: 2
        evaluationFrequency: 'PT1M'
        windowSize: 'PT5M'
        criteria: {
          'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
          allOf: [
            {
              name: 'HighCPU'
              metricName: 'Percentage CPU'
              operator: 'GreaterThan'
              threshold: 90
              timeAggregation: 'Average'
            }
          ]
        }
        actions: [{ actionGroupId: actionGroup.id }]
        scopes: [vm.id]
      }
    }
    ```

### Log search alert: Application error spike

```bicep
resource errorSpikeAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'app-error-spike'
  location: location
  properties: {
    severity: 1
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [logAnalyticsWorkspace.id]
    criteria: {
      allOf: [
        {
          query: '''
            AppExceptions
            | where TimeGenerated > ago(15m)
            | summarize ErrorCount = count() by AppRoleName
            | where ErrorCount > 50
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          dimensions: [
            {
              name: 'AppRoleName'
              operator: 'Include'
              values: ['*']
            }
          ]
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroup.id]
      customProperties: {
        runbook: 'https://wiki.internal/runbooks/app-errors'
        team: 'platform-engineering'
      }
    }
  }
}
```

### Dynamic threshold alert: Latency anomaly

Dynamic threshold alerts use machine learning to learn the metric's normal behavior and alert on deviations. This replaces Datadog Anomaly Monitors and Splunk Dynamic Detectors.

```bicep
resource latencyAnomalyAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'latency-anomaly'
  location: 'global'
  properties: {
    severity: 2
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.MultipleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'LatencyAnomaly'
          metricName: 'requests/duration'
          metricNamespace: 'microsoft.insights/components'
          operator: 'GreaterOrLessThan'
          alertSensitivity: 'Medium'
          timeAggregation: 'Average'
          criterionType: 'DynamicThresholdCriterion'
          failingPeriods: {
            numberOfEvaluationPeriods: 4
            minFailingPeriodsToAlert: 3
          }
        }
      ]
    }
    actions: [{ actionGroupId: actionGroup.id }]
    scopes: [appInsights.id]
  }
}
```

---

## Action groups: Notification routing

Action groups replace the notification routing in Datadog (monitors -> integrations), New Relic (alert policies -> notification channels), and Splunk (detectors -> recipients).

### Action group configuration

```bicep
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-platform-oncall'
  location: 'global'
  properties: {
    groupShortName: 'PlatOnCall'
    enabled: true
    emailReceivers: [
      {
        name: 'Platform Team Email'
        emailAddress: 'platform-oncall@contoso.com'
        useCommonAlertSchema: true
      }
    ]
    smsReceivers: [
      {
        name: 'On-Call SMS'
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
        name: 'Slack'
        serviceUri: 'https://hooks.slack.com/services/T00/B00/xxxxx'
        useCommonAlertSchema: true
      }
    ]
    azureFunctionReceivers: [
      {
        name: 'Custom Enrichment'
        functionAppResourceId: functionApp.id
        functionName: 'EnrichAlert'
        httpTriggerUrl: 'https://func-alerts.azurewebsites.net/api/EnrichAlert'
        useCommonAlertSchema: true
      }
    ]
  }
}
```

### Supported notification channels

| Channel                  | Configuration                                | Replaces                                  |
| ------------------------ | -------------------------------------------- | ----------------------------------------- |
| Email                    | `emailReceivers`                             | All vendors: email notifications          |
| SMS                      | `smsReceivers`                               | All vendors: SMS notifications            |
| Voice call               | `voiceReceivers`                             | Datadog/Splunk: voice calls               |
| PagerDuty                | `webhookReceivers` (PagerDuty Events API v2) | All vendors: PagerDuty integration        |
| Opsgenie                 | `webhookReceivers` (Opsgenie API)            | All vendors: Opsgenie integration         |
| ServiceNow               | ITSM Connector (bi-directional)              | All vendors: ServiceNow integration       |
| Slack                    | `webhookReceivers` (Slack webhook)           | All vendors: Slack integration            |
| Microsoft Teams          | Logic App action + Teams connector           | All vendors: Teams notifications          |
| Azure Function           | `azureFunctionReceivers`                     | Custom notification logic                 |
| Logic App                | `logicAppReceivers`                          | Complex multi-step notification workflows |
| Webhook (generic)        | `webhookReceivers`                           | Any HTTP endpoint                         |
| Azure Automation Runbook | `automationRunbookReceivers`                 | Auto-remediation workflows                |

---

## Alert processing rules: Suppression and routing

Alert processing rules replace maintenance windows (Datadog Downtime, New Relic Muting Rules, Splunk Muting Rules) and alert routing logic.

### Maintenance window (suppress alerts during deployment)

```bicep
resource maintenanceWindow 'Microsoft.AlertsManagement/actionRules@2023-05-01-preview' = {
  name: 'deployment-maintenance-window'
  location: 'global'
  properties: {
    scopes: ['/subscriptions/{subscription-id}/resourceGroups/rg-production']
    conditions: [
      {
        field: 'Severity'
        operator: 'Equals'
        values: ['Sev3', 'Sev4']
      }
    ]
    schedule: {
      effectiveFrom: '2026-05-01T02:00:00Z'
      effectiveUntil: '2026-05-01T04:00:00Z'
      timeZone: 'UTC'
      recurrences: []
    }
    actions: [{ actionType: 'RemoveAllActionGroups' }]
    enabled: true
    description: 'Suppress low-severity alerts during weekly deployment window'
  }
}
```

### Route alerts by severity

```bicep
resource routeHighSeverity 'Microsoft.AlertsManagement/actionRules@2023-05-01-preview' = {
  name: 'route-critical-to-pagerduty'
  location: 'global'
  properties: {
    scopes: ['/subscriptions/{subscription-id}']
    conditions: [
      {
        field: 'Severity'
        operator: 'Equals'
        values: ['Sev0', 'Sev1']
      }
    ]
    actions: [
      {
        actionType: 'AddActionGroups'
        actionGroupIds: [pagerDutyActionGroup.id]
      }
    ]
    enabled: true
    description: 'Route Sev0 and Sev1 alerts to PagerDuty on-call'
  }
}
```

---

## Smart detection (Application Insights)

Application Insights Smart Detection provides proactive anomaly detection without manual threshold configuration. It automatically detects:

- **Failure anomalies** -- sudden increase in failed request rate
- **Performance anomalies** -- degradation in response time
- **Memory leak detection** -- gradual memory increase patterns
- **Abnormal rise in exception volume** -- exception spike detection
- **Dependency failure anomalies** -- downstream service degradation
- **Trace severity ratio** -- unusual shift in trace severity distribution

Smart Detection is enabled by default for all Application Insights resources. It replaces:

- Datadog Watchdog (Enterprise tier)
- New Relic Applied Intelligence
- Splunk ITSI (IT Service Intelligence)

---

## ITSM Connector: ServiceNow integration

For organizations using ServiceNow for incident management, the ITSM Connector provides bi-directional integration.

**Capabilities:**

- Automatically create ServiceNow incidents from Azure Monitor alerts
- Sync alert state (fired/resolved) with incident state
- Enrich incidents with alert context (affected resource, query results, runbook links)
- Close incidents when alerts auto-resolve

**Configuration:**

1. Create an ITSM connection in Azure Monitor (Alerts > ITSM Connections)
2. Provide ServiceNow instance URL and credentials
3. Map alert severity to ServiceNow priority
4. Configure incident template (assignment group, category, subcategory)
5. Add ITSM action to action groups

---

## Migration checklist

- [ ] Inventory all alert rules (metric, log, composite) from source platform
- [ ] Categorize alerts by type: metric threshold, anomaly, log query, heartbeat
- [ ] Create action groups for each notification target (email, PagerDuty, Slack, ServiceNow)
- [ ] Migrate metric threshold alerts to Azure Monitor metric alerts
- [ ] Migrate log-based alerts to Azure Monitor log search alerts
- [ ] Configure dynamic threshold alerts for anomaly detection
- [ ] Set up alert processing rules for maintenance windows
- [ ] Configure alert processing rules for severity-based routing
- [ ] Enable Application Insights Smart Detection
- [ ] Set up ITSM Connector for ServiceNow (if applicable)
- [ ] Validate alert parity: run both platforms in parallel for 2-4 weeks
- [ ] Confirm notification delivery for all channels
- [ ] Document escalation procedures in runbooks
- [ ] Decommission source platform alert rules after validation

---

**Related:** [APM Migration](apm-migration.md) | [Log Migration](log-migration.md) | [Metrics Migration](metrics-migration.md) | [Dashboard Migration](dashboard-migration.md) | [Best Practices](best-practices.md)
