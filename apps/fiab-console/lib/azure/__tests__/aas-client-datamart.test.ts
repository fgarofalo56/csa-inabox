/**
 * Datamart migration assistant — AAS client pure helpers + cloud matrix.
 *
 * Guards the two pieces of the datamart→Synapse+AAS migration that are pure
 * (no network): the AAS server-name sanitizer (ARM naming rules) and the
 * sovereign AAS data-plane suffix. If a helper drifts (e.g. a Commercial-only
 * literal sneaks into aasSuffix, or the sanitizer emits an invalid name) these
 * fail. Mirrors ai-functions-suffix.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { sanitizeAasName, skuTier, sanitizeDbName } from '../aas-naming';

const SAVED = { ...process.env };

async function loadEndpoints(cloud?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_CLOUD;
  delete process.env.LOOM_ARM_ENDPOINT;
  delete process.env.LOOM_AAS_HOST_SUFFIX;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  return import('../cloud-endpoints');
}

afterEach(() => {
  process.env = { ...SAVED };
});

describe('sanitizeAasName — ARM server-name rules', () => {
  it('lowercases, strips non-alphanumerics, prefixes loom', () => {
    expect(sanitizeAasName('Sales Datamart')).toBe('loomsalesdatamart');
  });

  it('strips leading non-letters from the raw name (loom prefix keeps it valid)', () => {
    expect(sanitizeAasName('123-mart')).toBe('loommart');
  });

  it('caps the result at 63 chars', () => {
    const out = sanitizeAasName('a'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out.startsWith('loom')).toBe(true);
  });

  it('always starts with a letter and is >= 3 chars', () => {
    const out = sanitizeAasName('X');
    expect(/^[a-z][a-z0-9]*$/.test(out)).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

describe('skuTier — ARM tier from SKU prefix', () => {
  it('D* → Development', () => expect(skuTier('D1')).toBe('Development'));
  it('B* → Basic', () => expect(skuTier('B1')).toBe('Basic'));
  it('S* → Standard', () => expect(skuTier('S1')).toBe('Standard'));
});

describe('aasSuffix / aasConnectionUri — cloud matrix', () => {
  it('Commercial → asazure.windows.net', async () => {
    const m = await loadEndpoints('AzureCloud');
    expect(m.aasSuffix()).toBe('asazure.windows.net');
    expect(m.aasConnectionUri('loomsales', 'eastus2')).toBe(
      'asazure://eastus2.asazure.windows.net/loomsales',
    );
  });

  it('GCC-High (AzureUSGovernment) → asazure.usgovcloudapi.net', async () => {
    const m = await loadEndpoints('AzureUSGovernment');
    expect(m.aasSuffix()).toBe('asazure.usgovcloudapi.net');
    expect(m.aasConnectionUri('loomsales', 'usgovvirginia')).toBe(
      'asazure://usgovvirginia.asazure.usgovcloudapi.net/loomsales',
    );
  });

  it('DoD (AzureDOD) → asazure.usgovcloudapi.net (Gov AAS data-plane)', async () => {
    const m = await loadEndpoints('AzureDOD');
    expect(m.aasSuffix()).toBe('asazure.usgovcloudapi.net');
  });

  it('LOOM_AAS_HOST_SUFFIX overrides outright', async () => {
    const m = await loadEndpoints('AzureCloud');
    process.env.LOOM_AAS_HOST_SUFFIX = 'asazure.custom.example';
    expect(m.aasSuffix()).toBe('asazure.custom.example');
  });
});
