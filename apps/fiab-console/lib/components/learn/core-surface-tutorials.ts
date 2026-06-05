/**
 * Core-surface Loom Learn tutorials.
 *
 * The /learn portal links "Loom doc first". These 8 hand-authored tutorials
 * cover the core data surfaces end-to-end and live at
 * `docs/fiab/learn/<slug>.md` (served at `<LOOM_DOCS_BASE>/fiab/learn/<slug>/`).
 *
 * This module is the catalog-wiring layer for those docs: it returns
 * `LearnTopic` rows the Learn page renders alongside `getLearnCatalog()`, so
 * each portal link resolves to the real Loom doc (PRIMARY) with the upstream
 * Microsoft Learn page as the SECONDARY link — never a 404, never a doc-less
 * "MS Learn"-only card.
 *
 * Kept here (rather than in `lib/learn/content.ts`) so the docs can be wired in
 * without editing the generated per-editor registry. The `loomDocUrl` builder
 * and `LearnTopic` shape are imported from that registry so URLs and types stay
 * in lockstep with the rest of the catalog.
 */

import { loomDocUrl, type LearnTopic } from '@/lib/learn/content';

interface CoreSurfaceSpec {
  /** Doc slug under docs/fiab/learn/ (no extension). */
  slug: string;
  title: string;
  summary: string;
  /** Item-type slug used to resolve icon + color via itemVisual(). */
  visualType: string;
  /** Upstream Microsoft Learn / service docs page (SECONDARY link). */
  msLearnUrl: string;
}

/**
 * The 8 core-surface tutorials, in suggested reading order. Each `slug` has a
 * backing doc at `docs/fiab/learn/<slug>.md`.
 */
export const CORE_SURFACE_SPECS: ReadonlyArray<CoreSurfaceSpec> = [
  {
    slug: 'lakehouse-shortcuts',
    title: 'Lakehouse shortcuts',
    summary:
      'Reference ADLS Gen2, S3, GCS, Dataverse, or another lakehouse without copying data — OneLake shortcuts in the Files and Tables tabs.',
    visualType: 'lakehouse',
    msLearnUrl: 'https://learn.microsoft.com/fabric/data-engineering/lakehouse-shortcuts',
  },
  {
    slug: 'data-pipelines-and-dataflows',
    title: 'Data pipelines & Mapping Data Flow',
    summary:
      'Orchestrate Copy, Notebook, and Dataflow activities on the visual canvas; transform code-free with Dataflow Gen2; validate, run, and schedule.',
    visualType: 'data-pipeline',
    msLearnUrl: 'https://learn.microsoft.com/fabric/data-factory/data-factory-overview',
  },
  {
    slug: 'notebooks-spark',
    title: 'Notebooks (Spark)',
    summary:
      'Interactive PySpark / Spark SQL notebooks over the lakehouse: attach a cluster, read and write Delta, use %%sql, run, and schedule from a pipeline.',
    visualType: 'notebook',
    msLearnUrl: 'https://learn.microsoft.com/fabric/data-engineering/lakehouse-notebook-explore',
  },
  {
    slug: 'warehouse-sql',
    title: 'Warehouse SQL',
    summary:
      'Managed T-SQL over OneLake: create and load tables, cross-database joins, DirectLake for Power BI, and serverless cost-per-scan discipline.',
    visualType: 'warehouse',
    msLearnUrl: 'https://learn.microsoft.com/fabric/data-warehouse/data-warehousing',
  },
  {
    slug: 'kql-real-time-intelligence',
    title: 'KQL / Real-time intelligence',
    summary:
      'End-to-end real-time path: Eventstream → KQL database → queryset + dashboard → Activator alert, all on the real ADX / Kusto data plane.',
    visualType: 'kql-database',
    msLearnUrl: 'https://learn.microsoft.com/fabric/real-time-intelligence/overview',
  },
  {
    slug: 'purview-governance',
    title: 'Purview governance (classic Data Map)',
    summary:
      'Register sources, run scans, auto-classify sensitive data, then discover via catalog search, asset detail, lineage, and the glossary.',
    visualType: 'data-product',
    msLearnUrl: 'https://learn.microsoft.com/purview/legacy/governance-solutions-overview',
  },
  {
    slug: 'cosmos-data-explorer',
    title: 'Cosmos Data Explorer',
    summary:
      'Browse databases and containers, create and edit JSON items, and run NoSQL queries (nested objects, arrays, JOIN) against the real Cosmos data plane.',
    visualType: 'cosmos-gremlin-graph',
    msLearnUrl: 'https://learn.microsoft.com/azure/cosmos-db/data-explorer',
  },
  {
    slug: 'deployment-and-byo',
    title: 'Deployment & BYO',
    summary:
      'Push-button provision or reuse existing Azure services (bring-your-own) per service via EXISTING_* env vars, with honest infra gates and no drift.',
    visualType: 'plan',
    msLearnUrl: 'https://learn.microsoft.com/azure/developer/azure-developer-cli/overview',
  },
];

/**
 * Build the core-surface tutorials as `LearnTopic` rows for the Learn portal.
 * Every row resolves its PRIMARY link to the real Loom doc under
 * `fiab/learn/<slug>` and carries the upstream MS Learn page as SECONDARY.
 */
export function getCoreSurfaceTutorials(): LearnTopic[] {
  return CORE_SURFACE_SPECS.map((spec) => ({
    id: `learn:${spec.slug}`,
    title: spec.title,
    summary: spec.summary,
    section: 'Tutorials',
    category: 'Core surfaces',
    visualType: spec.visualType,
    primaryUrl: loomDocUrl(`fiab/learn/${spec.slug}`),
    primaryLabel: 'Loom guide',
    msLearnUrl: spec.msLearnUrl,
    hasLoomDoc: true,
  }));
}
