# Federation Migration: Okta to Entra ID

**Status:** Authored 2026-04-30
**Audience:** Identity Architects, Security Engineers, IAM Engineers
**Purpose:** Detailed guidance for migrating domain federation from Okta to Entra ID

---

## Overview

Domain federation is the mechanism by which Okta serves as the identity provider (IdP) for your organization's domains. When a user signs in to Microsoft 365 or Azure, the authentication request is redirected to Okta for credential validation. Migrating federation means making Entra ID the direct authentication authority -- eliminating the redirect to Okta entirely.

This is typically the **final** migration step. You migrate applications, MFA, provisioning, and policies first, then cut federation as the last operation. Federation cutover affects every user authenticating through that domain, so it requires careful planning and rollback capability.

Microsoft has published dedicated guidance: [Migrate Okta federation to Entra ID managed authentication](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-okta-federation-to-azure-active-directory).

---

## 1. Federation models

### Current state: Okta as IdP (federated domain)

```
User login flow (federated):

    User ──> login.microsoftonline.com ──> Redirect to Okta
                                              │
                                         Okta authenticates
                                         Okta enforces MFA
                                         Okta issues SAML assertion
                                              │
                                         Redirect back to Entra
                                              │
                                         Entra validates assertion
                                         Entra issues tokens
                                              │
                                         User accesses resource
```

### Target state: Entra ID as IdP (managed domain)

```
User login flow (managed):

    User ──> login.microsoftonline.com ──> Entra authenticates directly
                                              │
                                         Entra enforces Conditional Access
                                         Entra enforces MFA (Authenticator)
                                         Entra issues tokens
                                              │
                                         User accesses resource
```

**Benefits of managed authentication:**

- Eliminates Okta dependency (no redirect, no Okta availability requirement)
- Reduces authentication latency (single IdP hop instead of double)
- Enables Entra-native features: password protection, Smart Lockout, Conditional Access (full capabilities), continuous access evaluation
- Simplifies troubleshooting (single sign-in log instead of cross-IdP correlation)

---

## 2. Pre-migration requirements

Before cutting federation, ensure these prerequisites are complete:

| Requirement                     | Validation                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| **All SSO apps migrated**       | Every Okta SSO integration has an Entra Enterprise Application equivalent                        |
| **MFA enrolled**                | >= 95% of users enrolled in Microsoft Authenticator or FIDO2                                     |
| **Conditional Access deployed** | All Okta sign-on policies have equivalent Conditional Access policies                            |
| **Provisioning migrated**       | All SCIM connectors configured in Entra provisioning                                             |
| **Passwords synced**            | Users have Entra-managed passwords (via Entra Connect password hash sync or cloud-only accounts) |
| **Emergency access accounts**   | Break-glass accounts configured with Entra-native authentication (not federated)                 |
| **Rollback plan**               | Federation can be re-enabled within 30 minutes if issues arise                                   |

!!! warning "Password hash synchronization is critical"
If your domain is currently federated to Okta, users do not have password hashes in Entra ID (passwords are validated by Okta). Before cutting federation, you **must** either:

    1. Enable password hash synchronization (PHS) through Entra Connect Sync for hybrid environments
    2. Issue temporary access passes (TAP) for cloud-only users to set new passwords
    3. Use passwordless authentication (FIDO2, Authenticator) so passwords are not required

    Without this step, users will be unable to sign in after federation cutover.

---

## 3. Staged rollover (recommended approach)

Staged rollover migrates users from federated to managed authentication in groups rather than all at once. This is the recommended approach for production environments.

### How staged rollover works

Entra ID's staged rollover feature allows you to select groups of users who authenticate directly with Entra ID while the domain remains technically federated. Users not in the staged rollover groups continue to authenticate via Okta.

```powershell
# Step 1: Enable staged rollover for password hash sync
Connect-MgGraph -Scopes "Policy.ReadWrite.AuthenticationMethod"

# Create staged rollover policy
$params = @{
    featureRollouts = @(
        @{
            feature = "passwordHashSync"
            isEnabled = $true
            isAppliedToOrganization = $false
        }
    )
}

# Step 2: Add pilot group to staged rollover
$pilotGroup = Get-MgGroup -Filter "displayName eq 'Okta-Migration-Pilot'"

# Add group to PHS staged rollover
New-MgPolicyStagedRolloutPolicy -Body @{
    feature = "passwordHashSync"
    isEnabled = $true
    isAppliedToOrganization = $false
}

# Assign pilot group
$policy = Get-MgPolicyStagedRolloutPolicy -Filter "feature eq 'passwordHashSync'"
New-MgPolicyStagedRolloutPolicyAppliedTo -StagedRolloutPolicyId $policy.Id -Body @{
    "@odata.id" = "https://graph.microsoft.com/v1.0/groups/$($pilotGroup.Id)"
}
```

### Staged rollover sequence

| Wave       | Scope                                     | Duration | Validation criteria                                        |
| ---------- | ----------------------------------------- | -------- | ---------------------------------------------------------- |
| **Wave 1** | IT staff and identity team (50-100 users) | 1 week   | All apps accessible, MFA works, no authentication failures |
| **Wave 2** | Early adopter department (200-500 users)  | 1 week   | Help desk ticket volume within baseline                    |
| **Wave 3** | 25% of organization                       | 2 weeks  | Authentication success rate >= 99.5%                       |
| **Wave 4** | 50% of organization                       | 1 week   | No increase in help desk tickets                           |
| **Wave 5** | Remaining users                           | 1 week   | Full validation                                            |
| **Final**  | Convert domain from federated to managed  | 1 day    | Remove Okta federation trust                               |

---

## 4. Federation cutover (final step)

After staged rollover validates that all users can authenticate directly with Entra ID, the final step is converting the domain from federated to managed.

### Using PowerShell

```powershell
# Connect to Microsoft Graph
Connect-MgGraph -Scopes "Domain.ReadWrite.All"

# Verify current domain federation status
Get-MgDomain -DomainId "contoso.com" | Select-Object Id, AuthenticationType

# Expected output for federated domain:
# Id           AuthenticationType
# --           ------------------
# contoso.com  Federated

# Convert domain from federated to managed
Update-MgDomain -DomainId "contoso.com" -AuthenticationType "Managed"

# Verify conversion
Get-MgDomain -DomainId "contoso.com" | Select-Object Id, AuthenticationType

# Expected output after conversion:
# Id           AuthenticationType
# --           ------------------
# contoso.com  Managed
```

### Using Azure CLI

```bash
# Convert domain from federated to managed
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/domains/contoso.com" \
  --body '{"authenticationType": "Managed"}'

# Verify conversion
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/domains/contoso.com" \
  --query "authenticationType"
```

---

## 5. SAML/WS-Fed federation configuration

If you are maintaining Okta federation temporarily (coexistence scenario), you may need to configure or modify the federation trust.

### Okta federation trust configuration in Entra ID

```powershell
# View current federation configuration
Get-MgDomainFederationConfiguration -DomainId "contoso.com"

# Key properties of the federation configuration:
# - IssuerUri: Okta issuer URL (e.g., https://your-org.okta.com)
# - PassiveSignInUri: Okta SAML endpoint
# - SigningCertificate: Okta signing certificate (base64)
# - ActiveSignInUri: Okta WS-Trust endpoint (for rich clients)
# - PreferredAuthenticationProtocol: samlP or wsFed
```

### Token claims mapping

When transitioning from Okta federation, ensure token claims are mapped correctly:

| Okta claim               | SAML attribute                                                         | Entra ID equivalent                     | Notes                                                           |
| ------------------------ | ---------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `sub` / `nameIdentifier` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier` | ImmutableID (on-prem) or UPN (cloud)    | Must match between Okta and Entra to prevent duplicate accounts |
| `email`                  | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`   | `user.mail` or `user.userprincipalname` | Verify claim mapping in each SSO app                            |
| `groups`                 | Custom attribute                                                       | `user.assignedgroups` or group claim    | Group claim format may differ (Object ID vs name)               |
| `firstName`              | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname`      | `user.givenname`                        | Standard claim                                                  |
| `lastName`               | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname`        | `user.surname`                          | Standard claim                                                  |

---

## 6. Rollback procedures

### Emergency rollback: re-enable federation

If issues arise after federation cutover, re-enable Okta federation:

```powershell
# Emergency rollback -- re-federate domain to Okta
$federationConfig = @{
    issuerUri = "https://your-org.okta.com"
    passiveSignInUri = "https://your-org.okta.com/app/office365/sso/saml"
    signingCertificate = "<base64-encoded-okta-signing-certificate>"
    preferredAuthenticationProtocol = "samlP"
}

# Re-configure federation
New-MgDomainFederationConfiguration -DomainId "contoso.com" -BodyParameter $federationConfig

# Convert domain back to federated
Update-MgDomain -DomainId "contoso.com" -AuthenticationType "Federated"

# Verify rollback
Get-MgDomain -DomainId "contoso.com" | Select-Object Id, AuthenticationType
```

### Rollback checklist

- [ ] Okta tenant still active (do not decommission until 90 days post-cutover)
- [ ] Okta signing certificate not expired
- [ ] Okta application configurations preserved
- [ ] DNS records for Okta endpoints still resolving
- [ ] Rollback tested in non-production environment

---

## 7. Multi-domain federation

Organizations with multiple domains require per-domain federation management:

```powershell
# List all domains and their authentication types
Get-MgDomain | Select-Object Id, AuthenticationType, IsVerified

# Migrate domains in order:
# 1. Test/dev domains first
# 2. Secondary production domains
# 3. Primary domain last

# Example: Migrate domains in sequence
$domains = @("test.contoso.com", "subsidiary.contoso.com", "contoso.com")

foreach ($domain in $domains) {
    Write-Host "Converting $domain to managed authentication..."
    Update-MgDomain -DomainId $domain -AuthenticationType "Managed"

    # Validate
    $result = Get-MgDomain -DomainId $domain
    Write-Host "$domain authentication type: $($result.AuthenticationType)"

    # Wait for validation before proceeding to next domain
    Read-Host "Validate $domain and press Enter to continue"
}
```

---

## 8. Hybrid identity considerations

If your organization uses on-premises Active Directory with Entra Connect Sync:

### Password hash synchronization

```powershell
# Verify PHS is enabled in Entra Connect
Get-ADSyncAADCompanyFeature

# Expected: PasswordHashSync = True

# If not enabled, configure PHS:
Set-ADSyncAADCompanyFeature -PasswordHashSync $true

# Force initial password hash sync
Start-ADSyncSyncCycle -PolicyType Initial
```

### Entra Connect Cloud Sync (alternative)

For new deployments, Entra Connect Cloud Sync provides a lighter-weight option:

```powershell
# Cloud Sync is configured via the Entra admin center
# No on-premises server required beyond the provisioning agent

# Verify Cloud Sync agent status
Get-MgServicePrincipal -Filter "appId eq '1a4721b3-e57f-4451-ae87-ef078703ec94'"
```

---

## 9. Post-cutover validation

After federation cutover, validate across all dimensions:

| Validation area                 | Test procedure                                         | Success criteria                                  |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| **User sign-in**                | 10+ users from each migrated wave sign in to M365      | Successful authentication without Okta redirect   |
| **MFA**                         | Verify MFA prompts use Microsoft Authenticator         | No Okta Verify prompts                            |
| **SSO apps**                    | Access each migrated SSO application                   | SSO works without re-authentication for each app  |
| **Conditional Access**          | Trigger CA policy scenarios (new device, new location) | Policies enforce correctly                        |
| **Self-service password reset** | User resets password via SSPR                          | Password reset completes without Okta involvement |
| **Provisioning**                | Create new user in HR system; verify provisioning      | User appears in Entra ID and assigned apps        |
| **Sign-in logs**                | Review Entra sign-in logs for errors                   | Error rate < 0.5%                                 |

---

## Key Microsoft Learn references

- [Migrate Okta federation to Entra managed authentication](https://learn.microsoft.com/entra/identity/enterprise-apps/migrate-okta-federation-to-azure-active-directory)
- [Staged rollover for cloud authentication](https://learn.microsoft.com/entra/identity/hybrid/connect/how-to-connect-staged-rollover)
- [Password hash synchronization](https://learn.microsoft.com/entra/identity/hybrid/connect/how-to-connect-password-hash-synchronization)
- [Entra Connect Cloud Sync](https://learn.microsoft.com/entra/identity/hybrid/cloud-sync/what-is-cloud-sync)
- [Domain federation configuration](https://learn.microsoft.com/graph/api/resources/internaldomainfederation)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
