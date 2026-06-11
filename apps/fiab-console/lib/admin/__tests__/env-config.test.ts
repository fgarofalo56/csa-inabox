import { describe, it, expect } from 'vitest';
import {
  EDITABLE_ENV,
  isEditableEnvKey,
  getEditableEnv,
  maskValue,
  buildSyncArtifacts,
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
    // entra-app anyOf includes AZURE_CLIENT_ID — the alias key must be settable.
    expect(isEditableEnvKey('LOOM_ENTRA_CLIENT_ID')).toBe(true);
    expect(isEditableEnvKey('AZURE_CLIENT_ID')).toBe(true);
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

  it('flags bicep-derived vars (org-visuals, LA workspace) with derived=true', () => {
    expect(getEditableEnv('LOOM_ORG_VISUALS_URL')?.derived).toBe(true);
    expect(getEditableEnv('LOOM_LOG_ANALYTICS_WORKSPACE_ID')?.derived).toBe(true);
    // A normal operator-set var is NOT derived.
    expect(getEditableEnv('LOOM_COSMOS_ENDPOINT')?.derived).toBeUndefined();
  });
});
