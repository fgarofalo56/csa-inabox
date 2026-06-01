/**
 * Deploy-planner service catalog — the Azure service types CSA Loom /
 * Fabric-in-a-Box can plan into a deployment, grouped by category. Each entry
 * is tied to the REAL bicep knob that deploys it where one exists
 * (platform/fiab/bicep/main.bicep + params/*.bicepparam), so the visual plan
 * and `az deployment sub create` stay in sync (per .claude/rules/no-vaporware.md).
 *
 * Three honest deployment states, NOT one:
 *   - `bicepFlag: '<param>'` → a toggleable service; the bicepparam export
 *     writes that param true/false based on the plan.
 *   - `bicepFlag: null`      → a CORE service that always deploys (no toggle).
 *     Shown as "core" and never written as a param.
 *   - `planOnly: true`       → a service Loom can PLAN but does not yet have a
 *     one-button bicep toggle for. It is real Azure, just not auto-provisioned
 *     by main.bicep today. Shown with a "plan-only" badge so nobody mistakes
 *     the tile for an auto-deploy. It never emits a fake bicep param.
 *
 * Icons: every service renders a high-quality Fluent glyph + brand color via
 * `serviceVisual()` (mirrors lib/components/ui/item-type-visual). A bundled
 * official Azure raster icon (`icon`) is used when present; otherwise the
 * Fluent glyph. The OPTIONAL Atlas Diag icon API (`NEXT_PUBLIC_LOOM_ICON_BASE`,
 * via `iconUrl()` from item-type-visual) is a progressive enhancement only —
 * the catalog renders fully standalone with Fluent icons.
 */

import type { FluentIcon } from '@fluentui/react-icons';
import {
  // compute
  Box24Regular, Server24Regular, ServerLink24Regular, AppsList24Regular,
  Apps24Regular, Code24Regular,
  Cube24Regular, Grid24Regular,
  // data & analytics
  Database24Regular, DatabaseLink24Regular, CloudFlow24Regular,
  Flow24Regular, DataLine24Regular, DataHistogram24Regular, DataPie24Regular,
  Layer24Regular, Archive24Regular, DocumentTable24Regular,
  // ai
  BrainCircuit24Regular, Bot24Regular, BotSparkle24Regular, Sparkle24Regular,
  Search24Regular, Eye24Regular, Mic24Regular, Translate24Regular,
  // integration
  PlugConnected24Regular, Pulse24Regular, MailInbox24Regular, BoardSplit24Regular,
  Globe24Regular, ArrowRouting24Regular, Group24Regular,
  // governance & security
  ShieldCheckmark24Regular, ShieldKeyhole24Regular, Key24Regular,
  ClipboardTaskListLtr24Regular, ChartMultiple24Regular, BookGlobe24Regular,
  Shield24Regular, LockClosed24Regular,
  // networking
  VirtualNetwork24Regular, Router24Regular, GlobeShield24Regular,
  Connector24Regular, Earth24Regular, ArrowBidirectionalUpDown24Regular,
  // fallback
  Document24Regular,
} from '@fluentui/react-icons';

export type ServiceCategory =
  | 'compute' | 'data' | 'ai' | 'integration' | 'governance' | 'networking';

export interface ServiceDef {
  key: string;
  label: string;
  category: ServiceCategory;
  /** bicep param that enables it, or null if it is always deployed (core). */
  bicepFlag: string | null;
  /**
   * True when Loom can PLAN this service but has no one-button bicep toggle
   * for it yet. Such services never emit a bicep param (no fake knobs); they
   * surface a "plan-only" badge so the plan is honest about what auto-deploys.
   */
  planOnly?: boolean;
  /** Fluent glyph used as the standalone (no-external-dep) icon. */
  glyph: FluentIcon;
  /** /public/azure-icons file (official Microsoft icon), if one is bundled. */
  icon?: string;
  /** Accent colour (category brand) for the icon chip + fallback badge. */
  color: string;
  /** Short description shown in the tile tooltip. */
  description: string;
}

export const SERVICE_CATEGORY_ORDER: Array<{ id: ServiceCategory; label: string; color: string }> = [
  { id: 'compute',     label: 'Compute & apps',        color: '#0078d4' },
  { id: 'data',        label: 'Data & analytics',      color: '#117865' },
  { id: 'ai',          label: 'AI & machine learning', color: '#7c3aed' },
  { id: 'integration', label: 'Integration & messaging', color: '#e3008c' },
  { id: 'governance',  label: 'Governance & security', color: '#0b6a0b' },
  { id: 'networking',  label: 'Networking & edge',     color: '#004578' },
];

/** Per-category brand colour (icon chip tint + fallback badge). */
export const CATEGORY_COLOR: Record<ServiceCategory, string> = Object.fromEntries(
  SERVICE_CATEGORY_ORDER.map((c) => [c.id, c.color]),
) as Record<ServiceCategory, string>;

export const SERVICE_CATALOG: ServiceDef[] = [
  // ───────────────────────── compute & apps ─────────────────────────
  { key: 'containerApps', label: 'Container Apps', category: 'compute', bicepFlag: 'deployAppsEnabled',
    glyph: Box24Regular, icon: 'Container-Apps-Environments.png', color: '#0078d4',
    description: 'Hosts the Loom console + BFF + agent apps (Azure Container Apps).' },
  { key: 'acr', label: 'Container Registry', category: 'compute', bicepFlag: null,
    glyph: Archive24Regular, icon: 'Container-Registries.png', color: '#0078d4',
    description: 'Stores the Loom app images (core — always deployed).' },
  { key: 'aks', label: 'Kubernetes Service (AKS)', category: 'compute', bicepFlag: 'atlasOnAksEnabled',
    glyph: Grid24Regular, icon: 'Kubernetes-Services.png', color: '#0078d4',
    description: 'Managed Kubernetes — enables the optional Atlas-on-AKS workload.' },
  { key: 'appService', label: 'App Service', category: 'compute', bicepFlag: null, planOnly: true,
    glyph: Globe24Regular, icon: 'App-Services.png', color: '#0078d4',
    description: 'PaaS web app / API hosting. Plan-only — not auto-provisioned today.' },
  { key: 'functions', label: 'Azure Functions', category: 'compute', bicepFlag: null, planOnly: true,
    glyph: Code24Regular, icon: 'Function-Apps.png', color: '#0078d4',
    description: 'Serverless event-driven compute. Plan-only.' },
  { key: 'containerInstances', label: 'Container Instances', category: 'compute', bicepFlag: null, planOnly: true,
    glyph: Box24Regular, icon: 'Container-Instances.png', color: '#0078d4',
    description: 'Single-shot serverless containers. Plan-only.' },
  { key: 'vm', label: 'Virtual Machines', category: 'compute', bicepFlag: null, planOnly: true,
    glyph: Server24Regular, icon: 'Virtual-Machine.png', color: '#0078d4',
    description: 'IaaS VMs / scale sets. Plan-only.' },
  { key: 'batch', label: 'Azure Batch', category: 'compute', bicepFlag: null, planOnly: true,
    glyph: AppsList24Regular, color: '#0078d4',
    description: 'Large-scale parallel + HPC batch compute. Plan-only.' },
  { key: 'logicApps', label: 'Logic Apps', category: 'compute', bicepFlag: null, planOnly: true,
    glyph: Flow24Regular, icon: 'Logic-Apps.png', color: '#0078d4',
    description: 'Low-code workflow automation. Plan-only.' },
  { key: 'staticWebApps', label: 'Static Web Apps', category: 'compute', bicepFlag: null, planOnly: true,
    glyph: Apps24Regular, color: '#0078d4',
    description: 'Globally-distributed static front-ends + managed APIs. Plan-only.' },

  // ─────────────────────── data & analytics ─────────────────────────
  { key: 'storage', label: 'ADLS Gen2 (OneLake)', category: 'data', bicepFlag: null,
    glyph: Archive24Regular, icon: 'Storage-Accounts.png', color: '#117865',
    description: 'Medallion lake storage (bronze/silver/gold). Core — always deployed.' },
  { key: 'synapse', label: 'Synapse Serverless', category: 'data', bicepFlag: null,
    glyph: Server24Regular, color: '#117865',
    description: 'Serverless SQL over the lake (OPENROWSET + Delta). Core data plane.' },
  { key: 'databricks', label: 'Azure Databricks', category: 'data', bicepFlag: null,
    glyph: ServerLink24Regular, color: '#b91c4b',
    description: 'Spark engineering + ML. Unity Catalog / SQL Warehouse gated by boundary.' },
  { key: 'databricksUnity', label: 'Databricks Unity Catalog', category: 'data', bicepFlag: 'databricksUnityCatalogEnabled',
    glyph: BookGlobe24Regular, color: '#b91c4b',
    description: 'Unity Catalog governance metastore for Databricks.' },
  { key: 'databricksSqlWarehouse', label: 'Databricks SQL Warehouse', category: 'data', bicepFlag: 'databricksSqlWarehouseEnabled',
    glyph: Server24Regular, color: '#b91c4b',
    description: 'Serverless SQL warehouse on Databricks.' },
  { key: 'adx', label: 'Data Explorer (Eventhouse)', category: 'data', bicepFlag: 'adxEnabled',
    glyph: DataLine24Regular, color: '#117865',
    description: 'Real-time analytics (KQL) for Eventstream + realtime hub.' },
  { key: 'cosmos', label: 'Cosmos DB', category: 'data', bicepFlag: null,
    glyph: Cube24Regular, icon: 'Azure-Cosmos-DB.png', color: '#117865',
    description: 'Loom item/state store. Core — always deployed.' },
  { key: 'sql', label: 'Azure SQL Database', category: 'data', bicepFlag: null,
    glyph: DatabaseLink24Regular, icon: 'Azure-SQL.png', color: '#117865',
    description: 'Relational store for SQL-database items.' },
  { key: 'sqlMi', label: 'SQL Managed Instance', category: 'data', bicepFlag: null, planOnly: true,
    glyph: ServerLink24Regular, color: '#117865',
    description: 'Near-100% SQL Server compatibility, fully managed. Plan-only.' },
  { key: 'postgres', label: 'PostgreSQL Flexible', category: 'data', bicepFlag: null, planOnly: true,
    glyph: Database24Regular, color: '#117865',
    description: 'Managed PostgreSQL (flexible server). Plan-only.' },
  { key: 'mysql', label: 'MySQL Flexible', category: 'data', bicepFlag: null, planOnly: true,
    glyph: Database24Regular, color: '#117865',
    description: 'Managed MySQL (flexible server). Plan-only.' },
  { key: 'redis', label: 'Cache for Redis', category: 'data', bicepFlag: null, planOnly: true,
    glyph: DataHistogram24Regular, color: '#117865',
    description: 'In-memory cache / session store. Plan-only.' },
  { key: 'fabricCapacity', label: 'Fabric Capacity (F-SKU)', category: 'data', bicepFlag: null, planOnly: true,
    glyph: Layer24Regular, color: '#117865',
    description: 'Microsoft Fabric capacity backing the Loom workspace. Plan-only.' },
  { key: 'streamAnalytics', label: 'Stream Analytics', category: 'data', bicepFlag: null, planOnly: true,
    glyph: DataPie24Regular, color: '#117865',
    description: 'Real-time stream processing (SQL-like). Plan-only.' },
  { key: 'dataFactory', label: 'Data Factory', category: 'data', bicepFlag: null, planOnly: true,
    glyph: CloudFlow24Regular, color: '#117865',
    description: 'Cloud ETL/ELT orchestration. Plan-only.' },
  { key: 'purviewData', label: 'Microsoft Fabric / OneLake catalog', category: 'data', bicepFlag: null,
    glyph: DocumentTable24Regular, color: '#117865',
    description: 'OneLake catalog surfaced in Loom. Core where the lake is deployed.' },

  // ───────────────────────── ai & ML ────────────────────────────────
  { key: 'aiFoundry', label: 'AI Foundry (Azure OpenAI)', category: 'ai', bicepFlag: 'aiFoundryEnabled',
    glyph: BrainCircuit24Regular, icon: 'Azure-OpenAI.png', color: '#7c3aed',
    description: 'AI Foundry project + Azure OpenAI deployments for Copilot/agents.' },
  { key: 'foundryPortal', label: 'AI Foundry Portal', category: 'ai', bicepFlag: 'foundryPortalEnabled',
    glyph: BotSparkle24Regular, color: '#7c3aed',
    description: 'AI Foundry portal experience (hub + projects UI).' },
  { key: 'aiSearch', label: 'AI Search', category: 'ai', bicepFlag: 'aiSearchEnabled',
    glyph: Search24Regular, color: '#7c3aed',
    description: 'Vector + keyword index for RAG over Loom items.' },
  { key: 'defenderForAI', label: 'Defender for AI', category: 'ai', bicepFlag: 'defenderForAIEnabled',
    glyph: ShieldCheckmark24Regular, color: '#7c3aed',
    description: 'Threat protection + prompt-shield for AI workloads.' },
  { key: 'mlWorkspace', label: 'Azure Machine Learning', category: 'ai', bicepFlag: null, planOnly: true,
    glyph: Bot24Regular, icon: 'Machine-Learning-Studio-(Classic)-Web-Services.png', color: '#7c3aed',
    description: 'AML workspace for training + MLOps. Plan-only.' },
  { key: 'aiServices', label: 'Azure AI Services (multi)', category: 'ai', bicepFlag: null, planOnly: true,
    glyph: Sparkle24Regular, icon: 'Azure-Applied-AI-Services.png', color: '#7c3aed',
    description: 'Multi-service Cognitive Services account. Plan-only.' },
  { key: 'documentIntelligence', label: 'Document Intelligence', category: 'ai', bicepFlag: null, planOnly: true,
    glyph: DocumentTable24Regular, color: '#7c3aed',
    description: 'OCR + document extraction (form recognizer). Plan-only.' },
  { key: 'visionServices', label: 'Computer Vision', category: 'ai', bicepFlag: null, planOnly: true,
    glyph: Eye24Regular, color: '#7c3aed',
    description: 'Image analysis + OCR. Plan-only.' },
  { key: 'speechServices', label: 'Speech Services', category: 'ai', bicepFlag: null, planOnly: true,
    glyph: Mic24Regular, color: '#7c3aed',
    description: 'Speech-to-text, TTS, translation. Plan-only.' },
  { key: 'languageServices', label: 'Language Services', category: 'ai', bicepFlag: null, planOnly: true,
    glyph: Translate24Regular, color: '#7c3aed',
    description: 'Text analytics, entity + sentiment, translation. Plan-only.' },
  { key: 'contentSafety', label: 'Content Safety', category: 'ai', bicepFlag: null, planOnly: true,
    glyph: ShieldCheckmark24Regular, color: '#7c3aed',
    description: 'Moderates text + image for harmful content. Plan-only.' },

  // ─────────────────────── integration ──────────────────────────────
  { key: 'apim', label: 'API Management', category: 'integration', bicepFlag: 'apimEnabled',
    glyph: PlugConnected24Regular, icon: 'API-Management-Services.png', color: '#e3008c',
    description: 'API gateway fronting data + AI APIs.' },
  { key: 'eventhubs', label: 'Event Hubs', category: 'integration', bicepFlag: null,
    glyph: Pulse24Regular, icon: 'Event-Hubs.png', color: '#e3008c',
    description: 'Streaming ingestion for Eventstream sources.' },
  { key: 'eventGrid', label: 'Event Grid', category: 'integration', bicepFlag: null, planOnly: true,
    glyph: BoardSplit24Regular, icon: 'Event-Grid-Topics.png', color: '#e3008c',
    description: 'Pub/sub event routing across Azure. Plan-only.' },
  { key: 'serviceBus', label: 'Service Bus', category: 'integration', bicepFlag: null, planOnly: true,
    glyph: MailInbox24Regular, color: '#e3008c',
    description: 'Enterprise messaging (queues + topics). Plan-only.' },
  { key: 'storageQueues', label: 'Storage Queues', category: 'integration', bicepFlag: null, planOnly: true,
    glyph: ArrowRouting24Regular, color: '#e3008c',
    description: 'Simple durable message queue on Storage. Plan-only.' },
  { key: 'signalr', label: 'SignalR / Web PubSub', category: 'integration', bicepFlag: null, planOnly: true,
    glyph: Group24Regular, color: '#e3008c',
    description: 'Real-time websocket fan-out. Plan-only.' },
  { key: 'businessProcess', label: 'Business Process Tracking', category: 'integration', bicepFlag: null, planOnly: true,
    glyph: ArrowRouting24Regular, icon: 'Business-Process-Tracking.png', color: '#e3008c',
    description: 'Track long-running business transactions. Plan-only.' },

  // ─────────────────── governance & security ────────────────────────
  { key: 'purview', label: 'Microsoft Purview', category: 'governance', bicepFlag: 'purviewEnabled',
    glyph: BookGlobe24Regular, color: '#0b6a0b',
    description: 'Unified catalog + business domains. Reuse tenant Purview where present.' },
  { key: 'keyvault', label: 'Key Vault', category: 'governance', bicepFlag: null,
    glyph: Key24Regular, icon: 'Key-Vaults.png', color: '#0b6a0b',
    description: 'Secret + key store. Core — always deployed.' },
  { key: 'logAnalytics', label: 'Log Analytics + Sentinel', category: 'governance', bicepFlag: null,
    glyph: ChartMultiple24Regular, color: '#0b6a0b',
    description: 'Monitoring workspace + Sentinel onboarding. Core — always deployed.' },
  { key: 'loomMip', label: 'MIP Sensitivity Labels', category: 'governance', bicepFlag: 'loomMipEnabled',
    glyph: ShieldKeyhole24Regular, color: '#0b6a0b',
    description: 'Microsoft Purview Information Protection labels on Loom items.' },
  { key: 'loomDlp', label: 'Data Loss Prevention (DLP)', category: 'governance', bicepFlag: 'loomDlpEnabled',
    glyph: LockClosed24Regular, color: '#0b6a0b',
    description: 'Purview DLP policies enforced across Loom.' },
  { key: 'defenderCloud', label: 'Defender for Cloud', category: 'governance', bicepFlag: null, planOnly: true,
    glyph: Shield24Regular, color: '#0b6a0b',
    description: 'CSPM + workload protection plans. Plan-only.' },
  { key: 'policy', label: 'Azure Policy / Blueprints', category: 'governance', bicepFlag: null, planOnly: true,
    glyph: ClipboardTaskListLtr24Regular, color: '#0b6a0b',
    description: 'Compliance guardrails + initiatives. Plan-only.' },
  { key: 'managedIdentity', label: 'Managed Identity', category: 'governance', bicepFlag: null,
    glyph: ShieldCheckmark24Regular, color: '#0b6a0b',
    description: 'User-assigned identity for service-to-service auth. Core.' },

  // ───────────────────── networking & edge ──────────────────────────
  { key: 'vnet', label: 'Virtual Network', category: 'networking', bicepFlag: null,
    glyph: VirtualNetwork24Regular, color: '#004578',
    description: 'Landing-zone VNet + subnets. Core where private networking is on.' },
  { key: 'privateEndpoints', label: 'Private Endpoints', category: 'networking', bicepFlag: null, planOnly: true,
    glyph: Connector24Regular, color: '#004578',
    description: 'Private Link endpoints for PaaS data planes. Plan-only.' },
  { key: 'privateDns', label: 'Private DNS Zones', category: 'networking', bicepFlag: null, planOnly: true,
    glyph: Earth24Regular, color: '#004578',
    description: 'Private DNS for Private Link resolution. Plan-only.' },
  { key: 'appGateway', label: 'Application Gateway', category: 'networking', bicepFlag: 'appGatewayEnabled',
    glyph: Router24Regular, icon: 'Application-Gateways.png', color: '#004578',
    description: 'WAF + L7 ingress for the console.' },
  { key: 'frontDoor', label: 'Front Door', category: 'networking', bicepFlag: 'frontDoorEnabled',
    glyph: GlobeShield24Regular, icon: 'Front-Door-and-CDN-Profiles.png', color: '#004578',
    description: 'Global edge + WAF (Commercial).' },
  { key: 'cdn', label: 'CDN Profile', category: 'networking', bicepFlag: null, planOnly: true,
    glyph: Globe24Regular, icon: 'CDN-Profiles.png', color: '#004578',
    description: 'Content delivery / edge cache. Plan-only.' },
  { key: 'vpnGateway', label: 'VPN Gateway', category: 'networking', bicepFlag: 'vpnGatewayEnabled',
    glyph: ArrowBidirectionalUpDown24Regular, color: '#004578',
    description: 'Hybrid connectivity into the landing zone.' },
  { key: 'loadBalancer', label: 'Load Balancer', category: 'networking', bicepFlag: null, planOnly: true,
    glyph: ArrowRouting24Regular, icon: 'Load-Balancers.png', color: '#004578',
    description: 'L4 load balancing. Plan-only.' },
  { key: 'firewall', label: 'Azure Firewall', category: 'networking', bicepFlag: null, planOnly: true,
    glyph: Shield24Regular, color: '#004578',
    description: 'Managed stateful network firewall. Plan-only.' },
];

const BY_KEY = new Map(SERVICE_CATALOG.map((s) => [s.key, s]));
export function serviceByKey(key: string): ServiceDef | undefined { return BY_KEY.get(key); }
export function servicesByCategory(cat: ServiceCategory): ServiceDef[] {
  return SERVICE_CATALOG.filter((s) => s.category === cat);
}

/** Resolve the icon glyph + color for a service key (always usable). */
export function serviceVisual(key: string): { glyph: FluentIcon; color: string; label: string } {
  const def = BY_KEY.get(key);
  if (def) return { glyph: def.glyph, color: def.color, label: def.label };
  return { glyph: Document24Regular, color: '#6b7280', label: key };
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

/** QA/debug — how many distinct service types the catalog covers. */
export const SERVICE_COUNT = SERVICE_CATALOG.length;
/** How many of those have a real one-button bicep toggle. */
export const TOGGLEABLE_SERVICE_COUNT = SERVICE_CATALOG.filter((s) => s.bicepFlag).length;
