/**
 * Canonical "scan-and-choose" service catalog for the Setup Wizard.
 *
 * This is the single source of truth shared by:
 *   - GET  /api/setup/scan-services        (the cross-subscription Resource Graph scan)
 *   - lib/setup/service-choices-to-params   (choice → bicep param + EXISTING_* env translation)
 *   - lib/panes/setup-wizard.tsx            (the "Services" step UI)
 *   - app/api/setup/deploy                  (threads the chosen wiring into the deploy)
 *
 * It is the TypeScript twin of the `SERVICES` array in
 * scripts/csa-loom/byo-wizard.sh — the two surfaces (CLI + Wizard) MUST agree on
 * the service keys, ARM types, bicep `existing*` param names, the canonical
 * EXISTING_* env names, and the `loom<Svc>Enabled` flags so the scan + the deploy
 * stay in lockstep (ui-parity.md). A vitest pins this in
 * app/api/setup/__tests__/scan-services.test.ts.
 *
 * Every backend is Azure-native (no-fabric-dependency.md). Fabric / Power BI is
 * NOT in this list — it stays opt-in via fabricEnabled, never scanned/recommended.
 *
 * Service keys are a closed enum (loom-no-freeform-config.md): the wizard offers
 * the discovered resources as dropdown picks, never a free-text resource id.
 */

/** The per-service choice the operator makes in the wizard / CLI. */
export type ServiceMode = 'use-existing' | 'new' | 'disable';

/** What the recommendation engine suggests, given what the scan found. */
export type ServiceRecommendation = ServiceMode;

export interface ScanServiceDef {
  /** Stable enum key (matches byo-wizard.sh row key). */
  key: string;
  /** Human label shown in the wizard / CLI. */
  label: string;
  /** Lowercase ARM type for the Resource Graph `type =~ '...'` filter. */
  armType: string;
  /**
   * Optional Resource Graph predicate appended with `and` (e.g. AI Foundry is an
   * AIServices-kind Cognitive Services account). Lowercased operands.
   */
  kindFilter?: string;
  /** Bicep `existing<Svc>Name` param (when the service supports deploy-time reuse). */
  existingNameParam?: string;
  /** Bicep `existing<Svc>Rg` param. */
  existingRgParam?: string;
  /** Bicep `existing<Svc>Sub` param. */
  existingSubParam?: string;
  /** Canonical EXISTING_*  env name (post-deploy patch-navigator-env.sh / readEnvironmentVariable). */
  envName: string;
  /** Canonical EXISTING_*_RG env name. */
  envRg: string;
  /** Canonical EXISTING_*_SUB env name. */
  envSub: string;
  /**
   * Bicep `loom<Svc>Enabled` flag, when the service has a provisioning toggle.
   * Services WITHOUT a flag are DLZ-provisioned with the platform (synapse,
   * cosmos, eventhubs, databricks, adf) — they cannot be "disabled".
   */
  enabledFlag?: string;
  /**
   * Default posture is everything-on (opt-out): when no existing instance is
   * found and the service has a flag, recommend NEW. true for every Azure-native
   * backend.
   */
  defaultOn: boolean;
  /**
   * Reuse-first services. Enterprise Purview is one-per-tenant — provisioning a
   * second fails (EnterpriseTenantAlreadyExists) — so always recommend
   * use-existing when a candidate is found.
   */
  reuseOnly?: boolean;
}

/**
 * The 11 Azure-native backends the Setup Wizard can scan + wire. Order matches
 * byo-wizard.sh's SERVICES array. `existing*` params are present only for the
 * services main.bicep declares them for (verified against
 * platform/fiab/bicep/main.bicep) — Maps has a flag only, so its reuse path is
 * an EXISTING_* env wiring, never an undeclared bicep param.
 */
export const SETUP_SCAN_SERVICES: ScanServiceDef[] = [
  {
    key: 'aisearch',
    label: 'AI Search',
    armType: 'microsoft.search/searchservices',
    existingNameParam: 'existingAiSearchService',
    existingRgParam: 'existingAiSearchRg',
    existingSubParam: 'existingAiSearchSub',
    envName: 'EXISTING_AI_SEARCH_SERVICE',
    envRg: 'EXISTING_AI_SEARCH_RG',
    envSub: 'EXISTING_AI_SEARCH_SUB',
    enabledFlag: 'aiSearchEnabled',
    defaultOn: true,
  },
  {
    key: 'apim',
    label: 'API Management',
    armType: 'microsoft.apimanagement/service',
    existingNameParam: 'existingApimName',
    existingRgParam: 'existingApimRg',
    existingSubParam: 'existingApimSub',
    envName: 'EXISTING_APIM',
    envRg: 'EXISTING_APIM_RG',
    envSub: 'EXISTING_APIM_SUB',
    enabledFlag: 'apimEnabled',
    defaultOn: true,
  },
  {
    key: 'adx',
    label: 'ADX / Kusto',
    armType: 'microsoft.kusto/clusters',
    existingNameParam: 'existingAdxClusterName',
    existingRgParam: 'existingAdxClusterRg',
    existingSubParam: 'existingAdxClusterSub',
    envName: 'EXISTING_KUSTO_CLUSTER',
    envRg: 'EXISTING_KUSTO_RG',
    envSub: 'EXISTING_KUSTO_SUB',
    enabledFlag: 'adxEnabled',
    defaultOn: true,
  },
  {
    key: 'foundry',
    label: 'AI Foundry / AOAI',
    armType: 'microsoft.cognitiveservices/accounts',
    kindFilter: "kind =~ 'AIServices'",
    existingNameParam: 'existingFoundryAccountName',
    existingRgParam: 'existingFoundryRg',
    existingSubParam: 'existingFoundrySub',
    envName: 'EXISTING_AOAI',
    envRg: 'EXISTING_AOAI_RG',
    envSub: 'EXISTING_AOAI_SUB',
    enabledFlag: 'aiFoundryEnabled',
    defaultOn: true,
  },
  {
    key: 'purview',
    label: 'Microsoft Purview',
    armType: 'microsoft.purview/accounts',
    existingNameParam: 'existingPurviewAccount',
    existingRgParam: 'existingPurviewRg',
    existingSubParam: 'existingPurviewSub',
    envName: 'EXISTING_PURVIEW',
    envRg: 'EXISTING_PURVIEW_RG',
    envSub: 'EXISTING_PURVIEW_SUB',
    enabledFlag: 'purviewEnabled',
    defaultOn: true,
    reuseOnly: true,
  },
  {
    key: 'synapse',
    label: 'Synapse Analytics',
    armType: 'microsoft.synapse/workspaces',
    existingNameParam: 'existingSynapseWorkspace',
    existingRgParam: 'existingSynapseRg',
    existingSubParam: 'existingSynapseSub',
    envName: 'EXISTING_SYNAPSE',
    envRg: 'EXISTING_SYNAPSE_RG',
    envSub: 'EXISTING_SYNAPSE_SUB',
    // DLZ-provisioned (no enable flag): reuse / new only, never disable.
    defaultOn: true,
  },
  {
    key: 'cosmos',
    label: 'Cosmos DB',
    armType: 'microsoft.documentdb/databaseaccounts',
    existingNameParam: 'existingCosmosAccount',
    existingRgParam: 'existingCosmosRg',
    existingSubParam: 'existingCosmosSub',
    envName: 'EXISTING_COSMOS_ACCOUNT',
    envRg: 'EXISTING_COSMOS_ACCOUNT_RG',
    envSub: 'EXISTING_COSMOS_ACCOUNT_SUB',
    defaultOn: true,
  },
  {
    key: 'adf',
    label: 'Data Factory',
    armType: 'microsoft.datafactory/factories',
    existingNameParam: 'existingAdfFactory',
    existingRgParam: 'existingAdfRg',
    existingSubParam: 'existingAdfSub',
    envName: 'EXISTING_ADF',
    envRg: 'EXISTING_ADF_RG',
    envSub: 'EXISTING_ADF_SUB',
    defaultOn: true,
  },
  {
    key: 'eventhubs',
    label: 'Event Hubs',
    armType: 'microsoft.eventhub/namespaces',
    existingNameParam: 'existingEventHubNamespace',
    existingRgParam: 'existingEventHubRg',
    existingSubParam: 'existingEventHubSub',
    envName: 'EXISTING_EVENTHUB_NAMESPACE',
    envRg: 'EXISTING_EVENTHUB_RG',
    envSub: 'EXISTING_EVENTHUB_SUB',
    defaultOn: true,
  },
  {
    key: 'databricks',
    label: 'Azure Databricks',
    armType: 'microsoft.databricks/workspaces',
    existingNameParam: 'existingDatabricksWorkspace',
    existingRgParam: 'existingDatabricksRg',
    existingSubParam: 'existingDatabricksSub',
    envName: 'EXISTING_DATABRICKS',
    envRg: 'EXISTING_DATABRICKS_RG',
    envSub: 'EXISTING_DATABRICKS_SUB',
    defaultOn: true,
  },
  {
    key: 'maps',
    label: 'Azure Maps',
    armType: 'microsoft.maps/accounts',
    // Maps has a `loom`-style flag but NO existing* bicep params (the account
    // name is computed) — reuse is wired post-deploy via the EXISTING_* env.
    envName: 'EXISTING_AZURE_MAPS',
    envRg: 'EXISTING_AZURE_MAPS_RG',
    envSub: 'EXISTING_AZURE_MAPS_SUB',
    enabledFlag: 'azureMapsEnabled',
    defaultOn: true,
  },
];

/** Lookup by key. */
export const SETUP_SCAN_SERVICE_BY_KEY: Record<string, ScanServiceDef> = Object.fromEntries(
  SETUP_SCAN_SERVICES.map((s) => [s.key, s]),
);

/** Whether a service can be disabled (only services with a provisioning flag). */
export function canDisable(def: ScanServiceDef): boolean {
  return !!def.enabledFlag;
}

/** A discovered candidate resource from the Resource Graph scan. */
export interface ScanCandidate {
  name: string;
  rg: string;
  sub: string;
  region?: string;
}

/** Per-service scan result returned by /api/setup/scan-services. */
export interface ScanServiceResult {
  key: string;
  label: string;
  candidates: ScanCandidate[];
  recommendation: ServiceRecommendation;
  /** The candidate the recommendation points at (use-existing only). */
  recommendedCandidate?: ScanCandidate;
  /** Default posture for this service (everything-on opt-out). */
  defaultOn: boolean;
  /** Whether "disable" is a valid choice (has an enable flag). */
  canDisable: boolean;
}

/**
 * The recommendation engine — pure + deterministic so the BFF route and tests
 * agree. Mirrors byo-wizard.sh's interactive default ("1 = reuse" when a
 * candidate is found, else NEW for default-on services).
 *
 * @param def        the service definition
 * @param candidates discovered instances (already filtered to the service type)
 * @param deploySub  the deploy/admin subscription id — a candidate there is preferred
 */
export function recommendForService(
  def: ScanServiceDef,
  candidates: ScanCandidate[],
  deploySub?: string,
): { recommendation: ServiceRecommendation; recommendedCandidate?: ScanCandidate } {
  if (candidates.length > 0) {
    // Prefer a candidate in the deploy subscription (cheapest to wire, same-sub
    // RBAC), else the first discovered.
    const inSub = deploySub ? candidates.find((c) => c.sub === deploySub) : undefined;
    return { recommendation: 'use-existing', recommendedCandidate: inSub ?? candidates[0] };
  }
  // No existing instance found.
  if (def.reuseOnly) {
    // Reuse-first service with nothing to reuse: provision new when it has a
    // flag (e.g. a tenant with no Enterprise Purview yet), else honest-disable.
    return { recommendation: def.enabledFlag ? 'new' : 'disable' };
  }
  if (def.defaultOn) return { recommendation: 'new' };
  return { recommendation: def.enabledFlag ? 'disable' : 'new' };
}
