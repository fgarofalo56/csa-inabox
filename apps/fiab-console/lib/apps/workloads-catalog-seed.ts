/**
 * The curated CSA workload catalog — SINGLE SOURCE OF TRUTH.
 *
 * WHY THIS MODULE EXISTS (#3375)
 *
 *   This list used to live as a private `WORKLOADS` const inside
 *   `app/api/admin/bootstrap-catalogs/route.ts`, reachable ONLY by a
 *   tenant-admin POST to that route. `docs/fiab/operator-interactive-setup.md`
 *   therefore told the operator to open the browser dev console on a fresh
 *   deployment and issue `POST /api/admin/bootstrap-catalogs` by hand.
 *
 *   That is a defect twice over:
 *     - `.claude/rules/auto-bind-by-default.md` §5 — an action the PLATFORM can
 *       perform must not be a step the user performs.
 *     - `.claude/rules/ux-baseline.md` G2 — zero day-one gates.
 *
 *   The sibling apps catalog already had the right shape: `GET
 *   /api/apps-catalog` carries a registry-derived backstop that upserts every
 *   registered content bundle on first read, so it self-heals with no operator
 *   action and no dependency on the (PE-locked, VNet-only) Cosmos seed ever
 *   having run. `GET /api/workloads-catalog` had NO such backstop — it copied
 *   from tenant `GLOBAL` and returned an empty list when GLOBAL was empty,
 *   which is exactly the state a fresh subscription is in.
 *
 *   Hoisting the list here lets BOTH consumers read the same definition:
 *     - `app/api/admin/bootstrap-catalogs/route.ts` — the explicit GLOBAL seed,
 *     - `app/api/workloads-catalog/route.ts`       — the per-tenant backstop,
 *   so the catalog is populated by the platform on first read and the dev
 *   console instruction could be deleted from the runbook.
 *
 * NOTE: the bootstrap seed writes these under tenant `GLOBAL`; the backstop
 * writes them under the signed-in tenant. Both stamp their own `tenantId`, so
 * the shape here carries none.
 */

export interface WorkloadSeed {
  id: string;
  name: string;
  description: string;
  category: string;
  included: boolean;
  featureSlugs: string[];
  homeHref?: string;
}

export const WORKLOAD_SEEDS: WorkloadSeed[] = [
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
