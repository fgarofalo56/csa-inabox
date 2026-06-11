/**
 * workload-hub — registry-derived Workload-hub model.
 *
 * The Workload hub (Fabric parity: learn.microsoft.com/fabric/fundamentals/fabric-home)
 * presents *workloads* (categories) whose tiles each expand to the *item types*
 * you can create/manage in that workload. Loom's twist: each item type resolves
 * to an Azure-native backend via its per-slug editor/provisioner, so "create by
 * workload" works with NO Fabric capacity bound.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the hub's grouping + counts:
 *   • Every `WorkloadCategory` in the item-type catalog maps to exactly one
 *     workload group via `CATEGORY_TO_WORKLOAD` (asserted by vitest), so no
 *     item type is orphaned and counts never drift from the catalog.
 *   • `workloadGroups()` returns the groups; `creatableItemTypes(group)` is the
 *     real, registry-derived list of things you can create in it; the count
 *     shown on every tile === `creatableItemTypes(group).length`.
 *
 * Counts are derived, never hand-authored — see docs/fiab/parity/workload-hub.md.
 */

import {
  FABRIC_ITEM_TYPES,
  WORKLOAD_CATEGORIES,
  itemsByCategory,
  type FabricItemType,
  type WorkloadCategory,
} from './fabric-item-types';

/**
 * Core workloads ship with every Loom tenant ("My workloads"); accelerators
 * are optional CSA add-ons surfaced under "More workloads".
 */
export type WorkloadTier = 'core' | 'accelerator';

export interface WorkloadGroupDef {
  /** URL key — used at /workload-hub/[workload] */
  key: string;
  /** Display name (the workload label shown on the hub tile + landing page) */
  name: string;
  /** One-line "what this workload is for" summary. */
  description: string;
  /** core → My workloads; accelerator → More workloads (optional add-ons). */
  tier: WorkloadTier;
  /**
   * Catalog categories that roll up into this workload. Azure-native service
   * families (Synapse / Databricks / ADF / Streaming analytics / AI Foundry)
   * collapse under their Fabric-facing parent so the hub mirrors Fabric's
   * workload taxonomy while keeping the Azure-native item types creatable.
   */
  categories: WorkloadCategory[];
}

/**
 * The canonical workload groups. Each `WorkloadCategory` appears in exactly one
 * group's `categories` (enforced by vitest), so the union of all groups covers
 * the entire catalog with no overlap and no gaps.
 */
export const WORKLOAD_GROUPS: readonly WorkloadGroupDef[] = [
  {
    key: 'data-engineering',
    name: 'Data Engineering',
    description: 'Lakehouses, notebooks, and Spark — on ADLS Gen2 + Delta, Synapse, and Azure Databricks for ETL/ELT at scale.',
    tier: 'core',
    categories: ['Data Engineering', 'Synapse Analytics', 'Azure Databricks', 'Azure Data Lake Analytics'],
  },
  {
    key: 'data-factory',
    name: 'Data Factory',
    description: 'Pipelines, dataflows, datasets, and triggers — orchestrate copy + transform on Synapse pipelines or Azure Data Factory.',
    tier: 'core',
    categories: ['Data Factory', 'Azure Data Factory'],
  },
  {
    key: 'data-warehouse',
    name: 'Data Warehouse',
    description: 'MPP T-SQL warehouses on a Synapse dedicated SQL pool with auto-pause + on-demand resume.',
    tier: 'core',
    categories: ['Data Warehouse'],
  },
  {
    key: 'databases',
    name: 'Databases',
    description: 'Azure SQL Database / Managed Instance, SQL Server 2025 vector indexes, Cosmos DB, and mirrored databases.',
    tier: 'core',
    categories: ['Databases', 'Azure SQL Database'],
  },
  {
    key: 'real-time-intelligence',
    name: 'Real-Time Intelligence',
    description: 'Eventhouses, KQL databases + querysets + dashboards, eventstreams, and Activator rules — on Azure Data Explorer + Event Hubs.',
    tier: 'core',
    categories: ['Real-Time Intelligence', 'Streaming analytics'],
  },
  {
    key: 'data-science',
    name: 'Data Science',
    description: 'ML models, experiments, prompt flow, evaluations, and compute — powered by Azure Machine Learning + Azure AI Foundry.',
    tier: 'core',
    categories: ['Data Science', 'Azure AI Foundry'],
  },
  {
    key: 'fabric-iq',
    name: 'Fabric IQ',
    description: 'Ontologies, plans, graphs, maps, and data/operations agents — the semantic + agentic layer over your estate.',
    tier: 'core',
    categories: ['Fabric IQ'],
  },
  {
    key: 'power-bi',
    name: 'Power BI',
    description: 'Semantic models, reports, dashboards, paginated reports, and scorecards over a Loom-native tabular layer (AAS optional).',
    tier: 'core',
    categories: ['Power BI'],
  },
  {
    key: 'power-platform',
    name: 'Power Platform',
    description: 'Dataverse tables, Power Apps, Power Automate flows, Power Pages, and AI Builder models.',
    tier: 'core',
    categories: ['Power Platform'],
  },
  {
    key: 'copilot-studio',
    name: 'Copilot Studio',
    description: 'Agents, knowledge sources, topics, actions, channels, and analytics — plus the CSA template library.',
    tier: 'core',
    categories: ['Copilot Studio'],
  },
  {
    key: 'apis-functions',
    name: 'APIs and functions',
    description: 'GraphQL APIs, user data functions, variable libraries, and serverless function backends.',
    tier: 'core',
    categories: ['APIs and functions'],
  },
  {
    key: 'ai-agents',
    name: 'AI & Agents',
    description: 'Cross-item Copilot and agentic helpers that reason across your workspace items.',
    tier: 'core',
    categories: ['AI & Agents'],
  },
  {
    key: 'fabric-apps',
    name: 'Fabric Apps',
    description: 'Code-first app backends (database, auth, Data APIs, storage) and model-bound web apps built with the Rayfin SDK.',
    tier: 'core',
    categories: ['Fabric Apps'],
  },
  {
    key: 'geoanalytics',
    name: 'Geoanalytics',
    description: 'H3/S2 spatial indexing, ST_* functions over the lakehouse, and Azure Maps integration.',
    tier: 'accelerator',
    categories: ['Azure Geoanalytics'],
  },
  {
    key: 'graph-vector',
    name: 'Graph + Vector',
    description: 'Cosmos Gremlin, Cypher (ADX make-graph), GQL, and vector stores across Cosmos / AI Search / pgvector.',
    tier: 'accelerator',
    categories: ['Azure Graph + Vector'],
  },
  {
    key: 'data-products',
    name: 'Industry Solutions & Data Products',
    description: 'Pre-built reference architectures and publishable data products for Healthcare, Financial, Casino, and IoT.',
    tier: 'accelerator',
    categories: ['CSA Data Products'],
  },
];

/**
 * Category → workload-key lookup, derived once from WORKLOAD_GROUPS. Auditable
 * single mapping (honors loom-no-freeform-config — typed lookup, not free JSON).
 */
export const CATEGORY_TO_WORKLOAD: Readonly<Record<string, string>> = (() => {
  const m: Record<string, string> = {};
  for (const g of WORKLOAD_GROUPS) {
    for (const c of g.categories) m[c] = g.key;
  }
  return m;
})();

/** All workload groups (the hub's full list). */
export function workloadGroups(): readonly WorkloadGroupDef[] {
  return WORKLOAD_GROUPS;
}

/** Resolve a workload group by its URL key. */
export function findWorkloadGroup(key: string | null | undefined): WorkloadGroupDef | undefined {
  if (!key) return undefined;
  const k = key.toLowerCase().trim();
  return WORKLOAD_GROUPS.find((g) => g.key === k);
}

/**
 * The real, registry-derived list of item types you can CREATE in a workload.
 * Deprecated types are excluded (they have no create path — same rule the
 * New item dialog applies). Sorted: GA before Preview, then by display name —
 * so the most-used types lead each landing page.
 */
export function creatableItemTypes(group: WorkloadGroupDef): FabricItemType[] {
  const seen = new Set<string>();
  const out: FabricItemType[] = [];
  for (const c of group.categories) {
    for (const t of itemsByCategory(c)) {
      if (t.deprecated) continue;
      if (seen.has(t.slug)) continue;
      seen.add(t.slug);
      out.push(t);
    }
  }
  return out.sort((a, b) => {
    const ap = a.preview ? 1 : 0;
    const bp = b.preview ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return a.displayName.localeCompare(b.displayName);
  });
}

/** Count of creatable item types in a workload — the number shown on its tile. */
export function workloadItemCount(group: WorkloadGroupDef): number {
  return creatableItemTypes(group).length;
}

/**
 * Representative item-type slug for the workload's tile glyph — its first
 * non-preview creatable type (falls back to the first creatable, then the
 * group key). Drives the itemVisual() icon + brand color on the hub tile.
 */
export function representativeSlug(group: WorkloadGroupDef): string {
  const items = creatableItemTypes(group);
  const ga = items.find((t) => !t.preview);
  return (ga ?? items[0])?.slug ?? group.key;
}

/** Total creatable item types across every workload (hero stat / QA). */
export function totalCreatableItemTypes(): number {
  return new Set(
    FABRIC_ITEM_TYPES.filter((t) => !t.deprecated).map((t) => t.slug),
  ).size;
}

/** All catalog category names, for the coverage test. */
export { WORKLOAD_CATEGORIES };

/**
 * Resolve a seeded workloads-catalog row (Cosmos) to a registry workload key,
 * so the legacy /workloads catalog page can deep-link into the new landing
 * pages. Matches by display name first, then by any shared creatable slug.
 */
export function matchWorkloadKey(name: string, featureSlugs: string[] = []): string | undefined {
  const n = (name || '').toLowerCase().trim();
  const byName = WORKLOAD_GROUPS.find((g) => g.name.toLowerCase().trim() === n);
  if (byName) return byName.key;
  for (const g of WORKLOAD_GROUPS) {
    const slugs = new Set(creatableItemTypes(g).map((t) => t.slug));
    if (featureSlugs.some((f) => slugs.has(f))) return g.key;
  }
  return undefined;
}
