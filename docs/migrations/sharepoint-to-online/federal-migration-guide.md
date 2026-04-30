# Federal SharePoint Migration Guide: GCC, GCC-High, and DoD

**Status:** Authored 2026-04-30
**Audience:** Federal IT administrators, compliance officers, and M365 architects managing SharePoint migrations to government cloud environments.
**Scope:** SPO GCC/GCC-High/DoD tenant provisioning, compliance boundaries, data residency, records management, NARA requirements, and sensitivity labels for CUI.

---

## 1. Federal cloud environment overview

Microsoft offers three government cloud environments for SharePoint Online, each with different compliance levels and operational boundaries:

| Environment  | Compliance level           | Data residency                   | Tenant isolation                   | Use case                                          |
| ------------ | -------------------------- | -------------------------------- | ---------------------------------- | ------------------------------------------------- |
| **GCC**      | FedRAMP High               | US data centers                  | Logical separation from commercial | Federal civilian agencies, state/local government |
| **GCC-High** | FedRAMP High + DoD SRG IL4 | US data centers                  | Physically separate infrastructure | DoD, ITAR, CJIS, CUI requirements                 |
| **DoD**      | DoD SRG IL5                | US data centers (DoD-controlled) | DoD-exclusive infrastructure       | DoD organizations requiring IL5                   |

### Feature availability by environment

| Feature                     | Commercial | GCC       | GCC-High            | DoD                 |
| --------------------------- | ---------- | --------- | ------------------- | ------------------- |
| SharePoint Online           | Full       | Full      | Full (minor delays) | Full (minor delays) |
| Modern pages                | Full       | Full      | Full                | Full                |
| Hub sites                   | Full       | Full      | Full                | Full                |
| Power Automate              | Full       | Full      | GCC-High instance   | DoD instance        |
| Power Apps                  | Full       | Full      | GCC-High instance   | DoD instance        |
| Microsoft Teams             | Full       | Full      | Full                | Full                |
| Copilot for M365            | Full       | Available | Roadmap             | Roadmap             |
| SharePoint Framework (SPFx) | Full       | Full      | Full                | Full                |
| SPMT                        | Full       | Full      | Full                | Full                |
| Migration Manager           | Full       | Full      | Full                | Limited             |
| Sensitivity labels          | Full       | Full      | Full                | Full                |
| DLP policies                | Full       | Full      | Full                | Full                |
| Microsoft Purview           | Full       | Full      | Full                | Full                |
| Microsoft Search            | Full       | Full      | Full                | Full                |
| Viva Engage (Yammer)        | Full       | Full      | Not available       | Not available       |
| SharePoint Embedded         | Full       | Roadmap   | Roadmap             | Roadmap             |

!!! warning "GCC-High and DoD feature lag"
GCC-High and DoD environments typically receive new SPO features 2-6 months after commercial availability. Verify feature availability in the [M365 Government service description](https://learn.microsoft.com/office365/servicedescriptions/office-365-platform-service-description/office-365-us-government/office-365-us-government) before planning migrations that depend on specific capabilities.

---

## 2. Tenant provisioning

### GCC tenant

GCC tenants are provisioned through the standard Microsoft government enrollment process:

1. Verify government eligibility through [Microsoft Government validation](https://www.microsoft.com/microsoft-365/government/eligibility-validation)
2. Purchase M365 G3 or G5 licenses through a government-authorized reseller or Microsoft Enterprise Agreement
3. Tenant is provisioned in US data centers with FedRAMP High compliance

### GCC-High tenant

GCC-High requires additional validation and specialized provisioning:

1. Government eligibility validation (federal, ITAR, CJIS, CUI requirements)
2. Tenant provisioned on physically separate GCC-High infrastructure
3. All identities must use GCC-High Entra ID (separate from commercial Entra)
4. DNS domains: `*.onmicrosoft.us` (not `.com`)
5. SharePoint URLs: `https://agency.sharepoint.us`

```powershell
# GCC-High SPO admin center URL
# https://agency-admin.sharepoint.us

# Connect to GCC-High SPO
Connect-SPOService -Url "https://agency-admin.sharepoint.us" -Region ITAR

# Connect PnP to GCC-High
Connect-PnPOnline -Url "https://agency.sharepoint.us/sites/sitename" `
    -AzureEnvironment USGovernmentHigh -Interactive
```

### DoD tenant

DoD tenants are provisioned exclusively for Department of Defense organizations:

1. DoD sponsorship and validation required
2. Provisioned on DoD-exclusive infrastructure
3. DNS domains: `*.onmicrosoft.us` (DoD partition)
4. Strict access controls and CAC/PIV authentication required

```powershell
# DoD SPO connection
Connect-SPOService -Url "https://agency-admin.sharepoint-mil.us" -Region USGovernmentDoD

Connect-PnPOnline -Url "https://agency.sharepoint-mil.us/sites/sitename" `
    -AzureEnvironment USGovernmentDoD -Interactive
```

---

## 3. Compliance boundaries and data residency

### Data residency guarantees

| Environment | Data at rest                     | Data in transit                               | Backup location              |
| ----------- | -------------------------------- | --------------------------------------------- | ---------------------------- |
| GCC         | US data centers                  | Encrypted (TLS 1.2+)                          | US data centers              |
| GCC-High    | US data centers (segregated)     | Encrypted (TLS 1.2+), FIPS 140-2              | US data centers (segregated) |
| DoD         | US data centers (DoD-controlled) | Encrypted (TLS 1.2+), FIPS 140-2, NSA Suite B | US data centers (DoD)        |

### Compliance framework mapping

| Framework          | GCC                       | GCC-High   | DoD        |
| ------------------ | ------------------------- | ---------- | ---------- |
| FedRAMP High       | Authorized                | Authorized | Authorized |
| DoD SRG IL2        | Covered                   | Covered    | Covered    |
| DoD SRG IL4        | Covered                   | Covered    | Covered    |
| DoD SRG IL5        | Covered (select services) | Covered    | Covered    |
| NIST 800-171 (CUI) | Supported                 | Supported  | Supported  |
| NIST 800-53 Rev 5  | Mapped                    | Mapped     | Mapped     |
| CJIS               | Supported                 | Supported  | N/A        |
| ITAR               | Not suitable              | Covered    | Covered    |
| CMMC 2.0 Level 2   | Supported                 | Supported  | Supported  |

---

## 4. Records management for federal content

### NARA requirements

Federal agencies must comply with National Archives and Records Administration (NARA) requirements for records management. SharePoint Online provides M365 Records Management to meet these requirements.

### M365 Records Management configuration

```powershell
Connect-IPPSSession -ConnectionUri "https://ps.compliance.protection.office365.us" `
    -AzureADAuthorizationEndpointUri "https://login.microsoftonline.us/common"

# Create retention labels for federal records schedules
New-RetentionCompliancePolicy -Name "Federal Records Schedule" `
    -SharePointLocation All `
    -OneDriveLocation All

# Create retention label: Temporary Records (7 years)
New-ComplianceRetentionEventType -Name "RecordDisposition"

New-RetentionComplianceRule -Policy "Federal Records Schedule" `
    -Name "Temporary Records - 7 Year" `
    -RetentionDuration 2555 `  # 7 years in days
    -RetentionComplianceAction KeepAndDelete `
    -ExpirationDateOption CreationAgeInDays

# Create retention label: Permanent Records (transfer to NARA)
New-RetentionComplianceRule -Policy "Federal Records Schedule" `
    -Name "Permanent Records" `
    -RetentionDuration Unlimited `
    -RetentionComplianceAction Keep `
    -IsRecordLabel $true

# Create retention label: Vital Records
New-RetentionComplianceRule -Policy "Federal Records Schedule" `
    -Name "Vital Records" `
    -RetentionDuration Unlimited `
    -RetentionComplianceAction Keep `
    -IsRecordLabel $true `
    -IsRegulatoryLabel $true  # Cannot be removed once applied
```

### File plan for federal records

```powershell
# Create file plan descriptors matching NARA GRS
$filePlan = @{
    "GRS 5.1" = @{
        Description = "Common Office Records"
        RetentionPeriod = "6 years"
        DispositionAction = "Destroy"
    }
    "GRS 5.2" = @{
        Description = "Transitory and Intermediary Records"
        RetentionPeriod = "When no longer needed"
        DispositionAction = "Destroy"
    }
    "GRS 6.1" = @{
        Description = "Email Records"
        RetentionPeriod = "7 years"
        DispositionAction = "Destroy"
    }
}
```

### Disposition review workflow

1. Configure disposition review in M365 Compliance Center
2. Assign reviewers (records managers) for each retention label
3. When retention period expires, reviewers receive notification
4. Reviewers approve destruction, extend retention, or transfer to NARA
5. Audit trail maintained for all disposition decisions

---

## 5. Sensitivity labels for CUI

### CUI marking requirements

Controlled Unclassified Information (CUI) requires specific marking per NIST 800-171 and 32 CFR Part 2002. Sensitivity labels in SPO automate CUI marking.

```powershell
Connect-IPPSSession -ConnectionUri "https://ps.compliance.protection.office365.us" `
    -AzureADAuthorizationEndpointUri "https://login.microsoftonline.us/common"

# Create CUI sensitivity labels
New-Label -DisplayName "CUI" `
    -Name "CUI" `
    -Tooltip "Controlled Unclassified Information" `
    -Comment "Content subject to CUI handling requirements per 32 CFR 2002" `
    -ContentType "File, Email" `
    -EncryptionEnabled $true `
    -EncryptionProtectionType Template

# CUI sub-categories
New-Label -DisplayName "CUI//SP-CTI" `
    -Name "CUI-SP-CTI" `
    -ParentId (Get-Label -Identity "CUI").Guid `
    -Tooltip "CUI Specified - Controlled Technical Information" `
    -ContentType "File, Email" `
    -EncryptionEnabled $true

New-Label -DisplayName "CUI//SP-ITAR" `
    -Name "CUI-SP-ITAR" `
    -ParentId (Get-Label -Identity "CUI").Guid `
    -Tooltip "CUI Specified - International Traffic in Arms Regulations" `
    -ContentType "File, Email" `
    -EncryptionEnabled $true

New-Label -DisplayName "CUI//SP-PRVCY" `
    -Name "CUI-SP-PRVCY" `
    -ParentId (Get-Label -Identity "CUI").Guid `
    -Tooltip "CUI Specified - Privacy" `
    -ContentType "File, Email" `
    -EncryptionEnabled $true

# Publish CUI labels
New-LabelPolicy -Name "CUI Label Policy" `
    -Labels "CUI","CUI-SP-CTI","CUI-SP-ITAR","CUI-SP-PRVCY" `
    -ExchangeLocation All `
    -SharePointLocation All `
    -OneDriveLocation All `
    -Settings @{
        "mandatory" = "true"
        "defaultlabel" = "CUI"
    }
```

### Auto-labeling for CUI detection

```powershell
# Auto-detect and label CUI content in migrated SharePoint sites
New-AutoSensitivityLabelPolicy -Name "CUI Auto-Detection" `
    -SharePointLocation All `
    -OneDriveLocation All `
    -ApplySensitivityLabel "CUI" `
    -Mode TestWithNotifications

# CUI keyword detection rule
New-AutoSensitivityLabelRule -Policy "CUI Auto-Detection" `
    -Name "CUI Banner Detection" `
    -ContentContainsSensitiveInformation @{
        Name = "U.S. Social Security Number (SSN)"
        MinCount = 1
    } `
    -HeaderMatchesPatterns @("CUI", "CONTROLLED", "FOUO", "FOR OFFICIAL USE ONLY")
```

---

## 6. Migration tool configuration for government clouds

### SPMT for GCC/GCC-High

```powershell
Import-Module Microsoft.SharePoint.MigrationTool.PowerShell

# GCC connection
Register-SPMTMigration `
    -SPOUrl "https://agency.sharepoint.com" `
    -SPOCredential (Get-Credential) `
    -Environment GCC `
    -Force

# GCC-High connection
Register-SPMTMigration `
    -SPOUrl "https://agency.sharepoint.us" `
    -SPOCredential (Get-Credential) `
    -Environment GCCHigh `
    -Force
```

### Migration Manager for government clouds

1. Access Migration Manager through the government admin center:
    - GCC: `https://admin.microsoft.com` (GCC tenant)
    - GCC-High: `https://admin.microsoft.us`
2. Agent installation is the same process; agents connect to government endpoints
3. All data stays within government cloud boundaries during migration

---

## 7. Identity and access for government tenants

### CAC/PIV authentication

GCC-High and DoD environments typically require CAC (Common Access Card) or PIV (Personal Identity Verification) authentication:

```powershell
# Configure Entra ID (Azure AD) for certificate-based authentication
# This is configured in the GCC-High/DoD Entra portal

# Users authenticate to SPO using their CAC/PIV certificate
# No password-based authentication for privileged access

# PnP PowerShell with certificate authentication (GCC-High)
Connect-PnPOnline -Url "https://agency.sharepoint.us/sites/sitename" `
    -ClientId $clientId `
    -Thumbprint $certThumbprint `
    -Tenant "agency.onmicrosoft.us" `
    -AzureEnvironment USGovernmentHigh
```

### Conditional Access for government

```powershell
# Require compliant device + MFA for SPO access
# Configure in GCC-High Entra ID portal (portal.azure.us)

# Typical federal Conditional Access policies:
# 1. Require MFA for all users accessing SPO
# 2. Require compliant (Intune-managed) device
# 3. Block access from non-US locations
# 4. Require CAC/PIV for privileged roles
# 5. Block legacy authentication protocols
```

---

## 8. CSA-in-a-Box Purview integration for federal SPO

CSA-in-a-Box deploys Microsoft Purview in the government cloud environment to provide unified governance across SPO and the broader data platform:

| Integration                           | Federal value                                             |
| ------------------------------------- | --------------------------------------------------------- |
| **Purview sensitivity labels on SPO** | Automated CUI marking and enforcement                     |
| **Purview DLP on SPO**                | Prevent CUI leakage through external sharing              |
| **Purview records management**        | NARA-compliant retention and disposition                  |
| **Purview audit**                     | Complete audit trail for FISMA/FedRAMP AU controls        |
| **Purview eDiscovery**                | FOIA response and legal hold support                      |
| **Purview data catalog**              | Enterprise data governance across SPO, OneLake, Azure SQL |

---

## 9. Migration checklist for federal organizations

### Pre-migration

- [ ] Validate government cloud eligibility and tenant type (GCC/GCC-High/DoD)
- [ ] Obtain Authority to Operate (ATO) for SPO in government cloud (usually inherited)
- [ ] Configure Entra Connect for government cloud sync
- [ ] Configure CAC/PIV authentication (GCC-High/DoD)
- [ ] Plan CUI marking strategy with sensitivity labels
- [ ] Define records retention schedules per NARA GRS
- [ ] Identify ITAR-controlled content requiring GCC-High
- [ ] Review sharing policies for government compliance
- [ ] Plan conditional access policies

### During migration

- [ ] Use SPMT/Migration Manager with government cloud endpoints
- [ ] Verify data residency during migration (no data outside US boundaries)
- [ ] Apply sensitivity labels to migrated content
- [ ] Validate permissions map correctly to government Entra ID
- [ ] Monitor for CUI content that may need reclassification
- [ ] Test records management policies on migrated content

### Post-migration

- [ ] Deploy Purview DLP policies on all SPO sites
- [ ] Enable auto-labeling for CUI detection
- [ ] Configure records management disposition workflows
- [ ] Run audit reports to verify compliance
- [ ] Validate Conditional Access policies
- [ ] Document ATO evidence for migrated environment
- [ ] Decommission on-premises farm per agency procedures

---

## References

- [M365 Government service description](https://learn.microsoft.com/office365/servicedescriptions/office-365-platform-service-description/office-365-us-government/office-365-us-government)
- [GCC-High and DoD documentation](https://learn.microsoft.com/office365/servicedescriptions/office-365-platform-service-description/office-365-us-government/gcc-high-and-dod)
- [NARA records management](https://www.archives.gov/records-mgmt)
- [CUI Registry](https://www.archives.gov/cui)
- [NIST 800-171 CUI requirements](https://csrc.nist.gov/publications/detail/sp/800-171/rev-2/final)
- [FedRAMP Marketplace](https://marketplace.fedramp.gov/)
- [M365 compliance certifications](https://learn.microsoft.com/compliance/regulatory/offering-home)
- [PnP PowerShell for government clouds](https://pnp.github.io/powershell/articles/connecting.html)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
