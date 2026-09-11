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
//
// ── #3338 ASKED FOR EXACTLY THAT, AND IT IS REFUSED HERE (2026-09-07) ────────
//
// #3338 ("transform-runner is bound but not granted — artifact writes will
// 403") proposes threading `adminPlane.outputs.uamiConsolePrincipalId` in and
// adding a Storage Blob Data Contributor (ba92f5b4-…) assignment for it. That is
// the Console UAMI — precisely the long-lived shared identity the paragraph
// above excludes, at precisely the role and scope the 2026-08-13 measurement
// recorded above as ALREADY ASSIGNED out-of-band on the live Commercial lake.
// Taking it would trade an unreachable 403 for a RoleAssignmentExists that fails
// the whole deployment: the #3329 / #3333 P0 class this file exists to avoid.
// The repo has paid for that shape three times already, cited by SYMBOL because
// line numbers rot (an earlier revision of this header cited
// admin-plane/main.bicep:9095 and this file's own sibling diff moved that line):
// main.bicep's `adminAppResourcesRbac` gating note (the app-resources leaf
// "failed RoleAssignmentExists on EVERY deploy in BOTH topologies"),
// main.bicep's monitoring-reader-rbac `digestPrincipalId: ''` note, and
// admin-plane/main.bicep's note on the REMOVED `reportSubscriptionsPrincipalId`
// output.
//
// It is refused on a second, independent ground: the 403 is not reachable at
// head, so the grant would enable nothing while risking the estate. Measured
// 2026-09-07 in apps/loom-transform-runner — `requirements.txt` pulls no
// `azure-storage-*` package, `LOOM_TRANSFORM_ARTIFACTS_ACCOUNT` has no reader
// anywhere in the repo, and every endpoint in `app/main.py` runs inside a
// `tempfile.TemporaryDirectory` and returns target/manifest.json inline. There
// is no write to 403 on. #3338's real acceptance criterion is an
// artifact-persistence path in that app, which does not exist yet.
//
// Five guards in scripts/ci/__tests__/module-existing-scope.test.mjs hold the
// line. GUARDS 1-4 are keyed to an INVENTORY of this file and its call site;
// GUARD 5 is keyed to an INVARIANT of the DEPLOYMENT and does not name this file
// at all. Four earlier revisions each lost to one edit — revision 1 keyed the
// refusal to param NAMES (`/PrincipalId$/`), so the identical Console-UAMI grant
// under `consoleUamiObjectId` read green; revision 2 keyed it to a
// `principalId:` at exactly four spaces inside a top-level `resource`, so an
// inline `properties: { … }` and a grant delegated to a child module both read
// green while compiling to the same ARM; revision 3 keyed everything to
// declarations IN THIS FILE, so a reviewer left the file untouched and swapped
// what main.bicep BINDS to it — one line at the call site made this pass grant
// the Console UAMI with every guard green (measured 2026-09-09: the parent
// commit's suite passed 35/35 on that mutation applied to the real main.bicep);
// revision 4 added the call site but stayed keyed to THIS FILENAME and to the
// 185 `.bicep` under platform/fiab/bicep, so a reviewer simply added a FILE —
// a 25-line sibling granting the Console UAMI Storage Blob Data Contributor on
// the same lake, invoked at the same scope — and every guard was green again
// (re-measured 2026-09-11 against the real shipped tree: revision 4's suite
// rc 0, 40/40; `az bicep build` rc 0, 3,984,293 bytes, with the Contributor
// grant readable in the emitted ARM under `[variables('lakeAdoptSub')]`).
// Enumerating one more syntax would only move the next escape, so the key is now
// the three bicep KEYWORDS that must begin a statement and that no layout can
// hide, plus the call site's ARGUMENTS, plus a fifth key that is not a filename
// at all:
//
//   GUARD 1 — every `param` this file declares is in PASS_PARAM_REGISTER with a
//     `kind` and a reason. A `principal` param must reach the `principalId` of a
//     real role assignment; a `config` param must not. Adding ANY param under
//     ANY name, referenced or not, is RED until a reviewer registers it — which
//     is the half-applied form of #3338's fix (param threaded, assignment
//     forgotten), including the form that is referenced by a `!empty(...)`
//     grant-gate var and a counted output.
//   GUARD 2 — every `resource` and `module` this file declares is in
//     PASS_BODY_REGISTER, every principal that actually reaches a `principalId`
//     is on a self-minted allowlist with a measured reason, and every role
//     definition GUID reachable inside a roleAssignments declaration is in
//     PASS_GRANTED_ROLES. The inventory half is what closes the inline-object,
//     `[for]`-loop and delegated-module forms together instead of one at a time;
//     the role half is what closes a one-token Reader→Contributor swap, which
//     adds no declaration at all and would falsify this file's own
//     `s3GatewayRoleDefinitionId` @description.
//   GUARD 3 — only modules whose grant this pass OWNS may gate their deploy on
//     `loomStorageWillBeGranted`.
//   GUARD 4 — this pass has exactly ONE call site in the WHOLE REPOSITORY (every
//     tracked `.bicep` — 357 of them at this commit, not the 185 under
//     platform/fiab/bicep, and including the `= [for … : {` declaration form),
//     that call site's
//     `scope:` is registered, every argument bound to it is registered, and each
//     `principal` argument is traced hop by hop — main.bicep's expression, the
//     admin-plane output behind it, the minting module's output behind that — to
//     a `userAssignedIdentities` resource s3-gateway-aca.bicep DECLARES rather
//     than adopts. That terminal check is the structural form of "minted by this
//     run", so it cannot be satisfied by renaming.
//
//     Revision 1 of this guard claimed that sentence while measuring only
//     `main.bicep`, through a module regex that could not parse a loop header. A
//     reviewer beat it twice, both compiling and both 39/39 GREEN: a second call
//     site in `modules/admin-plane/main.bicep` (where the sibling lake-RBAC
//     delegations already live), and a second call site in `main.bicep` itself
//     written as `= [for … : {`. Revision 2 then read 185 files and a reviewer
//     beat it a third time from OUTSIDE that tree: `deploy/bicep/gov/main.bicep`,
//     which `.github/workflows/deploy-gov.yml` builds and deploys, and which
//     cloud-parity.md makes the likeliest home for a boundary-specific grant
//     (measured 2026-09-11: revision 2's suite rc 0, 40/40 GREEN; `az bicep
//     build` of the mutated Gov orchestrator rc 0, 126,243 bytes). The
//     population is now the repository, proved complete against
//     `git ls-files '*.bicep'` rather than against a directory list.
//
//   GUARD 5 — and the fifth key is not this file's name. Every module call site
//     ANYWHERE in the repository whose `scope:` deploys into ANOTHER
//     SUBSCRIPTION — a two-argument `resourceGroup()`, a `subscription(<id>)`,
//     a `managementGroup()` — must be registered by (file, symbol, target), and
//     every `Microsoft.Authorization/roleAssignments` REACHABLE from a call site
//     at this pass's own lake scope, through the target module and the modules
//     it in turn calls, must satisfy the SAME self-minted-principal and
//     registered-role checks GUARD 2 applies here. That is the population key
//     GUARDS 1-4 lacked: a new FILE that grants on this lake cannot avoid being
//     deployed at this lake's scope, so it cannot avoid the register. Measured
//     at this commit: 123 cross-subscription call sites across all 357 `.bicep`,
//     112 of them in the vendored Azure Landing Zones tree (exempt, and the
//     exemption is re-measured in-suite to prove that tree references neither
//     this pass nor the lake's adopt symbols), 11 of them Loom's own and each
//     registered with a reason.
//
// WHAT THAT DOES NOT CLAIM. It is source analysis over this file, the
// repository's module declarations, and the three call-chain hops named above,
// not an assertion about the compiled ARM — only `az bicep build` over this pass
// could make that one, and it is not run from node:test. Nor is it a claim about
// every route by which this pass could come to grant something else: the chain's
// registration stops at s3-gateway-aca.bicep's `storageIdentity` declaration,
// and a change INSIDE that module that made the symbol resolve to a pre-existing
// identity while keeping the `= {` form is outside what the guards read. The
// call-site reader is line-oriented, so a declaration whose `{` is not on the
// `module` line, or whose loop header itself contains a `:`, fails to match and
// is not recorded — fail-CLOSED for the reader, but it means "one call site" is
// a statement about declarations this reader can parse. GUARD 5's population key
// is the SCOPE EXPRESSION AS WRITTEN, so a grant that reached this lake's
// resource group without a two-argument `resourceGroup(...)` — from an
// orchestrator already running inside the lake's subscription — is outside it;
// that is not reachable from today's subscription-scoped `main.bicep`, which is
// the whole reason this pass exists, but it is stated rather than implied
// closed. `check-module-existing-scope.mjs`, the shipped checker, still walks
// only platform/fiab/bicep and is blind to both of the 2026-09-11 bypasses
// (rc 0, no NEW finding, on each) — its invariant is #3333's cross-RG residency,
// not this one, and widening it is a separate change with its own measurement.
// What IS checkable, and is checked: no new param, resource or module can enter
// this file, no different role can be granted from it, no second call site or
// different bound value or call-site scope can appear anywhere in the
// repository, and no new module can be deployed into this lake's subscription at
// all, without a reviewer registering the change.

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
