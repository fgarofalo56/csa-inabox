// --------------------------------------------------------------------------
// Sentinel Analytics Rules
// Deploys scheduled analytics rules for common threat detection scenarios.
// --------------------------------------------------------------------------

@description('Name of the Log Analytics workspace with Sentinel')
param workspaceName string

@description('Deployment environment')
@allowed(['dev', 'stg', 'prd'])
param environment string = 'dev'

// --------------------------------------------------------------------------
// Reference to existing workspace
// --------------------------------------------------------------------------

resource workspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = {
  name: workspaceName
}

// --------------------------------------------------------------------------
// Rule 1: Brute Force Detection
// --------------------------------------------------------------------------

resource bruteForceRule 'Microsoft.SecurityInsights/alertRules@2023-02-01-preview' = {
  scope: workspace
  name: guid(workspace.id, 'brute-force-detection')
  kind: 'Scheduled'
  properties: {
    displayName: 'Brute Force Attack - Multiple Failed Sign-Ins'
    description: 'Detects more than 10 failed sign-in attempts from a single IP address within a 5-minute window, indicating a potential brute force attack.'
    severity: 'Medium'
    enabled: true
    query: '''
      SigninLogs
      | where ResultType != "0"
      | summarize FailedAttempts = count(), TargetAccounts = dcount(UserPrincipalName), Accounts = make_set(UserPrincipalName, 10) by IPAddress, bin(TimeGenerated, 5m)
      | where FailedAttempts > 10
      | project TimeGenerated, IPAddress, FailedAttempts, TargetAccounts, Accounts
    '''
    queryFrequency: 'PT5M'
    queryPeriod: 'PT10M'
    triggerOperator: 'GreaterThan'
    triggerThreshold: 0
    suppressionDuration: 'PT1H'
    suppressionEnabled: true
    tactics: ['CredentialAccess']
    techniques: ['T1110']
    entityMappings: [
      {
        entityType: 'IP'
        fieldMappings: [
          { identifier: 'Address'; columnName: 'IPAddress' }
        ]
      }
    ]
  }
}

// --------------------------------------------------------------------------
// Rule 2: Suspicious PowerShell Execution
// --------------------------------------------------------------------------

resource powershellRule 'Microsoft.SecurityInsights/alertRules@2023-02-01-preview' = {
  scope: workspace
  name: guid(workspace.id, 'suspicious-powershell')
  kind: 'Scheduled'
  properties: {
    displayName: 'Suspicious PowerShell Command Execution'
    description: 'Detects PowerShell commands with common obfuscation techniques including encoded commands, bypass flags, and download cradles.'
    severity: 'High'
    enabled: true
    query: '''
      SecurityEvent
      | where EventID == 4688
      | where ProcessName endswith "powershell.exe" or ProcessName endswith "pwsh.exe"
      | where CommandLine has_any ("-EncodedCommand", "-enc", "FromBase64String", "bypass", "hidden", "Invoke-Expression", "IEX", "DownloadString", "Net.WebClient")
      | project TimeGenerated, Computer, Account, ProcessName, CommandLine, ParentProcessName
    '''
    queryFrequency: 'PT5M'
    queryPeriod: 'PT10M'
    triggerOperator: 'GreaterThan'
    triggerThreshold: 0
    suppressionDuration: 'PT30M'
    suppressionEnabled: true
    tactics: ['Execution', 'DefenseEvasion']
    techniques: ['T1059.001']
    entityMappings: [
      {
        entityType: 'Host'
        fieldMappings: [
          { identifier: 'HostName'; columnName: 'Computer' }
        ]
      }
      {
        entityType: 'Account'
        fieldMappings: [
          { identifier: 'Name'; columnName: 'Account' }
        ]
      }
    ]
  }
}

// --------------------------------------------------------------------------
// Rule 3: Lateral Movement via RDP from Unusual Source
// --------------------------------------------------------------------------

resource lateralMovementRule 'Microsoft.SecurityInsights/alertRules@2023-02-01-preview' = {
  scope: workspace
  name: guid(workspace.id, 'lateral-movement-rdp')
  kind: 'Scheduled'
  properties: {
    displayName: 'Lateral Movement - RDP from Unusual Source'
    description: 'Detects RDP logon events (Type 10) where the source host has not previously connected to the target within the last 14 days.'
    severity: 'High'
    enabled: true
    query: '''
      let baseline = SecurityEvent
      | where TimeGenerated between (ago(14d) .. ago(1d))
      | where EventID == 4624 and LogonType == 10
      | distinct IpAddress, Computer;
      SecurityEvent
      | where TimeGenerated > ago(1d)
      | where EventID == 4624 and LogonType == 10
      | join kind=leftanti baseline on IpAddress, Computer
      | project TimeGenerated, Computer, TargetAccount, IpAddress, LogonProcessName
    '''
    queryFrequency: 'PT15M'
    queryPeriod: 'P14D'
    triggerOperator: 'GreaterThan'
    triggerThreshold: 0
    suppressionDuration: 'PT1H'
    suppressionEnabled: true
    tactics: ['LateralMovement']
    techniques: ['T1021.001']
    entityMappings: [
      {
        entityType: 'Host'
        fieldMappings: [
          { identifier: 'HostName'; columnName: 'Computer' }
        ]
      }
      {
        entityType: 'IP'
        fieldMappings: [
          { identifier: 'Address'; columnName: 'IpAddress' }
        ]
      }
    ]
  }
}

// --------------------------------------------------------------------------
// Rule 4: Data Exfiltration Indicator
// --------------------------------------------------------------------------

resource exfiltrationRule 'Microsoft.SecurityInsights/alertRules@2023-02-01-preview' = {
  scope: workspace
  name: guid(workspace.id, 'data-exfiltration')
  kind: 'Scheduled'
  properties: {
    displayName: 'Data Exfiltration - Large Outbound Data Transfer'
    description: 'Detects outbound network transfers exceeding 500 MB to a single external destination within a 1-hour window.'
    severity: 'High'
    enabled: true
    query: '''
      AzureNetworkAnalytics_CL
      | where TimeGenerated > ago(1h)
      | where FlowDirection_s == "O" and FlowStatus_s == "A"
      | where not(ipv4_is_private(DestIP_s))
      | summarize TotalBytesSent = sum(tolong(BytesSent_d)) by SrcIP_s, DestIP_s, bin(TimeGenerated, 1h)
      | where TotalBytesSent > 524288000
      | extend TotalMB = round(TotalBytesSent / 1048576.0, 2)
      | project TimeGenerated, SrcIP_s, DestIP_s, TotalMB
    '''
    queryFrequency: 'PT30M'
    queryPeriod: 'PT1H'
    triggerOperator: 'GreaterThan'
    triggerThreshold: 0
    suppressionDuration: 'PT2H'
    suppressionEnabled: true
    tactics: ['Exfiltration']
    techniques: ['T1048']
    entityMappings: [
      {
        entityType: 'IP'
        fieldMappings: [
          { identifier: 'Address'; columnName: 'SrcIP_s' }
        ]
      }
    ]
  }
}

// --------------------------------------------------------------------------
// Rule 5: Communication with Known Malicious IP
// --------------------------------------------------------------------------

resource maliciousIpRule 'Microsoft.SecurityInsights/alertRules@2023-02-01-preview' = {
  scope: workspace
  name: guid(workspace.id, 'known-malicious-ip')
  kind: 'Scheduled'
  properties: {
    displayName: 'Communication with Known Malicious IP Address'
    description: 'Detects network connections to IP addresses flagged in Microsoft Threat Intelligence as malicious or associated with known threat actors.'
    severity: 'High'
    enabled: true
    query: '''
      let TI_IPs = ThreatIntelligenceIndicator
      | where ExpirationDateTime > now()
      | where NetworkIP != ""
      | distinct NetworkIP;
      AzureNetworkAnalytics_CL
      | where TimeGenerated > ago(1h)
      | where FlowDirection_s == "O"
      | join kind=inner TI_IPs on $left.DestIP_s == $right.NetworkIP
      | project TimeGenerated, SrcIP_s, DestIP_s, DestPort_d, BytesSent_d, BytesReceived_d
    '''
    queryFrequency: 'PT15M'
    queryPeriod: 'PT1H'
    triggerOperator: 'GreaterThan'
    triggerThreshold: 0
    suppressionDuration: 'PT1H'
    suppressionEnabled: true
    tactics: ['CommandAndControl']
    techniques: ['T1071']
    entityMappings: [
      {
        entityType: 'IP'
        fieldMappings: [
          { identifier: 'Address'; columnName: 'DestIP_s' }
        ]
      }
    ]
  }
}
