# Compliance — CJIS Security Policy

> **Scope:** Criminal Justice Information Services (CJIS) Security Policy compliance for organizations handling Criminal Justice Information (CJI) on the CSA-in-a-Box platform. This document maps platform controls to CJIS policy areas and provides implementation guidance for law enforcement and public safety workloads.

## What is CJIS?

The **CJIS Security Policy** is published by the FBI's Criminal Justice Information Services Division and establishes the minimum security requirements for any organization that accesses, transmits, stores, or processes **Criminal Justice Information (CJI)**. CJI includes data from the National Crime Information Center (NCIC), the Interstate Identification Index (III), fingerprint records, and any data derived from these systems.

Compliance is **mandatory** — not voluntary — for:

- Law enforcement agencies (federal, state, local, tribal)
- Private contractors and vendors providing IT services to law enforcement
- Cloud service providers hosting systems that process CJI
- Any organization with access to FBI CJIS data through a Criminal Justice Agency (CJA)

The current version is **CJIS Security Policy v5.9.x**, updated periodically by the CJIS Advisory Policy Board (APB). Violations can result in termination of access to FBI CJIS systems — a severe operational consequence for any law enforcement agency.

## Policy areas crosswalk

The CJIS Security Policy defines 13 policy areas. The table below maps each to CSA-in-a-Box capabilities and the relevant Azure services.

| #   | CJIS Policy Area                     | CSA-in-a-Box Implementation                                                                                                                   | Azure Service                           |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | Information Exchange Agreements      | Out of scope — your legal/compliance team drafts agreements with CJA and FBI                                                                  | N/A (organizational)                    |
| 2   | Security Awareness Training          | Out of scope — your training program; platform documents security controls for training material                                              | N/A (organizational)                    |
| 3   | Incident Response                    | [Security Incident runbook](../runbooks/security-incident.md); Defender for Cloud alerts; Sentinel detection rules                            | Defender for Cloud, Microsoft Sentinel  |
| 4   | Auditing & Accountability            | Diagnostic Settings → Log Analytics; [LOG_SCHEMA.md](../LOG_SCHEMA.md); 1-year minimum retention configurable; immutable log storage          | Log Analytics, Azure Monitor, Storage   |
| 5   | Access Control                       | Entra ID RBAC + PIM; Conditional Access; [Identity & Secrets Flow](../reference-architecture/identity-secrets-flow.md); least-privilege Bicep | Entra ID, PIM, Conditional Access       |
| 6   | Identification & Authentication      | Entra ID MFA enforced via Conditional Access; RS256 JWT with tenant pinning; no shared accounts; session timeouts                             | Entra ID, Key Vault                     |
| 7   | Configuration Management             | Full Bicep IaC in `deploy/bicep/`; Azure Policy baselines; CI/CD with what-if gates; branch protection                                        | Azure Policy, GitHub Actions            |
| 8   | Media Protection                     | Inherited from Azure datacenter (physical media); encryption at rest on all storage; Purview classification                                   | Azure Storage (encryption), Purview     |
| 9   | Physical Protection                  | Fully inherited from Azure datacenter physical security controls                                                                              | Azure Datacenter                        |
| 10  | System & Comm Protection + Integrity | [Hub-Spoke Topology](../reference-architecture/hub-spoke-topology.md); Private Endpoints; TLS 1.2+; CMK; Azure Firewall Premium IDPS          | Azure Firewall, Private Link, Key Vault |
| 11  | Formal Audits                        | Compliance manifests in `governance/compliance/`; Defender for Cloud regulatory compliance dashboard                                          | Defender for Cloud                      |
| 12  | Personnel Security                   | Out of scope — your HR; background check requirements documented below                                                                        | N/A (organizational)                    |
| 13  | Mobile Devices                       | Conditional Access device compliance policies; Intune MDM integration for managed devices                                                     | Intune, Conditional Access              |

## Azure CJIS compliance

Microsoft Azure maintains a **CJIS Information Agreement** with participating states. This agreement is a contractual commitment between Microsoft and the state's CJIS Systems Agency (CSA) that governs how Azure personnel handle CJI.

| Azure Environment | CJIS Status                                                   | Notes                                         |
| ----------------- | ------------------------------------------------------------- | --------------------------------------------- |
| Azure Government  | CJIS agreement available; screened personnel; US-only support | Recommended for CJI workloads                 |
| Azure Commercial  | CJIS agreement available in most states                       | Verify with your state's CSA before deploying |

!!! danger
Before deploying CJI workloads, you **must** verify that Microsoft has an active CJIS Information Agreement with your state's CJIS Systems Agency. Not all states have completed this agreement. Contact your state CSA or Microsoft's compliance team to confirm.

## Critical requirements

### Encryption — FIPS 140-2 validated

CJIS requires **FIPS 140-2 validated** cryptographic modules for all encryption of CJI at rest and in transit.

```bicep
// Key Vault with FIPS 140-2 Level 2 HSM — deploy/bicep/DMLZ/modules/KeyVault/
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  properties: {
    sku: {
      family: 'A'
      name: 'premium'  // Premium SKU = HSM-backed keys (FIPS 140-2 L2)
    }
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enableRbacAuthorization: true
  }
}
```

- **At rest:** AES-256 with infrastructure double encryption on Storage; CMK via Key Vault HSM. See `deploy/bicep/DMLZ/modules/Storage/`.
- **In transit:** TLS 1.2 minimum enforced by Azure Policy; HTTPS-only on all endpoints.

### Advanced Authentication (MFA)

CJIS requires **Advanced Authentication** (multi-factor) for all access to CJI from any location. This is not optional.

- **Entra ID Conditional Access** policies enforce MFA for all users accessing CJI systems.
- **Phishing-resistant methods** (FIDO2 keys, Windows Hello for Business, certificate-based auth) are recommended over SMS/phone-call MFA.
- **No exceptions** for VPN-connected users, service desk personnel, or "trusted network" locations — CJIS requires MFA regardless of network origin.

### Background checks

All personnel with **unescorted access** to unencrypted CJI must pass a state and national fingerprint-based background check. This applies to:

- Your organization's staff who administer the platform
- Microsoft personnel with potential access (covered under the CJIS Information Agreement)
- Third-party contractors with logical or physical access

!!! danger
Background check requirements apply to **all personnel** — including database administrators, help desk staff, and developers — if they have the ability to access unencrypted CJI. There are no exceptions for "read-only" access.

### Audit logging — minimum 1 year retention

CJIS Policy Area 4 requires that audit logs be retained for a **minimum of one year**. Log entries must capture:

- User ID and terminal/session
- Date and time of access
- Successful and failed access attempts
- Type of event (create, read, update, delete)
- System resources accessed

```bicep
// Log Analytics workspace with 365-day retention
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  properties: {
    retentionInDays: 365  // CJIS minimum 1 year
    features: {
      immediatePurgeDataOn30Days: false
    }
  }
}
```

### Session timeout

CJIS requires that sessions accessing CJI be locked or terminated after a **maximum of 30 minutes** of inactivity. Configure this via:

- Entra ID Conditional Access sign-in frequency policies
- Application-level session timeouts in portal configuration
- Azure Virtual Desktop session limits for desktop-based CJI access

## CSA-in-a-Box CJIS configuration

### Key Vault with FIPS 140-2 Level 2+ HSM

The platform's Key Vault module (`deploy/bicep/DMLZ/modules/KeyVault/`) deploys with Premium SKU by default, providing HSM-backed keys validated to FIPS 140-2 Level 2. Purge protection and 90-day soft delete are enforced, preventing accidental or malicious key destruction.

### Entra ID Conditional Access for advanced authentication

Conditional Access policies should be configured to require MFA for all applications that process CJI. The platform's identity architecture ([Identity & Secrets Flow](../reference-architecture/identity-secrets-flow.md)) supports this through Entra ID integration with no fallback to local authentication.

### Azure Monitor with 1-year log retention

Diagnostic Settings on every deployed resource route logs to a central Log Analytics workspace. Configure the workspace retention to 365 days minimum. For long-term archival beyond the active retention window, configure export rules to immutable blob storage.

### Network isolation with private endpoints

Every data-plane service in the platform deploys with Private Endpoints and `publicNetworkAccess: Disabled`. Combined with the [Hub-Spoke Topology](../reference-architecture/hub-spoke-topology.md) and Azure Firewall, this ensures CJI never traverses the public internet. NSG rules enforce deny-by-default with explicit allow rules for authorized traffic.

## Common CJIS audit findings

Issues frequently identified during CJIS audits and how CSA-in-a-Box addresses them:

| Common Finding                            | CJIS Policy Area | CSA-in-a-Box Mitigation                                                                            |
| ----------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| MFA not enforced for all CJI access paths | PA 6             | Conditional Access requires MFA; no bypass for "trusted networks"                                  |
| Audit logs retained less than 1 year      | PA 4             | Log Analytics configured for 365-day retention; archive to immutable storage                       |
| Encryption not FIPS 140-2 validated       | PA 10            | Key Vault Premium (HSM FIPS 140-2 L2); Azure platform crypto modules are FIPS-validated            |
| Shared service accounts                   | PA 6             | Managed Identity for service-to-service; no shared human accounts; PIM for privileged access       |
| No formal incident response plan          | PA 3             | [Security Incident runbook](../runbooks/security-incident.md) provides template; customize for CJI |
| Unencrypted CJI in transit                | PA 10            | TLS 1.2+ enforced by policy; HTTPS-only; Private Endpoints eliminate public transit                |
| Excessive administrative privileges       | PA 5             | PIM just-in-time activation; least-privilege RBAC roles; no standing admin access                  |
| Missing media sanitization procedures     | PA 8             | Inherited from Azure datacenter; customer must document local media procedures                     |

!!! tip
Request a **CJIS Security Addendum** from Microsoft as part of your Azure contract. This is separate from the state-level CJIS Information Agreement and provides additional contractual protections specific to your deployment.

## Related

- [Compliance — NIST 800-53 Rev 5](nist-800-53-rev5.md) — CJIS controls map to NIST 800-53
- [Compliance — FedRAMP Moderate](fedramp-moderate.md) — overlapping control set for federal systems
- [Compliance — StateRAMP](stateramp.md) — state/local government variant
- [Best Practices — Security & Compliance](../best-practices/security-compliance.md)
- [Government Service Matrix](../GOV_SERVICE_MATRIX.md) — Azure service availability per cloud
- FBI CJIS Security Policy: https://www.fbi.gov/services/cjis/cjis-security-policy-resource-center
- Microsoft CJIS: https://learn.microsoft.com/azure/compliance/offerings/offering-cjis
