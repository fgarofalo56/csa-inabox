# Monitoring Migration: Citrix Director to AVD Insights

**Audience:** VDI Engineers, Operations Teams, Help Desk
**Scope:** Migrating from Citrix Director, Citrix Analytics, and Connection Quality Indicator (CQI) to Azure Monitor, AVD Insights, and Log Analytics.
**Last updated:** 2026-04-30

---

## Overview

Citrix Director is the primary monitoring and troubleshooting tool for Citrix environments. It provides real-time session monitoring, historical trending, logon duration analysis, and help desk tools. AVD Insights -- built on Azure Monitor and Log Analytics -- provides equivalent functionality with the added benefit of integration across the entire Azure ecosystem.

---

## 1. Feature mapping

| Citrix Director feature                  | AVD equivalent                               | Notes                                                  |
| ---------------------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| **Dashboard overview**                   | AVD Insights overview workbook               | Session counts, host health, user activity             |
| **Session details**                      | AVD Insights > Connection diagnostics        | Per-session details: RTT, bandwidth, errors            |
| **Logon duration analysis**              | AVD Insights > Logon performance             | Profile load, GPO processing, shell start, total logon |
| **User activity**                        | Log Analytics queries (WVDConnections table) | Connection start/stop, session duration                |
| **Machine details**                      | AVD Insights > Host performance              | CPU, memory, disk, network per host                    |
| **Application launch monitoring**        | Custom Log Analytics queries                 | Application process start events                       |
| **Historical trending**                  | Azure Monitor workbooks (custom timeframes)  | KQL queries with time range parameters                 |
| **Alerts**                               | Azure Monitor alert rules                    | KQL-based alerts with action groups                    |
| **Citrix Analytics for Security**        | Microsoft Sentinel + Defender for Cloud      | SIEM/XDR integration                                   |
| **Citrix Analytics for Performance**     | AVD Insights performance workbook            | Network quality, latency, experience scoring           |
| **Connection Quality Indicator (CQI)**   | AVD connection quality data                  | RTT, bandwidth, frame rate                             |
| **Filters and search**                   | KQL queries with filters                     | Flexible querying via Kusto                            |
| **Help desk (shadow/logoff/disconnect)** | Azure Portal + PowerShell                    | Admin actions via portal or script                     |
| **Notifications**                        | Azure Monitor action groups                  | Email, SMS, webhook, Logic App, ITSM                   |
| **EUEM scoring**                         | Intune Endpoint Analytics                    | End-user experience scoring                            |

---

## 2. Enable AVD diagnostics

### 2.1 Create Log Analytics workspace

```bash
# Create workspace for AVD diagnostics
az monitor log-analytics workspace create \
  --workspace-name law-avd-prod \
  --resource-group rg-avd-monitoring \
  --location eastus2 \
  --retention-time 90  # days
```

### 2.2 Configure diagnostic settings

```bash
# Enable diagnostics on host pool
az monitor diagnostic-settings create \
  --name diag-avd-hostpool \
  --resource /subscriptions/.../hostPools/hp-analytics-prod \
  --workspace law-avd-prod \
  --logs '[
    {"category": "Checkpoint", "enabled": true},
    {"category": "Error", "enabled": true},
    {"category": "Management", "enabled": true},
    {"category": "Connection", "enabled": true},
    {"category": "HostRegistration", "enabled": true},
    {"category": "AgentHealthStatus", "enabled": true},
    {"category": "NetworkData", "enabled": true},
    {"category": "SessionHostManagement", "enabled": true},
    {"category": "ConnectionGraphicsData", "enabled": true},
    {"category": "AutoscaleEvaluationPooled", "enabled": true}
  ]'

# Enable diagnostics on workspace
az monitor diagnostic-settings create \
  --name diag-avd-workspace \
  --resource /subscriptions/.../workspaces/ws-analytics-prod \
  --workspace law-avd-prod \
  --logs '[
    {"category": "Checkpoint", "enabled": true},
    {"category": "Error", "enabled": true},
    {"category": "Management", "enabled": true},
    {"category": "Feed", "enabled": true}
  ]'
```

### 2.3 Enable AVD Insights

AVD Insights is a pre-built Azure Monitor workbook:

1. Navigate to **Azure Portal > Azure Virtual Desktop > Insights**
2. Select the Log Analytics workspace (`law-avd-prod`)
3. Configure the performance counters on session hosts:

```powershell
# Install Azure Monitor Agent on session hosts (if not already installed)
# This can be done via Intune, GPO, or VM extension

# Required performance counters for AVD Insights:
# LogicalDisk(*)\% Free Space
# LogicalDisk(C:)\Avg. Disk Queue Length
# Memory(*)\Available Mbytes
# Memory(*)\Page Faults/sec
# Network Interface(*)\Bytes Total/sec
# PhysicalDisk(*)\Avg. Disk Queue Length
# PhysicalDisk(*)\Avg. Disk sec/Read
# PhysicalDisk(*)\Avg. Disk sec/Write
# Processor Information(_Total)\% Processor Time
# Process(*)\% Processor Time
# Process(*)\Working Set - Private
# RemoteFX Network(*)\Current TCP RTT
# RemoteFX Network(*)\Current UDP Bandwidth
# Terminal Services Session(*)\% Processor Time
# User Input Delay per Process(*)\Max Input Delay
# User Input Delay per Session(*)\Max Input Delay
```

---

## 3. Log Analytics queries for common monitoring scenarios

### 3.1 Active sessions (replaces Director dashboard)

```kusto
// Current active sessions
WVDConnections
| where TimeGenerated > ago(1h)
| where State == "Connected"
| summarize ActiveSessions = dcount(CorrelationId) by SessionHostName
| order by ActiveSessions desc
```

### 3.2 Logon duration analysis (replaces Director logon analysis)

```kusto
// Logon duration breakdown
WVDCheckpoints
| where TimeGenerated > ago(24h)
| where Name in ("LoadProfile", "ShellReady", "GroupPolicyProcessing", "OnConnectionComplete")
| extend Duration = todouble(Parameters.DurationMs)
| summarize AvgDuration = avg(Duration) by Name
| order by AvgDuration desc

// Detailed per-user logon times
WVDConnections
| where TimeGenerated > ago(24h)
| where State == "Connected"
| project UserName, SessionHostName, TimeGenerated,
    ProfileLoadTime = todouble(custom_dimensions.ProfileLoadTimeMs),
    GPOTime = todouble(custom_dimensions.GPOProcessingTimeMs),
    TotalLogonTime = todouble(custom_dimensions.TotalLogonTimeMs)
| order by TotalLogonTime desc
```

### 3.3 Connection errors (replaces Director alerts)

```kusto
// Connection failures in the last 24 hours
WVDErrors
| where TimeGenerated > ago(24h)
| where ServiceError == true
| summarize ErrorCount = count() by CodeSymbolic, Message
| order by ErrorCount desc

// User-specific connection issues
WVDConnections
| where TimeGenerated > ago(24h)
| where State == "Failed"
| project TimeGenerated, UserName, SessionHostName,
    ErrorCode = custom_dimensions.ErrorCode,
    ErrorMessage = custom_dimensions.ErrorMessage
| order by TimeGenerated desc
```

### 3.4 Session host health (replaces Director machine details)

```kusto
// Session host availability
WVDAgentHealthStatus
| where TimeGenerated > ago(1h)
| summarize arg_max(TimeGenerated, *) by SessionHostName
| project SessionHostName, LastHeartBeat = TimeGenerated,
    HealthStatus = iff(TimeGenerated > ago(5m), "Healthy", "Unhealthy"),
    ActiveSessions, AllowNewSessions
| order by HealthStatus asc

// CPU and memory utilization per host
Perf
| where TimeGenerated > ago(1h)
| where ObjectName == "Processor Information" and CounterName == "% Processor Time" and InstanceName == "_Total"
| summarize AvgCPU = avg(CounterValue) by Computer
| join kind=inner (
    Perf
    | where TimeGenerated > ago(1h)
    | where ObjectName == "Memory" and CounterName == "Available Mbytes"
    | summarize AvgMemAvail = avg(CounterValue) by Computer
) on Computer
| project Computer, AvgCPU, AvgMemAvailMB = AvgMemAvail
| order by AvgCPU desc
```

### 3.5 Network quality (replaces CQI)

```kusto
// RDP connection quality metrics
WVDConnectionNetworkData
| where TimeGenerated > ago(1h)
| summarize
    AvgRTT = avg(EstRoundTripTimeInMs),
    MaxRTT = max(EstRoundTripTimeInMs),
    AvgBandwidth = avg(EstAvailableBandwidthKBps)
  by SessionHostName, UserName
| order by AvgRTT desc

// Identify users with poor connection quality
WVDConnectionNetworkData
| where TimeGenerated > ago(24h)
| where EstRoundTripTimeInMs > 150  // >150ms indicates poor experience
| summarize PoorQualitySamples = count(), AvgRTT = avg(EstRoundTripTimeInMs)
  by UserName
| order by PoorQualitySamples desc
```

### 3.6 FSLogix profile performance

```kusto
// FSLogix profile load events
Event
| where TimeGenerated > ago(24h)
| where Source == "FSLogix-Apps/Operational"
| where EventID == 25  // Profile loaded
| extend ProfileLoadTime = extract("Profile loaded in (\\d+) ms", 1, RenderedDescription)
| project TimeGenerated, Computer, UserName = extract("User: (.+?)\\s", 1, RenderedDescription),
    ProfileLoadTimeMs = toint(ProfileLoadTime)
| order by ProfileLoadTimeMs desc

// FSLogix errors
Event
| where TimeGenerated > ago(24h)
| where Source == "FSLogix-Apps/Operational"
| where EventLevelName == "Error"
| project TimeGenerated, Computer, EventID, RenderedDescription
| order by TimeGenerated desc
```

### 3.7 User experience (input delay)

```kusto
// User input delay (responsiveness metric)
Perf
| where TimeGenerated > ago(1h)
| where ObjectName == "User Input Delay per Session"
    and CounterName == "Max Input Delay"
| summarize AvgInputDelay = avg(CounterValue), MaxInputDelay = max(CounterValue) by Computer
| where MaxInputDelay > 100  // >100ms is noticeable
| order by MaxInputDelay desc
```

---

## 4. Alert configuration

### 4.1 Create alert rules (replaces Director alerts)

```bash
# Alert: Session host unavailable
az monitor scheduled-query create \
  --name "alert-avd-host-unhealthy" \
  --resource-group rg-avd-monitoring \
  --scopes /subscriptions/.../workspaces/law-avd-prod \
  --condition "count > 0" \
  --condition-query "WVDAgentHealthStatus | where TimeGenerated > ago(10m) | where LastHeartBeat < ago(5m) | summarize UnhealthyHosts = dcount(SessionHostName)" \
  --severity 2 \
  --evaluation-frequency 5m \
  --window-size 10m \
  --action-groups /subscriptions/.../actionGroups/ag-avd-ops

# Alert: High connection failure rate
az monitor scheduled-query create \
  --name "alert-avd-connection-failures" \
  --resource-group rg-avd-monitoring \
  --scopes /subscriptions/.../workspaces/law-avd-prod \
  --condition "count > 10" \
  --condition-query "WVDConnections | where TimeGenerated > ago(15m) | where State == 'Failed' | summarize FailedConnections = count()" \
  --severity 1 \
  --evaluation-frequency 5m \
  --window-size 15m \
  --action-groups /subscriptions/.../actionGroups/ag-avd-ops

# Alert: FSLogix profile load failures
az monitor scheduled-query create \
  --name "alert-avd-fslogix-errors" \
  --resource-group rg-avd-monitoring \
  --scopes /subscriptions/.../workspaces/law-avd-prod \
  --condition "count > 0" \
  --condition-query "Event | where TimeGenerated > ago(15m) | where Source == 'FSLogix-Apps/Operational' | where EventLevelName == 'Error' | summarize Errors = count()" \
  --severity 2 \
  --evaluation-frequency 5m \
  --window-size 15m \
  --action-groups /subscriptions/.../actionGroups/ag-avd-ops

# Alert: High user input delay
az monitor scheduled-query create \
  --name "alert-avd-input-delay" \
  --resource-group rg-avd-monitoring \
  --scopes /subscriptions/.../workspaces/law-avd-prod \
  --condition "count > 5" \
  --condition-query "Perf | where TimeGenerated > ago(15m) | where ObjectName == 'User Input Delay per Session' and CounterName == 'Max Input Delay' | where CounterValue > 200 | summarize HighDelay = dcount(Computer)" \
  --severity 2 \
  --evaluation-frequency 5m \
  --window-size 15m \
  --action-groups /subscriptions/.../actionGroups/ag-avd-ops
```

---

## 5. Custom workbooks

### 5.1 Create a Citrix Director-style dashboard

AVD Insights provides a comprehensive built-in workbook. For organizations wanting a Citrix Director-style layout, create a custom workbook:

```json
{
    "version": "Notebook/1.0",
    "items": [
        {
            "type": "query",
            "name": "Active Sessions",
            "query": "WVDConnections | where State == 'Connected' | summarize Sessions = dcount(CorrelationId)",
            "visualization": "tiles"
        },
        {
            "type": "query",
            "name": "Failed Connections (24h)",
            "query": "WVDConnections | where TimeGenerated > ago(24h) | where State == 'Failed' | count",
            "visualization": "tiles"
        },
        {
            "type": "query",
            "name": "Session Host Status",
            "query": "WVDAgentHealthStatus | summarize arg_max(TimeGenerated, *) by SessionHostName | summarize Healthy = countif(TimeGenerated > ago(5m)), Unhealthy = countif(TimeGenerated <= ago(5m))",
            "visualization": "tiles"
        },
        {
            "type": "query",
            "name": "Average Logon Time",
            "query": "WVDCheckpoints | where Name == 'OnConnectionComplete' | extend Duration = todouble(Parameters.DurationMs) | summarize avg(Duration)",
            "visualization": "tiles"
        }
    ]
}
```

---

## 6. Help desk operations

### 6.1 Citrix Director admin actions mapped to AVD

| Director action          | AVD equivalent           | How to execute                                                              |
| ------------------------ | ------------------------ | --------------------------------------------------------------------------- |
| **Shadow session**       | No built-in shadow       | Use third-party (e.g., ScreenConnect) or RDP shadow                         |
| **Log off user**         | Log off session          | Azure Portal > Host Pool > Session Hosts > Select > User Sessions > Log Off |
| **Disconnect user**      | Disconnect session       | Azure Portal or `Remove-AzWvdUserSession` PowerShell                        |
| **Send message**         | Send message to session  | `Send-AzWvdUserSessionMessage` PowerShell cmdlet                            |
| **Reset profile**        | Delete FSLogix VHDx      | Delete user's VHDx from Azure Files; new one created at next login          |
| **Power on/off machine** | Start/Stop/Deallocate VM | Azure Portal or `Start-AzVM` / `Stop-AzVM`                                  |

### 6.2 PowerShell examples for help desk

```powershell
# List all user sessions
Get-AzWvdUserSession -HostPoolName hp-analytics-prod -ResourceGroupName rg-avd-prod

# Log off a specific user
Remove-AzWvdUserSession -HostPoolName hp-analytics-prod `
  -ResourceGroupName rg-avd-prod `
  -SessionHostName "sh-analytics-001.internal.company.com" `
  -Id 3 -Force

# Send message to all sessions on a host
$sessions = Get-AzWvdUserSession -HostPoolName hp-analytics-prod `
  -ResourceGroupName rg-avd-prod `
  -SessionHostName "sh-analytics-001.internal.company.com"

foreach ($session in $sessions) {
    Send-AzWvdUserSessionMessage -HostPoolName hp-analytics-prod `
      -ResourceGroupName rg-avd-prod `
      -SessionHostName "sh-analytics-001.internal.company.com" `
      -UserSessionId $session.Name.Split("/")[-1] `
      -MessageTitle "Maintenance Notice" `
      -MessageBody "This session host will restart in 30 minutes. Please save your work."
}
```

---

## 7. Citrix Director decommission

After AVD Insights is fully operational and the help desk is trained:

1. **Maintain Director** for 30 days in read-only mode (historical reference)
2. **Export historical data** from the Citrix Monitoring database for audit retention
3. **Decommission Director servers** and Monitoring SQL database
4. **Remove Citrix Analytics** subscriptions
5. **Update runbooks** and help desk documentation to reference AVD Insights and Azure Portal

---

**Maintainers:** CSA-in-a-Box core team
**Last updated:** 2026-04-30
