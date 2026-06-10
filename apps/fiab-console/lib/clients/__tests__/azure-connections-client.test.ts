/**
 * azure-connections-client (F16) — unit coverage for the deterministic,
 * network-free logic: the built-in role GUIDs and the Console-UAMI principal
 * resolution (env override + MI-token `oid` decode).
 *
 * The ARM/Cosmos/data-plane paths are integration-tested against live Azure
 * per no-vaporware.md; here we lock the role constants the honest-gate depends
 * on and the JWT decode that powers the role check.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SAVED = { ...process.env };

/** base64url-encode a JSON payload into a 3-segment fake JWT. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

// Mock @azure/identity so the module-level credential returns a crafted MI
// token whose `oid` claim is the UAMI principal id. One mock covers every
// transitive import (cosmos-client / adls-client / storage-discovery).
vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() {
      return { token: fakeJwt({ oid: 'uami-oid-from-token' }), expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return {
    ChainedTokenCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ManagedIdentityCredential: FakeCred,
  };
});

// Stub the heavy local deps the client imports but these unit cases never
// exercise (they pull in @azure/storage-file-datalake / @azure/cosmos, whose
// deep ESM graph is environment-specific). resolveUamiPrincipalId + the role
// constants under test don't touch them.
vi.mock('@/lib/azure/adls-client', () => ({ getServiceClientFor: () => ({}) }));
vi.mock('@/lib/azure/storage-discovery', () => ({ listStorageAccounts: async () => [] }));
vi.mock('@/lib/azure/cosmos-client', () => ({ azureConnectionsContainer: async () => ({}) }));

async function load() {
  vi.resetModules();
  return import('../azure-connections-client');
}

beforeEach(() => {
  delete process.env.LOOM_UAMI_PRINCIPAL_ID;
  delete process.env.LOOM_UAMI_CLIENT_ID;
  delete process.env.AZURE_CLIENT_ID;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe('azure-connections-client — role constants', () => {
  it('exports the correct built-in role GUIDs', async () => {
    const m = await load();
    expect(m.STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID).toBe('ba92f5b4-2d11-453d-a403-e96b0029c9fe');
    expect(m.LOG_ANALYTICS_CONTRIBUTOR_ROLE_ID).toBe('92aaf0da-9dab-42b6-94a3-d43ce8d16293');
  });
});

describe('azure-connections-client — resolveUamiPrincipalId', () => {
  it('prefers the explicit LOOM_UAMI_PRINCIPAL_ID env override', async () => {
    process.env.LOOM_UAMI_PRINCIPAL_ID = 'explicit-principal-id';
    const m = await load();
    await expect(m.resolveUamiPrincipalId()).resolves.toBe('explicit-principal-id');
  });

  it('falls back to decoding the oid claim from the MI ARM token', async () => {
    const m = await load();
    await expect(m.resolveUamiPrincipalId()).resolves.toBe('uami-oid-from-token');
  });
});
