/**
 * shared-services — the single source of truth for the Setup Wizard's
 * "adopt existing shared service" discovery + validation step (D6).
 *
 * Each entry maps one reusable shared Azure service to:
 *   - the ARM resource type Azure Resource Graph scans for (kept byte-identical
 *     to scripts/csa-loom/discover-services.sh's scan() list so the UI and the
 *     shell wizard never drift),
 *   - an optional Resource Graph `kind`/`properties` filter,
 *   - the canonical `EXISTING_*` env-var triple (name/rg/sub) consumed by the
 *     bicepparam `readEnvironmentVariable(...)` block, byo-wizard.sh, and the
 *     post-deploy grant/patch scripts,
 *   - the matching `existing<Svc>` bicep parameter names so a "reuse" choice in
 *     the wizard flows straight into `az deployment sub create -p existing*=…`
 *     (generalising the loomPurviewAccount-already-exists pattern), and
 *   - validation hints (whether region-match matters hard, whether deploy-new is
 *     gated — e.g. Purview is one-per-tenant).
 *
 * This module is imported by:
 *   - app/api/setup/discover-services/route.ts  (the ARG scan)
 *   - app/api/setup/validate-service/route.ts   (honest per-service checks)
 *   - lib/panes/setup-wizard.tsx                (the discovery step UI)
 *
 * No Fabric: every service here is Azure-native (per no-fabric-dependency.md).
 * Discovery never offers or requires a Fabric capacity/workspace.
 */

export type SharedServiceKey =
  | 'purview'
  | 'law'
  | 'keyvault'
  | 'aoai'
  | 'gateway'
  | 'aiSearch'
  | 'apim'
  | 'adx';

/** A candidate resource discovered via Azure Resource Graph. */
export interface ServiceCandidate {
  name: string;
  rg: string;
  subscriptionId: string;
  /** Azure region (location) the resource lives in. */
  region: string;
  /** SKU tier/name where ARG projects one (else ''). */
  sku: string;
  /** ARM `kind` where applicable (e.g. AIServices/OpenAI for Cognitive). */
  kind: string;
  /** Full ARM resource id — used by validate-service for the permission probe. */
  id: string;
}

/** How a per-service choice resolves at deploy time. */
export type ServiceMode = 'reuse' | 'new' | 'gate';

/** Result of one validation check. */
export interface ServiceCheck {
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface ServiceDescriptor {
  key: SharedServiceKey;
  label: string;
  /** The item-type-visual key for the icon chip (itemVisual()). */
  visual: string;
  /** ARM resource type for the Resource Graph scan (lowercased compare). */
  armType: string;
  /**
   * Optional ARG filter on `kind` / `properties`. When set, only rows matching
   * it are bucketed into this service (e.g. AOAI = Cognitive accounts whose
   * kind is AIServices or OpenAI). Evaluated client-side in the route over the
   * projected row, so the single ARG query stays one round-trip.
   */
  kindMatch?: (kind: string) => boolean;
  /** Canonical EXISTING_* env-var triple (matches byo-wizard.sh + bicepparam). */
  env: { name: string; rg: string; sub: string };
  /**
   * The `existing<Svc>` bicep parameter names a reuse choice emits. `sub` is
   * optional (Purview's data-plane is account-host addressed, sub-agnostic).
   */
  bicep: { name: string; rg: string; sub?: string };
  /**
   * When true, deploying a NEW instance is hard-gated because the service is
   * one-per-tenant — the wizard pins the choice to "reuse" if a candidate
   * exists (Purview: EnterpriseTenantAlreadyExists).
   */
  oneePerTenant?: boolean;
  /** When true, a region mismatch is a hard FAIL rather than a WARN. */
  regionHard?: boolean;
  /** Short human note shown on the option card. */
  note: string;
}

export const SHARED_SERVICES: ServiceDescriptor[] = [
  {
    key: 'purview',
    label: 'Microsoft Purview',
    visual: 'purview-account',
    armType: 'microsoft.purview/accounts',
    env: { name: 'EXISTING_PURVIEW', rg: 'EXISTING_PURVIEW_RG', sub: 'EXISTING_PURVIEW_SUB' },
    bicep: { name: 'existingPurviewAccount', rg: 'existingPurviewRg', sub: 'existingPurviewSub' },
    oneePerTenant: true,
    note: 'One Purview account per tenant — reuse the existing one (a second deploy fails with EnterpriseTenantAlreadyExists).',
  },
  {
    key: 'law',
    label: 'Log Analytics workspace',
    visual: 'monitor',
    armType: 'microsoft.operationalinsights/workspaces',
    env: { name: 'EXISTING_LAW', rg: 'EXISTING_LAW_RG', sub: 'EXISTING_LAW_SUB' },
    bicep: { name: 'existingLogAnalyticsWorkspace', rg: 'existingLogAnalyticsRg', sub: 'existingLogAnalyticsSub' },
    note: 'Reuse a central Log Analytics workspace for diagnostics + the LAW→Event Hubs→ADX live feed.',
  },
  {
    key: 'keyvault',
    label: 'Key Vault',
    visual: 'key-vault',
    armType: 'microsoft.keyvault/vaults',
    env: { name: 'EXISTING_KEYVAULT', rg: 'EXISTING_KEYVAULT_RG', sub: 'EXISTING_KEYVAULT_SUB' },
    bicep: { name: 'existingKeyVaultName', rg: 'existingKeyVaultRg', sub: 'existingKeyVaultSub' },
    note: 'Reuse an existing Key Vault for Loom secrets / CMK instead of provisioning a new one.',
  },
  {
    key: 'aoai',
    label: 'Azure OpenAI / AI Services',
    visual: 'foundry',
    armType: 'microsoft.cognitiveservices/accounts',
    kindMatch: (k) => {
      const v = (k || '').toLowerCase();
      return v === 'aiservices' || v === 'openai';
    },
    env: { name: 'EXISTING_AOAI', rg: 'EXISTING_AOAI_RG', sub: 'EXISTING_AOAI_SUB' },
    bicep: { name: 'existingFoundryAccountName', rg: 'existingFoundryRg', sub: 'existingFoundrySub' },
    note: 'Reuse an existing AOAI / AI Services account that already has chat + embeddings deployments.',
  },
  {
    key: 'gateway',
    label: 'Application Gateway / Front Door',
    visual: 'gateway',
    armType: 'microsoft.network/applicationgateways',
    env: { name: 'EXISTING_GATEWAY', rg: 'EXISTING_GATEWAY_RG', sub: 'EXISTING_GATEWAY_SUB' },
    bicep: { name: 'existingGatewayName', rg: 'existingGatewayRg', sub: 'existingGatewaySub' },
    note: 'Reuse an existing Application Gateway (or Front Door) for ingress instead of provisioning one.',
  },
  {
    key: 'aiSearch',
    label: 'AI Search',
    visual: 'ai-search-index',
    armType: 'microsoft.search/searchservices',
    env: { name: 'EXISTING_AI_SEARCH_SERVICE', rg: 'EXISTING_AI_SEARCH_RG', sub: 'EXISTING_AI_SEARCH_SUB' },
    bicep: { name: 'existingAiSearchService', rg: 'existingAiSearchRg', sub: 'existingAiSearchSub' },
    note: 'Reuse an existing Azure AI Search service for RAG indexes.',
  },
  {
    key: 'apim',
    label: 'API Management',
    visual: 'api',
    armType: 'microsoft.apimanagement/service',
    env: { name: 'EXISTING_APIM', rg: 'EXISTING_APIM_RG', sub: 'EXISTING_APIM_SUB' },
    bicep: { name: 'existingApimName', rg: 'existingApimRg', sub: 'existingApimSub' },
    note: 'Reuse an existing APIM instance as the AI gateway / facade.',
  },
  {
    key: 'adx',
    label: 'Azure Data Explorer (ADX)',
    visual: 'kql-database',
    armType: 'microsoft.kusto/clusters',
    env: { name: 'EXISTING_KUSTO_CLUSTER', rg: 'EXISTING_KUSTO_RG', sub: 'EXISTING_KUSTO_SUB' },
    bicep: { name: 'existingAdxClusterName', rg: 'existingAdxClusterRg', sub: 'existingAdxClusterSub' },
    note: 'Reuse an existing ADX/Kusto cluster for the eventhouse / KQL surfaces.',
  },
];

/** The union of ARM types the single ARG discovery query scans for. */
export const SHARED_SERVICE_ARM_TYPES: string[] = SHARED_SERVICES.map((s) => s.armType);

/** Look up a descriptor by key (undefined for unknown keys). */
export function serviceByKey(key: string): ServiceDescriptor | undefined {
  return SHARED_SERVICES.find((s) => s.key === key);
}

/** Bucket a raw ARG row (type already lowercased) into a service key, or null. */
export function bucketRowToService(typeLower: string, kind: string): SharedServiceKey | null {
  for (const svc of SHARED_SERVICES) {
    if (svc.armType !== typeLower) continue;
    if (svc.kindMatch && !svc.kindMatch(kind)) continue;
    return svc.key;
  }
  return null;
}

/** The per-service choice the wizard captures and threads into the deploy payload. */
export interface ServiceChoice {
  mode: ServiceMode;
  candidate?: ServiceCandidate;
  checks?: ServiceCheck[];
  /** Worst status across checks — drives the inline MessageBar intent. */
  worst?: 'pass' | 'warn' | 'fail';
}

/**
 * Translate the wizard's serviceChoices into the canonical EXISTING_* env map
 * the deploy route forwards to the orchestrator and renders into the
 * `az deployment sub create` command. Only `reuse` choices with a candidate
 * emit values; `new`/`gate` leave the triple empty (provision-new / honest-gate).
 */
export function choicesToExistingEnv(
  choices: Partial<Record<SharedServiceKey, ServiceChoice>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!choices) return out;
  for (const svc of SHARED_SERVICES) {
    const c = choices[svc.key];
    if (!c || c.mode !== 'reuse' || !c.candidate?.name) continue;
    out[svc.env.name] = c.candidate.name;
    out[svc.env.rg] = c.candidate.rg || '';
    out[svc.env.sub] = c.candidate.subscriptionId || '';
  }
  return out;
}

/**
 * Translate the wizard's serviceChoices into `existing<Svc>` bicep `-p` param
 * assignments (one array of `name='value'` strings) for the copy-paste deploy
 * command. Mirrors choicesToExistingEnv but uses the bicep param names.
 */
export function choicesToBicepParams(
  choices: Partial<Record<SharedServiceKey, ServiceChoice>> | undefined,
): string[] {
  const out: string[] = [];
  if (!choices) return out;
  for (const svc of SHARED_SERVICES) {
    const c = choices[svc.key];
    if (!c || c.mode !== 'reuse' || !c.candidate?.name) continue;
    out.push(`${svc.bicep.name}='${c.candidate.name}'`);
    out.push(`${svc.bicep.rg}='${c.candidate.rg || ''}'`);
    if (svc.bicep.sub) out.push(`${svc.bicep.sub}='${c.candidate.subscriptionId || ''}'`);
  }
  return out;
}
