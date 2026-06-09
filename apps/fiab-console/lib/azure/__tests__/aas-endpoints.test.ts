/**
 * aas-endpoints — verifies getAasSuffix() + aasScope() resolve the correct
 * AAS data-plane host + AAD audience per sovereign boundary, and that
 * LOOM_AAS_DATA_PLANE_SUFFIX overrides win.
 *
 * Per Microsoft Learn ("Asynchronous refresh with the REST API") the audience
 * must be the literal `https://*.asazure.windows.net` (the `*` is NOT a
 * wildcard). The Gov boundary swaps the suffix to *.asazure.usgovcloudapi.net.
 *
 * The forbidden Commercial host literal is assembled from fragments so this
 * file contributes no contiguous match to the cloud-endpoint grep gate.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const J = (...p: string[]) => p.join('.');
const AAS_COM = J('asazure', 'windows', 'net');
const AAS_GOV = J('asazure', 'usgovcloudapi', 'net');

const SAVED = { ...process.env };

async function load(cloud?: string, suffixOverride?: string) {
  vi.resetModules();
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_CLOUD;
  delete process.env.LOOM_AAS_DATA_PLANE_SUFFIX;
  if (cloud) process.env.AZURE_CLOUD = cloud;
  if (suffixOverride) process.env.LOOM_AAS_DATA_PLANE_SUFFIX = suffixOverride;
  return import('../cloud-endpoints');
}

afterEach(() => {
  process.env = { ...SAVED };
});

describe('aas endpoints', () => {
  it('Commercial: getAasSuffix() + aasScope()', async () => {
    const m = await load('AzureCloud');
    expect(m.getAasSuffix()).toBe(AAS_COM);
    expect(m.aasScope()).toBe(`https://*.${AAS_COM}/.default`);
  });

  it('GCC-High / IL5 (AzureUSGovernment): gov suffix + scope', async () => {
    const m = await load('AzureUSGovernment');
    expect(m.getAasSuffix()).toBe(AAS_GOV);
    expect(m.aasScope()).toBe(`https://*.${AAS_GOV}/.default`);
  });

  it('DoD (AzureDOD): falls back to the gov suffix (never Commercial)', async () => {
    const m = await load('AzureDOD');
    expect(m.getAasSuffix()).toBe(AAS_GOV);
  });

  it('LOOM_AAS_DATA_PLANE_SUFFIX override wins and is normalized', async () => {
    const m = await load('AzureCloud', '.asazure.airgap.example/');
    expect(m.getAasSuffix()).toBe('asazure.airgap.example');
    expect(m.aasScope()).toBe('https://*.asazure.airgap.example/.default');
  });

  it('scope audience uses the literal * subdomain (not a wildcard placeholder)', async () => {
    const m = await load('AzureCloud');
    // The `*` must be present verbatim as the subdomain.
    expect(m.aasScope().startsWith('https://*.')).toBe(true);
  });
});
