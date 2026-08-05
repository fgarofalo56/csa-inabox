/**
 * adoption-catalog — the ONE catalog of every Azure backing service CSA Loom can
 * adopt from an existing estate or deploy new.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this module the same question — "which services can Loom reuse, what is
 * each one's ARM type, its bicep enable flag, its EXISTING_* env names, and the
 * role the Console UAMI needs on it" — was answered by SIX divergent tables:
 *
 *   lib/setup/scan-services.ts                      (12 services)
 *   app/api/setup/discover-services/route.ts        (16, its own SERVICES array)
 *   app/api/setup/deploy/route.ts SERVICE_PARAM_MAP (15)
 *   lib/azure/attached-service-kinds.ts             (15 attach kinds — the best of them)
 *   scripts/csa-loom/byo-wizard.sh                  (12)
 *   scripts/csa-loom/scan-and-deploy.sh             (14)
 *
 * They disagreed, and the disagreements shipped. Measured on 2026-08-05:
 *   - `maps`    — the CLI used loomMapsEnabled + EXISTING_AZURE_MAPS_ACCOUNT, the
 *                 console used azureMapsEnabled + EXISTING_AZURE_MAPS. Only the
 *                 first env name was read by any .bicepparam, so the console's
 *                 BYO value was inert.
 *   - `foundry` — the CLI disabled agentFoundryEnabled, the console disabled
 *                 aiFoundryEnabled. main.bicep documents those as INDEPENDENT
 *                 accounts, so the two surfaces suppressed different resources
 *                 for the same "reuse my AOAI" answer.
 *   - the vitest that claimed to pin them "in lockstep" asserted only
 *     `expect(def.enabledFlag).toBeTruthy()` — it compared no name at all, which
 *     is exactly why the drift was invisible.
 *
 * This file is the single source of truth. `scripts/ci/check-adoption-catalog-sync.mjs`
 * byte-compares every field below against `platform/fiab/bicep/main.bicep` and
 * fails the build on any drift.
 *
 * RELATIONSHIP TO attached-service-kinds.ts
 * -----------------------------------------
 * That module stays: it is the day-2 *attach* vocabulary (register an existing
 * resource into a landing zone after Loom is deployed). Its `roleGuid`/`roleName`
 * values are re-exported here verbatim via `attachKind`, so day-0 adoption and
 * day-2 attach grant the SAME role and can never diverge. The guard asserts it.
 *
 * Every backend here is Azure-native (no-fabric-dependency.md). Fabric / Power BI
 * is deliberately absent: it is never scanned, never recommended, never adopted.
 */

import {
  ATTACHED_KIND_DEFS,
  type AttachedServiceKind,
} from '../azure/attached-service-kinds';

/**
 * How the operator's decision for one service is honoured.
 *
 * - `adopt`  — bind Loom to the named existing resource AND suppress the new one.
 * - `create` — deploy a new one (the default for an absent decision).
 * - `skip`   — deploy nothing and bind nothing; the dependent editors honest-gate.
 */
export type AdoptionMode = 'adopt' | 'create' | 'skip';

/**
 * What Loom is allowed to do with a service, decided by us and not by the
 * operator. Rendered in the UI so a locked row always carries its reason.
 *
 * - `adoptable`      — offer adopt or create, freely.
 * - `adopt-required` — a tenant/region singleton exists; "create new" is DISABLED
 *                      with an explanation rather than offered and then failed.
 *                      Purview: a second account fails EnterpriseTenantAlreadyExists.
 * - `reference-only` — Loom only READS the resource; it never creates one and
 *                      never mutates it (Azure SQL under plan-backing-sql.bicep).
 * - `attach-in-place`— adopted through the landing-zone attach path, not by
 *                      suppressing a Loom-created resource.
 * - `create-only`    — Loom always deploys its own. REQUIRES `createOnlyReason`.
 */
export type AdoptionClass =
  | 'adoptable'
  | 'adopt-required'
  | 'reference-only'
  | 'attach-in-place'
  | 'create-only';

/** Drives which family-specific fitness checks run (see lib/deploy/fitness.ts). */
export type ServiceFamily =
  | 'governance'
  | 'search'
  | 'ai'
  | 'analytics'
  | 'lakehouse'
  | 'streaming'
  | 'integration'
  | 'operational-db'
  | 'storage'
  | 'api'
  | 'geo'
  | 'observability'
  | 'network'
  | 'platform';

/** How strict the hub-region match is for this service. */
export type RegionPolicy =
  /** Must sit in the hub region; anything else is unusable. */
  | 'must-match-hub'
  /** Cross-region works but costs latency/egress — warn, do not block. */
  | 'prefer-hub'
  /** The service is global or explicitly supports cross-region (Purview, Maps). */
  | 'any';

/** Declarative inputs to the fitness evaluator. Evaluated, never assumed. */
export interface FitnessSpec {
  /** SKU tier/name values Loom can work against (case-insensitive). Empty = any. */
  allowedSkuTiers?: string[];
  /** SKU tier/name values that are known-unusable, with the reason rendered. */
  forbiddenSkus?: { match: string; why: string }[];
  regionPolicy: RegionPolicy;
  /**
   * Family-specific check ids this service runs, resolved in fitness.ts. Each id
   * maps to a check that states what it OBSERVED, never what it assumed.
   */
  familyChecks: string[];
}

export interface AdoptableServiceDef {
  /** The ONLY identifier, everywhere: plan keys, bicep `adopt` keys, UI, docs. */
  key: string;
  label: string;
  /** Lowercase ARM type for the Resource Graph `type in~ (...)` literal. */
  armType: string;
  /** Case-insensitive ARM `kind` discriminator (AOAI is an AIServices account). */
  armKindFilter?: string;
  /** item-type-visual slug, so rows/tiles reuse the shipped icon registry. */
  tileSlug: string;
  family: ServiceFamily;
  cls: AdoptionClass;
  /** MANDATORY when cls === 'create-only' | 'attach-in-place' | 'reference-only'. */
  createOnlyReason?: string;
  /** A tenant- or region-scoped singleton, which forces `adopt-required`. */
  singleton?: 'tenant' | 'region';
  /** The bicep param that enables provisioning at all (opt-out toggle). */
  enableFlag?: string;
  /** The bicep var that must gate creation. Required for adoptable classes. */
  provisionVar?: string;
  /**
   * The bicep MODULE PARAMETER that `provisionVar` must be passed to — i.e. the
   * knob the resource-creating module actually reads. `'if'` means the module is
   * gated by an inline `= if (... provisionVar ...)` condition instead.
   *
   * This is what makes the drift guard precise. Asserting merely that the raw
   * enable flag is never passed anywhere is too broad: `deSynapse:
   * loomSynapseEnabled` is an env-blanking MIRROR and
   * `loomStreamAnalyticsEnabled: loomStreamAnalyticsEnabled` on
   * asa-query-tester-rbac is an RBAC grant the Console still needs when the job
   * is ADOPTED. Naming the exact sink catches a revert of the real gate and
   * nothing else.
   */
  provisionSink?: string;
  /** Built-in role the Console UAMI needs on an ADOPTED instance. */
  roleGuid?: string;
  roleName?: string;
  /** The day-2 attach kind this maps to, so both paths grant the same role. */
  attachKind?: AttachedServiceKind;
  /** LOOM_* env vars in the admin-plane app env this service populates. */
  consoleEnv: string[];
  /** Legacy per-service EXISTING_* env names still honoured by the bicepparams. */
  legacyEnv?: { name: string; rg: string; sub: string };
  /** Shown in the UI: what Loom uses this service for. */
  usedFor: string;
  /**
   * What Loom CHANGES about an adopted instance (deploy-integrity R5.2). Rendered
   * VERBATIM on the review step. An operator adopting a production Databricks
   * workspace must see "assigns it to a Unity Catalog metastore" BEFORE, not after.
   * An empty array means Loom only reads the resource.
   */
  mutations: string[];
  fitness: FitnessSpec;
}

// ---------------------------------------------------------------------------
// Role GUIDs — resolved FROM attached-service-kinds.ts so day-0 adoption and
// day-2 attach can never grant different roles for the same service.
// ---------------------------------------------------------------------------
const ATTACH_BY_KIND = new Map(ATTACHED_KIND_DEFS.map((d) => [d.kind, d]));

function role(kind: AttachedServiceKind): { roleGuid: string; roleName: string; attachKind: AttachedServiceKind } {
  const d = ATTACH_BY_KIND.get(kind);
  if (!d) {
    // Not reachable through the closed enum, but a thrown error here is far
    // better than silently emitting an undefined role into a grant plan.
    throw new Error(`adoption-catalog: no attach kind def for '${kind}'`);
  }
  return { roleGuid: d.roleGuid, roleName: d.roleName, attachKind: kind };
}

const LOG_ANALYTICS_CONTRIBUTOR = '92aaf0da-9dab-42b6-94a3-d43ce8d16293';

export const ADOPTION_CATALOG: AdoptableServiceDef[] = [
  {
    key: 'purview',
    label: 'Microsoft Purview',
    armType: 'microsoft.purview/accounts',
    tileSlug: 'purview',
    family: 'governance',
    cls: 'adopt-required',
    singleton: 'tenant',
    enableFlag: 'purviewEnabled',
    provisionVar: 'provisionPurview',
    provisionSink: 'purviewEnabled',
    ...role('purview'),
    consoleEnv: ['LOOM_PURVIEW_ACCOUNT'],
    legacyEnv: { name: 'EXISTING_PURVIEW', rg: 'EXISTING_PURVIEW_RG', sub: 'EXISTING_PURVIEW_SUB' },
    usedFor: 'the data catalog, classification, lineage and the sensitivity-label sweep',
    mutations: [
      'registers Loom lake, Synapse and Databricks sources as Purview data sources',
      'creates a Loom collection under the root collection',
      'creates and runs scan definitions against those sources',
      'writes glossary terms and classification rules',
    ],
    fitness: {
      // Purview is one SKU. Cross-region is explicitly supported by
      // main.bicep's purviewLocation, so the region check must not block.
      regionPolicy: 'any',
      familyChecks: ['purview.sameTenant', 'purview.rootCollectionAdmin', 'purview.capacityUnits'],
    },
  },
  {
    key: 'aisearch',
    label: 'Azure AI Search',
    armType: 'microsoft.search/searchservices',
    tileSlug: 'ai-search',
    family: 'search',
    cls: 'adoptable',
    enableFlag: 'aiSearchEnabled',
    provisionVar: 'provisionAiSearch',
    provisionSink: 'aiSearchEnabled',
    ...role('ai-search'),
    consoleEnv: ['LOOM_AI_SEARCH_SERVICE'],
    legacyEnv: { name: 'EXISTING_AI_SEARCH_SERVICE', rg: 'EXISTING_AI_SEARCH_RG', sub: 'EXISTING_AI_SEARCH_SUB' },
    usedFor: 'Copilot retrieval, the docs index and catalog search',
    mutations: [
      'creates up to four indexes (loom-docs, loom-catalog, loom-items, loom-help)',
      'creates the matching indexers and skillsets',
    ],
    fitness: {
      forbiddenSkus: [{
        match: 'free',
        why: 'the Free tier caps a service at 3 indexes and Loom creates 4',
      }],
      regionPolicy: 'prefer-hub',
      familyChecks: ['aisearch.indexHeadroom'],
    },
  },
  {
    key: 'foundry',
    label: 'Azure OpenAI / AI Foundry',
    armType: 'microsoft.cognitiveservices/accounts',
    armKindFilter: 'aiservices',
    tileSlug: 'ai-foundry',
    family: 'ai',
    cls: 'adoptable',
    enableFlag: 'aiFoundryEnabled',
    provisionVar: 'provisionFoundry',
    provisionSink: 'aiFoundryEnabled',
    ...role('aoai'),
    consoleEnv: ['LOOM_AOAI_ENDPOINT', 'LOOM_AOAI_DEPLOYMENT', 'LOOM_AOAI_EMBED_DEPLOYMENT'],
    legacyEnv: { name: 'EXISTING_AOAI', rg: 'EXISTING_AOAI_RG', sub: 'EXISTING_AOAI_SUB' },
    usedFor: 'Copilot, the data agents, AI functions and every embedding path',
    mutations: [],
    fitness: {
      regionPolicy: 'prefer-hub',
      // Adopting an account with NO deployment is unusable, not a bind failure
      // discovered at first chat turn.
      familyChecks: ['foundry.chatDeployment', 'foundry.embedDeployment', 'foundry.kind'],
    },
  },
  {
    key: 'adx',
    label: 'Azure Data Explorer',
    armType: 'microsoft.kusto/clusters',
    tileSlug: 'kql-database',
    family: 'analytics',
    cls: 'adoptable',
    enableFlag: 'adxEnabled',
    provisionVar: 'provisionAdx',
    provisionSink: 'adxEnabled',
    ...role('adx'),
    consoleEnv: ['LOOM_KUSTO_CLUSTER_URI', 'LOOM_KUSTO_CLUSTER_NAME', 'LOOM_KUSTO_RG', 'LOOM_KUSTO_SUB'],
    legacyEnv: { name: 'EXISTING_KUSTO_CLUSTER', rg: 'EXISTING_KUSTO_RG', sub: 'EXISTING_KUSTO_SUB' },
    usedFor: 'the eventhouse / KQL database item type, real-time dashboards and the graph engine',
    mutations: [
      'creates the loomdb_default database',
      'creates data connections from the Loom Event Hubs namespace',
      'enables streaming ingestion if it is off',
    ],
    fitness: {
      forbiddenSkus: [{
        match: 'dev(no sla)_standard_e2a_v4',
        why: 'a Dev/Test cluster has no SLA and a single node — it cannot carry a Loom eventhouse',
      }],
      regionPolicy: 'must-match-hub',
      familyChecks: ['adx.streamingIngestion', 'adx.databaseHeadroom'],
    },
  },
  {
    key: 'synapse',
    label: 'Azure Synapse Analytics',
    armType: 'microsoft.synapse/workspaces',
    tileSlug: 'synapse-serverless-sql-pool',
    family: 'analytics',
    cls: 'adoptable',
    enableFlag: 'loomSynapseEnabled',
    provisionVar: 'provisionSynapse',
    provisionSink: 'loomSynapseEnabled',
    ...role('synapse'),
    consoleEnv: ['LOOM_SYNAPSE_WORKSPACE', 'LOOM_SYNAPSE_RG', 'LOOM_SYNAPSE_SUB'],
    legacyEnv: { name: 'EXISTING_SYNAPSE', rg: 'EXISTING_SYNAPSE_RG', sub: 'EXISTING_SYNAPSE_SUB' },
    usedFor: 'serverless SQL over the lake, Spark notebooks and the warehouse item type',
    mutations: [
      'sets the Console managed identity as a Synapse SQL administrator',
      'creates Spark pools when the Spark workload tier is enabled',
      'creates a managed private endpoint to the lake when the workspace uses a managed VNet',
    ],
    fitness: {
      regionPolicy: 'must-match-hub',
      familyChecks: ['synapse.managedVnetPrivateEndpoint', 'synapse.sqlAdminSettable'],
    },
  },
  {
    key: 'databricks',
    label: 'Azure Databricks',
    armType: 'microsoft.databricks/workspaces',
    tileSlug: 'databricks-sql-warehouse',
    family: 'lakehouse',
    cls: 'adoptable',
    enableFlag: 'loomDatabricksEnabled',
    provisionVar: 'provisionDatabricks',
    provisionSink: 'loomDatabricksEnabled',
    ...role('databricks'),
    consoleEnv: ['LOOM_DATABRICKS_HOSTNAME', 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID'],
    legacyEnv: { name: 'EXISTING_DATABRICKS', rg: 'EXISTING_DATABRICKS_RG', sub: 'EXISTING_DATABRICKS_SUB' },
    usedFor: 'Unity Catalog, the SQL warehouse, Delta jobs and DLT pipelines',
    mutations: [
      'assigns the workspace to a Unity Catalog metastore',
      'creates a SCIM service principal for the Console identity',
      'creates a SQL warehouse',
      'creates Loom catalogs, schemas and external locations',
    ],
    fitness: {
      allowedSkuTiers: ['premium'],
      forbiddenSkus: [{
        match: 'standard',
        why: 'Unity Catalog and SCIM provisioning both require the Premium tier',
      }],
      regionPolicy: 'must-match-hub',
      // Reassigning a workspace already on a FOREIGN metastore is destructive to
      // its existing UC objects, so it is unusable rather than a warning.
      familyChecks: ['databricks.metastoreAssignment'],
    },
  },
  {
    key: 'adf',
    label: 'Azure Data Factory',
    armType: 'microsoft.datafactory/factories',
    tileSlug: 'data-pipeline',
    family: 'integration',
    cls: 'adoptable',
    enableFlag: 'loomDataFactoryEnabled',
    provisionVar: 'provisionAdf',
    provisionSink: 'loomDataFactoryEnabled',
    ...role('adf'),
    consoleEnv: ['LOOM_ADF_NAME', 'LOOM_ADF_RG', 'LOOM_ADF_SUB'],
    legacyEnv: { name: 'EXISTING_ADF', rg: 'EXISTING_ADF_RG', sub: 'EXISTING_ADF_SUB' },
    usedFor: 'the data-pipeline item type, copy activities and the mirrored-database CDC path',
    mutations: [
      'creates Loom-named pipelines, datasets and linked services',
      'creates a managed private endpoint to the lake when the factory uses a managed VNet',
    ],
    fitness: {
      regionPolicy: 'must-match-hub',
      familyChecks: ['adf.managedVnetPrivateEndpoint', 'adf.pipelineNameCollision'],
    },
  },
  {
    key: 'eventhubs',
    label: 'Azure Event Hubs',
    armType: 'microsoft.eventhub/namespaces',
    tileSlug: 'event-hub',
    family: 'streaming',
    cls: 'adoptable',
    enableFlag: 'loomEventHubEnabled',
    provisionVar: 'provisionEventHubs',
    provisionSink: 'loomEventHubEnabled',
    ...role('eventhubs'),
    consoleEnv: ['LOOM_EVENTHUB_NAMESPACE', 'LOOM_EVENTHUB_RG', 'LOOM_EVENTHUB_SUB'],
    legacyEnv: { name: 'EXISTING_EVENTHUB_NAMESPACE', rg: 'EXISTING_EVENTHUB_RG', sub: 'EXISTING_EVENTHUB_SUB' },
    usedFor: 'the eventstream item type and every real-time ingestion path',
    mutations: [
      'creates Loom event hubs and consumer groups in the namespace',
      'grants the ADX cluster identity Azure Event Hubs Data Receiver',
    ],
    fitness: {
      forbiddenSkus: [{
        match: 'basic',
        why: 'the Basic tier has no consumer groups beyond $Default and Loom needs its own',
      }],
      regionPolicy: 'must-match-hub',
      familyChecks: ['eventhubs.throughputHeadroom'],
    },
  },
  {
    key: 'streamanalytics',
    label: 'Azure Stream Analytics',
    armType: 'microsoft.streamanalytics/streamingjobs',
    tileSlug: 'stream-analytics-job',
    family: 'streaming',
    cls: 'adoptable',
    enableFlag: 'loomStreamAnalyticsEnabled',
    provisionVar: 'provisionStreamAnalytics',
    provisionSink: 'enableStreamAnalytics',
    ...role('stream-analytics'),
    consoleEnv: ['LOOM_ASA_RG', 'LOOM_ASA_SUB', 'LOOM_ASA_LOCATION'],
    legacyEnv: { name: 'EXISTING_ASA_JOB', rg: 'EXISTING_ASA_RG', sub: 'EXISTING_ASA_SUB' },
    usedFor: 'the eventstream transform surface and the stream-analytics-job item type',
    mutations: [
      'REPLACES the job query with the Loom transform',
      'creates inputs and outputs against the Loom Event Hubs namespace and lake',
    ],
    fitness: {
      regionPolicy: 'must-match-hub',
      // Editing the query of a RUNNING job is destructive to the customer's
      // workload, so it needs an explicit confirm rather than a silent adopt.
      familyChecks: ['asa.jobStopped'],
    },
  },
  {
    key: 'cosmos',
    label: 'Azure Cosmos DB',
    armType: 'microsoft.documentdb/databaseaccounts',
    tileSlug: 'cosmos-account',
    family: 'operational-db',
    cls: 'adoptable',
    enableFlag: 'loomConsoleCosmosEnabled',
    provisionVar: 'provisionConsoleCosmos',
    provisionSink: 'deployConsoleCosmos',
    ...role('cosmos'),
    consoleEnv: ['LOOM_COSMOS_ENDPOINT', 'LOOM_COSMOS_ACCOUNT', 'LOOM_COSMOS_ACCOUNT_RG', 'LOOM_COSMOS_ACCOUNT_SUB'],
    legacyEnv: { name: 'EXISTING_COSMOS_ACCOUNT', rg: 'EXISTING_COSMOS_ACCOUNT_RG', sub: 'EXISTING_COSMOS_ACCOUNT_SUB' },
    usedFor: 'all Console control-plane metadata — items, workspaces, permissions, plans',
    mutations: [
      'creates roughly 90 Loom containers in the loom database',
      'sets autoscale throughput on the database',
    ],
    fitness: {
      regionPolicy: 'prefer-hub',
      familyChecks: ['cosmos.serverlessAutoscale', 'cosmos.containerNameCollision'],
    },
  },
  {
    key: 'apim',
    label: 'API Management',
    armType: 'microsoft.apimanagement/service',
    tileSlug: 'apim',
    family: 'api',
    cls: 'adoptable',
    enableFlag: 'apimEnabled',
    provisionVar: 'provisionApim',
    provisionSink: 'apimEnabled',
    ...role('apim'),
    consoleEnv: ['LOOM_APIM_NAME', 'LOOM_APIM_RG', 'LOOM_APIM_SUB'],
    legacyEnv: { name: 'EXISTING_APIM', rg: 'EXISTING_APIM_RG', sub: 'EXISTING_APIM_SUB' },
    usedFor: 'the API marketplace, the AOAI gateway and every published Loom API',
    mutations: [
      'creates Loom APIs, products and subscriptions',
      'adds policy fragments for the AOAI gateway backend',
    ],
    fitness: {
      forbiddenSkus: [{
        match: 'consumption',
        why: 'the Consumption tier does not support the policy features the AOAI gateway uses',
      }],
      regionPolicy: 'must-match-hub',
      familyChecks: ['apim.vnetMode'],
    },
  },
  {
    key: 'maps',
    label: 'Azure Maps',
    armType: 'microsoft.maps/accounts',
    tileSlug: 'azure-maps',
    family: 'geo',
    cls: 'adoptable',
    enableFlag: 'azureMapsEnabled',
    provisionVar: 'provisionMaps',
    provisionSink: 'azureMapsEnabled',
    ...role('maps'),
    consoleEnv: ['LOOM_AZURE_MAPS_ACCOUNT', 'LOOM_MAPS_BACKEND'],
    legacyEnv: { name: 'EXISTING_AZURE_MAPS_ACCOUNT', rg: 'EXISTING_AZURE_MAPS_RG', sub: 'EXISTING_AZURE_MAPS_SUB' },
    usedFor: 'the geo editors, map tiles and geocoding',
    mutations: [],
    fitness: {
      forbiddenSkus: [{
        match: 's0',
        why: 'S0 does not carry the render tier the Loom geo editors call',
      }],
      // Maps accounts are global; a region mismatch is meaningless.
      regionPolicy: 'any',
      familyChecks: ['maps.authMode'],
    },
  },
  {
    key: 'aml',
    label: 'Azure Machine Learning',
    armType: 'microsoft.machinelearningservices/workspaces',
    tileSlug: 'ml-model',
    family: 'ai',
    cls: 'adoptable',
    enableFlag: 'mlWorkspaceEnabled',
    provisionVar: 'provisionAml',
    provisionSink: 'if',
    ...role('aml'),
    consoleEnv: ['LOOM_AML_WORKSPACE', 'LOOM_AML_RG', 'LOOM_AML_DEFAULT_COMPUTE'],
    legacyEnv: { name: 'EXISTING_AML_WORKSPACE', rg: 'EXISTING_AML_RG', sub: 'EXISTING_AML_SUB' },
    usedFor: 'the ml-model item type and the notebook AML compute path',
    mutations: [
      'creates a default compute instance for notebooks',
      'registers Loom models and environments',
    ],
    fitness: {
      regionPolicy: 'must-match-hub',
      familyChecks: ['aml.computeQuota'],
    },
  },

  // ------------------------------------------------------------------
  // Not adoptable by suppression. Each carries the SPECIFIC technical
  // reason, rendered in the UI on a locked row (deploy-integrity R5.3:
  // never silently adopt, never silently duplicate — and never offer a
  // choice that does not work).
  // ------------------------------------------------------------------
  {
    key: 'azure-sql',
    label: 'Azure SQL',
    armType: 'microsoft.sql/servers',
    tileSlug: 'azure-sql-database',
    family: 'operational-db',
    cls: 'reference-only',
    createOnlyReason:
      'Loom never creates an Azure SQL server. modules/shared/plan-backing-sql.bicep targets an EXISTING server you name (loomPlanBackingSqlServer) and only reads from it, so there is no create-or-adopt decision to make.',
    ...role('azure-sql'),
    consoleEnv: ['LOOM_PLAN_BACKING_SQL_SERVER'],
    usedFor: 'read-only plan-backing queries against a server you already own',
    mutations: [],
    fitness: { regionPolicy: 'prefer-hub', familyChecks: [] },
  },
  {
    key: 'storage-adls',
    label: 'Storage / ADLS Gen2',
    armType: 'microsoft.storage/storageaccounts',
    tileSlug: 'storage-adls',
    family: 'storage',
    cls: 'attach-in-place',
    createOnlyReason:
      'Loom always creates its own platform lake account because it owns the Bronze/Silver/Gold container layout, the lifecycle policy and the CMK posture. An ADLS Gen2 account you already own is attached as an additional data source through the landing-zone attach path instead, where Loom reads it and never restructures it. Note that isHnsEnabled is create-time-only, so an account without a hierarchical namespace could not serve Delta through the Gen2 API even if it were adopted.',
    ...role('storage-adls'),
    consoleEnv: [],
    usedFor: 'the lakehouse item type, Delta tables and every medallion layer',
    mutations: [],
    fitness: {
      regionPolicy: 'must-match-hub',
      familyChecks: ['adls.hns', 'adls.premiumPageBlob'],
    },
  },
  {
    key: 'loganalytics',
    label: 'Log Analytics workspace',
    armType: 'microsoft.operationalinsights/workspaces',
    tileSlug: 'monitoring',
    family: 'observability',
    cls: 'attach-in-place',
    createOnlyReason:
      'Loom creates its own workspace so retention, the table set and the diagnostic-setting wiring are known. An existing workspace is attachable on the dlz-attach path via hubLawId; adopting one for a hub install is not wired yet, so it is not offered as a choice that would silently do nothing.',
    roleGuid: LOG_ANALYTICS_CONTRIBUTOR,
    roleName: 'Log Analytics Contributor',
    consoleEnv: ['LOOM_LOG_ANALYTICS_WORKSPACE_ID'],
    usedFor: 'diagnostics, the monitor item type and every workspace-scoped KQL query',
    mutations: [],
    fitness: { regionPolicy: 'any', familyChecks: [] },
  },
  {
    key: 'keyvault',
    label: 'Key Vault',
    armType: 'microsoft.keyvault/vaults',
    tileSlug: 'key-vault',
    family: 'platform',
    cls: 'create-only',
    createOnlyReason:
      "Loom's Key Vault is the trust root for MSAL secrets, data-plane credentials and cosign material. enableSoftDelete and enablePurgeProtection are one-way settings that cannot be turned on retroactively in a way Loom can guarantee, so a vault with purge protection off cannot meet Loom's recovery contract — and adopting one would mean Loom writes platform secrets into a vault whose access policies and network ACLs a third party mutates. Loom always creates its own. Referencing a customer vault as a read-only source for connection strings is a separate, later capability with a different role and scope.",
    consoleEnv: ['LOOM_KEY_VAULT_URI'],
    usedFor: 'MSAL secrets, data-plane credentials and signing material',
    mutations: [],
    fitness: { regionPolicy: 'must-match-hub', familyChecks: [] },
  },
  {
    key: 'containerappsenv',
    label: 'Container Apps environment',
    armType: 'microsoft.app/managedenvironments',
    tileSlug: 'container-app',
    family: 'platform',
    cls: 'create-only',
    createOnlyReason:
      "A Container Apps environment's infrastructure subnet and its internal-ingress mode are immutable after creation. Loom requires an internal-ingress environment in a delegated subnet of a specific minimum size, and the environment is the unit of .internal FQDN resolution. An existing environment created with internal=false, or in an undersized subnet, cannot be converted. Loom always creates its own — but it can create it inside a VNet and subnet you already own, which is the supported brownfield lever here.",
    consoleEnv: [],
    usedFor: 'every Loom container app and the .internal service mesh',
    mutations: [],
    fitness: { regionPolicy: 'must-match-hub', familyChecks: [] },
  },
  {
    key: 'acr',
    label: 'Container Registry',
    armType: 'microsoft.containerregistry/registries',
    tileSlug: 'container-registry',
    family: 'platform',
    cls: 'create-only',
    createOnlyReason:
      "Loom's two-phase image build opens the registry firewall, runs az acr build, then re-locks it. Loom will not perform that open-and-relock cycle against a registry you own, and it is the registry that carries the cosign trust root for every Loom image. Loom always creates its own.",
    consoleEnv: ['LOOM_ACR_LOGIN_SERVER'],
    usedFor: 'every Loom container image and the supply-chain attestation chain',
    mutations: [],
    fitness: { regionPolicy: 'must-match-hub', familyChecks: [] },
  },
  {
    key: 'postgres',
    label: 'Azure Database for PostgreSQL',
    armType: 'microsoft.dbforpostgresql/flexibleservers',
    tileSlug: 'postgres',
    family: 'operational-db',
    cls: 'create-only',
    createOnlyReason:
      'Loom migrates the Unity Catalog and DuckLake catalog schemas into this server in place, and no Console binding env exists for an externally-supplied server. Offering an adopt choice here would collect an answer the deployment could not honour, so it is locked rather than silently ignored.',
    enableFlag: 'postgresEnabled',
    consoleEnv: ['LOOM_POSTGRES_HOST'],
    usedFor: 'the Loom Unity catalog and the DuckLake catalog',
    mutations: [],
    fitness: { regionPolicy: 'must-match-hub', familyChecks: [] },
  },
];

const BY_KEY = new Map(ADOPTION_CATALOG.map((d) => [d.key, d]));

/** Look up a service def. Returns undefined for an unknown key. */
export function getServiceDef(key: string): AdoptableServiceDef | undefined {
  return BY_KEY.get(key);
}

/** Every key in the catalog, in catalog order. */
export function allServiceKeys(): string[] {
  return ADOPTION_CATALOG.map((d) => d.key);
}

/** The services whose adopt/create decision the bicep `adopt` bag actually honours. */
export function adoptableServices(): AdoptableServiceDef[] {
  return ADOPTION_CATALOG.filter((d) => d.cls === 'adoptable' || d.cls === 'adopt-required');
}

/**
 * Every ARM type discovery should query, deduped. GENERATED — never a
 * hand-maintained literal, which is how the six catalogs drifted apart.
 */
export function adoptionArmTypes(): string[] {
  return Array.from(new Set(ADOPTION_CATALOG.map((d) => d.armType))).sort();
}

/**
 * The Resource Graph `type in~ (...)` operand, built from the catalog. Callers
 * must use this rather than writing their own type list.
 */
export function adoptionArmTypeFilter(): string {
  return adoptionArmTypes().map((t) => `'${t}'`).join(', ');
}

/**
 * Map a discovered ARM resource to a catalog key, disambiguating the Cognitive
 * Services type by its ARM `kind` (AOAI is an AIServices account; a Maps or
 * generic Cognitive account is not a Foundry adoption target).
 */
export function armTypeToServiceKey(armType: string, armResourceKind?: string): string | null {
  const t = (armType || '').toLowerCase();
  const k = (armResourceKind || '').toLowerCase();
  const matches = ADOPTION_CATALOG.filter((d) => d.armType === t);
  if (matches.length === 0) return null;
  if (matches.length === 1 && !matches[0].armKindFilter) return matches[0].key;
  const byKind = matches.find((d) => d.armKindFilter && k.includes(d.armKindFilter));
  if (byKind) return byKind.key;
  return matches.find((d) => !d.armKindFilter)?.key ?? null;
}

/**
 * Whether the operator may choose `adopt` for this service at all. A locked row
 * always renders `createOnlyReason` — never a disabled control with no reason.
 */
export function canAdopt(key: string): boolean {
  const d = BY_KEY.get(key);
  return !!d && (d.cls === 'adoptable' || d.cls === 'adopt-required');
}

/**
 * Whether the operator may choose `create` for this service. False for a tenant
 * singleton that already exists — "create new" is DISABLED with an explanation
 * rather than offered and then failed at deploy time with
 * EnterpriseTenantAlreadyExists.
 */
export function canCreate(key: string, candidateExists: boolean): boolean {
  const d = BY_KEY.get(key);
  if (!d) return false;
  if (d.cls === 'reference-only' || d.cls === 'attach-in-place') return false;
  if (d.cls === 'adopt-required' && candidateExists) return false;
  return true;
}
