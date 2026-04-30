# Conditional Access Migration: Okta Sign-on Policies to Entra ID

**Status:** Authored 2026-04-30
**Audience:** Identity Architects, Security Engineers, IAM Analysts
**Purpose:** Detailed guidance for migrating Okta sign-on policies to Entra Conditional Access

---

## Overview

Okta sign-on policies control how users authenticate -- where MFA is required, which network locations are trusted, what session lifetimes apply, and which device conditions must be met. Entra Conditional Access is the equivalent policy engine in Microsoft's identity platform, but with significantly broader scope and richer signal integration.

This guide provides a systematic approach to mapping every Okta sign-on policy to an Entra Conditional Access policy, ensuring no security posture is lost during migration.

Microsoft has published dedicated guidance: [Migrate Okta sign-on policies to Conditional Access](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-okta-sign-on-policies-conditional-access).

---

## 1. Policy model comparison

### Okta sign-on policy model

```
Okta Policy Hierarchy:

    Global Sign-On Policy (org-wide default)
        └── Rule 1: If [condition], then [action]
        └── Rule 2: If [condition], then [action]
        └── Default Rule: Allow with MFA

    Per-App Sign-On Policy (per application)
        └── Rule 1: If [condition], then [action]
        └── Rule 2: If [condition], then [action]
        └── Default Rule: Allow
```

### Entra Conditional Access policy model

```
Entra CA Policy Model:

    Policy 1: [Users] + [Apps] + [Conditions] -> [Grant/Block] + [Session]
    Policy 2: [Users] + [Apps] + [Conditions] -> [Grant/Block] + [Session]
    Policy 3: [Users] + [Apps] + [Conditions] -> [Grant/Block] + [Session]
    ...
    (All policies evaluated; most restrictive grant controls apply)
```

### Key differences

| Aspect               | Okta sign-on policies                     | Entra Conditional Access                                                     |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| **Evaluation model** | First-match (ordered rules within policy) | All-match (all applicable policies evaluated; most restrictive wins)         |
| **Scope**            | IdP-layer only (authentication event)     | Identity + apps + devices + locations + risk + workload identities           |
| **Policy count**     | One global + one per app                  | Unlimited policies targeting any combination of users/apps/conditions        |
| **Risk signals**     | Okta ThreatInsight (limited)              | Identity Protection (user risk + sign-in risk from billions of signals)      |
| **Device signals**   | Requires Workspace ONE/Jamf               | Native Intune compliance                                                     |
| **Session controls** | Session lifetime only                     | Sign-in frequency, persistent browser, app-enforced restrictions, MCAS proxy |
| **Report-only mode** | Limited testing capability                | Full report-only mode for policy impact analysis                             |
| **Named locations**  | IP-based network zones only               | IP ranges + GPS-based + country/region + compliant network                   |

---

## 2. Policy-by-policy mapping

### Export Okta sign-on policies

```bash
# Export global sign-on policy
curl -s -H "Authorization: SSWS ${OKTA_API_TOKEN}" \
  "https://${OKTA_DOMAIN}/api/v1/policies?type=OKTA_SIGN_ON" \
  | jq '[.[] | {
    id: .id,
    name: .name,
    status: .status,
    type: .type,
    priority: .priority,
    conditions: .conditions
  }]' > okta-signon-policies.json

# Export rules for each policy
for policy_id in $(jq -r '.[].id' okta-signon-policies.json); do
  curl -s -H "Authorization: SSWS ${OKTA_API_TOKEN}" \
    "https://${OKTA_DOMAIN}/api/v1/policies/${policy_id}/rules" \
    > "okta-policy-rules-${policy_id}.json"
done
```

### Mapping template

For each Okta sign-on policy rule, create an Entra Conditional Access policy:

| Okta rule element                    | Maps to           | Entra CA configuration                                       |
| ------------------------------------ | ----------------- | ------------------------------------------------------------ |
| `conditions.people.users.include`    | Users and groups  | `conditions.users.includeUsers` / `includeGroups`            |
| `conditions.people.users.exclude`    | Exclude users     | `conditions.users.excludeUsers` / `excludeGroups`            |
| `conditions.network.connection`      | Named locations   | `conditions.locations.includeLocations` / `excludeLocations` |
| `conditions.authContext.authType`    | Client app types  | `conditions.clientAppTypes`                                  |
| `conditions.riskScore`               | Sign-in risk      | `conditions.signInRiskLevels`                                |
| `actions.signon.access` (ALLOW/DENY) | Grant/Block       | `grantControls.builtInControls`                              |
| `actions.signon.requireFactor`       | Require MFA       | `grantControls.builtInControls: ["mfa"]`                     |
| `actions.signon.factorLifetime`      | Sign-in frequency | `sessionControls.signInFrequency`                            |
| `conditions.platform.include`        | Device platform   | `conditions.platforms.includePlatforms`                      |

---

## 3. Common policy migrations

### Policy 1: Require MFA for all users

**Okta rule:**

```json
{
    "name": "Require MFA for all",
    "conditions": {
        "people": { "users": { "include": ["EVERYONE"] } },
        "network": { "connection": "ANYWHERE" }
    },
    "actions": {
        "signon": {
            "access": "ALLOW",
            "requireFactor": true,
            "factorLifetime": 720
        }
    }
}
```

**Entra Conditional Access:**

```powershell
$policy = @{
    displayName = "Require MFA for all users"
    state = "enabledForReportingButNotEnforced"
    conditions = @{
        users = @{
            includeUsers = @("All")
            excludeGroups = @("break-glass-accounts-group-id")
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
    sessionControls = @{
        signInFrequency = @{
            value = 30
            type = "days"
            isEnabled = $true
        }
    }
}

New-MgIdentityConditionalAccessPolicy -BodyParameter $policy
```

### Policy 2: Block access from untrusted networks

**Okta rule:**

```json
{
    "name": "Block untrusted network",
    "conditions": {
        "network": { "connection": "ZONE", "exclude": ["trusted-zone-id"] }
    },
    "actions": {
        "signon": { "access": "DENY" }
    }
}
```

**Entra Conditional Access:**

```powershell
# Step 1: Create named location for trusted network
$trustedLocation = @{
    "@odata.type" = "#microsoft.graph.ipNamedLocation"
    displayName = "Corporate Network"
    isTrusted = $true
    ipRanges = @(
        @{ "@odata.type" = "#microsoft.graph.iPv4CidrRange"; cidrAddress = "10.0.0.0/8" },
        @{ "@odata.type" = "#microsoft.graph.iPv4CidrRange"; cidrAddress = "203.0.113.0/24" }
    )
}
$location = New-MgIdentityConditionalAccessNamedLocation -BodyParameter $trustedLocation

# Step 2: Create policy blocking untrusted locations
$blockPolicy = @{
    displayName = "Block access from untrusted networks"
    state = "enabled"
    conditions = @{
        users = @{ includeUsers = @("All") }
        applications = @{ includeApplications = @("All") }
        locations = @{
            includeLocations = @("All")
            excludeLocations = @($location.Id)
        }
    }
    grantControls = @{
        operator = "OR"
        builtInControls = @("block")
    }
}
New-MgIdentityConditionalAccessPolicy -BodyParameter $blockPolicy
```

### Policy 3: Device trust (Okta + Workspace ONE to Entra + Intune)

**Okta rule:**

```json
{
    "name": "Require managed device",
    "conditions": {
        "device": { "registered": true, "managed": true }
    },
    "actions": {
        "signon": {
            "access": "ALLOW",
            "requireFactor": false
        }
    }
}
```

**Entra Conditional Access:**

```powershell
$devicePolicy = @{
    displayName = "Require compliant device"
    state = "enabled"
    conditions = @{
        users = @{ includeUsers = @("All") }
        applications = @{ includeApplications = @("All") }
        clientAppTypes = @("browser", "mobileAppsAndDesktopClients")
    }
    grantControls = @{
        operator = "OR"
        builtInControls = @("compliantDevice")
    }
}
New-MgIdentityConditionalAccessPolicy -BodyParameter $devicePolicy
```

### Policy 4: Risk-based MFA (Okta ThreatInsight to Identity Protection)

**Okta:** ThreatInsight blocks or challenges suspicious IPs at the pre-authentication stage.

**Entra Conditional Access with Identity Protection:**

```powershell
# High-risk sign-in: block access
$highRiskPolicy = @{
    displayName = "Block high-risk sign-ins"
    state = "enabled"
    conditions = @{
        users = @{ includeUsers = @("All") }
        applications = @{ includeApplications = @("All") }
        signInRiskLevels = @("high")
    }
    grantControls = @{
        operator = "OR"
        builtInControls = @("block")
    }
}
New-MgIdentityConditionalAccessPolicy -BodyParameter $highRiskPolicy

# Medium-risk sign-in: require MFA
$mediumRiskPolicy = @{
    displayName = "Require MFA for medium-risk sign-ins"
    state = "enabled"
    conditions = @{
        users = @{ includeUsers = @("All") }
        applications = @{ includeApplications = @("All") }
        signInRiskLevels = @("medium")
    }
    grantControls = @{
        operator = "OR"
        builtInControls = @("mfa")
    }
}
New-MgIdentityConditionalAccessPolicy -BodyParameter $mediumRiskPolicy

# High-risk user: require password change + MFA
$riskyUserPolicy = @{
    displayName = "Require password change for high-risk users"
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
New-MgIdentityConditionalAccessPolicy -BodyParameter $riskyUserPolicy
```

---

## 4. Entra-exclusive capabilities (no Okta equivalent)

These Conditional Access capabilities have no direct Okta sign-on policy equivalent. Enable them as part of the migration to improve security posture:

### Authentication context

```powershell
# Create authentication context for step-up MFA
$authContext = @{
    id = "c1"
    displayName = "Sensitive Data Access"
    description = "Step-up authentication for accessing sensitive data"
    isAvailable = $true
}
New-MgIdentityConditionalAccessAuthenticationContextClassReference -BodyParameter $authContext

# Create CA policy using authentication context
$stepUpPolicy = @{
    displayName = "Require phishing-resistant MFA for sensitive data"
    state = "enabled"
    conditions = @{
        users = @{ includeUsers = @("All") }
        applications = @{
            includeAuthenticationContextClassReferences = @("c1")
        }
    }
    grantControls = @{
        operator = "OR"
        authenticationStrength = @{
            id = "00000000-0000-0000-0000-000000000004"
        }
    }
}
New-MgIdentityConditionalAccessPolicy -BodyParameter $stepUpPolicy
```

### Continuous Access Evaluation (CAE)

CAE enforces policy changes in near-real-time rather than waiting for token expiration. This is automatically enabled for supported applications (Exchange Online, SharePoint Online, Teams, Graph API).

### Token protection

```powershell
# Require token binding (prevents token theft and replay)
$tokenProtectionPolicy = @{
    displayName = "Require token binding for Windows devices"
    state = "enabled"
    conditions = @{
        users = @{ includeUsers = @("All") }
        applications = @{ includeApplications = @("All") }
        platforms = @{
            includePlatforms = @("windows")
        }
    }
    sessionControls = @{
        secureSignInSession = @{
            isEnabled = $true
        }
    }
}
New-MgIdentityConditionalAccessPolicy -BodyParameter $tokenProtectionPolicy
```

### Workload identity Conditional Access

```powershell
# Apply CA to service principals (no Okta equivalent)
$workloadPolicy = @{
    displayName = "Require compliant network for service principals"
    state = "enabled"
    conditions = @{
        clientApplications = @{
            includeServicePrincipals = @("service-principal-id-1", "service-principal-id-2")
        }
        locations = @{
            includeLocations = @("All")
            excludeLocations = @("trusted-location-id")
        }
    }
    grantControls = @{
        operator = "OR"
        builtInControls = @("block")
    }
}
New-MgIdentityConditionalAccessPolicy -BodyParameter $workloadPolicy
```

---

## 5. Session controls migration

| Okta session setting     | Entra session control             | Configuration                                                     |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------- |
| Session lifetime (hours) | Sign-in frequency                 | `sessionControls.signInFrequency.value` + `.type` (hours/days)    |
| Idle session timeout     | Persistent browser session        | `sessionControls.persistentBrowser.mode` (always/never)           |
| Force re-authentication  | Sign-in frequency: every time     | `sessionControls.signInFrequency.frequencyInterval` = "everyTime" |
| No Okta equivalent       | Application enforced restrictions | `sessionControls.applicationEnforcedRestrictions.isEnabled`       |
| No Okta equivalent       | MCAS session proxy                | `sessionControls.cloudAppSecurity.isEnabled`                      |

---

## 6. Report-only mode and validation

### Deploy all policies in report-only mode first

```powershell
# List all CA policies in report-only mode
$reportOnlyPolicies = Get-MgIdentityConditionalAccessPolicy -Filter "state eq 'enabledForReportingButNotEnforced'"

Write-Host "Policies in report-only mode: $($reportOnlyPolicies.Count)"
$reportOnlyPolicies | ForEach-Object {
    Write-Host "  - $($_.DisplayName)"
}
```

### Analyze report-only impact

```powershell
# Query sign-in logs for report-only policy impact
$signIns = Get-MgAuditLogSignIn -Filter "createdDateTime ge 2026-04-01T00:00:00Z" -Top 1000

$policyImpact = $signIns | ForEach-Object {
    $_.ConditionalAccessPolicies | Where-Object { $_.Result -eq "reportOnlyFailure" }
} | Group-Object DisplayName | Sort-Object Count -Descending

Write-Host "Report-only policy impact (would have blocked):"
$policyImpact | ForEach-Object {
    Write-Host "  $($_.Name): $($_.Count) sign-ins affected"
}
```

### Promote from report-only to enabled

```powershell
# After validation, enable policies one at a time
$policyId = "policy-id-to-enable"
Update-MgIdentityConditionalAccessPolicy -ConditionalAccessPolicyId $policyId -State "enabled"
```

---

## 7. CSA-in-a-Box-specific Conditional Access policies

Configure Conditional Access policies specifically for CSA-in-a-Box platform components:

```powershell
# Require MFA + compliant device for Fabric workspace access
$fabricPolicy = @{
    displayName = "CSA-in-a-Box: Secure Fabric access"
    state = "enabled"
    conditions = @{
        users = @{ includeGroups = @("fabric-users-group-id") }
        applications = @{
            includeApplications = @(
                "00000009-0000-0000-c000-000000000000"  # Power BI / Fabric
            )
        }
    }
    grantControls = @{
        operator = "AND"
        builtInControls = @("mfa", "compliantDevice")
    }
}
New-MgIdentityConditionalAccessPolicy -BodyParameter $fabricPolicy
```

---

## 8. Validation checklist

- [ ] All Okta sign-on policies exported and documented
- [ ] Each Okta policy rule mapped to a Conditional Access policy
- [ ] Named locations created (IP ranges, GPS, countries)
- [ ] All policies deployed in report-only mode
- [ ] Report-only impact analyzed for 14+ days
- [ ] No unexpected blocks in report-only data
- [ ] Break-glass accounts excluded from all blocking policies
- [ ] Policies promoted from report-only to enabled (one at a time)
- [ ] Sign-in logs monitored for 7 days post-enablement
- [ ] Okta sign-on policies documented as deprecated

---

## Key Microsoft Learn references

- [Migrate Okta sign-on policies to Conditional Access](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-okta-sign-on-policies-conditional-access)
- [Conditional Access overview](https://learn.microsoft.com/entra/identity/conditional-access/overview)
- [Named locations](https://learn.microsoft.com/entra/identity/conditional-access/concept-assignment-network)
- [Identity Protection risk policies](https://learn.microsoft.com/entra/id-protection/concept-identity-protection-policies)
- [Authentication context](https://learn.microsoft.com/entra/identity/conditional-access/concept-conditional-access-cloud-apps#authentication-context)
- [Continuous access evaluation](https://learn.microsoft.com/entra/identity/conditional-access/concept-continuous-access-evaluation)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
