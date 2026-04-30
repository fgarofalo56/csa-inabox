# SAP Security Migration to Azure

**Migrating SAP authentication, authorization, GRC, network security, and data encryption to Azure-native security services.**

---

## Overview

SAP security spans identity, authorization, governance, network, and data protection. Migrating to Azure provides an opportunity to consolidate SAP's fragmented security model (SAP user management, SNC, GRC, IdM) into a unified platform built on Microsoft Entra ID, Purview, Defender for Cloud, and Azure networking. This guide covers each security domain with migration patterns and CSA-in-a-Box integration.

---

## 1. SAP authentication to Entra ID SSO

### 1.1 SAML 2.0 SSO for SAP Fiori and Web GUI

```
User → Entra ID (authentication) → SAML assertion → SAP NetWeaver → SAP Fiori
```

#### Entra ID SAML configuration for SAP

```bash
# Register SAP as an enterprise application in Entra ID
az ad app create \
  --display-name "SAP S/4HANA Production" \
  --identifier-uris "https://sap-s4h-prd.contoso.com/sap/saml2/sp" \
  --web-redirect-uris "https://sap-s4h-prd.contoso.com/sap/saml2/sp/acs"
```

| Configuration step  | Entra ID setting                          | SAP setting                                          |
| ------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Entity ID           | Application ID URI                        | Transaction SAML2 → Local Provider → Entity ID       |
| ACS URL             | Reply URL                                 | Transaction SAML2 → Trusted Providers → ACS endpoint |
| NameID              | user.userprincipalname or user.employeeid | Transaction SAML2 → NameID mapping                   |
| Signing certificate | Download from Entra ID                    | Upload to SAP Trust Manager (STRUST)                 |
| Metadata exchange   | Entra ID Federation Metadata URL          | Transaction SAML2 → Metadata import                  |
| Conditional Access  | Require MFA, compliant device             | N/A (enforced at Entra ID layer)                     |

### 1.2 OAuth 2.0 for SAP API access

```
Client App → Entra ID (OAuth token) → API Management → SAP Gateway (OData)
```

```xml
<!-- API Management policy: validate Entra ID token, forward to SAP -->
<policies>
    <inbound>
        <validate-jwt header-name="Authorization">
            <openid-config url="https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" />
            <audiences>
                <audience>api://sap-gateway-prod</audience>
            </audiences>
        </validate-jwt>
        <!-- Map Entra ID claims to SAP user -->
        <set-header name="sap-client" exists-action="override">
            <value>100</value>
        </set-header>
    </inbound>
</policies>
```

### 1.3 Principal propagation (Entra ID user to SAP user)

Principal propagation maps the authenticated Entra ID user to the corresponding SAP user, preserving authorization context.

| Approach                   | How it works                                                  | Use case           |
| -------------------------- | ------------------------------------------------------------- | ------------------ |
| SAML assertion with NameID | Entra ID sends SAP user ID in NameID claim                    | SAP Fiori, Web GUI |
| OAuth2 with user mapping   | Entra ID token → APIM → SAP .NET Connector with impersonation | API-based access   |
| X.509 certificate mapping  | Entra ID issues short-lived cert → SAP SNC accepts            | Backend-to-backend |

---

## 2. SAP GRC to Azure governance

### 2.1 SAP GRC Access Control to Entra ID Governance

| SAP GRC Access Control feature    | Azure equivalent                           | Notes                                        |
| --------------------------------- | ------------------------------------------ | -------------------------------------------- |
| Access Risk Analysis (ARA)        | Entra ID Governance + PIM access reviews   | SoD rules → Entra ID access review policies  |
| Business Role Management          | Entra ID groups + Azure RBAC               | SAP roles map to Entra ID group-based access |
| Emergency Access Management (EAM) | Entra PIM (Privileged Identity Management) | JIT access replaces firefighter IDs          |
| User Access Review (UAR)          | Entra ID Access Reviews                    | Periodic review of SAP access via Entra      |
| Risk mitigation                   | Entra ID Conditional Access + PIM          | Risk-based access policies                   |

### 2.2 Firefighter ID migration

SAP GRC firefighter IDs provide emergency privileged access with logging. The Azure equivalent is Entra PIM.

| SAP GRC firefighter               | Entra PIM equivalent                            |
| --------------------------------- | ----------------------------------------------- |
| Firefighter ID (shared account)   | PIM-eligible role assignment (personal account) |
| Firefighter controller (approver) | PIM approval workflow                           |
| Firefighter log (audit trail)     | PIM audit log + Azure Monitor                   |
| Time-limited access               | PIM time-bound activation (1--8 hours)          |
| Reason code required              | PIM justification required                      |

```bash
# Create PIM-eligible assignment for SAP emergency access
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/roleManagement/directory/roleEligibilityScheduleRequests" \
  --body '{
    "action": "adminAssign",
    "justification": "SAP emergency access role",
    "roleDefinitionId": "<sap-admin-role-id>",
    "directoryScopeId": "/",
    "principalId": "<user-object-id>",
    "scheduleInfo": {
      "startDateTime": "2026-04-30T00:00:00Z",
      "expiration": {
        "type": "afterDuration",
        "duration": "P365D"
      }
    }
  }'
```

### 2.3 SAP GRC Process Control to Purview Compliance Manager

| SAP GRC Process Control | Azure equivalent                             | Migration approach                         |
| ----------------------- | -------------------------------------------- | ------------------------------------------ |
| Control definitions     | Purview Compliance Manager assessments       | Map controls to compliance frameworks      |
| Control testing         | Purview + Azure Policy automated assessments | Automate control testing with Azure Policy |
| Risk assessments        | Purview + Defender for Cloud risk scoring    | Continuous risk assessment                 |
| Audit management        | Purview audit logs + Azure Monitor           | Centralized audit trail                    |
| Policy management       | Azure Policy + Purview data policies         | Policy-as-code for data governance         |

---

## 3. Network security for SAP on Azure

### 3.1 Network architecture

```
Internet
    │
    ▼
Azure Front Door (WAF)
    │
    ▼
Azure Firewall (hub VNet)
    │
    ▼
SAP VNet (spoke)
├── sap-web-subnet     ── NSG ── Web Dispatcher, Fiori
├── sap-app-subnet     ── NSG ── Application servers (ASCS, dialog)
├── sap-db-subnet      ── NSG ── HANA VMs (private only)
└── sap-mgmt-subnet    ── NSG ── Azure Bastion (no public IPs)
```

### 3.2 Network security controls

| Control                  | Azure service                          | SAP SNC equivalent              |
| ------------------------ | -------------------------------------- | ------------------------------- |
| Perimeter firewall       | Azure Firewall Premium                 | Router/firewall in front of SAP |
| Web application firewall | Azure Front Door WAF / App Gateway WAF | SAP Web Dispatcher rules        |
| Network segmentation     | NSG (per-subnet)                       | Network zones in data center    |
| DDoS protection          | Azure DDoS Protection Standard         | Data center DDoS appliance      |
| Private connectivity     | Private Link + Private Endpoints       | SNC encryption                  |
| Jump box access          | Azure Bastion (no public IPs)          | SSH/RDP jump servers            |
| DNS resolution           | Azure Private DNS                      | Internal DNS servers            |
| Traffic inspection       | Azure Firewall TLS inspection          | Network packet inspection       |

### 3.3 Azure Firewall rules for SAP

```bash
# Azure Firewall network rules for SAP
az network firewall network-rule create \
  --resource-group rg-hub-network \
  --firewall-name fw-hub \
  --collection-name SAP-Network-Rules \
  --name Allow-HANA-SQL \
  --source-addresses "10.1.2.0/24" \
  --destination-addresses "10.1.1.0/24" \
  --destination-ports 30015 39913-39915 \
  --protocols TCP \
  --priority 200 \
  --action Allow

# Application rules for SAP software downloads
az network firewall application-rule create \
  --resource-group rg-hub-network \
  --firewall-name fw-hub \
  --collection-name SAP-App-Rules \
  --name Allow-SAP-Downloads \
  --source-addresses "10.1.0.0/16" \
  --target-fqdns "softwaredownloads.sap.com" "support.sap.com" "launchpad.support.sap.com" \
  --protocols Https=443 \
  --priority 300 \
  --action Allow
```

---

## 4. SAP data encryption on Azure

### 4.1 Encryption at rest

| Layer                             | Azure service                                        | Configuration                           |
| --------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| HANA data volume encryption (TDE) | SAP HANA TDE + Azure Key Vault (BYOK)                | HANA root key stored in Azure Key Vault |
| OS disk encryption                | Azure Disk Encryption (ADE) or host-based encryption | BitLocker (Windows) or dm-crypt (Linux) |
| ANF volume encryption             | ANF encryption at rest (platform-managed or CMK)     | Double encryption available             |
| Backup encryption                 | Azure Backup encryption (platform or CMK)            | Automatic for HANA streaming backup     |
| OneLake / Fabric encryption       | Microsoft-managed or CMK                             | Data at rest encrypted in OneLake       |

### 4.2 Encryption in transit

| Communication path      | Encryption                       | Notes                                |
| ----------------------- | -------------------------------- | ------------------------------------ |
| Client → SAP Fiori      | TLS 1.2/1.3 (Azure Front Door)   | Enforced by Azure                    |
| App server → HANA       | HANA internal TLS (sapcryptolib) | SAP-managed TLS                      |
| HANA → HANA (HSR)       | TLS (HSR encryption)             | Configure in HANA system replication |
| HANA → Azure Backup     | TLS 1.2                          | BACKINT interface over TLS           |
| HANA → Fabric Mirroring | TLS 1.2                          | Microsoft-managed                    |
| Azure Bastion → SAP VM  | TLS 1.2                          | Azure Bastion native encryption      |

### 4.3 Azure Key Vault for SAP HANA TDE

```bash
# Create Key Vault for SAP HANA encryption keys
az keyvault create \
  --name kv-sap-hana-encryption \
  --resource-group rg-sap-security \
  --location eastus2 \
  --sku premium \
  --enable-purge-protection true \
  --enable-soft-delete true \
  --retention-days 90

# Create encryption key for HANA TDE
az keyvault key create \
  --vault-name kv-sap-hana-encryption \
  --name hana-tde-root-key \
  --kty RSA \
  --size 2048 \
  --ops encrypt decrypt wrapKey unwrapKey

# Grant HANA VM managed identity access to Key Vault
az keyvault set-policy \
  --name kv-sap-hana-encryption \
  --object-id <hana-vm-managed-identity-oid> \
  --key-permissions get list wrapKey unwrapKey
```

---

## 5. Microsoft Defender for Cloud for SAP

### 5.1 Defender for Cloud capabilities for SAP

| Capability               | Description                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Threat detection for SAP | Detect suspicious activities in SAP application logs (failed logons, privilege escalation, sensitive transaction execution) |
| Vulnerability assessment | Identify SAP-specific misconfigurations and vulnerabilities                                                                 |
| Security recommendations | SAP-specific security posture recommendations                                                                               |
| SIEM integration         | Stream SAP security logs to Microsoft Sentinel                                                                              |
| Incident investigation   | Investigate SAP security incidents in Sentinel with cross-platform correlation                                              |

### 5.2 Sentinel for SAP threat detection

```bash
# Deploy Microsoft Sentinel SAP connector
# Prerequisites: SAP NetWeaver 7.22+, SAP role /MSFTSEN/SENTINEL_RESPONDER

# Install SAP data connector agent
az sentinel data-connector create \
  --resource-group rg-sentinel \
  --workspace-name law-sentinel \
  --data-connector-id sap-connector \
  --kind "SAPViaAgent"
```

| SAP log source                  | Sentinel table  | Detection examples                                 |
| ------------------------------- | --------------- | -------------------------------------------------- |
| SAP Security Audit Log (SM20)   | SAPAuditLog_CL  | Failed logons, transaction execution, user changes |
| SAP Change Document Log (SCDoc) | SAPChangeDoc_CL | Unauthorized master data changes                   |
| SAP HANA audit trail            | SAPHANAAudit_CL | Privilege escalation, schema changes               |
| SAP ICM Log                     | SAPICM_CL       | Web attack detection                               |
| SAP Syslog                      | SAPSyslog_CL    | System errors, crashes                             |
| SAP ABAP Spool                  | SAPSpoolLog_CL  | Sensitive data printing                            |

---

## 6. CSA-in-a-Box security integration

| Integration                         | CSA-in-a-Box component       | SAP security context                                     |
| ----------------------------------- | ---------------------------- | -------------------------------------------------------- |
| Purview for SAP data classification | Purview scanner for HANA     | Classify SAP data fields as PII, financial, HR-sensitive |
| Purview data access governance      | Purview policies             | Enforce data access policies on SAP data in OneLake      |
| Entra ID unified identity           | Entra ID SSO                 | Single identity for SAP and all Azure services           |
| Azure Monitor                       | ACSS + Log Analytics         | Unified security monitoring across SAP and CSA-in-a-Box  |
| Compliance control mappings         | CSA-in-a-Box compliance YAML | NIST 800-53, FedRAMP, CMMC mappings include SAP controls |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Feature Mapping](feature-mapping-complete.md) | [Infrastructure Migration](infrastructure-migration.md) | [Federal Migration Guide](federal-migration-guide.md)
