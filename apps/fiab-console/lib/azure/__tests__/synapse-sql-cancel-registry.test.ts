/**
 * The Synapse SQL client's in-process cancel registry, driven directly (only
 * `mssql` and the credential are stood in). `executeQuery` registers a running
 * request under its `SqlCancelKey`; `cancelActiveQuery(key)` cancels it only
 * when every field of the key matches: the route family, the caller's oid, the
 * item id and the queryId.
 *
 * The fake request's `query()` stays pending until `cancel()` is called, so a
 * query is "in flight" for as long as the test needs. What breaks each case is
 * named in its label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fake = vi.hoisted(() => {
  const requests: Array<{ cancelled: boolean }> = [];
  class FakeRequest {
    cancelled = false;
    private rejectRun: ((e: Error) => void) | null = null;
    on() { return this; }
    input() { return this; }
    query() {
      return new Promise((_resolve, reject) => { this.rejectRun = reject; });
    }
    cancel() {
      this.cancelled = true;
      this.rejectRun?.(new Error('Canceled.'));
    }
  }
  class ConnectionPool {
    connected = true;
    async connect() { return this; }
    on() { return this; }
    request() {
      const r = new FakeRequest();
      requests.push(r);
      return r;
    }
  }
  return { requests, ConnectionPool };
});
vi.mock('mssql', () => ({ default: { ConnectionPool: fake.ConnectionPool, NVarChar: () => 'nvarchar', MAX: -1 } }));
vi.mock('@/lib/azure/workspace-credential-factory', () => ({
  workspaceScopedCredential: () => ({
    getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }),
  }),
}));

import { executeQuery, cancelActiveQuery, type SqlCancelKey } from '../synapse-sql-client';

const TARGET = { server: 's', database: 'd', cacheKey: 'registry-test' };
const KEY: SqlCancelKey = { family: 'warehouse', oid: 'oid-a', itemId: 'wh-1', queryId: 'q-1' };

/** Start a query under `key` and wait until it is registered (in flight). */
async function start(key: SqlCancelKey) {
  const before = fake.requests.length;
  const run = executeQuery(TARGET, 'SELECT 1', 30_000, undefined, key);
  run.catch(() => undefined); // it rejects when cancelled
  await vi.waitFor(() => expect(fake.requests.length).toBe(before + 1));
  return { run, request: fake.requests[before] };
}

beforeEach(() => {
  fake.requests.length = 0;
});

describe('SQL cancel registry: keys are namespaced by family and scoped to caller and item', () => {
  it('the exact key cancels the running request, once (positive half)', async () => {
    const { run, request } = await start(KEY);
    expect(cancelActiveQuery({ ...KEY })).toBe(true);
    expect(request.cancelled).toBe(true);
    await expect(run).rejects.toThrow('Canceled.');
    // The entry is gone after the cancel.
    expect(cancelActiveQuery({ ...KEY })).toBe(false);
  });

  it('a key from another route family does not cancel (breaks if the family is dropped from the key)', async () => {
    const { request } = await start(KEY);
    expect(cancelActiveQuery({ ...KEY, family: 'dedicated-sql-pool' })).toBe(false);
    expect(cancelActiveQuery({ ...KEY, family: 'serverless-sql-pool' })).toBe(false);
    expect(request.cancelled).toBe(false);
    // Still in flight under its own key.
    expect(cancelActiveQuery(KEY)).toBe(true);
  });

  it('a foreign oid does not cancel (breaks if the oid is dropped from the key)', async () => {
    const { request } = await start(KEY);
    expect(cancelActiveQuery({ ...KEY, oid: 'oid-b' })).toBe(false);
    expect(request.cancelled).toBe(false);
    expect(cancelActiveQuery(KEY)).toBe(true);
  });

  it('another item does not cancel (breaks if the item id is dropped from the key)', async () => {
    const { request } = await start(KEY);
    expect(cancelActiveQuery({ ...KEY, itemId: 'wh-2' })).toBe(false);
    expect(request.cancelled).toBe(false);
    expect(cancelActiveQuery(KEY)).toBe(true);
  });

  it('fields cannot be spelled to collide (breaks if the key is a delimiter join such as family:oid:item:query)', async () => {
    // Joined with ':' both keys read `warehouse:oid-a:wh-1:q-1`.
    const registered: SqlCancelKey = { ...KEY, itemId: 'wh-1:q', queryId: '1' };
    const { request } = await start(registered);
    expect(cancelActiveQuery({ ...KEY, itemId: 'wh-1', queryId: 'q:1' })).toBe(false);
    expect(request.cancelled).toBe(false);
    expect(cancelActiveQuery(registered)).toBe(true);
  });

  it('a query started without a key is not registered', async () => {
    const before = fake.requests.length;
    const run = executeQuery(TARGET, 'SELECT 1', 30_000);
    run.catch(() => undefined);
    await vi.waitFor(() => expect(fake.requests.length).toBe(before + 1));
    expect(cancelActiveQuery(KEY)).toBe(false);
    // Clean up the pending fake request.
    (fake.requests[before] as any).cancel();
  });
});
