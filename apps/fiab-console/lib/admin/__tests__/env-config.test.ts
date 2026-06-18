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

  it('exposes exactly the 45 editable runtime variables (catalog completeness)', () => {
    // The env-config catalog is the union of every required + anyOf key across
    // ENV_CHECKS. The /admin/env-config coverage badge reads N-of-45; this pins
    // the catalog size so a drift in ENV_CHECKS is caught in CI. Bumped to 45 by
    // the day-one self-audit expansion (MCP deploy/built-in, Warp SQL engine,
    // Databricks, Purview UC endpoint, DLP enable, ACA env coords).
    expect(EDITABLE_ENV.length).toBe(45);
  });

  it('flags bicep-derived vars (org-visuals, LA workspace) with derived=true', () => {
    expect(getEditableEnv('LOOM_ORG_VISUALS_URL')?.derived).toBe(true);
    expect(getEditableEnv('LOOM_LOG_ANALYTICS_WORKSPACE_ID')?.derived).toBe(true);
    // A normal operator-set var is NOT derived.
    expect(getEditableEnv('LOOM_COSMOS_ENDPOINT')?.derived).toBeUndefined();
  });
});
