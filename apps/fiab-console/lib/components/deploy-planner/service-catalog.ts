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

/**
 * A single configurable knob for a planned resource. Constrained-choice only
 * (per .claude/rules — no freeform JSON config): `select` renders a Dropdown
 * whose options are the EXACT `@allowed` set on the backing bicep module
 * param, `number` renders a SpinButton bounded by the module's
 * `@minValue`/`@maxValue`, and `text` is reserved for genuinely-freeform Azure
 * fields (e.g. a Linux runtime string) validated by `pattern`.
 *
 * `bicepParam` is the top-level main.bicep parameter the deploy-planner emitter
 * writes this value into; main.bicep forwards it to the module (so export →
 * `az deployment sub create` actually applies the SKU/tier/runtime choice and
 * does not drift — see no-vaporware.md "Bicep sync").
 */
export interface ConfigField {
  /** Sub-key under PlanSubscription.serviceConfigs[serviceKey]. */
  key: string;
  label: string;
  type: 'select' | 'number' | 'text';
  /** Allowed values for `select` — MUST mirror the module's @allowed list. */
  allowed?: string[];
  /** Bounds for `number` — MUST mirror the module's @minValue/@maxValue. */
  min?: number;
  max?: number;
  /** Default value (also the module default) shown when nothing is set. */
  default: ConfigValue;
  /** Regex a `text` value must match (Azure naming/runtime constraint). */
  pattern?: string;
  /** Top-level main.bicep param this value is emitted into. */
  bicepParam: string;
  /**
   * How the value is rendered in the .bicepparam: 'int' (bare) or 'string'
   * (quoted). Defaults to 'int' for type==='number', else 'string'. Override
   * for a numeric-looking select whose bicep param is an int (e.g. storage GB).
   */
  emit?: 'int' | 'string';
  /** One-line helper shown under the control. */
  help?: string;
}

export type ConfigValue = string | number;

/**
 * A representative meter on the public Azure Retail Prices API
 * (https://prices.azure.com/api/retail/prices) used to compute a best-effort
 * monthly estimate for a planned service. The cost-estimate route scopes the
 * query by `serviceName` + region + Consumption price type (the values that are
 * safe to pin case-sensitively per the 2023-01-01-preview contract), then
 * refines the returned rows with the case-INSENSITIVE `match` / `exclude`
 * substring hints and picks the lowest qualifying retail price. This is honest
 * about being a single representative SKU — never an exact bill (see `unitNote`).
 */
export interface RetailMeter {
  /** Exact, case-sensitive Azure Retail Prices `serviceName` (scopes the query). */
  serviceName: string;
  /** Optional exact ARM SKU name to pin (e.g. 'Standard_D2s_v5'). */
  armSkuName?: string;
  /** Case-insensitive substrings a candidate row's sku/meter/product must contain. */
  match?: string[];
  /** Case-insensitive substrings that disqualify a candidate row. */
  exclude?: string[];
  /** Quantity multiplier for the normalized monthly unit (default 1). */
  defaultMonthlyQty?: number;
  /** Honest note about the representative SKU/quantity the estimate assumes. */
  unitNote: string;
}

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
  /**
   * Constrained-choice config knobs for this resource (SKU/tier/runtime), each
   * mapped 1:1 to a real main.bicep param. Present only for toggleable services
   * whose bicep module exposes @allowed knobs. Core / plan-only services have
   * none (a config knob there would be a fake — see no-vaporware.md).
   */
  config?: ConfigField[];
  /**
   * Representative public-retail-price meter for the cost estimator, or omitted
   * when no single representative SKU is meaningful (usage-metered / abstract /
   * tenant-gated services render as "not estimated" honestly).
   */
  retail?: RetailMeter;
  /** azure.microsoft.com/pricing/details deep-link for this service's row. */
  pricingDetailsUrl?: string;
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
  { key: 'appService', label: 'App Service', category: 'compute', bicepFlag: 'appServiceEnabled',
    glyph: Globe24Regular, icon: 'App-Services.png', color: '#0078d4',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/app-service/linux/',
    retail: { serviceName: 'Azure App Service', match: ['B1'], exclude: ['Windows', 'Isolated', 'Premium'],
      unitNote: 'Basic B1 Linux plan · 730 hrs/mo (1 instance)' },
    description: 'PaaS web app / API hosting (Linux B1 plan + web app, HTTPS-only).',
    config: [
      { key: 'planSku', label: 'Plan SKU', type: 'select', allowed: ['B1', 'B2', 'S1', 'P0v3', 'P1v3'],
        default: 'B1', bicepParam: 'appServicePlanSku', help: 'B1 is the cheapest functional Linux dedicated tier.' },
      { key: 'linuxFxVersion', label: 'Runtime stack', type: 'text', default: 'NODE|20-lts',
        pattern: '^[A-Za-z0-9.+_-]+\\|[A-Za-z0-9.+_-]+$', bicepParam: 'appServiceLinuxFxVersion',
        help: 'Linux runtime e.g. NODE|20-lts, DOTNETCORE|8.0, PYTHON|3.12.' },
    ] },
  { key: 'functions', label: 'Azure Functions', category: 'compute', bicepFlag: 'functionsEnabled',
    glyph: Code24Regular, icon: 'Function-Apps.png', color: '#0078d4',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/functions/',
    description: 'Serverless event-driven compute (Consumption Linux plan + backing storage).',
    config: [
      { key: 'workerRuntime', label: 'Worker runtime', type: 'select', allowed: ['node', 'python', 'dotnet-isolated', 'java'],
        default: 'node', bicepParam: 'functionsWorkerRuntime' },
      { key: 'linuxFxVersion', label: 'Runtime version', type: 'text', default: 'Node|20',
        pattern: '^[A-Za-z0-9.+_-]+\\|[A-Za-z0-9.+_-]+$', bicepParam: 'functionsLinuxFxVersion',
        help: 'e.g. Node|20, Python|3.12, DOTNET-ISOLATED|8.0, Java|17.' },
    ] },
  { key: 'containerInstances', label: 'Container Instances', category: 'compute', bicepFlag: 'containerInstancesEnabled',
    glyph: Box24Regular, icon: 'Container-Instances.png', color: '#0078d4',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/container-instances/',
    description: 'Single-shot serverless containers (sample image group, start/stop-able).' },
  { key: 'vm', label: 'Virtual Machines', category: 'compute', bicepFlag: 'vmEnabled',
    glyph: Server24Regular, icon: 'Virtual-Machine.png', color: '#0078d4',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/virtual-machines/linux/',
    retail: { serviceName: 'Virtual Machines', armSkuName: 'Standard_D2s_v5',
      exclude: ['Spot', 'Low Priority', 'Windows'],
      unitNote: 'Standard_D2s_v5 Linux on-demand · 730 hrs/mo (excludes OS disk + egress)' },
    description: 'Linux IaaS VM (isolated VNet/subnet + NIC, no public IP, SSH-key auth, managed OS disk).' },
  { key: 'batch', label: 'Azure Batch', category: 'compute', bicepFlag: 'batchEnabled',
    glyph: AppsList24Regular, color: '#0078d4',
    description: 'Large-scale parallel + HPC batch compute (BatchService mode + managed-identity auto-storage).' },
  { key: 'logicApps', label: 'Logic Apps', category: 'compute', bicepFlag: 'logicAppsEnabled',
    glyph: Flow24Regular, icon: 'Logic-Apps.png', color: '#0078d4',
    description: 'Low-code workflow automation (Consumption Logic App, empty editable workflow).' },
  { key: 'staticWebApps', label: 'Static Web Apps', category: 'compute', bicepFlag: 'staticWebAppsEnabled',
    glyph: Apps24Regular, color: '#0078d4',
    description: 'Globally-distributed static front-ends + managed APIs (standalone, no repo link).' },

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
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/data-explorer/',
    retail: { serviceName: 'Azure Data Explorer', match: ['Markup'], exclude: [],
      unitNote: 'Standard engine cluster markup per vCore-hour · 730 hrs/mo (markup only — excludes the underlying VM + storage meters; a small dev cluster runs ~$80–320/mo all-in)' },
    description: 'Real-time analytics (KQL) for Eventstream + realtime hub.' },
  { key: 'cosmos', label: 'Cosmos DB', category: 'data', bicepFlag: null,
    glyph: Cube24Regular, icon: 'Azure-Cosmos-DB.png', color: '#117865',
    description: 'Loom item/state store. Core — always deployed.' },
  { key: 'sql', label: 'Azure SQL Database', category: 'data', bicepFlag: null,
    glyph: DatabaseLink24Regular, icon: 'Azure-SQL.png', color: '#117865',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/azure-sql-database/single/',
    retail: { serviceName: 'SQL Database', match: ['S0'], exclude: ['Managed', 'Hyperscale', 'Elastic'],
      unitNote: 'Single DB Standard S0 (10 DTU) · 730 hrs/mo' },
    description: 'Relational store for SQL-database items.' },
  { key: 'sqlMi', label: 'SQL Managed Instance', category: 'data', bicepFlag: null, planOnly: true,
    glyph: ServerLink24Regular, color: '#117865',
    description: 'Near-100% SQL Server compatibility, fully managed. Plan-only — needs a delegated subnet + ~hours-long provision, so it is not a single self-contained toggle.' },
  { key: 'postgres', label: 'PostgreSQL Flexible', category: 'data', bicepFlag: 'postgresEnabled',
    glyph: Database24Regular, color: '#117865',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/postgresql/flexible-server/',
    retail: { serviceName: 'Azure Database for PostgreSQL', match: ['B1ms'], exclude: ['Windows'],
      unitNote: 'Flexible Server Burstable B1ms compute · 730 hrs/mo (excludes storage + backup)' },
    description: 'Managed PostgreSQL (flexible server, Entra-only auth) + starter DB.',
    config: [
      { key: 'version', label: 'PostgreSQL version', type: 'select', allowed: ['13', '14', '15', '16'],
        default: '16', bicepParam: 'postgresVersion' },
      { key: 'storageSizeGB', label: 'Storage (GB)', type: 'select', allowed: ['32', '64', '128', '256', '512'],
        default: '32', emit: 'int', bicepParam: 'postgresStorageSizeGB' },
    ] },
  { key: 'mysql', label: 'MySQL Flexible', category: 'data', bicepFlag: 'mysqlEnabled',
    glyph: Database24Regular, color: '#117865',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/mysql/flexible-server/',
    retail: { serviceName: 'Azure Database for MySQL', match: ['B1ms'], exclude: ['Windows'],
      unitNote: 'Flexible Server Burstable B1ms compute · 730 hrs/mo (excludes storage + backup)' },
    description: 'Managed MySQL (flexible server) + starter DB.',
    config: [
      { key: 'version', label: 'MySQL version', type: 'select', allowed: ['5.7', '8.0.21'],
        default: '8.0.21', bicepParam: 'mysqlVersion' },
      { key: 'storageSizeGB', label: 'Storage (GB)', type: 'number', min: 20, max: 16384,
        default: 20, bicepParam: 'mysqlStorageSizeGB', help: '20–16384 GB.' },
    ] },
  { key: 'redis', label: 'Cache for Redis', category: 'data', bicepFlag: 'redisEnabled',
    glyph: DataHistogram24Regular, color: '#117865',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/cache/',
    retail: { serviceName: 'Redis Cache', match: ['C0'], exclude: ['Premium', 'Enterprise'],
      unitNote: 'Basic C0 (250 MB) · 730 hrs/mo' },
    description: 'In-memory cache / session store (Basic C0, Entra auth enabled).',
    config: [
      { key: 'skuName', label: 'SKU', type: 'select', allowed: ['Basic', 'Standard', 'Premium'],
        default: 'Basic', bicepParam: 'redisSkuName',
        help: 'Basic = single node; Standard = replicated; Premium = clustering + persistence. The family + capacity are set automatically to a valid pairing.' },
    ] },
  { key: 'fabricCapacity', label: 'Fabric Capacity (F-SKU)', category: 'data', bicepFlag: null, planOnly: true,
    glyph: Layer24Regular, color: '#117865',
    description: 'Microsoft Fabric capacity backing the Loom workspace. Plan-only — F-SKU + Fabric tenant admin gating, not a self-contained sub-deployment toggle.' },
  { key: 'streamAnalytics', label: 'Stream Analytics', category: 'data', bicepFlag: 'streamAnalyticsEnabled',
    glyph: DataPie24Regular, color: '#117865',
    description: 'Real-time stream processing (SQL-like). Job created Stopped, ready to edit.' },
  { key: 'dataFactory', label: 'Data Factory', category: 'data', bicepFlag: 'dataFactoryEnabled',
    glyph: CloudFlow24Regular, color: '#117865',
    description: 'Cloud ETL/ELT orchestration (factory for the ADF Pipeline/Dataset/Trigger editors).' },
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
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/search/',
    retail: { serviceName: 'Azure Cognitive Search', match: ['Standard S1'], exclude: ['CC'],
      unitNote: 'Standard S1 search unit · 730 hrs/mo (1 replica × 1 partition)' },
    description: 'Vector + keyword index for RAG over Loom items.' },
  { key: 'defenderForAI', label: 'Defender for AI', category: 'ai', bicepFlag: 'defenderForAIEnabled',
    glyph: ShieldCheckmark24Regular, color: '#7c3aed',
    description: 'Threat protection + prompt-shield for AI workloads.' },
  { key: 'mlWorkspace', label: 'Azure Machine Learning', category: 'ai', bicepFlag: 'mlWorkspaceEnabled',
    glyph: Bot24Regular, icon: 'Machine-Learning-Studio-(Classic)-Web-Services.png', color: '#7c3aed',
    description: 'AML workspace for training + MLOps (provisions its KV/Storage/AppInsights dependencies).' },
  { key: 'aiServices', label: 'Azure AI Services (multi)', category: 'ai', bicepFlag: 'aiServicesEnabled',
    glyph: Sparkle24Regular, icon: 'Azure-Applied-AI-Services.png', color: '#7c3aed',
    description: 'Multi-service Cognitive Services account (Entra-only, custom subdomain).' },
  { key: 'documentIntelligence', label: 'Document Intelligence', category: 'ai', bicepFlag: 'documentIntelligenceEnabled',
    glyph: DocumentTable24Regular, color: '#7c3aed',
    description: 'OCR + document extraction (FormRecognizer account, Entra-only).' },
  { key: 'visionServices', label: 'Computer Vision', category: 'ai', bicepFlag: 'visionServicesEnabled',
    glyph: Eye24Regular, color: '#7c3aed',
    description: 'Image analysis + OCR (single-kind ComputerVision Cognitive Services account, Entra-only).' },
  { key: 'speechServices', label: 'Speech Services', category: 'ai', bicepFlag: 'speechServicesEnabled',
    glyph: Mic24Regular, color: '#7c3aed',
    description: 'Speech-to-text, TTS, translation (single-kind SpeechServices account, Entra-only).' },
  { key: 'languageServices', label: 'Language Services', category: 'ai', bicepFlag: 'languageServicesEnabled',
    glyph: Translate24Regular, color: '#7c3aed',
    description: 'Text analytics, entity + sentiment (single-kind TextAnalytics account, Entra-only).' },
  { key: 'contentSafety', label: 'Content Safety', category: 'ai', bicepFlag: 'contentSafetyEnabled',
    glyph: ShieldCheckmark24Regular, color: '#7c3aed',
    description: 'Moderates text + image for harmful content (ContentSafety account, Entra-only).' },

  // ─────────────────────── integration ──────────────────────────────
  { key: 'apim', label: 'API Management', category: 'integration', bicepFlag: 'apimEnabled',
    glyph: PlugConnected24Regular, icon: 'API-Management-Services.png', color: '#e3008c',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/api-management/',
    retail: { serviceName: 'API Management', match: ['Developer'], exclude: ['Self Hosted Gateway', 'Consumption'],
      unitNote: 'Developer tier unit · 730 hrs/mo (non-production, no SLA)' },
    description: 'API gateway fronting data + AI APIs.' },
  { key: 'eventhubs', label: 'Event Hubs', category: 'integration', bicepFlag: null,
    glyph: Pulse24Regular, icon: 'Event-Hubs.png', color: '#e3008c',
    description: 'Streaming ingestion for Eventstream sources.' },
  { key: 'eventGrid', label: 'Event Grid', category: 'integration', bicepFlag: 'eventGridEnabled',
    glyph: BoardSplit24Regular, icon: 'Event-Grid-Topics.png', color: '#e3008c',
    description: 'Pub/sub event routing across Azure (custom topic, local-auth disabled).' },
  { key: 'serviceBus', label: 'Service Bus', category: 'integration', bicepFlag: 'serviceBusEnabled',
    glyph: MailInbox24Regular, color: '#e3008c',
    description: 'Enterprise messaging (Standard namespace, SAS disabled) + starter queue/topic.' },
  { key: 'storageQueues', label: 'Storage Queues', category: 'integration', bicepFlag: 'storageQueuesEnabled',
    glyph: ArrowRouting24Regular, color: '#e3008c',
    description: 'Simple durable message queue on Storage (shared-key disabled) + starter queue.' },
  { key: 'signalr', label: 'SignalR / Web PubSub', category: 'integration', bicepFlag: 'signalrEnabled',
    glyph: Group24Regular, color: '#e3008c',
    description: 'Real-time websocket fan-out (SignalR Standard_S1, AAD-only).' },
  { key: 'businessProcess', label: 'Business Process Tracking', category: 'integration', bicepFlag: null, planOnly: true,
    glyph: ArrowRouting24Regular, icon: 'Business-Process-Tracking.png', color: '#e3008c',
    description: 'Track long-running business transactions. Plan-only — a preview capability layered on a Standard Logic App + tracking store, not a single self-contained resource.' },

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
  { key: 'defenderCloud', label: 'Defender for Cloud', category: 'governance', bicepFlag: 'defenderCloudEnabled',
    glyph: Shield24Regular, color: '#0b6a0b',
    description: 'CSPM + workload protection plans (sets subscription Microsoft.Security pricing tiers to Standard).' },
  { key: 'policy', label: 'Azure Policy / Blueprints', category: 'governance', bicepFlag: 'policyEnabled',
    glyph: ClipboardTaskListLtr24Regular, color: '#0b6a0b',
    description: 'Compliance guardrails (sample built-in audit policy assigned at the subscription scope).' },
  { key: 'managedIdentity', label: 'Managed Identity', category: 'governance', bicepFlag: null,
    glyph: ShieldCheckmark24Regular, color: '#0b6a0b',
    description: 'User-assigned identity for service-to-service auth. Core.' },

  // ───────────────────── networking & edge ──────────────────────────
  { key: 'vnet', label: 'Virtual Network', category: 'networking', bicepFlag: null,
    glyph: VirtualNetwork24Regular, color: '#004578',
    description: 'Landing-zone VNet + subnets. Core where private networking is on.' },
  { key: 'privateEndpoints', label: 'Private Endpoints', category: 'networking', bicepFlag: null, planOnly: true,
    glyph: Connector24Regular, color: '#004578',
    description: 'Private Link endpoints for PaaS data planes. Plan-only — each endpoint needs a target resource id + the specific groupId/subresource, so it is provisioned per-target, not as a standalone toggle.' },
  { key: 'privateDns', label: 'Private DNS Zones', category: 'networking', bicepFlag: null, planOnly: true,
    glyph: Earth24Regular, color: '#004578',
    description: 'Private DNS for Private Link resolution. Plan-only — zone name + VNet links are derived from the specific Private Endpoints being created, so it is provisioned alongside them rather than standalone.' },
  { key: 'appGateway', label: 'Application Gateway', category: 'networking', bicepFlag: 'appGatewayEnabled',
    glyph: Router24Regular, icon: 'Application-Gateways.png', color: '#004578',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/application-gateway/',
    retail: { serviceName: 'Application Gateway', match: ['Standard', 'Fixed'], exclude: ['Basic', 'WAF'],
      unitNote: 'Standard_v2 fixed gateway-hour · 730 hrs/mo (excludes per-capacity-unit + data processing)' },
    description: 'WAF + L7 ingress for the console.' },
  { key: 'frontDoor', label: 'Front Door', category: 'networking', bicepFlag: 'frontDoorEnabled',
    glyph: GlobeShield24Regular, icon: 'Front-Door-and-CDN-Profiles.png', color: '#004578',
    description: 'Global edge + WAF (Commercial).' },
  { key: 'cdn', label: 'CDN Profile', category: 'networking', bicepFlag: 'cdnEnabled',
    glyph: Globe24Regular, icon: 'CDN-Profiles.png', color: '#004578',
    description: 'Content delivery / edge cache (Standard Microsoft CDN profile; endpoints added from the navigator).' },
  { key: 'vpnGateway', label: 'VPN Gateway', category: 'networking', bicepFlag: 'vpnGatewayEnabled',
    glyph: ArrowBidirectionalUpDown24Regular, color: '#004578',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/vpn-gateway/',
    retail: { serviceName: 'VPN Gateway', match: ['VpnGw1'], exclude: ['VpnGw1AZ', 'VpnGw2', 'VpnGw3', 'VpnGw4', 'VpnGw5', 'P2S', 'Connection'],
      unitNote: 'VpnGw1 gateway-hour · 730 hrs/mo (excludes S2S/P2S connection + egress)' },
    description: 'Hybrid connectivity into the landing zone.' },
  { key: 'loadBalancer', label: 'Load Balancer', category: 'networking', bicepFlag: 'loadBalancerEnabled',
    glyph: ArrowRouting24Regular, icon: 'Load-Balancers.png', color: '#004578',
    description: 'Internal Standard L4 load balancer (isolated VNet/subnet + frontend/pool/probe/rule).' },
  { key: 'firewall', label: 'Azure Firewall', category: 'networking', bicepFlag: 'firewallEnabled',
    glyph: Shield24Regular, color: '#004578',
    pricingDetailsUrl: 'https://azure.microsoft.com/pricing/details/azure-firewall/',
    retail: { serviceName: 'Azure Firewall', match: ['Standard', 'Deployment'], exclude: ['Premium', 'Basic', 'Hub', 'Data Processed'],
      unitNote: 'Standard deployment-hour · 730 hrs/mo (excludes per-GB data processing)' },
    description: 'Managed stateful firewall (Standard AZFW_VNet in its own VNet with AzureFirewallSubnet + static public IP).' },
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

/**
 * Distinct retail meters for the given service keys — what the cost-estimate
 * route queries against the public Azure Retail Prices API. Returns one entry
 * per service-key that has a representative meter (deduped by key).
 */
export function metersForServices(keys: string[]): Array<{ key: string; label: string; category: ServiceCategory; meter: RetailMeter; pricingDetailsUrl?: string }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; label: string; category: ServiceCategory; meter: RetailMeter; pricingDetailsUrl?: string }> = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    const def = BY_KEY.get(k);
    if (def?.retail) out.push({ key: def.key, label: def.label, category: def.category, meter: def.retail, pricingDetailsUrl: def.pricingDetailsUrl });
  }
  return out;
}

/** QA/debug — how many distinct service types the catalog covers. */
export const SERVICE_COUNT = SERVICE_CATALOG.length;
/** How many of those have a real one-button bicep toggle. */
export const TOGGLEABLE_SERVICE_COUNT = SERVICE_CATALOG.filter((s) => s.bicepFlag).length;

/** The config schema for a service key, or [] if it exposes no knobs. */
export function configFor(key: string): ConfigField[] {
  return BY_KEY.get(key)?.config ?? [];
}

/** How many services expose configurable knobs (for QA / tests). */
export const CONFIGURABLE_SERVICE_COUNT = SERVICE_CATALOG.filter((s) => s.config?.length).length;

/**
 * Validate + coerce one raw value against a ConfigField. Returns the coerced
 * value when valid, or `undefined` when it should be rejected (out of the
 * @allowed set, NaN, out of bounds, or failing the text pattern). This is the
 * single gate shared by the UI and the server sanitizer so neither can write a
 * value the bicep module's @allowed/@minValue would reject.
 */
export function coerceConfigValue(field: ConfigField, raw: unknown): ConfigValue | undefined {
  if (field.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) return undefined;
    const v = Math.round(n);
    if (field.min !== undefined && v < field.min) return undefined;
    if (field.max !== undefined && v > field.max) return undefined;
    return v;
  }
  const sv = String(raw);
  if (field.type === 'select') {
    return field.allowed?.includes(sv) ? sv : undefined;
  }
  // text
  if (sv.length === 0 || sv.length > 256) return undefined;
  if (field.pattern && !new RegExp(field.pattern).test(sv)) return undefined;
  return sv;
}

/** A service's config object filled with each field's default value. */
export function defaultConfig(key: string): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const f of configFor(key)) out[f.key] = f.default;
  return out;
}

/**
 * Resolve the effective value for one field (stored value if valid, else the
 * default). Used by both the panel and the emitter so they always agree.
 */
export function resolveConfigValue(field: ConfigField, stored: Record<string, ConfigValue> | undefined): ConfigValue {
  const raw = stored?.[field.key];
  if (raw === undefined) return field.default;
  const c = coerceConfigValue(field, raw);
  return c === undefined ? field.default : c;
}
