// =====================================================================
// CSA Loom — SharePoint / OneDrive shortcut Graph AppRole documentation module
// =====================================================================
//
// SharePoint Online + OneDrive for Business shortcut sources resolve through
// the Microsoft Graph drives API on the Console UAMI's application token. Graph
// AppRoles (Entra application permissions) cannot be granted via ARM/Bicep —
// they require a POST to
//   /v1.0/servicePrincipals/{uamiOid}/appRoleAssignments
// on the Microsoft Graph API. This module therefore DOCUMENTS the required
// grants (as deterministic outputs the post-deploy bootstrap reads) and is
// invoked from admin-plane/main.bicep when loomSharePointShortcutsEnabled = true.
//
// The actual grant is performed by:
//   scripts/csa-loom/grant-sharepoint-graph-approles.sh
// followed by a Tenant Admin issuing admin consent in
//   Entra ID -> Enterprise applications -> Console UAMI -> Permissions.
//
// Required AppRoles on the Console UAMI (Microsoft Graph, type=Role):
//   Sites.Read.All  332a536c-c7ef-4017-ab91-336970924f0d
//   Files.Read.All  01d4889c-1287-42c6-ac1f-5d1e02578ef6
//
// Until consented, /api/lakehouse/shortcuts/sharepoint returns 503 with the
// exact remediation and the wizard renders its honest-gate MessageBar (per
// no-vaporware.md / ui-parity.md). No mock data is ever returned. ADLS Gen2 and
// internal Loom lakehouse shortcuts need none of this.

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
  { name: 'Sites.Read.All', appRoleId: '332a536c-c7ef-4017-ab91-336970924f0d', reason: 'Search SharePoint sites and list their document libraries (drives).' }
  { name: 'Files.Read.All', appRoleId: '01d4889c-1287-42c6-ac1f-5d1e02578ef6', reason: 'List and read SharePoint / OneDrive drive items (folders and files).' }
]

output graphBase string = graphBase
output graphScope string = '${graphBase}/.default'
output consentPortalUrl string = consentPortal
output documentOnly bool = skipRoleGrants
output grantScriptHint string = 'CONSOLE_UAMI_PRINCIPAL=${consolePrincipalId} scripts/csa-loom/grant-sharepoint-graph-approles.sh'
