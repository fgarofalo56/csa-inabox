/**
 * `POST /api/items/[type]/[id]/visual-query` for `synapse-serverless-sql-pool`
 * fails closed when the guard admits the caller but hands back no item record:
 * without the item there is no lakehouse root set to confine a non-admin's SQL
 * to, so nothing runs.
 *
 * The guard is mocked here ONLY to produce that shape (the real guard returns
 * a 404 before this point, so the case cannot arise today). The breaking input
 * is a route that skips confinement when the item is missing: the non-admin
 * case would then run and answer 200.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-reader', tid: 'tid-1', upn: 'r@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION, tenantScopeId: () => 'tid-1' }));
vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: vi.fn(async () => null) }));

const admin = vi.hoisted(() => ({ isTenantAdmin: vi.fn(() => false) }));
vi.mock('@/lib/auth/feature-gate', async () => ({
  ...(await vi.importActual<any>('@/lib/auth/feature-gate')),
  isTenantAdmin: admin.isTenantAdmin,
}));

const POOL = { id: 'pool-1', itemType: 'synapse-serverless-sql-pool', workspaceId: 'ws-1', displayName: 'P', state: {} };
const scope = vi.hoisted(() => ({
  guardSqlPoolQueryItem: vi.fn(async (..._a: any[]) => ({ ctx: { item: null as any } }) as any),
  confineToWorkspaceLakehouses: vi.fn(async (..._a: any[]) => null as any),
}));
vi.mock('@/app/api/items/synapse-serverless-sql-pool/_lib/query-scope', async () => ({
  ...(await vi.importActual<any>('@/app/api/items/synapse-serverless-sql-pool/_lib/query-scope')),
  guardSqlPoolQueryItem: scope.guardSqlPoolQueryItem,
  confineToWorkspaceLakehouses: scope.confineToWorkspaceLakehouses,
}));

const synapse = vi.hoisted(() => ({
  executeQuery: vi.fn(async (..._a: any[]) => ({
    columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 3, truncated: false, messages: [],
  })),
  executeQueryAsUser: vi.fn(async (..._a: any[]) => ({
    columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 3, truncated: false, messages: [],
  })),
  serverlessTarget: vi.fn((database = 'master') => ({ server: 's', database, cacheKey: `k:${database}` })),
  dedicatedTarget: vi.fn(() => ({ server: 'd', database: 'pool', cacheKey: 'dedicated:pool' })),
  serverlessEndpoint: () => 's.sql.azuresynapse.net',
  getSynapseSqlSuffix: () => 'sql.azuresynapse.net',
}));
vi.mock('@/lib/azure/synapse-sql-client', () => synapse);
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: vi.fn(async () => ({ state: 'Online' })) }));
vi.mock('@/lib/azure/sql-access-mode', () => ({ resolveAccessMode: vi.fn(async () => 'service') }));
vi.mock('@/lib/azure/sql-user-token-store', () => ({ getUserSqlToken: vi.fn(async () => 'user-token') }));
vi.mock('@/lib/azure/databricks-client', () => ({ executeStatement: vi.fn(), getWarehouse: vi.fn() }));

import { POST } from '@/app/api/items/[type]/[id]/visual-query/route';

function ctx() {
  return { params: Promise.resolve({ type: 'synapse-serverless-sql-pool', id: 'pool-1' }) } as any;
}
function req(body: any) {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}
const describeBody = { describe: { schema: 'dbo', table: 'orders' } };

beforeEach(() => {
  vi.clearAllMocks();
  admin.isTenantAdmin.mockReturnValue(false);
  scope.guardSqlPoolQueryItem.mockResolvedValue({ ctx: { item: null } } as any);
  scope.confineToWorkspaceLakehouses.mockResolvedValue(null as any);
});

describe('visual query on the serverless SQL pool item fails closed without the item record', () => {
  it('a non-admin with no item record gets 500 and nothing runs (breaks if confinement is skipped when the item is missing)', async () => {
    const res = await POST(req(describeBody), ctx());
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
    expect(scope.confineToWorkspaceLakehouses).not.toHaveBeenCalled();
    expect(synapse.executeQuery).not.toHaveBeenCalled();
    expect(synapse.executeQueryAsUser).not.toHaveBeenCalled();
  });

  it('positive half: with the item record, the same non-admin request is confined against that item and runs', async () => {
    scope.guardSqlPoolQueryItem.mockResolvedValue({ ctx: { item: POOL } } as any);
    const res = await POST(req(describeBody), ctx());
    expect(res.status).toBe(200);
    expect(scope.confineToWorkspaceLakehouses).toHaveBeenCalledTimes(1);
    expect(scope.confineToWorkspaceLakehouses.mock.calls[0][1]).toBe(POOL);
    expect(synapse.executeQuery).toHaveBeenCalledTimes(1);
  });
});
