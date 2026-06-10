/**
 * Cloud-matrix + gate tests for the Power Query (M) ingest path's AAS client
 * and the Synapse dev-plane sovereign-cloud fix.
 *
 * aasConfigGate() must:
 *   - fire AAS_NOT_IN_GOV in GCC-High / DoD BEFORE any env/network call
 *     (Azure Analysis Services has no Government offering), and
 *   - in Commercial, gate precisely on LOOM_AAS_SERVER then LOOM_AAS_MODEL,
 *     returning null only when both are set.
 *
 * synapse-artifacts-client.devBase() must resolve the Government dev-plane host
 * (dev.azuresynapse.usgovcloudapi.net) in GCC-High / DoD — the bug this task
 * fixes — and the Commercial host otherwise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub the credential chain so importing the clients never reaches Azure.
vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() {
      return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { aasConfigGate } from '../aas-client';
import { devBase } from '../synapse-artifacts-client';

const SAVED = {
  LOOM_CLOUD: process.env.LOOM_CLOUD,
  AZURE_CLOUD: process.env.AZURE_CLOUD,
  LOOM_AAS_SERVER: process.env.LOOM_AAS_SERVER,
  LOOM_AAS_MODEL: process.env.LOOM_AAS_MODEL,
  LOOM_SYNAPSE_WORKSPACE: process.env.LOOM_SYNAPSE_WORKSPACE,
};

function clear() {
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_AAS_SERVER;
  delete process.env.LOOM_AAS_MODEL;
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
}

beforeEach(() => { clear(); });
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v as string;
  }
  vi.restoreAllMocks();
});

describe('aasConfigGate — government clouds have no AAS', () => {
  it('GCC-High (LOOM_CLOUD=GCC-High) → AAS_NOT_IN_GOV even with server+model set', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_AAS_SERVER = 'asazure://usgovvirginia.asazure.windows.net/aasloomdefault';
    process.env.LOOM_AAS_MODEL = 'IngestModel';
    const gate = aasConfigGate();
    expect(gate?.missing).toBe('AAS_NOT_IN_GOV');
    expect(gate?.reason).toMatch(/Government|OPENROWSET/i);
  });

  it('IL5 alias (LOOM_CLOUD=il5) → AAS_NOT_IN_GOV', () => {
    process.env.LOOM_CLOUD = 'il5';
    expect(aasConfigGate()?.missing).toBe('AAS_NOT_IN_GOV');
  });

  it('DoD (AZURE_CLOUD=AzureDOD) → AAS_NOT_IN_GOV', () => {
    process.env.AZURE_CLOUD = 'AzureDOD';
    expect(aasConfigGate()?.missing).toBe('AAS_NOT_IN_GOV');
  });
});

describe('aasConfigGate — commercial env precision', () => {
  it('missing LOOM_AAS_SERVER → gate on LOOM_AAS_SERVER', () => {
    process.env.LOOM_CLOUD = 'Commercial';
    expect(aasConfigGate()?.missing).toBe('LOOM_AAS_SERVER');
  });

  it('server set, model missing → gate on LOOM_AAS_MODEL', () => {
    process.env.LOOM_CLOUD = 'Commercial';
    process.env.LOOM_AAS_SERVER = 'asazure://westus.asazure.windows.net/aasloomdefault';
    expect(aasConfigGate()?.missing).toBe('LOOM_AAS_MODEL');
  });

  it('server + model set → null (AAS usable)', () => {
    process.env.LOOM_CLOUD = 'Commercial';
    process.env.LOOM_AAS_SERVER = 'asazure://westus.asazure.windows.net/aasloomdefault';
    process.env.LOOM_AAS_MODEL = 'IngestModel';
    expect(aasConfigGate()).toBeNull();
  });
});

describe('synapse-artifacts devBase — sovereign dev-plane host', () => {
  it('Commercial → dev.azuresynapse.net', () => {
    process.env.LOOM_CLOUD = 'Commercial';
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom-default';
    expect(devBase()).toBe('https://syn-loom-default.dev.azuresynapse.net');
  });

  it('GCC-High → dev.azuresynapse.usgovcloudapi.net (the fix)', () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom-default';
    expect(devBase()).toBe('https://syn-loom-default.dev.azuresynapse.usgovcloudapi.net');
  });

  it('DoD → dev.azuresynapse.usgovcloudapi.net', () => {
    process.env.AZURE_CLOUD = 'AzureDOD';
    process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom-default';
    expect(devBase()).toBe('https://syn-loom-default.dev.azuresynapse.usgovcloudapi.net');
  });
});
