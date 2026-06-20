/**
 * POST /api/admin/bootstrap-catalogs — one-time seed of apps-catalog and
 * workloads-catalog under tenant=GLOBAL. Idempotent (upserts).
 *
 * Cosmos is PE-locked from the outside, so the bash equivalent at
 * scripts/csa-loom/seed-catalogs.sh only works from inside the VNet.
 * This route runs from inside the container app where the data-plane
 * is reachable. Auth gate: session must exist (any signed-in user can
 * trigger — the seed is benign and idempotent).
 *
 * After this is called once per environment, the per-tenant copy on
 * first /api/apps-catalog GET = [] handles new tenants automatically.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { appsCatalogContainer, workloadsCatalogContainer } from '@/lib/azure/cosmos-client';
import { ensureDataProductsIndex } from '@/lib/azure/loom-data-products-search';
import { listBundleIds, getBundle } from '@/lib/apps/content-bundles';
import { CATALOG_META } from '@/lib/apps/content-bundles/catalog-meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TENANT = 'GLOBAL';

/**
 * Apps to seed under tenant=GLOBAL.
 *
 * SINGLE SOURCE OF TRUTH (apps-catalog A+ cluster, 2026-06-20):
 * derived from the content-bundle registry (`listBundleIds`) +
 * `CATALOG_META`, NOT a hand-maintained array. The previous hard-coded
 * `APPS` const had two vaporware defects this eliminates:
 *
 *   1. **id drift** — five entries used the bare slug
 *      (`change-feed-processor`, `direct-lake-replacement`,
 *      `federal-data-mesh`, `ml-pipeline`, `multi-agency-onboarding`)
 *      while the registered bundle's appId is `app-<slug>`. Install →
 *      getBundle(id) then returned undefined for those, so the GLOBAL
 *      seed produced catalog docs whose rich content never resolved (and
 *      collided with the registry-backstop's correctly-id'd copy → two
 *      tiles for the same app, one broken).
 *   2. **14 missing apps** — the array seeded only 15 of the 29
 *      registered bundles. The documented use-cases (data-governance,
 *      logic-apps-integration, real-time-dashboards, azure-realtime-
 *      analytics, sovereign-ai-agents, hybrid-topology), the Supercharge
 *      bundles, and workspace-monitoring never reached the GLOBAL seed,
 *      so a fresh deploy showed them only after the live
 *      /api/apps-catalog registry backstop ran (and never at all where
 *      the per-tenant copy is taken straight from GLOBAL).
 *
 * Deriving from the registry guarantees the GLOBAL seed, the live
 * registry backstop (app/api/apps-catalog/route.ts), and the install
 * resolver (getBundle) all agree on id + items[], so EVERY app is
 * installable for real. items[] carries the lean `{type, template}`
 * shape (rich content stays in-process per content-bundles/index.ts so
 * the Cosmos doc stays well under the 2 MB per-doc limit).
 */
export function buildApps() {
  const apps: Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    category: string;
    publisher: string;
    items: { type: string; template: string }[];
  }> = [];
  for (const appId of listBundleIds()) {
    const meta = CATALOG_META[appId];
    if (!meta) continue; // bundle without catalog metadata — skip (still installable directly)
    const bundle = getBundle(appId);
    apps.push({
      id: appId,
      name: meta.name,
      description: meta.description,
      icon: meta.icon,
      category: meta.category,
      publisher: meta.publisher,
      // Lean {type, template} refs — install reads getBundle(appId) for the
      // rich starter content, so template just points back at the bundle id.
      items: (bundle?.items || []).map((i) => ({ type: i.itemType, template: appId })),
    });
  }
  return apps;
}

const APPS = buildApps();

const WORKLOADS = [
  { id:'wl-data-engineering', name:'Data Engineering', description:'Synapse + ADF + Spark pools for ETL/ELT at scale.', category:'Included', included:true, featureSlugs:['synapse-serverless-sql-pool','synapse-dedicated-sql-pool','synapse-spark-pool','synapse-pipeline','adf-pipeline','spark-job-definition','environment','copy-job'] },
  { id:'wl-data-factory', name:'Data Factory', description:'ADF pipelines, triggers, datasets, mapping data flows.', category:'Included', included:true, featureSlugs:['adf-pipeline','adf-dataset','adf-trigger'] },
  { id:'wl-data-science', name:'Data Science', description:'AI Foundry hub, ML models + experiments, prompt flow, evaluations, compute clusters.', category:'Included', included:true, featureSlugs:['ai-foundry-hub','ml-model','ml-experiment','prompt-flow','evaluation','compute','dataset'], homeHref:'/experience/data-science/home' },
  { id:'wl-data-warehouse', name:'Data Warehouse', description:'Synapse Dedicated SQL pool (MPP T-SQL) with auto-pause + on-demand resume.', category:'Included', included:true, featureSlugs:['synapse-dedicated-sql-pool','warehouse','azure-sql-server','azure-sql-database'] },
  { id:'wl-databases', name:'Databases', description:'Azure SQL family, SQL Server 2025 features, Cosmos DB, Mirrored databases.', category:'Included', included:true, featureSlugs:['azure-sql-database','azure-sql-managed-instance','sql-server-2025-vector-index','mirrored-database'] },
  { id:'wl-industry', name:'Industry Solutions', description:'Pre-built reference architectures for Healthcare, Financial, Casino, IoT.', category:'Included', included:true, featureSlugs:['data-product-template','data-product-instance'] },
  { id:'wl-power-bi', name:'Power BI', description:'Semantic models, reports, dashboards, paginated reports, scorecards.', category:'Included', included:true, featureSlugs:['semantic-model','report','dashboard','paginated-report','scorecard'] },
  { id:'wl-realtime', name:'Real-Time Intelligence', description:'Event Hubs, Eventhouse, KQL databases + querysets + dashboards, Activator rules.', category:'Included', included:true, featureSlugs:['eventhouse','kql-database','kql-queryset','kql-dashboard','eventstream','activator'] },
  { id:'wl-power-platform', name:'Power Platform', description:'Environments, Dataverse, Power Apps, Power Automate, Power Pages, AI Builder.', category:'Included', included:true, featureSlugs:['dataverse-table','power-app','power-automate-flow','power-page','ai-builder-model'] },
  { id:'wl-copilot-studio', name:'Copilot Studio', description:'Agents, knowledge sources, topics, actions, channels, analytics, CSA template library.', category:'Included', included:true, featureSlugs:['copilot-studio-agent','copilot-studio-knowledge','copilot-studio-topic','copilot-studio-action','copilot-studio-channel','copilot-studio-analytics','copilot-template-library'] },
  { id:'wl-csa-fedramp', name:'FedRAMP Compliance Engine', description:'NIST 800-53 control mapping + continuous audit telemetry + IL5 deployment variant.', category:'CSA', included:false, featureSlugs:['scorecard','kql-dashboard','activator'] },
  { id:'wl-csa-geoanalytics', name:'Geoanalytics', description:'H3/S2 spatial indexing, ST_* functions over Lakehouse, Azure Maps integration.', category:'CSA', included:false, featureSlugs:['geo-map','geo-dataset','geo-query','geo-pipeline'] },
  { id:'wl-csa-graph', name:'Graph + Vector', description:'Cosmos Gremlin, Cypher (via ADX make-graph), GQL, vector store across Cosmos/AI Search/pgvector.', category:'CSA', included:false, featureSlugs:['cosmos-gremlin-graph','cypher-graph','gql-graph','vector-store'] },
];

export async function POST(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const now = new Date().toISOString();
  const stamp = { tenantId: TENANT, createdBy: 'bootstrap-catalogs', createdAt: now, updatedAt: now };

  const apps = await appsCatalogContainer();
  let appCount = 0;
  for (const a of APPS) {
    await apps.items.upsert({ ...a, ...stamp, installedBy: [] }).catch(() => {});
    appCount++;
  }

  const wls = await workloadsCatalogContainer();
  let wlCount = 0;
  for (const w of WORKLOADS) {
    await wls.items.upsert({ ...w, ...stamp, publisher: 'CSA', iconUrl: null }).catch(() => {});
    wlCount++;
  }

  // Provision the consumer-discovery AI Search index for the Data Marketplace.
  // Idempotent + best-effort: a brand-new env gets the index here; a missing
  // LOOM_AI_SEARCH_SERVICE just reports the honest gate (no throw).
  const dataProductsIndex = await ensureDataProductsIndex().catch((e: any) => ({
    created: false, ok: false, error: e?.message || String(e),
  }));

  return NextResponse.json({ ok: true, tenant: TENANT, appsSeeded: appCount, workloadsSeeded: wlCount, dataProductsIndex });
}
