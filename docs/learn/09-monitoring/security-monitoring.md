# Security Monitoring

[Home](../../README.md) > Monitoring > Security Monitoring

!!! abstract "Overview"
This guide covers security monitoring approaches for Azure Synapse Analytics, including threat detection, audit logging, and compliance monitoring.

## 🛡️ Security Monitoring Framework

Implement comprehensive security monitoring to detect and respond to security threats in your Azure Synapse Analytics environment.

<div class="grid cards" markdown>

- 👁️ __Threat Detection__

---

Monitor for suspicious activities and security threats

[→ Threat monitoring](#threat-detection)

- 📄 __Audit Logging__

---

Track and analyze user and service activities

[→ Audit configuration](#audit-logging)

- ⚠️ __Security Alerting__

---

Configure proactive alerts for security events

[→ Alert setup](#security-alerting)

- ✅ __Compliance Monitoring__

---

Track compliance with security standards

[→ Compliance tracking](#compliance-monitoring)

</div>

## Threat Detection

!!! warning "Security Alert"
Enable Advanced Threat Protection for all Synapse SQL pools to detect anomalous database activities.

Azure Synapse Analytics integrates with Azure Defender for SQL and Azure Security Center to provide threat detection capabilities:

1. __SQL Injection Detection__ - Identifies attempts to exploit vulnerabilities
2. __Access from Unusual Locations__ - Detects logins from unusual IP addresses
3. __Unusual Application Sign-ins__ - Identifies suspicious authentication patterns
4. __Brute Force Attempts__ - Detects repeated failed authentication attempts
5. __Data Exfiltration__ - Identifies suspicious large data extraction operations

```json
{
  "name": "default",
  "type": "Microsoft.Sql/servers/securityAlertPolicies",
  "properties": {
    "state": "Enabled",
    "disabledAlerts": [],
    "emailAddresses": ["security@contoso.com"],
    "emailAccountAdmins": true,
    "retentionDays": 90
  }
}
```

## Audit Logging

![Secure Data Lakehouse Security Overview](https://learn.microsoft.com/en-us/azure/architecture/example-scenario/analytics/media/secure-data-lakehouse-defender-for-cloud-synopsis.png)

Configure comprehensive audit logging for Azure Synapse Analytics:

| Log Category | Description | Retention |
|-------------|-------------|-----------|
| SQL Security Audit Logs | Authentication events, permission changes, data access | 90 days |
| Management Activities | Resource creation, modification, deletion | 90 days |
| Data Plane Activities | Data access and modifications | 30 days |
| Spark Job Executions | Spark job submissions and activities | 30 days |
| Pipeline Executions | Pipeline triggers and activities | 30 days |

!!! example "Audit Log Configuration"

```powershell
# Enable diagnostic settings for Synapse workspace
$workspace = "mysynapseworkspace"
$resourceGroup = "myresourcegroup"
$logAnalytics = "/subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<workspace>"

# Enable all log categories
$logs = @()
Get-AzDiagnosticSettingCategory -ResourceId "/subscriptions/<id>/resourceGroups/$resourceGroup/providers/Microsoft.Synapse/workspaces/$workspace" | 
Where-Object {$_.CategoryType -eq "Logs"} | 
ForEach-Object {
$logs += @{
Category = $_.Name
Enabled = $true
RetentionPolicy = @{
Days = 90
Enabled = $true
}
}
}

# Apply the diagnostic setting
Set-AzDiagnosticSetting -Name "SecurityMonitoring" `
-ResourceId "/subscriptions/<id>/resourceGroups/$resourceGroup/providers/Microsoft.Synapse/workspaces/$workspace" `
-WorkspaceId $logAnalytics `
-Log $logs
```

## Security Alerting

Implement these security alert categories for Azure Synapse Analytics:

1. __Authentication Failures__ - Multiple failed login attempts
2. __Permission Changes__ - Additions to high-privilege roles
3. __Firewall Changes__ - Modifications to firewall rules
4. __Suspicious Query Patterns__ - Potential data exfiltration attempts
5. __Configuration Changes__ - Critical security setting modifications

!!! tip "Best Practice"
Integrate security alerts with your incident management system using Azure Logic Apps or Azure Functions.

```kusto
// Example KQL query for detecting suspicious authentication patterns
let timeframe = 1h;
SigninLogs
| where TimeGenerated > ago(timeframe)
| where ResourceDisplayName contains "synapse"
| where ResultType == "50126" // Password mismatch
| summarize FailedAttempts = count() by UserPrincipalName, IPAddress, AppDisplayName
| where FailedAttempts > 5
| extend Timestamp = now()
| extend SourceSystem = "Azure AD"
| extend AlertType = "Brute Force Attempt"
| extend AlertSeverity = "High"
```

## Compliance Monitoring

Track and report on compliance with key security standards:

| Standard | Monitoring Approach | Reporting Frequency |
|----------|---------------------|---------------------|
| GDPR | Data access logs, data classification | Monthly |
| HIPAA | PHI access audit, encryption verification | Weekly |
| PCI DSS | Cardholder data access, network isolation | Daily |
| SOC 2 | Access controls, change management | Quarterly |
| ISO 27001 | Risk assessments, security controls | Monthly |

Create compliance dashboards using Azure Monitor workbooks that provide:

1. Real-time compliance status visualization
2. Historical compliance trends
3. Remediation recommendations
4. Compliance evidence collection
5. Automated reporting for audits

## Integration with Azure Purview

!!! info "Integration Point"
Azure Purview enhances security monitoring through data governance and classification capabilities.

Leverage Azure Purview (Microsoft Purview) integration with Synapse Analytics for:

1. __Automated Data Classification__ - Identify and tag sensitive data
2. __Lineage Tracking__ - Monitor how sensitive data moves through pipelines
3. __Access Reviews__ - Regularly validate access permissions
4. __Policy Enforcement__ - Apply consistent security policies
5. __Compliance Reporting__ - Generate compliance reports for audits

## Related Resources

- [Azure Synapse Analytics security white paper](https://learn.microsoft.com/en-us/azure/synapse-analytics/guidance/security-white-paper-introduction)
- [Microsoft Purview data governance](https://learn.microsoft.com/en-us/purview/purview)
- [Azure Monitor for Synapse Analytics](https://learn.microsoft.com/en-us/azure/synapse-analytics/monitoring/monitor-azure-synapse-analytics-using-azure-monitor)
