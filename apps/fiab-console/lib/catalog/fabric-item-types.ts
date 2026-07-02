/**
 * Authoritative Fabric item-type catalog, sourced from
 * docs/fiab/fabric-feature-inventory.md (which was assembled via
 * Microsoft Learn MCP — item-definition-overview,
 * item-management-overview, and per-workload product overviews).
 *
 * Used by:
 *  - the `+ New item` dialog (categorized grid)
 *  - the per-item-type editor routes at /items/[type]/[id]
 *  - the workspace inventory rollup
 *
 * Keep in sync with the inventory doc; any drift means the doc is
 * stale (re-fetch via microsoft_docs_search) or this file is.
 */

// ---------------------------------------------------------------------------
// Types live in ./item-types/types and are re-exported here so the public API
// (import { FabricItemType, WorkloadCategory, LearnContent, ... } from
// '@/lib/catalog/fabric-item-types') is unchanged for every existing importer.
// ---------------------------------------------------------------------------
export type {
  WorkloadCategory,
  LearnStep,
  LearnContent,
  CreateConfigChoice,
  CreateConfig,
  FabricItemType,
} from './item-types/types';
import type { FabricItemType, WorkloadCategory } from './item-types/types';

// Per-category item-type slices. Editing one workload no longer touches this
// merge-conflict-magnet file — add/remove items in the relevant slice module.
import { fabricAppsItems } from './item-types/fabric-apps';
import { dataEngineeringItems } from './item-types/data-engineering';
import { dataFactoryItems } from './item-types/data-factory';
import { dataWarehouseItems } from './item-types/data-warehouse';
import { databasesItems } from './item-types/databases';
import { realTimeIntelligenceItems } from './item-types/real-time-intelligence';
import { dataScienceItems } from './item-types/data-science';
import { fabricIqItems } from './item-types/fabric-iq';
import { powerBiItems } from './item-types/power-bi';
import { apisAndFunctionsItems } from './item-types/apis-and-functions';
import { synapseAnalyticsItems } from './item-types/synapse-analytics';
import { azureDatabricksItems } from './item-types/azure-databricks';
import { azureDataFactoryItems } from './item-types/azure-data-factory';
import { streamingAnalyticsItems } from './item-types/streaming-analytics';
import { csaDataProductsItems } from './item-types/csa-data-products';
import { azureAiFoundryItems } from './item-types/azure-ai-foundry';
import { copilotStudioItems } from './item-types/copilot-studio';
import { powerPlatformItems } from './item-types/power-platform';
import { azureSqlDatabaseItems } from './item-types/azure-sql-database';
import { azureGeoanalyticsItems } from './item-types/azure-geoanalytics';
import { azureGraphVectorItems } from './item-types/azure-graph-vector';
import { aiAgentsItems } from './item-types/ai-agents';

/**
 * Authoritative Fabric item-type catalog, composed from the per-category slices
 * above. Spreads run in the ORIGINAL category-appearance order and each slice
 * keeps its items in original relative order, so:
 *   • the SET of slugs is identical to the pre-split array,
 *   • itemsByCategory() / findItemType() / WORKLOAD_CATEGORIES are unchanged,
 *   • within-category order is preserved.
 * (Not frozen — matches the original mutable, readonly-typed array.)
 */
export const FABRIC_ITEM_TYPES: readonly FabricItemType[] = [
  ...fabricAppsItems,
  ...dataEngineeringItems,
  ...dataFactoryItems,
  ...dataWarehouseItems,
  ...databasesItems,
  ...realTimeIntelligenceItems,
  ...dataScienceItems,
  ...fabricIqItems,
  ...powerBiItems,
  ...apisAndFunctionsItems,
  ...synapseAnalyticsItems,
  ...azureDatabricksItems,
  ...azureDataFactoryItems,
  ...streamingAnalyticsItems,
  ...csaDataProductsItems,
  ...azureAiFoundryItems,
  ...copilotStudioItems,
  ...powerPlatformItems,
  ...azureSqlDatabaseItems,
  ...azureGeoanalyticsItems,
  ...azureGraphVectorItems,
  ...aiAgentsItems,
];


export const WORKLOAD_CATEGORIES: readonly WorkloadCategory[] = [
  'Data Engineering',
  'Data Factory',
  'Data Warehouse',
  'Databases',
  'Real-Time Intelligence',
  'Data Science',
  'Fabric IQ',
  'Power BI',
  'APIs and functions',
  'Synapse Analytics',
  'Azure Databricks',
  'Azure Data Factory',
  'Streaming analytics',
  'Azure Data Lake Analytics',
  'Azure AI Foundry',
  'Azure SQL Database',
  'Azure Geoanalytics',
  'Azure Graph + Vector',
  'CSA Data Products',
  'Copilot Studio',
  'Power Platform',
  'AI & Agents',
  'Fabric Apps',
];

export function itemsByCategory(category: WorkloadCategory): FabricItemType[] {
  return FABRIC_ITEM_TYPES.filter((i) => i.category === category);
}

export function findItemType(slug: string): FabricItemType | undefined {
  return FABRIC_ITEM_TYPES.find((i) => i.slug === slug);
}
