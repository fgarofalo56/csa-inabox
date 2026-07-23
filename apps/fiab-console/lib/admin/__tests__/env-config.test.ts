import { describe, it, expect } from 'vitest';
import {
  EDITABLE_ENV,
  isEditableEnvKey,
  getEditableEnv,
  maskValue,
  buildSyncArtifacts,
  ENV_ALIAS_GROUPS,
  aliasSatisfiedKeys,
} from '../env-config';

describe('admin/env-config registry', () => {
  it('derives the editable whitelist from ENV_CHECKS (non-empty, deduped)', () => {
    expect(EDITABLE_ENV.length).toBeGreaterThan(5);
    const keys = EDITABLE_ENV.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length); // no dupes
    // Known critical keys must be present + settable.
    expect(isEditableEnvKey('LOOM_COSMOS_ENDPOINT')).toBe(true);
    expect(isEditableEnvKey('LOOM_SUBSCRIPTION_ID')).toBe(true);
    expect(isEditableEnvKey('SESSION_SECRET')).toBe(true);
  });

  it('flattens anyOf groups into individual settable keys', () => {
    // entra-app required LOOM_MSAL_CLIENT_ID + anyOf [AZURE_TENANT_ID |
    // LOOM_MSAL_TENANT_ID]; cosmos-config anyOf [LOOM_COSMOS_ENDPOINT |
    // COSMOS_ENDPOINT] — every alias key in those groups must be settable.
    expect(isEditableEnvKey('LOOM_MSAL_CLIENT_ID')).toBe(true);
    expect(isEditableEnvKey('AZURE_TENANT_ID')).toBe(true);
    expect(isEditableEnvKey('LOOM_MSAL_TENANT_ID')).toBe(true);
    expect(isEditableEnvKey('COSMOS_ENDPOINT')).toBe(true);
  });

  it('flags secret-typed keys and never echoes their value', () => {
    expect(getEditableEnv('SESSION_SECRET')?.secret).toBe(true);
    expect(getEditableEnv('LOOM_COSMOS_ENDPOINT')?.secret).toBe(false);
    expect(maskValue('SESSION_SECRET', 'super-secret-value')).toBe('***');
    expect(maskValue('LOOM_COSMOS_ENDPOINT', 'https://x.documents.azure.com:443/')).toBe('https://x.documents.azure.com:443/');
  });

  it('rejects unknown keys (no-freeform-config whitelist)', () => {
    expect(isEditableEnvKey('LOOM_TOTALLY_MADE_UP')).toBe(false);
    expect(getEditableEnv('LOOM_TOTALLY_MADE_UP')).toBeUndefined();
  });

  it('builds CLI + bicep reconcile artifacts for changed keys', () => {
    const { cliScript, bicepEnvSnippet } = buildSyncArtifacts(
      { LOOM_COSMOS_DATABASE: 'loom' },
      ['SESSION_SECRET'],
    );
    expect(cliScript).toContain('az containerapp update');
    expect(cliScript).toContain('LOOM_COSMOS_DATABASE=loom');
    // Secret is set via secret + secretref, never as a plain value.
    expect(cliScript).toContain('az containerapp secret set');
    expect(cliScript).toContain('SESSION_SECRET=secretref:session-secret');
    expect(bicepEnvSnippet).toContain("name: 'LOOM_COSMOS_DATABASE'");
    expect(bicepEnvSnippet).toContain("secretRef: 'session-secret'");
  });

  it('surfaces the usage + govern analytics embed vars as settable (F21/F2)', () => {
    for (const k of [
      'LOOM_USAGE_REPORT_KIND', 'LOOM_USAGE_PBI_WORKSPACE_ID', 'LOOM_USAGE_PBI_REPORT_ID',
      'LOOM_GRAFANA_USAGE_DASHBOARD_UID', 'LOOM_GRAFANA_ENDPOINT',
      'LOOM_REPORT_KIND', 'LOOM_GOVERN_PBI_WORKSPACE_ID', 'LOOM_GOVERN_PBI_REPORT_ID',
      'LOOM_GRAFANA_DASHBOARD_UID',
    ]) {
      expect(isEditableEnvKey(k)).toBe(true);
    }
    // None of these embed config vars are secret-typed.
    expect(getEditableEnv('LOOM_USAGE_PBI_WORKSPACE_ID')?.secret).toBe(false);
  });

  it('carries provisionedBy + role so an unset var names its exact bicep module/role', () => {
    const usage = getEditableEnv('LOOM_USAGE_REPORT_KIND');
    expect(usage?.provisionedBy).toMatch(/admin-plane\/main\.bicep/);
    expect(usage?.role).toMatch(/Power BI workspace Member|Grafana/);
    // Cosmos (a core var) also carries its provisioning hint.
    expect(getEditableEnv('LOOM_COSMOS_ENDPOINT')?.provisionedBy).toBeTruthy();
  });

  it('exposes anyOf alias groups (either/or requirements) including bootstrap-admin', () => {
    const hasAdminGroup = ENV_ALIAS_GROUPS.some(
      (g) => g.includes('LOOM_TENANT_ADMIN_OID') && g.includes('LOOM_TENANT_ADMIN_GROUP_ID'),
    );
    expect(hasAdminGroup).toBe(true);
    // Cosmos alias pair + MSAL/Azure tenant alias pair are also groups.
    expect(ENV_ALIAS_GROUPS.some((g) => g.includes('LOOM_COSMOS_ENDPOINT') && g.includes('COSMOS_ENDPOINT'))).toBe(true);
    expect(ENV_ALIAS_GROUPS.some((g) => g.includes('AZURE_TENANT_ID') && g.includes('LOOM_MSAL_TENANT_ID'))).toBe(true);
  });

  it('marks the OTHER member of a satisfied anyOf group as satisfied (no false critical)', () => {
    // OID set, GROUP_ID unset → GROUP_ID is satisfied (the either/or is met).
    const setKeys = new Set(['LOOM_TENANT_ADMIN_OID']);
    const satisfied = aliasSatisfiedKeys((k) => setKeys.has(k));
    expect(satisfied.has('LOOM_TENANT_ADMIN_GROUP_ID')).toBe(true);
    // The directly-set key is NOT in the satisfied (alias) set.
    expect(satisfied.has('LOOM_TENANT_ADMIN_OID')).toBe(false);
    // COSMOS_ENDPOINT is satisfied when its preferred alias LOOM_COSMOS_ENDPOINT is set.
    const cosmosSet = new Set(['LOOM_COSMOS_ENDPOINT']);
    expect(aliasSatisfiedKeys((k) => cosmosSet.has(k)).has('COSMOS_ENDPOINT')).toBe(true);
    // Nothing set → nothing alias-satisfied.
    expect(aliasSatisfiedKeys(() => false).size).toBe(0);
  });

  it('marks the Power BI embed vars satisfied when the Grafana embed path is active (mutually-exclusive backends)', () => {
    // Day-one the deploy wires the Grafana embed path (#1461): KIND=grafana +
    // the two stable dashboard UIDs. The four Power BI embed vars are then the
    // UNUSED alternative backend and must report as alias-satisfied (so the
    // env-config catalog counts them as configured → 40/40, not a false
    // "not set"). This is the either/or that backs the Wave-2 coverage fix.
    const grafanaSet = new Set([
      'LOOM_USAGE_REPORT_KIND', 'LOOM_REPORT_KIND',
      'LOOM_GRAFANA_USAGE_DASHBOARD_UID', 'LOOM_GRAFANA_DASHBOARD_UID', 'LOOM_GRAFANA_ENDPOINT',
    ]);
    const satisfied = aliasSatisfiedKeys((k) => grafanaSet.has(k));
    expect(satisfied.has('LOOM_USAGE_PBI_WORKSPACE_ID')).toBe(true);
    expect(satisfied.has('LOOM_USAGE_PBI_REPORT_ID')).toBe(true);
    expect(satisfied.has('LOOM_GOVERN_PBI_WORKSPACE_ID')).toBe(true);
    expect(satisfied.has('LOOM_GOVERN_PBI_REPORT_ID')).toBe(true);
    // LOOM_ALERT_RG is the either/or partner of LOOM_ADMIN_RG — satisfied when
    // the admin RG is set (bicep also emits LOOM_ALERT_RG directly day-one).
    const adminRgSet = new Set(['LOOM_ADMIN_RG']);
    expect(aliasSatisfiedKeys((k) => adminRgSet.has(k)).has('LOOM_ALERT_RG')).toBe(true);
  });

  it('exposes exactly the 62 editable runtime variables (catalog completeness)', () => {
    // The env-config catalog is the union of every required + anyOf key across
    // ENV_CHECKS. The /admin/env-config coverage badge reads N-of-<count>; this
    // pins the catalog size so a drift in ENV_CHECKS is caught in CI. Bumped to
    // 60 by the wave-2 coverage fix (SWA publish, Activator ADX scope, managed-PE
    // subnet, Plan SQL writeback, DAB preview runtime, UDF invoke base, OneLake
    // ACL enforcement, Azure Maps backend/credential) — previously these keys
    // were silently DROPPED by PUT /api/admin/env-config. Bumped to 62 by
    // BR-SIEM (LOOM_AUDIT_DCR_ENDPOINT + LOOM_AUDIT_DCR_ID, the LoomAudit_CL
    // SIEM audit-stream wiring). Bumped to 67 by SVC-1/SVC-8 (the svc-ai-enrich
    // spec adds LOOM_DOCINTEL_ENDPOINT / LOOM_VISION_ENDPOINT /
    // LOOM_LANGUAGE_ENDPOINT / LOOM_TRANSLATOR_ENDPOINT / LOOM_CONTENT_SAFETY_ENDPOINT
    // — the AI-enrichment pipeline-activity cognitive endpoints). Bumped to 71 by
    // HYP-16 (the Hyperscale band substrate services: LOOM_ONELAKE_URL,
    // LOOM_DIRECTLAKE_URL, LOOM_BROKER_URL, LOOM_BROKER_REDIS — the three optional
    // default-OFF H-band service URLs + the shared Redis host). Bumped to 73 by
    // PSR-3 (LOOM_SPARK_POOL_LEASE_CONTAINER + LOOM_SPARK_POOL_REDIS — the warm
    // Spark pool's cross-replica lease-store substrate signals). Bumped to 139
    // by the CONVERGED wave-3 expansions: the health-coverage audit
    // (docs/fiab/health-coverage-audit.md: svc-aas, svc-aml, svc-apim,
    // svc-powerplatform, svc-keyvault, svc-servicebus, svc-stream-analytics,
    // svc-azure-sql, svc-postgres, svc-eventgrid, svc-batch,
    // svc-redis-result-cache) UNIONED with the G2 gate-registry promotion of
    // every remaining bespoke *_not_configured gate (MIP/DLP, Event Grid
    // topics/webhooks, IoT Hub, Digital Twins, Airflow, Postgres family, dbt,
    // SHIR, Dataverse, medallion layers, Cosmos control-plane, embeddings, …)
    // so every gate is editable on /admin/env-config and resolvable from
    // /admin/gates + the Fix-it wizard (docs/fiab/gate-registry.md), plus
    // LOOM_AOAI_DEPLOYMENT joining the svc-aoai anyOf groups.
    // Bumped to 135 by access-governance W4 (svc-graph-group-sync:
    // LOOM_GRAPH_GROUP_SYNC_ENABLED — opt-in, optionalDefault, Graph read-only
    // Entra group reconcile for group-targeted access packages).
    // Bumped to 137 by WS-1.1 (svc-model-reasoning-tier: LOOM_AOAI_STRONG_DEPLOYMENT
    // + LOOM_AOAI_MINI_DEPLOYMENT — the model tier router's reasoning + mini tier
    // deployments, admin-tunable + optionalDefault: unset silently rides the single
    // default AOAI deployment for every turn, fully functional).
    // Bumped to 138 by the Gov-89 AAS recognition: LOOM_SEMANTIC_BACKEND joins
    // the svc-aas anyOf (the Loom-native tabular layer is the DEFAULT engine;
    // AAS is an optional Commercial/GCC fast-path, unavailable in GCC-High).
    // Bumped to 139 by WS-1.2 (svc-model-serving: LOOM_MODEL_SERVING_BACKEND —
    // the model-serving backend selector, default 'aml' = Azure ML managed online
    // endpoints, opt-in 'databricks' = Mosaic serving; the workspace/hostname keys
    // it also references are shared with svc-aml / svc-databricks, so only the
    // selector is a NEW editable var).
    // Bumped to 140 by the Gov OSS Maps replacement: LOOM_MAPS_TILE_URL joins the
    // svc-azure-maps anyOf (the self-hosted OSS MapLibre tileserver — the GCC-High
    // path where Azure Maps is unavailable; served in-VNet via the Console proxy).
    // Bumped to 141 by WS-2.1 (svc-feature-store: LOOM_FEATURE_STORE_BACKEND — the
    // Feature Store offline backend selector, default = Unity Catalog on Commercial /
    // auto-PostgreSQL on the sovereign OSS-UC / Gov path; the databricks-hostname /
    // pgvector-host keys it also references are shared with svc-databricks /
    // svc-postgres, so only the selector is a NEW editable var).
    // Bumped to 143 by WS-1.3 (svc-fine-tuning): LOOM_FINETUNE_BACKEND (the AOAI vs
    // Databricks fine-tuning backend selector) + LOOM_AOAI_ACCOUNT (the AIServices/
    // OpenAI account the fine-tuning + model-deployment REST targets) are both NEW
    // editable vars; the LOOM_AOAI_ENDPOINT / LOOM_FOUNDRY_NAME keys it also
    // references are shared with svc-aoai / svc-aml.
    // 143 base → WS-5.2 svc-a2a-egress added LOOM_A2A_EGRESS_ALLOW (144) →
    // WS-10.1 svc-lcu-autopilot added LOOM_AUTOPILOT_MODE + LOOM_CAPACITY_LCU
    // (146) → WS-9 svc-agent-mesh adds LOOM_MESH_PROFILE (147) → WS-C2
    // svc-report-subscriptions adds LOOM_REPORT_SUBSCRIPTIONS_FUNCTION +
    // LOOM_SUBSCRIPTION_LOGIC_APP_NAME (149) — two NEW → C1 svc-cost-management
    // adds LOOM_BILLING_SCOPE (150) → S1 svc-secret-expiry adds
    // LOOM_ALERT_ACTION_GROUP_ID (the ONE shared derived alert sink, O1
    // convention) + LOOM_SECRET_EXPIRY_WARN_DAYS (152) → V1 (observability
    // fragment) adds LOOM_SYNTHETIC_MONITOR_ENABLED + LOOM_UAT_RESULTS_ACCOUNT
    // + LOOM_UAT_RESULTS_CONTAINER (svc-synthetic-monitor) and
    // SYNTHETIC_LOGIN_UPN + SYNTHETIC_LOGIN_SECRET (svc-synthetic-login,
    // secret-typed honest-skip; the shared LOOM_ALERT_ACTION_GROUP_ID is
    // already counted) (157) → I1 svc-workspace-identity adds
    // LOOM_WORKSPACE_IDENTITY_MODE (off | shadow | enforce) +
    // LOOM_WS_IDENTITY_RG (falls back to LOOM_DLZ_RG) (159) → E2
    // svc-copilot-evaluator adds LOOM_COPILOT_EVALUATOR_URL (160) → O1
    // svc-alerting adds LOOM_ALERT_WEBHOOK_URL (the optional on-call webhook
    // bridge for the unified dispatchAlert path; secret-typed, KV secretRef)
    // (161) → C2 svc-cost-forecast adds LOOM_COST_FORECAST_HORIZON_DAYS +
    // LOOM_COST_FORECAST_METHOD (both optionalDefault tuning knobs — the
    // forecast runs day-one unset: 30-day horizon, method 'auto' = real
    // Forecast API → computed linear/seasonal fallback) (163) → L2
    // svc-openlineage adds LOOM_OPENLINEAGE_AUTH_MODE (164; the per-pool
    // credential registrations are secretRef-typed, not editable env) → RUM1
    // svc-client-rum adds LOOM_RUM_ENABLED + LOOM_RUM_SAMPLE_RATE +
    // APPLICATIONINSIGHTS_CONNECTION_STRING (secret-typed, monitoring-module
    // derived) (167) → I3 svc-workspace-identity adds
    // LOOM_WS_IDENTITY_SHADOW_SAMPLE (shadow divergence-audit sampling 0..1,
    // code default 1.0) (168) → C3 svc-cost-anomaly-monitor adds
    // LOOM_COST_ANOMALY_ENABLED (optionalDefault opt-out flag — the scheduled
    // cost-anomaly monitor is default-ON) (169).
    // Bumped to 174 by A11/A12/A13 (Spark reliability): svc-spark-autorecover
    // (LOOM_SPARK_AUTORECOVER_ENABLED + LOOM_SPARK_RECOVER_MAX_ATTEMPTS) +
    // svc-spark-vcore-budget (LOOM_SPARK_VCORE_BUDGET + LOOM_SPARK_TENANT_SESSION_MAX)
    // + svc-spark-chaos-drill (LOOM_SPARK_CHAOS_ENABLED) — all five optionalDefault
    // (default-ON/opt-out reliability knobs; chaos is OFF-by-default-as-intended).
    // Bumped to 176 by N11/N12 (GraphRAG + self-healing NL2SQL): LOOM_GRAPHRAG_MAX_HOPS
    // (multi-hop traversal depth, code default 2, clamp [1,4]) +
    // LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS (bounded repair attempts, code default 2,
    // clamp [0,5]) — both optional tuning knobs with safe code defaults.
    expect(EDITABLE_ENV.length).toBe(176);
  });

  it('surfaces the wave-2 env vars as settable (previously dropped by the whitelist)', () => {
    for (const k of [
      'LOOM_SWA_SUBSCRIPTION_ID', 'LOOM_SWA_RESOURCE_GROUP', 'LOOM_SWA_LOCATION',
      'LOOM_ADX_ALERT_SCOPE', 'LOOM_PE_SUBNET_ID',
      'LOOM_PLAN_BACKING_SQL_SERVER', 'LOOM_PLAN_BACKING_SQL_DATABASE',
      'LOOM_DAB_PREVIEW_URL', 'LOOM_UDF_FUNCTION_BASE',
      'LOOM_ONELAKE_SECURITY_ACL', 'LOOM_MAPS_BACKEND', 'LOOM_AZURE_MAPS_CLIENT_ID',
    ]) {
      expect(isEditableEnvKey(k), k).toBe(true);
    }
    // The Maps shared key is secret-typed (never echoed); the client id is not.
    expect(getEditableEnv('LOOM_AZURE_MAPS_KEY')?.secret).toBe(true);
    expect(getEditableEnv('LOOM_AZURE_MAPS_CLIENT_ID')?.secret).toBe(false);
    // O1 — the on-call webhook URL embeds a bearer token → secret-typed.
    expect(getEditableEnv('LOOM_ALERT_WEBHOOK_URL')?.secret).toBe(true);
    // SWA sub/rg/location fall back to the deployment-wide vars (alias groups).
    expect(aliasSatisfiedKeys((k) => k === 'LOOM_SUBSCRIPTION_ID').has('LOOM_SWA_SUBSCRIPTION_ID')).toBe(true);
    expect(aliasSatisfiedKeys((k) => k === 'LOOM_LOCATION').has('LOOM_SWA_LOCATION')).toBe(true);
  });

  it('flags bicep-derived vars (org-visuals, LA workspace) with derived=true', () => {
    expect(getEditableEnv('LOOM_ORG_VISUALS_URL')?.derived).toBe(true);
    expect(getEditableEnv('LOOM_LOG_ANALYTICS_WORKSPACE_ID')?.derived).toBe(true);
    // A normal operator-set var is NOT derived.
    expect(getEditableEnv('LOOM_COSMOS_ENDPOINT')?.derived).toBeUndefined();
  });

  it('flags silent-fallback substrates optionalDefault=true (counted as configured day-one)', () => {
    // The out-of-band Hyperscale-band substrates + the Cosmos-native Plan writeback
    // fall back with zero loss of function when unset, so /admin/env-config counts
    // them as configured (status 'default') → 73-of-73 on a clean deploy without
    // faking a resource (the FEATURE is on via the built-in fallback).
    for (const k of ['LOOM_ONELAKE_URL', 'LOOM_DIRECTLAKE_URL', 'LOOM_BROKER_URL', 'LOOM_BROKER_REDIS',
      'LOOM_PLAN_BACKING_SQL_SERVER', 'LOOM_PLAN_BACKING_SQL_DATABASE']) {
      expect(getEditableEnv(k)?.optionalDefault, k).toBe(true);
    }
    // A normal operator/day-one var is NOT an optional-default fallback.
    expect(getEditableEnv('LOOM_COSMOS_ENDPOINT')?.optionalDefault).toBeUndefined();
    expect(getEditableEnv('LOOM_SYNAPSE_WORKSPACE')?.optionalDefault).toBeUndefined();
  });

  it('flags the AI-enrich endpoints + SIEM audit DCR optionalDefault=true (73/73 on the live deploy)', () => {
    // These 7 were the ONLY vars unset on a real (stale) live revision — the
    // "66 of 73" the operator saw. Each is genuinely fallback-functional:
    //   - the 5 AI-enrich endpoints fall back to the shared multi-service Azure
    //     AI Services (Foundry) account (cognitive-common.resolveCognitiveEndpoint),
    //   - the SIEM audit DCR silently no-ops while the built-in Cosmos audit trail
    //     keeps every event.
    // So each counts as configured (status 'default') → 73-of-73, honestly.
    for (const k of [
      'LOOM_DOCINTEL_ENDPOINT', 'LOOM_VISION_ENDPOINT', 'LOOM_LANGUAGE_ENDPOINT',
      'LOOM_TRANSLATOR_ENDPOINT', 'LOOM_CONTENT_SAFETY_ENDPOINT',
      'LOOM_AUDIT_DCR_ENDPOINT', 'LOOM_AUDIT_DCR_ID',
    ]) {
      expect(getEditableEnv(k)?.optionalDefault, k).toBe(true);
    }
    // Exactly the optionalDefault keys — pins the set so any future drift that
    // would drop /admin/env-config below full coverage fails CI. Wave-3 adds
    // the Event Grid webhook transport pair (svc-webhooks-eventgrid: direct
    // HMAC-signed HTTPS delivery is the fully-functional default) and
    // LOOM_RESULT_CACHE_REDIS (the query result cache falls back to the
    // per-replica in-memory cache with zero loss of function).
    const optDefault = EDITABLE_ENV.filter((e) => e.optionalDefault).map((e) => e.key).sort();
    expect(optDefault).toEqual([
      // RUM1 svc-client-rum — browser RUM is strictly-additive telemetry: with
      // the connection string unset, capture + ingest are a silent no-op with
      // zero loss of function (the spec's optionalDefault posture).
      'APPLICATIONINSIGHTS_CONNECTION_STRING',
      'LOOM_A2A_EGRESS_ALLOW',
      // O1 svc-alerting — the optional on-call webhook bridge; unset = the
      // unified dispatch path still delivers every severity via the shared
      // action group's email + Owner ARM-role receivers (fully functional).
      'LOOM_ALERT_WEBHOOK_URL',
      'LOOM_AOAI_MINI_DEPLOYMENT', 'LOOM_AOAI_STRONG_DEPLOYMENT',
      'LOOM_AUDIT_DCR_ENDPOINT', 'LOOM_AUDIT_DCR_ID',
      // WS-10.1 svc-lcu-autopilot — both optionalDefault (propose mode +
      // auto-derived LCU ceiling are the fully-functional defaults).
      'LOOM_AUTOPILOT_MODE',
      'LOOM_BROKER_REDIS', 'LOOM_BROKER_URL',
      'LOOM_CAPACITY_LCU',
      'LOOM_CONTENT_SAFETY_ENDPOINT',
      // C3 svc-cost-anomaly-monitor — the scheduled cost-anomaly monitor is
      // default-ON (opt-out): unset LOOM_COST_ANOMALY_ENABLED = enabled, the
      // bicep-provisioned ACA Job seeds a whole-estate 3σ watch and alerts via
      // the shared action group + in-product notifications with zero config.
      'LOOM_COST_ANOMALY_ENABLED',
      // C2 svc-cost-forecast — both fully-functional-by-default tuning knobs
      // (unset → 30-day horizon, method 'auto' = real Forecast API first with
      // the computed linear/seasonal fallback, honestly labeled).
      'LOOM_COST_FORECAST_HORIZON_DAYS', 'LOOM_COST_FORECAST_METHOD',
      'LOOM_DIRECTLAKE_URL', 'LOOM_DOCINTEL_ENDPOINT',
      'LOOM_EVENTGRID_TOPIC_ENDPOINT', 'LOOM_EVENTGRID_TOPIC_KEY',
      // N11 svc-graphrag — multi-hop traversal depth; unset = code default 2
      // (GraphRAG grounding still runs, just at the default hop budget).
      'LOOM_GRAPHRAG_MAX_HOPS',
      'LOOM_GRAPH_GROUP_SYNC_ENABLED',
      'LOOM_LANGUAGE_ENDPOINT', 'LOOM_MESH_PROFILE',
      // N12 — bounded NL2SQL repair attempts; unset = code default 2 (the
      // self-healing loop still repairs, just within the default budget).
      'LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS',
      'LOOM_ONELAKE_URL',
      // L2 svc-openlineage — unset credential = the OpenLineage feed is an
      // ADDITIVE source that is silently absent while UC / dbt / ADF column
      // lineage keep flowing (default-ON preserved; pool-setup wizard adds it).
      'LOOM_OPENLINEAGE_AUTH_MODE',
      'LOOM_PLAN_BACKING_SQL_DATABASE', 'LOOM_PLAN_BACKING_SQL_SERVER',
      'LOOM_RESULT_CACHE_REDIS',
      // RUM1 svc-client-rum — default-ON knobs (unset = enabled @ 100%).
      'LOOM_RUM_ENABLED', 'LOOM_RUM_SAMPLE_RATE',
      // A11/A12/A13 Spark reliability — all default-ON/opt-out (chaos default-OFF
      // is the intended production posture): auto-recovery enable + thrash cap,
      // the vCore-budget + session-cap ceiling, and the chaos-drill switch.
      'LOOM_SPARK_AUTORECOVER_ENABLED', 'LOOM_SPARK_CHAOS_ENABLED',
      'LOOM_SPARK_RECOVER_MAX_ATTEMPTS', 'LOOM_SPARK_TENANT_SESSION_MAX', 'LOOM_SPARK_VCORE_BUDGET',
      'LOOM_TRANSLATOR_ENDPOINT', 'LOOM_VISION_ENDPOINT',
      // I1 svc-workspace-identity — mode off (unset) is the fully-functional
      // intended default (shared Console UAMI, unchanged); the sole Phase-0
      // exception to default-ON (phased shadow → enforce, operator decision).
      // I3 adds the shadow-audit sampling alias (unset = code default 1.0).
      'LOOM_WORKSPACE_IDENTITY_MODE', 'LOOM_WS_IDENTITY_RG',
      'LOOM_WS_IDENTITY_SHADOW_SAMPLE', 'LOOM_WS_IDENTITY_SUB',
      // V1 svc-synthetic-login — absence is an HONEST SKIP of the J1 MSAL
      // login probe (minted-session journeys still monitor the app), so the
      // pair counts as configured day-one.
      'SYNTHETIC_LOGIN_SECRET', 'SYNTHETIC_LOGIN_UPN',
    ]);
  });
});
