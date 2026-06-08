// =====================================================================
// CSA Loom — Identity Picker Graph AppRole documentation / wiring module
// =====================================================================
//
// Graph AppRoles (Entra application permissions) cannot be granted via
// ARM/Bicep — they require a POST to
//   /v1.0/servicePrincipals/{uamiOid}/appRoleAssignments
// on the Microsoft Graph API. This module therefore DOCUMENTS the required
// grants (as deterministic outputs that the post-deploy bootstrap reads) and
// is invoked from admin-plane/main.bicep when loomIdentityPickerEnabled = true.
//
// The actual grant is performed by:
//   scripts/csa-loom/grant-identity-graph-approles.sh
// followed by a Tenant Admin issuing admin consent in
//   Entra ID → Enterprise applications → Console UAMI → Permissions.
//
// Required AppRoles on the Console UAMI (Microsoft Graph, type=Role):
//   User.Read.All         df021288-bdef-4463-88db-98f22de89214
//   Group.Read.All        5b567255-7703-4780-807c-7be8301ae99b
//   Application.Read.All  9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30
//
// Until consented, /api/governance/identities/search returns 503 with the
// exact remediation and the IdentityPicker renders its honest-gate MessageBar
// (per no-vaporware.md / ui-parity.md). No mock data is ever returned.

targetScope = 'resourceGroup'

@description('Console UAMI principal (object) ID — used for the grant-script hint output.')
param consolePrincipalId string

@description('Cloud boundary — determines the Graph endpoint reported in outputs.')
@allowed([ 'Commercial', 'GCC', 'GCC-High', 'IL5' ])
param boundary string

@description('When true, document only (matches the repo-wide skipRoleGrants convention). No grant is attempted from Bicep regardless, since Graph AppRoles are out-of-band.')
param skipRoleGrants bool = false

var graphBase = boundary == 'GCC-High'
  ? 'https://graph.microsoft.us'
  : boundary == 'IL5'
    ? 'https://dod-graph.microsoft.us'
    : 'https://graph.microsoft.com'

var consentPortal = boundary == 'GCC-High' || boundary == 'IL5'
  ? 'https://portal.azure.us'
  : 'https://portal.azure.com'

output requiredAppRoles array = [
  { name: 'User.Read.All',        appRoleId: 'df021288-bdef-4463-88db-98f22de89214', reason: 'Search users by displayName or UPN.' }
  { name: 'Group.Read.All',       appRoleId: '5b567255-7703-4780-807c-7be8301ae99b', reason: 'Search groups and expand transitiveMembers.' }
  { name: 'Application.Read.All', appRoleId: '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30', reason: 'Search service principals / managed identities.' }
]

output graphBase string = graphBase
output graphScope string = '${graphBase}/.default'
output consentPortalUrl string = consentPortal
output documentOnly bool = skipRoleGrants
output grantScriptHint string = 'CONSOLE_UAMI_PRINCIPAL=${consolePrincipalId} scripts/csa-loom/grant-identity-graph-approles.sh'
