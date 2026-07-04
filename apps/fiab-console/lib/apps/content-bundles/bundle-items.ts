/**
 * Lightweight per-bundle item-type manifest — rel-T63.
 *
 * Maps each content-bundle appId to the ORDERED list of item types the
 * bundle ships (with duplicates preserved, e.g. the Supercharge medallion
 * bundles carry many 'notebook' items). This is the LEAN projection the
 * apps-catalog seed + bootstrap need to build each catalog doc's
 * items:[{type, template}] array WITHOUT importing the heavy (~3.1 MB)
 * per-bundle content payloads. The full payload is loaded lazily via the
 * async getBundle(appId) in ./index.ts only when an app is actually
 * installed / a notebook imported.
 *
 * Drift is guarded by content-bundles/__tests__/bundle-items-manifest.test.ts,
 * which asserts BUNDLE_ITEM_TYPES[id] deep-equals (await getBundle(id)).items
 * mapped to itemType — so this manifest can never silently disagree with the
 * real bundles. If a bundle's items change, that test fails until this map is
 * regenerated.
 */
export const BUNDLE_ITEM_TYPES: Record<string, string[]> = {
  'app-azure-realtime-analytics': ['lakehouse', 'notebook', 'notebook', 'notebook', 'notebook', 'warehouse', 'kql-database', 'kql-dashboard', 'data-pipeline', 'semantic-model', 'activator',],
  'app-casino-analytics': ['warehouse', 'activator', 'notebook', 'notebook',],
  'app-change-feed-processor': ['eventstream', 'notebook', 'notebook', 'lakehouse', 'ai-search-index', 'kql-database', 'kql-dashboard', 'activator',],
  'app-data-governance': ['data-product', 'notebook', 'activator',],
  'app-data-steward': ['data-product', 'semantic-model',],
  'app-direct-lake-replacement': ['mirrored-database', 'lakehouse', 'databricks-notebook', 'databricks-notebook', 'eventstream', 'data-pipeline', 'semantic-model', 'report', 'activator',],
  'app-fabric-mirror-onboard': ['mirrored-database', 'lakehouse', 'notebook',],
  'app-federal-data-mesh': ['data-product', 'lakehouse', 'notebook', 'warehouse', 'semantic-model', 'report', 'kql-database', 'kql-dashboard', 'activator', 'ai-search-index', 'data-pipeline',],
  'app-fedramp-tracker': ['scorecard', 'kql-dashboard',],
  'app-finops-cost': ['semantic-model', 'report', 'kql-dashboard',],
  'app-healthcare-popmgt': ['lakehouse', 'ml-model',],
  'app-hybrid-topology': ['warehouse', 'data-product', 'lakehouse', 'notebook', 'mirrored-database', 'data-pipeline', 'semantic-model', 'report', 'kql-database', 'kql-dashboard', 'activator', 'ai-search-index',],
  'app-iot-realtime': ['eventstream', 'kql-database', 'kql-dashboard',],
  'app-lakehouse-inspector': ['lakehouse', 'notebook',],
  'app-logic-apps-integration': ['logic-app', 'logic-app', 'logic-app', 'activator',],
  'app-ml-pipeline': ['lakehouse', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'ml-model', 'warehouse', 'data-pipeline', 'activator',],
  'app-multi-agency-onboarding': ['warehouse', 'notebook', 'data-pipeline', 'lakehouse', 'kql-database', 'semantic-model', 'report', 'activator',],
  'app-pipeline-designer': ['synapse-pipeline', 'adf-pipeline', 'databricks-job', 'warehouse',],
  'app-rag-builder': ['ai-search-index', 'prompt-flow', 'evaluation', 'notebook',],
  'app-real-time-dashboards': ['eventstream', 'kql-database', 'kql-dashboard', 'activator', 'semantic-model', 'report',],
  'app-sovereign-ai-agents': ['prompt-flow', 'ai-search-index', 'kql-database', 'evaluation', 'notebook',],
  'app-supercharge-bronze': ['notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook',],
  'app-supercharge-gold': ['notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook',],
  'app-supercharge-guide': ['notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook',],
  'app-supercharge-ml': ['notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook',],
  'app-supercharge-silver': ['notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook',],
  'app-supercharge-streaming': ['notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook', 'notebook',],
  'app-supercharge-utils': ['notebook', 'notebook', 'notebook',],
  'app-workspace-monitoring': ['workspace-monitor', 'kql-dashboard',],
};
