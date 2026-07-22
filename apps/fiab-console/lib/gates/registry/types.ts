/**
 * R30 — shared types + ARM options-loader presets for the gate registry
 * fragment directory (formerly the top of the lib/gates/registry.ts monolith).
 * Fragments import ONLY from this module — never from ../registry (the index)
 * — per the barrel-cycle rule (WS-E1 gotcha).
 */
import type {
  AuditCategory,
  AuditSeverity,
  Avail,
  CheckResult,
  ServiceAvailability,
} from '@/lib/admin/env-checks';

export type FixitKind = 'env-picker' | 'resource-picker' | 'role-grant' | 'wizard';

/**
 * A REAL ARM options-loader for one env var of a gate: the resolve dialog
 * enumerates live resources in the deployment's subscription(s) so the
 * operator PICKS from what actually exists instead of typing.
 */
export interface GateOptionsLoader {
  /**
   * ARM resource type enumerated at subscription scope, e.g.
   * 'Microsoft.Synapse/workspaces'. Executed by GET /api/admin/gates/[id]/options
   * as `GET /subscriptions/{sub}/resources?$filter=resourceType eq '<type>'`.
   */
  armType: string;
  /**
   * Which field of the ARM resource becomes the env value:
   *   'name' | 'id' — from the list response directly;
   *   'properties.<path>' — requires a per-resource GET (the options route
   *   fetches each resource with `armApiVersion`, bounded).
   */
  valueFrom: 'name' | 'id' | `properties.${string}`;
  /** api-version for the per-resource GET when valueFrom needs properties. */
  armApiVersion?: string;
  /** Restrict to resources whose `kind` matches (e.g. OpenAI/AIServices). */
  kindFilter?: string[];
  /**
   * Special multi-step loader: 'aoai-deployments' lists model deployments
   * across the subscription's OpenAI/AIServices accounts (accounts list →
   * per-account deployments list). Overrides armType enumeration.
   */
  special?: 'aoai-deployments';
}

export interface GateRequiredSetting {
  /** The env var this setting writes (whitelisted via EDITABLE_ENV). */
  envVar: string;
  /** What the value is / does (from VALUE_HINT + the spec). */
  description: string;
  /** Placeholder / example value. */
  valueHint: string;
  /** Members of the same anyOf group (setting ANY one satisfies the gate). */
  aliasOf?: string[];
  /** True when part of a `required` group (vs an anyOf alternative). */
  required: boolean;
  /** Live ARM discovery for the Fix-it picker (absent → free-text input). */
  loader?: GateOptionsLoader;
}

export interface GateFixit {
  kind: FixitKind;
  /**
   * For 'role-grant' / 'wizard': the one-time operator action that cannot be
   * a pure env write (RBAC grant, tenant consent). The dialog shows the
   * pre-filled fixScript/portalSteps from the self-audit check for these.
   */
  grantNote?: string;
}

export interface GateSurface {
  /** Route or page where the gate fires, e.g. '/copilot', '/api/items/eventstream/*'. */
  path: string;
  /** Human label, e.g. 'Copilot pane', 'Eventstream editor'. */
  label: string;
}

export interface GateDef {
  /** Stable gate id == the ENV_CHECKS spec id (e.g. 'svc-aoai'). */
  id: string;
  title: string;
  category: AuditCategory;
  severity: AuditSeverity;
  /** Where this gate fires in the product. */
  surfaces: GateSurface[];
  /** Every env var / alias group that satisfies the gate. */
  requiredSettings: GateRequiredSetting[];
  /** The exact RBAC role / tenant action needed once values are set. */
  role?: string;
  /** The bicep module that wires these values on a push-button deploy. */
  provisionedBy?: string;
  /** Exact operator remediation (from the self-audit spec). */
  remediation: string;
  docs?: string;
  /**
   * True when a push-button deploy AUTO-fills the values (spec.derived) or the
   * unset state is the fully-functional intended default (spec.optionalDefault)
   * — i.e. ZERO day-one operator input is needed.
   */
  canAutoResolve: boolean;
  autoResolveNote?: string;
  fixit: GateFixit;
  /** Bespoke error codes routes return today for this gate (Phase-1 inventory). */
  legacyCodes: string[];
  /** X2 — structured per-cloud availability of the backing Azure service,
   * passed through verbatim from the ENV_CHECKS spec. Absent = GA everywhere. */
  availability?: ServiceAvailability;
}

/** Live status for a gate — evaluated from the REAL env-presence check (the
 * per-client *ConfigGate() helpers gate on exactly these vars). */
export interface GateStatus {
  id: string;
  /** 'configured'         — every required value present (or auto-resolved default);
   *  'blocked'            — missing values; the surfaces honest-gate with a Fix-it.
   *  'cloud-unavailable'  — X2: the values are missing AND the backing service is
   *                         structurally unavailable in the active cloud — the
   *                         honest bar names the Azure-native/OSS fallback
   *                         (`fallbackNote`) with NO Fix-it (you cannot provision
   *                         the impossible). Distinct from 'blocked'. */
  status: 'configured' | 'blocked' | 'cloud-unavailable';
  /** The underlying audit result (detail, portalSteps, fixScript). */
  check: CheckResult;
  /** Missing env vars (preferred member of each unsatisfied group). */
  missing: string[];
  /** X2 — the service's availability in the ACTIVE cloud (absent = 'ga').
   * 'limited' NEVER gates: the surface renders normally plus a non-blocking
   * info note sourced from `fallbackNote`. */
  availability?: Avail;
  /** X2 — the Azure-native / OSS / Loom-native fallback note for the active
   * cloud (present when availability is 'limited' or 'unavailable'). */
  fallbackNote?: string;
}

// ── per-gate enrichment (surfaces / fixit / legacy codes) ────────────────────
// Every ENV_CHECKS id MUST have an entry here (enforced by the registry test).

export interface GateMeta {
  surfaces: GateSurface[];
  fixit: GateFixit;
  legacyCodes?: string[];
  /** Loaders keyed by env var (merged into requiredSettings). */
  loaders?: Record<string, GateOptionsLoader>;
  autoResolveNote?: string;
}

export const L = {
  synapse: { armType: 'Microsoft.Synapse/workspaces', valueFrom: 'name' } as GateOptionsLoader,
  adxUri: { armType: 'Microsoft.Kusto/clusters', valueFrom: 'properties.uri', armApiVersion: '2023-08-15' } as GateOptionsLoader,
  eventhubs: { armType: 'Microsoft.EventHub/namespaces', valueFrom: 'name' } as GateOptionsLoader,
  storage: { armType: 'Microsoft.Storage/storageAccounts', valueFrom: 'name' } as GateOptionsLoader,
  aisearch: { armType: 'Microsoft.Search/searchServices', valueFrom: 'name' } as GateOptionsLoader,
  aoaiEndpoint: {
    armType: 'Microsoft.CognitiveServices/accounts', valueFrom: 'properties.endpoint',
    armApiVersion: '2023-05-01', kindFilter: ['OpenAI', 'AIServices'],
  } as GateOptionsLoader,
  aoaiDeployment: { armType: 'Microsoft.CognitiveServices/accounts', valueFrom: 'name', special: 'aoai-deployments' } as GateOptionsLoader,
  aoaiAccount: {
    armType: 'Microsoft.CognitiveServices/accounts', valueFrom: 'name',
    armApiVersion: '2023-05-01', kindFilter: ['OpenAI', 'AIServices'],
  } as GateOptionsLoader,
  databricks: { armType: 'Microsoft.Databricks/workspaces', valueFrom: 'properties.workspaceUrl', armApiVersion: '2024-05-01' } as GateOptionsLoader,
  adf: { armType: 'Microsoft.DataFactory/factories', valueFrom: 'name' } as GateOptionsLoader,
  purview: { armType: 'Microsoft.Purview/accounts', valueFrom: 'name' } as GateOptionsLoader,
  cosmos: { armType: 'Microsoft.DocumentDB/databaseAccounts', valueFrom: 'properties.documentEndpoint', armApiVersion: '2024-05-15' } as GateOptionsLoader,
  law: { armType: 'Microsoft.OperationalInsights/workspaces', valueFrom: 'id' } as GateOptionsLoader,
  lawCustomerId: { armType: 'Microsoft.OperationalInsights/workspaces', valueFrom: 'properties.customerId', armApiVersion: '2023-09-01' } as GateOptionsLoader,
  maps: { armType: 'Microsoft.Maps/accounts', valueFrom: 'properties.uniqueId', armApiVersion: '2023-06-01' } as GateOptionsLoader,
  acaEnv: { armType: 'Microsoft.App/managedEnvironments', valueFrom: 'id' } as GateOptionsLoader,
  acaEnvDomain: { armType: 'Microsoft.App/managedEnvironments', valueFrom: 'properties.defaultDomain', armApiVersion: '2024-03-01' } as GateOptionsLoader,
  grafana: { armType: 'Microsoft.Dashboard/grafana', valueFrom: 'properties.endpoint', armApiVersion: '2023-09-01' } as GateOptionsLoader,
  sqlServer: { armType: 'Microsoft.Sql/servers', valueFrom: 'properties.fullyQualifiedDomainName', armApiVersion: '2023-08-01-preview' } as GateOptionsLoader,
  aas: { armType: 'Microsoft.AnalysisServices/servers', valueFrom: 'properties.serverFullName', armApiVersion: '2017-08-01' } as GateOptionsLoader,
  aml: { armType: 'Microsoft.MachineLearningServices/workspaces', valueFrom: 'name' } as GateOptionsLoader,
  apim: { armType: 'Microsoft.ApiManagement/service', valueFrom: 'name' } as GateOptionsLoader,
  keyvault: { armType: 'Microsoft.KeyVault/vaults', valueFrom: 'properties.vaultUri', armApiVersion: '2023-07-01' } as GateOptionsLoader,
  servicebus: { armType: 'Microsoft.ServiceBus/namespaces', valueFrom: 'name' } as GateOptionsLoader,
  adt: { armType: 'Microsoft.DigitalTwins/digitalTwinsInstances', valueFrom: 'properties.hostName', armApiVersion: '2023-01-31' } as GateOptionsLoader,
  batch: { armType: 'Microsoft.Batch/batchAccounts', valueFrom: 'name' } as GateOptionsLoader,
  pgFqdn: { armType: 'Microsoft.DBforPostgreSQL/flexibleServers', valueFrom: 'properties.fullyQualifiedDomainName', armApiVersion: '2023-12-01-preview' } as GateOptionsLoader,
  cosmosAccountName: { armType: 'Microsoft.DocumentDB/databaseAccounts', valueFrom: 'name' } as GateOptionsLoader,
  appConfig: { armType: 'Microsoft.AppConfiguration/configurationStores', valueFrom: 'properties.endpoint', armApiVersion: '2023-03-01' } as GateOptionsLoader,
};
