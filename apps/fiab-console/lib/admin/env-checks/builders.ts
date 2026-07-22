/**
 * R30 fragment — the 'builders' domain slice of ENV_CHECKS (formerly part of the
 * lib/admin/env-checks.ts monolith). An env-adding item edits ONLY its own
 * domain fragment; ./index.ts merges every fragment into the same exported
 * ENV_CHECKS array (public API unchanged). Import ONLY from './core' here —
 * never './index' (barrel-cycle rule, WS-E1 gotcha).
 */
import type { EnvSpec } from './core';

export const BUILDERS_ENV_CHECKS: EnvSpec[] = [

  // ── builders (new surfaces — each works Loom-native on Cosmos by default; the
  //    env below only lights up the Azure-backed *deploy/run* target) ──
  {
    id: 'svc-mcp-deploy', category: 'builders', title: 'MCP Servers — deploy backend (Container Apps)', severity: 'optional',
    // The catalog list + built-in MCP server work without this. Deploying a
    // catalog MCP server as its own Container App needs the ACA managed
    // environment coordinates the deploy route mounts the new app into.
    anyOf: [['LOOM_ACA_ENV_ID', 'LOOM_ACA_ENV_DOMAIN']], warnOnMiss: true,
    remediation: 'The MCP Servers catalog + built-in server work without this. To DEPLOY a catalog MCP server as a Container App, set LOOM_ACA_ENV_ID (the managed environment resource id) + LOOM_ACA_ENV_DOMAIN; the Console UAMI also needs Contributor on the admin RG and a Key Vault for the server secretRefs. POST /api/admin/mcp-servers/deploy reads these.',
    provisionedBy: 'modules/admin-plane/main.bicep (Container Apps managed environment → apps[] env LOOM_ACA_ENV_ID / LOOM_ACA_ENV_DOMAIN)',
    role: 'Contributor (Console UAMI) on the admin RG + Key Vault Secrets User on the MCP secrets vault',
  },
  {
    id: 'svc-warp-engine', category: 'builders', title: 'Warp transforms — SQL run target (Synapse / Databricks)', severity: 'recommended',
    // Transforms persist Loom-native (items container). Running a transform
    // needs a real SQL engine — Synapse serverless/dedicated TDS OR Databricks
    // SQL. Either satisfies the gate (no Fabric dependency).
    anyOf: [['LOOM_SYNAPSE_WORKSPACE', 'LOOM_DATABRICKS_HOSTNAME']], warnOnMiss: true,
    remediation: 'Warp saves transforms Loom-native (items store) without this. To RUN a visual transform, set a SQL engine: LOOM_SYNAPSE_WORKSPACE (Synapse serverless/dedicated TDS) and/or LOOM_DATABRICKS_HOSTNAME (Databricks SQL warehouse). GET /api/experience/warp/transforms enumerates the available run targets from these.',
    provisionedBy: 'modules/landing-zone/synapse.bicep (loomSynapseWorkspace) and/or modules/landing-zone (Databricks workspace → loomDatabricksHostname)',
    role: 'Synapse SQL Administrator (UAMI) and/or Databricks workspace access (UAMI) on the chosen engine',
  },

  // ── wave-2 coverage: builder/publish/networking env the earlier checks missed.
  //    env-config.ts derives its EDITABLE_ENV whitelist from THESE specs — a var
  //    absent here is silently DROPPED by PUT /api/admin/env-config, so every
  //    runtime LOOM_ var a route reads must have a spec. ──
  {
    id: 'svc-swa-publish', category: 'builders', title: 'Static Web Apps publish (Workshop / Slate apps)', severity: 'optional',
    // The publish routes fall back: sub → LOOM_SUBSCRIPTION_ID, rg → LOOM_SWA_RG,
    // location → LOOM_LOCATION → 'eastus2' — hence the alias groups.
    anyOf: [
      ['LOOM_SWA_SUBSCRIPTION_ID', 'LOOM_SUBSCRIPTION_ID'],
      ['LOOM_SWA_RESOURCE_GROUP', 'LOOM_SWA_RG'],
      ['LOOM_SWA_LOCATION', 'LOOM_LOCATION'],
    ],
    warnOnMiss: true,
    remediation: 'Workshop and Slate apps PUBLISH to a real Azure Static Web App. Set LOOM_SWA_RESOURCE_GROUP (the resource group new SWAs deploy into; LOOM_SWA_SUBSCRIPTION_ID falls back to LOOM_SUBSCRIPTION_ID and LOOM_SWA_LOCATION defaults to eastus2) and grant the Console UAMI "Website Contributor" on that RG. The builders + in-editor Preview work without this — only one-click Publish is gated. No Microsoft Fabric required.',
    provisionedBy: 'modules/admin-plane/main.bicep apps[] env (LOOM_SWA_SUBSCRIPTION_ID / LOOM_SWA_RESOURCE_GROUP / LOOM_SWA_LOCATION — RG defaults to the admin RG, byoExisting.swaResourceGroup overrides) + swa-publish-rbac.bicep (Website Contributor grant); POST /api/items/{workshop-app,slate-app}/[id]/publish reads these',
    role: 'Website Contributor (Console UAMI) on the SWA resource group',
  },
  {
    id: 'svc-plan-writeback', category: 'builders', title: 'Plan (preview) — Azure SQL writeback store', severity: 'optional',
    required: ['LOOM_PLAN_BACKING_SQL_SERVER', 'LOOM_PLAN_BACKING_SQL_DATABASE'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Planning cells always persist Loom-native (Cosmos). To ALSO mirror them into a governed Azure SQL store (the Azure-native equivalent of Fabric\'s auto-provisioned Plan SQL database), deploy modules/shared/plan-backing-sql.bicep (or point at an existing DB) and set LOOM_PLAN_BACKING_SQL_SERVER + LOOM_PLAN_BACKING_SQL_DATABASE. Grant the Console UAMI db_ddladmin + db_datawriter on that database (AAD token auth — no SQL password). No Microsoft Fabric required.',
    provisionedBy: 'modules/shared/plan-backing-sql.bicep → admin-plane/main.bicep params loomPlanBackingSqlServer / loomPlanBackingSqlDatabase (apps[] env ~2579)',
    role: 'db_ddladmin + db_datawriter (Console UAMI AAD login) on the writeback database',
  },
  {
    id: 'svc-dab-runtime', category: 'builders', title: 'Data API builder — shared preview runtime', severity: 'optional',
    required: ['LOOM_DAB_PREVIEW_URL'], warnOnMiss: true, derived: true,
    remediation: 'Auto-wired on a push-button deploy (dabRuntimeEnabled, default on): the loom-dab-preview Container App URL lands in LOOM_DAB_PREVIEW_URL. It powers the DAB editor\'s live REST/GraphQL testers + publish probe, the ontology-sdk "Try it" runner, and Slate rest-dab queries. The builders render fully without it — only run-against-runtime calls are gated.',
    provisionedBy: 'modules/admin-plane/dab-runtime.bicep (dabRuntimeEnabled) → LOOM_DAB_PREVIEW_URL apps[] env (admin-plane/main.bicep ~3650)',
    role: 'none (HTTP endpoint); entity queries additionally need the Console UAMI SQL login — scripts/csa-loom/grant-dab-sql.sh',
  },
  {
    id: 'svc-udf-function', category: 'builders', title: 'User data functions — Azure Functions run target', severity: 'optional',
    required: ['LOOM_UDF_FUNCTION_BASE'], warnOnMiss: true,
    remediation: 'Set LOOM_UDF_FUNCTION_BASE to the shared Loom UDF runtime (or an Azure Function App) base URL (e.g. https://my-udf.azurewebsites.net) — the Azure-native invoke backend. The invoke route forwards the item\'s authored source (x-udf-source-b64) so the shared runtime executes THIS function, not a bundled sample. A per-item state.azureFunctionUrl overrides the base URL; a Fabric backend is opt-in ONLY via LOOM_UDF_BACKEND=fabric. The editor + code authoring work without it — only Invoke is gated.',
    provisionedBy: 'modules/admin-plane/udf-runtime.bicep (udfRuntimeEnabled, default on → the loom-udf-runtime Container App) → admin-plane/main.bicep apps[] env LOOM_UDF_FUNCTION_BASE (a BYO Functions host overrides via loomUdfFunctionBase); POST /api/items/user-data-function/[id]/invoke reads it',
    role: 'none (HTTPS endpoint); if the function requires a key, set state.functionKeySecret to the Key Vault secret name',
  },
  {
    id: 'svc-airflow', category: 'builders', title: 'Managed Airflow (airflow-job items)', severity: 'optional',
    required: ['LOOM_AIRFLOW_ENDPOINT'], warnOnMiss: true,
    remediation: 'Set LOOM_AIRFLOW_ENDPOINT to the Airflow web endpoint so the airflow-job editor drives real DAG runs (airflow.bicep deploys it).',
    provisionedBy: 'modules/deploy-planner/airflow.bicep → apps[] env LOOM_AIRFLOW_ENDPOINT',
    role: 'Airflow API access (Console UAMI / basic auth via Key Vault)',
  },
  {
    id: 'svc-copyjob-control', category: 'builders', title: 'Copy job — watermark control store (Azure SQL)', severity: 'optional',
    required: ['LOOM_COPYJOB_CONTROL_SQL_SERVER'], warnOnMiss: true,
    remediation: 'Set LOOM_COPYJOB_CONTROL_SQL_SERVER (the Azure SQL logical server) so incremental copy jobs persist watermarks (copyjob_control_not_configured). Full-load copy jobs work without it.',
    provisionedBy: 'modules/shared/plan-backing-sql.bicep (shared control SQL) → apps[] env',
    role: 'db_datawriter (Console UAMI AAD login) on the control database',
  },
  {
    id: 'svc-weave-ontology', category: 'builders', title: 'Weave ontology store (Postgres)', severity: 'optional',
    required: ['LOOM_WEAVE_PG_FQDN'], warnOnMiss: true,
    remediation: 'Set LOOM_WEAVE_PG_FQDN so the Weave ontology store persists to its governed Postgres database (weave_ontology_not_configured).',
    provisionedBy: 'modules/deploy-planner/postgres-flexible.bicep → apps[] env LOOM_WEAVE_PG_FQDN',
    role: 'Entra AAD login (Console UAMI) on the server',
  },
  {
    id: 'svc-dbt', category: 'builders', title: 'dbt runner (dbt-project items)', severity: 'optional',
    required: ['LOOM_DBT_RUNNER_URL'], warnOnMiss: true,
    remediation: 'Set LOOM_DBT_RUNNER_URL to the deployed loom-dbt-runner Container App so dbt projects execute real runs (dbt_not_configured). Authoring works without it.',
    provisionedBy: 'modules/compute/dbt-runner-app.bicep → apps[] env LOOM_DBT_RUNNER_URL',
    role: 'none (in-VNet HTTP endpoint)',
  },
  {
    id: 'svc-approval-logicapp', category: 'builders', title: 'Pipeline approvals — Logic App', severity: 'optional',
    required: ['LOOM_APPROVAL_LOGIC_APP_NAME'], warnOnMiss: true,
    remediation: 'Set LOOM_APPROVAL_LOGIC_APP_NAME (+ LOOM_SUBSCRIPTION_ID) so pipeline approval activities trigger the real approval Logic App (approval_not_configured).',
    provisionedBy: 'modules/admin-plane/approval-logicapp.bicep → apps[] env',
    role: 'Logic App Contributor (Console UAMI) on the app',
  },
  {
    id: 'svc-sample-data', category: 'builders', title: 'Sample data seeds (Learning Hub / practice pipelines)', severity: 'optional',
    anyOf: [['LOOM_SAMPLE_ADLS', 'LOOM_ADLS_ACCOUNT']], warnOnMiss: true,
    remediation: 'Set LOOM_SAMPLE_ADLS (falls back to the DLZ account) so use-case app installs and practice pipelines seed real sample data (sample_adls_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep (samples container) → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI)',
  },
  {
    id: 'svc-csv-imports', category: 'builders', title: 'Data products — CSV import store', severity: 'optional',
    required: ['LOOM_CSV_IMPORTS_URL'], warnOnMiss: true,
    remediation: 'Set LOOM_CSV_IMPORTS_URL (a Blob container URL) so data-product CSV imports have a landing store (csv_imports_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep (csv-imports container) → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI) on the container',
  },
  {
    id: 'svc-feedback-forwarding', category: 'builders', title: 'Feedback forwarding (GitHub issues)', severity: 'optional',
    required: ['LOOM_FEEDBACK_GITHUB_TOKEN'], warnOnMiss: true,
    remediation: 'Set LOOM_FEEDBACK_GITHUB_TOKEN (fine-grained PAT, Key Vault-sourced) so in-product feedback forwards to GitHub issues. The in-store feedback inbox works without it.',
    provisionedBy: 'ACA secret loom-feedback-github-token → apps[] env',
    role: 'GitHub fine-grained PAT (issues:write on the target repo)',
  },
  {
    id: 'svc-param-sources', category: 'builders', title: 'Pipeline parameter sources (Key Vault / App Config)', severity: 'optional',
    anyOf: [['LOOM_PARAM_KEYVAULT', 'LOOM_PARAM_APPCONFIG']], warnOnMiss: true,
    remediation: 'Set LOOM_PARAM_KEYVAULT (vault URI) and/or LOOM_PARAM_APPCONFIG (App Configuration endpoint) so pipeline parameters and trigger wizards can bind to secret/config sources. Inline parameters work without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (Key Vault / App Config) → apps[] env',
    role: 'Key Vault Secrets User / App Configuration Data Reader (Console UAMI)',
  },
  {
    id: 'svc-data-wrangler', category: 'builders', title: 'Data Wrangler runtime', severity: 'optional',
    required: ['LOOM_WRANGLER_ENDPOINT'], warnOnMiss: true,
    remediation: 'Set LOOM_WRANGLER_ENDPOINT to the deployed loom-wrangler Container App so the Data Wrangler panel executes real transform previews. The notebook path works without it.',
    provisionedBy: 'modules/compute/wrangler-app.bicep → apps[] env LOOM_WRANGLER_ENDPOINT',
    role: 'none (in-VNet HTTP endpoint)',
  },
  {
    id: 'svc-apim', category: 'builders', title: 'API Management (publish-as-API / API marketplace)', severity: 'optional',
    anyOf: [['LOOM_APIM_NAME', 'LOOM_APIM_RG', 'LOOM_SUBSCRIPTION_ID']], warnOnMiss: true,
    remediation: 'Set LOOM_SUBSCRIPTION_ID (LOOM_APIM_NAME / LOOM_APIM_RG default to the deployment names) so publish-as-API and the API marketplace can target the APIM service. The probe verifies the service actually resolves.',
    provisionedBy: 'modules/admin-plane (apimEnabled → APIM service) → apps[] env LOOM_APIM_NAME / LOOM_APIM_RG',
    role: 'API Management Service Contributor (Console UAMI) on the service',
  },
];
