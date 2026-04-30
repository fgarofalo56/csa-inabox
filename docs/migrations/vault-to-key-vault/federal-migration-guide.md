# Federal Migration Guide: HashiCorp Vault to Azure Key Vault

**Status:** Authored 2026-04-30
**Audience:** Federal Security Architects, ISSOs, ISSMs, Authorization Officials, Federal Platform Engineers
**Purpose:** Guide for migrating HashiCorp Vault to Azure Key Vault in Azure Government with FIPS 140-3 Level 3, IL4/IL5, CMMC, and FedRAMP compliance

---

## Overview

Federal agencies and defense contractors operating HashiCorp Vault face unique migration considerations. Key management controls are among the most scrutinized in any federal authorization -- NIST 800-53 SC-12 (Cryptographic Key Establishment and Management) and SC-13 (Cryptographic Protection) are critical controls that directly impact Authority to Operate (ATO) timelines.

Azure Key Vault in Azure Government inherits the platform's FedRAMP High authorization. Key Vault Premium and Managed HSM provide FIPS 140-3 Level 3 hardware security module backing. Azure Government supports IL4 and IL5 data classifications, and Key Vault is authorized for both impact levels.

This guide addresses federal-specific requirements: FIPS validation, Impact Level handling, CMMC compliance, FedRAMP control mapping, and HSM-backed key management for classified data protection.

---

## 1. Federal compliance landscape

### Azure Government authorization status

| Service                 | FedRAMP | DoD IL2 | DoD IL4 | DoD IL5         | DoD IL6 |
| ----------------------- | ------- | ------- | ------- | --------------- | ------- |
| **Key Vault Standard**  | High    | Yes     | Yes     | No              | No      |
| **Key Vault Premium**   | High    | Yes     | Yes     | Yes (Azure Gov) | No      |
| **Managed HSM**         | High    | Yes     | Yes     | Yes             | Pending |
| **Entra ID (Gov)**      | High    | Yes     | Yes     | Yes             | No      |
| **Azure Monitor (Gov)** | High    | Yes     | Yes     | Yes             | No      |
| **Azure Policy**        | High    | Yes     | Yes     | Yes             | No      |

### FIPS 140-3 validation

| Component                       | FIPS level                                                    | Certificate                                       |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| **Key Vault Standard**          | Software cryptographic module (FIPS 140-2 Level 1 equivalent) | Not suitable for federal production               |
| **Key Vault Premium**           | FIPS 140-3 Level 3 (multi-tenant HSM pool)                    | Suitable for most federal workloads               |
| **Managed HSM**                 | FIPS 140-3 Level 3 (dedicated, single-tenant HSM)             | Required for IL5, CMMC Level 3, classified data   |
| **Vault OSS**                   | No FIPS validation                                            | Not suitable for federal production               |
| **Vault Enterprise + Luna HSM** | FIPS 140-2 Level 3 (Luna appliance)                           | HSM is validated, but Vault software layer is not |

**Key distinction:** With Key Vault Premium and Managed HSM, the entire key management operation occurs within the FIPS-validated HSM boundary. With Vault Enterprise + external HSM, only the auto-unseal and key storage operations are HSM-protected -- the Vault software layer performing encryption/decryption operations is not FIPS-validated.

---

## 2. NIST 800-53 Rev 5 control mapping

### SC-12: Cryptographic Key Establishment and Management

| Control enhancement                  | Vault Enterprise implementation                      | Key Vault implementation                                            |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------- |
| **SC-12(1): Availability**           | Vault cluster HA + Consul backend + DR replication   | Built-in HA, geo-replication (Premium), multi-region Managed HSM    |
| **SC-12(2): Symmetric keys (FIPS)**  | Requires external FIPS-validated HSM for key storage | Managed HSM: FIPS 140-3 Level 3 AES key operations                  |
| **SC-12(3): Asymmetric keys (FIPS)** | Requires external FIPS-validated HSM for key storage | Key Vault Premium/Managed HSM: FIPS 140-3 Level 3 RSA/EC operations |

**Key Vault advantage:** SC-12 is fully satisfied by Key Vault Premium or Managed HSM without external HSM appliances. The control inherits from Azure Government's FedRAMP High authorization package.

### SC-13: Cryptographic Protection

| Requirement                     | Vault Enterprise                                                                  | Key Vault                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **FIPS-validated cryptography** | Vault software uses Go crypto library (not FIPS-validated); requires external HSM | Key Vault Premium: FIPS 140-3 Level 3 cryptographic module; all operations within HSM boundary |
| **Approved algorithms**         | Configurable (AES-256-GCM, RSA-2048+, ECDSA-P256+)                                | Enforced (AES-128/256, RSA-2048/3072/4096, EC-P256/P384/P521)                                  |
| **Key management procedures**   | Organization-defined (Vault policies)                                             | Azure RBAC + PIM + Azure Policy (auditable, enforceable)                                       |

### SC-28: Protection of Information at Rest

| Requirement                    | Vault Enterprise                                        | Key Vault                                                                                                        |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Encryption of data at rest** | Vault encrypts stored data with internal encryption key | Key Vault: all secrets, keys, and certificates encrypted at rest with Microsoft-managed or customer-managed keys |
| **Key storage protection**     | Internal barrier key protected by auto-unseal HSM       | HSM-backed key material never leaves HSM boundary                                                                |

### AC-2: Account Management

| Requirement                      | Vault Enterprise                                       | Key Vault                                                    |
| -------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| **Privileged access management** | Vault tokens, response wrapping                        | Entra PIM: time-limited, approval-based, audited             |
| **Access review**                | Manual review of Vault policies and entity assignments | Entra Access Reviews: automated, periodic, attestation-based |
| **Separation of duties**         | Multiple Vault policies required                       | Distinct RBAC roles (Secrets User vs Officer vs Admin)       |

### AU-2/AU-3: Audit Events and Content

| Requirement                | Vault Enterprise                                         | Key Vault                                                             |
| -------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| **Audit logging**          | Vault audit backend (file/syslog/socket)                 | Azure Monitor diagnostic settings (Log Analytics, Event Hub, Storage) |
| **Audit content**          | Request/response body, client IP, auth method, timestamp | Operation type, object name, caller identity, IP, timestamp, result   |
| **Tamper protection**      | HMAC-signed audit entries                                | Azure Monitor immutable retention policies                            |
| **Centralized collection** | Requires external SIEM integration                       | Native Log Analytics integration; Sentinel for SIEM                   |

---

## 3. DoD Impact Level guidance

### IL4 (Controlled Unclassified Information -- CUI)

**Recommended tier:** Key Vault Premium

IL4 requires:

- FIPS 140-2/3 validated cryptographic modules for key protection
- Azure Government region deployment
- Encryption of CUI at rest and in transit

Key Vault Premium in Azure Government satisfies all IL4 requirements:

```bicep
// IL4 Key Vault deployment
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-il4-${uniqueString(resourceGroup().id)}'
  location: 'usgovvirginia' // Azure Government region
  properties: {
    sku: {
      family: 'A'
      name: 'premium' // HSM-backed for IL4
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}
```

### IL5 (Higher sensitivity CUI, National Security Systems)

**Recommended tier:** Managed HSM

IL5 requires:

- Dedicated, single-tenant infrastructure for cryptographic operations
- FIPS 140-3 Level 3 HSM with customer-controlled security domain
- Azure Government region with IL5 authorization

Managed HSM provides the dedicated HSM infrastructure required for IL5:

```bash
# Create Managed HSM in Azure Government (IL5)
az keyvault create --hsm-name mhsm-il5-prod \
  --resource-group rg-il5-keys \
  --location usgovvirginia \
  --administrators $ADMIN_OID \
  --retention-days 90

# Activate HSM with security domain (customer-controlled keys)
# Download security domain exchange key
az keyvault security-domain download \
  --hsm-name mhsm-il5-prod \
  --security-domain-file security-domain.json \
  --sd-quorum 3 \
  --sd-wrapping-keys key1.pem key2.pem key3.pem
```

**Security domain:** The security domain is the master encryption key that protects all key material in the HSM. With Managed HSM, the customer holds the security domain keys -- Microsoft cannot access key material. This satisfies IL5's requirement for customer-controlled cryptographic infrastructure.

### IL6 (Classified -- SECRET)

IL6 classified workloads require Azure Government Secret regions and are subject to additional controls beyond this guide. Contact Microsoft Federal for IL6 Key Vault availability.

---

## 4. CMMC 2.0 compliance

### CMMC Level 2 (Advanced)

CMMC Level 2 maps to NIST SP 800-171 Rev 2 controls. Key Vault Premium satisfies CMMC cryptographic requirements:

| CMMC practice     | NIST 800-171 control                    | Key Vault implementation                           |
| ----------------- | --------------------------------------- | -------------------------------------------------- |
| **SC.L2-3.13.11** | Employ FIPS-validated cryptography      | Key Vault Premium: FIPS 140-3 Level 3              |
| **SC.L2-3.13.10** | Establish and manage cryptographic keys | Key Vault RBAC + rotation policies + PIM           |
| **SC.L2-3.13.16** | Protect CUI at rest                     | Key Vault secrets encrypted at rest (HSM-backed)   |
| **AC.L2-3.1.1**   | Limit system access                     | Key Vault RBAC + Conditional Access                |
| **AC.L2-3.1.5**   | Employ least privilege                  | Key Vault built-in roles (Secrets User vs Officer) |
| **AU.L2-3.3.1**   | Create and retain audit records         | Key Vault diagnostic logs to Log Analytics         |
| **AU.L2-3.3.2**   | Ensure individual accountability        | Entra ID identity + Key Vault audit logs           |

### CMMC Level 3 (Expert)

CMMC Level 3 adds controls from NIST SP 800-172. Managed HSM is recommended for Level 3:

| Additional requirement                      | Managed HSM implementation                                 |
| ------------------------------------------- | ---------------------------------------------------------- |
| **Single-tenant cryptographic boundary**    | Dedicated HSM hardware, not shared with other tenants      |
| **Customer-controlled key material**        | Security domain held by customer                           |
| **Enhanced key management procedures**      | Dual-control activation, M-of-N recovery                   |
| **Continuous monitoring of key operations** | Real-time diagnostic streaming to Log Analytics + Sentinel |

---

## 5. FedRAMP key management controls

### Preparing ATO documentation

When migrating from Vault to Key Vault, the ATO documentation impact is significant:

**Vault in the authorization boundary:**

- Vault cluster is a **distinct system component** requiring independent security assessment
- Consul backend adds another component to the boundary
- HSM appliances add hardware security assessment requirements
- Vault policies, auth methods, and audit backends all require documentation
- 3rd-party software supply chain risk assessment (HashiCorp/IBM)

**Key Vault in the authorization boundary:**

- Key Vault **inherits Azure Government's FedRAMP High P-ATO**
- No infrastructure components to assess (no VMs, no Consul, no HSM appliances)
- RBAC and Azure Policy configuration documented as customer-responsible controls
- Supply chain risk is Microsoft's responsibility (Azure platform)

### ATO acceleration

| ATO task                             | Vault in boundary                                     | Key Vault in boundary                                   |
| ------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| **System component inventory**       | Vault VMs, Consul VMs, HSM appliances, load balancers | Key Vault resource reference (no infrastructure)        |
| **FIPS validation evidence**         | External HSM certificate + Vault software assessment  | Azure Government inherited FedRAMP package              |
| **Vulnerability scanning**           | Vault VMs, Consul VMs (Nessus/Qualys scans)           | Not applicable (managed service)                        |
| **Penetration testing**              | Vault API, Consul API, auth methods                   | Not applicable (Microsoft performs platform pentesting) |
| **Configuration management**         | Vault config files, Consul config, HSM config         | Bicep IaC for Key Vault + Azure Policy                  |
| **Incident response**                | Vault-specific IR procedures                          | Azure-standard IR procedures                            |
| **Supply chain risk**                | HashiCorp (now IBM) software supply chain assessment  | Microsoft Azure platform (inherited)                    |
| **Estimated ATO timeline reduction** | Baseline                                              | 4-8 weeks faster (fewer components, inherited controls) |

---

## 6. Federal migration considerations

### Network isolation

```bicep
// Federal-grade network isolation for Key Vault
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    // ...
    publicNetworkAccess: 'Disabled' // No public access in federal environments
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      ipRules: [] // No IP exceptions
      virtualNetworkRules: [] // Access only via private endpoint
    }
  }
}

// Private endpoint in hub VNet
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: 'pe-${vaultName}'
  location: location
  properties: {
    subnet: {
      id: hubSubnetId // Hub VNet in hub-spoke topology
    }
    privateLinkServiceConnections: [
      {
        name: 'kv-private'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: ['vault']
        }
      }
    ]
  }
}

// Private DNS zone for name resolution
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.vaultcore.usgovcloudapi.net' // Azure Government DNS
  location: 'global'
}
```

### Continuous monitoring integration

```bicep
// Stream Key Vault events to Microsoft Sentinel for continuous monitoring
resource diagnosticSettings 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'kv-sentinel-diagnostics'
  scope: keyVault
  properties: {
    workspaceId: sentinelWorkspaceId // Sentinel-enabled Log Analytics workspace
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: true
          days: 365 // 1 year online, archive to ADX for 7-year retention
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}
```

### Sentinel analytics rules for Key Vault

```kusto
// Detect unusual Key Vault access patterns
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.KEYVAULT"
| where OperationName == "SecretGet"
| summarize AccessCount = count() by CallerIPAddress, Identity = identity_claim_upn_s, bin(TimeGenerated, 1h)
| where AccessCount > 100
| extend AlertSeverity = "Medium"
| extend AlertDescription = strcat("Unusual Key Vault secret access: ", AccessCount, " operations from ", CallerIPAddress)

// Detect Key Vault access from unexpected locations
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.KEYVAULT"
| where ResultType != "Success"
| summarize FailureCount = count() by CallerIPAddress, OperationName, bin(TimeGenerated, 15m)
| where FailureCount > 10
```

---

## 7. HSM key ceremony procedures

For Managed HSM deployments in federal environments, formal key ceremonies are required:

### Initial HSM activation

```bash
# Key ceremony step 1: Generate wrapping keys (M-of-N, minimum 3 key holders)
# Each key holder generates their RSA key pair independently
openssl req -newkey rsa:2048 -nodes -keyout holder1-private.pem -x509 -days 365 -out holder1.pem
openssl req -newkey rsa:2048 -nodes -keyout holder2-private.pem -x509 -days 365 -out holder2.pem
openssl req -newkey rsa:2048 -nodes -keyout holder3-private.pem -x509 -days 365 -out holder3.pem

# Key ceremony step 2: Download security domain (requires all key holders present)
az keyvault security-domain download \
  --hsm-name mhsm-federal-prod \
  --security-domain-file security-domain.json \
  --sd-quorum 2 \
  --sd-wrapping-keys holder1.pem holder2.pem holder3.pem

# Key ceremony step 3: Store security domain fragments securely
# Each key holder stores their private key + security domain fragment
# in a physically separate secure location (safe, vault, etc.)
```

### Security domain recovery (disaster recovery)

```bash
# Restore from security domain backup (requires M-of-N key holders)
az keyvault security-domain upload \
  --hsm-name mhsm-federal-dr \
  --sd-file security-domain.json \
  --sd-wrapping-keys holder1-private.pem holder2-private.pem \
  --sd-exchange-key exchange-key.pem
```

---

## 8. Federal migration checklist

- [ ] **Pre-migration:**
    - [ ] Vault inventory complete (secrets, keys, certificates, policies, auth methods)
    - [ ] Impact Level determination for all secrets (IL2/IL4/IL5)
    - [ ] Key Vault tier selected (Premium for IL4, Managed HSM for IL5)
    - [ ] ATO documentation impact assessment complete
    - [ ] Network architecture reviewed (private endpoints in hub-spoke)
    - [ ] ISSO/ISSM briefed on migration plan
- [ ] **Deployment:**
    - [ ] Key Vault deployed in Azure Government region
    - [ ] FIPS 140-3 Level 3 confirmed (Premium or Managed HSM)
    - [ ] Private endpoints configured (no public access)
    - [ ] Diagnostic logging to Sentinel workspace
    - [ ] RBAC roles assigned (principle of least privilege)
    - [ ] PIM configured for privileged roles
    - [ ] Azure Policy guardrails deployed
- [ ] **Migration execution:**
    - [ ] Secrets migrated with secure export/import
    - [ ] Managed identity deployed for Azure database access
    - [ ] Encryption keys migrated (or BYOK imported)
    - [ ] PKI certificates migrated
    - [ ] Vault policies mapped to RBAC assignments
- [ ] **Compliance validation:**
    - [ ] FIPS validation evidence documented
    - [ ] SC-12 and SC-13 controls validated
    - [ ] Audit logging verified end-to-end
    - [ ] Continuous monitoring active in Sentinel
    - [ ] ATO package updated with Key Vault controls
    - [ ] POA&M updated (close Vault-related items, open any new Key Vault items)
- [ ] **Post-migration:**
    - [ ] Vault decommission plan approved by ISSO
    - [ ] Vault infrastructure removed from authorization boundary
    - [ ] SSP updated to reflect Key Vault
    - [ ] Continuous monitoring procedures updated

---

## Related resources

- **Migration playbook:** [Vault to Key Vault](../vault-to-key-vault.md)
- **TCO analysis:** [Total Cost of Ownership](tco-analysis.md)
- **Policy migration:** [Policy Migration Guide](policy-migration.md)
- **CSA-in-a-Box compliance:**
    - [NIST 800-53 Rev 5](../../compliance/nist-800-53-rev5.md)
    - [FedRAMP Moderate](../../compliance/fedramp-moderate.md)
    - [CMMC 2.0 Level 2](../../compliance/cmmc-2.0-l2.md)
- **Microsoft Learn:**
    - [Azure Government Key Vault](https://learn.microsoft.com/azure/azure-government/documentation-government-services-keyvault)
    - [Managed HSM security domain](https://learn.microsoft.com/azure/key-vault/managed-hsm/security-domain)
    - [Azure Government compliance](https://learn.microsoft.com/azure/azure-government/compliance/)
    - [FedRAMP High baseline](https://learn.microsoft.com/azure/compliance/offerings/offering-fedramp)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
