/**
 * #3744 — the Console-side PRODUCER of LOOM_DATABRICKS_SQL_WAREHOUSE_ID.
 *
 * Seams: the Databricks REST client and the Cosmos container are replaced with
 * in-memory fakes; the REAL platform-settings read (`readPlatformSettings`),
 * the REAL runtime-produced store, the REAL env-check evaluation and the REAL
 * gate registry run unmodified — so the "gate reads green" assertions exercise
 * the same code /admin/readiness does.
 *
 * Every load-bearing assertion names, beside it, the input/mutation that turns
 * it red (assertion-design.md). The mutation run for these is reported in the
 * PR body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const h = vi.hoisted(() => {
  // writes = successful binding writes; replaceCalls = every replace attempt;
  // failNextReplace = the next replace loses an etag race (412) once.
  const cosmos: { doc: any; etag: number; writes: number; replaceCalls: number; failNextReplace: boolean } =
    { doc: undefined, etag: 0, writes: 0, replaceCalls: 0, failNextReplace: false };
  const container = {
    item: (_id: string, _pk: string) => ({
      read: async () => {
        if (!cosmos.doc) {
          const e: any = new Error('Entity with the specified id does not exist');
          e.code = 404;
          throw e;
        }
        return { resource: { ...cosmos.doc } };
      },
      replace: async (doc: any, opts: any) => {
        cosmos.replaceCalls++;
        if (cosmos.failNextReplace) {
          // A concurrent admin write landed between our read and our replace.
          cosmos.failNextReplace = false;
          cosmos.doc = { ...cosmos.doc, _etag: String(++cosmos.etag) };
        }
        if (opts?.accessCondition?.condition !== cosmos.doc?._etag) {
          const e: any = new Error('precondition failed');
          e.code = 412;
          throw e;
        }
        cosmos.doc = { ...doc, _etag: String(++cosmos.etag) };
        cosmos.writes++;
        return { resource: cosmos.doc };
      },
    }),
    items: {
      create: async (doc: any) => {
        if (cosmos.doc) {
          const e: any = new Error('conflict');
          e.code = 409;
          throw e;
        }
        cosmos.doc = { ...doc, _etag: String(++cosmos.etag) };
        cosmos.writes++;
        return { resource: cosmos.doc };
      },
    },
  };
  const dbx = {
    listWarehouses: vi.fn(),
    getWarehouse: vi.fn(),
    createWarehouse: vi.fn(),
    // The only raw call the resolver makes is SCIM `Me` (getCurrentIdentity lives in the resolver).
    dbxFetch: vi.fn(),
  };
  return { cosmos, container, dbx };
});

vi.mock('@/lib/azure/cosmos-client', () => ({ envConfigContainer: async () => h.container }));
vi.mock('@/lib/azure/databricks-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure/databricks-client')>('@/lib/azure/databricks-client');
  // The REAL databricksConfigGate (reads LOOM_DATABRICKS_HOSTNAME); only the REST calls are faked.
  return { ...actual, ...h.dbx };
});

import {
  resolveDatabricksSqlWarehouseId,
  classifyWarehouseFailure,
  WarehouseResolutionError,
  LOOM_DEFAULT_WAREHOUSE_SPEC,
  LOOM_DEFAULT_WAREHOUSE_NAME,
  WAREHOUSE_ENV_VAR,
  __testing,
} from '../databricks-sql-warehouse';
import { clearRuntimeProduced } from '../runtime-produced-env';
import { gateStatus, getGate } from '@/lib/gates/registry';

const HOST = 'adb-1111.11.azuredatabricks.net';

function httpErr(op: string, status: number, body: string): Error {
  const e: any = new Error(`${op} failed ${status}: ${body}`);
  e.status = status;
  e.body = body;
  return e;
}

/** SCIM `Me` answers with the raw SCIM shape (entitlements/groups are objects, as the API returns them). */
function meReturns(body: object) {
  h.dbx.dbxFetch.mockImplementation(async (p: string) => {
    if (p !== '/api/2.0/preview/scim/v2/Me') throw new Error(`unexpected raw call ${p}`);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

function seedBinding(id: string, hostname = HOST) {
  h.cosmos.doc = {
    id: '__platform__',
    tenantId: '__platform__',
    biBackend: 'loom-native', // an unrelated admin setting that must survive the merge
    databricksSqlWarehouse: { id, name: LOOM_DEFAULT_WAREHOUSE_NAME, hostname, source: 'created', boundAt: '2026-09-01T00:00:00Z' },
    _etag: String(++h.cosmos.etag),
  };
}

beforeEach(() => {
  __testing.reset();
  __testing.setSleep(async () => undefined);
  clearRuntimeProduced(WAREHOUSE_ENV_VAR);
  h.cosmos.doc = undefined;
  h.cosmos.etag = 0;
  h.cosmos.writes = 0;
  h.cosmos.replaceCalls = 0;
  h.cosmos.failNextReplace = false;
  for (const f of Object.values(h.dbx)) f.mockReset();
  h.dbx.listWarehouses.mockResolvedValue([]);
  vi.stubEnv(WAREHOUSE_ENV_VAR, '');
  vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', HOST);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolution order', () => {
  it('(a) the env pin wins — no workspace call is made', async () => {
    vi.stubEnv(WAREHOUSE_ENV_VAR, 'wh-pinned');
    seedBinding('wh-persisted');
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-listed', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if env is consulted after persisted/list: id would be 'wh-persisted' or 'wh-listed'.
    expect(r).toMatchObject({ id: 'wh-pinned', source: 'env' });
    expect(h.dbx.getWarehouse).not.toHaveBeenCalled();
    expect(h.dbx.listWarehouses).not.toHaveBeenCalled();
  });

  it('(b) a persisted binding wins over the list, verified with a GET', async () => {
    seedBinding('wh-persisted');
    h.dbx.getWarehouse.mockResolvedValue({ id: 'wh-persisted', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STOPPED' });
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-listed', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if the persisted layer is skipped: the list would yield 'wh-listed'.
    expect(r).toMatchObject({ id: 'wh-persisted', source: 'persisted' });
    expect(h.dbx.getWarehouse).toHaveBeenCalledWith('wh-persisted');
    expect(h.dbx.listWarehouses).not.toHaveBeenCalled();
  });

  it('(b) a binding recorded against ANOTHER workspace host is ignored', async () => {
    seedBinding('wh-other-estate', 'adb-9999.9.azuredatabricks.net');
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-listed', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if the host check is dropped: 'wh-other-estate' would be returned.
    expect(r.id).toBe('wh-listed');
    expect(h.dbx.getWarehouse).not.toHaveBeenCalled();
  });

  it('(c) the list adopts the warehouse named loom-default (not the first one), then persists it', async () => {
    h.dbx.listWarehouses.mockResolvedValue([
      { id: 'wh-a', name: 'analyst-adhoc', state: 'RUNNING' },
      { id: 'wh-ld', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STOPPED' },
    ]);
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if the pick is "first / first running" (the old probe heuristic): 'wh-a'.
    expect(r).toMatchObject({ id: 'wh-ld', source: 'listed' });
    expect(h.dbx.createWarehouse).not.toHaveBeenCalled();
    // Breaks if persistence is skipped, or clobbers the unrelated admin field.
    expect(h.cosmos.doc.databricksSqlWarehouse).toMatchObject({ id: 'wh-ld', hostname: HOST, source: 'listed' });
  });

  it('(d) creates loom-default with the bootstrap spec when absent, then persists it', async () => {
    h.dbx.listWarehouses.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'wh-new', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STARTING' }]);
    h.dbx.createWarehouse.mockResolvedValue({ id: 'wh-new' });
    const r = await resolveDatabricksSqlWarehouseId();
    expect(r).toMatchObject({ id: 'wh-new', source: 'created' });
    // Breaks on any drift in size / auto-stop / serverless / name.
    expect(h.dbx.createWarehouse).toHaveBeenCalledTimes(1);
    expect(h.dbx.createWarehouse).toHaveBeenCalledWith(LOOM_DEFAULT_WAREHOUSE_SPEC);
    expect(h.cosmos.doc.databricksSqlWarehouse).toMatchObject({ id: 'wh-new', source: 'created' });
    expect(h.cosmos.doc.biBackend).toBeUndefined(); // no pre-existing doc here → nothing to preserve
  });

  it('(d) persisting MERGES into an existing platform doc — an admin setting survives', async () => {
    h.cosmos.doc = { id: '__platform__', tenantId: '__platform__', biBackend: 'powerbi', _etag: String(++h.cosmos.etag) };
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-ld', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    await resolveDatabricksSqlWarehouseId();
    // Breaks if the write replaces the doc wholesale: biBackend would be lost.
    expect(h.cosmos.doc.biBackend).toBe('powerbi');
    expect(h.cosmos.doc.databricksSqlWarehouse.id).toBe('wh-ld');
  });
});

describe('self-healing', () => {
  it('a persisted id that 404s is discarded and re-resolved', async () => {
    seedBinding('wh-gone');
    h.dbx.getWarehouse.mockRejectedValue(httpErr('getWarehouse', 404, '{"error_code":"RESOURCE_DOES_NOT_EXIST","message":"not found"}'));
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-ld2', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if a 404 is treated as fatal (throws) or ignored (returns 'wh-gone').
    expect(r.id).toBe('wh-ld2');
    expect(h.cosmos.doc.databricksSqlWarehouse.id).toBe('wh-ld2');
  });

  it('a persisted id whose warehouse is DELETED is re-resolved', async () => {
    seedBinding('wh-deleted');
    h.dbx.getWarehouse.mockResolvedValue({ id: 'wh-deleted', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'DELETED' });
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-ld3', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    expect((await resolveDatabricksSqlWarehouseId()).id).toBe('wh-ld3');
  });

  it('the in-process cache re-verifies after its TTL and re-heals an out-of-band delete', async () => {
    h.dbx.listWarehouses.mockResolvedValueOnce([{ id: 'wh-first', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    expect((await resolveDatabricksSqlWarehouseId()).id).toBe('wh-first');
    // Within the TTL: served from cache, no calls.
    const callsBefore = h.dbx.listWarehouses.mock.calls.length + h.dbx.getWarehouse.mock.calls.length;
    expect((await resolveDatabricksSqlWarehouseId()).id).toBe('wh-first');
    expect(h.dbx.listWarehouses.mock.calls.length + h.dbx.getWarehouse.mock.calls.length).toBe(callsBefore);
    // Past the TTL, the persisted id now 404s → re-list finds the replacement.
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 6 * 60_000);
    h.dbx.getWarehouse.mockRejectedValue(httpErr('getWarehouse', 404, 'gone'));
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-second', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    // Breaks if the cache never expires: 'wh-first' would be served forever.
    expect((await resolveDatabricksSqlWarehouseId()).id).toBe('wh-second');
  });
});

describe('concurrency', () => {
  it('N simultaneous first calls issue exactly ONE create and all get the same id', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // The list stays EMPTY until a create has actually landed. (A first version
    // used mockResolvedValueOnce([]) and a mutation run showed it BLIND: the
    // 2nd..Nth undeduplicated callers listed after the first and adopted
    // instead of creating, so removing the in-flight promise stayed green.)
    let created = 0;
    h.dbx.listWarehouses.mockImplementation(async () =>
      created ? [{ id: 'wh-once', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STARTING' }] : []);
    h.dbx.createWarehouse.mockImplementation(async () => { await gate; created++; return { id: 'wh-once' }; });
    const all = Array.from({ length: 5 }, () => resolveDatabricksSqlWarehouseId());
    // Let every caller reach its create (or its await on the shared promise)
    // before releasing — a macrotask drains every pending microtask chain.
    await new Promise((r) => setTimeout(r, 25));
    release();
    const ids = (await Promise.all(all)).map((r) => r.id);
    // Breaks if the in-flight promise is removed: create would be called 5 times.
    expect(h.dbx.createWarehouse).toHaveBeenCalledTimes(1);
    expect(new Set(ids)).toEqual(new Set(['wh-once']));
  });

  it('a create that CONFLICTS (another replica won) re-lists and adopts', async () => {
    h.dbx.listWarehouses.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'wh-replica', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STARTING' }]);
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 409, '{"error_code":"RESOURCE_ALREADY_EXISTS","message":"exists"}'));
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if a create-conflict is classified as a failure instead of adopted.
    expect(r.id).toBe('wh-replica');
  });

  it('two loom-default warehouses (a cross-replica race) converge on the lowest id, surplus named', async () => {
    h.dbx.listWarehouses.mockResolvedValueOnce([]).mockResolvedValue([
      { id: 'wh-zzz', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' },
      { id: 'wh-aaa', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' },
    ]);
    h.dbx.createWarehouse.mockResolvedValue({ id: 'wh-zzz' });
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if "the id I created" wins over the deterministic pick: 'wh-zzz'.
    expect(r.id).toBe('wh-aaa');
    expect(r.detail).toMatch(/wh-zzz/);
    // M-B: the PERSISTED id is the converged one. Breaks if persistBinding is
    // handed createdId ('wh-zzz') while the returned id is 'wh-aaa' — the next
    // process would then bind a different warehouse than this one did.
    expect(h.cosmos.doc.databricksSqlWarehouse.id).toBe('wh-aaa');
    // Nit #8: never claims a "concurrent create won" — it names what it measured.
    expect(r.detail).toMatch(/This replica's create returned wh-zzz; bound to the lowest-id 'loom-default' \(wh-aaa\)/);
  });

  it('a create whose response carries NO id binds the listed warehouse and says exactly that', async () => {
    h.dbx.listWarehouses.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'wh-listed', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STARTING' }]);
    h.dbx.createWarehouse.mockResolvedValue({});
    const r = await resolveDatabricksSqlWarehouseId();
    expect(r.id).toBe('wh-listed');
    // Breaks if the old "A concurrent create won" text comes back: no concurrency was measured.
    expect(r.detail).toMatch(/^The create returned no id; bound to the listed 'loom-default' \(wh-listed\)\./);
    expect(r.detail).not.toMatch(/concurrent create won/);
  });

  it('create retry: a transport failure is followed by a RE-LIST that adopts loom-default — exactly ONE POST', async () => {
    // Breaking input: the first POST dies in transit (its response lost), and
    // the re-list shows the warehouse it created. A blind retry POSTs a second
    // time (createWarehouse called 2x, a duplicate warehouse).
    const t: any = new TypeError('fetch failed');
    t.cause = { code: 'ECONNRESET' };
    h.dbx.listWarehouses
      .mockResolvedValueOnce([]) // (c) nothing yet
      .mockResolvedValue([{ id: 'wh-landed', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STARTING' }]);
    h.dbx.createWarehouse.mockRejectedValueOnce(t).mockResolvedValue({ id: 'wh-second-post' });
    const r = await resolveDatabricksSqlWarehouseId();
    expect(h.dbx.createWarehouse).toHaveBeenCalledTimes(1);
    expect(r.id).toBe('wh-landed');
    expect(h.cosmos.doc.databricksSqlWarehouse).toMatchObject({ id: 'wh-landed', source: 'listed' });
    expect(r.detail).toMatch(/without POSTing again/);
  });

  it('create retry: a re-list that still shows NO loom-default does POST again (the retry is not removed)', async () => {
    const t: any = new TypeError('fetch failed');
    t.cause = { code: 'ECONNRESET' };
    let posted = 0;
    h.dbx.listWarehouses.mockImplementation(async () =>
      posted >= 2 ? [{ id: 'wh-retry', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STARTING' }] : []);
    h.dbx.createWarehouse.mockImplementation(async () => { posted++; if (posted === 1) throw t; return { id: 'wh-retry' }; });
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if the retry loop is dropped (1 POST, then a network failure).
    expect(h.dbx.createWarehouse).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ id: 'wh-retry', source: 'created' });
  });
});

describe('failure classification (R6/R7)', () => {
  it('no workspace bound → not-configured, and NO call is made', async () => {
    vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', '');
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err).toBeInstanceOf(WarehouseResolutionError);
    expect(err.kind).toBe('not-configured');
    expect(err.missing).toBe('LOOM_DATABRICKS_HOSTNAME');
    expect(h.dbx.listWarehouses).not.toHaveBeenCalled();
  });

  it('the measured network refusal (403 "Unauthorized network access") → network, never "not configured"', async () => {
    h.dbx.listWarehouses.mockRejectedValue(httpErr('listWarehouses', 403, 'Unauthorized network access to workspace: 1111'));
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    // Breaks if the 403-status branch is checked before the body: it would read 'permission'.
    expect(err.kind).toBe('network');
    // The workspace ANSWERED, so it was reached: breaks if this reuses the
    // transport wording ("could not reach"), which claims no answer came back.
    expect(err.message).toMatch(/was refused at the network layer \(HTTP 403\)/);
    expect(err.message).not.toMatch(/could not reach/);
    expect(err.message).toMatch(/Unauthorized network access/);
    expect(err.message).not.toMatch(/not configured/i);
  });

  it('a transport failure (no HTTP answer) → network, retried with bounded backoff, then fails closed', async () => {
    const sleeps: number[] = [];
    __testing.setSleep(async (ms) => { sleeps.push(ms); });
    const t: any = new TypeError('fetch failed');
    t.cause = { code: 'ECONNREFUSED' };
    h.dbx.listWarehouses.mockRejectedValue(t);
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.kind).toBe('network');
    // No HTTP answer: "could not reach" is the measured fact. Breaks if the
    // transport branch borrows the 403 "refused at the network layer" text.
    expect(err.message).toMatch(/could not reach the Databricks workspace/);
    expect(err.message).not.toMatch(/refused at the network layer/);
    // Breaks if retry is removed (1 call) or unbounded (the loop would not stop at 3).
    expect(h.dbx.listWarehouses).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1500]);
  });

  it('M-A: a list that FAILS (500, retries exhausted) never falls through to a create', async () => {
    h.dbx.listWarehouses.mockRejectedValue(httpErr('listWarehouses', 500, '{"error_code":"INTERNAL_ERROR","message":"boom"}'));
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    // Breaks if a list failure is swallowed to [] — (d) would then POST a
    // warehouse into a workspace whose contents were never read.
    expect(h.dbx.createWarehouse).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(WarehouseResolutionError);
    expect(err).toMatchObject({ kind: 'unknown', step: 'list', status: 500 });
    expect(h.dbx.listWarehouses).toHaveBeenCalledTimes(3);
  });

  it('M-E: inside the 30 s failure hold a repeat call is served the SAME error with no new workspace call', async () => {
    h.dbx.listWarehouses.mockRejectedValue(httpErr('listWarehouses', 403, 'Unauthorized network access to workspace'));
    const first = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    const second = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    // Breaks if the hold is removed: a render loop would re-list every call (2 here).
    expect(h.dbx.listWarehouses).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second.kind).toBe('network');
  });

  it('M-F: a REFUSED create writes NOTHING to the platform doc (no placeholder binding)', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 403, '{"error_code":"PERMISSION_DENIED","message":"not allowed"}'));
    meReturns({ displayName: 'loom-console-uami', entitlements: [{ value: 'workspace-access' }], groups: [{ display: 'users' }] });
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.kind).toBe('permission');
    // Breaks if a binding (e.g. id 'pending') is persisted on entering (d)
    // before the create is verified: writes would be 1 and the doc defined.
    expect(h.cosmos.writes).toBe(0);
    expect(h.cosmos.doc).toBeUndefined();
  });

  it('M-C: a binding write that loses an etag race (412) is retried and lands', async () => {
    // An existing platform doc forces the IfMatch replace path.
    h.cosmos.doc = { id: '__platform__', tenantId: '__platform__', biBackend: 'powerbi', _etag: String(++h.cosmos.etag) };
    h.cosmos.failNextReplace = true;
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-race', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if a 412 is not retried: one replace call, no write, and the
    // detail would report the binding NOT persisted.
    expect(h.cosmos.replaceCalls).toBe(2);
    expect(h.cosmos.writes).toBe(1);
    expect(h.cosmos.doc.databricksSqlWarehouse.id).toBe('wh-race');
    expect(h.cosmos.doc.biBackend).toBe('powerbi');
    expect(r.detail).not.toMatch(/NOT persisted/);
  });

  it('a REFUSED create → permission, naming allow-cluster-create and what SCIM Me measured', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 403, '{"error_code":"PERMISSION_DENIED","message":"not allowed"}'));
    meReturns({ displayName: 'loom-console-uami', entitlements: [{ value: 'workspace-access' }, { value: 'databricks-sql-access' }], groups: [{ display: 'users' }] });
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.kind).toBe('permission');
    expect(err.entitlement).toBe('allow-cluster-create');
    // Breaks if the SCIM measurement is dropped from the message.
    expect(err.message).toMatch(/"allow-cluster-create" is ABSENT/);
    expect(err.message).toMatch(/workspace-access, databricks-sql-access/);
    expect(err.remediation).toMatch(/cannot grant this to itself/);
  });

  it('a refused create where SCIM Me ALSO fails says it could not confirm (no invented cause)', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 403, '{"error_code":"PERMISSION_DENIED","message":"no"}'));
    h.dbx.dbxFetch.mockResolvedValue(new Response('nope', { status: 403 }));
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.kind).toBe('permission');
    expect(err.message).toMatch(/Could not read the identity's entitlements to confirm/);
    expect(err.message).not.toMatch(/ABSENT/);
  });

  it('a quota refusal → quota', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 400, '{"error_code":"QUOTA_EXCEEDED","message":"limit reached"}'));
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.kind).toBe('quota');
    expect(err.message).toMatch(/QUOTA_EXCEEDED/);
  });

  it('an unrecognised refusal → unknown, saying the cause is not established', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 400, '{"error_code":"INVALID_PARAMETER_VALUE","message":"bad channel"}'));
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    // Breaks if unknown falls into a named class (e.g. a catch-all 'permission').
    expect(err.kind).toBe('unknown');
    expect(err.message).toMatch(/does not identify a permission, network, or quota cause/);
    expect(err.message).toMatch(/INVALID_PARAMETER_VALUE/);
  });

  it('a serverless refusal (400 naming serverless) falls back to classic PRO, same size/auto-stop — the bootstrap\'s fallback', async () => {
    h.dbx.listWarehouses.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'wh-classic', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STARTING' }]);
    h.dbx.createWarehouse
      .mockRejectedValueOnce(httpErr('createWarehouse', 400, '{"error_code":"INVALID_PARAMETER_VALUE","message":"Serverless compute is not enabled for this workspace"}'))
      .mockResolvedValueOnce({ id: 'wh-classic' });
    const r = await resolveDatabricksSqlWarehouseId();
    expect(r.id).toBe('wh-classic');
    expect(h.dbx.createWarehouse).toHaveBeenNthCalledWith(2, { ...LOOM_DEFAULT_WAREHOUSE_SPEC, enable_serverless_compute: false });
    expect(r.detail).toMatch(/classic PRO/);
  });

  it('classifyWarehouseFailure: a bare 401 is AUTHENTICATION and names no entitlement', () => {
    const e = classifyWarehouseFailure('list', httpErr('listWarehouses', 401, 'unauthenticated'));
    // Breaks if 401 folds back into the 403 permission branch: kind 'permission'
    // and entitlement 'databricks-sql-access' — a grant that cannot fix a rejected token.
    expect(e.kind).toBe('authentication');
    expect(e.entitlement).toBeUndefined();
    expect(`${e.message} ${e.remediation}`).not.toMatch(/databricks-sql-access|allow-cluster-create/);
    expect(e.remediation).toMatch(/not a missing entitlement/);
    expect(e.message).toMatch(/HTTP 401/);
  });

  it('a 401 on list reaches the gate as authentication — no SCIM read, no role-grant Fix-it', async () => {
    h.dbx.listWarehouses.mockRejectedValue(httpErr('listWarehouses', 401, '{"error_code":"UNAUTHENTICATED","message":"token rejected"}'));
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.kind).toBe('authentication');
    expect(err.entitlement).toBeUndefined();
    // Breaks if authentication is routed through the permission measurement.
    expect(h.dbx.dbxFetch).not.toHaveBeenCalled();
    const g = getGate('svc-databricks-sql')!;
    expect(g.fixit.kind).toBe('env-picker');
  });

  it('a refused create where SCIM Me shows the identity IS an admin → unknown, no entitlement, no grant', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 403, '{"error_code":"PERMISSION_DENIED","message":"not allowed"}'));
    meReturns({ displayName: 'loom-console-uami', entitlements: [{ value: 'workspace-access' }], groups: [{ display: 'admins' }] });
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    // Breaks if the admin measurement only annotates the message and keeps
    // kind 'permission' + entitlement 'allow-cluster-create' (the round-1 shape).
    expect(err.kind).toBe('unknown');
    expect(err.entitlement).toBeUndefined();
    expect(err.message).toMatch(/HTTP 403/);
    expect(err.message).toMatch(/not allowed/);
    expect(err.message).toMatch(/cause is not established/);
    expect(err.remediation).toMatch(/granting an entitlement will not fix it/);
    expect(err.remediation).not.toMatch(/allow-cluster-create/);
    // G2 overlay: a non-permission kind keeps the declared env-picker.
    const g = getGate('svc-databricks-sql')!;
    expect(g.fixit.kind).not.toBe('role-grant');
    expect(g.fixit.kind).toBe('env-picker');
  });

  it('a refused LIST where the identity already holds databricks-sql-access directly → unknown, no entitlement', async () => {
    h.dbx.listWarehouses.mockRejectedValue(httpErr('listWarehouses', 403, '{"error_code":"PERMISSION_DENIED","message":"denied"}'));
    meReturns({ entitlements: [{ value: 'databricks-sql-access' }], groups: [{ display: 'users' }] });
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    // Breaks if the SCIM measurement runs only for the create step (list keeps
    // 'permission' naming databricks-sql-access), or checks the wrong entitlement.
    expect(err.kind).toBe('unknown');
    expect(err.entitlement).toBeUndefined();
    expect(err.message).toMatch(/"databricks-sql-access" is present directly/);
  });
});

describe('the svc-databricks-sql gate reads the resolver', () => {
  it('is blocked before resolution and CONFIGURED on a resolver-produced id (env unset)', async () => {
    // Pre-condition: the env var is unset, so a presence-only gate is blocked.
    expect(gateStatus('svc-databricks-sql')!.status).toBe('blocked');
    h.dbx.listWarehouses.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'wh-gate', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'STARTING' }]);
    h.dbx.createWarehouse.mockResolvedValue({ id: 'wh-gate' });
    await resolveDatabricksSqlWarehouseId();
    const st = gateStatus('svc-databricks-sql')!;
    // Breaks if `runtimeProduced` is removed from the spec, or the resolver stops publishing.
    expect(st.status).toBe('configured');
    expect(st.missing).toEqual([]);
    expect(st.check.detail).toMatch(/wh-gate/);
  });

  it('after a classified failure the gate stays blocked and carries THAT cause, not "set LOOM_X"', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 403, '{"error_code":"PERMISSION_DENIED","message":"no"}'));
    meReturns({ entitlements: [{ value: 'workspace-access' }], groups: [] });
    await resolveDatabricksSqlWarehouseId().catch(() => undefined);
    const st = gateStatus('svc-databricks-sql')!;
    expect(st.status).toBe('blocked');
    // The Missing: suffix is what gateStatus parses — it must still name the var.
    expect(st.missing).toEqual([WAREHOUSE_ENV_VAR]);
    expect(st.check.detail).toMatch(/tried to produce LOOM_DATABRICKS_SQL_WAREHOUSE_ID and failed \(permission\)/);
    // G2: a permission failure is a Fix-it grant, not a paragraph.
    const g = getGate('svc-databricks-sql')!;
    expect(g.fixit.kind).toBe('role-grant');
    expect(g.fixit.grantNote).toMatch(/allow-cluster-create/);
    expect(g.remediation).toMatch(/allow-cluster-create/);
  });

  it('with no failure recorded, the gate keeps its declared env-picker Fix-it', () => {
    const g = getGate('svc-databricks-sql')!;
    // Breaks if the overlay always reports role-grant.
    expect(g.fixit.kind).toBe('env-picker');
    expect(JSON.parse(JSON.stringify(g)).fixit.kind).toBe('env-picker'); // getters serialize
  });

  it('a network failure does NOT turn the Fix-it into a role grant', async () => {
    h.dbx.listWarehouses.mockRejectedValue(httpErr('listWarehouses', 403, 'Unauthorized network access to workspace'));
    await resolveDatabricksSqlWarehouseId().catch(() => undefined);
    const g = getGate('svc-databricks-sql')!;
    expect(g.fixit.kind).toBe('env-picker');
    expect(g.remediation).toMatch(/private endpoint/);
  });

  it('no workspace bound: the detail says the Console CANNOT produce it — not that a call failed', async () => {
    vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', '');
    await resolveDatabricksSqlWarehouseId().catch(() => undefined);
    const st = gateStatus('svc-databricks-sql')!;
    expect(st.check.detail).toMatch(/cannot produce LOOM_DATABRICKS_SQL_WAREHOUSE_ID yet/);
    expect(st.check.detail).not.toMatch(/tried to produce/);
  });
});

describe('the self-audit gate check runs the producer first (what /admin/readiness executes)', () => {
  it('gate-svc-databricks-sql evaluates SATISFIED on a cold process once the producer runs', async () => {
    const { loadExternalGates } = await import('@/lib/admin/gate-registry');
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-audit', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    const check = (await loadExternalGates()).find((g) => g.id === 'gate-svc-databricks-sql')!;
    // Cold: nothing produced yet in this process.
    expect(gateStatus('svc-databricks-sql')!.status).toBe('blocked');
    // Breaks if runProducer() is removed from evaluate(): it would report the var missing.
    expect(await check.evaluate()).toBeNull();
    expect(h.dbx.listWarehouses).toHaveBeenCalled();
  });

  it('a producer failure reaches the self-audit check as the classified remediation', async () => {
    const { loadExternalGates } = await import('@/lib/admin/gate-registry');
    h.dbx.listWarehouses.mockRejectedValue(httpErr('listWarehouses', 403, 'Unauthorized network access to workspace'));
    const check = (await loadExternalGates()).find((g) => g.id === 'gate-svc-databricks-sql')!;
    const miss = await check.evaluate();
    expect(miss?.detail).toMatch(/failed \(network\)/);
    // Breaks if `remediation` is snapshotted at map time (the static pre-attempt text).
    expect(check.remediation).toMatch(/private endpoint/);
  });
});

describe('spec is lifted from the bootstrap, not transcribed', () => {
  it('LOOM_DEFAULT_WAREHOUSE_SPEC equals the bootstrap\'s serverless POST body', () => {
    const wf = readFileSync(
      path.resolve(__dirname, '../../../../../.github/workflows/csa-loom-post-deploy-bootstrap.yml'),
      'utf8',
    );
    const bodies = [...wf.matchAll(/-d '(\{"name":"[^']*"enable_serverless_compute":true[^']*\})'/g)].map((m) => JSON.parse(m[1]));
    // Breaks if the workflow step is renamed/removed (0 bodies) or duplicated ambiguously.
    expect(bodies).toHaveLength(1);
    expect(LOOM_DEFAULT_WAREHOUSE_SPEC).toEqual(bodies[0]);
    // And the adopt-by-name select uses the same name.
    expect(wf).toContain(`select(.name=="${LOOM_DEFAULT_WAREHOUSE_NAME}")`);
  });
});
