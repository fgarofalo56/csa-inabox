/**
 * Phase 2 — lakehouse dataset/shortcut provisioner tests.
 *
 * Covers the no-vaporware fix: a bundle lakehouse shortcut that references a
 * dataset must ship that dataset REAL (repo-hosted) and the install must
 * actually UPLOAD it into the tenant's own ADLS + register a real, queryable
 * shortcut row. We assert:
 *
 *   1. repoDataset → the repo bytes are uploaded into the tenant ADLS, a
 *      Synapse OPENROWSET view is registered, and an 'active' shortcut row is
 *      created (self-contained, no external URL).
 *   2. repoDataset MISSING on disk → honest 'pending' gate (no silent success).
 *   3. internal:// target → 'active' shortcut row on the primary account.
 *   4. publicAnonymous target → real unauthenticated probe; 2xx ⇒ 'active',
 *      non-2xx ⇒ 'pending' (honest gate).
 *   5. bare external target (no honesty flag) → 'pending' (never silent 'active').
 *
 * Every ADLS / Synapse / registry call is mocked; no real Azure traffic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const COLD_TRANSFORM_TIMEOUT_MS = 120_000;

// ---- Mock the credential chain (provisioner constructs one at import). ----
vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() { return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return null; } },
}));

// ---- Mock the ADLS client (record uploads + dirs). ----
const adlsUploads: Array<{ container: string; path: string; size: number; contentType: string }> = [];
const adlsDirs: string[] = [];
vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
  listContainers: vi.fn(async () => [{ name: 'landing' }, { name: 'bronze' }]),
  createDirectory: vi.fn(async (container: string, path: string) => { adlsDirs.push(`${container}/${path}`); return { ok: true }; }),
  uploadFile: vi.fn(async (container: string, path: string, body: Buffer, contentType: string) => {
    adlsUploads.push({ container, path, size: body.length, contentType });
    return { ok: true, size: body.length };
  }),
  pathToHttpsUrl: (container: string, path: string) => `https://acct.dfs.core.windows.net/${container}/${path}`,
  resolveAbfssRoot: (container: string, rootPath: string) => `abfss://${container}@acct.dfs.core.windows.net/${rootPath}`,
}));

// ---- Mock Synapse serverless (record view DDL). ----
const synapseDdl: string[] = [];
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(async (_t: unknown, sql: string) => { synapseDdl.push(sql); return { rows: [] }; }),
  serverlessTarget: (db: string) => ({ server: 'syn-fix-ondemand', database: db }),
}));

// ---- Mock the shortcut registry (record created rows). ----
interface RegRow { lakehouseId: string; name: string; targetUri: string; status: string; engine?: string; engineObject?: string; statusDetail?: string; }
const registry: RegRow[] = [];
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({
  createShortcut: vi.fn(async (def: any) => {
    const row = { ...def, status: def.status ?? 'active' };
    registry.push(row);
    return row;
  }),
}));

// ---- Mock the repo-dataset reader (control found/missing per path). ----
vi.mock('@/lib/apps/repo-datasets', () => ({
  readRepoDataset: vi.fn((p: string) => {
    if (p.includes('missing')) return null;
    const fileName = p.split('/').pop() || 'data.csv';
    return {
      relPath: p,
      absPath: `/repo/${p}`,
      bytes: Buffer.from('a,b,c\n1,2,3\n4,5,6\n'),
      fileName,
      contentType: 'text/csv',
    };
  }),
}));

// fetch mock for the public-anonymous probe.
function stubFetch(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
}

const baseSession = {
  claims: { oid: 't-fix', name: 'Fix', upn: 'fix@example.com', email: 'fix@example.com', groups: [] },
  exp: Math.floor(Date.now() / 1000) + 3600,
} as any;

const baseTarget = { mode: 'shared' as const, lakehouseBackend: 'adls' as const, adlsContainer: 'landing' };

async function runLakehouse(content: any) {
  const { lakehouseProvisioner } = await import('@/lib/install/provisioners/lakehouse');
  return lakehouseProvisioner({
    session: baseSession,
    target: baseTarget,
    cosmosItemId: 'lh-item-1',
    workspaceId: 'ws-1',
    displayName: 'Test Lakehouse',
    content,
    appId: 'app-test',
  });
}

beforeEach(() => {
  adlsUploads.length = 0;
  adlsDirs.length = 0;
  synapseDdl.length = 0;
  registry.length = 0;
  process.env.LOOM_BRONZE_URL = 'https://acct.dfs.core.windows.net/bronze';
  process.env.LOOM_LANDING_URL = 'https://acct.dfs.core.windows.net/landing';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-fix';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
});

describe('lakehouse shortcut dataset provisioning (no-vaporware)', () => {
  it('uploads a repoDataset into the tenant ADLS + registers an active queryable shortcut', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    const res = await runLakehouse({
      kind: 'lakehouse',
      folders: [],
      deltaTables: [],
      shortcuts: [
        { name: 'retail-orders-public', repoDataset: 'samples/app-data/lakehouse-inspector/retail-orders-public.csv', format: 'csv', kind: 'files' },
      ],
    });

    expect(res.status).toBe('created');
    // The repo bytes were uploaded into the tenant ADLS under Files/_shortcuts/.
    const upload = adlsUploads.find((u) => u.path.includes('_shortcuts/retail-orders-public'));
    expect(upload).toBeTruthy();
    expect(upload!.contentType).toBe('text/csv');
    expect(upload!.size).toBeGreaterThan(0);
    // A Synapse OPENROWSET view was registered over the uploaded file.
    expect(synapseDdl.some((s) => /CREATE VIEW lakehouse\.shortcut_retail_orders_public/.test(s))).toBe(true);
    // The registry row is active + internal (self-contained, no external host).
    const row = registry.find((r) => r.name === 'retail-orders-public');
    expect(row).toBeTruthy();
    expect(row!.status).toBe('active');
    expect(row!.targetUri.startsWith('internal://')).toBe(true);
    expect(res.secondaryIds?.shortcutsActive).toContain('retail-orders-public');
  });

  it('honest-gates a repoDataset that is missing from the deployed image (pending, not silent success)', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    const res = await runLakehouse({
      kind: 'lakehouse', folders: [], deltaTables: [],
      shortcuts: [{ name: 'gone', repoDataset: 'samples/app-data/missing/nope.csv', kind: 'files' }],
    });
    expect(res.status).toBe('created'); // lakehouse itself is real
    const row = registry.find((r) => r.name === 'gone');
    expect(row!.status).toBe('pending');
    expect(row!.statusDetail).toMatch(/not found/i);
    expect(res.secondaryIds?.shortcutsPending).toContain('gone');
    // Nothing was uploaded for the missing dataset.
    expect(adlsUploads.some((u) => u.path.includes('gone'))).toBe(false);
  });

  it('registers an internal:// shortcut as active on the primary account', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    const res = await runLakehouse({
      kind: 'lakehouse', folders: [], deltaTables: [],
      shortcuts: [{ name: 'eventhub_capture', target: 'internal://landing/eventhub-capture', kind: 'files' }],
    });
    expect(res.status).toBe('created');
    const row = registry.find((r) => r.name === 'eventhub_capture');
    expect(row!.status).toBe('active');
    expect(row!.targetUri).toBe('internal://landing/eventhub-capture');
  });

  it('probes a publicAnonymous target — 2xx ⇒ active', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    stubFetch(200);
    const res = await runLakehouse({
      kind: 'lakehouse', folders: [], deltaTables: [],
      shortcuts: [{ name: 'cms-public', target: 'https://data.cms.gov/x', publicAnonymous: true, kind: 'files' }],
    });
    expect(res.status).toBe('created');
    const row = registry.find((r) => r.name === 'cms-public');
    expect(row!.status).toBe('active');
  });

  it('probes a publicAnonymous target — non-2xx ⇒ pending (honest gate)', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    stubFetch(404);
    const res = await runLakehouse({
      kind: 'lakehouse', folders: [], deltaTables: [],
      shortcuts: [{ name: 'dead-public', target: 'https://example.invalid/x', publicAnonymous: true, kind: 'files' }],
    });
    const row = registry.find((r) => r.name === 'dead-public');
    expect(row!.status).toBe('pending');
    expect(row!.statusDetail).toMatch(/404/);
  });

  it('registers a bare external target as pending — never silent active', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    const res = await runLakehouse({
      kind: 'lakehouse', folders: [], deltaTables: [],
      shortcuts: [{ name: 'unverified', target: 'abfss://x@unknown.dfs.core.windows.net/y', kind: 'files' }],
    });
    const row = registry.find((r) => r.name === 'unverified');
    expect(row!.status).toBe('pending');
    expect(row!.statusDetail).toMatch(/not validated|unverified/i);
  });
});
