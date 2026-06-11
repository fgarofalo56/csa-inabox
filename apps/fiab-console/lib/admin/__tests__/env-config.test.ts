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
});
