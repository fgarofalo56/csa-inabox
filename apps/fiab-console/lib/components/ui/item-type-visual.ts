/**
 * item-type-visual — the single visual registry for Loom item types.
 *
 * Maps every Loom / Fabric / Azure item-type slug to a stable
 * `{ icon, color, label }` triple so tiles, list rows, data-table cells,
 * and headers all render the *same* glyph + brand color for a given type.
 *
 * This is the typed, component-friendly companion to the existing
 * `lib/components/item-type-icon.tsx` (which returns coloured `ReactNode`s
 * for the workspace tree). Here we return the icon *component* + a resolved
 * color string + a human label, which is what tile/card/grid primitives want.
 *
 * Color families (mirrors the catalog WorkloadCategory palette):
 *   data-eng / warehouse → blue·green   RTI → orange
 *   science / ML         → purple       governance / APIs → teal
 *
 * ── Atlas Diag icon API (OPTIONAL) ────────────────────────────────────────
 * The operator's Atlas Diag service can serve per-type raster/SVG icons.
 * `iconUrl(type)` returns a URL when `NEXT_PUBLIC_LOOM_ICON_BASE` is set,
 * else `undefined`. It is a *progressive enhancement* only — every consumer
 * MUST fall back to the bundled Fluent icon from `itemVisual().icon`. There
 * is no hard dependency on Atlas; the registry is fully standalone.
 */

import type { FluentIcon } from '@fluentui/react-icons';
import {
  // Data engineering / lakehouse
  Notebook24Regular, Database24Regular, Box24Regular, CodeBlock24Regular,
  // Data factory
  Flow24Regular, ArrowSwap24Regular, ArrowDownload24Regular,
  Link24Regular, BranchFork24Regular, CloudFlow24Regular,
  // Data warehouse / databases
  Server24Regular, DatabaseLink24Regular, ServerLink24Regular,
  // Real-time
  Flash24Regular, DataLine24Regular, DataHistogram24Regular,
  Pulse24Regular, BoardSplit24Regular, Filter24Regular,
  // Data science / ML
  Bot24Regular, Sparkle24Regular, BrainCircuit24Regular, BeakerEdit24Regular,
  Beaker24Regular,
  // Fabric IQ / agents
  ChatMultiple24Regular, Map24Regular, TextBulletListTree24Regular,
  ClipboardTaskListLtr24Regular, BotSparkle24Regular,
  // Power BI
  ChartMultiple24Regular, DataPie24Regular, Layer24Regular, DataTreemap24Regular,
  Gauge24Regular, DocumentBulletList24Regular,
  // APIs / functions
  PlugConnected24Regular, Globe24Regular, Code24Regular, AppsList24Regular,
  // Catalog / metastores
  Cloud24Regular, ShieldTask24Regular,
  // AI Foundry
  Cube24Regular, ShieldCheckmark24Regular, BranchRequestRegular,
  Search24Regular, DesktopFlow24Regular,
  // Copilot Studio / Power Platform
  BookGlobe24Regular, ChatBubblesQuestion24Regular, PuzzlePiece24Regular,
  Channel24Regular, ChartPerson24Regular, Library24Regular, Apps24Regular,
  Table24Regular, AppFolder24Regular,
  // Geo / graph / vector
  Diversity24Regular, Branch24Regular, Earth24Regular, VirtualNetwork24Regular,
  PersonChat24Regular,
  // Connectables (Add-existing import)
  LockClosed24Regular,
  // Fallback
  Document24Regular,
} from '@fluentui/react-icons';

/** A family groups item types so they share a brand color. */
export type ItemFamily =
  | 'data-eng'
  | 'data-factory'
  | 'warehouse'
  | 'database'
  | 'rti'
  | 'science'
  | 'fabric-iq'
  | 'powerbi'
  | 'api'
  | 'synapse'
  | 'databricks'
  | 'foundry'
  | 'copilot'
  | 'power-platform'
  | 'geo'
  | 'graph'
  | 'data-product'
  | 'neutral';

/**
 * Family → brand color. Static hex (not Fluent tokens) so the swatch reads
 * identically in light + dark — matches the catalog tile palette.
 */
export const FAMILY_COLOR: Record<ItemFamily, string> = {
  'data-eng':       '#0050b3', // blue
  'data-factory':   '#0078d4', // bright blue
  'warehouse':      '#117865', // green
  'database':       '#1a7f4e', // green
  'rti':            '#c2410c', // orange
  'science':        '#7c3aed', // purple
  'fabric-iq':      '#4b1d8f', // deep purple
  'powerbi':        '#ad6800', // amber
  'api':            '#0d7377', // teal
  'synapse':        '#1a1342', // navy
  'databricks':     '#b91c4b', // red-pink
  'foundry':        '#7c3aed', // purple
  'copilot':        '#c2410c', // orange
  'power-platform': '#0d7377', // teal
  'geo':            '#0d7377', // teal
  'graph':          '#5e4dc0', // violet
  'data-product':   '#3d2e80', // deep violet
  'neutral':        '#6b7280', // grey fallback
};

export interface ItemVisual {
  /** Fluent icon *component* (24px regular). */
  icon: FluentIcon;
  /** Resolved brand color (hex) for this type, via its family. */
  color: string;
  /** Family bucket the type belongs to. */
  family: ItemFamily;
  /** Human-friendly label (Title Case from the slug if not overridden). */
  label: string;
}

interface Entry {
  icon: FluentIcon;
  family: ItemFamily;
  /** Override label; otherwise derived from the slug. */
  label?: string;
}

/**
 * slug → { icon, family }. Slugs match `lib/catalog/fabric-item-types.ts`
 * plus the Azure-service aliases used by the service navigators.
 */
const REGISTRY: Record<string, Entry> = {
  // ── Data Engineering ──────────────────────────────────────────────
  'lakehouse':            { icon: Database24Regular,  family: 'data-eng', label: 'Lakehouse' },
  'materialized-lake-view': { icon: Layer24Regular,   family: 'data-eng', label: 'Materialized Lake View' },
  'notebook':             { icon: Notebook24Regular,  family: 'data-eng', label: 'Notebook' },
  'spark-job-definition': { icon: CodeBlock24Regular, family: 'data-eng', label: 'Spark Job Definition' },
  'environment':          { icon: Box24Regular,       family: 'data-eng', label: 'Environment' },

  // ── Data Factory ──────────────────────────────────────────────────
  'data-pipeline':      { icon: Flow24Regular,         family: 'data-factory', label: 'Data Pipeline' },
  'dataflow':           { icon: CloudFlow24Regular,    family: 'data-factory', label: 'Dataflow' },
  'copy-job':           { icon: ArrowDownload24Regular, family: 'data-factory', label: 'Copy Job' },
  'mirrored-database':  { icon: ArrowSwap24Regular,    family: 'data-factory', label: 'Mirrored Database' },
  'mirrored-databricks':{ icon: ArrowSwap24Regular,    family: 'data-factory', label: 'Mirrored Databricks' },
  'mounted-adf':        { icon: Link24Regular,         family: 'data-factory', label: 'Mounted ADF' },
  'dbt-job':            { icon: BranchFork24Regular,   family: 'data-factory', label: 'dbt Job' },
  'airflow-job':        { icon: BranchFork24Regular,   family: 'data-factory', label: 'Airflow Job' },

  // ── Data Warehouse / Databases ───────────────────────────────────
  'warehouse':          { icon: Server24Regular,       family: 'warehouse', label: 'Warehouse' },
  'sql-database':       { icon: DatabaseLink24Regular, family: 'database',  label: 'SQL Database' },

  // ── Real-Time Intelligence ───────────────────────────────────────
  'eventhouse':         { icon: DataLine24Regular,      family: 'rti', label: 'Eventhouse' },
  'kql-database':       { icon: Flash24Regular,         family: 'rti', label: 'KQL Database' },
  'kql-queryset':       { icon: Filter24Regular,        family: 'rti', label: 'KQL Queryset' },
  'kql-dashboard':      { icon: DataHistogram24Regular, family: 'rti', label: 'KQL Dashboard' },
  'eventstream':        { icon: Pulse24Regular,         family: 'rti', label: 'Eventstream' },
  'event-schema-set':   { icon: BoardSplit24Regular,    family: 'rti', label: 'Event Schema Set' },
  'activator':          { icon: Pulse24Regular,         family: 'rti', label: 'Activator' },
  'eventhub':           { icon: Pulse24Regular,         family: 'rti', label: 'Event Hub' },
  'azure-eventhub':     { icon: Pulse24Regular,         family: 'rti', label: 'Azure Event Hub' },

  // ── Data Science / ML ────────────────────────────────────────────
  'ml-model':           { icon: BrainCircuit24Regular,  family: 'science', label: 'ML Model' },
  'ml-experiment':      { icon: BeakerEdit24Regular,    family: 'science', label: 'ML Experiment' },
  'automl':             { icon: Sparkle24Regular,       family: 'science', label: 'AutoML' },

  // ── Fabric IQ ────────────────────────────────────────────────────
  'ontology':           { icon: TextBulletListTree24Regular, family: 'fabric-iq', label: 'Ontology' },
  'graph-model':        { icon: Diversity24Regular,           family: 'fabric-iq', label: 'Graph Model' },
  'plan':               { icon: ClipboardTaskListLtr24Regular, family: 'fabric-iq', label: 'Plan' },
  'map':                { icon: Map24Regular,                 family: 'fabric-iq', label: 'Map' },
  'data-agent':         { icon: ChatMultiple24Regular,        family: 'fabric-iq', label: 'Data Agent' },
  'operations-agent':   { icon: Bot24Regular,                 family: 'fabric-iq', label: 'Operations Agent' },

  // ── Power BI ─────────────────────────────────────────────────────
  'semantic-model':     { icon: Layer24Regular,            family: 'powerbi', label: 'Semantic Model' },
  'report':             { icon: ChartMultiple24Regular,    family: 'powerbi', label: 'Report' },
  'dashboard':          { icon: Gauge24Regular,            family: 'powerbi', label: 'Dashboard' },
  'paginated-report':   { icon: DocumentBulletList24Regular, family: 'powerbi', label: 'Paginated Report' },
  'scorecard':          { icon: DataTreemap24Regular,      family: 'powerbi', label: 'Scorecard' },

  // ── APIs / functions ─────────────────────────────────────────────
  'graphql-api':        { icon: Globe24Regular,         family: 'api', label: 'GraphQL API' },
  'user-data-function': { icon: Code24Regular,          family: 'api', label: 'User Data Function' },
  'variable-library':   { icon: AppsList24Regular,      family: 'api', label: 'Variable Library' },
  'apim-api':           { icon: PlugConnected24Regular, family: 'api', label: 'API Management API' },
  'apim-product':       { icon: DataPie24Regular,       family: 'api', label: 'APIM Product' },
  'apim-policy':        { icon: ShieldCheckmark24Regular, family: 'api', label: 'APIM Policy' },

  // ── Synapse / Databricks / ADF ───────────────────────────────────
  'synapse-dedicated-sql-pool':  { icon: Server24Regular,     family: 'synapse', label: 'Synapse Dedicated SQL Pool' },
  'synapse-serverless-sql-pool': { icon: Server24Regular,     family: 'synapse', label: 'Synapse Serverless SQL Pool' },
  'synapse-spark-pool':          { icon: ServerLink24Regular, family: 'synapse', label: 'Synapse Spark Pool' },
  'synapse-pipeline':            { icon: Flow24Regular,       family: 'synapse', label: 'Synapse Pipeline' },
  'databricks-notebook':         { icon: Notebook24Regular,   family: 'databricks', label: 'Databricks Notebook' },
  'databricks-job':              { icon: BranchFork24Regular, family: 'databricks', label: 'Databricks Job' },
  'databricks-cluster':          { icon: ServerLink24Regular, family: 'databricks', label: 'Databricks Cluster' },
  'databricks-sql-warehouse':    { icon: Server24Regular,     family: 'databricks', label: 'Databricks SQL Warehouse' },
  'adf-pipeline':                { icon: Flow24Regular,       family: 'data-factory', label: 'ADF Pipeline' },
  'adf-dataset':                 { icon: Table24Regular,      family: 'data-factory', label: 'ADF Dataset' },
  'adf-trigger':                 { icon: Pulse24Regular,      family: 'data-factory', label: 'ADF Trigger' },
  'stream-analytics-job':        { icon: Pulse24Regular,      family: 'rti',          label: 'Stream Analytics Job' },

  // ── AI Foundry ───────────────────────────────────────────────────
  'ai-foundry-hub':       { icon: Cube24Regular,           family: 'foundry', label: 'AI Foundry Hub' },
  'ai-foundry-project':   { icon: BranchRequestRegular,    family: 'foundry', label: 'AI Foundry Project' },
  'prompt-flow':          { icon: Flow24Regular,           family: 'foundry', label: 'Prompt Flow' },
  'evaluation':           { icon: Beaker24Regular,         family: 'foundry', label: 'Evaluation' },
  'content-safety':       { icon: ShieldCheckmark24Regular, family: 'foundry', label: 'Content Safety' },
  'tracing':              { icon: DesktopFlow24Regular,    family: 'foundry', label: 'Tracing' },
  'ai-search-index':      { icon: Search24Regular,         family: 'foundry', label: 'AI Search Index' },
  'compute':              { icon: ServerLink24Regular,     family: 'foundry', label: 'Compute' },
  'dataset':              { icon: Table24Regular,          family: 'foundry', label: 'Dataset' },

  // ── Copilot Studio ───────────────────────────────────────────────
  'copilot-studio-agent':     { icon: BotSparkle24Regular,         family: 'copilot', label: 'Copilot Studio Agent' },
  'copilot-studio-knowledge': { icon: BookGlobe24Regular,          family: 'copilot', label: 'Copilot Studio Knowledge' },
  'copilot-studio-topic':     { icon: ChatBubblesQuestion24Regular, family: 'copilot', label: 'Copilot Studio Topic' },
  'copilot-studio-action':    { icon: PuzzlePiece24Regular,        family: 'copilot', label: 'Copilot Studio Action' },
  'copilot-studio-channel':   { icon: Channel24Regular,            family: 'copilot', label: 'Copilot Studio Channel' },
  'copilot-studio-analytics': { icon: ChartPerson24Regular,        family: 'copilot', label: 'Copilot Studio Analytics' },
  'copilot-template-library': { icon: Library24Regular,            family: 'copilot', label: 'Copilot Template Library' },
  'cross-item-copilot':       { icon: BotSparkle24Regular,         family: 'copilot', label: 'Cross-Item Copilot' },

  // ── Power Platform ───────────────────────────────────────────────
  'powerplatform-environment': { icon: AppFolder24Regular, family: 'power-platform', label: 'Power Platform Environment' },
  'dataverse-table':           { icon: Table24Regular,     family: 'power-platform', label: 'Dataverse Table' },
  'power-app':                 { icon: Apps24Regular,      family: 'power-platform', label: 'Power App' },
  'power-automate-flow':       { icon: Flow24Regular,      family: 'power-platform', label: 'Power Automate Flow' },
  'power-page':                { icon: Globe24Regular,     family: 'power-platform', label: 'Power Page' },
  'ai-builder-model':          { icon: Sparkle24Regular,   family: 'power-platform', label: 'AI Builder Model' },

  // ── Azure SQL family ─────────────────────────────────────────────
  'azure-sql-server':              { icon: Server24Regular,       family: 'database', label: 'Azure SQL Server' },
  'azure-sql-database':            { icon: DatabaseLink24Regular, family: 'database', label: 'Azure SQL Database' },
  'azure-sql-managed-instance':    { icon: ServerLink24Regular,   family: 'database', label: 'Azure SQL Managed Instance' },
  'sql-server-2025-vector-index':  { icon: PersonChat24Regular,   family: 'database', label: 'SQL Server 2025 Vector Index' },

  // ── Cosmos DB ────────────────────────────────────────────────────
  'azure-cosmos-account':   { icon: Cube24Regular,     family: 'database', label: 'Azure Cosmos Account' },
  'cosmos-account':         { icon: Cube24Regular,     family: 'database', label: 'Cosmos Account' },
  'cosmos-database':        { icon: Database24Regular, family: 'database', label: 'Cosmos Database' },
  'cosmos-container':       { icon: Box24Regular,      family: 'database', label: 'Cosmos Container' },
  'cosmos-gremlin-graph':   { icon: Diversity24Regular, family: 'graph',   label: 'Cosmos Gremlin Graph' },

  // ── Geoanalytics ─────────────────────────────────────────────────
  'geo-map':       { icon: Map24Regular,    family: 'geo', label: 'Geo Map' },
  'geo-dataset':   { icon: Earth24Regular,  family: 'geo', label: 'Geo Dataset' },
  'geo-query':     { icon: Filter24Regular, family: 'geo', label: 'Geo Query' },
  'geo-pipeline':  { icon: Flow24Regular,   family: 'geo', label: 'Geo Pipeline' },

  // ── Graph + Vector ───────────────────────────────────────────────
  'cypher-graph':  { icon: Branch24Regular,         family: 'graph', label: 'Cypher Graph' },
  'gql-graph':     { icon: VirtualNetwork24Regular, family: 'graph', label: 'GQL Graph' },
  'vector-store':  { icon: Cube24Regular,           family: 'graph', label: 'Vector Store' },

  // ── CSA data products ────────────────────────────────────────────
  'data-product':           { icon: Cube24Regular, family: 'data-product', label: 'Data Product' },
  'data-product-template':  { icon: Cube24Regular, family: 'data-product', label: 'Data Product Template' },
  'data-product-instance':  { icon: Cube24Regular, family: 'data-product', label: 'Data Product Instance' },

  // ── Catalog metastores / accounts ────────────────────────────────
  'unity-catalog':     { icon: DatabaseLink24Regular,   family: 'databricks', label: 'Unity Catalog' },
  'onelake-workspace': { icon: Cloud24Regular,          family: 'data-eng',   label: 'OneLake Workspace' },
  'purview-account':   { icon: ShieldTask24Regular,     family: 'api',        label: 'Purview Account' },

  // ── Connection source types (the /connections "Add existing" picker) ──
  'postgres':          { icon: Database24Regular,       family: 'database', label: 'PostgreSQL' },
  'storage-adls':      { icon: Cloud24Regular,          family: 'data-eng', label: 'ADLS / Storage' },
  'event-hub':         { icon: Pulse24Regular,          family: 'rti',      label: 'Event Hubs' },
  'service-bus':       { icon: Channel24Regular,        family: 'rti',      label: 'Service Bus' },
  'key-vault':         { icon: LockClosed24Regular,     family: 'api',      label: 'Key Vault' },
};

/** Derive a Title Case label from a slug ("kql-database" → "Kql Database"). */
function labelFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Resolve the visual for an item type. Always returns a usable value:
 * unknown slugs fall back to a neutral Document glyph.
 */
export function itemVisual(type: string | null | undefined): ItemVisual {
  const slug = (type ?? '').toLowerCase().trim();
  const entry = REGISTRY[slug];
  if (entry) {
    return {
      icon: entry.icon,
      color: FAMILY_COLOR[entry.family],
      family: entry.family,
      label: entry.label ?? labelFromSlug(slug),
    };
  }
  return {
    icon: Document24Regular,
    color: FAMILY_COLOR.neutral,
    family: 'neutral',
    label: slug ? labelFromSlug(slug) : 'Item',
  };
}

/** True when the registry explicitly knows this slug (not a fallback). */
export function isKnownItemType(type: string | null | undefined): boolean {
  return !!REGISTRY[(type ?? '').toLowerCase().trim()];
}

/** Number of slugs the registry explicitly covers (QA/debug). */
export const COVERED_ITEM_TYPE_COUNT = Object.keys(REGISTRY).length;

/**
 * OPTIONAL Atlas Diag icon URL hook (progressive enhancement).
 *
 * Returns a per-type icon URL when `NEXT_PUBLIC_LOOM_ICON_BASE` is configured
 * (e.g. the Atlas Diag icon API), otherwise `undefined`. Consumers MUST treat
 * the URL as optional and always fall back to `itemVisual(type).icon`.
 *
 *   const { icon: FallbackIcon } = itemVisual(type);
 *   const url = iconUrl(type);
 *   return url ? <img src={url} alt="" /> : <FallbackIcon />;
 */
export function iconUrl(type: string | null | undefined): string | undefined {
  const base =
    typeof process !== 'undefined'
      ? process.env.NEXT_PUBLIC_LOOM_ICON_BASE
      : undefined;
  if (!base || !type) return undefined;
  const slug = type.toLowerCase().trim();
  return `${base.replace(/\/$/, '')}/${encodeURIComponent(slug)}.svg`;
}
