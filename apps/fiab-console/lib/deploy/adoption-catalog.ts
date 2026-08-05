/**
 * adoption-catalog — the ONE catalog of Azure services CSA Loom can adopt from
 * an existing (brownfield) estate, or deploy new (greenfield).
 *
 * ## Why this file exists
 *
 * Six divergent catalogs described "the services Loom can reuse", and they
 * disagreed on flag names, env names and even which service a key referred to:
 *
 *   - `lib/setup/scan-services.ts`                       (12 services)
 *   - `app/api/setup/discover-services/route.ts` SERVICES (16)
 *   - `app/api/setup/deploy/route.ts` SERVICE_PARAM_MAP   (15)
 *   - `lib/azure/attached-service-kinds.ts`               (15 — the best of them)
 *   - `scripts/csa-loom/byo-wizard.sh`                    (12)
 *   - `scripts/csa-loom/scan-and-deploy.sh`               (14)
 *
 * Machine-diffing them found real, shipped drift (`maps` carried
 * `loomMapsEnabled` in the CLI and `azureMapsEnabled` in TypeScript; `foundry`
 * carried `agentFoundryEnabled` vs `aiFoundryEnabled` — two DIFFERENT accounts).
 * The "no drift" test that was supposed to prevent exactly this asserted only
 * `expect(def.enabledFlag).toBeTruthy()` — it compared no names at all.
 *
 * This catalog is the replacement. `scripts/ci/check-adoption-catalog-sync.mjs`
 * byte-compares every `enableFlag` against the parameters `main.bicep` actually
 * declares, so an invented or renamed flag fails CI instead of shipping.
 *
 * ## Scope of THIS file
 *
 * Discovery + adoption metadata only:
 *   - what ARM type to scan for (the ARG `type in~` literal is GENERATED from
 *     this list — never hand-maintained, see `discovery-model.ts`),
 *   - whether the service can be adopted at all, and if not, WHY (§6 of the
 *     greenfield/brownfield design — `class:'create-only'` demands a reason),
 *   - what Loom uses it for and what Loom would CHANGE about an adopted
 *     instance (rendered verbatim on the review step — an operator adopting a
 *     production Databricks workspace must see "assigns it to a Unity Catalog
 *     metastore" BEFORE, not after),
 *   - the built-in role the Console UAMI needs on an adopted instance.
 *
 * The `adopt` bicep param bag, the `provisionVar` gating and the plan model are
 * downstream of this file and land separately; `provisionVar` records the name
 * those vars will carry so the two halves cannot drift apart silently.
 *
 * Role GUIDs and `tileSlug`s are carried over VERBATIM from
 * `lib/azure/attached-service-kinds.ts` (which this catalog supersedes) so the
 * day-0 adopt path and the day-2 attach path keep granting the same roles.
 *
 * No Fabric / Power BI entry exists here by construction — every backend is
 * Azure-native (`.claude/rules/no-fabric-dependency.md`). Fabric stays opt-in
 * behind `fabricEnabled` and is never scanned or recommended.
 */

/** Coarse grouping used to organise the discovery result and the plan UI. */
export type ServiceFamily =
  | 'analytics'
  | 'storage'
  | 'governance'
  | 'ai'
  | 'streaming'
  | 'database'
  | 'integration'
  | 'networking'
  | 'platform';

/**
 * How this service may participate in a deployment plan.
 *
 * - `adoptable`      — Loom can use an existing instance or deploy a new one.
 * - `adopt-required` — a TENANT SINGLETON: when one exists, "create new" is not
 *   merely discouraged, it FAILS at ARM (Purview: `EnterpriseTenantAlreadyExists`).
 *   The UI disables "new" with the explanation rather than offering it and then
 *   failing the deploy 20 minutes in.
 * - `reference-only` — Loom reads it but never provisions or mutates it.
 * - `create-only`    — Loom always deploys its own; adoption is not feasible.
 *   `createOnlyReason` is REQUIRED and is rendered to the operator, because
 *   "you can't" without "because" is indistinguishable from "we didn't build it".
 */
export type AdoptionClass = 'adoptable' | 'adopt-required' | 'reference-only' | 'create-only';

export interface AdoptableServiceDef {
  /** Stable key — the ONLY identifier used across discovery, plan and bicep. */
  key: string;
  label: string;
  /** Lower-case ARM type for the generated ARG `type in~ (...)` literal. */
  armType: string;
  /**
   * Case-insensitive discriminator on the ARM resource's `kind` field, for ARM
   * types that host several distinct services. AOAI/Foundry is an
   * `AIServices`-kind Cognitive Services account; a Speech or Vision account
   * shares the ARM type and is NOT an adoption candidate for `foundry`.
   */
  armKindFilter?: string;
  /** item-type-visual slug so rows reuse the existing icon registry. */
  tileSlug: string;
  family: ServiceFamily;
  cls: AdoptionClass;
  /** REQUIRED when cls === 'create-only'. Rendered verbatim to the operator. */
  createOnlyReason?: string;
  /** `tenant` → only one may exist per tenant (Purview). */
  singleton?: 'tenant' | 'region';
  /**
   * The `main.bicep` boolean parameter that turns this service on, when one
   * exists. `null` means the service is provisioned unconditionally today (it
   * has no opt-out flag) — recorded honestly rather than inventing a name that
   * `check-adoption-catalog-sync.mjs` would then fail on.
   */
  enableFlag: string | null;
  /**
   * The bicep var that MUST gate creation once the `adopt` param bag lands:
   * `var <provisionVar> = <enableFlag> && adoptMode(adopt, '<key>') == 'create'`.
   * Declared here so the two halves are pinned to one name from the start.
   */
  provisionVar: string;
  /** Built-in role definition GUID the Console UAMI needs on an adopted instance. */
  roleGuid: string;
  roleName: string;
  /** `LOOM_*` Console env vars this service populates once bound. */
  consoleEnv: string[];
  /** Shown in the UI: what Loom uses this service for. */
  usedFor: string;
  /**
   * What Loom CHANGES about an adopted instance. Mandatory and non-empty for
   * every adoptable service — the operator sees this before confirming, so
   * adoption is never a silent mutation of production infrastructure.
   * An empty array is only valid for `reference-only` / `create-only`.
   */
  mutations: string[];
}

// Built-in Azure role definition GUIDs — carried over verbatim from
// lib/azure/attached-service-kinds.ts and scripts/csa-loom/grant-navigator-rbac.sh
// so day-0 adopt and day-2 attach grant identically.
const CONTRIBUTOR = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
const STORAGE_BLOB_DATA_CONTRIB = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const COSMOS_CONTRIB = '5bd9cd88-fe45-4216-938b-f97437e15450';
const EH_DATA_OWNER = 'f526a384-b230-433a-b45c-95f59c4a2dec';
const ADF_CONTRIB = '673868aa-7521-48a0-acc6-0f60742d39f5';
const SEARCH_CONTRIB = '7ca78c08-252a-4471-8644-bb5ff32d4ba0';
const COG_CONTRIB = '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68';
const APIM_CONTRIB = '312a565d-c81f-4fd8-895a-4e21e48d571c';
const PURVIEW_DATA_SOURCE_ADMIN = '200bba9e-f0c8-430f-892b-6f0794863803';
const LOG_ANALYTICS_CONTRIB = '92aaf0da-9dab-42b6-94a3-d43ce8d16293';
const NETWORK_CONTRIB = '4d97b98b-1d4f-4787-a291-c67834d212e7';
const PRIVATE_DNS_ZONE_CONTRIB = 'b12aa53e-6015-4669-85d0-8515ebb3ae7f';
const ACR_PUSH = '8311e382-0749-4cb8-b61a-304f252e45ec';
const READER = 'acdd72a7-3385-48ef-bd42-f606fba81ae7';

/**
 * The adoption catalog. Every entry's `armType` feeds the single generated ARG
 * query; every `enableFlag` is byte-compared against `main.bicep` in CI.
 *
 * Ordered by family so the discovery result groups sensibly without a second
 * sort table.
 */
export const ADOPTION_CATALOG: AdoptableServiceDef[] = [
  // ---- governance ---------------------------------------------------------
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
    roleGuid: PURVIEW_DATA_SOURCE_ADMIN,
    roleName: 'Purview Data Source Administrator',
    consoleEnv: ['LOOM_PURVIEW_ACCOUNT', 'LOOM_PURVIEW_RG', 'LOOM_PURVIEW_SUB'],
    usedFor: 'Data map, classification, lineage and the governance surfaces.',
    mutations: [
      'registers Loom lake / Synapse / Databricks sources as Purview data sources',
      'creates a Loom collection under the root collection',
      'runs scheduled scans against the registered sources',
    ],
  },

  // ---- analytics ----------------------------------------------------------
  {
    key: 'synapse',
    label: 'Synapse Analytics',
    armType: 'microsoft.synapse/workspaces',
    tileSlug: 'synapse-serverless-sql-pool',
    family: 'analytics',
    cls: 'adoptable',
    enableFlag: 'loomSynapseEnabled',
    provisionVar: 'provisionSynapse',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_SYNAPSE_WORKSPACE', 'LOOM_SYNAPSE_RG', 'LOOM_SYNAPSE_SUB'],
    usedFor: 'Serverless + dedicated SQL, Spark pools, and the pipeline runtime.',
    mutations: [
      'sets the Console UAMI as a Synapse SQL administrator',
      'creates Loom Spark pools and serverless SQL external tables',
      'creates managed private endpoints to the lake when the workspace uses a managed VNet',
    ],
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
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_KUSTO_CLUSTER', 'LOOM_KUSTO_RG', 'LOOM_KUSTO_SUB'],
    usedFor: 'Real-Time Intelligence — eventhouse, KQL databases, querysets, dashboards, and the graph engine.',
    mutations: [
      'creates Loom KQL databases on the cluster',
      'enables streaming ingestion if it is off',
      'grants the Console UAMI database-admin on the databases it creates',
    ],
  },
  {
    key: 'databricks',
    label: 'Azure Databricks',
    armType: 'microsoft.databricks/workspaces',
    tileSlug: 'databricks-sql-warehouse',
    family: 'analytics',
    cls: 'adoptable',
    enableFlag: 'loomDatabricksEnabled',
    provisionVar: 'provisionDatabricks',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_DATABRICKS_WORKSPACE', 'LOOM_DATABRICKS_HOST', 'LOOM_DATABRICKS_RG', 'LOOM_DATABRICKS_SUB'],
    usedFor: 'Notebooks, jobs, DLT pipelines, SQL warehouses and Unity Catalog.',
    mutations: [
      'assigns the workspace to a Unity Catalog metastore',
      'creates a SCIM service principal for Loom',
      'creates a SQL warehouse',
      'creates Loom catalogs / schemas in Unity Catalog',
    ],
  },
  {
    key: 'aml',
    label: 'Azure Machine Learning',
    armType: 'microsoft.machinelearningservices/workspaces',
    tileSlug: 'ml-model',
    family: 'analytics',
    cls: 'adoptable',
    enableFlag: 'mlWorkspaceEnabled',
    provisionVar: 'provisionAml',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_AML_WORKSPACE', 'LOOM_AML_RG', 'LOOM_AML_SUB'],
    usedFor: 'Model training, registry and managed endpoints for the ML item types.',
    mutations: [
      'creates a default compute instance / cluster for Loom jobs',
      'registers Loom models and environments in the workspace registry',
    ],
  },

  // ---- storage ------------------------------------------------------------
  {
    key: 'storage-adls',
    label: 'Storage / ADLS Gen2',
    armType: 'microsoft.storage/storageaccounts',
    tileSlug: 'storage-adls',
    family: 'storage',
    cls: 'adoptable',
    // Lake storage is provisioned with each landing zone and has no opt-out
    // flag in main.bicep today. Recorded as null rather than invented.
    enableFlag: null,
    provisionVar: 'provisionLakeStorage',
    roleGuid: STORAGE_BLOB_DATA_CONTRIB,
    roleName: 'Storage Blob Data Contributor',
    consoleEnv: ['LOOM_STORAGE_ACCOUNT', 'LOOM_STORAGE_RG', 'LOOM_STORAGE_SUB'],
    usedFor: 'The medallion lakehouse (bronze / silver / gold Delta) and Org visuals.',
    mutations: [
      'creates bronze / silver / gold containers',
      'writes Delta tables under the Loom lake root',
      'creates a private endpoint + private DNS record when the account is PE-only',
    ],
  },

  // ---- database -----------------------------------------------------------
  {
    key: 'cosmos',
    label: 'Cosmos DB',
    armType: 'microsoft.documentdb/databaseaccounts',
    tileSlug: 'cosmos-account',
    family: 'database',
    cls: 'adoptable',
    enableFlag: 'loomConsoleCosmosEnabled',
    provisionVar: 'provisionConsoleCosmos',
    roleGuid: COSMOS_CONTRIB,
    roleName: 'DocumentDB Account Contributor',
    consoleEnv: ['LOOM_COSMOS_ACCOUNT', 'LOOM_COSMOS_RG', 'LOOM_COSMOS_SUB'],
    usedFor: 'Console metadata (items, workspaces, plans) and the graph / vector store.',
    mutations: [
      'creates the Loom database and its containers',
      'writes Console metadata continuously',
    ],
  },
  {
    key: 'postgres',
    label: 'PostgreSQL Flexible Server',
    armType: 'microsoft.dbforpostgresql/flexibleservers',
    tileSlug: 'postgres',
    family: 'database',
    cls: 'adoptable',
    enableFlag: 'postgresEnabled',
    provisionVar: 'provisionPostgres',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_POSTGRES_SERVER', 'LOOM_POSTGRES_RG', 'LOOM_POSTGRES_SUB'],
    usedFor: 'The Loom Unity catalog and the DuckLake catalog backends.',
    mutations: [
      'creates the Loom Unity and DuckLake catalog databases',
      'adds a firewall rule (or private endpoint) for the Container Apps egress',
    ],
  },
  {
    key: 'azure-sql',
    label: 'Azure SQL',
    armType: 'microsoft.sql/servers',
    tileSlug: 'azure-sql-database',
    family: 'database',
    cls: 'reference-only',
    enableFlag: null,
    provisionVar: 'provisionAzureSql',
    roleGuid: READER,
    roleName: 'Reader',
    consoleEnv: ['LOOM_PLAN_BACKING_SQL_SERVER'],
    usedFor: 'Read-only source for federated queries and plan-backing metadata.',
    mutations: [],
  },

  // ---- ai -----------------------------------------------------------------
  {
    key: 'foundry',
    label: 'AI Foundry / Azure OpenAI',
    armType: 'microsoft.cognitiveservices/accounts',
    armKindFilter: 'aiservices',
    tileSlug: 'ai-foundry',
    family: 'ai',
    cls: 'adoptable',
    enableFlag: 'aiFoundryEnabled',
    provisionVar: 'provisionFoundry',
    roleGuid: COG_CONTRIB,
    roleName: 'Cognitive Services Contributor',
    consoleEnv: ['LOOM_AOAI_ACCOUNT', 'LOOM_AOAI_RG', 'LOOM_AOAI_SUB', 'LOOM_AOAI_CHAT_DEPLOYMENT', 'LOOM_AOAI_EMBED_DEPLOYMENT'],
    usedFor: 'Copilot, the agent runtime, embeddings and every AI-assisted surface.',
    mutations: [
      'creates chat + embedding model deployments if the required ones are absent',
      'consumes TPM quota on the account',
    ],
  },
  {
    key: 'aisearch',
    label: 'AI Search',
    armType: 'microsoft.search/searchservices',
    tileSlug: 'ai-search',
    family: 'ai',
    cls: 'adoptable',
    enableFlag: 'aiSearchEnabled',
    provisionVar: 'provisionAiSearch',
    roleGuid: SEARCH_CONTRIB,
    roleName: 'Search Service Contributor',
    consoleEnv: ['LOOM_AI_SEARCH_SERVICE', 'LOOM_AI_SEARCH_RG', 'LOOM_AI_SEARCH_SUB'],
    usedFor: 'Catalog search, the docs corpus and the Copilot retrieval index.',
    mutations: [
      'creates Loom indexes, indexers and skillsets',
      'consumes index and storage quota on the service',
    ],
  },

  // ---- streaming ----------------------------------------------------------
  {
    key: 'eventhubs',
    label: 'Event Hubs',
    armType: 'microsoft.eventhub/namespaces',
    tileSlug: 'event-hub',
    family: 'streaming',
    cls: 'adoptable',
    enableFlag: 'loomEventHubEnabled',
    provisionVar: 'provisionEventHubs',
    roleGuid: EH_DATA_OWNER,
    roleName: 'Azure Event Hubs Data Owner',
    consoleEnv: ['LOOM_EVENTHUB_NAMESPACE', 'LOOM_EVENTHUB_RG', 'LOOM_EVENTHUB_SUB'],
    usedFor: 'Eventstream sources, Data Explorer ingestion and mirroring CDC transport.',
    mutations: [
      'creates Loom event hubs and consumer groups in the namespace',
      'consumes throughput units',
    ],
  },
  {
    key: 'streamanalytics',
    label: 'Stream Analytics',
    armType: 'microsoft.streamanalytics/streamingjobs',
    tileSlug: 'stream-analytics-job',
    family: 'streaming',
    cls: 'adoptable',
    enableFlag: 'loomStreamAnalyticsEnabled',
    provisionVar: 'provisionStreamAnalytics',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_ASA_JOB', 'LOOM_ASA_RG', 'LOOM_ASA_SUB'],
    usedFor: 'The stream-analytics-job editor and the Eventstream transform node.',
    mutations: [
      'REPLACES the job query with the Loom transform',
      'stops and restarts the job to apply the query',
      'rebinds the job inputs and outputs',
    ],
  },

  // ---- integration --------------------------------------------------------
  {
    key: 'adf',
    label: 'Data Factory',
    armType: 'microsoft.datafactory/factories',
    tileSlug: 'data-pipeline',
    family: 'integration',
    cls: 'adoptable',
    enableFlag: 'loomDataFactoryEnabled',
    provisionVar: 'provisionAdf',
    roleGuid: ADF_CONTRIB,
    roleName: 'Data Factory Contributor',
    consoleEnv: ['LOOM_ADF_FACTORY', 'LOOM_ADF_RG', 'LOOM_ADF_SUB'],
    usedFor: 'The data-pipeline item type — pipelines, datasets, linked services, dataflows.',
    mutations: [
      'creates Loom pipelines, datasets and linked services in the factory',
      'creates an integration runtime when none is reusable',
      'creates managed private endpoints when the factory uses a managed VNet',
    ],
  },
  {
    key: 'apim',
    label: 'API Management',
    armType: 'microsoft.apimanagement/service',
    tileSlug: 'apim',
    family: 'integration',
    cls: 'adoptable',
    enableFlag: 'apimEnabled',
    provisionVar: 'provisionApim',
    roleGuid: APIM_CONTRIB,
    roleName: 'API Management Service Contributor',
    consoleEnv: ['LOOM_APIM_NAME', 'LOOM_APIM_RG', 'LOOM_APIM_SUB'],
    usedFor: 'The API marketplace — publish, Try-it, and the gateway policies.',
    mutations: [
      'creates Loom APIs, products and policies',
      'consumes API slots on the service',
    ],
  },
  {
    key: 'maps',
    label: 'Azure Maps',
    armType: 'microsoft.maps/accounts',
    tileSlug: 'azure-maps',
    family: 'integration',
    cls: 'adoptable',
    enableFlag: 'azureMapsEnabled',
    provisionVar: 'provisionMaps',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: ['LOOM_AZURE_MAPS_ACCOUNT'],
    usedFor: 'The geo / map editors and the Org visuals basemap.',
    mutations: ['reads the account key into Key Vault for the map surfaces'],
  },

  // ---- platform -----------------------------------------------------------
  {
    key: 'loganalytics',
    label: 'Log Analytics workspace',
    armType: 'microsoft.operationalinsights/workspaces',
    tileSlug: 'monitor',
    family: 'platform',
    cls: 'adoptable',
    enableFlag: null,
    provisionVar: 'provisionLogAnalytics',
    roleGuid: LOG_ANALYTICS_CONTRIB,
    roleName: 'Log Analytics Contributor',
    consoleEnv: ['LOOM_LAW_ID', 'LOOM_LAW_RG', 'LOOM_LAW_SUB'],
    usedFor: 'Container Apps logs, Application Insights, activity logs and the health probes.',
    mutations: [
      'sends Loom diagnostic settings and container logs to the workspace',
      'creates Loom custom tables and saved queries',
    ],
  },
  {
    key: 'acr',
    label: 'Container Registry',
    armType: 'microsoft.containerregistry/registries',
    tileSlug: 'container-registry',
    family: 'platform',
    cls: 'adoptable',
    enableFlag: null,
    provisionVar: 'provisionAcr',
    roleGuid: ACR_PUSH,
    roleName: 'AcrPush',
    consoleEnv: ['LOOM_ACR_NAME', 'LOOM_ACR_RG', 'LOOM_ACR_SUB'],
    usedFor: 'Hosts every Loom container image the Container Apps pull.',
    mutations: [
      'pushes Loom application images into the registry',
      'does NOT modify the registry firewall — the registry must already be reachable from the build agent and the Container Apps environment',
    ],
  },

  // ---- networking ---------------------------------------------------------
  {
    key: 'vnet',
    label: 'Virtual Network',
    armType: 'microsoft.network/virtualnetworks',
    tileSlug: 'network',
    family: 'networking',
    cls: 'adoptable',
    enableFlag: null,
    provisionVar: 'provisionHubVnet',
    roleGuid: NETWORK_CONTRIB,
    roleName: 'Network Contributor',
    consoleEnv: ['LOOM_HUB_VNET_ID'],
    usedFor: 'The hub network the Container Apps environment, private endpoints and Bastion live in.',
    mutations: [
      'creates the Loom hub subnets inside free address space in the VNet',
      'creates private endpoints for the Loom backing services',
      'links the required privatelink DNS zones to the VNet',
    ],
  },
  {
    key: 'privatednszone',
    label: 'Private DNS zone',
    armType: 'microsoft.network/privatednszones',
    tileSlug: 'network',
    family: 'networking',
    cls: 'adoptable',
    enableFlag: null,
    provisionVar: 'provisionPrivateDns',
    roleGuid: PRIVATE_DNS_ZONE_CONTRIB,
    roleName: 'Private DNS Zone Contributor',
    consoleEnv: [],
    usedFor: 'Resolves the privatelink.* names for every Loom private endpoint.',
    mutations: [
      'adds A records for the Loom private endpoints',
      'adds a virtual-network link to the Loom hub VNet',
    ],
  },
  {
    key: 'firewallpolicy',
    label: 'Azure Firewall policy',
    armType: 'microsoft.network/firewallpolicies',
    tileSlug: 'network',
    family: 'networking',
    cls: 'adoptable',
    enableFlag: 'firewallEnabled',
    provisionVar: 'provisionFirewallPolicy',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: [],
    usedFor: 'Egress rules for the admin plane.',
    mutations: [
      'adds a uniquely-named Loom rule-collection group in a reserved priority band',
      'does NOT renumber or modify any existing rule collection',
    ],
  },
  {
    key: 'azurefirewall',
    label: 'Azure Firewall (instance)',
    armType: 'microsoft.network/azurefirewalls',
    tileSlug: 'network',
    family: 'networking',
    cls: 'create-only',
    createOnlyReason:
      'Rule-collection-group priority bands collide destructively and there is no safe merge — Loom cannot know which of your existing collections it may renumber. Loom adopts the firewall POLICY by resource id instead (adding its own uniquely-named rule-collection group in a reserved priority band) and deploys its own firewall instance.',
    enableFlag: 'firewallEnabled',
    provisionVar: 'provisionFirewall',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: [],
    usedFor: 'Egress hardening for the admin plane.',
    mutations: [],
  },
  {
    key: 'keyvault',
    label: 'Key Vault',
    armType: 'microsoft.keyvault/vaults',
    tileSlug: 'key-vault',
    family: 'platform',
    cls: 'create-only',
    createOnlyReason:
      "Loom's Key Vault is the trust root for the MSAL secret, data-plane credentials and cosign material. enableSoftDelete / enablePurgeProtection are one-way settings that cannot be turned on retroactively in a way Loom can guarantee, and adoption would mean Loom writes platform secrets into a vault whose access policies and network ACLs a third party mutates. Loom always deploys its own. (Referencing a customer vault as a read-only source for connection strings is a separate, later capability.)",
    enableFlag: null,
    provisionVar: 'provisionKeyVault',
    roleGuid: CONTRIBUTOR,
    roleName: 'Contributor',
    consoleEnv: [],
    usedFor: 'Stores the MSAL secret, SESSION_SECRET and the Loom Connections credential store.',
    mutations: [],
  },
];

const BY_KEY: Record<string, AdoptableServiceDef> = Object.fromEntries(
  ADOPTION_CATALOG.map((d) => [d.key, d]),
);

/** Look up a catalog entry (undefined for an unknown key). */
export function getServiceDef(key: string): AdoptableServiceDef | undefined {
  return BY_KEY[key];
}

/** Human label for a key (falls back to the raw key). */
export function serviceLabel(key: string): string {
  return BY_KEY[key]?.label ?? key;
}

/**
 * Every distinct ARM type discovery must query, deduped and lower-cased.
 *
 * This is the ONLY place the ARG type list comes from — `discovery-model.ts`
 * generates its `type in~ (...)` literal from this function so a catalog entry
 * can never be added without the scanner looking for it. A hand-maintained
 * second list is exactly how `maps`, `postgres` and `storage` ended up offered
 * in the wizard but absent from the deploy.
 */
export function adoptionArmTypes(): string[] {
  return Array.from(new Set(ADOPTION_CATALOG.map((d) => d.armType))).sort();
}

/**
 * Catalog entries that share an ARM type, in catalog order. Used by the row →
 * candidate mapper to disambiguate by `armKindFilter` (a Cognitive Services
 * account is `foundry` only when its kind is AIServices).
 */
export function defsForArmType(armType: string): AdoptableServiceDef[] {
  const t = (armType || '').toLowerCase();
  return ADOPTION_CATALOG.filter((d) => d.armType === t);
}

/**
 * Resolve a discovered ARM row (type + optional resource `kind`) to the catalog
 * key it is a candidate for, or null when the row is not an adoption candidate.
 *
 * A kind-filtered def only claims a row whose `kind` matches; a row of a
 * kind-filtered ARM type that matches NO filter (e.g. a Speech account) is
 * correctly not a candidate rather than being mis-filed under `foundry`.
 */
export function armRowToServiceKey(armType: string, resourceKind?: string): string | null {
  const matches = defsForArmType(armType);
  if (matches.length === 0) return null;
  const k = (resourceKind || '').toLowerCase();
  const filtered = matches.find((d) => d.armKindFilter && k.includes(d.armKindFilter));
  if (filtered) return filtered.key;
  return matches.find((d) => !d.armKindFilter)?.key ?? null;
}

/** Services the operator may choose to adopt (excludes create-only). */
export function adoptableServices(): AdoptableServiceDef[] {
  return ADOPTION_CATALOG.filter((d) => d.cls !== 'create-only');
}
