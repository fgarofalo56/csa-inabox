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
    id: 'svc-mcp-deploy', category: 'builders', title: 'MCP Servers — deploy backend (Container Apps)', severity: 'recommended',
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
    id: 'svc-swa-publish', category: 'builders', title: 'Static Web Apps publish (Workshop / Slate apps)', severity: 'recommended',
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
    id: 'svc-plan-writeback', category: 'builders', title: 'Plan (preview) — Azure SQL writeback store', severity: 'recommended',
    required: ['LOOM_PLAN_BACKING_SQL_SERVER', 'LOOM_PLAN_BACKING_SQL_DATABASE'], warnOnMiss: true, optionalDefault: true,
    remediation: 'Planning cells always persist Loom-native (Cosmos). To ALSO mirror them into a governed Azure SQL store (the Azure-native equivalent of Fabric\'s auto-provisioned Plan SQL database), deploy modules/shared/plan-backing-sql.bicep (or point at an existing DB) and set LOOM_PLAN_BACKING_SQL_SERVER + LOOM_PLAN_BACKING_SQL_DATABASE. Grant the Console UAMI db_ddladmin + db_datawriter on that database (AAD token auth — no SQL password). No Microsoft Fabric required.',
    provisionedBy: 'modules/shared/plan-backing-sql.bicep → admin-plane/main.bicep params loomPlanBackingSqlServer / loomPlanBackingSqlDatabase (apps[] env ~2579)',
    role: 'db_ddladmin + db_datawriter (Console UAMI AAD login) on the writeback database',
  },
  {
    id: 'svc-dab-runtime', category: 'builders', title: 'Data API builder — shared preview runtime', severity: 'recommended',
    required: ['LOOM_DAB_PREVIEW_URL'], warnOnMiss: true, derived: true,
    remediation: 'Auto-wired on a push-button deploy (dabRuntimeEnabled, default on): the loom-dab-preview Container App URL lands in LOOM_DAB_PREVIEW_URL. It powers the DAB editor\'s live REST/GraphQL testers + publish probe, the ontology-sdk "Try it" runner, and Slate rest-dab queries. The builders render fully without it — only run-against-runtime calls are gated.',
    provisionedBy: 'modules/admin-plane/dab-runtime.bicep (dabRuntimeEnabled) → LOOM_DAB_PREVIEW_URL apps[] env (admin-plane/main.bicep ~3650)',
    role: 'none (HTTP endpoint); entity queries additionally need the Console UAMI SQL login — scripts/csa-loom/grant-dab-sql.sh',
  },
  {
    id: 'svc-udf-function', category: 'builders', title: 'User data functions — Azure Functions run target', severity: 'recommended',
    required: ['LOOM_UDF_FUNCTION_BASE'], warnOnMiss: true,
    remediation: 'Set LOOM_UDF_FUNCTION_BASE to the shared Loom UDF runtime (or an Azure Function App) base URL (e.g. https://my-udf.azurewebsites.net) — the Azure-native invoke backend. The invoke route forwards the item\'s authored source (x-udf-source-b64) so the shared runtime executes THIS function, not a bundled sample. A per-item state.azureFunctionUrl overrides the base URL; a Fabric backend is opt-in ONLY via LOOM_UDF_BACKEND=fabric. The editor + code authoring work without it — only Invoke is gated.',
    provisionedBy: 'modules/admin-plane/udf-runtime.bicep (udfRuntimeEnabled, default on → the loom-udf-runtime Container App) → admin-plane/main.bicep apps[] env LOOM_UDF_FUNCTION_BASE (a BYO Functions host overrides via loomUdfFunctionBase); POST /api/items/user-data-function/[id]/invoke reads it',
    role: 'none (HTTPS endpoint); if the function requires a key, set state.functionKeySecret to the Key Vault secret name',
  },
  {
    id: 'svc-airflow', category: 'builders', title: 'Managed Airflow (airflow-job items)', severity: 'recommended',
    required: ['LOOM_AIRFLOW_ENDPOINT'], warnOnMiss: true,
    remediation: 'Set LOOM_AIRFLOW_ENDPOINT to the Airflow web endpoint so the airflow-job editor drives real DAG runs (airflow.bicep deploys it).',
    provisionedBy: 'modules/deploy-planner/airflow.bicep → apps[] env LOOM_AIRFLOW_ENDPOINT',
    role: 'Airflow API access (Console UAMI / basic auth via Key Vault)',
  },
  {
    id: 'svc-logic-apps', category: 'builders', title: 'Workflows — Azure Logic Apps (Consumption) target', severity: 'recommended',
    // AUTO-BIND (.claude/rules/auto-bind-by-default.md): creating a `logic-app`
    // item PROVISIONS + BINDS a real Microsoft.Logic/workflows resource named
    // after the item. That needs three ARM coordinates, ALL of which the
    // admin-plane already stamps on the Console container app — hence `derived`.
    //
    // #2954: this gate was previously invisible (no spec at all) AND unsatisfiable
    // (the provisioner read LOOM_LOGIC_LOCATION || LOOM_AZURE_LOCATION, neither of
    // which ANY bicep module sets). Registering it here means /admin/gates and
    // Copilot can both see + resolve it, and the alias groups below name the
    // variables the platform genuinely emits.
    anyOf: [
      ['LOOM_LOGIC_SUB', 'LOOM_SUBSCRIPTION_ID'],
      ['LOOM_LOGIC_RG', 'LOOM_DLZ_RG', 'LOOM_ADMIN_RG'],
      ['LOOM_LOGIC_LOCATION', 'LOOM_LOCATION'],
    ],
    warnOnMiss: true, derived: true,
    remediation: 'Workflow (logic-app) items auto-provision a real Azure Logic Apps Consumption workflow named after the item. A push-button deploy wires all three coordinates automatically (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_LOCATION); set the LOOM_LOGIC_* overrides only to target a different subscription, resource group, or region. If the configured resource group does not exist, auto-bind retries once against LOOM_ADMIN_RG rather than dead-ending. The Console UAMI also needs "Logic App Contributor" at RESOURCE-GROUP scope on whichever group it lands in — deploy-planner/logic-app.bicep grants exactly that on the DLZ RG (logicAppsEnabled, default on).',
    provisionedBy: 'modules/admin-plane/main.bicep apps[] env (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_LOCATION) + modules/deploy-planner/logic-app.bicep (logicAppsEnabled, default on → the RG-scoped Logic App Contributor grant)',
    role: 'Logic App Contributor (Console UAMI) at RESOURCE-GROUP scope on LOOM_DLZ_RG — a workflow-scoped grant 403s every new-workflow PUT',
    docs: 'https://learn.microsoft.com/rest/api/logic/workflows/create-or-update',
  },
  {
    id: 'svc-copyjob-control', category: 'builders', title: 'Copy job — watermark control store (Azure SQL)', severity: 'recommended',
    required: ['LOOM_COPYJOB_CONTROL_SQL_SERVER'], warnOnMiss: true,
    remediation: 'Set LOOM_COPYJOB_CONTROL_SQL_SERVER (the Azure SQL logical server) so incremental copy jobs persist watermarks (copyjob_control_not_configured). Full-load copy jobs work without it. HONEST STATE (measured 2026-08-10, docs/fiab/gov-readiness-2026-08-10.md): NO caller anywhere in platform/fiab/bicep passes admin-plane/main.bicep\'s loomCopyJobControlSqlServer param, so this var is emitted empty on every cloud and the control-table module (copy-job-control.bicep, guarded by !empty(loomCopyJobControlSqlServer)) never runs. The gate cannot currently be cleared by a deploy.',
    provisionedBy: 'NOT WIRED BY ANY TEMPLATE TODAY — admin-plane/main.bicep declares loomCopyJobControlSqlServer (default \'\') and emits it to apps[] env, but no orchestrator passes a value. NOTE modules/shared/plan-backing-sql.bicep (previously named here) creates only a DATABASE on an EXISTING Azure SQL logical server — it does not create the server, and it too is invoked only when loomPlanBackingSqlServer is non-empty, which nothing sets.',
    role: 'db_datawriter (Console UAMI AAD login) on the control database',
  },
  {
    id: 'svc-weave-ontology', category: 'builders', title: 'Weave ontology store (Postgres)', severity: 'recommended',
    required: ['LOOM_WEAVE_PG_FQDN'], warnOnMiss: true,
    remediation: 'Set LOOM_WEAVE_PG_FQDN so the Weave ontology store persists to its governed Postgres database (weave_ontology_not_configured). HONEST STATE (measured 2026-08-10, docs/fiab/gov-readiness-2026-08-10.md): main.bicep derives this FQDN only when useSingleDlz is true — i.e. topology single-sub. On a tenant or multi-sub deployment (which includes every GCC-High / IL5 deploy) it is emitted EMPTY even though weaveOntologyEnabled defaults true, so the gate cannot be cleared by a deploy on those topologies. Same cliff affects LOOM_BATCH_ACCOUNT, LOOM_POSTGRES_HOST and the AML default compute.',
    provisionedBy: 'modules/landing-zone/postgres-weave.bicep (Apache AGE PostgreSQL flexible server) → main.bicep loomWeavePgFqdn (main.bicep ~1385, gated on useSingleDlz && weaveOntologyEnabled) → admin-plane/main.bicep apps[] env LOOM_WEAVE_PG_FQDN. Previously this field named modules/deploy-planner/postgres-flexible.bicep — a path that does not exist.',
    role: 'Entra AAD login (Console UAMI) on the server',
  },
  {
    id: 'svc-dbt', category: 'builders', title: 'dbt runner (dbt-project items)', severity: 'recommended',
    required: ['LOOM_DBT_RUNNER_URL'], warnOnMiss: true,
    remediation: 'Set LOOM_DBT_RUNNER_URL to the deployed loom-dbt-runner Container App so dbt projects execute real runs (dbt_not_configured). Authoring works without it.',
    provisionedBy: 'modules/compute/dbt-runner-app.bicep → apps[] env LOOM_DBT_RUNNER_URL',
    role: 'none (in-VNet HTTP endpoint)',
  },
  {
    id: 'svc-transform-runner', category: 'builders', title: 'Transformation runner — dbt + SQLMesh (transformation-project items)', severity: 'recommended',
    required: ['LOOM_TRANSFORM_RUNNER_URL'], warnOnMiss: true, derived: true,
    remediation: 'Auto-wired on a push-button deploy: the loom-transform-runner Container App URL lands in LOOM_TRANSFORM_RUNNER_URL. It backs the transformation-project item\'s plan / apply / run / diff / environments calls for BOTH engines — dbt-core (the default) and SQLMesh (virtual data environments + plan/apply + column-level diff). Authoring, project-file generation, and the model DAG all render without it; only the engine calls are gated. Deploy platform/fiab/bicep/modules/integration/transform-runner-aca.bicep (activated once the loom-transform-runner image is in ACR — the same dbtRunnerImageReady switch), or set the URL directly here.',
    provisionedBy: 'modules/integration/transform-runner-aca.bicep (activated by admin-plane/main.bicep transformRunnerActive) → apps[] env LOOM_TRANSFORM_RUNNER_URL',
    role: 'none for the HTTP call (in-VNet internal ingress). The runner authenticates to the warehouse as the Console UAMI, which already holds Synapse SQL / Databricks / ADLS access; the module additionally grants it Storage Blob Data Contributor on the artifacts storage account.',
    // X2 — both engines are OSS Python on Azure Container Apps + the customer's
    // own Synapse/Databricks/ADLS. Nothing in the path is cloud-restricted, so
    // the capability is GA in every boundary, including disconnected IL5.
    availability: {
      commercial: 'ga', gccHigh: 'ga', il5: 'ga',
      fallbackNote: 'OSS dbt-core + SQLMesh in a Container App inside the deployment\'s own VNet, against customer-owned Synapse / Databricks / ADLS (DuckDB-over-ADLS for a fully disconnected enclave). SQLMesh state lives in the target engine\'s own sqlmesh_state schema. There is NO dbt Cloud and NO Tobiko Cloud in the path, so plan / apply / diff run air-gapped in IL5 with no egress.',
    },
  },
  {
    id: 'svc-approval-logicapp', category: 'builders', title: 'Pipeline approvals — Logic App', severity: 'recommended',
    required: ['LOOM_APPROVAL_LOGIC_APP_NAME'], warnOnMiss: true,
    remediation: 'Set LOOM_APPROVAL_LOGIC_APP_NAME (+ LOOM_SUBSCRIPTION_ID) so pipeline approval activities trigger the real approval Logic App (approval_not_configured).',
    provisionedBy: 'modules/admin-plane/approval-logicapp.bicep → apps[] env',
    role: 'Logic App Contributor (Console UAMI) on the app',
  },
  {
    id: 'svc-sample-data', category: 'builders', title: 'Sample data seeds (Learning Hub / practice pipelines)', severity: 'recommended',
    anyOf: [['LOOM_SAMPLE_ADLS', 'LOOM_ADLS_ACCOUNT']], warnOnMiss: true,
    remediation: 'Set LOOM_SAMPLE_ADLS (falls back to the DLZ account) so use-case app installs and practice pipelines seed real sample data (sample_adls_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep (samples container) → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI)',
  },
  {
    id: 'svc-csv-imports', category: 'builders', title: 'Data products — CSV import store', severity: 'recommended',
    required: ['LOOM_CSV_IMPORTS_URL'], warnOnMiss: true,
    remediation: 'Set LOOM_CSV_IMPORTS_URL (a Blob container URL) so data-product CSV imports have a landing store (csv_imports_not_configured).',
    provisionedBy: 'modules/landing-zone/storage.bicep (csv-imports container) → apps[] env',
    role: 'Storage Blob Data Contributor (UAMI) on the container',
  },
  {
    id: 'svc-feedback-forwarding', category: 'builders', title: 'Feedback forwarding (GitHub issues)', severity: 'recommended',
    required: ['LOOM_FEEDBACK_GITHUB_TOKEN'], warnOnMiss: true,
    // Feedback capture is ON by default via the in-store Cosmos inbox
    // (app/api/admin/feedback-forwarding). GitHub forwarding is an optional
    // upgrade requiring a customer-supplied fine-grained PAT — which cannot have
    // a deployment default. Absence loses ZERO function, so this is a
    // configured default-on substrate, not a red blocker.
    optionalDefault: true,
    optionalDefaultDetail: 'The in-store feedback inbox (Cosmos) captures every submission out of the box. GitHub forwarding is optional — set LOOM_FEEDBACK_GITHUB_TOKEN (a fine-grained PAT with issues:write, Key Vault-sourced) only to also open GitHub issues.',
    remediation: 'Optional. Set LOOM_FEEDBACK_GITHUB_TOKEN (fine-grained PAT with issues:write, Key Vault-sourced) to ALSO forward in-product feedback to GitHub issues. The in-store inbox captures everything without it.',
    provisionedBy: 'Customer-supplied GitHub PAT (Key Vault secretRef loom-feedback-github-token → apps[] env); no deployment default — the in-store inbox is the default.',
    role: 'GitHub fine-grained PAT (issues:write on the target repo)',
  },
  {
    id: 'svc-param-sources', category: 'builders', title: 'Pipeline parameter sources (Key Vault / App Config)', severity: 'recommended',
    anyOf: [['LOOM_PARAM_KEYVAULT', 'LOOM_PARAM_APPCONFIG']], warnOnMiss: true,
    remediation: 'Set LOOM_PARAM_KEYVAULT (vault URI) and/or LOOM_PARAM_APPCONFIG (App Configuration endpoint) so pipeline parameters and trigger wizards can bind to secret/config sources. Inline parameters work without it.',
    provisionedBy: 'modules/admin-plane/main.bicep (Key Vault / App Config) → apps[] env',
    role: 'Key Vault Secrets User / App Configuration Data Reader (Console UAMI)',
  },
  {
    id: 'svc-data-wrangler', category: 'builders', title: 'Data Wrangler runtime', severity: 'recommended',
    required: ['LOOM_WRANGLER_ENDPOINT'], warnOnMiss: true,
    remediation: 'Set LOOM_WRANGLER_ENDPOINT to the deployed loom-wrangler Container App so the Data Wrangler panel executes real transform previews. The notebook path works without it.',
    provisionedBy: 'modules/compute/wrangler-app.bicep → apps[] env LOOM_WRANGLER_ENDPOINT',
    role: 'none (in-VNet HTTP endpoint)',
  },
  {
    id: 'svc-apim', category: 'builders', title: 'API Management (publish-as-API / API marketplace)', severity: 'recommended',
    anyOf: [['LOOM_APIM_NAME', 'LOOM_APIM_RG', 'LOOM_SUBSCRIPTION_ID']], warnOnMiss: true,
    remediation: 'Set LOOM_SUBSCRIPTION_ID (LOOM_APIM_NAME / LOOM_APIM_RG default to the deployment names) so publish-as-API and the API marketplace can target the APIM service. The probe verifies the service actually resolves.',
    provisionedBy: 'modules/admin-plane (apimEnabled → APIM service) → apps[] env LOOM_APIM_NAME / LOOM_APIM_RG',
    role: 'API Management Service Contributor (Console UAMI) on the service',
  },
];
