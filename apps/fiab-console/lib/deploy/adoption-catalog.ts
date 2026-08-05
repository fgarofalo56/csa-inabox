/**
 * adoption-catalog — the ONE catalog of every Azure backing service Loom can
 * adopt from an existing estate or deploy new.
 *
 * WHY ONE CATALOG (design §3.1): before this there were SIX divergent tables —
 * `lib/setup/scan-services.ts` (12 services), the `SERVICES` array in
 * `app/api/setup/discover-services/route.ts` (16), `SERVICE_PARAM_MAP` in
 * `app/api/setup/deploy/route.ts` (15), `scripts/csa-loom/byo-wizard.sh` (12),
 * `scan-and-deploy.sh` (14), and `lib/azure/attached-service-kinds.ts` (15).
 * They disagreed on enable-flag names and on `EXISTING_*` env names, and the
 * "no drift" test that was supposed to pin them (`scan-services.test.ts:136`)
 * asserted only `expect(def.enabledFlag).toBeTruthy()` — it compared no names,
 * which is exactly why `maps` and `foundry` drifted into being dead params.
 *
 * The role GUIDs and `tileSlug`s here are carried VERBATIM from
 * `attached-service-kinds.ts` (the best of the six) so day-0 adoption and day-2
 * attach speak the same vocabulary and grant the same roles.
 *
 * PURE: no Azure SDK, no `next/headers`, no fs. Imported by server routes AND
 * by the client wizard, so it must stay free of server-only imports.
 *
 * NOTE ON `provisionVar`: this names the bicep VARIABLE that must gate the
 * resource's creation — `var provisionPurview = purviewEnabled &&
 * adoptMode(adopt,'purview') == 'create'`. It is recorded here so a CI guard can
 * byte-compare it against `platform/fiab/bicep/main.bicep` and fail when a
 * provision site is gated on the bare enable flag (the class of defect that has
 * Loom deploying a SECOND Purview next to the customer's existing one even
 * though `existingPurviewAccount` was supplied).
 */

export type ServiceFamily =
  | 'analytics'
  | 'storage'
  | 'streaming'
  | 'ai'
  | 'governance'
  | 'integration'
  | 'platform'
  | 'network'
  | 'observability';

export type AdoptionClass =
  | 'adoptable'
  | 'adopt-required'
  | 'create-only'
  | 'reference-only'
  | 'attach-in-place';

export interface AdoptableServiceDef {
  /** The ONLY identifier, everywhere. */
  key: string;
  label: string;
  /** Lower-case, for the ARG `type in~ (...)` literal. */
  armType: string;
  /** Case-insensitive discriminator on the ARM `kind` field (AOAI = AIServices). */
  armKindFilter?: string;
  tileSlug: string;
  family: ServiceFamily;
  class: AdoptionClass;
  /** REQUIRED when class === 'create-only'. Rendered verbatim in the UI. */
  createOnlyReason?: string;
  /** A singleton cannot be created twice — "create new" is disabled, not offered. */
  singleton?: 'tenant' | 'region';
  /** main.bicep enable flag, when the service has one. */
  enableFlag?: string;
  /** The bicep VAR that must gate creation (see the note above). */
  provisionVar?: string;
  /** Built-in role the Console UAMI needs on an adopted instance. */
  roleGuid?: string;
  roleName?: string;
  /** LOOM_* env vars this service populates on the Console. */
  consoleEnv: string[];
  /** What Loom uses it for — shown on every row in the wizard. */
  usedFor: string;
  /**
   * What Loom CHANGES about an adopted instance. MANDATORY, rendered verbatim
   * on the review step. An operator adopting a production Databricks workspace
   * must see "assigns the workspace to a Unity Catalog metastore" BEFORE the
   * deploy, not after.
   */
  mutations: string[];
}

// Built-in Azure role definition GUIDs — kept in step with
// scripts/csa-loom/grant-navigator-rbac.sh and attached-service-kinds.ts.
const CONTRIBUTOR = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
const STORAGE_BLOB_DATA_CONTRIB = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const COSMOS_CONTRIB = '5bd9cd88-fe45-4216-938b-f97437e15450';
const EH_DATA_OWNER = 'f526a384-b230-433a-b45c-95f59c4a2dec';
const ADF_CONTRIB = '673868aa-7521-48a0-acc6-0f60742d39f5';
const SEARCH_CONTRIB = '7ca78c08-252a-4471-8644-bb5ff32d4ba0';
const COG_CONTRIB = '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68';
const APIM_CONTRIB = '312a565d-c81f-4fd8-895a-4e21e48d571c';
const PURVIEW_DATA_SOURCE_ADMIN = '200bba9e-f0c8-430f-892b-6f0794863803';
const NETWORK_CONTRIB = '4d97b98b-1d4f-4787-a291-c67834d212e7';
const PRIVATE_DNS_ZONE_CONTRIB = 'b12aa53e-6015-4669-85d0-8515ebb3ae7f';
const LOG_ANALYTICS_CONTRIB = '92aaf0da-9dab-42b6-94a3-d43ce8d16293';
const ACR_PUSH = '8311e382-0749-4cb8-b61a-304f252e45ec';

export const ADOPTION_CATALOG: AdoptableServiceDef[] = [
  // ── governance ──────────────────────────────────────────────────────────
  {
    key: 'purview',
    label: 'Microsoft Purview',
    armType: 'microsoft.purview/accounts',
    tileSlug: 'purview',
    family: 'governance',
    class: 'adopt-required',
    singleton: 'tenant',
    enableFlag: 'purviewEnabled',
    provisionVar: 'provisionPurview',
    roleGuid: PURVIEW_DATA_SOURCE_ADMIN,
    roleName: 'Purview Data Source Administrator',
    consoleEnv: ['LOOM_PURVIEW_ACCOUNT', 'LOOM_PURVIEW_RG', 'LOOM_PURVIEW_SUB'],
    usedFor: 'The data map, classifications, lineage and the governance surfaces.',
    mutations: [
      'registers Loom’s lake, Synapse and Databricks sources as scan targets',
      'creates a Loom collection under the root collection',
      'creates scan rulesets and a recurring scan schedule',
    ],
  },
  // ── analytics ───────────────────────────────────────────────────────────
  {
    key: 'synapse',
    label: 'Synapse Analytics',
    armType: 'microsoft.synapse/workspaces',
    tileSlug: 'synapse-serverless-sql-pool',
    family: 'analytics',
    class: 'adoptable',
    enableFlag: 'loomSynapseEnabled',
    provisionVar: 'provisionSynapse',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_SYNAPSE_WORKSPACE', 'LOOM_SYNAPSE_RG', 'LOOM_SYNAPSE_SUB'],
    usedFor: 'Serverless SQL over the lake, dedicated pools for the warehouse, and Spark pools for notebooks.',
    mutations: [
      'adds the Console identity as a Synapse SQL administrator',
      'creates Loom’s serverless SQL databases and external tables',
      'creates a managed private endpoint to the lake when the workspace uses a managed VNet',
    ],
  },
  {
    key: 'adx',
    label: 'Azure Data Explorer',
    armType: 'microsoft.kusto/clusters',
    tileSlug: 'kql-database',
    family: 'analytics',
    class: 'adoptable',
    enableFlag: 'adxEnabled',
    provisionVar: 'provisionAdx',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_KUSTO_CLUSTER', 'LOOM_KUSTO_RG', 'LOOM_KUSTO_SUB'],
    usedFor: 'Eventhouses, KQL databases/querysets/dashboards, and the graph store.',
    mutations: [
      'creates Loom’s KQL databases on the cluster',
      'enables streaming ingestion if it is off',
      'grants the cluster identity Event Hubs Data Receiver on Loom’s namespace',
    ],
  },
  {
    key: 'databricks',
    label: 'Azure Databricks',
    armType: 'microsoft.databricks/workspaces',
    tileSlug: 'databricks-sql-warehouse',
    family: 'analytics',
    class: 'adoptable',
    enableFlag: 'loomDatabricksEnabled',
    provisionVar: 'provisionDatabricks',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_DATABRICKS_WORKSPACE', 'LOOM_DATABRICKS_HOST', 'LOOM_DATABRICKS_RG', 'LOOM_DATABRICKS_SUB'],
    usedFor: 'Unity Catalog governance, SQL warehouses, jobs and DLT pipelines.',
    mutations: [
      'assigns the workspace to a Unity Catalog metastore',
      'creates a SCIM service principal for Loom',
      'creates a SQL warehouse and Loom’s catalogs/schemas',
    ],
  },
  {
    key: 'aml',
    label: 'Azure Machine Learning',
    armType: 'microsoft.machinelearningservices/workspaces',
    tileSlug: 'ml-model',
    family: 'ai',
    class: 'adoptable',
    enableFlag: 'mlWorkspaceEnabled',
    provisionVar: 'provisionAml',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_AML_WORKSPACE', 'LOOM_AML_RG', 'LOOM_AML_SUB'],
    usedFor: 'Model training, registration and managed online endpoints.',
    mutations: ['creates a default compute instance', 'registers Loom’s models and environments'],
  },
  // ── storage ─────────────────────────────────────────────────────────────
  {
    key: 'storage-adls',
    label: 'Storage / ADLS Gen2',
    armType: 'microsoft.storage/storageaccounts',
    tileSlug: 'storage-adls',
    family: 'storage',
    class: 'adoptable',
    provisionVar: 'provisionLakeStorage',
    roleGuid: STORAGE_BLOB_DATA_CONTRIB,
    roleName: 'Storage Blob Data Contributor',
    consoleEnv: ['LOOM_STORAGE_ACCOUNT', 'LOOM_STORAGE_RG', 'LOOM_STORAGE_SUB'],
    usedFor: 'The medallion lakehouse (bronze/silver/gold Delta) and the org-visuals container.',
    mutations: [
      'creates the bronze / silver / gold containers',
      'creates the org-visuals container',
      'adds a private endpoint + DNS record when the account is not reachable from the Console subnet',
    ],
  },
  {
    key: 'cosmos',
    label: 'Cosmos DB',
    armType: 'microsoft.documentdb/databaseaccounts',
    tileSlug: 'cosmos-account',
    family: 'storage',
    class: 'adoptable',
    enableFlag: 'loomConsoleCosmosEnabled',
    provisionVar: 'provisionConsoleCosmos',
    roleGuid: COSMOS_CONTRIB,
    roleName: 'DocumentDB Account Contributor',
    consoleEnv: ['LOOM_COSMOS_ACCOUNT', 'LOOM_COSMOS_RG', 'LOOM_COSMOS_SUB'],
    usedFor: 'Console metadata (items, workspaces, plans, audit) and the graph/vector store.',
    mutations: ['creates Loom’s database and ~40 containers', 'sets autoscale throughput on new containers'],
  },
  {
    key: 'postgres',
    label: 'PostgreSQL Flexible Server',
    armType: 'microsoft.dbforpostgresql/flexibleservers',
    tileSlug: 'postgres',
    family: 'storage',
    class: 'adoptable',
    enableFlag: 'postgresEnabled',
    provisionVar: 'provisionPostgres',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_POSTGRES_HOST', 'LOOM_POSTGRES_RG', 'LOOM_POSTGRES_SUB'],
    usedFor: 'The Loom Unity catalog store and the DuckLake catalog.',
    mutations: ['creates Loom’s databases', 'adds a firewall rule or private endpoint for the Console subnet'],
  },
  {
    key: 'azure-sql',
    label: 'Azure SQL',
    armType: 'microsoft.sql/servers',
    tileSlug: 'azure-sql-database',
    family: 'storage',
    class: 'reference-only',
    consoleEnv: ['LOOM_PLAN_BACKING_SQL_SERVER'],
    usedFor: 'Read-only plan-backing queries. Loom never provisions or mutates it.',
    mutations: [],
  },
  // ── streaming ───────────────────────────────────────────────────────────
  {
    key: 'eventhubs',
    label: 'Event Hubs',
    armType: 'microsoft.eventhub/namespaces',
    tileSlug: 'event-hub',
    family: 'streaming',
    class: 'adoptable',
    enableFlag: 'loomEventHubEnabled',
    provisionVar: 'provisionEventHub',
    roleGuid: EH_DATA_OWNER,
    roleName: 'Azure Event Hubs Data Owner',
    consoleEnv: ['LOOM_EVENTHUB_NAMESPACE', 'LOOM_EVENTHUB_RG', 'LOOM_EVENTHUB_SUB'],
    usedFor: 'Eventstream sources, ADX ingestion transport and mirroring CDC.',
    mutations: ['creates Loom’s event hubs and consumer groups', 'grants the ADX cluster Data Receiver'],
  },
  {
    key: 'streamanalytics',
    label: 'Stream Analytics',
    armType: 'microsoft.streamanalytics/streamingjobs',
    tileSlug: 'stream-analytics-job',
    family: 'streaming',
    class: 'adoptable',
    enableFlag: 'loomStreamAnalyticsEnabled',
    provisionVar: 'provisionStreamAnalytics',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_ASA_JOB', 'LOOM_ASA_RG', 'LOOM_ASA_SUB'],
    usedFor: 'The stream-analytics-job editor and the Eventstream transform node.',
    mutations: ['replaces the job query with Loom’s transform', 'adds inputs/outputs for Loom’s streams'],
  },
  // ── integration ─────────────────────────────────────────────────────────
  {
    key: 'adf',
    label: 'Data Factory',
    armType: 'microsoft.datafactory/factories',
    tileSlug: 'data-pipeline',
    family: 'integration',
    class: 'adoptable',
    enableFlag: 'loomDataFactoryEnabled',
    provisionVar: 'provisionAdf',
    roleGuid: ADF_CONTRIB,
    roleName: 'Data Factory Contributor',
    consoleEnv: ['LOOM_ADF_FACTORY', 'LOOM_ADF_RG', 'LOOM_ADF_SUB'],
    usedFor: 'Data pipelines, dataflows, copy activities and the pipeline canvas.',
    mutations: [
      'creates Loom’s pipelines, datasets and linked services',
      'creates a managed private endpoint to the lake when the factory uses a managed VNet',
    ],
  },
  {
    key: 'apim',
    label: 'API Management',
    armType: 'microsoft.apimanagement/service',
    tileSlug: 'apim',
    family: 'integration',
    class: 'adoptable',
    enableFlag: 'apimEnabled',
    provisionVar: 'provisionApim',
    roleGuid: APIM_CONTRIB,
    roleName: 'API Management Service Contributor',
    consoleEnv: ['LOOM_APIM_NAME', 'LOOM_APIM_RG', 'LOOM_APIM_SUB'],
    usedFor: 'The API marketplace — publish, Try-it and the generated curl.',
    mutations: ['creates Loom’s APIs, products and policies'],
  },
  // ── ai ──────────────────────────────────────────────────────────────────
  {
    key: 'aisearch',
    label: 'AI Search',
    armType: 'microsoft.search/searchservices',
    tileSlug: 'ai-search',
    family: 'ai',
    class: 'adoptable',
    enableFlag: 'aiSearchEnabled',
    provisionVar: 'provisionAiSearch',
    roleGuid: SEARCH_CONTRIB,
    roleName: 'Search Service Contributor',
    consoleEnv: ['LOOM_AI_SEARCH_SERVICE', 'LOOM_AI_SEARCH_RG', 'LOOM_AI_SEARCH_SUB'],
    usedFor: 'The docs corpus, catalog search and the Copilot retrieval index.',
    mutations: ['creates four indexes and their indexers', 'creates a data source pointing at Loom’s lake'],
  },
  {
    key: 'foundry',
    label: 'AI Foundry / Azure OpenAI',
    armType: 'microsoft.cognitiveservices/accounts',
    armKindFilter: 'aiservices',
    tileSlug: 'ai-foundry',
    family: 'ai',
    class: 'adoptable',
    enableFlag: 'aiFoundryEnabled',
    provisionVar: 'provisionFoundry',
    roleGuid: COG_CONTRIB,
    roleName: 'Cognitive Services Contributor',
    consoleEnv: ['LOOM_AOAI_ENDPOINT', 'LOOM_AOAI_RG', 'LOOM_AOAI_SUB', 'LOOM_AOAI_CHAT_DEPLOYMENT', 'LOOM_AOAI_EMBED_DEPLOYMENT'],
    usedFor: 'Copilot, the agent runtime, embeddings and every AI-assisted surface.',
    mutations: ['creates a chat and an embeddings deployment if Loom’s named ones are absent'],
  },
  {
    key: 'maps',
    label: 'Azure Maps',
    armType: 'microsoft.maps/accounts',
    tileSlug: 'azure-maps',
    family: 'ai',
    class: 'adoptable',
    enableFlag: 'azureMapsEnabled',
    provisionVar: 'provisionMaps',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_AZURE_MAPS_ACCOUNT'],
    usedFor: 'The geo/map editors and geospatial rendering.',
    mutations: ['reads the account key into Loom’s Key Vault'],
  },
  // ── network (attach-in-place) ───────────────────────────────────────────
  {
    key: 'vnet',
    label: 'Virtual Network',
    armType: 'microsoft.network/virtualnetworks',
    tileSlug: 'network',
    family: 'network',
    class: 'attach-in-place',
    provisionVar: 'provisionHubVnet',
    roleGuid: NETWORK_CONTRIB,
    roleName: 'Network Contributor',
    consoleEnv: ['LOOM_HUB_VNET_ID'],
    usedFor: 'The hub VNet that hosts the Container Apps subnet, private endpoints and the firewall.',
    mutations: [
      'creates the subnets Loom needs from free address space (it never renumbers an existing subnet)',
      'delegates the Container Apps subnet to Microsoft.App/environments',
    ],
  },
  {
    key: 'privatednszone',
    label: 'Private DNS zone',
    armType: 'microsoft.network/privatednszones',
    tileSlug: 'network',
    family: 'network',
    class: 'attach-in-place',
    provisionVar: 'provisionPrivateDns',
    roleGuid: PRIVATE_DNS_ZONE_CONTRIB,
    roleName: 'Private DNS Zone Contributor',
    consoleEnv: [],
    usedFor: 'Name resolution for every privatelink.* endpoint Loom creates.',
    mutations: ['adds A records for Loom’s private endpoints', 'links the zone to the hub VNet'],
  },
  {
    key: 'firewallpolicy',
    label: 'Azure Firewall policy',
    armType: 'microsoft.network/firewallpolicies',
    tileSlug: 'network',
    family: 'network',
    class: 'attach-in-place',
    provisionVar: 'provisionFirewallPolicy',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: [],
    usedFor: 'Egress rules for the admin plane.',
    mutations: ['adds one uniquely-named rule-collection group in a reserved priority band'],
  },
  {
    key: 'azurefirewall',
    label: 'Azure Firewall (instance)',
    armType: 'microsoft.network/azurefirewalls',
    tileSlug: 'network',
    family: 'network',
    class: 'create-only',
    createOnlyReason:
      'Rule-collection-group priority bands collide destructively and there is no safe merge — Loom cannot know which of your existing collections it may renumber. Loom adopts the firewall POLICY by id and deploys its own firewall instance.',
    provisionVar: 'provisionFirewall',
    consoleEnv: [],
    usedFor: 'Egress hardening for the admin plane.',
    mutations: [],
  },
  // ── observability / platform ────────────────────────────────────────────
  {
    key: 'loganalytics',
    label: 'Log Analytics workspace',
    armType: 'microsoft.operationalinsights/workspaces',
    tileSlug: 'monitoring',
    family: 'observability',
    class: 'adoptable',
    provisionVar: 'provisionLogAnalytics',
    roleGuid: LOG_ANALYTICS_CONTRIB,
    roleName: 'Log Analytics Contributor',
    consoleEnv: ['LOOM_LAW_ID'],
    usedFor: 'Container Apps logs, diagnostic settings and the observability surfaces.',
    mutations: ['adds diagnostic settings from Loom’s resources', 'creates Loom’s saved queries'],
  },
  {
    key: 'acr',
    label: 'Container Registry',
    armType: 'microsoft.containerregistry/registries',
    tileSlug: 'container',
    family: 'platform',
    class: 'adoptable',
    provisionVar: 'provisionAcr',
    roleGuid: ACR_PUSH,
    roleName: 'AcrPush',
    consoleEnv: ['LOOM_ACR_NAME'],
    usedFor: 'Hosting Loom’s container images for the Container Apps environment.',
    mutations: [
      'pushes Loom’s image repositories',
      'does NOT modify the registry firewall — an unreachable registry is reported as unusable rather than opened',
    ],
  },
  {
    key: 'keyvault',
    label: 'Key Vault',
    armType: 'microsoft.keyvault/vaults',
    tileSlug: 'key-vault',
    family: 'platform',
    class: 'create-only',
    createOnlyReason:
      'Loom’s vault is the trust root for the MSAL secret, data-plane credentials and cosign material. Soft-delete and purge protection are one-way settings that cannot be turned on retroactively in a way Loom can guarantee, and adoption would mean Loom writes platform secrets into a vault whose access policies and network ACLs a third party mutates.',
    provisionVar: 'provisionKeyVault',
    consoleEnv: ['LOOM_KEYVAULT_NAME'],
    usedFor: 'The MSAL secret, session secret, Maps key and the Connections credential store.',
    mutations: [],
  },
  {
    key: 'containerappsenv',
    label: 'Container Apps environment',
    armType: 'microsoft.app/managedenvironments',
    tileSlug: 'container',
    family: 'platform',
    class: 'create-only',
    createOnlyReason:
      'The infrastructure subnet and the internal-ingress mode of a Container Apps environment are immutable after creation, and the environment is the unit of .internal FQDN resolution. An environment created with internal ingress off, or in an undersized subnet, cannot be converted. Loom CAN place its new environment in a VNet and subnet you already own — that is the supported brownfield lever.',
    provisionVar: 'provisionContainerAppsEnv',
    consoleEnv: [],
    usedFor: 'Hosting the Console and every Loom container app.',
    mutations: [],
  },
];

const BY_KEY = new Map(ADOPTION_CATALOG.map((d) => [d.key, d]));

export function getServiceDef(key: string): AdoptableServiceDef | undefined {
  return BY_KEY.get(key);
}

/** Every distinct ARM type the estate scan must query (deduped, lower-case). */
export function adoptionArmTypes(): string[] {
  return Array.from(new Set(ADOPTION_CATALOG.map((d) => d.armType)));
}

/**
 * Map a discovered ARM row onto a catalog key.
 *
 * Cognitive Services accounts split by the ARM `kind` field (AOAI is an
 * `AIServices` account); a non-matching kind yields null rather than being
 * mis-filed as a Foundry candidate.
 */
export function armRowToServiceKey(armType: string, armKind?: string): string | null {
  const t = (armType || '').toLowerCase();
  const k = (armKind || '').toLowerCase();
  const matches = ADOPTION_CATALOG.filter((d) => d.armType === t);
  if (matches.length === 0) return null;
  if (matches.length === 1 && !matches[0].armKindFilter) return matches[0].key;
  const byKind = matches.find((d) => d.armKindFilter && k.includes(d.armKindFilter));
  if (byKind) return byKind.key;
  return matches.find((d) => !d.armKindFilter)?.key ?? null;
}

/** The services the wizard offers a decision for (create-only rows included —
 *  they render LOCKED with their reason rather than being hidden). */
export function decidableServices(): AdoptableServiceDef[] {
  return ADOPTION_CATALOG.filter((d) => d.class !== 'reference-only');
}
