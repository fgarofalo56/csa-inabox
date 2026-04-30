# MFA Migration: Okta to Entra ID

**Status:** Authored 2026-04-30
**Audience:** Identity Architects, Security Engineers, IAM Engineers
**Purpose:** Detailed guidance for migrating multi-factor authentication from Okta to Microsoft Entra ID

---

## Overview

MFA migration is one of the most user-impacting phases of an Okta-to-Entra ID migration. Every user who currently authenticates with Okta Verify must re-enroll in Microsoft Authenticator (or an alternative Entra-supported method). This requires a structured communication campaign, a self-service enrollment window, and help desk readiness.

The good news: Microsoft Authenticator provides a superior MFA experience with number matching, biometric unlock, passwordless sign-in, and passkey support. Users who complete the transition typically report a better authentication experience.

---

## 1. MFA factor comparison

| Okta MFA factor             | Entra ID equivalent                                         | Parity  | Notes                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Okta Verify (push)**      | **Microsoft Authenticator (push with number matching)**     | Full+   | Authenticator push with number matching is more phishing-resistant than basic Okta push. Number matching requires user to enter a displayed number rather than just tapping "Approve." |
| **Okta Verify (TOTP)**      | **Microsoft Authenticator (TOTP) or any OATH TOTP app**     | Full    | Any OATH-compliant TOTP app works. Authenticator, Google Authenticator, Authy, etc.                                                                                                    |
| **Okta FastPass**           | **Microsoft Authenticator passwordless + Passkeys (FIDO2)** | Full    | Authenticator passwordless and FIDO2 passkeys provide equivalent or superior passwordless experience. Device-bound credentials with biometric unlock.                                  |
| **FIDO2 security key**      | **FIDO2 security keys**                                     | Full    | Same hardware keys work (YubiKey, Feitian, etc.). Re-registration required in Entra.                                                                                                   |
| **SMS OTP**                 | **SMS verification**                                        | Full    | Supported but both Microsoft and NIST discourage SMS-based MFA. Use migration as opportunity to upgrade.                                                                               |
| **Voice call**              | **Voice call verification**                                 | Full    | Supported but discouraged.                                                                                                                                                             |
| **Email OTP**               | **Email OTP**                                               | Full    | Available as secondary method.                                                                                                                                                         |
| **Security questions**      | **Security questions (SSPR only)**                          | Partial | Available for self-service password reset, not for MFA step-up.                                                                                                                        |
| **Duo Security (via Okta)** | **Microsoft Authenticator**                                 | Full    | Replace Duo with Authenticator. If Duo is required for non-Microsoft systems, it can coexist.                                                                                          |
| **RSA SecurID (via Okta)**  | **OATH hardware tokens or FIDO2**                           | Full    | RSA tokens can be registered as OATH hardware tokens in Entra, or replaced with FIDO2 keys.                                                                                            |

---

## 2. Phishing-resistant MFA (the migration opportunity)

The migration from Okta to Entra ID is an ideal opportunity to upgrade your organization's MFA posture to phishing-resistant methods. OMB M-22-09 requires federal agencies to implement phishing-resistant MFA.

### What is phishing-resistant MFA?

Phishing-resistant MFA uses cryptographic binding between the authentication factor and the legitimate service, making it impossible for an attacker to intercept and replay the authentication. Methods include:

| Method                                   | Phishing resistant                                     | Supported in Entra             | Supported in Okta            |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------ | ---------------------------- |
| **FIDO2 security keys**                  | Yes                                                    | Yes (native)                   | Yes                          |
| **Passkeys (device-bound)**              | Yes                                                    | Yes (Authenticator + platform) | Limited (Okta FastPass)      |
| **Windows Hello for Business**           | Yes                                                    | Yes (native)                   | Not supported                |
| **Certificate-based auth (PIV/CAC)**     | Yes                                                    | Yes (native CBA)               | Requires third-party bridge  |
| **Authenticator push (number matching)** | Partially (phishing-resistant with additional context) | Yes                            | Not supported in Okta Verify |
| **TOTP**                                 | No                                                     | Yes                            | Yes                          |
| **SMS/Voice**                            | No                                                     | Yes                            | Yes                          |

### Recommended upgrade path

```
Current Okta MFA          ──>    Target Entra MFA (phishing-resistant)
─────────────────────────────────────────────────────────────────────
Okta Verify push          ──>    Authenticator push (number matching)
                                 OR Passkey (FIDO2) for high-security
Okta Verify TOTP          ──>    Authenticator push (number matching)
                                 [upgrade from TOTP to push]
Okta FastPass             ──>    Authenticator passwordless
                                 OR FIDO2 passkey
SMS OTP                   ──>    Authenticator push (eliminate SMS)
Security keys (YubiKey)   ──>    FIDO2 security keys (re-register)
PIV/CAC (via SAML bridge) ──>    Entra CBA (native, no bridge)
```

---

## 3. MFA enrollment strategy

### Option A: Self-service enrollment (recommended for most organizations)

1. Deploy Microsoft Authenticator to all devices via MDM (Intune) or app store
2. Enable combined security information registration in Entra ID
3. Configure registration campaign (Entra nudge feature)
4. Set a 30-day enrollment window
5. Users enroll at their next sign-in or via https://aka.ms/mysecurityinfo

```powershell
# Enable combined registration
$params = @{
    registrationEnforcement = @{
        authenticationMethodsRegistrationCampaign = @{
            snoozeDurationInDays = 3
            state = "enabled"
            excludeTargets = @()
            includeTargets = @(
                @{
                    id = "all_users"
                    targetType = "group"
                    targetedAuthenticationMethod = "microsoftAuthenticator"
                }
            )
        }
    }
}

Update-MgPolicyAuthenticationMethodPolicy -BodyParameter $params
```

### Option B: IT-assisted enrollment (for high-security environments)

1. Schedule enrollment sessions by department
2. IT staff assists with Authenticator setup
3. Verify enrollment immediately
4. Issue temporary access pass (TAP) for initial enrollment if needed

```powershell
# Issue Temporary Access Pass for MFA enrollment
$tapParams = @{
    startDateTime = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
    lifetimeInMinutes = 60
    isUsableOnce = $true
}

New-MgUserAuthenticationTemporaryAccessPassMethod -UserId "user@contoso.com" -BodyParameter $tapParams
```

### Option C: Parallel enrollment (during coexistence)

1. Users register Authenticator while still using Okta Verify
2. Both MFA methods active during transition period
3. Conditional Access policies gradually shift MFA to Authenticator
4. Okta MFA policies relaxed as Entra MFA takes over

---

## 4. Microsoft Authenticator deployment

### MDM deployment via Intune

```json
{
    "app": {
        "name": "Microsoft Authenticator",
        "platforms": {
            "ios": {
                "bundleId": "com.microsoft.azureauthenticator",
                "appStoreUrl": "https://apps.apple.com/app/microsoft-authenticator/id983156458"
            },
            "android": {
                "packageName": "com.azure.authenticator",
                "playStoreUrl": "https://play.google.com/store/apps/details?id=com.azure.authenticator"
            }
        },
        "assignmentType": "required",
        "targetGroups": ["All Users"]
    }
}
```

### Authenticator configuration policies

```powershell
# Configure Microsoft Authenticator authentication method
$authenticatorConfig = @{
    "@odata.type" = "#microsoft.graph.microsoftAuthenticatorAuthenticationMethodConfiguration"
    state = "enabled"
    includeTargets = @(
        @{
            targetType = "group"
            id = "all_users"
            authenticationMode = "any"  # push, passwordless, or both
        }
    )
    featureSettings = @{
        displayAppInformationRequiredState = @{
            state = "enabled"  # Show app name in push notification
        }
        displayLocationInformationRequiredState = @{
            state = "enabled"  # Show location in push notification
        }
        numberMatchingRequiredState = @{
            state = "enabled"  # Require number matching (phishing-resistant)
        }
    }
}

# Apply configuration
Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration `
    -AuthenticationMethodConfigurationId "MicrosoftAuthenticator" `
    -BodyParameter $authenticatorConfig
```

---

## 5. FIDO2 security key migration

If your organization uses FIDO2 security keys with Okta, the same physical keys work with Entra ID. However, each key must be re-registered because the FIDO2 credential is bound to the relying party (IdP).

### Enable FIDO2 in Entra ID

```powershell
# Enable FIDO2 authentication method
$fido2Config = @{
    "@odata.type" = "#microsoft.graph.fido2AuthenticationMethodConfiguration"
    state = "enabled"
    isAttestationEnforced = $true  # Require attestation for key type verification
    isSelfServiceRegistrationAllowed = $true
    keyRestrictions = @{
        isEnforced = $true
        enforcementType = "allow"
        aaGuids = @(
            "2fc0579f-8113-47ea-b116-bb5a8db9202a",  # YubiKey 5 NFC
            "73bb0cd4-e502-49b8-9c6f-b59445bf720b",  # YubiKey 5Ci
            "cb69481e-8ff7-4039-93ec-0a2729a154a8"   # YubiKey 5 series
        )
    }
    includeTargets = @(
        @{
            targetType = "group"
            id = "all_users"
        }
    )
}

Update-MgPolicyAuthenticationMethodPolicyAuthenticationMethodConfiguration `
    -AuthenticationMethodConfigurationId "Fido2" `
    -BodyParameter $fido2Config
```

### Key re-registration process

1. User navigates to https://aka.ms/mysecurityinfo
2. Selects "Add security key"
3. Inserts FIDO2 key and follows prompts
4. Key creates new credential bound to Entra ID (login.microsoftonline.com)
5. Old Okta credential remains on key but is no longer used

!!! note "Keys support multiple credentials"
FIDO2 security keys can hold credentials for multiple relying parties simultaneously. The Okta credential does not need to be removed before registering with Entra ID. Users can have both active during the transition period.

---

## 6. Re-enrollment communication plan

### Timeline

| Day          | Action                                                                            |
| ------------ | --------------------------------------------------------------------------------- |
| **Day -30**  | Announce MFA migration via email, intranet, and team meetings                     |
| **Day -14**  | Send step-by-step enrollment guide with screenshots                               |
| **Day -7**   | Reminder email with link to https://aka.ms/mysecurityinfo                         |
| **Day 0**    | Enable registration campaign nudge in Entra                                       |
| **Day 0-21** | Self-service enrollment window (nudge every 3 days)                               |
| **Day 21**   | Final reminder to unenrolled users                                                |
| **Day 28**   | Conditional Access policy enforces Authenticator (Okta Verify no longer accepted) |
| **Day 30**   | Close enrollment window; remaining users require IT-assisted enrollment           |

### Sample user communication

Subject: **Action Required: Set up Microsoft Authenticator by [date]**

Body:

> We are consolidating our identity platform to Microsoft Entra ID. As part of this change, you need to set up Microsoft Authenticator as your MFA method.
>
> **What you need to do:**
>
> 1. Install Microsoft Authenticator from your device's app store
> 2. Visit https://aka.ms/mysecurityinfo
> 3. Click "Add sign-in method" and select "Authenticator app"
> 4. Follow the on-screen instructions
>
> **Deadline:** [date -- 30 days from now]
>
> This replaces Okta Verify. After the deadline, Okta Verify will no longer be accepted for sign-in.

---

## 7. Conditional Access MFA policies

After enrollment, configure Conditional Access to enforce MFA:

```powershell
# Create Conditional Access policy requiring MFA for all users
$caPolicy = @{
    displayName = "Require MFA for all users"
    state = "enabledForReportingButNotEnforced"  # Start in report-only mode
    conditions = @{
        users = @{
            includeUsers = @("All")
            excludeUsers = @()
            excludeGroups = @("break-glass-accounts")
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

New-MgIdentityConditionalAccessPolicy -BodyParameter $caPolicy

# After validation, change state to "enabled"
```

### Phishing-resistant MFA policy (for sensitive apps)

```powershell
# Require phishing-resistant MFA for sensitive applications
$prMfaPolicy = @{
    displayName = "Require phishing-resistant MFA for sensitive apps"
    state = "enabled"
    conditions = @{
        users = @{
            includeUsers = @("All")
        }
        applications = @{
            includeApplications = @(
                "fabric-workspace-app-id",
                "azure-portal-app-id",
                "admin-console-app-id"
            )
        }
    }
    grantControls = @{
        operator = "OR"
        authenticationStrength = @{
            id = "00000000-0000-0000-0000-000000000004"  # Phishing-resistant MFA
        }
    }
}

New-MgIdentityConditionalAccessPolicy -BodyParameter $prMfaPolicy
```

---

## 8. MFA enrollment monitoring

Track enrollment progress with Graph API:

```powershell
# Get MFA registration status for all users
$registrationDetails = Get-MgReportAuthenticationMethodUserRegistrationDetail -All

# Summary statistics
$total = $registrationDetails.Count
$authenticatorRegistered = ($registrationDetails | Where-Object {
    $_.MethodsRegistered -contains "microsoftAuthenticator"
}).Count
$fido2Registered = ($registrationDetails | Where-Object {
    $_.MethodsRegistered -contains "fido2SecurityKey"
}).Count
$notRegistered = ($registrationDetails | Where-Object {
    $_.IsMfaRegistered -eq $false
}).Count

Write-Host "MFA Enrollment Report:"
Write-Host "  Total users: $total"
Write-Host "  Authenticator enrolled: $authenticatorRegistered ($([math]::Round($authenticatorRegistered/$total*100,1))%)"
Write-Host "  FIDO2 enrolled: $fido2Registered ($([math]::Round($fido2Registered/$total*100,1))%)"
Write-Host "  Not MFA registered: $notRegistered ($([math]::Round($notRegistered/$total*100,1))%)"
```

---

## 9. Post-migration: disable Okta MFA

After all users are enrolled in Entra MFA and federation cutover is complete:

1. Verify 100% MFA enrollment in Entra
2. Monitor sign-in logs for 30 days -- zero Okta Verify usage
3. Deactivate Okta Verify factor in Okta admin console
4. Users can uninstall Okta Verify from their devices
5. Retain Okta tenant for 90 days (rollback capability)

---

## Key Microsoft Learn references

- [Authentication methods in Entra ID](https://learn.microsoft.com/entra/identity/authentication/concept-authentication-methods)
- [Microsoft Authenticator](https://learn.microsoft.com/entra/identity/authentication/howto-authentication-passwordless-phone)
- [FIDO2 security keys](https://learn.microsoft.com/entra/identity/authentication/howto-authentication-passwordless-security-key)
- [Registration campaign](https://learn.microsoft.com/entra/identity/authentication/how-to-mfa-registration-campaign)
- [Temporary Access Pass](https://learn.microsoft.com/entra/identity/authentication/howto-authentication-temporary-access-pass)
- [Conditional Access authentication strength](https://learn.microsoft.com/entra/identity/authentication/concept-authentication-strengths)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
