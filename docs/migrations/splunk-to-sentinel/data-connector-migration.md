# Data Connector Migration: Splunk to Sentinel

**Status:** Authored 2026-04-30
**Audience:** Security Engineers, SOC Infrastructure Teams, Platform Engineers
**Purpose:** Guide for migrating Splunk data inputs, forwarders, and apps to Microsoft Sentinel data connectors and Azure Monitor Agent

---

## 1. Data collection architecture comparison

### Splunk data collection

```
Data Sources ──> Forwarders (UF/HF) ──> Indexers ──> Search Heads
                      │
              syslog/CEF inputs
              scripted inputs
              modular inputs
              HTTP Event Collector (HEC)
              DB Connect
```

### Sentinel data collection

```
Data Sources ──> Data Connectors ──> Log Analytics Workspace ──> Sentinel
                      │
              Azure Monitor Agent (AMA)
              Syslog/CEF via AMA
              Data Collection API
              Content Hub solutions
              Native Microsoft connectors
              Logic App connectors
```

---

## 2. Forwarder to Azure Monitor Agent migration

### Replacing Universal Forwarders

| Splunk component                         | Azure equivalent              | Deployment method                                  |
| ---------------------------------------- | ----------------------------- | -------------------------------------------------- |
| **Universal Forwarder (Windows)**        | Azure Monitor Agent (AMA)     | Azure Arc, Intune, GPO, manual install             |
| **Universal Forwarder (Linux)**          | Azure Monitor Agent (AMA)     | Azure Arc, package manager, manual install         |
| **Heavy Forwarder (syslog aggregation)** | AMA on Linux log forwarder VM | Deploy dedicated log forwarder VM                  |
| **Deployment Server**                    | Azure Arc + Azure Policy      | Automated agent deployment and configuration       |
| **Server classes**                       | Data Collection Rules (DCRs)  | DCRs define what data to collect and where to send |

### Azure Monitor Agent deployment

=== "Azure Arc (recommended for servers)"

    ```powershell
    # Install AMA via Azure Arc on Windows servers
    # First, onboard server to Azure Arc
    azcmagent connect `
        --resource-group "rg-sentinel-prod" `
        --tenant-id "<tenant-id>" `
        --subscription-id "<subscription-id>" `
        --location "usgovvirginia"

    # Then deploy AMA via Azure Policy or manually
    az connectedmachine extension create `
        --resource-group "rg-sentinel-prod" `
        --machine-name "server01" `
        --name "AzureMonitorWindowsAgent" `
        --publisher "Microsoft.Azure.Monitor" `
        --type "AzureMonitorWindowsAgent"
    ```

=== "Bicep (infrastructure-as-code)"

    ```bicep
    // modules/monitoring/data-collection-rule.bicep
    param location string
    param workspaceId string
    param ruleName string = 'dcr-windows-security'

    resource dcr 'Microsoft.Insights/dataCollectionRules@2022-06-01' = {
      name: ruleName
      location: location
      properties: {
        dataSources: {
          windowsEventLogs: [
            {
              name: 'securityEvents'
              streams: ['Microsoft-SecurityEvent']
              xPathQueries: [
                'Security!*[System[(EventID=4624 or EventID=4625 or EventID=4648 or EventID=4672 or EventID=4688 or EventID=4720 or EventID=4726 or EventID=4740 or EventID=4767)]]'
                'System!*[System[(EventID=7045 or EventID=7040)]]'
              ]
            }
          ]
          syslog: [
            {
              name: 'syslogAuth'
              streams: ['Microsoft-Syslog']
              facilityNames: ['auth', 'authpriv']
              logLevels: ['Info', 'Notice', 'Warning', 'Error', 'Critical', 'Alert', 'Emergency']
            }
          ]
        }
        destinations: {
          logAnalytics: [
            {
              name: 'sentinelWorkspace'
              workspaceResourceId: workspaceId
            }
          ]
        }
        dataFlows: [
          {
            streams: ['Microsoft-SecurityEvent', 'Microsoft-Syslog']
            destinations: ['sentinelWorkspace']
          }
        ]
      }
    }
    ```

### Data Collection Rules (DCRs) -- replacing server classes

DCRs are the Sentinel equivalent of Splunk deployment server classes. They define:

- **What to collect** -- specific event IDs, log facilities, performance counters
- **How to transform** -- KQL-based transformations at ingestion time
- **Where to send** -- Log Analytics workspace destination

| Splunk server class concept | DCR equivalent                                   |
| --------------------------- | ------------------------------------------------ |
| Server class membership     | DCR association (link DCR to VMs/Arc machines)   |
| App deployment              | N/A -- agents collect via DCR, no apps to deploy |
| Input configuration         | Data source definitions in DCR                   |
| Props/transforms            | KQL transformation rules in DCR                  |
| Output targeting            | Destination configuration in DCR                 |

---

## 3. Data source migration matrix

### Network and firewall devices

| Splunk data source     | Splunk input method    | Sentinel connector      | Sentinel table              | Content Hub solution |
| ---------------------- | ---------------------- | ----------------------- | --------------------------- | -------------------- |
| **Palo Alto Firewall** | Syslog via UF/HF       | CEF via AMA             | CommonSecurityLog           | Palo Alto Networks   |
| **Cisco ASA**          | Syslog via UF/HF       | CEF via AMA             | CommonSecurityLog           | Cisco ASA            |
| **Cisco Firepower**    | eStreamer + Splunk app | CEF via AMA             | CommonSecurityLog           | Cisco Firepower      |
| **Fortinet FortiGate** | Syslog via UF/HF       | CEF via AMA             | CommonSecurityLog           | Fortinet FortiGate   |
| **Check Point**        | OPSEC LEA + Splunk app | CEF via AMA             | CommonSecurityLog           | Check Point          |
| **F5 BIG-IP**          | Syslog via UF/HF       | CEF via AMA or syslog   | CommonSecurityLog or Syslog | F5 Networks          |
| **Juniper SRX**        | Syslog via UF/HF       | Syslog via AMA          | Syslog                      | Juniper              |
| **Zscaler**            | Cloud-to-cloud (API)   | Zscaler connector       | CommonSecurityLog           | Zscaler              |
| **NetFlow/sFlow**      | Splunk Stream app      | NSG Flow Logs or custom | AzureNetworkAnalytics_CL    | Azure Network        |

### Endpoint and identity

| Splunk data source                  | Splunk input method   | Sentinel connector            | Sentinel table                  | Content Hub solution    |
| ----------------------------------- | --------------------- | ----------------------------- | ------------------------------- | ----------------------- |
| **Windows Security Events**         | UF with WinEventLog   | AMA with SecurityEvent        | SecurityEvent                   | Windows Security Events |
| **Windows Sysmon**                  | UF with Sysmon TA     | AMA with Sysmon DCR           | Event (Sysmon)                  | Windows Security Events |
| **Linux syslog**                    | UF syslog input       | AMA syslog                    | Syslog                          | Syslog                  |
| **Linux auditd**                    | UF with auditd input  | AMA with auditd               | Syslog (auditd)                 | Linux auditd            |
| **CrowdStrike Falcon**              | Splunk app (API pull) | CrowdStrike connector         | CrowdStrike tables              | CrowdStrike Falcon      |
| **Carbon Black**                    | Splunk app (API pull) | VMware Carbon Black connector | CarbonBlack tables              | VMware Carbon Black     |
| **Microsoft Defender for Endpoint** | Splunk app (API pull) | Native connector (free)       | DeviceEvents, DeviceLogonEvents | Microsoft 365 Defender  |
| **Active Directory**                | UF on DCs             | AMA on DCs                    | SecurityEvent                   | Windows Security Events |
| **Entra ID (Azure AD)**             | Splunk app (API pull) | Native connector (free)       | SigninLogs, AuditLogs           | Azure Active Directory  |

### Cloud platforms

| Splunk data source      | Splunk input method | Sentinel connector      | Sentinel table   | Content Hub solution  |
| ----------------------- | ------------------- | ----------------------- | ---------------- | --------------------- |
| **Azure Activity Logs** | Splunk Azure app    | Native connector (free) | AzureActivity    | Azure Activity        |
| **Azure Diagnostics**   | Splunk Azure app    | Diagnostic settings     | AzureDiagnostics | Various per service   |
| **AWS CloudTrail**      | Splunk AWS app      | AWS S3 connector        | AWSCloudTrail    | Amazon Web Services   |
| **AWS GuardDuty**       | Splunk AWS app      | AWS S3 connector        | AWSGuardDuty     | Amazon Web Services   |
| **GCP Audit Logs**      | Splunk GCP app      | GCP Pub/Sub connector   | GCPAuditLogs     | Google Cloud Platform |
| **Microsoft 365**       | Splunk O365 app     | Native connector (free) | OfficeActivity   | Microsoft 365         |
| **Azure Key Vault**     | Splunk Azure app    | Diagnostic settings     | AzureDiagnostics | Azure Key Vault       |

### Security tools

| Splunk data source                   | Splunk input method   | Sentinel connector            | Sentinel table              | Content Hub solution |
| ------------------------------------ | --------------------- | ----------------------------- | --------------------------- | -------------------- |
| **Qualys**                           | Splunk Qualys app     | Qualys connector              | QualysHostDetection         | Qualys VM            |
| **Tenable/Nessus**                   | Splunk Tenable app    | Tenable connector             | Tenable tables              | Tenable              |
| **Proofpoint**                       | Splunk Proofpoint app | Proofpoint connector          | Proofpoint tables           | Proofpoint           |
| **Okta**                             | Splunk Okta app       | Okta SSO connector            | Okta tables                 | Okta SSO             |
| **Symantec/Broadcom**                | Syslog/CEF            | CEF via AMA                   | CommonSecurityLog           | Broadcom Symantec    |
| **McAfee/Trellix**                   | Syslog/CEF            | CEF via AMA                   | CommonSecurityLog           | Trellix              |
| **Threat Intelligence (STIX/TAXII)** | Splunk TI app         | Threat Intelligence connector | ThreatIntelligenceIndicator | Threat Intelligence  |
| **MISP**                             | Splunk MISP app       | MISP connector or TAXII       | ThreatIntelligenceIndicator | MISP                 |

### Application and web

| Splunk data source   | Splunk input method  | Sentinel connector              | Sentinel table         | Content Hub solution |
| -------------------- | -------------------- | ------------------------------- | ---------------------- | -------------------- |
| **IIS Web Logs**     | UF with IIS monitor  | AMA with IIS logs               | W3CIISLog              | IIS                  |
| **Apache/Nginx**     | UF with file monitor | AMA syslog or custom            | Syslog or custom table | Apache/Nginx         |
| **DNS Logs**         | UF with DNS input    | DNS connector                   | DnsEvents              | DNS                  |
| **DHCP Logs**        | UF with DHCP input   | Custom via AMA                  | Custom table           | --                   |
| **Application logs** | UF/HEC               | Data Collection API             | Custom table           | --                   |
| **Database audit**   | DB Connect           | Logic App + Data Collection API | Custom table           | --                   |

---

## 4. Content Hub solutions

Content Hub solutions are the Sentinel equivalent of Splunkbase apps. Each solution typically includes:

- **Data connector** -- instructions and configuration for data ingestion
- **Analytics rules** -- pre-built detection rules for the data source
- **Workbooks** -- dashboards for the data source
- **Hunting queries** -- threat hunting queries
- **Playbooks** -- automation playbooks

### Deploying Content Hub solutions

```powershell
# List available solutions
az sentinel solution list --resource-group "rg-sentinel" --workspace-name "law-sentinel"

# Install a solution (example: Palo Alto Networks)
az sentinel solution create \
    --resource-group "rg-sentinel" \
    --workspace-name "law-sentinel" \
    --solution-name "PaloAltoNetworks" \
    --plan publisher="paloaltonetworks" product="PaloAlto-Networks" name="PaloAltoNetworks"
```

---

## 5. Syslog and CEF collector deployment

Many network devices that sent syslog to Splunk Heavy Forwarders will send to a Linux log forwarder VM with AMA:

### Architecture

```
Network Devices ──(syslog/CEF)──> Linux Forwarder VM ──(AMA)──> Log Analytics Workspace
                                       │
                                  AMA installed
                                  DCR configured
                                  rsyslog/syslog-ng
```

### Deployment

```bash
# On the Linux forwarder VM:

# 1. Install Azure Monitor Agent
# (via Azure Arc or direct install)
wget https://aka.ms/azcmagent -O install_linux_azcmagent.sh
bash install_linux_azcmagent.sh

# 2. Configure rsyslog to receive remote syslog
cat >> /etc/rsyslog.d/50-sentinel.conf << 'EOF'
# Accept syslog from network devices
module(load="imudp")
input(type="imudp" port="514")
module(load="imtcp")
input(type="imtcp" port="514")

# CEF messages go to local4
local4.* /var/log/cef.log
EOF

# 3. Restart rsyslog
systemctl restart rsyslog

# 4. AMA DCR handles forwarding to Log Analytics
# (configured via Azure portal or Bicep)
```

---

## 6. Custom data ingestion (replacing HEC)

Splunk HTTP Event Collector (HEC) is replaced by the Log Analytics Data Collection API:

### Splunk HEC equivalent

**Splunk HEC:**

```bash
curl -k https://splunk-hec:8088/services/collector \
  -H "Authorization: Splunk <hec-token>" \
  -d '{"event": "security event", "sourcetype": "custom:security", "index": "main"}'
```

**Log Analytics Data Collection API:**

```bash
# Using Data Collection Rule-based API
curl -X POST "https://<dce-endpoint>.ingest.monitor.azure.com/dataCollectionRules/<dcr-id>/streams/Custom-SecurityEvents_CL?api-version=2023-01-01" \
  -H "Authorization: Bearer <oauth-token>" \
  -H "Content-Type: application/json" \
  -d '[{"TimeGenerated": "2026-04-30T10:00:00Z", "EventMessage": "security event", "Severity": "High"}]'
```

---

## 7. Migration execution plan

### Step 1: Inventory current Splunk data sources

```spl
| rest /services/data/inputs/all
| table title, disabled, sourcetype, index
| where disabled=0
| stats count by sourcetype, index
```

### Step 2: Map to Sentinel connectors

For each active Splunk data source:

1. Check Content Hub for a matching solution
2. If no Content Hub solution, determine collection method (AMA, CEF, API, custom)
3. Document the target Sentinel table
4. Note any transformation requirements (field mapping, parsing)

### Step 3: Deploy connectors in phases

| Phase | Data sources                             | Priority | Notes                                  |
| ----- | ---------------------------------------- | -------- | -------------------------------------- |
| 1     | Microsoft native (M365, Entra, Defender) | Critical | Free ingestion, zero-effort connectors |
| 2     | Network perimeter (firewalls, IDS/IPS)   | Critical | CEF via AMA on log forwarder           |
| 3     | Endpoint (Windows, Linux, EDR)           | Critical | AMA deployment via Azure Arc           |
| 4     | Cloud platforms (Azure, AWS, GCP)        | High     | API-based connectors                   |
| 5     | Identity (Okta, Entra ID)                | High     | API-based connectors                   |
| 6     | Security tools (vulnerability, email)    | Medium   | Content Hub solutions                  |
| 7     | Application and custom logs              | Medium   | Data Collection API                    |
| 8     | Remaining sources                        | Low      | Evaluate necessity before migrating    |

### Step 4: Validate data flow

```kql
// Verify data is flowing from each connector
union withsource=TableName *
| where TimeGenerated > ago(24h)
| summarize
    EventCount = count(),
    FirstEvent = min(TimeGenerated),
    LastEvent = max(TimeGenerated)
    by TableName
| sort by EventCount desc
```

---

## 8. CSA-in-a-Box data connector integration

Security data flowing into Log Analytics is automatically available to CSA-in-a-Box analytics:

| Data flow            | Path                                                   | Use case                        |
| -------------------- | ------------------------------------------------------ | ------------------------------- |
| Sentinel to Fabric   | Log Analytics data export to Event Hub, Fabric ingests | Cross-domain security analytics |
| Sentinel to ADX      | Log Analytics data export to ADX                       | Long-term threat hunting        |
| Sentinel to Power BI | Direct query or export                                 | Executive security dashboards   |
| Sentinel to Purview  | Purview scans Log Analytics workspace                  | Compliance data classification  |

---

**Next steps:**

- [Dashboard Migration](dashboard-migration.md) -- migrate Splunk dashboards to workbooks
- [Historical Data Migration](historical-data-migration.md) -- migrate Splunk index data
- [Detection Rules Migration](detection-rules-migration.md) -- migrate correlation searches

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
