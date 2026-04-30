# Security Migration: AD Security Model to Entra ID

**Technical guide for migrating the Active Directory security model to Microsoft Entra ID --- covering Conditional Access, Identity Protection, Privileged Identity Management (PIM), identity threat detection, and Windows LAPS.**

---

## Overview

The Active Directory security model is built on network perimeter trust --- if you are on the network and have a valid Kerberos ticket, you are trusted. The Entra ID security model is built on Zero Trust --- every access request is evaluated against identity, device, location, risk, and application signals before granting access.

This migration replaces implicit network trust with explicit, policy-driven access decisions. The result is a fundamentally stronger security posture that eliminates entire categories of AD-specific attacks.

---

## 1. Conditional Access --- replacing network-based trust

### Conditional Access policy framework

Conditional Access is the Zero Trust policy engine. Every authentication to every cloud service passes through Conditional Access evaluation.

### Baseline policy set for CSA-in-a-Box

| Policy                                        | Conditions                  | Grant controls                     | Target                              |
| --------------------------------------------- | --------------------------- | ---------------------------------- | ----------------------------------- |
| **Require MFA for all users**                 | All users, all cloud apps   | MFA required                       | All users except break-glass        |
| **Require compliant device**                  | CSA-in-a-Box apps           | Compliant device + MFA             | Data platform users                 |
| **Block legacy auth**                         | All users, all apps         | Block                              | All users                           |
| **Require phishing-resistant MFA for admins** | Admin roles                 | Phishing-resistant MFA (FIDO2/CBA) | Global Admin, Privileged Role Admin |
| **Risk-based sign-in policy**                 | Medium/High risk sign-in    | MFA + password change              | All users                           |
| **Risk-based user policy**                    | High risk user              | Password change + MFA              | All users                           |
| **Named location: block risky countries**     | Countries not in allow-list | Block                              | All users                           |
| **Session: sign-in frequency**                | CSA-in-a-Box apps           | 12-hour sign-in frequency          | Data platform users                 |

### Policy deployment

```powershell
# Create baseline Conditional Access policy: Require MFA for all users
$params = @{
    displayName = "CA001 - Require MFA for all users"
    state = "enabledForReportingButNotEnforced"
    conditions = @{
        users = @{
            includeUsers = @("All")
            excludeUsers = @("BreakGlassAccount1-ObjectId", "BreakGlassAccount2-ObjectId")
        }
        applications = @{
            includeApplications = @("All")
        }
        clientAppTypes = @("browser", "mobileAppsAndDesktopClients")
    }
    grantControls = @{
        operator = "OR"
        builtInControls = @("mfa")
    }
}

New-MgIdentityConditionalAccessPolicy -BodyParameter $params

# Create policy: Block legacy authentication
$blockLegacy = @{
    displayName = "CA002 - Block legacy authentication"
    state = "enabledForReportingButNotEnforced"
    conditions = @{
        users = @{ includeUsers = @("All") }
        applications = @{ includeApplications = @("All") }
        clientAppTypes = @(
            "exchangeActiveSync",
            "other"
        )
    }
    grantControls = @{
        operator = "OR"
        builtInControls = @("block")
    }
}

New-MgIdentityConditionalAccessPolicy -BodyParameter $blockLegacy
```

### Conditional Access vs AD network trust

| AD approach                      | Conditional Access approach                   | Security improvement                    |
| -------------------------------- | --------------------------------------------- | --------------------------------------- |
| VPN = trusted                    | Identity + device + location + risk = trusted | Eliminates VPN as single trust factor   |
| Network firewall rules           | Per-app access policies                       | Granular application-level control      |
| IP-based access control          | Named Locations + device compliance           | Context-aware, not just IP-based        |
| NTLM/Kerberos on-net             | OAuth/OIDC with continuous evaluation         | Token binding, revocation, risk signals |
| Static group membership = access | Dynamic policy evaluation per request         | Real-time access decisions              |

---

## 2. Identity Protection --- replacing security event monitoring

### Identity Protection risk detections

Identity Protection uses ML models trained on billions of daily signals to detect identity threats that AD event logs cannot.

| Risk detection                | AD equivalent                                   | Latency        |
| ----------------------------- | ----------------------------------------------- | -------------- |
| Leaked credentials            | None (requires third-party dark web monitoring) | Near real-time |
| Anonymous IP address          | Manual IP reputation lists                      | Real-time      |
| Atypical travel               | None                                            | Real-time      |
| Malware-linked IP             | None                                            | Real-time      |
| Unfamiliar sign-in properties | None (requires UEBA solution)                   | Real-time      |
| Password spray                | Event 4625 analysis (manual)                    | Real-time      |
| Token anomaly                 | None                                            | Real-time      |
| Suspicious browser            | None                                            | Real-time      |
| Suspicious inbox forwarding   | None (Exchange-specific)                        | Near real-time |

### Configure Identity Protection

```powershell
# Configure sign-in risk policy
$signInRiskPolicy = @{
    displayName = "Sign-in Risk Policy - Require MFA"
    state = "enabled"
    conditions = @{
        users = @{ includeUsers = @("All") }
        applications = @{ includeApplications = @("All") }
        signInRiskLevels = @("medium", "high")
    }
    grantControls = @{
        operator = "OR"
        builtInControls = @("mfa")
    }
}

New-MgIdentityConditionalAccessPolicy -BodyParameter $signInRiskPolicy

# Configure user risk policy
$userRiskPolicy = @{
    displayName = "User Risk Policy - Require Password Change"
    state = "enabled"
    conditions = @{
        users = @{ includeUsers = @("All") }
        applications = @{ includeApplications = @("All") }
        userRiskLevels = @("high")
    }
    grantControls = @{
        operator = "AND"
        builtInControls = @("mfa", "passwordChange")
    }
}

New-MgIdentityConditionalAccessPolicy -BodyParameter $userRiskPolicy
```

### Identity Protection monitoring

```kusto
// KQL: Monitor high-risk sign-ins to CSA-in-a-Box resources
AADSignInEventsBeta
| where Timestamp > ago(24h)
| where RiskLevelDuringSignIn in ("medium", "high")
| where ResourceDisplayName in (
    "Microsoft Fabric",
    "Azure Databricks",
    "Microsoft Purview",
    "Power BI Service"
)
| project Timestamp, AccountUpn, RiskLevelDuringSignIn,
    RiskEventTypes, ResourceDisplayName, DeviceName, IPAddress
| sort by Timestamp desc
```

---

## 3. Privileged Identity Management (PIM) --- replacing AD admin groups

### AD admin model vs PIM model

| AD admin model                      | PIM model                            | Security improvement     |
| ----------------------------------- | ------------------------------------ | ------------------------ |
| Permanent Domain Admin membership   | Just-in-time Global Admin activation | No standing admin access |
| 24/7 admin access                   | Time-bound access (1--8 hours)       | Reduced exposure window  |
| No approval workflow                | Multi-level approval gates           | Change control           |
| Group membership = permanent access | Eligible + active role distinction   | Access only when needed  |
| No access reviews                   | Quarterly access reviews             | Regular validation       |
| Audit via event logs (complex)      | Built-in audit and reporting         | Clear accountability     |

### PIM role mapping

| AD admin group    | Entra PIM role                | Activation settings                                 |
| ----------------- | ----------------------------- | --------------------------------------------------- |
| Domain Admins     | Global Administrator          | Require approval + MFA + justification; max 4 hours |
| Schema Admins     | Application Administrator     | Require MFA + justification; max 2 hours            |
| Enterprise Admins | Privileged Role Administrator | Require approval + MFA; max 4 hours                 |
| DNS Admins        | No direct equivalent          | Custom role or Azure DNS RBAC                       |
| Server Operators  | No direct equivalent          | Migrate to Intune device admin                      |
| Account Operators | User Administrator            | Require MFA; max 8 hours                            |
| Backup Operators  | No direct equivalent          | Azure Backup contributor role                       |

### Configure PIM for CSA-in-a-Box admin roles

```powershell
# Configure PIM settings for Fabric Administrator role
$roleId = (Get-MgRoleManagementDirectoryRoleDefinition -Filter "displayName eq 'Fabric Administrator'").Id

# Configure activation requirements
$pimSettings = @{
    rules = @(
        @{
            id = "Approval_EndUser_Assignment"
            ruleType = "RoleManagementPolicyApprovalRule"
            target = @{ caller = "EndUser"; operations = @("All"); level = "Assignment" }
            setting = @{
                isApprovalRequired = $true
                approvalStages = @(
                    @{
                        approvalStageTimeOutInDays = 1
                        primaryApprovers = @(
                            @{
                                "@odata.type" = "#microsoft.graph.singleUser"
                                userId = "approver-object-id"
                            }
                        )
                    }
                )
            }
        }
        @{
            id = "AuthenticationContext_EndUser_Assignment"
            ruleType = "RoleManagementPolicyAuthenticationContextRule"
            target = @{ caller = "EndUser"; operations = @("All"); level = "Assignment" }
            setting = @{
                isEnabled = $true
                claimValue = "c1"  # Require phishing-resistant MFA
            }
        }
        @{
            id = "Expiration_EndUser_Assignment"
            ruleType = "RoleManagementPolicyExpirationRule"
            target = @{ caller = "EndUser"; operations = @("All"); level = "Assignment" }
            setting = @{
                isExpirationRequired = $true
                maximumDuration = "PT4H"  # 4 hours maximum
            }
        }
    )
}
```

---

## 4. Windows LAPS --- replacing legacy LAPS

### Legacy LAPS vs Windows LAPS

| Feature                    | Legacy LAPS (AD-backed)      | Windows LAPS (Entra ID-backed)              |
| -------------------------- | ---------------------------- | ------------------------------------------- |
| Password storage           | AD computer object attribute | Entra ID device object (encrypted)          |
| Encryption                 | Not encrypted in AD          | Encrypted at rest in Entra ID               |
| Access control             | AD ACL on attribute          | Entra RBAC (device local credential reader) |
| Password history           | None                         | Configurable history                        |
| Post-authentication action | None                         | Auto-rotate after use                       |
| Management                 | Custom PowerShell + AD tools | Intune policy + Entra admin center          |

### Configure Windows LAPS via Intune

```powershell
# Create Windows LAPS policy via Intune
# Intune > Endpoint Security > Account Protection > LAPS

$lapsPolicy = @{
    displayName = "CSA-in-a-Box LAPS Policy"
    description = "Windows LAPS with Entra ID backup for data platform devices"
    roleScopeTagIds = @("0")
    settings = @(
        @{
            settingDefinitionId = "device_vendor_msft_laps_policies_backupdirectory"
            settingValue = @{
                "@odata.type" = "#microsoft.graph.deviceManagementConfigurationChoiceSettingValue"
                value = "device_vendor_msft_laps_policies_backupdirectory_1"  # Azure AD
            }
        }
        @{
            settingDefinitionId = "device_vendor_msft_laps_policies_passwordagedaysaad"
            settingValue = @{
                "@odata.type" = "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue"
                value = 30
            }
        }
        @{
            settingDefinitionId = "device_vendor_msft_laps_policies_passwordcomplexity"
            settingValue = @{
                "@odata.type" = "#microsoft.graph.deviceManagementConfigurationChoiceSettingValue"
                value = "device_vendor_msft_laps_policies_passwordcomplexity_4"  # All character types
            }
        }
        @{
            settingDefinitionId = "device_vendor_msft_laps_policies_passwordlength"
            settingValue = @{
                "@odata.type" = "#microsoft.graph.deviceManagementConfigurationIntegerSettingValue"
                value = 24
            }
        }
        @{
            settingDefinitionId = "device_vendor_msft_laps_policies_postauthenticationactions"
            settingValue = @{
                "@odata.type" = "#microsoft.graph.deviceManagementConfigurationChoiceSettingValue"
                value = "device_vendor_msft_laps_policies_postauthenticationactions_3"  # Reset + logoff
            }
        }
    )
}
```

---

## 5. Identity Governance

### Access reviews

Access reviews replace the manual AD group membership audits that most organizations perform quarterly (or never).

```powershell
# Create recurring access review for CSA-in-a-Box admin group
$accessReview = @{
    displayName = "CSA Platform Admins - Quarterly Review"
    descriptionForAdmins = "Review admin access to CSA-in-a-Box platform services"
    scope = @{
        "@odata.type" = "#microsoft.graph.principalResourceMembershipsScope"
        principalScopes = @(@{
            "@odata.type" = "#microsoft.graph.accessReviewQueryScope"
            query = "/groups/csa-admins-group-id/members"
        })
        resourceScopes = @(@{
            "@odata.type" = "#microsoft.graph.accessReviewQueryScope"
            query = "/groups/csa-admins-group-id"
        })
    }
    reviewers = @(@{
        query = "/users/reviewer-object-id"
        queryType = "MicrosoftGraph"
    })
    settings = @{
        mailNotificationsEnabled = $true
        reminderNotificationsEnabled = $true
        justificationRequiredOnApproval = $true
        defaultDecisionEnabled = $true
        defaultDecision = "Deny"  # If reviewer doesn't respond, access is removed
        instanceDurationInDays = 14
        recurrence = @{
            pattern = @{ type = "absoluteMonthly"; interval = 3 }
            range = @{ type = "noEnd"; startDate = "2026-07-01" }
        }
        autoApplyDecisionsEnabled = $true
    }
}

New-MgIdentityGovernanceAccessReviewDefinition -BodyParameter $accessReview
```

### Entitlement management

Entitlement management automates access package assignment for CSA-in-a-Box resources:

| Access package     | Included resources                                   | Auto-assignment                 | Review cycle |
| ------------------ | ---------------------------------------------------- | ------------------------------- | ------------ |
| CSA Data Analyst   | Fabric Viewer, Power BI Reader, Purview Reader       | Department = "Analytics"        | Quarterly    |
| CSA Data Engineer  | Fabric Contributor, Databricks User, ADF Contributor | Department = "Data Engineering" | Quarterly    |
| CSA Platform Admin | Fabric Admin, Databricks Admin, Purview Admin        | Manual request + approval       | Monthly      |
| CSA Data Steward   | Purview Data Curator, Fabric Contributor             | Manual request + approval       | Quarterly    |

---

## 6. Workload identity security

### Service account to workload identity migration

```powershell
# Inventory service accounts with SPNs
Get-ADUser -Filter { ServicePrincipalName -like "*" } -Properties `
    ServicePrincipalName, PasswordLastSet, PasswordNeverExpires,
    LastLogonDate, Description |
    Select-Object SamAccountName, Description,
    @{N="SPNs"; E={$_.ServicePrincipalName -join "; "}},
    PasswordLastSet, PasswordNeverExpires, LastLogonDate |
    Export-Csv ".\service-accounts-with-spns.csv" -NoTypeInformation
```

### Workload identity types in Entra ID

| Use case                        | Identity type                          | Credential type                  |
| ------------------------------- | -------------------------------------- | -------------------------------- |
| Azure resource access           | System-assigned managed identity       | No credential (automatic)        |
| Cross-resource access           | User-assigned managed identity         | No credential (automatic)        |
| CI/CD pipeline (GitHub Actions) | Workload identity federation           | Federated credential (no secret) |
| CI/CD pipeline (Azure DevOps)   | Managed identity or service connection | Managed identity preferred       |
| Third-party SaaS integration    | Application registration               | Certificate (not secret)         |

---

## 7. Attack surface reduction

### AD attack vectors eliminated by Entra migration

| Attack              | AD risk                                  | Entra ID status | Protection                          |
| ------------------- | ---------------------------------------- | --------------- | ----------------------------------- |
| **Kerberoasting**   | High --- service account ticket cracking | **Eliminated**  | No on-prem Kerberos                 |
| **Golden Ticket**   | Critical --- KRBTGT compromise           | **Eliminated**  | No KDC                              |
| **Silver Ticket**   | High --- service key compromise          | **Eliminated**  | No service tickets                  |
| **DCSync**          | Critical --- domain replication abuse    | **Eliminated**  | No replication protocol             |
| **DCShadow**        | Critical --- rogue DC injection          | **Eliminated**  | No DC infrastructure                |
| **Pass-the-Hash**   | High --- NTLM hash reuse                 | **Eliminated**  | No NTLM                             |
| **Pass-the-Ticket** | High --- Kerberos ticket theft           | **Eliminated**  | No Kerberos tickets                 |
| **AS-REP Roasting** | Medium --- pre-auth disabled accounts    | **Eliminated**  | No AS-REP                           |
| **AD CS ESC1-ESC8** | High --- PKI misconfiguration abuse      | **Eliminated**  | No AD CS                            |
| **LDAP relay**      | Medium --- unsigned LDAP                 | **Eliminated**  | No LDAP                             |
| **Password spray**  | High                                     | **Mitigated**   | Smart lockout + Identity Protection |
| **Token theft**     | N/A for AD                               | **Mitigated**   | CAE + token binding                 |

---

## 8. Break-glass procedures

### Break-glass accounts

```powershell
# Create break-glass accounts (cloud-only, excluded from all CA policies)
# These accounts bypass Conditional Access for emergency admin access

# Account 1: FIDO2 security key
$breakGlass1 = @{
    accountEnabled = $true
    displayName = "Break Glass 1"
    mailNickname = "breakglass1"
    userPrincipalName = "breakglass1@contoso.onmicrosoft.com"
    passwordProfile = @{
        forceChangePasswordNextSignIn = $false
        password = (New-Guid).ToString() + "!Aa1"  # Complex, stored in safe
    }
}
New-MgUser -BodyParameter $breakGlass1

# Assign Global Admin permanently (not via PIM)
$roleDefinitionId = (Get-MgRoleManagementDirectoryRoleDefinition `
    -Filter "displayName eq 'Global Administrator'").Id

New-MgRoleManagementDirectoryRoleAssignment -BodyParameter @{
    principalId = $breakGlass1ObjectId
    roleDefinitionId = $roleDefinitionId
    directoryScopeId = "/"
}

# CRITICAL: Exclude break-glass accounts from ALL Conditional Access policies
# Monitor sign-ins: alert on any break-glass account usage
```

---

## CSA-in-a-Box integration

Security migration enables the full Zero Trust posture for CSA-in-a-Box:

- **Conditional Access** enforces MFA and device compliance for Fabric, Databricks, Purview, and Power BI access
- **PIM** provides just-in-time elevation for platform admin roles (no standing admin access)
- **Identity Protection** detects and remediates compromised credentials accessing platform resources
- **Access reviews** ensure ongoing validation of platform access
- **Workload identities** replace service account passwords for CI/CD and automation

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
