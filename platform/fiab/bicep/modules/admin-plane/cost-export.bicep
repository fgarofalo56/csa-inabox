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
// by another lane and sits at 238 of the 256 ARM parameter ceiling
// (`csa_loom_build_gate_bicep_param_cap`), so adding six invocations there is a
// change that lane must make, not this one. The invocation is documented below
// and is a single line.
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
// deployed to Azure Government, and the Gov ARM plane's acceptance of the
// `2023-08-01` API version was not checked — this workstation authenticates to
// a different tenant and never runs `az` against Gov. Verify from an
// in-boundary GitHub Actions runner before claiming Gov parity:
//
//   az provider show -n Microsoft.CostManagement \
//     --query "resourceTypes[?resourceType=='exports'].apiVersions" -o tsv
//
// If `2023-08-01` is absent there, pin an older version listed by that call.
// The API version must be a literal in Bicep, so it cannot be parameterised.
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

@description('First day the schedule may run. MUST be in the future or Cost Management rejects the export, so the default is tomorrow rather than a hard-coded date that goes stale and fails a redeploy months later.')
param scheduleStartUtc string = dateTimeAdd(utcNow('yyyy-MM-ddT00:00:00Z'), 'P1D', 'yyyy-MM-ddT00:00:00Z')

@description('Last day the schedule may run. Default is ten years out; Cost Management requires an end date after the start date.')
param scheduleEndUtc string = dateTimeAdd(utcNow('yyyy-MM-ddT00:00:00Z'), 'P10Y', 'yyyy-MM-ddT00:00:00Z')

@description('Set false to provision the export in a paused state (schedule status Inactive) without deleting it. Honours the estate pause/resume mandate: a paused estate should not be generating daily exports it will not read.')
param scheduleActive bool = true

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
  location: 'global'
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
    schedule: {
      status: scheduleActive ? 'Active' : 'Inactive'
      recurrence: 'Daily'
      recurrencePeriod: {
        from: scheduleStartUtc
        to: scheduleEndUtc
      }
    }
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

@description('First data is expected roughly 24 hours after the first scheduled run. Until then the Brain cost layer reports DERIVED figures, labelled as estimates - it does NOT report $0.00.')
output firstDataExpectedUtc string = dateTimeAdd(scheduleStartUtc, 'P1D', 'yyyy-MM-ddTHH:mm:ssZ')
