/**
 * R30 fragment — the 'builders' domain slice of GATE_META (formerly part of the
 * lib/gates/registry.ts monolith; entries sit in the same domain as their
 * ENV_CHECKS spec in lib/admin/env-checks/builders.ts). ./index.ts merges every
 * fragment into the same exported GATE_META shape (public API unchanged).
 * Import ONLY from './types' here — never './index' (barrel-cycle rule).
 */
import { L, type GateMeta } from './types';

export const BUILDERS_GATE_META: Record<string, GateMeta> = {
  // ── builders / catalog-governance / ai-copilot ──
  'svc-mcp-deploy': {
    surfaces: [{ path: '/admin/mcp-servers', label: 'MCP Servers — deploy catalog server' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_ACA_ENV_ID: L.acaEnv, LOOM_ACA_ENV_DOMAIN: L.acaEnvDomain },
  },
  'svc-warp-engine': {
    surfaces: [{ path: '/experience/warp', label: 'Warp transforms — Run' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_SYNAPSE_WORKSPACE: L.synapse, LOOM_DATABRICKS_HOSTNAME: L.databricks },
  },
  'svc-swa-publish': {
    surfaces: [
      { path: '/items/workshop-app', label: 'Workshop app — Publish' },
      { path: '/items/slate-app', label: 'Slate app — Publish' },
    ],
    fixit: { kind: 'env-picker' },
  },
  'svc-plan-writeback': {
    surfaces: [{ path: '/items/plan', label: 'Plan — SQL writeback mirror' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PLAN_BACKING_SQL_SERVER: L.sqlServer },
    autoResolveNote: 'Planning cells always persist Loom-native (Cosmos); the SQL mirror is an optional add-on.',
  },
  'svc-dab-runtime': {
    surfaces: [
      { path: '/items/data-api-builder', label: 'Data API builder — live testers' },
      { path: '/items/ontology-sdk', label: 'Ontology SDK — Try it' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Auto-wired on a push-button deploy (dabRuntimeEnabled, default on).',
  },
  'svc-udf-function': {
    surfaces: [{ path: '/items/user-data-function', label: 'User data functions — Invoke' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-apim': {
    surfaces: [
      { path: '/admin/api-management', label: 'API Management admin' },
      { path: '/marketplace', label: 'API marketplace / publish-as-API' },
    ],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_APIM_NAME: L.apim },
    legacyCodes: ['apim_not_configured'],
  },
  'svc-airflow': {
    surfaces: [{ path: '/items/airflow-job', label: 'Airflow job editor' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-copyjob-control': {
    surfaces: [{ path: '/items/copy-job', label: 'Copy job watermarks' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_COPYJOB_CONTROL_SQL_SERVER: L.sqlServer },
    legacyCodes: ['copyjob_control_not_configured'],
  },
  'svc-weave-ontology': {
    surfaces: [{ path: '/weave', label: 'Weave ontology store' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_WEAVE_PG_FQDN: L.pgFqdn },
    legacyCodes: ['weave_ontology_not_configured'],
  },
  'svc-dbt': {
    surfaces: [{ path: '/items/dbt-project', label: 'dbt runner' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['dbt_not_configured'],
  },
  'svc-transform-runner': {
    surfaces: [
      { path: '/items/transformation-project', label: 'Transformation project — Plan / Apply / Run' },
      { path: '/api/transform/*', label: 'Transform BFF (plan, apply, run, diff, environments)' },
    ],
    fixit: { kind: 'env-picker' },
    autoResolveNote: 'Auto-wired on a push-button deploy once the loom-transform-runner image is in ACR (the dbtRunnerImageReady switch also activates it). Authoring, codegen, and the model DAG work without it.',
    legacyCodes: ['transform_runner_not_configured'],
  },
  'svc-approval-logicapp': {
    surfaces: [{ path: '/items/data-pipeline', label: 'Pipeline approval activity' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['approval_not_configured'],
  },
  'svc-sample-data': {
    surfaces: [{ path: '/learn', label: 'Sample data seeds / practice pipelines' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_SAMPLE_ADLS: L.storage },
    legacyCodes: ['sample_adls_not_configured'],
  },
  'svc-csv-imports': {
    surfaces: [{ path: '/marketplace', label: 'Data product CSV import' }],
    fixit: { kind: 'env-picker' },
    legacyCodes: ['csv_imports_not_configured'],
  },
  'svc-feedback-forwarding': {
    surfaces: [{ path: '/admin/feedback-forwarding', label: 'Feedback forwarding' }],
    fixit: { kind: 'env-picker' },
  },
  'svc-param-sources': {
    surfaces: [{ path: '/items/data-pipeline', label: 'Parameter sources / trigger wizard' }],
    fixit: { kind: 'resource-picker' },
    loaders: { LOOM_PARAM_KEYVAULT: L.keyvault, LOOM_PARAM_APPCONFIG: L.appConfig },
  },
  'svc-data-wrangler': {
    surfaces: [{ path: '/items/notebook', label: 'Data Wrangler panel' }],
    fixit: { kind: 'env-picker' },
  },
};
