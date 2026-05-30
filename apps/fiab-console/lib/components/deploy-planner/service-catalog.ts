/**
 * Deploy-planner service catalog — the Azure services CSA Loom / Fabric-in-a-Box
 * can stand up, each tied to the REAL bicep knob that deploys it
 * (platform/fiab/bicep/main.bicep + params/*.bicepparam). The planner produces
 * a plan whose per-domain service set maps 1:1 onto these flags, and the
 * bicepparam export writes exactly these param names — so the visual plan and
 * `az deployment sub create` stay in sync (per .claude/rules/no-vaporware.md).
 *
 * `bicepFlag: null` = a core service that always deploys (no toggle); it shows
 * in the plan as always-on. `icon` is a file under /public/azure-icons (official
 * Microsoft Azure architecture icons); services without a bundled icon render a
 * branded initial badge until the icon pack is expanded.
 */

export type ServiceCategory =
  | 'compute' | 'data' | 'ai' | 'integration' | 'governance' | 'networking';

export interface ServiceDef {
  key: string;
  label: string;
  category: ServiceCategory;
  /** bicep param that enables it, or null if it is always deployed. */
  bicepFlag: string | null;
  /** /public/azure-icons file, or undefined → initial-badge fallback. */
  icon?: string;
  /** Accent colour (Azure service brand-ish) for swatch + fallback badge. */
  color: string;
  /** Short description shown in the palette tooltip. */
  description: string;
}

export const SERVICE_CATEGORY_ORDER: Array<{ id: ServiceCategory; label: string }> = [
  { id: 'compute', label: 'Compute & apps' },
  { id: 'data', label: 'Data & analytics' },
  { id: 'ai', label: 'AI' },
  { id: 'integration', label: 'Integration' },
  { id: 'governance', label: 'Governance & security' },
  { id: 'networking', label: 'Networking' },
];

export const SERVICE_CATALOG: ServiceDef[] = [
  // ---- compute ----
  { key: 'containerApps', label: 'Container Apps', category: 'compute', bicepFlag: 'deployAppsEnabled',
    icon: 'Container-Apps-Environments.png', color: '#0078d4',
    description: 'Hosts the Loom console + BFF + agent apps (Azure Container Apps).' },
  { key: 'acr', label: 'Container Registry', category: 'compute', bicepFlag: null,
    icon: 'Container-Registries.png', color: '#0078d4',
    description: 'Stores the Loom app images (core — always deployed).' },

  // ---- data ----
  { key: 'storage', label: 'ADLS Gen2 (OneLake)', category: 'data', bicepFlag: null,
    icon: 'Storage-Accounts.png', color: '#107c10',
    description: 'Medallion lake storage (bronze/silver/gold). Core — always deployed.' },
  { key: 'synapse', label: 'Synapse Serverless', category: 'data', bicepFlag: null,
    color: '#1f8a70',
    description: 'Serverless SQL over the lake (OPENROWSET + Delta). Core data plane.' },
  { key: 'databricks', label: 'Azure Databricks', category: 'data', bicepFlag: null,
    color: '#ff3621',
    description: 'Spark engineering + ML. Unity Catalog / SQL Warehouse gated by boundary.' },
  { key: 'adx', label: 'Data Explorer (Eventhouse)', category: 'data', bicepFlag: 'adxEnabled',
    color: '#00a4ef',
    description: 'Real-time analytics (KQL) for Eventstream + realtime hub.' },
  { key: 'cosmos', label: 'Cosmos DB', category: 'data', bicepFlag: null,
    icon: 'Azure-Cosmos-DB.png', color: '#0078d4',
    description: 'Loom item/state store. Core — always deployed.' },
  { key: 'sql', label: 'Azure SQL', category: 'data', bicepFlag: null,
    icon: 'Azure-SQL.png', color: '#0078d4',
    description: 'Relational store for SQL-database items.' },

  // ---- ai ----
  { key: 'aiFoundry', label: 'AI Foundry (Azure OpenAI)', category: 'ai', bicepFlag: 'aiFoundryEnabled',
    icon: 'Azure-OpenAI.png', color: '#7719aa',
    description: 'AI Foundry project + Azure OpenAI deployments for Copilot/agents.' },
  { key: 'aiSearch', label: 'AI Search', category: 'ai', bicepFlag: 'aiSearchEnabled',
    color: '#7719aa',
    description: 'Vector + keyword index for RAG over Loom items.' },

  // ---- integration ----
  { key: 'apim', label: 'API Management', category: 'integration', bicepFlag: 'apimEnabled',
    icon: 'API-Management-Services.png', color: '#e3008c',
    description: 'API gateway fronting data + AI APIs.' },
  { key: 'eventhubs', label: 'Event Hubs', category: 'integration', bicepFlag: null,
    icon: 'Event-Hubs.png', color: '#0078d4',
    description: 'Streaming ingestion for Eventstream sources.' },

  // ---- governance ----
  { key: 'purview', label: 'Microsoft Purview', category: 'governance', bicepFlag: 'purviewEnabled',
    color: '#0b6a0b',
    description: 'Unified catalog + business domains. Reuse tenant Purview where present.' },
  { key: 'keyvault', label: 'Key Vault', category: 'governance', bicepFlag: null,
    icon: 'Key-Vaults.png', color: '#0078d4',
    description: 'Secret + key store. Core — always deployed.' },
  { key: 'logAnalytics', label: 'Log Analytics + Sentinel', category: 'governance', bicepFlag: null,
    color: '#0078d4',
    description: 'Monitoring workspace + Sentinel onboarding. Core — always deployed.' },

  // ---- networking ----
  { key: 'appGateway', label: 'Application Gateway', category: 'networking', bicepFlag: 'appGatewayEnabled',
    icon: 'Application-Gateways.png', color: '#004578',
    description: 'WAF + L7 ingress for the console.' },
  { key: 'frontDoor', label: 'Front Door', category: 'networking', bicepFlag: 'frontDoorEnabled',
    icon: 'Front-Door-and-CDN-Profiles.png', color: '#004578',
    description: 'Global edge + WAF (Commercial).' },
  { key: 'vpnGateway', label: 'VPN Gateway', category: 'networking', bicepFlag: 'vpnGatewayEnabled',
    color: '#004578',
    description: 'Hybrid connectivity into the landing zone.' },
];

const BY_KEY = new Map(SERVICE_CATALOG.map((s) => [s.key, s]));
export function serviceByKey(key: string): ServiceDef | undefined { return BY_KEY.get(key); }
export function servicesByCategory(cat: ServiceCategory): ServiceDef[] {
  return SERVICE_CATALOG.filter((s) => s.category === cat);
}
/** The bicep feature flags that the given service-key set turns on. */
export function flagsForServices(keys: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of keys) {
    const def = BY_KEY.get(k);
    if (def?.bicepFlag) out[def.bicepFlag] = true;
  }
  return out;
}
