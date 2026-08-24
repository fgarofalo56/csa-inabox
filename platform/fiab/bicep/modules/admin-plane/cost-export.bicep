// CSA Loom — Cost Management EXPORT to storage, for the Loom Brain cost layer.
//
// ── WHY AN EXPORT AND NOT THE API ──────────────────────────────────────────
// PRP §1 decision 3 (PRPs/active/loom-brain/PRP.md): real cost comes from a
// Cost Management export to storage, NOT the live query API. Measured
// 2026-08-23: `Microsoft.CostManagement/query` returned HTTP 429 on ELEVEN
// consecutive attempts over ~35 minutes across the operator's subscriptions, so
// every dollar figure the Brain has produced to date is DERIVED (a measured SKU
// multiplied by a published list rate) rather than billed. This module is what
// makes a `billed` figure possible at all.
//
// The reader for what this drops in the container is
// `apps/fiab-console/lib/brain/cost/export-reader.ts`.
//
// ── NOT WIRED INTO THE ORCHESTRATOR, DELIBERATELY ──────────────────────────
// This module is NOT invoked from `admin-plane/main.bicep`. That file is owned
// by another lane and sits at 239 of the 256 ARM parameter ceiling
// (`csa_loom_build_gate_bicep_param_cap`), so adding six invocations there is a
// change that lane must make, not this one. The invocation is documented below
// and is a single line.
//
// 239 is measured, not remembered: `grep -c '^param '
// platform/fiab/bicep/modules/admin-plane/main.bicep` returns 239 on
// origin/main AND on this branch. An earlier revision of this header said 238,
// a number copied out of the #3291 allowlist note, which measured a DIFFERENT
// tree at a different time. 17 of headroom, not 18.
//
// ── LATENCY: THIS IS A DAILY DROP, NOT A LIVE FEED ─────────────────────────
// A daily export runs once a day and its FIRST data lands roughly 24 hours
// after the export is created. Microsoft additionally documents that a brand-new
// subscription can take up to 48 hours before Cost Management returns anything.
// Until then the Brain's cost layer degrades to DERIVED figures, labelled as
// such — see `lib/brain/cost/attribute.ts` (D1). Nothing here should be
// described as current spend; `CostExportRead.asOf` carries which run a figure
// came from.
//
// ── ALL SIX SUBSCRIPTIONS: SIX DEPLOYMENTS, NOT ONE ────────────────────────
// PRP §1 decision 4: reports cover ALL subscriptions. A `Microsoft.CostManagement/exports`
// resource is scoped to ONE billing scope, so covering the estate means
// deploying this module once per subscription:
//
//   for SUB in <the six subscription ids>; do
//     az deployment sub create --subscription "$SUB" --location centralus \
//       --template-file platform/fiab/bicep/modules/admin-plane/cost-export.bicep \
//       --parameters storageAccountResourceId=<sa-resource-id> containerName=loom-brain-cost
//   done
//
// A management-group scope would cover several subscriptions in one export, and
// it is DELIBERATELY not the default, because Microsoft documents three
// restrictions that each silently degrade the data:
//   * management-group scope is Enterprise Agreement ONLY (not MCA, not MPA);
//   * FOCUS is NOT supported at management-group scope;
//   * management-group exports carry USAGE charges only — purchases,
//     reservations and savings plans are absent, and amortized cost is
//     unsupported — and multiple currencies are not supported.
// Silently losing reservation spend from a cost report is the kind of confident
// partial measurement this program exists to stop, so the portable
// per-subscription path is the default and the MG path is left to an operator
// who has read the trade.
//
// ── CLOUD PARITY (cloud-parity.md) ─────────────────────────────────────────
// Nothing in this module is cloud-specific: no endpoint, no hostname, no
// region-gated SKU. Cost Management is supported in Azure Government on
// management.usgovcloudapi.net, and the same template applies there.
//
// WHAT IS NOT VERIFIED, stated rather than implied: this module has NOT been
// deployed to ANY cloud. Not Azure Government, and not Commercial either.
// Nothing in this file has run against a live estate and no export has ever
// been provisioned from it. The only thing established locally is that it
// COMPILES — `az bicep build --file <this file>`, RC=0, Bicep CLI 0.45.15.
// An earlier revision scoped this paragraph to Gov alone, which IMPLIED
// Commercial had been verified; it had not. `deploy-integrity.md` R4 verifies
// each boundary independently, so neither cloud inherits the other's receipt,
// and there is no receipt for either.
//
// Gov carries one ADDITIONAL unchecked item on top of that: whether the Gov ARM
// plane accepts the `2023-08-01` API version. It was not checked, because this
// workstation authenticates to a different tenant and never runs `az` against
// Gov. Check it from an in-boundary GitHub Actions runner before claiming Gov
// parity:
//
//   az provider show -n Microsoft.CostManagement \
//     --query "resourceTypes[?resourceType=='exports'].apiVersions" -o tsv
//
// If `2023-08-01` is absent there, pin an older version listed by that call.
// The API version must be a literal in Bicep, so it cannot be parameterised.
//
// ── `location` IS THE IDENTITY'S LOCATION, AND ITS VALUE IS UNVALIDATED ────
// Learn's generated reference for `Microsoft.CostManagement/exports@2023-08-01`
// documents `location` as "The location of the Export's managed identity. Only
// required when utilizing managed identity." This module DOES declare a
// system-assigned identity, so the field applies to it — it is NOT the region
// of the exported data, which has no region.
//
// What is NOT established is whether `'global'`, the value this module sends,
// is accepted for that identity. Learn gives the field's MEANING and its type
// (`string`) but enumerates no allowed values; the only official sample on that
// page — the AzAPI Terraform one — declares neither `identity` nor `location`,
// so it demonstrates no value either; and a Learn code-sample search turned up
// no Cost Management export that sets both. So this is recorded as UNKNOWN,
// not as correct and not as broken, and it is exposed as the
// `identityLocation` parameter so a deployment can correct it without a code
// change. The first real deployment settles it. Nothing short of that will.
//
// ── TWO MORE DATASET FIELDS THAT THE 2023-08-01 SCHEMA MAY NOT ACCEPT ──────
// Recorded here because they are the same class of risk — untested against a
// live plane — and because a reader should not infer from silence that they
// were checked. Measured against Learn's generated reference for 2023-08-01:
//   * `ExportDefinition.type` is listed as 'ActualCost' | 'AmortizedCost' |
//     'Usage'. **'FocusCost' is NOT in that list**, yet `exportType` below
//     offers it. FocusCost appears in the 2023-07-01-preview schema.
//   * `ExportDatasetConfiguration` for 2023-08-01 lists only `columns`.
//     **`dataVersion` is NOT a member**, yet the `datasetConfiguration` var
//     below emits it. `dataVersion` also appears only in 2023-07-01-preview.
// Neither has been sent to ARM, so neither is asserted to fail — Learn's
// generated tables are the evidence, not a rejection anyone has observed. The
// defaults (`ActualCost`, empty `dataVersion`) avoid both fields entirely, so
// the default path is unaffected. Settle these with the same first deployment
// that settles `identityLocation`; if the API rejects them, the fix is the
// preview api-version, which is a separate decision from this module's shape.
//
// ── RECOMMEND-ONLY (PRP §1 decision 1) ─────────────────────────────────────
// This module CREATES a read-only reporting artifact. It does not scale, stop
// or delete anything, and the Brain that consumes its output only ever proposes.

targetScope = 'subscription'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Name of the export within this subscription scope. Must be unique per scope.')
@minLength(3)
@maxLength(64)
param exportName string = 'loom-brain-cost-daily'

@description('Resource id of the storage account the export is delivered to. The account may live in any resource group or subscription the deployment identity can reach.')
param storageAccountResourceId string

@description('Blob container for the export. Cost Management CREATES it if it does not exist, so no container resource is declared here.')
@minLength(3)
@maxLength(63)
param containerName string = 'loom-brain-cost'

@description('Folder prefix inside the container. Keeping each subscription in its own folder means one reader pass never mixes two billing scopes.')
param rootFolderPath string = 'exports'

@description('Dataset. ActualCost is supported on every agreement type and is the safe default. FocusCost is the FinOps Open Cost and Usage Specification format and is NOT supported at management-group scope. AmortizedCost spreads reservation and savings-plan purchases.')
@allowed([
  'ActualCost'
  'AmortizedCost'
  'FocusCost'
])
param exportType string = 'ActualCost'

@description('Dataset schema version. Only meaningful for FocusCost (e.g. \'1.0\'). Leave empty for ActualCost / AmortizedCost so no configuration block is emitted.')
param dataVersion string = ''

// ── WHY THE SCHEDULE WINDOW DEFAULTS TO EMPTY AND NOT TO A DATE ────────────
// These two used to default to `dateTimeAdd(utcNow(...), 'P1D' / 'P10Y', ...)`.
// That is the rotator shape (`csa_loom_bicep_newguid_is_a_rotator`): `utcNow()`
// re-evaluates on EVERY deployment that does not pass the parameter, so the
// recurrencePeriod moved each time, the export registered as CHANGED on every
// redeploy, and a what-if over this module could never come back clean.
//
// That rotator was ALSO cited as reason (3) in this module's orphan-allowlist
// entry (`scripts/ci/check-bicep-sync.mjs`) for keeping it out of the
// orchestrator — the module was being held unwired to avoid drift the module
// itself was manufacturing. THE FIX FOR A ROTATOR IS TO STOP ROTATING, NOT TO
// STAY UNWIRED. Reason (3) is now obsolete and that entry's text needs the
// matching correction; it lives in a file this lane does not own, so it is
// tracked alongside the wire-vs-out-of-band decision in #3965. Reasons (1)
// one-billing-scope-per-export and (2) BCP139 on the cross-RG blob grant are
// structural, unaffected by this change, and still stand on their own.
//
// Empty is a real default rather than a punt. `recurrencePeriod` is OPTIONAL on
// `ExportSchedule` in the 2023-08-01 schema — Learn marks `definition` and
// `deliveryInfo` `(required)` and does NOT mark `recurrencePeriod` — so leaving
// both empty emits a daily schedule with no window at all, and a property that
// is never sent cannot drift. A hard-coded literal was rejected for the
// opposite failure: it does not rotate, but Learn also says of this block "The
// start date must be in future", so a literal goes stale and starts FAILING
// redeploys once its date passes. Empty has neither failure mode.
//
// Both shapes are UNEXERCISED against a live plane — see the WHAT IS NOT
// VERIFIED block in the header. What changed here is drift behaviour, which is
// determined by the template and is therefore checkable without a deployment;
// acceptance is not, and is not claimed.

@description('OPTIONAL start of a bounded recurrence window, UTC (e.g. \'2026-09-01T00:00:00Z\'). EMPTY — the default — omits recurrencePeriod entirely and the export simply recurs daily. When set it MUST be in the future, per Learn on ExportSchedule.recurrencePeriod, and it MUST be a stable value: passing a freshly computed date on each deploy re-introduces the rotator this default exists to remove.')
param scheduleStartUtc string = ''

@description('OPTIONAL end of the bounded recurrence window, UTC. Read only when scheduleStartUtc is set, and must be later than it. Empty emits a window with a start and no end, which the 2023-08-01 schema allows: ExportRecurrencePeriod.from is required, .to is not.')
param scheduleEndUtc string = ''

@description('Set false to provision the export in a paused state (schedule status Inactive) without deleting it. Honours the estate pause/resume mandate: a paused estate should not be generating daily exports it will not read.')
param scheduleActive bool = true

@description('Location recorded for the export\'s SYSTEM-ASSIGNED IDENTITY — NOT a region for the exported data, which has none. Parameterised because the correct value here is UNVALIDATED (see the header): it is exposed so a deployment can correct it without a code change. Default preserves the value this module has always sent.')
param identityLocation string = 'global'

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

// Storage Blob Data Contributor. The GUID is identical across all clouds
// (Commercial / GCC / GCC-High / IL5 / DoD) - same convention as the sibling
// module admin-plane/cost-management-reader-rbac.bicep. Emitted in the
// remediation output below; see the note on the blob-write grant.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// FocusCost carries a dataset schema version; the other types do not, and
// emitting an empty configuration block on them is rejected.
var datasetConfiguration = empty(dataVersion) ? {} : {
  configuration: {
    dataVersion: dataVersion
  }
}

// recurrencePeriod is emitted ONLY when a bounded window was actually asked
// for. Same union()-an-empty-object shape as datasetConfiguration above, and
// for the same reason: a key present with an unusable value is worse than a key
// that is absent, and `from: ''` is not a date. Both branches are object
// literals, so nothing here depends on whether ARM's if() short-circuits.
var recurrencePeriodBlock = empty(scheduleStartUtc) ? {} : {
  recurrencePeriod: union({
    from: scheduleStartUtc
  }, empty(scheduleEndUtc) ? {} : {
    to: scheduleEndUtc
  })
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

// partitionData is TRUE, and the reader depends on it. Azure partitions large
// exports regardless and documents that partitioning cannot be disabled in the
// current experience; with partitioning on, every run also writes a
// manifest.json listing its partitions. That manifest is the ONLY way
// `export-reader.ts` can establish it read the WHOLE run rather than a subset -
// without it the read reports completeness 'unknown', never 'complete'.
resource costExport 'Microsoft.CostManagement/exports@2023-08-01' = {
  name: exportName
  identity: {
    type: 'SystemAssigned'
  }
  location: identityLocation
  properties: {
    format: 'Csv'
    partitionData: true
    definition: {
      type: exportType
      timeframe: 'MonthToDate'
      dataSet: union({
        granularity: 'Daily'
      }, datasetConfiguration)
    }
    deliveryInfo: {
      destination: {
        resourceId: storageAccountResourceId
        container: containerName
        rootFolderPath: rootFolderPath
      }
    }
    schedule: union({
      status: scheduleActive ? 'Active' : 'Inactive'
      recurrence: 'Daily'
    }, recurrencePeriodBlock)
  }
}

// ---------------------------------------------------------------------------
// Write access for the export's managed identity — WHY IT IS NOT INLINE HERE
// ---------------------------------------------------------------------------
//
// The export writes to the container as its own system-assigned identity
// (declared above), and a storage account behind a firewall requires that
// identity to hold Storage Blob Data Contributor on the account. Under
// auto-bind-by-default.md the platform should perform that grant rather than
// ask an operator to.
//
// It is NOT declared here, and the reason is structural rather than a
// preference: a `Microsoft.Authorization/roleAssignments` scoped to a storage
// account in a DIFFERENT resource group cannot be declared in a
// subscription-scoped Bicep file. Measured - the attempt fails at compile time:
//
//   BCP139: A resource's scope must match the scope of the Bicep file for it to
//           be deployable. You must use modules to deploy resources to a
//           different scope.
//
// A module means a second .bicep file, and the cross-subscription case is the
// NORMAL one here: one central container receiving exports from six different
// subscriptions puts the storage account outside the subscription each export
// is scoped to. So the grant belongs alongside the orchestrator invocation, in
// the lane that owns `admin-plane/main.bicep`, not in this module.
//
// `blobWriteGrantCommand` below emits the exact command, already filled in, so
// the follow-on is a copy-paste rather than a research task. This is a NAMED
// GAP, not a silent one.
//
// It is frequently unnecessary in practice: Azure creates the export's
// system-assigned identity and wires its storage access automatically when the
// deploying principal holds `Microsoft.Authorization/roleAssignments/write` on
// the storage account. The grant below is the belt to that braces, and it is
// what makes a firewalled account work.

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('Resource id of the export.')
output exportResourceId string = costExport.id

@description('Export name, echoed so the reader can be pointed at the right folder.')
output exportNameOut string = exportName

@description('Container the reader should enumerate.')
output containerNameOut string = containerName

@description('Folder prefix within the container. The reader lists <container>/<rootFolderPath>/... and MUST read every partition named by each run\'s manifest.json.')
output rootFolderPathOut string = rootFolderPath

@description('Principal id of the export\'s system-assigned identity.')
output exportPrincipalId string = costExport.identity.principalId

@description('The blob-write grant this module cannot declare inline (BCP139 - see the note above). Ready to run as-is.')
output blobWriteGrantCommand string = 'az role assignment create --assignee-object-id ${costExport.identity.principalId} --assignee-principal-type ServicePrincipal --role ${storageBlobDataContributorRoleId} --scope ${storageAccountResourceId}'

@description('The recurrence-window start this deployment set, or EMPTY when no bounded window was requested (the default) and the export therefore recurs daily with no recurrencePeriod. EMPTY here means "no window was configured" — it is not a date, and a caller must not render it as one.')
output scheduleStartUtcOut string = scheduleStartUtc

// `firstDataExpectedUtc` was here. REMOVED with the rotator, for two reasons.
// (1) It computed `dateTimeAdd(scheduleStartUtc, 'P1D', ...)`, which has no
// defined result now that the default start is empty. (2) It asserted a precise
// delivery timestamp that Microsoft does not promise — the documented shape is
// "roughly 24 hours" after the first run, and up to 48 hours on a brand-new
// subscription — so it stated as fact something this template never
// established (deploy-integrity.md R7). The latency itself is not lost: it is
// described in the LATENCY block in the header, and the Brain surfaces it at
// read time from `CostExportRead.asOf` rather than from a predicted date.
// Nothing consumed the output — `git grep firstDataExpectedUtc` returned this
// file and nothing else — so no caller breaks.
