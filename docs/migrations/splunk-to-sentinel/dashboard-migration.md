# Dashboard Migration: Splunk Dashboards to Sentinel Workbooks

**Status:** Authored 2026-04-30
**Audience:** SOC Analysts, Dashboard Developers, Security Engineers
**Purpose:** Guide for migrating Splunk dashboards and reports to Microsoft Sentinel workbooks and Power BI dashboards via CSA-in-a-Box

---

## 1. Architecture comparison

### Splunk dashboards

Splunk provides two dashboard frameworks:

- **Classic Dashboards** (Simple XML) -- the traditional Splunk dashboard format
- **Dashboard Studio** -- the newer JSON-based framework with richer visualizations

Both use SPL queries to populate panels with charts, tables, maps, and single-value indicators.

### Sentinel workbooks

Sentinel uses **Azure Monitor Workbooks** -- interactive, parameterized reports that support:

- KQL queries against Log Analytics data
- Multiple visualization types (charts, grids, tiles, maps)
- Parameters for dynamic filtering
- Drill-down and cross-filtering
- ARM/Bicep-based deployment (infrastructure as code)
- Template gallery with pre-built security workbooks

### Power BI (via CSA-in-a-Box)

For executive-level dashboards that require rich visualization, natural language Q&A, and cross-domain data correlation, Power BI through CSA-in-a-Box provides:

- Direct Lake semantic models over security data
- Scheduled refresh from Log Analytics
- Mobile-optimized dashboards
- Row-level security for multi-tenant reporting
- Natural language queries via Power BI Copilot

---

## 2. Visualization type mapping

| Splunk visualization  | Sentinel workbook equivalent | Notes                                      |
| --------------------- | ---------------------------- | ------------------------------------------ |
| **Single value**      | Tiles / Metrics step         | KPI indicators with trend sparklines       |
| **Column chart**      | Bar chart                    | Horizontal or vertical bars                |
| **Line chart**        | Time chart / Line chart      | Time-series data visualization             |
| **Area chart**        | Area chart                   | Stacked or overlaid areas                  |
| **Pie chart**         | Pie chart                    | Category distribution                      |
| **Table**             | Grid / Table step            | Sortable, filterable tabular data          |
| **Map (chloropleth)** | Map visualization            | Geographic data on map                     |
| **Scatter plot**      | Scatter chart                | Two-dimensional data points                |
| **Radial gauge**      | Metrics step with thresholds | KPI with target thresholds                 |
| **Sparkline**         | Inline sparkline in grid     | Trend lines within table cells             |
| **Event timeline**    | Timeline visualization       | Event sequence visualization               |
| **Treemap**           | Treemap                      | Hierarchical data visualization            |
| **Sankey diagram**    | Not available natively       | Use custom JSON visualization or Power BI  |
| **Dashboard tokens**  | Workbook parameters          | Dynamic filters cascading across steps     |
| **Drilldown**         | Parameter-based linking      | Click to filter or navigate to detail view |
| **Trellis layout**    | Split by parameter           | Multiple charts split by dimension         |

---

## 3. Common SOC dashboard conversions

### Security Operations Center overview

**Splunk dashboard panel (SPL):**

```spl
<panel>
  <title>Security Events by Severity (Last 24h)</title>
  <chart>
    <search>
      <query>index=main sourcetype=*security*
      | stats count by severity
      | sort -count</query>
      <earliest>-24h</earliest>
    </search>
    <option name="charting.chart">pie</option>
  </chart>
</panel>
```

**Sentinel workbook (KQL):**

```kql
SecurityAlert
| where TimeGenerated > ago(24h)
| summarize Count = count() by AlertSeverity
| sort by Count desc
| render piechart
```

### Authentication monitoring

**Splunk dashboard (SPL):**

```spl
index=auth action=failure
| timechart span=1h count by src_ip limit=10
```

**Sentinel workbook (KQL):**

```kql
SigninLogs
| where TimeGenerated > ago(24h)
| where ResultType != 0
| summarize FailureCount = count() by bin(TimeGenerated, 1h), IPAddress
| top-nested 10 of IPAddress by max(FailureCount)
| render timechart
```

### Firewall activity

**Splunk dashboard (SPL):**

```spl
index=firewall sourcetype=pan:traffic action=blocked
| stats count by dest_port
| sort -count
| head 20
```

**Sentinel workbook (KQL):**

```kql
CommonSecurityLog
| where TimeGenerated > ago(24h)
| where DeviceAction == "Deny"
| summarize Count = count() by DestinationPort
| top 20 by Count
| render barchart
```

### Incident trend

**Splunk dashboard (SPL):**

```spl
`notable`
| timechart span=1d count by urgency
```

**Sentinel workbook (KQL):**

```kql
SecurityIncident
| where TimeGenerated > ago(30d)
| summarize Count = count() by bin(TimeGenerated, 1d), Severity
| render timechart
```

---

## 4. Workbook parameters (replacing Splunk tokens)

Splunk dashboard tokens become workbook parameters:

**Splunk tokens:**

```xml
<input type="time" token="time_range">
  <label>Time Range</label>
  <default>
    <earliest>-24h</earliest>
    <latest>now</latest>
  </default>
</input>
<input type="dropdown" token="severity_filter">
  <label>Severity</label>
  <choice value="*">All</choice>
  <choice value="critical">Critical</choice>
  <choice value="high">High</choice>
</input>
```

**Workbook parameters:**

```json
{
    "type": 9,
    "content": {
        "version": "KqlParameterItem/1.0",
        "parameters": [
            {
                "name": "TimeRange",
                "type": 4,
                "defaultValue": "Last 24 hours",
                "typeSettings": {
                    "selectableValues": [
                        { "durationMs": 3600000, "displayName": "Last 1 hour" },
                        {
                            "durationMs": 86400000,
                            "displayName": "Last 24 hours"
                        },
                        {
                            "durationMs": 604800000,
                            "displayName": "Last 7 days"
                        }
                    ]
                }
            },
            {
                "name": "Severity",
                "type": 2,
                "query": "SecurityAlert | distinct AlertSeverity",
                "typeSettings": { "additionalResourceOptions": ["value::all"] }
            }
        ]
    }
}
```

**Using parameters in queries:**

```kql
SecurityAlert
| where TimeGenerated {TimeRange}
| where "{Severity}" == "All" or AlertSeverity == "{Severity}"
| summarize Count = count() by AlertSeverity
```

---

## 5. Pre-built workbook templates

Sentinel provides extensive pre-built workbook templates via Content Hub:

| Workbook template               | Replaces Splunk dashboard | Coverage                                             |
| ------------------------------- | ------------------------- | ---------------------------------------------------- |
| **Microsoft Sentinel Overview** | ES Security Posture       | Overall SIEM health, incident trends, data ingestion |
| **Azure AD Sign-in Logs**       | Authentication dashboard  | Sign-in analytics, MFA, conditional access           |
| **Investigation Insights**      | ES Investigation          | Entity-centric investigation summary                 |
| **Threat Intelligence**         | ES Threat Intelligence    | TI indicator matching, IOC analytics                 |
| **MITRE ATT&CK**                | ES MITRE ATT&CK           | Detection coverage by ATT&CK technique               |
| **Incident Overview**           | ES Incident Review        | Incident management metrics, MTTR, assignment        |
| **Network Watcher**             | Network traffic dashboard | NSG flow analytics, traffic patterns                 |
| **Microsoft 365**               | O365 security dashboard   | M365 security events, DLP, compliance                |
| **Identity and Access**         | Identity dashboard        | Entra ID analytics, privileged access monitoring     |
| **Insecure Protocols**          | Protocol analysis         | Deprecated protocol usage detection                  |

### Deploying workbook templates

```powershell
# List available workbook templates
az sentinel metadata list \
    --resource-group "rg-sentinel" \
    --workspace-name "law-sentinel" \
    --query "[?kind=='Workbook'].{Name:name, Source:source.name}" \
    --output table
```

---

## 6. Custom workbook creation

### Building a custom SOC operations workbook

```json
{
    "$schema": "https://github.com/Microsoft/Application-Insights-Workbooks/blob/master/schema/workbook.json",
    "version": "Notebook/1.0",
    "items": [
        {
            "type": 1,
            "content": {
                "json": "## SOC Operations Dashboard\nSecurity Operations Center overview for the last {TimeRange}"
            }
        },
        {
            "type": 3,
            "content": {
                "version": "KqlItem/1.0",
                "query": "SecurityIncident\n| where TimeGenerated {TimeRange}\n| summarize\n    TotalIncidents = count(),\n    OpenIncidents = countif(Status == 'New' or Status == 'Active'),\n    ClosedIncidents = countif(Status == 'Closed'),\n    AvgCloseTime = avg(ClosedTime - CreatedTime)\n",
                "size": 3,
                "title": "Incident Summary",
                "queryType": 0,
                "visualization": "tiles",
                "tileSettings": {
                    "titleContent": { "columnMatch": "Column1" },
                    "leftContent": { "columnMatch": "Value", "formatter": 12 }
                }
            }
        },
        {
            "type": 3,
            "content": {
                "version": "KqlItem/1.0",
                "query": "SecurityIncident\n| where TimeGenerated {TimeRange}\n| summarize Count = count() by bin(TimeGenerated, 1d), Severity\n| render timechart",
                "size": 0,
                "title": "Incident Trend by Severity",
                "queryType": 0,
                "visualization": "timechart"
            }
        }
    ]
}
```

### Deploying workbooks via Bicep

```bicep
// modules/sentinel/workbook-soc-overview.bicep
param location string
param workspaceId string

resource workbook 'Microsoft.Insights/workbooks@2022-04-01' = {
  name: guid('soc-overview-workbook')
  location: location
  kind: 'shared'
  properties: {
    displayName: 'SOC Operations Overview'
    category: 'sentinel'
    sourceId: workspaceId
    serializedData: loadTextContent('workbook-templates/soc-overview.json')
  }
}
```

---

## 7. Power BI integration for executive dashboards

For CISO-level and board-level reporting, CSA-in-a-Box Power BI provides capabilities beyond what Sentinel workbooks offer:

### When to use workbooks vs Power BI

| Requirement                  | Sentinel workbooks | Power BI (CSA-in-a-Box)  |
| ---------------------------- | ------------------ | ------------------------ |
| SOC operational dashboards   | Primary            | --                       |
| Real-time SOC monitoring     | Primary            | --                       |
| Threat hunting visualization | Primary            | --                       |
| Executive / CISO reporting   | --                 | Primary                  |
| Board-level security posture | --                 | Primary                  |
| Cross-domain analytics       | --                 | Primary                  |
| Mobile dashboards            | Limited            | Primary                  |
| Natural language queries     | --                 | Primary (Copilot)        |
| Scheduled email reports      | Limited            | Primary                  |
| Data-driven alerts           | --                 | Primary (Data Activator) |

### Power BI security dashboard pattern

```kql
// KQL query for Power BI DirectQuery or export
// Security posture summary for executive dashboard
let IncidentMetrics = SecurityIncident
| where CreatedTime > ago(30d)
| summarize
    TotalIncidents = count(),
    CriticalIncidents = countif(Severity == "High"),
    MTTR_Hours = avg(datetime_diff('hour', ClosedTime, CreatedTime)),
    AutomatedClose = countif(Classification == "TruePositive" and ClosedTime - CreatedTime < 1h)
    by bin(CreatedTime, 1d);
let AlertMetrics = SecurityAlert
| where TimeGenerated > ago(30d)
| summarize
    TotalAlerts = count(),
    UniqueAlerts = dcount(AlertName)
    by bin(TimeGenerated, 1d);
IncidentMetrics
| join kind=leftouter AlertMetrics on $left.CreatedTime == $right.TimeGenerated
```

---

## 8. Migration checklist

- [ ] Inventory all Splunk dashboards (name, panels, queries, users)
- [ ] Categorize: SOC operational vs executive vs compliance vs ad-hoc
- [ ] Map SOC dashboards to Sentinel workbook templates (Content Hub)
- [ ] Map executive dashboards to Power BI via CSA-in-a-Box
- [ ] Convert SPL panel queries to KQL
- [ ] Map Splunk tokens to workbook parameters
- [ ] Build and test custom workbooks for dashboards without templates
- [ ] Deploy workbooks via Bicep (infrastructure as code)
- [ ] Configure Power BI semantic models for executive reporting
- [ ] Train SOC analysts on workbook navigation and customization
- [ ] Validate dashboard parity during parallel-run period

---

**Next steps:**

- [Historical Data Migration](historical-data-migration.md) -- migrate Splunk index data
- [Tutorial: SPL to KQL](tutorial-spl-to-kql.md) -- convert dashboard queries
- [Best Practices](best-practices.md) -- migration strategy

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
