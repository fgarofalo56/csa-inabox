/**
 * GHSA-v8r7-c2p5-mjf2 — POST /api/items/azure-sql-database/[id]/performance.
 *
 * BEFORE `server` + `database` arrived in the body under a bare `getSession()`
 * and went straight to the Query Store readers. This is a READ finding first:
 * `top-queries` returns executed QUERY TEXT and `query-plan` returns SHOWPLAN
 * XML, both of which routinely carry literal predicate values — so a
 * caller-named database leaked other tenants' workload CONTENT, not just their
 * schema. `enable` is the write half (ALTER DATABASE).
 *
 * The specs assert per-action so that a fix which pinned only one reader would
 * still fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';
const GOVERNED = '11111111-1111-1111-1111-111111111111';
const FOREIGN = '99999999-9999-9999-9999-999999999999';
const foreignId = `/subscriptions/${FOREIGN}/resourceGroups/rg-victim/providers/Microsoft.Sql/servers/victim-srv`;

const getSessionMock = vi.fn(() => ({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const OWNED_ITEM = {
  id: 'item1', workspaceId: 'ws1', itemType: 'azure-sql-database',
  displayName: 'Mine', state: { connection: { family: 'azure-sql', server: 'srv', database: 'db' } },
} as any;
const loadOwnedItemMock = vi.fn(async () => OWNED_ITEM);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

const queryStoreStatusMock = vi.fn(async () => ({ actual_state_desc: 'READ_WRITE' }));
const enableQueryStoreMock = vi.fn(async () => ({ actual_state_desc: 'READ_WRITE' }));
const topQueriesByMetricMock = vi.fn(async () => [{ query_id: 1, query_sql_text: 'SELECT ssn FROM patients' }]);
const queryTimeSeriesMock = vi.fn(async () => [{ t: 1 }]);
const queryStorePlanMock = vi.fn(async () => '<ShowPlanXML/>');
vi.mock('@/lib/azure/sql-objects-client', () => ({
  queryStoreStatus: (...a: any[]) => queryStoreStatusMock(...a),
  enableQueryStore: (...a: any[]) => enableQueryStoreMock(...a),
  topQueriesByMetric: (...a: any[]) => topQueriesByMetricMock(...a),
  queryTimeSeries: (...a: any[]) => queryTimeSeriesMock(...a),
  queryStorePlan: (...a: any[]) => queryStorePlanMock(...a),
}));
class AzureSqlError extends Error { status = 502; }
vi.mock('@/lib/azure/azure-sql-client', () => ({ AzureSqlError }));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/azure-sql-database/item1/performance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function noReaderRan() {
  expect(queryStoreStatusMock).not.toHaveBeenCalled();
  expect(topQueriesByMetricMock).not.toHaveBeenCalled();
  expect(queryTimeSeriesMock).not.toHaveBeenCalled();
  expect(queryStorePlanMock).not.toHaveBeenCalled();
  expect(enableQueryStoreMock).not.toHaveBeenCalled();
}

let savedSub: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedSub = process.env.LOOM_SUBSCRIPTION_ID;
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
});
afterEach(() => {
  if (savedSub === undefined) delete process.env.LOOM_SUBSCRIPTION_ID; else process.env.LOOM_SUBSCRIPTION_ID = savedSub;
});

describe('POST /api/items/azure-sql-database/[id]/performance — Query Store authorization', () => {
  it('401s when unauthenticated and reads NO Query Store', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'top-queries', server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(401);
    noReaderRan();
  });

  //   MUTATION: restore the `getSession()` prologue reading server/database from the body.
  it('404s a caller who does NOT own the item, reading NO query text', async () => {
    // mockResolvedValue, NOT ...Once — the wrapper tries every SQL_EDITOR_ITEM_TYPE.
    loadOwnedItemMock.mockResolvedValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'top-queries', server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(404);
    noReaderRan();
  });

  // `enable` runs ALTER DATABASE on the same handler, so the whole route stays
  // write-scoped.
  //   MUTATION: add `allowReadRoles: true`.
  it('stays WRITE-scoped — no allowReadRoles on the owner check', async () => {
    const { POST } = await import('../route');
    await POST(postReq({ action: 'status' }), PARAMS);
    const opts = loadOwnedItemMock.mock.calls.at(-1)?.[3] as { allowReadRoles?: boolean } | undefined;
    expect(opts?.allowReadRoles).toBeFalsy();
  });

  // The exfiltration shape: a foreign DATABASE on the item's own bound server.
  it('403s a body database that differs from the binding — reads NO query text', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'top-queries', server: 'srv', database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('database_mismatch');
    noReaderRan();
  });

  it('403s a body ARM id in an ungoverned subscription', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'query-plan', queryId: 7, server: foreignId, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    noReaderRan();
  });

  it('403s a body ARM id for a SAME-NAMED server in an ungoverned subscription', async () => {
    const sameName = `/subscriptions/${FOREIGN}/resourceGroups/rg-victim/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'top-queries', server: sameName, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('server_not_governed');
    noReaderRan();
  });

  it('403s an item BOUND to an ungoverned subscription even when the body agrees', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...OWNED_ITEM, state: { connection: { family: 'azure-sql', server: foreignId, database: 'db' } },
    } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'top-queries', server: foreignId, database: 'db' }), PARAMS);
    expect(r.status).toBe(403);
    noReaderRan();
  });

  it('409s an item with no bound connection rather than reading a body-chosen database', async () => {
    loadOwnedItemMock.mockResolvedValue({ ...OWNED_ITEM, state: {} } as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'top-queries', server: foreignId, database: 'victim-db' }), PARAMS);
    expect(r.status).toBe(409);
    noReaderRan();
  });

  // ---- the legitimate-owner direction, per action ----
  it('CONTROL: status reads the OWN bound database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'status' }), PARAMS);
    expect(r.status).toBe(200);
    expect(queryStoreStatusMock).toHaveBeenCalledWith('srv', 'db');
  });

  it('CONTROL: top-queries reads the OWN bound database, caller-chosen metric preserved', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'top-queries', metric: 'duration', topN: 5, windowHours: 3 }), PARAMS);
    expect(r.status).toBe(200);
    expect(topQueriesByMetricMock).toHaveBeenCalledWith('srv', 'db', 'duration', 3, 5);
  });

  it('CONTROL: query-plan reads the OWN bound database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'query-plan', queryId: 7 }), PARAMS);
    expect(r.status).toBe(200);
    expect(queryStorePlanMock).toHaveBeenCalledWith('srv', 'db', 7);
  });

  it('CONTROL: time-series reads the OWN bound database', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'time-series', queryId: 7, windowHours: 6 }), PARAMS);
    expect(r.status).toBe(200);
    expect(queryTimeSeriesMock).toHaveBeenCalledWith('srv', 'db', 7, 6);
  });

  it('CONTROL: enable still requires explicit confirm, then targets the binding', async () => {
    const { POST } = await import('../route');
    const gated = await POST(postReq({ action: 'enable' }), PARAMS);
    expect(gated.status).toBe(200);
    expect((await gated.json()).gate).toBe(true);
    expect(enableQueryStoreMock).not.toHaveBeenCalled();

    const done = await POST(postReq({ action: 'enable', confirm: true }), PARAMS);
    expect(done.status).toBe(200);
    expect(enableQueryStoreMock).toHaveBeenCalledWith('srv', 'db');
  });

  // THE REBINDING MUTATION CATCHERS — a DIFFERENT FORM of the same server, so a
  // `body.server ?? server` rebinding produces a different value. Asserted on
  // TWO readers, because they are separate call sites.
  //   MUTATION: `topQueriesByMetric(String(body.server || server), …)`.
  it('reads the BOUND server on top-queries even when the body names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'top-queries', server: governedId, database: 'db' }), PARAMS);
    expect(r.status).toBe(200);
    expect(topQueriesByMetricMock.mock.calls[0][0]).toBe('srv');
  });

  //   MUTATION: `queryStorePlan(String(body.server || server), …)`.
  it('reads the BOUND server on query-plan even when the body names it in another form', async () => {
    const governedId = `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv`;
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'query-plan', queryId: 7, server: governedId, database: 'db' }), PARAMS);
    expect(r.status).toBe(200);
    expect(queryStorePlanMock.mock.calls[0][0]).toBe('srv');
  });

  it('still validates the action it owns', async () => {
    const { POST } = await import('../route');
    const r = await POST(postReq({ action: 'nope' }), PARAMS);
    expect(r.status).toBe(400);
    noReaderRan();
  });
});
