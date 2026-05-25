// =============================================================================
// CSA Loom v3 — Conditional Access Policy Template
// =============================================================================
// PURPOSE
//   Document, as code-as-spec, the required Conditional Access (CA) policies
//   that protect sign-in to the Loom Console MSAL app.
//
// IMPORTANT — TEMPLATE FOR MANUAL APPLY ONLY
//   Conditional Access policies live in Entra ID (Azure AD), not in ARM.
//   Bicep / ARM cannot create CA policies. They must be applied via:
//     - Microsoft Graph (DELEGATED admin user token; SPNs cannot create CA)
//     - Entra admin center > Protection > Conditional Access
//     - Microsoft365DSC / Terraform azuread provider (also delegated auth)
//
//   This file exists so the policy definition is checked in, reviewed, and
//   versioned alongside the Loom Console platform code. The exact REST
//   payloads to POST to Graph are embedded below.
//
// PARAMETERS — for reference only (no resources are deployed)
// =============================================================================

@description('Entra (Azure AD) tenant ID. Reserved for v3.x manual-apply automation.')
param tenantId string = 'd1fc0498-f208-4b49-8376-beb9293acdf6'

@description('MSAL client (app) ID for the Loom Console. The CA policy targets sign-ins to this app.')
param loomMsalClientId string = '9844c28c-3b3a-4949-8d63-9eefa3b50a9d'

@description('Display name suffix for CA policies, e.g. "Loom Console". Reserved for v3.x manual-apply automation.')
param policyDisplayNameSuffix string = 'Loom Console'

// =============================================================================
// POLICY 1 — Require MFA for all Loom Console sign-ins
// =============================================================================
// Graph REST equivalent:
//   POST https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies
//   {
//     "displayName": "CSA Loom Console — require MFA for sign-in",
//     "state": "enabledForReportingButNotEnforced",
//     "conditions": {
//       "applications": {
//         "includeApplications": ["${loomMsalClientId}"]
//       },
//       "users": {
//         "includeUsers": ["All"]
//       },
//       "clientAppTypes": ["all"],
//       "locations": {
//         "includeLocations": ["All"]
//       }
//     },
//     "grantControls": {
//       "operator": "AND",
//       "builtInControls": ["mfa"]
//     }
//   }
//
// Apply via az CLI (delegated user with Conditional Access Administrator):
//   az rest --method POST \
//     --url "https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies" \
//     --body @ca-loom-mfa.json
//
// After verifying the policy is reporting-only and not breaking sign-in,
// flip "state" to "enabled" via PATCH on the returned policy ID.
// =============================================================================

// =============================================================================
// POLICY 2 — (OPTIONAL) Require device compliance for Loom Console
// =============================================================================
// Graph REST equivalent:
//   POST https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies
//   {
//     "displayName": "CSA Loom Console — require compliant device",
//     "state": "enabledForReportingButNotEnforced",
//     "conditions": {
//       "applications": { "includeApplications": ["${loomMsalClientId}"] },
//       "users":        { "includeUsers":        ["All"] },
//       "clientAppTypes": ["browser","mobileAppsAndDesktopClients"]
//     },
//     "grantControls": {
//       "operator": "OR",
//       "builtInControls": ["compliantDevice","domainJoinedDevice"]
//     }
//   }
//
// Pre-req: Devices must be enrolled in Intune and have a compliance policy
// assigned. For BYOD or unmanaged scenarios, leave this policy in reporting
// mode and rely on Policy 1 (MFA) only.
// =============================================================================

// =============================================================================
// VERIFICATION
// =============================================================================
// After applying both policies in reporting-only mode, drive Console sign-ins
// for at least 24 hours and review:
//   az rest --method GET \
//     --url "https://graph.microsoft.com/v1.0/auditLogs/signIns?\$filter=appId eq '${loomMsalClientId}'&\$top=50"
//
// Each sign-in record carries conditionalAccessPolicies[].result which
// distinguishes 'reportOnlyNotApplied' (would not have blocked) from
// 'reportOnlyFailure' (would have blocked). Iterate until the failure rate
// for legitimate users is zero, then PATCH state -> "enabled".
// =============================================================================

// =============================================================================
// OUTPUTS — none (this module deploys nothing)
// =============================================================================

output policySpecApplied bool = false
output reason string = 'CA policies require delegated user auth to Microsoft Graph. Apply manually using the JSON payloads embedded in this template. See docs/fiab/v3-security-hardening.md Phase 5.'
