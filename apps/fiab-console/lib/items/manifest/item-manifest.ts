/**
 * lib/items/manifest/item-manifest.ts — EH-P1-MANIFEST (issue #1801).
 *
 * Typed item-type MANIFEST model: the per-item-type capability declaration for
 * every Loom item type. This is an ADDITIVE layer over the existing catalog —
 * identity/display data (slug, name, category, restType, gallery flags) stays
 * single-sourced in `lib/catalog/fabric-item-types.ts` (the registry derives
 * from it, never duplicates it), while the CAPABILITY data that today lives as
 * scattered hard-coded slug lists is declared here once:
 *
 *   • which types have a Phase-2 provisioner        (provisioning-engine PROVISIONERS)
 *   • which types the Weave → Power BI edge sources (thread-actions PBI_SOURCEABLE /
 *                                                    pbi-source-resolver PBI_RESOLVABLE_TYPES)
 *   • which types a notebook session can attach     (thread-actions NOTEBOOK_ATTACHABLE)
 *   • which types can ground a Data Agent           (thread-actions DATA_AGENT_SOURCEABLE)
 *   • which types the opt-in Power BI model builder (thread-actions POWERBI_MODELABLE)
 *     accepts
 *
 * Every capability flag below is GROUNDED in one of those existing registries —
 * no invented capabilities. Drift is impossible to miss: the manifest test
 * suite (lib/items/manifest/__tests__) asserts each list here equals the live
 * registry it mirrors (PROVISIONERS keys, PBI_RESOLVABLE_TYPES, the union of
 * THREAD_ACTIONS fromTypes, …), so editing one side without the other fails CI.
 *
 * This module is intentionally CLIENT-SAFE: it imports only types from the
 * catalog. It must NEVER import the provisioning engine / Azure SDK clients
 * (thread-actions and other client-bundled modules consume the registry).
 *
 * Per .claude/rules/no-fabric-dependency.md: `defaultBackend` for every
 * provisionable type is 'azure-native' — Fabric is strictly opt-in via
 * LOOM_<ITEM>_BACKEND=fabric and is never the default.
 */
import type { WorkloadCategory } from '@/lib/catalog/item-types/types';

/** How a workload family relates to Microsoft Fabric / Azure. */
export type FamilyKind =
  /** 1:1 parity with a Fabric workload — Azure-native backend by DEFAULT, Fabric opt-in. */
  | 'fabric-parity'
  /** A first-class Azure service surface (Synapse, Databricks, ADF, AI Foundry, …). */
  | 'azure-service'
  /** Loom-only surface with no direct Fabric/Azure-portal analog. */
  | 'loom-native';

/**
 * What backs the item when it is provisioned with NO opt-in env set.
 *  - 'azure-native': a Phase-2 provisioner calls real Azure REST/data-plane.
 *  - 'cosmos-only' : the item is a Cosmos workspace document with no Phase-2
 *    backend side-effect (provisioning-engine: "Item types not listed here are
 *    Cosmos-only").
 */
export type DefaultBackend = 'azure-native' | 'cosmos-only';

/**
 * Typed capability flags per item type. Every flag mirrors behavior an
 * existing registry/consumer already expresses (see module doc) — the manifest
 * makes them queryable in one place instead of scattered slug lists.
 */
export interface ItemTypeCapabilities {
  /** Has a Phase-2 provisioner (provisioning-engine PROVISIONERS map). */
  provisionable: boolean;
  /**
   * Offered by the New-item dialog (browse or search) —
   * `!deprecated && !coreSurface && !hiddenFromGallery`, exactly the dialog's
   * filter in lib/components/new-item-dialog.tsx. `labs` / `searchOnly` types
   * are still creatable (via the Labs toggle / the search branch).
   */
  creatable: boolean;
  /** Hidden from browse but returned by search (FabricItemType.searchOnly). */
  searchOnly: boolean;
  /** Labs novelty item — hidden until the "Show Labs items" toggle (FabricItemType.labs). */
  labs: boolean;
  /** Preview item type (FabricItemType.preview). */
  preview: boolean;
  /** Deprecated — no create path; editor shows a migration surface (FabricItemType.deprecated). */
  deprecated: boolean;
  /** Core nav surface (e.g. data-marketplace), not created per-workspace (FabricItemType.coreSurface). */
  coreSurface: boolean;
  /**
   * The /items/[type]/[id] route renders an editor surface for this slug.
   * True for every cataloged type today (deprecated types render the migration
   * surface; aliases resolve via `editorSlug`). A future headless type would
   * set this false.
   */
  hasEditor: boolean;
  /** A Fabric REST API exists for the equivalent Fabric item (`!noRestApi`). */
  hasRestApi: boolean;
  /** At least one Weave ThreadAction lists this type in `fromTypes` (thread-actions). */
  weaveSourceable: boolean;
  /** Weave → "Analyze in Power BI" can source this type (PBI_SOURCEABLE / PBI_RESOLVABLE_TYPES). */
  pbiSourceable: boolean;
  /** The opt-in "Build a Power BI model" edge accepts this type (POWERBI_MODELABLE). */
  powerBiModelable: boolean;
  /** Can be attached to a notebook session for exploration (NOTEBOOK_ATTACHABLE). */
  notebookAttachable: boolean;
  /** Can ground a Loom Data Agent (DATA_AGENT_SOURCEABLE / DA_SOURCE_TYPES). */
  dataAgentSourceable: boolean;
}

/** The manifest — one per Loom item type, derived from the catalog + the capability lists below. */
export interface ItemManifest {
  /** Item-type slug (FabricItemType.slug; routes at /items/[slug]/[id]). */
  type: string;
  /** Display name (FabricItemType.displayName). */
  displayName: string;
  /** Workload family (FabricItemType.category). */
  family: WorkloadCategory;
  /** How the family relates to Fabric / Azure (FAMILY_KIND map). */
  familyKind: FamilyKind;
  /** REST API type name (FabricItemType.restType). */
  restType: string;
  /**
   * The Fabric REST item type this Loom type is 1:1 with — only set for
   * fabric-parity families with a real Fabric REST API. Fabric remains opt-in
   * per no-fabric-dependency.md; this is metadata, not a dependency.
   */
  fabricEquivalent?: string;
  /**
   * The Azure-native DEFAULT backend a Phase-2 provisioner targets (from the
   * provisioning-engine's per-type wiring + .claude/rules/no-fabric-dependency.md).
   * Undefined for Cosmos-only types.
   */
  azureBackend?: string;
  /** What backs the item with no opt-in env set. */
  defaultBackend: DefaultBackend;
  /** The slug whose editor renders this type (aliasOf resolution; usually `type` itself). */
  editorSlug: string;
  /** Item types auto-paired on successful provision (lib/items/registry ITEM_PAIRING_RULES). */
  pairsWith: readonly string[];
  capabilities: ItemTypeCapabilities;
}

// ───────────────────────────────────────────────────────────────────────────
// Capability source lists — each MIRRORS a live registry; the manifest test
// suite asserts equality so they cannot drift silently.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Item types with a Phase-2 provisioner. MIRRORS the keys of `PROVISIONERS` in
 * lib/install/provisioning-engine.ts (kept as data here so client bundles
 * never import the engine's Azure-SDK graph). Test-enforced 1:1.
 */
export const PROVISIONABLE_ITEM_TYPES: readonly string[] = [
  'notebook',
  'lakehouse',
  'warehouse',
  'kql-database',
  'kql-queryset',
  'eventhouse',
  'workspace-monitor',
  'kql-dashboard',
  'ai-search-index',
  'semantic-model',
  'activator',
  'data-pipeline',
  'eventstream',
  'mirrored-database',
  'mirrored-databricks',
  'databricks-notebook',
  'report',
  'data-product',
  'ml-model',
  'prompt-flow',
  'evaluation',
  'logic-app',
  'synapse-pipeline',
  'adf-pipeline',
  'databricks-job',
  'synapse-serverless-sql-pool',
  'materialized-lake-view',
];

/**
 * Item types the Weave → "Analyze in Power BI" edge can source. This is now
 * the CANONICAL declaration: lib/thread/thread-actions.ts derives its
 * `PBI_SOURCEABLE` from the manifest registry, and the test suite asserts it
 * stays set-equal to `PBI_RESOLVABLE_TYPES` in lib/azure/pbi-source-resolver.ts
 * (which keeps its own `as const` copy for typing). Order preserved from the
 * previous hard-coded list.
 */
export const PBI_SOURCEABLE_ITEM_TYPES: readonly string[] = [
  'lakehouse',
  'warehouse',
  'eventhouse',
  'kql-database',
  'mirrored-database',
  'dataset',
  'semantic-model',
  'data-product',
  'synapse-serverless-sql-pool',
  'synapse-dedicated-sql-pool',
];

/** MIRRORS thread-actions NOTEBOOK_ATTACHABLE (test-enforced). */
export const NOTEBOOK_ATTACHABLE_ITEM_TYPES: readonly string[] = [
  'lakehouse',
  'warehouse',
  'kql-database',
  'synapse-dedicated-sql-pool',
  'synapse-serverless-sql-pool',
  'azure-sql-database',
];

/** MIRRORS thread-actions DATA_AGENT_SOURCEABLE (test-enforced). */
export const DATA_AGENT_SOURCEABLE_ITEM_TYPES: readonly string[] = [
  'warehouse',
  'lakehouse',
  'kql-database',
  'semantic-model',
  'ai-search-index',
  'synapse-dedicated-sql-pool',
  'synapse-serverless-sql-pool',
  'azure-sql-database',
];

/** MIRRORS thread-actions POWERBI_MODELABLE (test-enforced). */
export const POWERBI_MODELABLE_ITEM_TYPES: readonly string[] = [
  'warehouse',
  'synapse-dedicated-sql-pool',
];

/**
 * Union of every `fromTypes` across THREAD_ACTIONS (thread-actions.ts) — the
 * types with at least one Weave edge. Test-enforced against
 * `actionsFor(slug).length > 0` for every cataloged type, so adding/removing a
 * ThreadAction without updating this list fails the suite.
 */
export const WEAVE_SOURCEABLE_ITEM_TYPES: readonly string[] = [
  'lakehouse',
  'warehouse',
  'kql-database',
  'synapse-dedicated-sql-pool',
  'synapse-serverless-sql-pool',
  'azure-sql-database',
  'semantic-model',
  'ai-search-index',
  'notebook',
  'eventhouse',
  'mirrored-database',
  'dataset',
  'data-product',
];

/**
 * Azure-native DEFAULT backend per provisionable type — from the
 * provisioning-engine's per-type wiring comments and the canonical table in
 * .claude/rules/no-fabric-dependency.md. Keys are exactly
 * PROVISIONABLE_ITEM_TYPES (consistency-checked).
 */
export const AZURE_BACKENDS: Readonly<Record<string, string>> = {
  'notebook': 'Synapse Spark (Livy) session pool',
  'lakehouse': 'ADLS Gen2 + Delta (Synapse table registration)',
  'warehouse': 'Synapse dedicated SQL pool',
  'kql-database': 'Azure Data Explorer (ADX) cluster',
  'kql-queryset': 'Azure Data Explorer (ADX) cluster',
  'eventhouse': 'Azure Data Explorer (ADX) cluster',
  'workspace-monitor': 'Azure Data Explorer (ADX) usage/perf DB fed by Azure Monitor diagnostics',
  'kql-dashboard': 'Loom-native dashboard over Azure Data Explorer (ADX)',
  'ai-search-index': 'Azure AI Search',
  'semantic-model': 'Loom-native tabular layer over Synapse warehouse/lakehouse (AAS optional)',
  'activator': 'Azure Monitor scheduled-query alert',
  'data-pipeline': 'Synapse pipeline (or ADF)',
  'eventstream': 'Azure Event Hubs (+ Stream Analytics)',
  'mirrored-database': 'ADF CDC copy → ADLS Bronze',
  'mirrored-databricks': 'Databricks Unity Catalog mount + Synapse serverless SQL views',
  'databricks-notebook': 'Azure Databricks workspace import + run',
  'report': 'Loom-native report renderer over the semantic layer',
  'data-product': 'Purview Unified Catalog + Cosmos DataProductStore',
  'ml-model': 'Azure ML / MLflow training + registry',
  'prompt-flow': 'Azure AI Foundry project (AML data-plane)',
  'evaluation': 'Azure AI Foundry evaluation run',
  'logic-app': 'Azure Logic Apps (ARM workflows)',
  'synapse-pipeline': 'Synapse Studio pipeline (Synapse dev REST)',
  'adf-pipeline': 'Azure Data Factory pipeline (ARM)',
  'databricks-job': 'Azure Databricks Jobs 2.1',
  'synapse-serverless-sql-pool': 'Synapse serverless SQL endpoint over the lake abfss root',
  'materialized-lake-view': 'Synapse Spark batch → Delta MLV + Cosmos lineage',
};

/**
 * How each workload family relates to Fabric / Azure. Exhaustive over
 * WorkloadCategory (TypeScript enforces a key per category).
 */
export const FAMILY_KIND: Readonly<Record<WorkloadCategory, FamilyKind>> = {
  'Data Engineering': 'fabric-parity',
  'Data Factory': 'fabric-parity',
  'Data Warehouse': 'fabric-parity',
  'Databases': 'fabric-parity',
  'Real-Time Intelligence': 'fabric-parity',
  'Data Science': 'fabric-parity',
  'Fabric IQ': 'fabric-parity',
  'Power BI': 'fabric-parity',
  'APIs and functions': 'fabric-parity',
  'Loom Apps': 'fabric-parity',
  'Synapse Analytics': 'azure-service',
  'Azure Databricks': 'azure-service',
  'Azure Data Factory': 'azure-service',
  'Streaming analytics': 'azure-service',
  'Azure AI Foundry': 'azure-service',
  'Azure SQL Database': 'azure-service',
  'Azure Geoanalytics': 'azure-service',
  'Azure Graph + Vector': 'azure-service',
  'Copilot Studio': 'azure-service',
  'Power Platform': 'azure-service',
  'CSA Data Products': 'loom-native',
  'AI & Agents': 'loom-native',
};
