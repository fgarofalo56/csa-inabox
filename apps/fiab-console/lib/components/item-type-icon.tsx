'use client';

/**
 * Per-item-type icon + color lookup, used by the workspace tree view (and
 * other surfaces that render a heterogeneous list of items).
 *
 * The color tokens mirror the homepage "Get started" quick-link palette so
 * the tree visually rhymes with the catalog cards on `/`.
 *
 * Unknown / unmapped slugs fall back to `Document20Regular` + neutral.
 */

import type { ReactNode } from 'react';
import {
  // Data engineering / lakehouse
  Notebook20Filled, Database20Regular, BeakerEdit20Regular, Box20Regular,
  // Data factory
  Flow20Regular, ArrowSwap20Regular, ArrowDownload20Regular,
  Link20Regular, BranchFork20Regular, CodeBlock20Regular, CloudFlow20Regular,
  // Data warehouse
  Server20Regular,
  // Databases
  DatabaseLink20Regular,
  // Real-time
  Flash20Filled, DataLine20Regular, DataHistogram20Regular,
  Pulse20Regular, BoardSplit20Regular, Filter20Regular,
  // Data science / ML
  Bot20Regular, Sparkle20Regular, BrainCircuit20Regular,
  // Fabric IQ / agents
  ChatMultiple20Regular, Map20Regular, TextBulletListTree20Regular, ClipboardTaskListLtr20Regular,
  // Power BI
  ChartMultiple20Regular, DataPie20Regular, Layer20Regular, DataTreemap20Regular,
  Gauge20Regular, DocumentBulletList20Regular,
  // APIs / functions
  PlugConnected20Regular, Globe20Regular, Code20Regular, AppsList20Regular,
  // Azure / Synapse / Databricks
  ServerLink20Regular,
  // AI Foundry
  Cube20Regular, Beaker20Regular, ShieldCheckmark20Regular, BranchRequest20Regular,
  Search20Regular, DesktopFlow20Regular,
  // Copilot Studio / Power Platform
  PersonChat20Regular, BookGlobe20Regular, ChatBubblesQuestion20Regular,
  PuzzlePiece20Regular, Channel20Regular, ChartPerson20Regular, Library20Regular,
  Apps20Regular, Table20Regular, AppFolder20Regular, Globe20Filled, BotSparkle20Regular,
  // SQL family
  // Geo / graph / vector
  Diversity20Regular, Branch20Regular, Earth20Regular, VirtualNetwork20Regular,
  // Data products
  Cube20Filled,
  // Fallbacks
  Document20Regular,
} from '@fluentui/react-icons';

/**
 * Category-level color tokens. These are static hex strings rather than
 * Fluent theme tokens so that the swatch is consistent in light + dark
 * (the homepage tile gradient palette has the same trade-off).
 */
export const CATEGORY_COLORS: Record<string, string> = {
  'Data Engineering':       '#0050b3', // blue
  'Data Factory':           '#0078d4', // bright blue
  'Data Warehouse':         '#117865', // green
  'Databases':              '#1a7f4e', // green
  'Real-Time Intelligence': '#c2410c', // orange
  'Data Science':           '#7c3aed', // purple
  'Fabric IQ':              '#4b1d8f', // deep purple
  'Power BI':               '#ad6800', // amber
  'APIs and functions':     '#0d7377', // teal
  'Synapse Analytics':      '#1a1342', // navy
  'Azure Databricks':       '#b91c4b', // red-pink
  'Azure Data Factory':     '#0050b3', // blue
  'Azure Data Lake Analytics': '#0050b3',
  'Azure AI Foundry':       '#7c3aed', // purple
  'Azure SQL Database':     '#1a7f4e', // green
  'Azure Geoanalytics':     '#0d7377', // teal
  'Azure Graph + Vector':   '#5e4dc0', // violet
  'CSA Data Products':      '#3d2e80', // deep violet
  'Copilot Studio':         '#c2410c', // orange
  'Power Platform':         '#0d7377', // teal
  'AI & Agents':            '#4b1d8f', // deep purple
  'Streaming analytics':    '#c2410c', // orange
};

export const NEUTRAL_COLOR = '#6b7280';

/**
 * Item-type slug → icon component. Covers every slug in
 * `lib/catalog/fabric-item-types.ts`. Anything not listed falls back to
 * the generic Document icon at render time.
 */
const ICON_BY_SLUG: Record<string, (props: { color?: string }) => ReactNode> = {
  // Data Engineering
  'lakehouse':             (p) => <Database20Regular style={{ color: p.color }} />,
  'materialized-lake-view': (p) => <Layer20Regular style={{ color: p.color }} />,
  'notebook':              (p) => <Notebook20Filled style={{ color: p.color }} />,
  'spark-job-definition':  (p) => <CodeBlock20Regular style={{ color: p.color }} />,
  'environment':           (p) => <Box20Regular style={{ color: p.color }} />,

  // Data Factory
  'data-pipeline':         (p) => <Flow20Regular style={{ color: p.color }} />,
  'dataflow':              (p) => <CloudFlow20Regular style={{ color: p.color }} />,
  'copy-job':              (p) => <ArrowDownload20Regular style={{ color: p.color }} />,
  'mirrored-database':     (p) => <ArrowSwap20Regular style={{ color: p.color }} />,
  'mirrored-databricks':   (p) => <ArrowSwap20Regular style={{ color: p.color }} />,
  'mounted-adf':           (p) => <Link20Regular style={{ color: p.color }} />,
  'dbt-job':               (p) => <BranchFork20Regular style={{ color: p.color }} />,
  'airflow-job':           (p) => <BranchFork20Regular style={{ color: p.color }} />,

  // Data Warehouse / Databases
  'warehouse':             (p) => <Server20Regular style={{ color: p.color }} />,
  'sql-database':          (p) => <DatabaseLink20Regular style={{ color: p.color }} />,

  // Real-Time Intelligence
  'eventhouse':            (p) => <DataLine20Regular style={{ color: p.color }} />,
  'kql-database':          (p) => <Flash20Filled style={{ color: p.color }} />,
  'kql-queryset':          (p) => <Filter20Regular style={{ color: p.color }} />,
  'kql-dashboard':         (p) => <DataHistogram20Regular style={{ color: p.color }} />,
  'eventstream':           (p) => <Pulse20Regular style={{ color: p.color }} />,
  'event-schema-set':      (p) => <BoardSplit20Regular style={{ color: p.color }} />,
  'activator':             (p) => <Pulse20Regular style={{ color: p.color }} />,

  // Data Science
  'ml-model':              (p) => <BrainCircuit20Regular style={{ color: p.color }} />,
  'ml-experiment':         (p) => <BeakerEdit20Regular style={{ color: p.color }} />,

  // Fabric IQ
  'ontology':              (p) => <TextBulletListTree20Regular style={{ color: p.color }} />,
  'graph-model':           (p) => <Diversity20Regular style={{ color: p.color }} />,
  'plan':                  (p) => <ClipboardTaskListLtr20Regular style={{ color: p.color }} />,
  'map':                   (p) => <Map20Regular style={{ color: p.color }} />,
  'data-agent':            (p) => <ChatMultiple20Regular style={{ color: p.color }} />,
  'operations-agent':      (p) => <Bot20Regular style={{ color: p.color }} />,

  // Power BI
  'semantic-model':        (p) => <Layer20Regular style={{ color: p.color }} />,
  'report':                (p) => <ChartMultiple20Regular style={{ color: p.color }} />,
  'dashboard':             (p) => <Gauge20Regular style={{ color: p.color }} />,
  'paginated-report':      (p) => <DocumentBulletList20Regular style={{ color: p.color }} />,
  'scorecard':             (p) => <DataTreemap20Regular style={{ color: p.color }} />,

  // APIs / functions
  'graphql-api':           (p) => <Globe20Regular style={{ color: p.color }} />,
  'user-data-function':    (p) => <Code20Regular style={{ color: p.color }} />,
  'variable-library':      (p) => <AppsList20Regular style={{ color: p.color }} />,
  'apim-api':              (p) => <PlugConnected20Regular style={{ color: p.color }} />,
  'apim-product':          (p) => <DataPie20Regular style={{ color: p.color }} />,
  'apim-policy':           (p) => <ShieldCheckmark20Regular style={{ color: p.color }} />,
  'data-product':          (p) => <Cube20Filled style={{ color: p.color }} />,

  // Synapse / Databricks / ADF
  'synapse-dedicated-sql-pool':  (p) => <Server20Regular style={{ color: p.color }} />,
  'synapse-serverless-sql-pool': (p) => <Server20Regular style={{ color: p.color }} />,
  'synapse-spark-pool':          (p) => <ServerLink20Regular style={{ color: p.color }} />,
  'synapse-pipeline':            (p) => <Flow20Regular style={{ color: p.color }} />,
  'databricks-notebook':         (p) => <Notebook20Filled style={{ color: p.color }} />,
  'databricks-job':              (p) => <BranchFork20Regular style={{ color: p.color }} />,
  'databricks-cluster':          (p) => <ServerLink20Regular style={{ color: p.color }} />,
  'databricks-sql-warehouse':    (p) => <Server20Regular style={{ color: p.color }} />,
  'adf-pipeline':                (p) => <Flow20Regular style={{ color: p.color }} />,
  'adf-dataset':                 (p) => <Table20Regular style={{ color: p.color }} />,
  'adf-trigger':                 (p) => <Pulse20Regular style={{ color: p.color }} />,
  'stream-analytics-job':        (p) => <Pulse20Regular style={{ color: p.color }} />,

  // AI Foundry
  'ai-foundry-hub':         (p) => <Cube20Regular style={{ color: p.color }} />,
  'ai-foundry-project':     (p) => <BranchRequest20Regular style={{ color: p.color }} />,
  'prompt-flow':            (p) => <Flow20Regular style={{ color: p.color }} />,
  'evaluation':             (p) => <Beaker20Regular style={{ color: p.color }} />,
  'content-safety':         (p) => <ShieldCheckmark20Regular style={{ color: p.color }} />,
  'tracing':                (p) => <DesktopFlow20Regular style={{ color: p.color }} />,
  'ai-search-index':        (p) => <Search20Regular style={{ color: p.color }} />,
  'compute':                (p) => <ServerLink20Regular style={{ color: p.color }} />,
  'dataset':                (p) => <Table20Regular style={{ color: p.color }} />,

  // Copilot Studio
  'copilot-studio-agent':       (p) => <BotSparkle20Regular style={{ color: p.color }} />,
  'copilot-studio-knowledge':   (p) => <BookGlobe20Regular style={{ color: p.color }} />,
  'copilot-studio-topic':       (p) => <ChatBubblesQuestion20Regular style={{ color: p.color }} />,
  'copilot-studio-action':      (p) => <PuzzlePiece20Regular style={{ color: p.color }} />,
  'copilot-studio-channel':     (p) => <Channel20Regular style={{ color: p.color }} />,
  'copilot-studio-analytics':   (p) => <ChartPerson20Regular style={{ color: p.color }} />,
  'copilot-template-library':   (p) => <Library20Regular style={{ color: p.color }} />,

  // Power Platform
  'powerplatform-environment':  (p) => <AppFolder20Regular style={{ color: p.color }} />,
  'dataverse-table':            (p) => <Table20Regular style={{ color: p.color }} />,
  'power-app':                  (p) => <Apps20Regular style={{ color: p.color }} />,
  'power-automate-flow':        (p) => <Flow20Regular style={{ color: p.color }} />,
  'power-page':                 (p) => <Globe20Filled style={{ color: p.color }} />,
  'ai-builder-model':           (p) => <Sparkle20Regular style={{ color: p.color }} />,

  // Azure SQL family
  'azure-sql-server':              (p) => <Server20Regular style={{ color: p.color }} />,
  'azure-sql-database':            (p) => <DatabaseLink20Regular style={{ color: p.color }} />,
  'azure-sql-managed-instance':    (p) => <ServerLink20Regular style={{ color: p.color }} />,
  'sql-server-2025-vector-index':  (p) => <PersonChat20Regular style={{ color: p.color }} />,

  // Geoanalytics
  'geo-map':         (p) => <Map20Regular style={{ color: p.color }} />,
  'geo-dataset':     (p) => <Earth20Regular style={{ color: p.color }} />,
  'geo-query':       (p) => <Filter20Regular style={{ color: p.color }} />,
  'geo-pipeline':    (p) => <Flow20Regular style={{ color: p.color }} />,

  // Graph + Vector
  'cosmos-gremlin-graph': (p) => <Diversity20Regular style={{ color: p.color }} />,
  'cypher-graph':         (p) => <Branch20Regular style={{ color: p.color }} />,
  'gql-graph':            (p) => <VirtualNetwork20Regular style={{ color: p.color }} />,
  'vector-store':         (p) => <Cube20Regular style={{ color: p.color }} />,

  // CSA data products
  'data-product-template':  (p) => <Cube20Regular style={{ color: p.color }} />,
  'data-product-instance':  (p) => <Cube20Filled style={{ color: p.color }} />,

  // AI & Agents
  'cross-item-copilot':     (p) => <BotSparkle20Regular style={{ color: p.color }} />,
};

/** Returns the icon node for a slug, colored by the slug's category. */
export function getItemTypeIcon(slug: string, category?: string): ReactNode {
  const color = (category && CATEGORY_COLORS[category]) || NEUTRAL_COLOR;
  const factory = ICON_BY_SLUG[slug];
  if (factory) return factory({ color });
  return <Document20Regular style={{ color }} />;
}

/** Returns the category color for a slug or category. */
export function getItemTypeColor(category?: string): string {
  if (!category) return NEUTRAL_COLOR;
  return CATEGORY_COLORS[category] || NEUTRAL_COLOR;
}

/** Count of slugs the lookup explicitly covers (for QA / debug). */
export const COVERED_ITEM_TYPE_COUNT = Object.keys(ICON_BY_SLUG).length;
