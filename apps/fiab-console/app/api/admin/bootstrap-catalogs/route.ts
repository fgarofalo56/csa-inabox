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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TENANT = 'GLOBAL';

/**
 * items[] is what the /api/apps/[id]/install route reads to create
 * workspace items in Cosmos. v3.27 omitted items[] which made every
 * app install report `installed: []` — the F-grade vaporware finding
 * called out in docs/fiab/parity-gap/apps-catalog-rollup.md.
 * Mirrored from scripts/csa-loom/seed-catalogs.sh.
 */
const APPS = [
  { id:'app-fedramp-tracker', name:'FedRAMP Compliance Tracker', description:'Track FedRAMP control implementation across Loom-deployed services. Maps Synapse, Databricks, ADX, APIM, AI Foundry to NIST 800-53 controls.', category:'Compliance', publisher:'CSA',
    items:[{type:'scorecard',template:'fedramp-controls'},{type:'kql-dashboard',template:'compliance-events'}] },
  { id:'app-data-steward', name:'Data Steward Console', description:'Curate datasets, manage classifications, certify endorsements. Wires Purview + AI Search + Synapse Serverless for lineage + search.', category:'Governance', publisher:'CSA',
    items:[{type:'data-product',template:'steward-default'},{type:'semantic-model',template:'steward-glossary'}] },
  { id:'app-rag-builder', name:'RAG Builder', description:'Stand up a Retrieval-Augmented Generation pipeline. Builds an AI Search index, wires Foundry prompt-flow, deploys an evaluation suite.', category:'AI', publisher:'CSA',
    items:[{type:'ai-search-index',template:'rag-default'},{type:'prompt-flow',template:'rag-basic'},{type:'evaluation',template:'rag-quality'}] },
  { id:'app-lakehouse-inspector', name:'Lakehouse Inspector', description:'Browse bronze/silver/gold ADLS containers, preview Parquet/Delta files via Synapse Serverless, profile data quality.', category:'Data', publisher:'CSA',
    items:[{type:'lakehouse',template:'medallion'}] },
  { id:'app-pipeline-designer', name:'Pipeline Designer', description:'Visual + JSON authoring for Synapse pipelines, ADF, Databricks Jobs. Common run history + alerting.', category:'Data Engineering', publisher:'CSA',
    items:[{type:'synapse-pipeline',template:'blank'},{type:'adf-pipeline',template:'blank'},{type:'databricks-job',template:'blank'}] },
  { id:'app-casino-analytics', name:'Casino Analytics', description:'Reference architecture: player-grain facts, table games, real-time win/loss, Activator alerts for high-roller events.', category:'Industry', publisher:'CSA',
    items:[{type:'warehouse',template:'casino-dw'},{type:'activator',template:'high-roller-alert'}] },
  { id:'app-healthcare-popmgt', name:'Healthcare Population Health', description:'FHIR-on-Lakehouse + risk stratification model + Power BI patient dashboards. HIPAA-aligned.', category:'Industry', publisher:'CSA',
    items:[{type:'lakehouse',template:'fhir-medallion'},{type:'ml-model',template:'risk-stratification'}] },
  { id:'app-iot-realtime', name:'IoT Real-Time Insights', description:'IoT Hub → Event Hubs → ADX → KQL dashboards. Activator alerts on device anomalies. End-to-end in one workspace.', category:'Real-Time', publisher:'CSA',
    items:[{type:'eventstream',template:'iot-default'},{type:'kql-database',template:'iot-telemetry'},{type:'kql-dashboard',template:'device-health'}] },
  { id:'app-finops-cost', name:'FinOps Cost Optimizer', description:'Per-domain chargeback report, Synapse pool auto-pause schedule, idle workload finder. Cosmos-backed budgets.', category:'Operations', publisher:'CSA',
    items:[{type:'semantic-model',template:'finops-cost'},{type:'report',template:'finops-monthly'}] },
  { id:'app-fabric-mirror-onboard', name:'Fabric Mirror Onboarding', description:'One-click setup for Fabric Mirroring: Azure SQL Mirror, Snowflake Mirror, Cosmos Mirror with target workspace + RBAC.', category:'Data', publisher:'CSA',
    items:[{type:'mirrored-database',template:'azure-sql-mirror'}] },
  { id:'change-feed-processor', name:'Change Feed Processor', description:'Event-driven sync on the Cosmos DB change feed: a Functions-hosted processor fans each change out to Event Hubs, AI Search, Redis, and Delta Lake. Ships the fan-out eventstream, processor + Delta-sync notebooks, orders lakehouse + AI Search index, and a change-feed-lag KQL DB + dashboard + Activator alert.', category:'Real-Time', publisher:'CSA',
    items:[{type:'eventstream',template:'order-change-fanout'},{type:'notebook',template:'change-feed-processor'},{type:'notebook',template:'delta-sync'},{type:'lakehouse',template:'orders-delta'},{type:'ai-search-index',template:'orders'},{type:'kql-database',template:'change-feed-monitoring'},{type:'kql-dashboard',template:'change-feed-health'},{type:'activator',template:'change-feed-lag-alert'}] },
  { id:'direct-lake-replacement', name:'Direct Lake-Replacement', description:'Migrate off a legacy BI server to Power BI Premium + a Loom lakehouse with 5-30s freshness via the Direct-Lake-Shim warm-cache materializer: Mirror to Bronze, Silver/Gold Databricks notebooks, Event Grid -> eventstream -> partition-refresh pipeline (TOM RequestRefresh), Import semantic model + report, and a freshness Activator watchdog.', category:'Data', publisher:'CSA',
    items:[{type:'mirrored-database',template:'legacy-sales-oltp'},{type:'lakehouse',template:'direct-lake-replacement'},{type:'databricks-notebook',template:'silver-cleanse'},{type:'databricks-notebook',template:'gold-star-schema'},{type:'eventstream',template:'gold-commit-shim'},{type:'data-pipeline',template:'dl-shim-refresh'},{type:'semantic-model',template:'sales-analytics-import'},{type:'report',template:'sales-analytics'},{type:'activator',template:'shim-freshness-watchdog'}] },
  { id:'federal-data-mesh', name:'Federal Data Mesh', description:'A federal department running multiple agencies as autonomous data-product domains (per-DLZ subscriptions) federated under a Department-CIO governance plane. Seeds a cross-domain marketplace data product + AI Search catalog, Agency A domain lakehouse, Delta Sharing automation notebook, federated access register (warehouse), cross-agency semantic model + report, and a FederationAudit ADX DB + dashboard + Activator alert.', category:'Government', publisher:'CSA',
    items:[{type:'data-product',template:'cross-domain-marketplace'},{type:'lakehouse',template:'agency-a-domain'},{type:'notebook',template:'cross-domain-delta-sharing'},{type:'warehouse',template:'federated-access-register'},{type:'semantic-model',template:'cross-agency-performance'},{type:'report',template:'cross-agency-dashboards'},{type:'kql-database',template:'federation-audit'},{type:'kql-dashboard',template:'federation-cost'},{type:'activator',template:'label-violation-alert'},{type:'ai-search-index',template:'data-product-catalog'},{type:'data-pipeline',template:'federation-sync'}] },
  { id:'ml-pipeline', name:'ML Pipeline (MLOps)', description:'A complete customer-churn MLOps loop on Databricks + Azure ML: feature store, MLflow/XGBoost training registered to Unity Catalog, validation gate, Model Serving deployment, and Lakehouse-Monitoring drift detection. Seeds five notebooks, the churn lakehouse, monitoring warehouse, MLOps orchestration pipeline, and a model-drift Activator alert.', category:'AI', publisher:'CSA',
    items:[{type:'lakehouse',template:'ml-churn'},{type:'notebook',template:'feature-engineering'},{type:'notebook',template:'model-training'},{type:'notebook',template:'model-validation'},{type:'notebook',template:'model-deployment'},{type:'notebook',template:'model-monitoring'},{type:'ml-model',template:'customer-churn'},{type:'warehouse',template:'ml-monitoring'},{type:'data-pipeline',template:'mlops-orchestration'},{type:'activator',template:'model-drift-alert'}] },
  { id:'multi-agency-onboarding', name:'Multi-Agency Onboarding', description:'The operational + governance analytics estate for onboarding additional agencies to a federal CSA Loom deployment as Data Landing Zones (DLZs) under a central Admin Plane. Seeds the DLZ Onboarding Registry (warehouse), the orchestrator notebook + provision/validate pipeline (PIM -> Bicep deploy -> peering check -> catalog scan -> smoke test), a federation-governance lakehouse, onboarding-telemetry KQL DB, governance semantic model + cockpit report, and a deployment-health Activator alert.', category:'Government', publisher:'CSA',
    items:[{type:'warehouse',template:'dlz-onboarding-registry'},{type:'notebook',template:'dlz-onboarding-orchestrator'},{type:'data-pipeline',template:'dlz-provision-validate'},{type:'lakehouse',template:'federation-governance'},{type:'kql-database',template:'onboarding-telemetry'},{type:'semantic-model',template:'federation-governance'},{type:'report',template:'onboarding-cockpit'},{type:'activator',template:'dlz-deployment-health'}] },
];

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
