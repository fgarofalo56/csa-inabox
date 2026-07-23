// CSA Loom DLZ — WORKLOAD-TIERED Synapse Spark pools + baked best-practice
// Apache Spark configuration + (optional) Log Analytics application emitter.
//
// WHY (the gap this closes):
//   synapse.bicep deploys ONE interactive Spark pool (`loompool`, Small,
//   autoscale 3-10) with NO Apache Spark configuration. That means:
//     1. Every Spark workload — interactive, ETL, batch, ML — runs on the same
//        Small pool with no workload-appropriate sizing.
//     2. The pool carries no best-practice Spark tuning (AQE, skew-join, Delta
//        optimize-write), so table writes create the small-file problem and
//        skewed joins run cold.
//     3. Spark applications submitted OUTSIDE the console (Spark job definitions,
//        Synapse pipelines, direct Livy) emit NO telemetry to Log Analytics —
//        only console-driven notebook sessions do (the per-session emitter in
//        apps/fiab-console/lib/spark/config-presets.ts). A pool-level
//        `sparkConfigProperties` closes that: every application on the pool emits.
//
//   This module adds the missing WORKLOAD tiers (loometl = Medium ETL,
//   loombatch = Large batch/ML) and bakes the same best-practice confs the UI's
//   compute presets offer (lib/databricks/cluster-presets.ts BASE_CONF+DELTA_CONF
//   and lib/spark/config-presets.ts) directly onto the pool, so pre-provisioned
//   compute matches what the editors hand out. Autopause + autoscale keep idle
//   cost at zero (a paused pool reserves no nodes).
//
// Azure-native / no-Fabric (per .claude/rules/no-fabric-dependency.md): these are
// Synapse Spark pools — the DEFAULT Loom notebook/spark-job backend. No Fabric
// capacity, workspace, or api.fabric.microsoft.com dependency.
//
// Telemetry split (per no-vaporware.md — "bicep where possible + a script for
// the dev-plane"): this module ALWAYS bakes the best-practice confs (no secret,
// deploy-safe) and, when a Log Analytics GUID is supplied, the LA emitter lines
// too. The LA shared KEY is NEVER inlined — it is referenced via a Key Vault
// secret through a Synapse Key Vault linked service. Creating that KV secret +
// linked service is a DEV-PLANE action, done idempotently by
// scripts/csa-loom/wire-spark-telemetry.sh, which then also points the pools at
// them. Default deploy leaves the LA-GUID params empty → pools get the tuning
// confs and the script applies the emitter post-deploy.
//
// Grounded in Microsoft Learn:
//   - Microsoft.Synapse workspaces/bigDataPools (sparkConfigProperties = File +
//     content): https://learn.microsoft.com/azure/templates/microsoft.synapse/workspaces/bigdatapools
//   - Monitor Apache Spark applications with Azure Log Analytics
//     (spark.synapse.logAnalytics.* + Key Vault linked service):
//     https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-azure-log-analytics
//   - Available Apache Spark configurations (uriSuffix: ods.opinsights.azure.us
//     for Azure Government): https://learn.microsoft.com/azure/synapse-analytics/monitor-synapse-analytics-reference
//   - Optimize write on Apache Spark (spark.microsoft.delta.optimizeWrite.enabled):
//     https://learn.microsoft.com/azure/synapse-analytics/spark/optimize-write-for-apache-spark
//   - AQE (adaptive query execution / skew-join / coalesce partitions).

targetScope = 'resourceGroup'

@description('Primary region.')
param location string

@description('Domain segment — the Synapse workspace is syn-loom-<domain>-<location>.')
param domainName string

@description('EXISTING Synapse workspace name. Defaults to the Loom convention (syn-loom-<domain>-<location>); override for a non-standard name.')
param synapseWorkspaceName string = 'syn-loom-${domainName}-${location}'

@description('Compliance tags applied to every pool.')
param complianceTags object

@description('Log Analytics workspace ARM resource id for the pools\' diagnostic settings (BigDataPoolAppsEnded). Empty skips the diagnostic settings (honest gate — same as synapse.bicep).')
param workspaceId string = ''

@description('Apache Spark version. 3.4 is the current GA at time of writing (matches loompool).')
param sparkVersion string = '3.4'

@description('Enable compute isolation on the tiered pools. Required for IL5 (dedicated physical hosts); incurs extra cost. Leave false for Commercial/GCC.')
param sparkPoolIsolatedCompute bool = false

@description('Master switch — deploy the workload-tiered pools. DEFAULT-ON per .claude/rules memory loom_default_on_opt_out (every feature ships enabled; admins opt out).')
param deployWorkloadTiers bool = true

// ── Log Analytics application emitter (optional in bicep; the primary applier is
//    scripts/csa-loom/wire-spark-telemetry.sh, which creates the KV secret + the
//    Synapse KV linked service the emitter references, then updates the pools). ──

@description('Log Analytics workspace GUID (customerId, NOT the ARM id) for the pool-level spark.synapse.logAnalytics emitter. Empty (default) OMITS the emitter lines from the baked config so the pool is deploy-safe; wire-spark-telemetry.sh applies them post-deploy.')
param logAnalyticsWorkspaceGuid string = ''

@description('Key Vault NAME holding the LA shared-key secret, referenced by the Synapse KV linked service. Empty omits the KV lines.')
param logAnalyticsKeyVaultName string = ''

@description('Key Vault secret NAME for the LA shared key. Default SparkLogAnalyticsSecret (the Synapse-documented default).')
param logAnalyticsKeyVaultSecretName string = 'SparkLogAnalyticsSecret'

@description('Synapse Key Vault LINKED-SERVICE name the emitter reads the secret through (created by wire-spark-telemetry.sh). Empty omits the linkedServiceName line — then Synapse falls back to workspace-MSI Key Vault access.')
param logAnalyticsLinkedServiceName string = ''

@description('LA data-collector URI suffix. ods.opinsights.azure.com (Commercial/GCC); ods.opinsights.azure.us (Azure Government / GCC-High / IL5).')
param logAnalyticsUriSuffix string = 'ods.opinsights.azure.com'

// ── OpenLineage listener (loom-next-level L2) — R0 CONFIG BAG (never new
//    scalar top-level params). Same split as the LA emitter above: bicep bakes
//    ONLY the secret-free conf lines, and ONLY when an ingest URL is supplied;
//    the per-pool CREDENTIAL (spark.openlineage.transport.auth.*) is NEVER
//    inlined here — scripts/csa-loom/openlineage-pool-setup.sh mints it,
//    uploads the openlineage-spark listener jar as a Synapse WORKSPACE LIBRARY
//    (required: DEP-enabled workspaces cannot pull from public repos — Learn:
//    apache-spark-azure-create-spark-configuration), and stamps the auth conf.
//    Default {} → zero OL lines (deploy-safe honest gate; the pool-config step
//    is the documented one-time action, per the svc-openlineage Fix-it wizard).
@description('OpenLineage listener config bag: { ingestUrl: string (the in-VNet console ingest URL, e.g. https://loom-console.<cae-domain>/api/lineage/openlineage), namespace: string (default loom) }. Empty (default) omits the OpenLineage conf lines; openlineage-pool-setup.sh applies listener + credential post-deploy.')
param openLineageConfig object = {}

@description('Workload tier definitions. Each object: { name, nodeSize (Small/Medium/Large/XLarge/XXLarge), minNodes (>=3), maxNodes (<=200), autoPauseMinutes }. Sizes are parameterized; autopause stays on for every tier.')
param sparkTiers array = [
  {
    // ETL / medallion transforms — memory-optimized Medium, moderate autoscale.
    name: 'loometl'
    nodeSize: 'Medium'
    minNodes: 3
    maxNodes: 12
    autoPauseMinutes: 15
  }
  {
    // Heavy batch + ML training — Large, wider autoscale for big shuffles.
    name: 'loombatch'
    nodeSize: 'Large'
    minNodes: 3
    maxNodes: 20
    autoPauseMinutes: 15
  }
]

resource synapseWs 'Microsoft.Synapse/workspaces@2021-06-01' existing = {
  name: synapseWorkspaceName
}

// ── Best-practice base confs — mirror of lib/databricks/cluster-presets.ts
//    BASE_CONF + DELTA_CONF and lib/spark/config-presets.ts. AQE on (coalesce +
//    skew-join → no pinned shuffle.partitions), Kryo serializer, and Delta
//    optimize-write. We set BOTH the Synapse-native optimize-write key
//    (spark.microsoft.delta.optimizeWrite.enabled) AND the databricks-namespaced
//    key (spark.databricks.delta.optimizeWrite.enabled, honored by Synapse's
//    bundled Delta) plus auto-compact, so the same conf is correct whether the
//    reader is Synapse Spark or (via the sibling Databricks path) Databricks.
var baseConfLines = [
  'spark.sql.adaptive.enabled true'
  'spark.sql.adaptive.coalescePartitions.enabled true'
  'spark.sql.adaptive.skewJoin.enabled true'
  'spark.serializer org.apache.spark.serializer.KryoSerializer'
  'spark.microsoft.delta.optimizeWrite.enabled true'
  'spark.databricks.delta.optimizeWrite.enabled true'
  'spark.databricks.delta.autoCompact.enabled true'
]

// ── LA emitter lines — appended ONLY when a workspace GUID is supplied. The
//    shared key is referenced via KV (never inlined). Without a KV linked
//    service the workspace MSI reads the KV secret directly.
var laEmitterLines = empty(logAnalyticsWorkspaceGuid) ? [] : concat(
  [
    'spark.synapse.logAnalytics.enabled true'
    'spark.synapse.logAnalytics.workspaceId ${logAnalyticsWorkspaceGuid}'
    'spark.synapse.logAnalytics.uriSuffix ${logAnalyticsUriSuffix}'
  ],
  !empty(logAnalyticsKeyVaultName) ? [
    'spark.synapse.logAnalytics.keyVault.name ${logAnalyticsKeyVaultName}'
    'spark.synapse.logAnalytics.keyVault.key.secret ${logAnalyticsKeyVaultSecretName}'
  ] : [],
  !empty(logAnalyticsLinkedServiceName) ? [
    'spark.synapse.logAnalytics.keyVault.linkedServiceName ${logAnalyticsLinkedServiceName}'
  ] : []
)

// ── OpenLineage listener lines (L2) — appended ONLY when an ingest URL is in
//    the config bag. spark.extraListeners registers the openlineage-spark
//    agent (the jar itself is a workspace library — see openlineage-pool-setup
//    .sh); the http transport posts RunEvents to the Console's IN-VNET ingest
//    route (rev-2 security redesign: never the public Front Door host). The
//    transport auth conf (spark.openlineage.transport.auth.*) is a SECRET and
//    is stamped by the setup script, never baked here.
var openLineageIngestUrl = string(openLineageConfig.?ingestUrl ?? '')
var openLineageLines = empty(openLineageIngestUrl) ? [] : [
  'spark.extraListeners io.openlineage.spark.agent.OpenLineageSparkListener'
  'spark.openlineage.transport.type http'
  'spark.openlineage.transport.url ${openLineageIngestUrl}'
  'spark.openlineage.namespace ${string(openLineageConfig.?namespace ?? 'loom')}'
]

var sparkConfigContent = join(concat(baseConfLines, laEmitterLines, openLineageLines), '\n')

// ── The tiered pools. Auto-pause + autoscale keep idle cost at zero. A dynamic
//    executor allocation window mirrors loompool (min 1 → max nodes-1).
resource pools 'Microsoft.Synapse/workspaces/bigDataPools@2021-06-01' = [for tier in sparkTiers: if (deployWorkloadTiers) {
  parent: synapseWs
  name: tier.name
  location: location
  tags: complianceTags
  properties: {
    nodeSizeFamily: 'MemoryOptimized'
    nodeSize: tier.nodeSize
    nodeCount: tier.minNodes
    autoScale: {
      enabled: true
      minNodeCount: tier.minNodes
      maxNodeCount: tier.maxNodes
    }
    autoPause: {
      enabled: true
      delayInMinutes: tier.?autoPauseMinutes ?? 15
    }
    sparkVersion: sparkVersion
    isComputeIsolationEnabled: sparkPoolIsolatedCompute
    // Session-level packages on (matches loompool) so spark-environment items can
    // bake pip/conda requirements onto the pool on publish.
    sessionLevelPackagesEnabled: true
    dynamicExecutorAllocation: {
      enabled: true
      minExecutors: 1
      maxExecutors: tier.maxNodes - 1
    }
    // Baked best-practice Apache Spark configuration (+ optional LA emitter).
    sparkConfigProperties: {
      configurationType: 'File'
      filename: 'loom-${tier.name}-spark-config.conf'
      content: sparkConfigContent
    }
  }
}]

// ── Pool-level diagnostic settings → standardized Loom LAW. BigDataPoolAppsEnded
//    surfaces one row per ended Spark application (SynapseBigDataPoolApplications
//    Ended). Complements the fine-grained per-application emitter above. Same
//    setting name as every Loom resource; honest gate when no LAW is bound.
resource poolDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = [for (tier, i) in sparkTiers: if (deployWorkloadTiers && !empty(workspaceId)) {
  scope: pools[i]
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'BigDataPoolAppsEnded', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}]

@description('Names of the workload-tiered Spark pools created (empty when deployWorkloadTiers is false).')
output tierPoolNames array = [for tier in sparkTiers: tier.name]

@description('The best-practice Spark configuration content baked onto every tiered pool (for receipts / verification). Secret-free.')
output bakedSparkConfig string = sparkConfigContent
