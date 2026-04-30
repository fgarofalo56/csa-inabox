# Why Microsoft Entra ID over On-Premises Active Directory

**Executive brief for CIOs, CISOs, and identity architects evaluating the migration from on-premises Active Directory to Microsoft Entra ID.**

---

## Executive summary

Active Directory has been the enterprise identity backbone since Windows 2000. It was designed for a world where users sat behind corporate firewalls, applications ran on domain-joined servers, and network perimeters defined security boundaries. That world no longer exists.

Microsoft Entra ID is the cloud-native identity platform that replaces Active Directory's authentication, authorization, and directory services with a Zero Trust architecture designed for hybrid work, cloud applications, and AI-powered security. This document presents the strategic case for migration --- not as a technology refresh, but as a foundational shift in how identity secures the enterprise.

For CSA-in-a-Box deployments, Entra ID is not optional. Every service in the platform --- Fabric, Databricks, Purview, Azure OpenAI, Power BI, ADLS Gen2 --- authenticates and authorizes through Entra ID. On-premises AD cannot provide the Conditional Access, managed identity, or SCIM provisioning that the platform requires.

---

## 1. The Zero Trust mandate

### The perimeter is gone

Traditional Active Directory security assumes that anything inside the corporate network is trusted. This assumption fails when:

- **Remote workers** authenticate from home networks, coffee shops, and airports
- **Cloud applications** run outside the corporate firewall
- **Contractors and partners** need access without domain-joined devices
- **Mobile devices** cannot join an AD domain
- **Lateral movement** within the network is the primary attack vector for ransomware

### Zero Trust principles in Entra ID

| Zero Trust principle | AD implementation                  | Entra ID implementation                                             |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| Verify explicitly    | Kerberos ticket + network location | Conditional Access evaluates 100+ signals per authentication        |
| Least privilege      | Static AD group membership         | PIM just-in-time elevation with time-bound access                   |
| Assume breach        | Perimeter firewalls                | Identity Protection ML-based risk detection + automatic remediation |

### Conditional Access --- the policy engine

Conditional Access replaces the implicit trust of "you're on the network, so you're trusted" with explicit, signal-based policy evaluation:

```
IF   user is in "Finance Executives" group
AND  device is NOT compliant (Intune)
AND  location is NOT "Corporate Office" named location
AND  sign-in risk is "Medium" or higher
THEN require phishing-resistant MFA + compliant device
     block access to "Financial Data" apps
     log to Azure Monitor for SOC review
```

Every authentication to CSA-in-a-Box services --- Fabric workspaces, Databricks notebooks, Purview catalog, Power BI reports --- passes through this policy engine. On-premises AD has no equivalent.

---

## 2. Passwordless authentication

### The password problem

Passwords are the single largest attack surface in enterprise identity:

- **80% of breaches** involve compromised credentials (Verizon DBIR 2025)
- **Password spray attacks** against AD are trivial with tools like Hydra and CrackMapExec
- **Credential stuffing** exploits password reuse across personal and corporate accounts
- **Help desk cost** for password resets averages $70 per incident (Forrester)

### Entra ID passwordless options

| Method                       | Technology                          | Phishing-resistant             | Federal approved             | User experience            |
| ---------------------------- | ----------------------------------- | ------------------------------ | ---------------------------- | -------------------------- |
| FIDO2 security key           | WebAuthn/CTAP2                      | Yes                            | Yes (NIST SP 800-63B AAL3)   | Tap key + PIN or biometric |
| Windows Hello for Business   | TPM-backed asymmetric key           | Yes                            | Yes (AAL3 with hardware TPM) | Face, fingerprint, or PIN  |
| Microsoft Authenticator      | Push notification + number matching | Partial (with number matching) | Yes (AAL2)                   | Approve on phone           |
| Certificate-based auth (CBA) | X.509 certificates (PIV/CAC)        | Yes                            | Yes (FIPS 201-3)             | Insert smart card          |

### Federal PIV/CAC integration

For federal agencies, Entra ID certificate-based authentication provides native PIV/CAC support:

```powershell
# Configure Entra ID CBA for PIV/CAC
# Step 1: Upload the issuing CA certificate chain
Connect-MgGraph -Scopes "Policy.ReadWrite.AuthenticationMethod"

$caCert = [System.Convert]::ToBase64String(
    (Get-Content -Path ".\DoD-Root-CA-6.cer" -AsByteStream)
)

New-MgOrganizationCertificateBasedAuthConfiguration `
    -OrganizationId $tenantId `
    -CertificateAuthorities @(
        @{
            Certificate            = $caCert
            IsRootAuthority        = $true
            CertificateRevocationListUrl = "http://crl.disa.mil/crl/DODROOTCA6.crl"
        }
    )
```

On-premises AD smart card logon requires AD CS, an enrollment agent, and certificate revocation list (CRL) distribution points --- infrastructure that Entra CBA eliminates entirely.

---

## 3. Cloud-native management --- eliminate infrastructure

### What you decommission

| Infrastructure component            | Purpose in AD               | Replacement in Entra ID           | Annual cost eliminated |
| ----------------------------------- | --------------------------- | --------------------------------- | ---------------------- |
| Domain controllers (2--6+ per site) | Authentication, replication | Entra ID SaaS (no infrastructure) | $75K--$150K per site   |
| AD FS farm (2--4 servers + WAP)     | Federation, SSO             | Entra ID native SSO               | $80K--$120K            |
| AD CS PKI (issuing CA + root CA)    | Certificate services        | Entra CBA + Key Vault managed PKI | $40K--$80K             |
| MFA server (on-prem NPS extension)  | Multi-factor authentication | Entra ID MFA (cloud-native)       | $30K--$60K             |
| RADIUS/NPS servers                  | Network device auth         | Entra Private Access              | $20K--$40K             |
| AD Connect server                   | Directory sync              | Cloud Sync agent (lightweight)    | $10K--$20K             |
| **Total infrastructure**            |                             |                                   | **$255K--$470K**       |

### Operational burden reduction

| Operational task               | AD frequency        | Entra ID approach               | FTE impact       |
| ------------------------------ | ------------------- | ------------------------------- | ---------------- |
| Domain controller patching     | Monthly + emergency | Microsoft-managed               | -0.5 FTE         |
| AD FS certificate renewal      | Annual (complex)    | Automatic                       | -0.2 FTE         |
| AD replication troubleshooting | Ongoing             | Eliminated                      | -0.3 FTE         |
| Group Policy management        | Ongoing             | Intune (modern tooling)         | -0.3 FTE         |
| AD schema extensions           | Per-application     | Graph API extensions            | -0.1 FTE         |
| Backup/DR for DCs              | Daily/weekly        | Microsoft-managed               | -0.3 FTE         |
| Security monitoring (AD)       | Continuous          | Identity Protection (automated) | -0.3 FTE         |
| **Total FTE reduction**        |                     |                                 | **1.5--2.0 FTE** |

---

## 4. Executive Order 14028 and federal compliance

### EO 14028 requirements

Executive Order 14028 (_Improving the Nation's Cybersecurity_, May 2021) mandates federal agencies to:

1. **Adopt Zero Trust architecture** --- Entra ID is the Microsoft implementation of the identity pillar
2. **Implement multi-factor authentication** --- Entra ID MFA with phishing-resistant methods (FIDO2, CBA)
3. **Deploy endpoint detection and response** --- Entra ID Identity Protection + Defender for Identity
4. **Encrypt data in transit and at rest** --- Entra ID enforces TLS 1.2+ for all authentication
5. **Improve supply chain security** --- Entra Workload Identities replace service account passwords

### CISA Zero Trust Maturity Model alignment

| ZTMM pillar  | Traditional level (AD)    | Optimal level (Entra ID)                                      |
| ------------ | ------------------------- | ------------------------------------------------------------- |
| Identity     | Passwords + optional MFA  | Passwordless + phishing-resistant MFA + continuous validation |
| Devices      | Domain join = trusted     | Device compliance + health attestation via Conditional Access |
| Networks     | Perimeter-based trust     | Identity-based access regardless of network                   |
| Applications | Kerberos/NTLM SSO         | OAuth/OIDC SSO + Conditional Access per-app                   |
| Data         | ACL-based on file servers | Purview sensitivity labels + DLP + Entra-governed access      |

### Hard-match hardening --- June/July 2026

Microsoft is enforcing hard-match hardening for Entra Connect and Cloud Sync synchronization. This enforcement:

- **Prevents** soft-matching of on-premises objects to existing cloud objects
- **Requires** organizations to use explicit hard-match (ImmutableId/SourceAnchor) for all synchronized objects
- **Breaks** legacy configurations that relied on SMTP proxy address or UPN matching

!!! warning "Action required before June 2026"
Organizations still using soft-match synchronization must remediate before the enforcement date. See [Hybrid Identity Migration](hybrid-identity-migration.md) for remediation steps. Failure to remediate will result in duplicate objects and authentication failures.

---

## 5. AI and Copilot integration

### Microsoft Copilot ecosystem

Entra ID is the identity layer for the entire Microsoft Copilot ecosystem:

| Copilot surface           | Entra ID dependency               | Value                                               |
| ------------------------- | --------------------------------- | --------------------------------------------------- |
| Microsoft 365 Copilot     | Entra ID SSO + Conditional Access | AI assistance across Word, Excel, PowerPoint, Teams |
| GitHub Copilot Enterprise | Entra ID SSO                      | Code generation with enterprise context             |
| Copilot for Security      | Entra ID + Defender integration   | AI-powered security investigation                   |
| Copilot in Fabric         | Entra ID workspace RBAC           | Natural language data analysis                      |
| Copilot in Power BI       | Entra ID RLS inheritance          | AI-generated reports respecting row-level security  |
| Copilot Studio            | Entra ID authentication           | Custom AI agents with enterprise identity           |

On-premises AD cannot authenticate to any Copilot surface. Migration to Entra ID is a prerequisite for AI adoption.

### Security Copilot and identity

Microsoft Copilot for Security integrates directly with Entra ID to:

- Investigate risky sign-ins using natural language
- Generate Conditional Access policy recommendations
- Analyze Identity Protection alerts
- Audit PIM role activations
- Query Graph API for identity data

---

## 6. Security posture improvement

### Identity Protection --- ML-powered threat detection

Entra ID Identity Protection uses machine learning models trained on 65 trillion daily signals to detect:

| Detection                     | Description                                         | AD equivalent               |
| ----------------------------- | --------------------------------------------------- | --------------------------- |
| Leaked credentials            | Monitors dark web for compromised credentials       | None (requires third-party) |
| Anonymous IP usage            | Flags authentication from TOR/VPN anonymizers       | None                        |
| Atypical travel               | Detects impossible travel between sign-in locations | None                        |
| Password spray                | Identifies distributed password spray attacks       | Event log analysis (manual) |
| Unfamiliar sign-in properties | ML baseline deviation detection                     | None                        |
| Token anomaly                 | Detects token theft and replay attacks              | None                        |

### Privileged Identity Management (PIM)

PIM replaces standing AD admin group membership with just-in-time, time-bound, approval-gated access:

```
AD model:           User → "Domain Admins" group → permanent 24/7 admin access
Entra PIM model:    User → requests "Global Admin" role → manager approves →
                    access granted for 4 hours → automatic deactivation →
                    full audit trail in Entra audit logs
```

### Attack surface comparison

| Attack vector           | On-premises AD exposure             | Entra ID exposure                               |
| ----------------------- | ----------------------------------- | ----------------------------------------------- |
| Kerberoasting           | High (service account SPNs)         | Eliminated (no Kerberos for cloud services)     |
| Golden ticket           | Critical (KRBTGT hash compromise)   | Eliminated (no on-prem KDC)                     |
| DCSync                  | Critical (replication rights abuse) | Eliminated (no replication protocol)            |
| Pass-the-hash           | High (NTLM hash reuse)              | Eliminated (no NTLM)                            |
| AD CS abuse (ESC1-ESC8) | High (misconfigured templates)      | Eliminated (no AD CS)                           |
| LDAP relay              | Medium (LDAP signing not enforced)  | Eliminated (no LDAP)                            |
| Password spray          | High (no smart lockout by default)  | Low (Entra smart lockout + Identity Protection) |

---

## 7. Ecosystem and integration advantages

### Microsoft 365 integration

Entra ID is the native identity provider for Microsoft 365. On-premises AD requires AD FS or Entra Connect to bridge this gap. With Entra ID as primary:

- **Seamless SSO** across all M365 services without federation infrastructure
- **Conditional Access** applied uniformly to Exchange Online, SharePoint, Teams, and OneDrive
- **Sensitivity labels** from Microsoft Purview Information Protection bound to Entra identities
- **Data Loss Prevention** policies enforced based on Entra group membership

### Third-party SaaS integration

Entra ID has a gallery of 10,000+ pre-integrated SaaS applications with:

- One-click SSO configuration (SAML/OIDC)
- Automatic user provisioning via SCIM
- Conditional Access enforcement
- Application usage analytics

On-premises AD FS requires manual configuration for each application and provides no provisioning or analytics.

### Developer platform

| Capability             | AD/AD FS                      | Entra ID                                  |
| ---------------------- | ----------------------------- | ----------------------------------------- |
| Authentication library | ADAL (deprecated)             | MSAL (active development)                 |
| API framework          | LDAP, WCF, WS-Trust           | Microsoft Graph REST API                  |
| Token format           | Kerberos tickets, SAML tokens | OAuth 2.0 access tokens, OIDC ID tokens   |
| Authorization model    | AD groups + ACLs              | App roles + scopes + Conditional Access   |
| CI/CD identity         | Service accounts (passwords)  | Workload identity federation (no secrets) |

---

## 8. Where on-premises AD still has advantages

This assessment is honest. There are scenarios where on-premises AD retains advantages:

| Scenario                           | AD advantage                                 | Entra ID mitigation                                            |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| **Air-gapped networks**            | AD works offline; Entra ID requires internet | Entra Domain Services for isolated environments                |
| **Legacy Kerberos apps**           | Native Kerberos without configuration        | Kerberos cloud trust + App Proxy KCD                           |
| **Complex GPO estates**            | Full GPO feature set (3,000+ settings)       | Intune covers ~80%; Settings Catalog growing                   |
| **Linux domain join**              | SSSD + Winbind + Samba mature                | Entra ID + SSSD improving but less mature                      |
| **Fine-grained password policies** | Per-OU/per-group policies                    | Entra ID: per-tenant (custom banned passwords add flexibility) |
| **Schema extensions**              | Direct schema modification                   | Directory extensions via Graph API                             |

These gaps are narrowing with each Entra ID release. For most enterprises, the security and operational benefits of Entra ID outweigh these edge cases.

---

## 9. Decision framework

### Migrate to Entra ID when

- Federal Zero Trust mandate (EO 14028) applies to your organization
- You are deploying CSA-in-a-Box or any Azure-native data platform
- Remote/hybrid workforce exceeds 30% of users
- SaaS application portfolio exceeds 20 applications
- Domain controller infrastructure is aging (hardware refresh due)
- AD FS farm requires significant investment to maintain
- Passwordless authentication is a strategic priority
- AI/Copilot adoption is planned

### Maintain AD (with hybrid identity) when

- Air-gapped or disconnected network segments require local authentication
- Legacy Kerberos applications cannot be remediated within 18 months
- Complex Group Policy estate with 500+ GPOs requires extended migration timeline
- Regulatory requirement for on-premises identity data residency (rare)

### The pragmatic path

Most organizations do not face a binary choice. The recommended approach is:

1. **Deploy hybrid identity immediately** (Entra Cloud Sync + PHS)
2. **Migrate applications progressively** (AD FS relying parties first)
3. **Migrate devices progressively** (new devices Entra Join, existing via Hybrid Join)
4. **Decommission AD infrastructure** as dependencies are eliminated
5. **Target cloud-only identity** as the 18--24 month goal

---

## 10. CSA-in-a-Box identity dependency

Every CSA-in-a-Box Bicep deployment assumes Entra ID as the identity provider:

```bicep
// Example: Fabric workspace RBAC bound to Entra group
resource fabricWorkspace 'Microsoft.Fabric/capacities@2023-11-01' = {
  name: workspaceName
  properties: {
    administration: {
      members: [
        entraGroupObjectId  // Entra ID security group
      ]
    }
  }
}

// Example: Databricks SCIM provisioning from Entra ID
resource databricksWorkspace 'Microsoft.Databricks/workspaces@2024-05-01' = {
  name: databricksName
  properties: {
    parameters: {
      enableNoPublicIp: { value: true }
      // SCIM connector syncs Entra users/groups automatically
    }
  }
}

// Example: Key Vault access via Entra RBAC
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  properties: {
    enableRbacAuthorization: true  // Entra RBAC, not access policies
    tenantId: subscription().tenantId
  }
}
```

Without Entra ID, none of these integrations function. The identity migration is not a nice-to-have --- it is the prerequisite for platform deployment.

---

## Summary

| Dimension                     | On-premises AD      | Microsoft Entra ID   | Winner         |
| ----------------------------- | ------------------- | -------------------- | -------------- |
| Zero Trust architecture       | Bolt-on             | Native               | Entra ID       |
| Passwordless authentication   | Limited             | Comprehensive        | Entra ID       |
| Infrastructure cost           | $255K--$470K/year   | $0 (SaaS)            | Entra ID       |
| Federal compliance (EO 14028) | Non-compliant       | Compliant            | Entra ID       |
| AI/Copilot readiness          | Not supported       | Native integration   | Entra ID       |
| Attack surface                | 7+ critical vectors | Most eliminated      | Entra ID       |
| SaaS integration              | Manual per-app      | 10,000+ gallery apps | Entra ID       |
| Operational FTE               | 2--3 FTE            | 0.5--1 FTE           | Entra ID       |
| Air-gapped networks           | Supported           | Not supported        | AD             |
| Legacy Kerberos apps          | Native              | Requires bridging    | AD             |
| GPO feature completeness      | 3,000+ settings     | ~80% coverage        | AD (narrowing) |

**The strategic direction is clear.** Entra ID is the identity control plane for the modern enterprise. The question is not whether to migrate, but how fast.

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
