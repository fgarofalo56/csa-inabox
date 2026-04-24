---
title: Security & Compliance Best Practices
description: Defense-in-depth security and compliance guidance for CSA-in-a-Box analytics platforms
tags:
    - security
    - compliance
    - networking
    - identity
    - encryption
    - azure-government
---

# Security & Compliance Best Practices

## Overview

CSA-in-a-Box deploys analytics platforms that handle sensitive data across federal, healthcare, and enterprise environments. Security is not an afterthought — it is embedded into every layer of the architecture through **defense-in-depth** and **Zero Trust** principles.

**Core Zero Trust Tenets:**

- **Verify explicitly** — Always authenticate and authorize based on all available data points (identity, location, device, service, data classification, anomalies).
- **Use least-privilege access** — Limit user access with Just-In-Time (JIT) and Just-Enough-Access (JEA), risk-based adaptive policies, and data protection.
- **Assume breach** — Minimize blast radius and segment access. Verify end-to-end encryption. Use analytics to detect threats, drive improvements, and improve defenses.

!!! tip "Layered Security Model"
No single control is sufficient. Each layer compensates for gaps in other layers. Network isolation stops lateral movement, identity controls prevent unauthorized access, encryption protects data at rest and in transit, and monitoring detects anomalies.

---

## Network Architecture

The following diagram illustrates the target network topology for a secure CSA-in-a-Box deployment.

```mermaid
graph TB
    subgraph Internet
        Users["Analysts / Users"]
        CICD["CI/CD Pipelines"]
    end

    subgraph Hub VNet
        FW["Azure Firewall<br/>Egress Control"]
        Bastion["Azure Bastion<br/>Secure Admin Access"]
        VPN["VPN Gateway /<br/>ExpressRoute"]
    end

    subgraph Spoke: Data Platform VNet
        subgraph Data Subnet
            ADLS["ADLS Gen2<br/>Private Endpoint"]
            Synapse["Synapse Analytics<br/>Private Endpoint"]
            ADF["Data Factory<br/>Private Endpoint"]
        end

        subgraph Compute Subnet
            DBX["Databricks Workspace<br/>VNet-Injected"]
            IR["Self-Hosted IR<br/>VM"]
        end

        subgraph Management Subnet
            KV["Key Vault<br/>Private Endpoint"]
            Purview["Microsoft Purview<br/>Private Endpoint"]
        end

        NSG1["NSG: Data"]
        NSG2["NSG: Compute"]
        NSG3["NSG: Management"]
    end

    Users -->|"HTTPS / Conditional Access"| FW
    CICD -->|"Service Principal"| FW
    FW --> ADLS
    FW --> Synapse
    FW --> DBX
    Bastion -->|"RDP/SSH"| IR
    VPN -->|"On-prem connectivity"| FW
    NSG1 -.->|"Deny by default"| Data Subnet
    NSG2 -.->|"Deny by default"| Compute Subnet
    NSG3 -.->|"Deny by default"| Management Subnet
```

---

## Network Isolation

### VNet Design — Hub-Spoke with Data Landing Zones

Adopt a **hub-spoke topology** where shared services (firewall, DNS, bastion) live in the hub, and each data landing zone occupies its own spoke VNet. This provides blast-radius containment and clear network boundaries.

| Component                  | Subnet         | Purpose                        |
| -------------------------- | -------------- | ------------------------------ |
| ADLS Gen2, Synapse, ADF    | `data-snet`    | Data storage and orchestration |
| Databricks, Self-Hosted IR | `compute-snet` | Compute workloads              |
| Key Vault, Purview         | `mgmt-snet`    | Secrets and governance         |
| Azure Firewall, Bastion    | Hub VNet       | Shared network services        |

### Private Endpoints for All PaaS Services

Every PaaS service **must** connect through a Private Endpoint. This removes the service from the public internet and routes traffic entirely through the VNet backbone.

**Required Private Endpoints:**

- Azure Data Lake Storage Gen2 (`blob`, `dfs` sub-resources)
- Azure Databricks (front-end and back-end connectivity via VNet injection)
- Azure Synapse Analytics (`Sql`, `SqlOnDemand`, `Dev`)
- Azure Key Vault (`vault`)
- Microsoft Purview (`account`, `portal`)
- Azure Data Factory (`dataFactory`)

### NSG Rules — Deny by Default

Every subnet must have an NSG attached with an explicit **deny-all inbound** rule at the lowest priority. Allow only required traffic.

| Priority | Direction | Source         | Destination | Port | Action   | Purpose           |
| -------- | --------- | -------------- | ----------- | ---- | -------- | ----------------- |
| 100      | Inbound   | `compute-snet` | `data-snet` | 443  | Allow    | Databricks → ADLS |
| 110      | Inbound   | `mgmt-snet`    | `data-snet` | 443  | Allow    | Purview scanning  |
| 4096     | Inbound   | Any            | Any         | Any  | **Deny** | Default deny      |

### Azure Firewall for Egress Control

All outbound traffic must route through Azure Firewall with application and network rules. Block all egress by default and allow only required FQDNs (e.g., PyPI for Databricks library installs, Microsoft Entra ID for authentication).

### Service Endpoints vs Private Endpoints

| Feature                | Service Endpoints                          | Private Endpoints             |
| ---------------------- | ------------------------------------------ | ----------------------------- |
| Traffic path           | Microsoft backbone, public IP              | Private IP in your VNet       |
| DNS                    | Public DNS                                 | Private DNS zone required     |
| Cross-region           | Yes                                        | Yes (with peering)            |
| Data exfiltration risk | Higher — traffic goes to service public IP | Lower — traffic stays in VNet |
| **Recommendation**     | **Avoid for sensitive workloads**          | **Always prefer**             |

### Do / Don't — Network Isolation

| ✅ Do                                           | ❌ Don't                                                  |
| ----------------------------------------------- | --------------------------------------------------------- |
| Use Private Endpoints for every PaaS service    | Leave storage accounts with public network access enabled |
| Attach NSGs to every subnet                     | Use `Allow *` inbound rules                               |
| Route egress through Azure Firewall             | Allow unrestricted outbound internet access               |
| Use Azure Private DNS Zones for name resolution | Rely on public DNS for Private Endpoint resolution        |
| Enable NSG flow logs for audit                  | Assume VNet isolation alone is sufficient                 |
| Peer spokes through the hub firewall            | Peer spokes directly without inspection                   |

### Bicep — Private Endpoint for ADLS Gen2

```bicep
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: 'pe-${storageAccountName}-blob'
  location: location
  properties: {
    subnet: {
      id: dataSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${storageAccountName}-blob'
        properties: {
          privateLinkServiceId: storageAccount.id
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource privateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'config-blob'
        properties: {
          privateDnsZoneId: blobPrivateDnsZoneId
        }
      }
    ]
  }
}

// Disable public access on the storage account
resource storageNetworkRules 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  properties: {
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
    }
  }
}
```

---

## Identity & Access Management

### Managed Identity Everywhere

Use **system-assigned or user-assigned Managed Identities** for every service-to-service interaction. Managed Identities eliminate credentials entirely — no connection strings, no keys, no passwords to rotate.

| Service                 | Identity Type      | Accesses                    |
| ----------------------- | ------------------ | --------------------------- |
| Azure Data Factory      | System-assigned MI | ADLS, Key Vault, Databricks |
| Databricks              | User-assigned MI   | ADLS, Key Vault             |
| Synapse                 | System-assigned MI | ADLS, Key Vault             |
| App Service / Functions | System-assigned MI | Key Vault, SQL, ADLS        |

### Microsoft Entra ID Group-Based RBAC

Assign roles to **Entra ID security groups**, not individual users. This ensures consistent access, simplifies auditing, and enables bulk changes.

**Recommended Group Structure:**

| Group                  | Role Assignment               | Scope                   |
| ---------------------- | ----------------------------- | ----------------------- |
| `sg-data-engineers`    | Storage Blob Data Contributor | ADLS resource group     |
| `sg-data-analysts`     | Storage Blob Data Reader      | ADLS resource group     |
| `sg-data-admins`       | Key Vault Administrator       | Key Vault               |
| `sg-platform-ops`      | Contributor                   | Platform resource group |
| `sg-security-auditors` | Reader + Security Reader      | Subscription            |

### Least Privilege — Specific Roles, Not Owner/Contributor

!!! warning "Avoid broad roles"
Never assign **Owner** or **Contributor** at subscription scope for day-to-day operations. Use purpose-built roles scoped to the narrowest resource.

| ❌ Overly Broad                 | ✅ Least Privilege                                 |
| ------------------------------- | -------------------------------------------------- |
| `Owner` at subscription         | `Storage Blob Data Contributor` at storage account |
| `Contributor` at resource group | `Data Factory Contributor` at ADF instance         |
| `Key Vault Contributor`         | `Key Vault Secrets User` (read-only for apps)      |

### Service Principals — CI/CD Only

Service principals with client secrets should **only** be used for CI/CD pipelines that cannot use Managed Identity (e.g., GitHub Actions). Prefer **federated credentials (OIDC)** to eliminate secret management entirely.

### Conditional Access Policies

Enforce Conditional Access for all human users accessing the data platform:

- **Require MFA** for all users
- **Block legacy authentication** protocols
- **Require compliant devices** for admin access
- **Restrict by location** — allow only corporate network or approved IPs
- **Session controls** — enforce sign-in frequency for sensitive apps

### Just-In-Time (JIT) Access

Use **Privileged Identity Management (PIM)** for elevated roles:

- Admin roles are **eligible**, not permanently assigned
- Activation requires justification and optional approval
- Time-boxed to 1–8 hours maximum
- All activations are logged and auditable

### Do / Don't — Identity & Access

| ✅ Do                                            | ❌ Don't                                               |
| ------------------------------------------------ | ------------------------------------------------------ |
| Use Managed Identity for service-to-service auth | Store connection strings or account keys in config     |
| Assign roles to Entra ID groups                  | Assign roles to individual users                       |
| Use PIM for admin elevation                      | Permanently assign Owner or Contributor                |
| Prefer federated credentials (OIDC) for CI/CD    | Create long-lived service principal secrets            |
| Enforce MFA via Conditional Access               | Allow password-only authentication                     |
| Scope roles to specific resources                | Assign roles at management group or subscription level |

### Bicep — Role Assignment with Managed Identity

```bicep
// Assign Storage Blob Data Contributor to Data Factory's managed identity
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource roleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, dataFactory.id, storageBlobDataContributorRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataContributorRoleId
    )
    principalId: dataFactory.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
```

---

## Encryption

### Encryption at Rest

All Azure PaaS services encrypt data at rest by default with **platform-managed keys (PMK)**. For regulated workloads, use **customer-managed keys (CMK)** stored in Key Vault.

| Tier                        | Key Management                        | Use Case                         |
| --------------------------- | ------------------------------------- | -------------------------------- |
| Platform-managed keys (PMK) | Microsoft manages keys automatically  | Default, non-regulated workloads |
| Customer-managed keys (CMK) | You manage keys in Key Vault          | FedRAMP High, CMMC, HIPAA        |
| Double encryption           | PMK + CMK (infrastructure encryption) | Highest sensitivity data         |

!!! info "CMK Requirements"
CMK requires a Key Vault with **soft delete** and **purge protection** enabled. The storage account or service must have a system-assigned managed identity to access the key.

### Encryption in Transit

- Enforce **TLS 1.2** minimum on all services
- Set `minimumTlsVersion: 'TLS1_2'` on storage accounts
- Disable insecure protocols (HTTP, SMB 2.x, unencrypted NFS)
- Use HTTPS-only for all API and data access

### Double Encryption

For the most sensitive workloads, enable **infrastructure encryption** which adds a second layer of encryption with a separate key at the hardware level.

```bicep
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    encryption: {
      requireInfrastructureEncryption: true  // Double encryption
      keySource: 'Microsoft.Keyvault'
      keyvaultproperties: {
        keyvaulturi: keyVaultUri
        keyname: encryptionKeyName
      }
    }
  }
  identity: {
    type: 'SystemAssigned'
  }
}
```

### Key Rotation Automation

- Configure **auto-rotation** in Key Vault for encryption keys
- Set rotation policy: rotate every 90 days, notify 30 days before expiry
- Use Event Grid to trigger automation on key near-expiry events
- Test rotation in staging before enabling in production

---

## Secrets Management

### Key Vault for Everything

All secrets, keys, and certificates **must** be stored in Azure Key Vault. No exceptions.

| Secret Type        | Key Vault Object | Example                    |
| ------------------ | ---------------- | -------------------------- |
| Database passwords | Secret           | `sql-admin-password`       |
| API keys           | Secret           | `external-api-key`         |
| Encryption keys    | Key              | `adls-cmk-key`             |
| TLS certificates   | Certificate      | `api-tls-cert`             |
| Connection strings | Secret           | `cosmos-connection-string` |

### Key Vault References in Services

| Service            | Integration Method                                  |
| ------------------ | --------------------------------------------------- |
| Azure Data Factory | Linked Service → Key Vault reference                |
| Databricks         | Secret Scope backed by Key Vault                    |
| App Service        | `@Microsoft.KeyVault(SecretUri=...)` app setting    |
| Azure Functions    | `@Microsoft.KeyVault(VaultName=...;SecretName=...)` |
| Synapse            | Linked Service → Key Vault reference                |

### Secret Rotation

- Set expiration dates on all secrets
- Use Event Grid + Azure Functions for automated rotation
- Rotate secrets every **90 days** at minimum
- Implement zero-downtime rotation (dual-key pattern)

!!! danger "Never Store Secrets in Code"
**NEVER** commit secrets, keys, or connection strings to source control. This includes:

    - Hardcoded passwords in application code
    - Connection strings in `appsettings.json` committed to git
    - API keys in Databricks notebooks or cells
    - Secrets passed as ADF pipeline parameters
    - Account keys in Bicep parameter files
    - `.env` files committed to repositories

    Use **Key Vault references** and **Managed Identity** for all secret access.

!!! danger "No Environment Variables for Secrets in Notebooks"
Databricks notebooks should **never** read secrets from environment variables or widget parameters. Use the **Databricks secret scope** backed by Azure Key Vault:

    ```python
    # ✅ Correct — Key Vault-backed secret scope
    secret = dbutils.secrets.get(scope="keyvault-scope", key="api-key")

    # ❌ WRONG — Never do this
    secret = os.environ["API_KEY"]
    secret = dbutils.widgets.get("api_key")
    ```

---

## Compliance Framework Alignment

### FedRAMP High — Key Control Mappings

| NIST Control Family            | Key Controls             | Azure Service / Feature                           |
| ------------------------------ | ------------------------ | ------------------------------------------------- |
| **AC — Access Control**        | AC-2, AC-3, AC-6         | Entra ID, PIM, RBAC, Conditional Access           |
| **AU — Audit**                 | AU-2, AU-3, AU-6, AU-12  | Azure Monitor, Diagnostic Settings, Log Analytics |
| **CM — Configuration Mgmt**    | CM-2, CM-6, CM-7         | Azure Policy, Bicep IaC, Azure Automation         |
| **IA — Identification & Auth** | IA-2, IA-5, IA-8         | Entra ID MFA, Managed Identity, Federated OIDC    |
| **IR — Incident Response**     | IR-4, IR-5, IR-6         | Microsoft Sentinel, Defender for Cloud            |
| **SC — System & Comms**        | SC-7, SC-8, SC-12, SC-28 | VNet, Private Endpoints, TLS 1.2+, Key Vault, CMK |
| **SI — System Integrity**      | SI-2, SI-3, SI-4         | Defender for Cloud, Azure Update Manager          |

### CMMC 2.0 Level 2 Alignment

CMMC Level 2 maps to the 110 practices in NIST SP 800-171 Rev 2. Key domains covered by CSA-in-a-Box:

- **Access Control (AC)** — Entra ID RBAC, Conditional Access, PIM
- **Audit & Accountability (AU)** — Diagnostic Settings, Log Analytics, Sentinel
- **Configuration Management (CM)** — Bicep IaC, Azure Policy, immutable deployments
- **Identification & Authentication (IA)** — MFA, Managed Identity, certificate-based auth
- **Media Protection (MP)** — CMK encryption, secure data disposal
- **System & Communications Protection (SC)** — Private Endpoints, TLS, network segmentation

### HIPAA Security Rule Alignment

| HIPAA Safeguard                     | Requirement                                  | Azure Implementation                |
| ----------------------------------- | -------------------------------------------- | ----------------------------------- |
| Access Control (§164.312(a))        | Unique user identification, emergency access | Entra ID, PIM, break-glass accounts |
| Audit Controls (§164.312(b))        | Record and examine access                    | Diagnostic Settings, Activity Log   |
| Integrity Controls (§164.312(c))    | Protect ePHI from improper alteration        | ADLS immutability, CMK encryption   |
| Transmission Security (§164.312(e)) | Encrypt ePHI in transit                      | TLS 1.2+, Private Endpoints         |
| Encryption (§164.312(a)(2)(iv))     | Encrypt ePHI at rest                         | CMK, double encryption              |

### NIST 800-53 Rev 5 — Priority Controls

For data analytics platforms, focus on these high-impact control families:

1. **SC-7 Boundary Protection** — Network segmentation, Private Endpoints, Azure Firewall
2. **AC-6 Least Privilege** — PIM, scoped RBAC, Managed Identity
3. **AU-2 Event Logging** — Diagnostic Settings on all resources
4. **SC-28 Protection of Information at Rest** — CMK encryption
5. **IA-2 Multi-Factor Authentication** — Conditional Access with MFA
6. **CM-2 Baseline Configuration** — Bicep IaC as the single source of truth

!!! tip "Cross-Reference"
See the [Compliance documentation](../compliance/) for detailed control matrices, evidence collection templates, and audit preparation guides.

---

## Azure Government

### When to Use Azure Government vs Commercial

| Criteria                           | Azure Government               | Azure Commercial          |
| ---------------------------------- | ------------------------------ | ------------------------- |
| FedRAMP High / DoD IL4+            | ✅ Required                    | ❌ Not sufficient         |
| ITAR / EAR data                    | ✅ Required                    | ❌ Not permitted          |
| CUI (Controlled Unclassified Info) | ✅ Recommended                 | ⚠️ Possible with controls |
| Non-regulated workloads            | ⚠️ Unnecessary cost/limitation | ✅ Preferred              |

### Service Availability Differences

Not all Azure services are available in Azure Government. Key gaps to watch:

- **Azure Databricks** — Available in Gov, but check region availability
- **Microsoft Purview** — Check current availability in Gov regions
- **Azure OpenAI Service** — Limited availability in Gov
- **Managed Grafana** — May not be available; plan alternatives

!!! warning "Always verify service availability"
Check the [Azure Government services by region](https://azure.microsoft.com/en-us/explore/global-infrastructure/government/services/) page before architecture decisions. See also the [Gov Service Matrix](../GOV_SERVICE_MATRIX.md) guide.

### Endpoint Differences

| Service                | Commercial                  | Azure Government                |
| ---------------------- | --------------------------- | ------------------------------- |
| Entra ID               | `login.microsoftonline.com` | `login.microsoftonline.us`      |
| Azure Resource Manager | `management.azure.com`      | `management.usgovcloudapi.net`  |
| Storage (blob)         | `*.blob.core.windows.net`   | `*.blob.core.usgovcloudapi.net` |
| Key Vault              | `*.vault.azure.net`         | `*.vault.usgovcloudapi.net`     |
| SQL Database           | `*.database.windows.net`    | `*.database.usgovcloudapi.net`  |

!!! info "Bicep & Terraform"
Use `environment()` functions in Bicep or `azurerm` provider `environment` parameter in Terraform to automatically resolve correct endpoints. Never hardcode cloud-specific URLs.

---

## Audit & Monitoring

### Diagnostic Settings for All Resources

**Every deployed resource** must have Diagnostic Settings configured to send logs and metrics to a central **Log Analytics Workspace**.

```bicep
resource diagnosticSettings 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-${resourceName}'
  scope: targetResource
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: true
          days: 365
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: true
          days: 90
        }
      }
    ]
  }
}
```

### Azure Activity Log Retention

- Export Activity Logs to Log Analytics (minimum **1 year** for compliance)
- Archive to Storage Account for long-term retention (**7 years** for FedRAMP)
- Set up alerts for critical administrative operations (role assignments, policy changes, resource deletions)

### Microsoft Defender for Cloud

Enable **Defender for Cloud** with the following plans:

| Plan                          | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| Defender for Storage          | Detect anomalous access, malware uploads         |
| Defender for Key Vault        | Detect unusual secret access patterns            |
| Defender for Resource Manager | Detect suspicious management operations          |
| Defender for SQL              | SQL injection, brute force detection             |
| Defender for Containers       | Container vulnerability scanning (if applicable) |

Review and remediate **Secure Score** recommendations weekly.

### Microsoft Sentinel for Security Analytics

For organizations requiring a SIEM:

- Connect all Diagnostic Settings to the Sentinel workspace
- Enable built-in analytics rules for Azure resource anomalies
- Create custom analytics rules for data platform-specific threats (e.g., bulk data export, unusual storage access patterns)
- Configure automated response playbooks for critical alerts

---

## Anti-Patterns

!!! danger "Storage Account with Public Access"
**Never** leave a storage account with `publicNetworkAccess: 'Enabled'` and `defaultAction: 'Allow'`. This exposes all data to the internet.

!!! danger "Shared Account Keys for Application Access"
Account keys grant **full control** over the entire storage account. Never use `listKeys()` in application code. Use Managed Identity with RBAC instead.

!!! danger "Owner Role for Automation"
CI/CD pipelines and automation accounts should **never** have `Owner` role. Use the narrowest role that accomplishes the task (e.g., `Contributor` scoped to a single resource group, or better, specific resource-level roles).

!!! danger "Secrets in Pipeline Variables"
Azure DevOps pipeline variables and GitHub Actions secrets are convenient but not a substitute for Key Vault. Pipeline variables are visible to pipeline editors and may appear in logs. Always reference Key Vault from pipelines.

!!! danger "Diagnostic Settings Not Configured"
If a resource has no Diagnostic Settings, you have **zero visibility** into security events. Deploy diagnostic settings as part of every resource module — never as an afterthought.

!!! danger "No Network Segmentation"
Deploying all resources into a single flat VNet with no NSGs provides no blast-radius containment. An attacker who compromises one service can reach everything.

---

## Security Checklist

Use this checklist before any environment is promoted to production.

### Network

- [ ] All PaaS services connected via Private Endpoints
- [ ] Public network access disabled on all storage accounts, Key Vaults, and databases
- [ ] NSGs attached to every subnet with deny-all default
- [ ] Azure Firewall configured for egress filtering
- [ ] NSG flow logs enabled and sent to Log Analytics
- [ ] Private DNS Zones configured for all Private Endpoint types
- [ ] No direct spoke-to-spoke peering (all traffic routes through hub)

### Identity & Access

- [ ] Managed Identity used for all service-to-service authentication
- [ ] No account keys, connection strings, or passwords in configuration
- [ ] RBAC assigned to Entra ID groups, not individual users
- [ ] No permanent Owner or Contributor assignments
- [ ] PIM enabled for admin roles
- [ ] Conditional Access policies enforce MFA
- [ ] Legacy authentication protocols blocked
- [ ] Break-glass accounts created, documented, and monitored
- [ ] Service principals use federated credentials (OIDC) where possible

### Encryption

- [ ] TLS 1.2 minimum enforced on all services
- [ ] Customer-managed keys configured (if required by compliance)
- [ ] Infrastructure encryption enabled for sensitive workloads
- [ ] Key rotation policy configured in Key Vault
- [ ] Key Vault has soft delete and purge protection enabled

### Secrets

- [ ] All secrets stored in Key Vault (none in code, config, or env vars)
- [ ] Secret expiration dates set
- [ ] Secret rotation automation configured
- [ ] Databricks uses Key Vault-backed secret scopes
- [ ] ADF Linked Services reference Key Vault for credentials

### Compliance

- [ ] Azure Policy assignments enforce required configurations
- [ ] Regulatory compliance dashboard reviewed in Defender for Cloud
- [ ] Control mapping documented for applicable framework (FedRAMP/CMMC/HIPAA)
- [ ] Evidence collection automated where possible

### Monitoring

- [ ] Diagnostic Settings configured on every resource
- [ ] Activity Log exported to Log Analytics (1-year minimum retention)
- [ ] Defender for Cloud enabled with relevant plans
- [ ] Secure Score reviewed and remediation tracked
- [ ] Alerts configured for critical security events
- [ ] Security contact email configured in Defender for Cloud
- [ ] Sentinel deployed (if SIEM required)

### Azure Government (if applicable)

- [ ] All services confirmed available in target Gov region
- [ ] Endpoints use `.us` / `.usgovcloudapi.net` suffixes
- [ ] No hardcoded commercial cloud URLs in code or templates
- [ ] Gov-specific compliance requirements validated
