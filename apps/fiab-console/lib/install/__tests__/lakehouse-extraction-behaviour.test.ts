/**
 * LAKEHOUSE PROVISIONER — the two BEHAVIOUR CHANGES the #3549 extraction made
 * (review should-fix 4).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * #3549 lifted the folder/table materialisation out of `lakehouse.ts` into the
 * shared `_seed-lakehouse-adls`, and the change was described as preserving the
 * installer's behaviour exactly. For the KQL applier that is true. For the
 * lakehouse it is NOT — the lift changed two observable behaviours, and neither
 * had a test:
 *
 *   1. AUTH SHORT-CIRCUIT. The old code logged a per-folder / per-table failure
 *      into `steps` and CONTINUED, so a 401/403 produced a half-built lakehouse
 *      that still reported `status:'created'`. The shared helper now returns an
 *      `authGate` and the provisioner returns `status:'remediation'` — which
 *      also SKIPS shortcut provisioning and the summary.
 *
 *   2. ORDERING. The folder-create loop used to run BEFORE the Synapse
 *      serverless user-DB setup. It now runs AFTER it, because the per-table
 *      view hook needs the resolved Synapse target.
 *
 * Both are improvements — failing fast with the precise grant beats a lakehouse
 * that reports success while most of its tree is missing (`no-vaporware.md`:
 * "never report success on an unverified outcome"). But an untested behaviour
 * change asserted as unchanged is exactly what this repo's review bar rejects,
 * so they are pinned here rather than claimed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const COLD_TRANSFORM_TIMEOUT_MS = 120_000;

vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() { return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { async getToken() { return null; } },
}));

/**
 * One ORDERED log across both planes. Two separate arrays cannot answer "did
 * the folder create happen before or after the Synapse DB setup?", which is
 * the whole point of behaviour-change 2.
 */
const events: string[] = [];
/** Paths whose ADLS write should be refused, and with what status. */
const adlsDeny = { pattern: null as RegExp | null, status: 403 };

vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing', 'csv-imports'],
  listContainers: vi.fn(async () => [{ name: 'landing' }, { name: 'bronze' }]),
  createDirectory: vi.fn(async (container: string, path: string) => {
    if (adlsDeny.pattern?.test(path)) {
      throw Object.assign(new Error('This request is not authorized to perform this operation.'), { statusCode: adlsDeny.status });
    }
    events.push(`adls:mkdir:${path}`);
    return { ok: true };
  }),
  uploadFile: vi.fn(async (container: string, path: string, body: Buffer) => {
    if (adlsDeny.pattern?.test(path)) {
      throw Object.assign(new Error('This request is not authorized to perform this operation.'), { statusCode: adlsDeny.status });
    }
    events.push(`adls:put:${path}`);
    return { ok: true, size: body.length };
  }),
  pathToHttpsUrl: (container: string, path: string) => `https://acct.dfs.core.windows.net/${container}/${path}`,
  resolveAbfssRoot: (container: string, rootPath: string) => `abfss://${container}@acct.dfs.core.windows.net/${rootPath}`,
}));

vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(async (t: any, sql: string) => {
    events.push(`synapse:${t?.database}:${sql.slice(0, 40).replace(/\s+/g, ' ')}`);
    return { rows: [] };
  }),
  serverlessTarget: (db: string) => ({ server: 'syn-fix-ondemand', database: db }),
}));

const registry: any[] = [];
vi.mock('@/lib/azure/lakehouse-shortcuts', () => ({
  createShortcut: vi.fn(async (def: any) => {
    const row = { ...def, status: def.status ?? 'active' };
    registry.push(row);
    events.push(`shortcut:${def.name}`);
    return row;
  }),
}));

vi.mock('@/lib/apps/repo-datasets', () => ({
  readRepoDataset: vi.fn((p: string) => ({
    relPath: p, absPath: `/repo/${p}`,
    bytes: Buffer.from('a,b,c\n1,2,3\n'), fileName: p.split('/').pop() || 'data.csv',
    contentType: 'text/csv',
  })),
}));

const baseSession = {
  claims: { oid: 't-fix', name: 'Fix', upn: 'fix@example.com', email: 'fix@example.com', groups: [] },
  exp: Math.floor(Date.now() / 1000) + 3600,
} as any;

const CONTENT = {
  kind: 'lakehouse',
  folders: [{ path: 'Files/raw' }, { path: 'Files/curated' }],
  deltaTables: [
    { name: 'orders', ddl: 'CREATE TABLE orders ( order_id BIGINT, amount DECIMAL(18,2) )', sampleRows: [[1, '10.50']] },
  ],
  shortcuts: [
    { name: 'retail-orders', repoDataset: 'samples/app-data/x/retail.csv', format: 'csv', kind: 'files' },
  ],
};

async function runLakehouse(content: any = CONTENT) {
  const { lakehouseProvisioner } = await import('@/lib/install/provisioners/lakehouse');
  return lakehouseProvisioner({
    session: baseSession,
    target: { mode: 'shared' as const, lakehouseBackend: 'adls' as const, adlsContainer: 'landing' },
    cosmosItemId: 'lh-item-1',
    workspaceId: 'ws-1',
    displayName: 'Test Lakehouse',
    content,
    appId: 'app-test',
  });
}

beforeEach(() => {
  events.length = 0;
  registry.length = 0;
  adlsDeny.pattern = null;
  adlsDeny.status = 403;
  process.env.LOOM_BRONZE_URL = 'https://acct.dfs.core.windows.net/bronze';
  process.env.LOOM_LANDING_URL = 'https://acct.dfs.core.windows.net/landing';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-fix';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
});

describe('lakehouse extraction — behaviour change 1: a mid-build 401/403 short-circuits', () => {
  it('returns remediation naming the exact grant, instead of a half-built "created"', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    // The root create succeeds; the FIRST folder underneath is refused.
    adlsDeny.pattern = /Files\/raw/;

    const res = await runLakehouse();

    expect(res.status).toBe('remediation');
    expect(res.gate?.reason).toMatch(/403/);
    expect(res.gate?.remediation).toMatch(/Storage Blob Data Contributor/);
  });

  it('SKIPS shortcut provisioning — the documented consequence of the short-circuit', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    adlsDeny.pattern = /Files\/raw/;

    await runLakehouse();

    // This is the behaviour change: pre-extraction the loop continued and
    // shortcuts were still registered. Asserted so it is a DECISION on record
    // rather than an accident nobody noticed.
    expect(registry).toEqual([]);
    expect(events.some((e) => e.startsWith('shortcut:'))).toBe(false);
  });

  it('CONTROL — a NON-auth folder failure still continues and reports created', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    // 409/500-class failures must NOT short-circuit: the old per-folder
    // continue is still the right answer for anything a grant would not fix.
    adlsDeny.pattern = /Files\/raw/;
    adlsDeny.status = 409;

    const res = await runLakehouse();

    expect(res.status).toBe('created');
    // …and the rest of the tree was still built.
    expect(events.some((e) => e.endsWith('/Files/curated'))).toBe(true);
    expect(registry.length).toBeGreaterThan(0);
  });
});

describe('lakehouse extraction — behaviour change 2: folders now run AFTER the Synapse DB setup', () => {
  it('creates the Synapse serverless user DB BEFORE materialising the folder tree', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    const res = await runLakehouse();
    expect(res.status).toBe('created');

    const dbSetup = events.findIndex((e) => e.startsWith('synapse:master:'));
    const firstFolder = events.findIndex((e) => e.startsWith('adls:mkdir:') && e.endsWith('/Files/raw'));

    expect(dbSetup, 'the serverless user-DB setup never ran').toBeGreaterThanOrEqual(0);
    expect(firstFolder, 'the folder tree was never created').toBeGreaterThanOrEqual(0);
    // The reorder, pinned. Pre-extraction this was the other way round.
    expect(dbSetup).toBeLessThan(firstFolder);
  });

  it('still registers the OPENROWSET view over a seeded table — the reorder kept the view layer', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    await runLakehouse();

    // The seed CSV landed …
    expect(events.some((e) => e.includes('adls:put:') && e.includes('orders.csv'))).toBe(true);
    // … and the view was registered in the USER db, not master.
    expect(events.some((e) => e.startsWith('synapse:loom_lakehouse:'))).toBe(true);
  });

  it('CONTROL — with no Synapse workspace the tree is still built and status is created', { timeout: COLD_TRANSFORM_TIMEOUT_MS }, async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;

    const res = await runLakehouse();

    expect(res.status).toBe('created');
    expect(events.some((e) => e.startsWith('adls:mkdir:') && e.endsWith('/Files/raw'))).toBe(true);
    // The view layer is optional — its absence must not gate the lakehouse.
    expect(events.some((e) => e.startsWith('synapse:'))).toBe(false);
  });
});
