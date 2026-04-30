# Complete Feature Mapping: Active Directory to Microsoft Entra ID

**50+ Active Directory features mapped to their Microsoft Entra ID equivalents with migration complexity ratings, gap analysis, and CSA-in-a-Box integration points.**

---

## How to read this mapping

Each feature is rated by migration complexity:

| Rating | Meaning                                                     | Typical effort |
| ------ | ----------------------------------------------------------- | -------------- |
| **XS** | Direct 1:1 mapping, minimal configuration                   | Hours          |
| **S**  | Straightforward mapping with minor configuration changes    | Days           |
| **M**  | Moderate effort, architectural differences require planning | 1--2 weeks     |
| **L**  | Significant effort, application or process changes required | 2--6 weeks     |
| **XL** | Major effort, possible redesign required                    | 6+ weeks       |

---

## 1. Authentication

| #   | AD feature                        | Entra ID equivalent                             | Complexity | Gap                      | Notes                                                                                            |
| --- | --------------------------------- | ----------------------------------------------- | ---------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | **Kerberos authentication**       | OAuth 2.0 / OIDC + Kerberos cloud trust         | M          | None                     | Cloud trust enables Kerberos SSO for Entra-joined devices to on-prem resources during transition |
| 2   | **NTLM authentication**           | **Eliminated** --- modern auth only             | L          | App remediation required | NTLM apps must be migrated to modern auth or placed behind App Proxy                             |
| 3   | **LDAP simple bind**              | Microsoft Graph API                             | M          | Protocol change          | All directory queries migrate from LDAP (port 389/636) to Graph REST API                         |
| 4   | **LDAP secure bind (LDAPS)**      | Graph API over HTTPS                            | M          | Protocol change          | TLS 1.2+ enforced by default                                                                     |
| 5   | **AD FS (SAML 2.0)**              | Entra ID SSO (native SAML)                      | M          | None                     | Direct migration; Entra ID supports SAML 2.0 natively                                            |
| 6   | **AD FS (WS-Federation)**         | Entra ID SSO (WS-Fed)                           | M          | None                     | WS-Fed supported for legacy apps; OIDC preferred for new                                         |
| 7   | **AD FS (OAuth/OIDC)**            | Entra ID SSO (native OIDC)                      | S          | None                     | Direct migration; better token handling in Entra                                                 |
| 8   | **Smart card logon (PIV/CAC)**    | Entra ID certificate-based authentication (CBA) | M          | None                     | Native PIV/CAC support; eliminates AD CS dependency                                              |
| 9   | **Windows integrated auth (WIA)** | Seamless SSO / Primary Refresh Token (PRT)      | S          | None                     | PRT provides SSO for Entra-joined devices                                                        |
| 10  | **Password authentication**       | Password hash sync + Entra password protection  | XS         | None                     | Banned password list adds protection                                                             |
| 11  | **Multi-factor authentication**   | Entra ID MFA (built-in)                         | S          | None                     | Number matching, push, FIDO2, CBA                                                                |
| 12  | **Passwordless (WHfB on-prem)**   | Windows Hello for Business (cloud)              | S          | None                     | Simpler deployment without on-prem key trust                                                     |

### Authentication --- CSA-in-a-Box integration

All CSA-in-a-Box services authenticate through Entra ID:

```powershell
# Verify SSO works for CSA-in-a-Box services
$token = Get-AzAccessToken -ResourceUrl "https://analysis.windows.net/powerbi/api"
# Token contains Entra ID claims used for:
# - Fabric workspace RBAC
# - Power BI row-level security
# - Databricks API access
# - Purview catalog access
```

---

## 2. Directory services

| #   | AD feature                                | Entra ID equivalent                                | Complexity | Gap                  | Notes                                                                   |
| --- | ----------------------------------------- | -------------------------------------------------- | ---------- | -------------------- | ----------------------------------------------------------------------- |
| 13  | **Organizational Units (OUs)**            | Administrative Units                               | S          | Partial              | Administrative Units scope admin delegation; not used for GPO targeting |
| 14  | **Security groups**                       | Entra ID security groups                           | XS         | None                 | Direct 1:1 mapping; synced via Cloud Sync                               |
| 15  | **Distribution groups**                   | Microsoft 365 groups / Exchange distribution lists | XS         | None                 | M365 groups preferred for new creation                                  |
| 16  | **Dynamic distribution groups**           | Dynamic security groups / dynamic M365 groups      | S          | None                 | Rules based on user attributes                                          |
| 17  | **Nested groups**                         | Nested Entra ID groups                             | XS         | Partial              | Supported but not recommended for Conditional Access                    |
| 18  | **Group-managed service accounts (gMSA)** | Entra Workload Identities                          | M          | Architectural change | Managed identity or workload identity federation                        |
| 19  | **Managed service accounts (MSA)**        | Entra Workload Identities                          | M          | Architectural change | Same as gMSA migration                                                  |
| 20  | **Service accounts (user-based)**         | Managed identities (system/user-assigned)          | M          | Architectural change | No passwords; credential-free authentication                            |
| 21  | **Computer objects**                      | Entra ID device objects                            | S          | None                 | Registered, joined, or hybrid joined                                    |
| 22  | **User objects**                          | Entra ID user objects                              | XS         | None                 | Synced or cloud-only                                                    |
| 23  | **Contact objects**                       | Entra ID contacts (mail contacts)                  | XS         | None                 | External contact representation                                         |
| 24  | **Schema extensions**                     | Directory extensions (Graph API)                   | M          | Different model      | Attribute extensions via application registration                       |

### Directory services --- CSA-in-a-Box integration

```powershell
# Dynamic group for Fabric workspace access
# All users in the "Data Engineering" department automatically get access
New-MgGroup -DisplayName "CSA-Fabric-DataEngineers" `
    -GroupTypes "DynamicMembership" `
    -MembershipRule '(user.department -eq "Data Engineering")' `
    -MembershipRuleProcessingState "On" `
    -SecurityEnabled $true `
    -MailEnabled $false `
    -MailNickname "csa-fabric-dataeng"
```

---

## 3. Group Policy and device management

| #   | AD feature                         | Entra ID equivalent                              | Complexity | Gap           | Notes                                                                          |
| --- | ---------------------------------- | ------------------------------------------------ | ---------- | ------------- | ------------------------------------------------------------------------------ |
| 25  | **Group Policy Objects (GPOs)**    | Intune configuration profiles + Settings Catalog | L          | ~80% coverage | Settings Catalog grows monthly; see [GPO Migration](group-policy-migration.md) |
| 26  | **GPO --- Security Settings**      | Intune compliance + security baselines           | M          | None          | Endpoint security baselines cover most settings                                |
| 27  | **GPO --- Software Installation**  | Intune Win32 app deployment + Microsoft Store    | M          | None          | Win32 app packaging via IntuneWin utility                                      |
| 28  | **GPO --- Scripts (logon/logoff)** | Intune PowerShell scripts + remediation scripts  | M          | Partial       | Proactive remediation scripts for monitoring                                   |
| 29  | **GPO --- Folder Redirection**     | OneDrive Known Folder Move                       | S          | None          | Better solution; automatic backup and sync                                     |
| 30  | **GPO --- Drive Mapping**          | Intune PowerShell scripts + SharePoint shortcuts | M          | Partial       | SharePoint drive mapping via Group Policy Preferences replacement              |
| 31  | **GPO --- Printer Deployment**     | Universal Print + Intune                         | M          | Partial       | Universal Print covers most scenarios; legacy printers need workaround         |
| 32  | **GPO --- ADMX-backed policies**   | Intune ADMX-backed policies (Settings Catalog)   | M          | ~90% coverage | Import custom ADMX templates                                                   |
| 33  | **GPO --- IE settings**            | Edge management via Intune                       | S          | None          | Edge policy maps cleanly                                                       |
| 34  | **WSUS**                           | Windows Update for Business + Intune             | S          | None          | Cloud-managed; better ring-based deployment                                    |
| 35  | **BitLocker (AD-backed recovery)** | BitLocker with Entra ID key escrow               | S          | None          | Automatic key rotation and escrow                                              |
| 36  | **LAPS (legacy)**                  | Windows LAPS with Entra ID backup                | S          | None          | Cloud-native local admin password management                                   |

### GPO migration --- Group Policy Analytics

```powershell
# Export GPO for Intune Group Policy Analytics
# Run on a domain controller or RSAT-equipped machine
Get-GPO -All | ForEach-Object {
    $gpoName = $_.DisplayName -replace '[\\/:*?"<>|]', '_'
    Get-GPOReport -Guid $_.Id -ReportType Xml -Path ".\GPO_Export\$gpoName.xml"
}
# Upload XML files to Intune > Devices > Group Policy Analytics
```

---

## 4. Authorization and access control

| #   | AD feature                                | Entra ID equivalent                          | Complexity | Gap                  | Notes                                                       |
| --- | ----------------------------------------- | -------------------------------------------- | ---------- | -------------------- | ----------------------------------------------------------- |
| 37  | **NTFS ACLs (file server)**               | ADLS Gen2 ACLs + Azure RBAC                  | M          | Different model      | POSIX-style ACLs on ADLS; see CSA-in-a-Box storage patterns |
| 38  | **Share permissions**                     | SharePoint/OneDrive permissions              | S          | None                 | Modern sharing replaces file share permissions              |
| 39  | **AD delegation (OU-level)**              | Entra ID Administrative Units + custom roles | M          | Partial              | Custom roles provide fine-grained delegation                |
| 40  | **Domain Admins / Enterprise Admins**     | Entra ID PIM (Global Admin, etc.)            | M          | None                 | Just-in-time replaces standing access                       |
| 41  | **AD RBAC (dsHeuristics)**                | Entra ID built-in + custom roles             | S          | None                 | 80+ built-in roles; custom roles for specific needs         |
| 42  | **Token-groups claim**                    | Group claims in tokens / app roles           | S          | 200 group limit      | Use app roles or group filtering for apps with many groups  |
| 43  | **SID-based authorization**               | Object ID (GUID) based authorization         | M          | Different identifier | Applications referencing SIDs must be updated to use OIDs   |
| 44  | **Kerberos constrained delegation (KCD)** | App Proxy with KCD or Entra private access   | L          | Complex migration    | See [Application Migration](application-migration.md)       |

### Authorization --- CSA-in-a-Box integration

| CSA-in-a-Box resource | AD authorization model      | Entra ID authorization model                                    |
| --------------------- | --------------------------- | --------------------------------------------------------------- |
| Fabric workspace      | N/A (not supported)         | Entra security group → Fabric workspace role                    |
| Databricks workspace  | N/A (SCIM only)             | Entra group → Databricks group → Unity Catalog grants           |
| Purview collection    | N/A (Entra only)            | Entra security group → Purview role (Data Reader, Data Curator) |
| ADLS Gen2 container   | AD security group (via ACL) | Entra security group → RBAC role + POSIX ACL                    |
| Key Vault             | N/A (Entra only)            | Entra identity → Key Vault RBAC role                            |
| Power BI dataset      | N/A (Entra only)            | Entra group → RLS role                                          |

---

## 5. PKI and certificate services

| #   | AD feature                          | Entra ID equivalent                         | Complexity | Gap             | Notes                                           |
| --- | ----------------------------------- | ------------------------------------------- | ---------- | --------------- | ----------------------------------------------- |
| 45  | **AD CS --- certificate templates** | Entra ID CBA + Key Vault / Intune SCEP/PKCS | M          | Different model | SCEP profiles in Intune for device certificates |
| 46  | **AD CS --- auto-enrollment**       | Intune certificate profiles (SCEP/PKCS)     | M          | None            | Policy-driven enrollment through Intune         |
| 47  | **AD CS --- CRL distribution**      | OCSP via Entra CBA / Key Vault              | S          | None            | Cloud-native revocation checking                |
| 48  | **AD CS --- key archival**          | Key Vault key management                    | M          | None            | HSM-backed key storage                          |
| 49  | **AD CS --- enrollment agent**      | Intune NDES connector                       | M          | None            | SCEP enrollment via Intune connector            |

---

## 6. Network and infrastructure services

| #   | AD feature                | Entra ID equivalent                           | Complexity | Gap                  | Notes                                              |
| --- | ------------------------- | --------------------------------------------- | ---------- | -------------------- | -------------------------------------------------- |
| 50  | **AD-integrated DNS**     | Azure DNS / Azure Private DNS Zones           | M          | Separate migration   | DNS zones must be migrated independently           |
| 51  | **AD Sites and Services** | Named Locations + Conditional Access          | S          | Different model      | Named locations define network trust boundaries    |
| 52  | **DFS Namespaces**        | SharePoint/OneDrive + Azure Files             | L          | Architectural change | File server migration is a separate project        |
| 53  | **DFS Replication**       | OneDrive sync + SharePoint document libraries | L          | Architectural change | Multi-site file replication replaced by cloud sync |
| 54  | **RADIUS / NPS**          | Entra Private Access + third-party NAC        | L          | Partial              | 802.1x scenarios require planning                  |
| 55  | **VPN (RRAS)**            | Entra Private Access / Azure VPN Gateway      | M          | None                 | Identity-based network access                      |
| 56  | **DHCP (AD-authorized)**  | Standalone DHCP / Azure DHCP                  | XS         | None                 | DHCP authorization in AD is trivial to remove      |

---

## 7. Federation and trust

| #   | AD feature                   | Entra ID equivalent                              | Complexity | Gap             | Notes                                               |
| --- | ---------------------------- | ------------------------------------------------ | ---------- | --------------- | --------------------------------------------------- |
| 57  | **AD forest trusts**         | Entra ID B2B collaboration + cross-tenant access | M          | Different model | B2B replaces trust relationships for partner access |
| 58  | **AD domain trusts**         | Multi-tenant organization (MTO)                  | M          | None            | Cross-tenant sync for multi-tenant enterprises      |
| 59  | **Selective authentication** | Cross-tenant access settings                     | S          | None            | Granular control over B2B access                    |
| 60  | **SID filtering**            | Tenant isolation (inherent)                      | XS         | None            | Cloud tenants are inherently isolated               |

---

## 8. Monitoring and auditing

| #   | AD feature                                | Entra ID equivalent                   | Complexity | Gap  | Notes                                      |
| --- | ----------------------------------------- | ------------------------------------- | ---------- | ---- | ------------------------------------------ |
| 61  | **Security event log (4624, 4625, etc.)** | Entra ID sign-in logs + audit logs    | S          | None | Richer data; integrates with Azure Monitor |
| 62  | **AD replication monitoring**             | Eliminated                            | XS         | None | No replication to monitor                  |
| 63  | **ADSI Edit**                             | Graph Explorer / Microsoft Graph API  | S          | None | Web-based and scriptable                   |
| 64  | **AD administrative center**              | Entra admin center (portal.azure.com) | XS         | None | Unified portal for all identity management |

### Monitoring --- CSA-in-a-Box integration

```kusto
// KQL query in Azure Monitor / Log Analytics
// Monitor sign-in failures to CSA-in-a-Box resources
SigninLogs
| where TimeGenerated > ago(24h)
| where ResourceDisplayName in (
    "Microsoft Fabric",
    "Azure Databricks",
    "Microsoft Purview",
    "Azure OpenAI Service",
    "Power BI Service"
)
| where ResultType != "0"  // Non-success
| summarize FailureCount = count() by
    UserPrincipalName,
    ResourceDisplayName,
    ResultDescription,
    ConditionalAccessStatus
| order by FailureCount desc
```

---

## 9. Identity lifecycle

| #   | AD feature                         | Entra ID equivalent                              | Complexity | Gap     | Notes                                                       |
| --- | ---------------------------------- | ------------------------------------------------ | ---------- | ------- | ----------------------------------------------------------- |
| 65  | **User provisioning (manual)**     | Entra ID Lifecycle Workflows                     | S          | None    | Automated joiner/mover/leaver workflows                     |
| 66  | **User deprovisioning (manual)**   | Entra ID Lifecycle Workflows + access reviews    | S          | None    | Automatic disable/delete on termination                     |
| 67  | **Password expiration policies**   | Entra ID password policies + passwordless        | XS         | None    | NIST 800-63B recommends against forced rotation             |
| 68  | **Fine-grained password policies** | Entra ID: tenant-level + custom banned passwords | S          | Partial | No per-OU policies; custom banned password list compensates |
| 69  | **Account lockout policies**       | Entra ID smart lockout                           | XS         | None    | ML-based lockout; customizable thresholds                   |
| 70  | **Self-service password reset**    | Entra SSPR (built-in)                            | XS         | None    | Reduces help desk volume 70%+                               |

---

## 10. Application integration

| #   | AD feature                        | Entra ID equivalent                        | Complexity | Gap                  | Notes                                                 |
| --- | --------------------------------- | ------------------------------------------ | ---------- | -------------------- | ----------------------------------------------------- |
| 71  | **LDAP application binding**      | Graph API + Entra Domain Services (legacy) | L          | Protocol change      | See [Application Migration](application-migration.md) |
| 72  | **Kerberos SSO (web apps)**       | Entra Application Proxy with KCD           | M          | Bridging required    | App Proxy provides reverse proxy with SSO             |
| 73  | **Windows integrated auth (IIS)** | Entra Application Proxy                    | M          | None                 | Seamless for IIS apps                                 |
| 74  | **ADAL-based apps**               | MSAL migration                             | M          | ADAL deprecated      | ADAL end-of-support; migrate to MSAL                  |
| 75  | **WCF services**                  | Modern REST + MSAL                         | L          | Architectural change | WCF services should migrate to REST APIs              |

---

## 11. Compliance and governance

| #   | AD feature                       | Entra ID equivalent                  | Complexity | Gap  | Notes                                                |
| --- | -------------------------------- | ------------------------------------ | ---------- | ---- | ---------------------------------------------------- |
| 76  | **AD Recycle Bin**               | Entra ID soft delete (30 days)       | XS         | None | Automatic; no forest-level feature enablement needed |
| 77  | **AD Administrative Audit**      | Entra audit logs + Azure Monitor     | S          | None | Richer; Log Analytics integration                    |
| 78  | **Object-level auditing (SACL)** | Entra audit logs (automatic)         | XS         | None | All changes logged by default                        |
| 79  | **Tombstone lifetime**           | Soft delete retention (30 days)      | XS         | None | Configurable retention                               |
| 80  | **Group Policy audit**           | Intune configuration change tracking | S          | None | Tracked in Intune audit logs                         |

---

## Migration complexity summary

| Complexity     | Count | Percentage | Action                                 |
| -------------- | ----- | ---------- | -------------------------------------- |
| XS (hours)     | 18    | 22%        | Migrate immediately                    |
| S (days)       | 22    | 28%        | Migrate in first wave                  |
| M (1--2 weeks) | 28    | 35%        | Plan and migrate in second wave        |
| L (2--6 weeks) | 10    | 13%        | Remediate then migrate in third wave   |
| XL (6+ weeks)  | 2     | 2%         | Long-term migration or maintain bridge |

### Key findings

1. **50% of features** migrate with XS or S effort --- these can be addressed in the first 4--6 weeks
2. **35% require moderate effort** (M) --- these are the planning-intensive items that need application inventory and testing
3. **15% require significant effort** (L/XL) --- primarily LDAP-dependent applications, complex GPO estates, and DFS infrastructure
4. **No blocking gaps** exist --- every AD feature has a functional Entra ID equivalent, though some require architectural adaptation

---

## 12. Migration priority matrix

### Priority 1: Quick wins (XS/S complexity --- Week 1--4)

These features have direct 1:1 mappings and can be migrated with minimal planning:

| #   | Feature                     | AD → Entra ID                        | Action                              |
| --- | --------------------------- | ------------------------------------ | ----------------------------------- |
| 10  | Password authentication     | AD password → PHS                    | Enable in Cloud Sync config         |
| 14  | Security groups             | AD groups → Entra groups             | Automatic via Cloud Sync            |
| 15  | Distribution groups         | AD DL → M365 groups                  | Automatic via Cloud Sync            |
| 21  | Computer objects            | AD computer → Entra device           | Automatic via Hybrid Join           |
| 22  | User objects                | AD user → Entra user                 | Automatic via Cloud Sync            |
| 23  | Contact objects             | AD contact → Entra contact           | Automatic via Cloud Sync            |
| 35  | BitLocker (AD-backed)       | AD → Entra key escrow                | `BackupToAAD-BitLockerKeyProtector` |
| 36  | LAPS                        | Legacy LAPS → Windows LAPS           | Intune LAPS policy                  |
| 56  | DHCP authorization          | AD-authorized → standalone           | Remove AD authorization dependency  |
| 60  | SID filtering               | AD trust → tenant isolation          | Inherent in cloud model             |
| 67  | Password expiration         | AD policy → Entra policy             | Tenant-level configuration          |
| 69  | Account lockout             | AD lockout → Entra smart lockout     | Automatic (better protection)       |
| 70  | Self-service password reset | None → Entra SSPR                    | Enable in Entra admin center        |
| 76  | AD Recycle Bin              | Forest-level → automatic soft delete | Always enabled in Entra ID          |
| 77  | Administrative audit        | AD event log → Entra audit log       | Automatic; richer data              |
| 78  | Object-level auditing       | SACL → automatic audit               | All changes logged by default       |
| 79  | Tombstone lifetime          | AD tombstone → 30-day soft delete    | No configuration needed             |
| 80  | GPO audit                   | Event log → Intune audit             | Tracked in Intune logs              |

### Priority 2: Planned migration (M complexity --- Week 4--12)

These features require architectural planning but are well-documented migration paths:

| #   | Feature                  | Key consideration                  | Planning effort          |
| --- | ------------------------ | ---------------------------------- | ------------------------ |
| 1   | Kerberos auth            | Cloud trust configuration required | 2--3 days                |
| 3   | LDAP simple bind         | All LDAP apps must be identified   | 1--2 weeks for inventory |
| 5   | AD FS (SAML)             | Per-relying-party migration        | 0.5--1 day per app       |
| 7   | AD FS (OIDC)             | Simplest AD FS migration           | 2--4 hours per app       |
| 8   | Smart card (PIV/CAC)     | CA certificate chain upload        | 1--2 days                |
| 11  | MFA                      | Method registration campaign       | 2--4 weeks user rollout  |
| 13  | OUs → Admin Units        | Admin delegation model redesign    | 1 week                   |
| 18  | gMSA → Workload identity | Per-service conversion             | 0.5--1 day per service   |
| 20  | Service accounts         | Inventory and convert              | 1--2 weeks               |
| 24  | Schema extensions        | Directory extension migration      | 1 week                   |
| 34  | WSUS → WUfB              | Update ring design                 | 1 week                   |
| 37  | NTFS ACLs                | ACL model translation for ADLS     | 1--2 weeks               |
| 45  | AD CS templates          | Intune certificate profiles        | 1--2 weeks               |
| 50  | AD-integrated DNS        | Zone migration planning            | 1 week                   |
| 51  | Sites and Services       | Named Location configuration       | 2--3 days                |
| 55  | VPN (RRAS)               | Entra Private Access evaluation    | 1--2 weeks               |
| 57  | Forest trusts            | B2B collaboration design           | 1 week                   |

### Priority 3: Complex migration (L/XL complexity --- Week 12+)

These features require significant remediation or architectural changes:

| #   | Feature                         | Key challenge                      | Mitigation                                |
| --- | ------------------------------- | ---------------------------------- | ----------------------------------------- |
| 2   | NTLM elimination                | Legacy apps depend on NTLM         | App Proxy or app rewrite                  |
| 25  | Full GPO estate                 | 500+ GPOs with complex inheritance | Group Policy Analytics + phased migration |
| 44  | Kerberos constrained delegation | Complex app proxy scenarios        | App Proxy KCD configuration               |
| 52  | DFS Namespaces                  | Multi-site file replication        | SharePoint/OneDrive migration             |
| 53  | DFS Replication                 | Branch office sync                 | OneDrive Known Folder Move                |
| 54  | RADIUS/NPS                      | 802.1x network auth                | Entra Private Access or NAC               |
| 71  | LDAP app binding                | Source code may not be available   | Entra Domain Services as bridge           |
| 75  | WCF services                    | Architectural rewrite needed       | REST API modernization                    |

---

## 13. Gap analysis --- features without direct equivalent

### Features that require alternative approaches

| AD feature                                  | Gap description                                                 | Alternative approach                                                                         | Risk level |
| ------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------- |
| **Fine-grained password policies (per-OU)** | Entra ID supports tenant-level password policy only             | Custom banned password list + Conditional Access authentication strength                     | Low        |
| **AD Sites and Services subnets**           | No direct subnet-to-policy binding                              | Named Locations in Conditional Access provide similar but not identical network-aware policy | Low        |
| **GPO WMI filtering**                       | No WMI-based filter in Intune                                   | Intune assignment filters (device property-based) cover most WMI scenarios                   | Low        |
| **GPO loopback processing**                 | No loopback equivalent                                          | Separate Intune profiles for device context vs user context                                  | Low        |
| **Print server GPO deployment**             | Universal Print covers most but not legacy network printers     | Intune printer deployment + Universal Print                                                  | Medium     |
| **Complex LDAP referrals**                  | Graph API does not support LDAP referral chains                 | Application-level query redesign                                                             | Medium     |
| **AD LDS (Lightweight Directory Services)** | No cloud equivalent of AD LDS                                   | Entra Domain Services or application database migration                                      | Medium     |
| **Netlogon secure channel**                 | Eliminated with DC decommission                                 | Not needed in cloud-only model                                                               | Low        |
| **AD-integrated DNS dynamic updates**       | Azure DNS Private Zones do not support AD-style dynamic updates | Azure DNS + DHCP server updates or standalone DNS                                            | Low        |

### Features that are better in Entra ID (no gap)

| AD feature                 | Entra ID improvement                          | Why it's better                                        |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Password hash storage      | PBKDF2 derived hash (not raw MD4)             | More resistant to offline cracking                     |
| Group membership expansion | Dynamic groups with rule-based membership     | Eliminates manual group management                     |
| Session management         | Continuous Access Evaluation (CAE)            | Real-time token revocation vs Kerberos ticket lifetime |
| Directory replication      | Globally distributed with Azure PoP           | No replication latency or conflict                     |
| Admin access model         | PIM just-in-time with approval                | No standing admin access                               |
| Threat detection           | ML-based Identity Protection                  | Detects threats AD cannot see                          |
| Token security             | Token binding + proof-of-possession           | Stronger than Kerberos ticket security                 |
| Cross-platform SSO         | PRT + MSAL on Windows/macOS/iOS/Android/Linux | Broader than Kerberos (Windows-only)                   |

---

## 14. CSA-in-a-Box feature dependency matrix

Every CSA-in-a-Box service depends on specific Entra ID features. This matrix shows which AD migration milestones must be completed before each platform service is fully functional.

| CSA-in-a-Box service                  | Required Entra ID features               | Migration milestone             |
| ------------------------------------- | ---------------------------------------- | ------------------------------- |
| **Fabric workspace access**           | Security groups, Conditional Access, PIM | Phase 1 (Hybrid Identity)       |
| **Databricks SCIM provisioning**      | User/group sync, enterprise app SSO      | Phase 1 (Hybrid Identity)       |
| **Purview data governance**           | Security groups, admin units, RBAC       | Phase 1 (Hybrid Identity)       |
| **Azure OpenAI RBAC**                 | Managed identity, RBAC roles             | Phase 2 (Application Migration) |
| **Power BI RLS**                      | Dynamic groups, SSO                      | Phase 1 (Hybrid Identity)       |
| **ADLS Gen2 access**                  | Managed identity, POSIX ACLs, RBAC       | Phase 2 (Application Migration) |
| **Key Vault secrets**                 | Managed identity, RBAC                   | Phase 2 (Application Migration) |
| **Conditional Access enforcement**    | All CA policies, device compliance       | Phase 3 (Device Migration)      |
| **Passwordless data platform access** | FIDO2/WHfB/CBA deployment                | Phase 4 (Security Hardening)    |
| **Full Zero Trust posture**           | All features deployed                    | Phase 5 (Cloud-Only)            |

### Implication

CSA-in-a-Box can begin deployment during **Phase 1** (Hybrid Identity). The platform does not require full AD decommission to function. However, full Zero Trust enforcement (Conditional Access requiring compliant devices, passwordless authentication, PIM for admin roles) requires Phase 3+ completion.

---

## 15. Protocol migration reference

### Authentication protocol mapping

| AD protocol               | Port            | Entra ID protocol      | Port        | Transport |
| ------------------------- | --------------- | ---------------------- | ----------- | --------- |
| Kerberos                  | 88 (TCP/UDP)    | OAuth 2.0              | 443 (HTTPS) | TLS 1.2+  |
| NTLM                      | 445 (TCP)       | OAuth 2.0              | 443 (HTTPS) | TLS 1.2+  |
| LDAP                      | 389 (TCP/UDP)   | Microsoft Graph API    | 443 (HTTPS) | TLS 1.2+  |
| LDAPS                     | 636 (TCP)       | Microsoft Graph API    | 443 (HTTPS) | TLS 1.2+  |
| SAML 2.0 (via AD FS)      | 443 (HTTPS)     | SAML 2.0 (native)      | 443 (HTTPS) | TLS 1.2+  |
| WS-Federation (via AD FS) | 443 (HTTPS)     | WS-Federation (native) | 443 (HTTPS) | TLS 1.2+  |
| RADIUS                    | 1812/1813 (UDP) | Entra Private Access   | 443 (HTTPS) | TLS 1.2+  |
| RPC (AD replication)      | Dynamic         | Eliminated             | N/A         | N/A       |
| DNS (AD-integrated)       | 53 (TCP/UDP)    | Azure DNS              | 443 (HTTPS) | TLS 1.2+  |
| Global Catalog            | 3268/3269       | Microsoft Graph API    | 443 (HTTPS) | TLS 1.2+  |

### Token format migration

| AD token                | Entra ID token                 | Key differences                                    |
| ----------------------- | ------------------------------ | -------------------------------------------------- |
| Kerberos TGT            | Primary Refresh Token (PRT)    | PRT is device-bound; longer lifetime; used for SSO |
| Kerberos service ticket | OAuth 2.0 access token         | JWT format; audience-scoped; verifiable without DC |
| SAML assertion (AD FS)  | SAML assertion (Entra ID)      | Same format; issued by different IdP               |
| NTLM response           | N/A (eliminated)               | NTLM has no cloud equivalent                       |
| AD session ticket       | Session cookie + OIDC ID token | Standard web session management                    |

### Firewall port simplification

| Direction             | AD ports required                                    | Entra ID ports required | Reduction                   |
| --------------------- | ---------------------------------------------------- | ----------------------- | --------------------------- |
| Client → DC           | 88, 135, 389, 445, 464, 636, 3268, 3269, dynamic RPC | 443 only                | 9+ ports → 1 port           |
| DC → DC (replication) | 135, 389, 636, 3268, 3269, dynamic RPC, 88, 445      | Eliminated              | 8+ ports → 0 ports          |
| AD FS client → server | 443, 49443                                           | 443 (native)            | No separate AD FS endpoints |
| RADIUS client → NPS   | 1812, 1813                                           | 443                     | Protocol change             |

This port simplification significantly reduces the network attack surface and simplifies firewall rule management.

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
