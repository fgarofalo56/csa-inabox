// CSA Loom — CROSS-SUBSCRIPTION lake grant pass (#3336).
//
// ── THE HOLE THIS FILLS ──────────────────────────────────────────────────────
//
// `modules/admin-plane/main.bicep` is invoked at the ADMIN resource group, in the
// ADMIN subscription. Every lake grant it owns is gated on `loomStorageGrantable`
// = `!empty(loomStorageAccount) && loomStorageAccountSameSub`. On an estate whose
// lake was DISCOVERED in a Data Landing Zone SUBSCRIPTION (the shape
// scripts/csa-loom/discover-dlz-adopt-plan.sh produces, unioned into `adopt` by
// params/commercial.bicepparam), `sameSub` is false and every one of those
// modules skips.
//
// That skip is CORRECT in isolation — a subscription-scoped deployment cannot
// create a role assignment in another subscription, and the alternative is the
// ResourceNotFound / AuthorizationFailed that failed two full Commercial deploys
// on 2026-08-13 (#3333, #3329). What was missing is that NOTHING ELSE PICKED THE
// GRANT UP. The capability was left bound-and-ungranted, or — for the S3 gateway
// — not deployed at all, because `s3GatewayActive` folded the grant condition
// into the DEPLOY condition (#3337).
//
// `platform/fiab/bicep/main.bicep` is `targetScope = 'subscription'` and ALREADY
// deploys modules into other subscriptions (`scope: resourceGroup(subId, rg)` —
// the dlz / dlzAccessPolicyRbac / dlzAppResourcesRbac / dlzItemCreateRbac loops).
// The mechanism existed; it was simply never used for lake grants. This module is
// the named owner it was missing, and the orchestrator invokes it with
//
//     scope: resourceGroup(adoptSub(adopt,'storage-adls'), adoptRg(adopt,'storage-adls'))
//
// so the lake's coordinates come from the ADOPT PLAN — the same document that
// bound `loomStorageAccount` in the first place — rather than a convention.
//
// ── WHY THIS CANNOT BE DEFAULT-ON, AND WHY THAT IS NOT A GATE ────────────────
//
// Submitting a nested deployment into another subscription needs
// `Microsoft.Resources/deployments/write` there, and creating the assignment
// needs `Microsoft.Authorization/roleAssignments/write`. A deploying principal
// that holds neither does not get a skipped grant — it gets AuthorizationFailed,
// and the WHOLE deployment fails. That is precisely the P0 class this repo paid
// for twice on 2026-08-13, so arming this unconditionally would trade one broken
// capability for a broken estate.
//
// The answer is NOT to ask the operator (auto-bind-by-default.md forbids
// user-performed plumbing). It is to MEASURE. The deploy lane runs
// `scripts/csa-loom/probe-lake-grant-rights.mjs` AS THE DEPLOYING IDENTITY
// against ARM's own `Microsoft.Authorization/permissions` endpoint at the lake
// resource group, and passes `crossSubLakeGrantsEnabled` accordingly. The
// customer performs no step; the platform establishes its own rights and acts.
// When the answer is "cannot", this module simply is not deployed — a module
// whose condition is false is not a discarded error (no `|| true`, no
// `2>/dev/null`, no `continue-on-error` anywhere in this path), and the console
// surfaces the honest gate with a Fix-it naming the exact role and scope.
//
// ── WHAT THIS MODULE MAY AND MAY NOT GRANT (read before adding a consumer) ───
//
// ARM rejects a second role assignment for a (scope, principal, roleDefinition)
// TUPLE that already has one, even under a different name — Microsoft's own RBAC
// conditions FAQ states it plainly, and this repo has already paid for it: the
// `adminAppResourcesRbac` leaf in main.bicep "failed RoleAssignmentExists on
// EVERY deploy in BOTH topologies" until it was collision-gated.
//
// A cross-sub pass is MORE exposed to that than a same-sub one, because the lake
// subscription is exactly where an estate accumulates out-of-band grants. MEASURED
// on the live Commercial estate 2026-08-13: the Console UAMI already holds Storage
// Blob Data Contributor on `saloomdefault…`, created 2026-06-18 by an imperative
// step — NOT by bicep, which has never been able to make that grant here. Adding
// the Console UAMI to this pass would therefore have re-created an existing tuple
// under a `guid()`-derived name and FAILED THE DEPLOYMENT on the very estate the
// change is meant to fix.
//
// So this pass grants ONLY identities THE DEPLOYMENT ITSELF CREATES. The S3
// gateway's dedicated `uami-loom-s3gw-<location>` (data-plane/s3-gateway-aca.bicep)
// is minted by the same deployment run, so it cannot carry a pre-existing
// assignment and a collision is STRUCTURALLY impossible, not merely unobserved.
// Verified on the live estate: no `loom-s3-gateway` container app and no
// `uami-loom-s3gw-*` identity exist, while 28 other Loom apps run.
//
// ANY consumer added here MUST satisfy that property, or must first establish
// that no equivalent assignment exists — a pre-existing tuple is a deployment
// failure, not a no-op. Grants for LONG-LIVED shared identities (the Console
// UAMI above all) belong in a child story of #3336 that deals with reconciliation
// explicitly; they are deliberately NOT in this pass.

targetScope = 'resourceGroup'

@description('ADLS Gen2 lake account. MUST exist in THIS module\'s resource group / subscription — the caller supplies both via `scope: resourceGroup(<lakeSub>, <lakeRg>)`, read from the adopt plan\'s storage-adls target.')
param storageAccountName string

@description('PRINCIPAL (object) id of the S3 gateway\'s DEDICATED storage identity — data-plane/s3-gateway-aca.bicep\'s `storageUamiPrincipalId`, surfaced by admin-plane as `s3GatewayStorageUamiPrincipalId`. Empty skips the grant (the gateway did not deploy on this run), which is a no-op and never an error.')
param s3GatewayPrincipalId string = ''

@description('Set false to skip every grant in this pass when an estate assigns lake roles out-of-band (a PIM-managed process). The gateway then serves 403s until that grant lands — fail-closed by design, and the console honest-gates rather than presenting a wired URL that cannot read a bucket.')
param assignRoles bool = true

// Storage Blob Data Reader — READ only, and the exact role
// data-plane/s3-gateway-lake-rbac.bicep grants on the same-subscription path.
// The built-in id is cloud-invariant, so this resolves identically in Commercial
// and in every Gov boundary (cloud-parity.md).
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

var grantS3Gateway = assignRoles && !empty(storageAccountName) && !empty(s3GatewayPrincipalId)
var anyGrant = grantS3Gateway

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (anyGrant) {
  name: empty(storageAccountName) ? 'placeholderaccount' : storageAccountName
}

// Deterministic guid over (scope, principal, role) — the SAME expression
// s3-gateway-lake-rbac.bicep uses, so if this estate later becomes same-sub the
// two passes converge on ONE assignment instead of racing to create two.
resource s3GatewayLakeRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantS3Gateway) {
  name: guid(lake.id, s3GatewayPrincipalId, storageBlobDataReaderRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: s3GatewayPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('TRUE when the S3 gateway\'s Storage Blob Data Reader grant was actually applied by this pass.')
output s3GatewayGranted bool = grantS3Gateway

@description('Number of role assignments this pass applied. 0 means every consumer was empty or assignRoles was false — a deliberate skip, never a swallowed failure.')
output grantsApplied int = grantS3Gateway ? 1 : 0

@description('Role the S3 gateway identity holds on the lake. READER — never Contributor.')
output s3GatewayRoleDefinitionId string = storageBlobDataReaderRoleId
