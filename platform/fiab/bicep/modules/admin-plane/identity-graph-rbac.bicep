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

@description('When true, also document the Group.ReadWrite.All AppRole required for the workspace settings "Teams and SharePoint" tab to CREATE a Microsoft 365 group for a workspace (set LOOM_WORKSPACE_M365_LINK=true on the console). Read-only group search needs only Group.Read.All; group creation needs this additional consent, so it is opt-in to avoid a surprise consent prompt on existing deployments.')
param workspaceM365LinkEnabled bool = false

@description('When true, document the Microsoft Graph Sites.Read.All + Files.Read.All AppRoles the Console UAMI needs for OneLake shortcuts to SharePoint document libraries / OneDrive folders (set LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true on the console). Granted out-of-band by scripts/csa-loom/grant-shortcut-graph-approles.sh + admin consent.')
param sharepointShortcutsEnabled bool = false

@description('Whether the identity picker itself is enabled — when false (SharePoint shortcuts enabled alone), the user/group/SPN read AppRoles are not documented as required.')
param identityPickerEnabled bool = true

var graphBase = boundary == 'GCC-High'
  ? 'https://graph.microsoft.us'
  : boundary == 'IL5'
    ? 'https://dod-graph.microsoft.us'
    : 'https://graph.microsoft.com'

var consentPortal = boundary == 'GCC-High' || boundary == 'IL5'
  ? 'https://portal.azure.us'
  : 'https://portal.azure.com'

// Group.ReadWrite.All — required ONLY when the workspace ↔ M365-group "create a
// new group" affordance is enabled. Append it conditionally so the documented
// grant set matches what's actually consented.
var baseAppRoles = [
  { name: 'User.Read.All',        appRoleId: 'df021288-bdef-4463-88db-98f22de89214', reason: 'Search users by displayName or UPN.' }
  { name: 'Group.Read.All',       appRoleId: '5b567255-7703-4780-807c-7be8301ae99b', reason: 'Search groups and expand transitiveMembers; link an existing M365 group to a workspace.' }
  { name: 'Application.Read.All', appRoleId: '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30', reason: 'Search service principals / managed identities.' }
]
var m365WriteAppRole = [
  { name: 'Group.ReadWrite.All', appRoleId: '62a82d76-70ea-41e2-9197-370581804d09', reason: 'Create a Microsoft 365 group for a workspace (settings → Teams and SharePoint).' }
]
// Sites.Read.All + Files.Read.All — required ONLY when SharePoint/OneDrive
// OneLake shortcuts are enabled. Lets the Console UAMI enumerate SharePoint
// sites + document libraries (drives) and read OneDrive/SharePoint drive items.
var sharepointAppRoles = [
  { name: 'Sites.Read.All', appRoleId: '332a536c-c7ef-4017-ab91-336970924f0d', reason: 'Enumerate SharePoint sites + their document libraries for OneLake shortcuts.' }
  { name: 'Files.Read.All', appRoleId: '01d4889c-1287-42c6-ac1f-5d1e02578ef6', reason: 'List + read OneDrive / SharePoint drive items a shortcut points at.' }
]

var identityRoles = identityPickerEnabled ? (workspaceM365LinkEnabled ? concat(baseAppRoles, m365WriteAppRole) : baseAppRoles) : []
output requiredAppRoles array = sharepointShortcutsEnabled ? concat(identityRoles, sharepointAppRoles) : identityRoles

output graphBase string = graphBase
output graphScope string = '${graphBase}/.default'
output consentPortalUrl string = consentPortal
output documentOnly bool = skipRoleGrants
output grantScriptHint string = 'CONSOLE_UAMI_PRINCIPAL=${consolePrincipalId} scripts/csa-loom/grant-identity-graph-approles.sh'
