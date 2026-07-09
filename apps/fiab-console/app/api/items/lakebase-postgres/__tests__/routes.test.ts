/**
 * DBX-4 — lakebase-postgres BFF route gates. Auth, item-access, the Azure
 * client, and Cosmos are mocked (no I/O). Asserts the honest query gate, the
 * not-bound 409, the bad-SKU 400, the branch happy path, and the read-only 403.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const session = { claims: { oid: 'oid-1', tid: 'tid-1', groups: [] }, exp: Date.now() / 1000 + 3600 };
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(() => session) }));

const item: any = { id: 'lb-1', workspaceId: 'ws-1', itemType: 'lakebase-postgres', displayName: 'LB', state: { lakebase: { server: { name: 'src', id: '/subscriptions/s/rg/src', fqdn: 'src.postgres.database.azure.com' }, database: 'lakebase' } } };
const access = { item, role: 'Owner', via: 'owner', canWrite: true };
const mockAccess = vi.fn(async (..._a: any[]) => access as any);
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: (...a: any[]) => mockAccess(...a) }));

// Cosmos — the real store writes through itemsContainer().item().replace().
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({ item: () => ({ replace: vi.fn(async (n: any) => ({ resource: n })) }) })),
}));

// Azure client — real catalogs/findSku/PostgresError; network fns are spies.
const gateFn = vi.fn((..._a: any[]) => null as any);
const execQuery = vi.fn(async (..._a: any[]) => ({} as any));
const createBranchFn = vi.fn(async (..._a: any[]) => ({} as any));
const createReplicaFn = vi.fn(async (..._a: any[]) => ({} as any));
vi.mock('@/lib/azure/postgres-flex-client', async (orig) => {
  const actual: any = await (orig as any)();
  return {
    ...actual,
    postgresQueryGate: (...a: any[]) => gateFn(...a),
    executePostgresQuery: (...a: any[]) => execQuery(...a),
    createBranch: (...a: any[]) => createBranchFn(...a),
    createReplica: (...a: any[]) => createReplicaFn(...a),
    listDatabases: vi.fn(async () => []),
    getServer: vi.fn(async () => ({ name: 'src', id: '/subscriptions/s/rg/src', fqdn: 'src.postgres.database.azure.com', location: 'eastus' })),
    listServers: vi.fn(async () => []),
  };
});

function post(url: string, body: unknown) {
  return new NextRequest(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}
const params = (id = 'lb-1') => ({ params: Promise.resolve({ id }) });

beforeEach(() => { access.canWrite = true; item.state.lakebase.server = { name: 'src', id: '/subscriptions/s/rg/src', fqdn: 'src.postgres.database.azure.com' }; gateFn.mockReturnValue(null); vi.clearAllMocks(); gateFn.mockReturnValue(null); });

describe('query route', () => {
  it('503s an honest gate when the Entra query principal is unset', async () => {
    gateFn.mockReturnValue({ missing: 'LOOM_POSTGRES_AAD_USER', detail: 'set it' });
    const { POST } = await import('../[id]/query/route');
    const res = await POST(post('http://x/api/items/lakebase-postgres/lb-1/query', { sql: 'select 1' }), params());
    expect(res.status).toBe(503);
    const j = await res.json(); expect(j.code).toBe('not_configured'); expect(j.missing).toBe('LOOM_POSTGRES_AAD_USER');
    expect(execQuery).not.toHaveBeenCalled();
  });

  it('409s when no server is bound', async () => {
    item.state.lakebase.server = undefined;
    const { POST } = await import('../[id]/query/route');
    const res = await POST(post('http://x/q', { sql: 'select 1' }), params());
    expect(res.status).toBe(409);
    const j = await res.json(); expect(j.code).toBe('not_bound');
  });

  it('runs real SQL on the happy path', async () => {
    execQuery.mockResolvedValue({ columns: ['v'], rows: [['16']], rowCount: 1, executionMs: 3 });
    const { POST } = await import('../[id]/query/route');
    const res = await POST(post('http://x/q', { sql: 'select version()' }), params());
    expect(res.status).toBe(200);
    const j = await res.json(); expect(j.ok).toBe(true); expect(j.result.rowCount).toBe(1);
    expect(execQuery).toHaveBeenCalledWith('src.postgres.database.azure.com', 'lakebase', 'select version()');
  });
});

describe('provision route', () => {
  it('400s an unknown SKU', async () => {
    const { POST } = await import('../[id]/provision/route');
    const res = await POST(post('http://x/p', { name: 'n', resourceGroup: 'r', location: 'l', administratorLogin: 'a', administratorLoginPassword: 'p', skuName: 'Bogus_SKU' }), params());
    expect(res.status).toBe(400);
    const j = await res.json(); expect(j.code).toBe('bad_sku');
  });
});

describe('branches route', () => {
  it('202s and records a branch on a real PITR restore', async () => {
    createBranchFn.mockResolvedValue({ ok: true, id: '/branch', provisioningState: 'Creating' });
    const { POST } = await import('../[id]/branches/route');
    const res = await POST(post('http://x/b', { newServerName: 'branch1' }), params());
    expect(res.status).toBe(202);
    const j = await res.json(); expect(j.ok).toBe(true); expect(j.branch.name).toBe('branch1');
    expect(createBranchFn).toHaveBeenCalled();
  });
});

describe('replicas route', () => {
  it('403s a read-only caller', async () => {
    access.canWrite = false;
    const { POST } = await import('../[id]/replicas/route');
    const res = await POST(post('http://x/r', { newServerName: 'rep1' }), params());
    expect(res.status).toBe(403);
    expect(createReplicaFn).not.toHaveBeenCalled();
  });
});
