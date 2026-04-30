# Federal Migration Guide: Azure Monitor in Azure Government

**Audience:** Federal CISOs, Security Architects, Compliance Officers, ATO Teams
**Last updated:** 2026-04-30

---

## Overview

Federal agencies and defense contractors face unique constraints when selecting observability platforms. FedRAMP authorization, DoD Impact Level (IL) requirements, data residency mandates, and FIPS cryptographic validation are non-negotiable prerequisites -- not optional features. This guide covers deploying Azure Monitor in Azure Government to meet these requirements.

Azure Monitor in Azure Government provides:

- **FedRAMP High** authorization inherited through the Azure Government boundary
- **DoD IL4 and IL5** coverage for Log Analytics, Application Insights, Azure Monitor Metrics, and Alerts
- **Data residency** within US sovereign boundaries (US Gov Virginia, US Gov Arizona)
- **FIPS 140-2 validated cryptographic modules** for data in transit and at rest
- **Managed identity authentication** eliminating the need for API keys or shared secrets

No third-party observability vendor provides equivalent coverage. This is not a competitive claim; it is a factual assessment of the current market.

---

## Compliance coverage comparison

| Compliance framework   | Azure Monitor (Gov)      | Datadog               | New Relic             | Splunk Observability |
| ---------------------- | ------------------------ | --------------------- | --------------------- | -------------------- |
| FedRAMP High           | Yes (inherited)          | No (Moderate limited) | No (Moderate limited) | No                   |
| FedRAMP Moderate       | Yes                      | Partial               | Partial               | No                   |
| DoD IL2                | Yes                      | No (commercial only)  | No (commercial only)  | No                   |
| DoD IL4                | Yes                      | No                    | No                    | No                   |
| DoD IL5                | Yes                      | No                    | No                    | No                   |
| DoD IL6                | Out of scope             | No                    | No                    | No                   |
| ITAR                   | Yes (Gov data residency) | No                    | No                    | No                   |
| CJIS                   | Yes (Gov)                | No                    | No                    | No                   |
| HIPAA BAA              | Yes                      | Enterprise only       | Yes                   | Yes                  |
| SOC 2 Type II          | Yes                      | Yes                   | Yes                   | Yes                  |
| ISO 27001              | Yes                      | Yes                   | Yes                   | Yes                  |
| FIPS 140-2             | Yes (validated modules)  | No                    | No                    | No                   |
| Section 508 / WCAG 2.1 | Yes (Azure Portal)       | Partial               | Partial               | Partial              |

---

## Azure Government deployment considerations

### Region selection

| Region          | Use case                          | IL coverage   |
| --------------- | --------------------------------- | ------------- |
| US Gov Virginia | Primary region for most workloads | IL2, IL4, IL5 |
| US Gov Arizona  | Secondary/DR region               | IL2, IL4, IL5 |
| US Gov Texas    | Additional capacity               | IL2, IL4      |
| US DoD Central  | DoD-specific workloads            | IL5, IL6      |
| US DoD East     | DoD-specific workloads            | IL5, IL6      |

### Service endpoints

Azure Government uses different endpoints than commercial Azure.

| Service                 | Commercial endpoint               | Government endpoint         |
| ----------------------- | --------------------------------- | --------------------------- |
| Log Analytics ingestion | `*.ods.opinsights.azure.com`      | `*.ods.opinsights.azure.us` |
| Log Analytics query     | `api.loganalytics.io`             | `api.loganalytics.us`       |
| Application Insights    | `*.applicationinsights.azure.com` | `*.applicationinsights.us`  |
| Azure Monitor metrics   | `*.monitoring.azure.com`          | `*.monitoring.azure.us`     |
| Entra ID (auth)         | `login.microsoftonline.com`       | `login.microsoftonline.us`  |

### Bicep deployment for Azure Government

```bicep
// Parameters
param location string = 'usgovvirginia'
param workspaceName string = 'law-fed-observability'
param appInsightsName string = 'ai-fed-app'

// Log Analytics workspace with IL5-appropriate retention
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    retentionInDays: 365  // 1-year for NIST AU-11
    sku: {
      name: 'PerGB2018'
    }
    publicNetworkAccessForIngestion: 'Disabled'  // Private Link only
    publicNetworkAccessForQuery: 'Disabled'       // Private Link only
    features: {
      enableDataExport: false  // Prevent data leaving sovereign boundary
      disableLocalAuth: true   // Entra ID only (no workspace keys)
    }
  }
}

// Customer-managed key (CMK) for IL5
resource cmkCluster 'Microsoft.OperationalInsights/clusters@2021-06-01' = {
  name: 'cluster-fed-cmk'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    keyVaultProperties: {
      keyVaultUri: keyVault.properties.vaultUri
      keyName: 'log-analytics-cmk'
      keyVersion: ''  // Auto-rotate
    }
  }
}

// Application Insights (workspace-based)
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    DisableLocalAuth: true  // Entra ID only
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Disabled'
  }
}
```

---

## NIST 800-53 control mapping (AU family)

Azure Monitor addresses the Audit and Accountability (AU) control family that observability platforms must satisfy.

| Control | Requirement                                  | Azure Monitor implementation                                                                   |
| ------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| AU-2    | Event logging                                | Diagnostic settings on all Azure resources; AMA for VMs; Application Insights for applications |
| AU-3    | Content of audit records                     | Log Analytics schema captures timestamp, source, type, outcome, identity                       |
| AU-4    | Audit log storage capacity                   | Commitment tiers scale to petabytes; auto-archive to storage accounts                          |
| AU-5    | Response to audit logging failures           | Azure Monitor Alerts on ingestion failures; Health service notifications                       |
| AU-6    | Audit record review, analysis, reporting     | KQL for analysis; Workbooks for reporting; automated alert rules                               |
| AU-7    | Audit record reduction and report generation | KQL summarize/reduce; Workbooks with parameters; scheduled queries                             |
| AU-8    | Time stamps                                  | UTC with NTP synchronization; TimeGenerated field in all records                               |
| AU-9    | Protection of audit information              | RBAC on Log Analytics; CMK encryption; Private Link access                                     |
| AU-10   | Non-repudiation                              | Managed identity authentication; Entra ID audit trail                                          |
| AU-11   | Audit record retention                       | Configurable 31-2555 days (interactive); archive for long-term                                 |
| AU-12   | Audit record generation                      | AMA auto-deploys via Azure Policy; diagnostic settings via Bicep                               |

### CSA-in-a-Box compliance integration

CSA-in-a-Box maps AU controls in `csa_platform/csa_platform/governance/compliance/nist-800-53-rev5.yaml`. Azure Monitor diagnostic settings are deployed automatically by the platform's Bicep modules, ensuring that every provisioned resource (Fabric workspace, Databricks cluster, ADF pipeline, Purview scan) emits audit records to the central Log Analytics workspace.

---

## Data residency and sovereignty

### Log data residency

All data stored in Azure Monitor Log Analytics workspaces in Azure Government remains within the US sovereign boundary. Specific guarantees:

- **Ingestion:** Data is ingested through government endpoints (`.azure.us`)
- **Storage:** Data is stored in the selected government region (US Gov Virginia or US Gov Arizona)
- **Processing:** All query processing occurs within the government boundary
- **Replication:** Geo-redundant storage replicates within government regions only
- **No cross-boundary transfer:** Data does not transit commercial Azure or non-US regions

### ITAR compliance

For workloads subject to International Traffic in Arms Regulations (ITAR), Azure Government provides the required data residency and access controls. Azure Monitor logs containing ITAR-controlled technical data stay within the Azure Government boundary, accessed only by US persons through Entra ID with appropriate citizenship validation.

---

## Private Link (AMPLS) for zero-trust network access

Azure Monitor Private Link Scope (AMPLS) ensures that telemetry ingestion and query traffic never traverses the public internet.

```bicep
// Azure Monitor Private Link Scope
resource ampls 'Microsoft.Insights/privateLinkScopes@2021-07-01-preview' = {
  name: 'ampls-fed-observability'
  location: 'global'
  properties: {
    accessModeSettings: {
      ingestionAccessMode: 'PrivateOnly'
      queryAccessMode: 'PrivateOnly'
    }
  }
}

// Link workspace to AMPLS
resource amplsWorkspace 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = {
  parent: ampls
  name: 'link-workspace'
  properties: {
    linkedResourceId: workspace.id
  }
}

// Link Application Insights to AMPLS
resource amplsAppInsights 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = {
  parent: ampls
  name: 'link-appinsights'
  properties: {
    linkedResourceId: appInsights.id
  }
}

// Private endpoint
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-ampls-observability'
  location: location
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'ampls-connection'
        properties: {
          privateLinkServiceId: ampls.id
          groupIds: ['azuremonitor']
        }
      }
    ]
  }
}
```

---

## FIPS 140-2 endpoints

All Azure Monitor endpoints in Azure Government use FIPS 140-2 validated cryptographic modules for TLS 1.2+. No additional configuration is required -- FIPS compliance is inherited from the Azure Government platform.

Application Insights SDKs and the Azure Monitor Agent use the platform's TLS stack, which satisfies FIPS requirements when running on Azure Government VMs with FIPS mode enabled.

---

## Diagnostic settings for compliance evidence

Configure diagnostic settings on all Azure resources to generate continuous compliance evidence.

```bicep
// Diagnostic settings for Key Vault (example)
resource kvDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: keyVault
  name: 'diag-to-law'
  properties: {
    workspaceId: workspace.id
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Deploy diagnostic settings at scale via Azure Policy
resource policy 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'deploy-diagnostics-to-law'
  properties: {
    policyDefinitionId: '/providers/Microsoft.Authorization/policySetDefinitions/deploy-diagnostics-loganalytics'
    parameters: {
      logAnalytics: { value: workspace.id }
    }
  }
}
```

---

## FedRAMP continuous monitoring with Azure Monitor

Azure Monitor provides the continuous monitoring infrastructure required by FedRAMP.

| FedRAMP requirement               | Azure Monitor capability                      |
| --------------------------------- | --------------------------------------------- |
| Continuous vulnerability scanning | Azure Monitor alerts on Defender findings     |
| Configuration monitoring          | Azure Policy compliance state + Log Analytics |
| Log aggregation and correlation   | Centralized Log Analytics workspace           |
| Incident detection                | Alert rules + Smart Detection                 |
| Evidence preservation             | Log retention (365+ days) + archive           |
| Reporting                         | Workbooks + Power BI for POA&M dashboards     |
| Change detection                  | Activity Log + diagnostic settings            |

---

## Migration checklist for federal environments

- [ ] Deploy Log Analytics workspace in Azure Government region (US Gov Virginia recommended)
- [ ] Enable Private Link (AMPLS) with PrivateOnly access mode
- [ ] Disable local authentication (workspace keys) -- Entra ID only
- [ ] Deploy customer-managed keys (CMK) for IL5 workloads
- [ ] Configure retention to meet NIST AU-11 requirements (minimum 365 days)
- [ ] Configure archive for long-term compliance retention (1-7 years)
- [ ] Deploy Azure Monitor Agent via Azure Policy (auto-remediation)
- [ ] Enable diagnostic settings on all Azure resources via Azure Policy
- [ ] Verify government endpoints in all SDK and agent configurations
- [ ] Validate data residency (query workspace to confirm region)
- [ ] Configure Application Insights with government ingestion endpoints
- [ ] Document AU control mappings for ATO package
- [ ] Set up continuous monitoring alerts for FedRAMP compliance
- [ ] Create POA&M tracking workbook for ongoing compliance

---

**Related:** [Why Azure Monitor](why-azure-monitor.md) | [Best Practices](best-practices.md) | [Migration Playbook](../observability-to-azure-monitor.md) | [CSA-in-a-Box NIST 800-53 Mapping](../../compliance/nist-800-53-rev5.md)
