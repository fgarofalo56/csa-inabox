// Microsoft Purview - ADOPT an account the tenant already owns
//
// WHY THIS MODULE EXISTS (deploy-integrity.md R5)
// ----------------------------------------------
// `modules/purview.bicep` CREATES an account. Until this module existed the Gov
// orchestrator had no other option, so `deployDMLZ=true` always meant "make a
// new Purview" — and R5 forbids both halves of what that produced:
//
//   "Silently deploying a second Purview next to the customer's existing one is
//    a violation. So is failing because one exists."
//
// Purview account quota is per-TENANT per-REGION and is 5. Measured on
// deploy-gov.yml run 31917112453 (gov-dev, usgovvirginia, what_if=true — the
// first run of that workflow ever to authenticate, see #3576):
//
//   2005 - The Tenant *** with 5 resources has surpassed its resource quota 5
//          for resource type Account in usgovvirginia location.
//
// A sovereign tenant that already runs Purview is the NORMAL case, so on this
// path "create a new one" was closer to always-broken than occasionally-broken.
//
// WHAT THIS MODULE DOES — AND DELIBERATELY DOES NOT DO
// ---------------------------------------------------
// It BINDS. It is a read-only `existing` reference that resolves the adopted
// account's real coordinates and endpoints from ARM so the orchestrator can
// output them and downstream wiring can use them.
//
// It writes NOTHING to the customer's account. In particular it does NOT attach
// diagnostic settings the way modules/purview.bicep does for an account Loom
// itself created: that is a mutation of a resource Loom does not own, and the
// adoption catalog (apps/fiab-console/lib/deploy/adoption-catalog.ts) declares
// Purview's adoption mutations as data-plane only (sources, a Loom collection,
// scan definitions, glossary + classification rules), applied post-deploy. An
// undeclared control-plane write here would be a mutation the operator was
// never shown on the review step, which R5.2 exists to prevent.

@description('Name of the EXISTING Purview account to adopt. Resolved by the caller from the adopt plan; never constructed from a convention.')
param name string

@description('The region the deployment is targeting. Compared against the adopted account\'s ACTUAL location and surfaced as `regionMatches` so the caller can report a cross-region binding as a fact it measured rather than an assumption.')
param expectedLocation string

// `existing` is a READ. If the named account is not there this fails at
// what-if/validate time with ARM's own not-found, which is the honest outcome —
// and scripts/csa-loom/discover-purview-adopt-plan.sh validates existence
// BEFORE the template is submitted precisely so the operator gets a precise
// message instead of that one (deploy-integrity R6).
resource purview 'Microsoft.Purview/accounts@2021-12-01' existing = {
  name: name
}

output accountId string = purview.id
output accountName string = purview.name

// The account's REAL location, read from ARM — not the region that was asked
// for. Purview's data plane is reached by account host, so a cross-region
// adoption is workable; it is reported, not silently normalised.
output accountLocation string = purview.location

// FALSE is not a failure here, it is a disclosure: the caller renders it so a
// cross-region binding is visible in the deployment outputs instead of being
// discovered later from latency.
output regionMatches bool = toLower(purview.location) == toLower(expectedLocation)

output principalId string = purview.identity.principalId
output catalogEndpoint string = purview.properties.endpoints.catalog
output scanEndpoint string = purview.properties.endpoints.scan
