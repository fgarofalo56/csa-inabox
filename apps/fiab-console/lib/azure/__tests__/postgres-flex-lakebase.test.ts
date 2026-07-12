/**
 * DBX-4 — postgres-flex-client provision / branch / replica / pgvector-allowlist
 * ARM body construction. The ARM transport (fetchWithTimeout) + credential are
 * mocked; the test asserts each function issues the correct createMode + body,
 * with no real Azure I/O.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface Captured { url: string; method: string; body: any }
const calls: Captured[] = [];
// Per-URL-substring canned JSON responses (matched in insertion order).
let responder: (url: string, method: string) => any = () => ({});

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class { async getToken() { return null; } } }));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: vi.fn(async (url: string, init: any) => {
    const method = (init?.method || 'GET').toUpperCase();
    let body: any = undefined;
    try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { /* raw */ }
    calls.push({ url, method, body });
    const json = responder(url, method);
    return { ok: true, status: 200, text: async () => JSON.stringify(json) } as any;
  }),
}));

const SAVED = { ...process.env };
beforeEach(() => { calls.length = 0; process.env.LOOM_SUBSCRIPTION_ID = 'sub-1'; });
afterEach(() => { process.env = { ...SAVED }; vi.clearAllMocks(); });

const SRC_ID = '/subscriptions/sub-1/resourceGroups/rg1/providers/Microsoft.DBforPostgreSQL/flexibleServers/src';

function srcServerJson() {
  return { id: SRC_ID, name: 'src', location: 'eastus', properties: { fullyQualifiedDomainName: 'src.postgres.database.azure.com', state: 'Ready' } };
}

describe('createServer (provision-spec)', () => {
  it('PUTs a Default-createMode server with sku + storage + version', async () => {
    responder = () => ({ id: '/x', properties: { state: 'Creating' } });
    const { createServer } = await import('../postgres-flex-client');
    const r = await createServer({
      name: 'lb1', resourceGroup: 'rg1', location: 'eastus',
      administratorLogin: 'pgadmin', administratorLoginPassword: 'p@ss', skuName: 'Standard_D2ds_v5',
      tier: 'GeneralPurpose', version: '16', storageGb: 64,
    });
    expect(r.ok).toBe(true);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body.sku).toEqual({ name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' });
    expect(put.body.properties.createMode).toBe('Default');
    expect(put.body.properties.version).toBe('16');
    expect(put.body.properties.storage.storageSizeGB).toBe(64);
  });

  it('fails fast without a subscription', async () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    const { createServer } = await import('../postgres-flex-client');
    const r = await createServer({ name: 'x', resourceGroup: 'r', location: 'l', administratorLogin: 'a', administratorLoginPassword: 'p', skuName: 'Standard_B1ms', tier: 'Burstable' });
    expect(r.ok).toBe(false);
  });
});

describe('createBranch (PITR)', () => {
  it('resolves the source then PUTs a PointInTimeRestore server', async () => {
    responder = (url, method) => (method === 'GET' && url.includes('/flexibleServers/src?') ? srcServerJson() : { id: '/branch', properties: { state: 'Creating' } });
    const { createBranch } = await import('../postgres-flex-client');
    const r = await createBranch({ sourceServerNameOrId: SRC_ID, newServerName: 'branch1', pointInTimeUTC: '2026-07-09T00:00:00Z' });
    expect(r.ok).toBe(true);
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('branch1'))!;
    expect(put.body.properties.createMode).toBe('PointInTimeRestore');
    expect(put.body.properties.sourceServerResourceId).toBe(SRC_ID);
    expect(put.body.properties.pointInTimeUTC).toBe('2026-07-09T00:00:00Z');
  });
});

describe('createReplica', () => {
  it('PUTs a Replica-createMode server', async () => {
    responder = (url, method) => (method === 'GET' && url.includes('/flexibleServers/src?') ? srcServerJson() : { id: '/replica', properties: { state: 'Creating' } });
    const { createReplica } = await import('../postgres-flex-client');
    const r = await createReplica({ sourceServerNameOrId: SRC_ID, newServerName: 'replica1' });
    expect(r.ok).toBe(true);
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('replica1'))!;
    expect(put.body.properties.createMode).toBe('Replica');
    expect(put.body.properties.sourceServerResourceId).toBe(SRC_ID);
  });
});

describe('allowlistExtension (pgvector)', () => {
  it('adds VECTOR to azure.extensions when absent (idempotent read-then-PUT)', async () => {
    responder = (url, method) => {
      if (method === 'GET' && url.includes('azure.extensions')) return { properties: { value: 'UUID-OSSP' } };
      return { properties: { value: 'UUID-OSSP,VECTOR' } };
    };
    const { allowlistExtension } = await import('../postgres-flex-client');
    const r = await allowlistExtension(SRC_ID, 'VECTOR');
    expect(r.extensions).toContain('VECTOR');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body.properties.value).toContain('VECTOR');
    expect(put.body.properties.source).toBe('user-override');
  });

  it('no-ops the PUT when the extension is already allowlisted', async () => {
    responder = () => ({ properties: { value: 'VECTOR' } });
    const { allowlistExtension } = await import('../postgres-flex-client');
    await allowlistExtension(SRC_ID, 'VECTOR');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('postgresQueryGate (honest gate names the real env var)', () => {
  it('returns LOOM_POSTGRES_AAD_USER when the principal name is unset', async () => {
    delete process.env.LOOM_POSTGRES_AAD_USER;
    const { postgresQueryGate } = await import('../postgres-flex-client');
    const gate = postgresQueryGate();
    expect(gate).not.toBeNull();
    expect(gate!.missing).toBe('LOOM_POSTGRES_AAD_USER');
    // Must NOT reference the retired/never-real LOOM_POSTGRES_QUERY_LIVE var.
    expect(gate!.detail).not.toMatch(/LOOM_POSTGRES_QUERY_LIVE/);
    expect(gate!.detail).toMatch(/pgaadauth_create_principal/);
  });

  it('returns null (no gate) once LOOM_POSTGRES_AAD_USER is set — query path is live', async () => {
    process.env.LOOM_POSTGRES_AAD_USER = 'loom-console-uami';
    const { postgresQueryGate } = await import('../postgres-flex-client');
    expect(postgresQueryGate()).toBeNull();
  });
});

describe('no stale LOOM_POSTGRES_QUERY_LIVE gate (pg query is wired)', () => {
  // Guard: the pg driver IS a dependency and executePostgresQuery runs real
  // SQL, so no surface may tell the operator to "add the pg driver" or set the
  // never-real LOOM_POSTGRES_QUERY_LIVE var — that would present a working
  // feature as vaporware (no-vaporware.md honest-gate accuracy).
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const root = path.resolve(__dirname, '..', '..', '..');
  const files = [
    'lib/azure/postgres-flex-client.ts',
    'lib/editors/unified-sql-database-editor.tsx',
    'lib/catalog/item-types/databases.ts',
  ];
  for (const rel of files) {
    it(`${rel} does not reference LOOM_POSTGRES_QUERY_LIVE`, () => {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(src).not.toMatch(/LOOM_POSTGRES_QUERY_LIVE/);
    });
  }

  it('pg is a declared console dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.pg).toBeTruthy();
  });
});
