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
  // failNextReplace = the next replace loses an etag race (412) once;
  // hideNextRead = the next read answers 404 once (a replica that read the doc
  // BEFORE another replica's binding landed).
  const cosmos: { doc: any; etag: number; writes: number; replaceCalls: number; failNextReplace: boolean; hideNextRead: boolean } =
    { doc: undefined, etag: 0, writes: 0, replaceCalls: 0, failNextReplace: false, hideNextRead: false };
  const container = {
    item: (_id: string, _pk: string) => ({
      read: async () => {
        if (!cosmos.doc || cosmos.hideNextRead) {
          cosmos.hideNextRead = false;
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
  LOOM_GOV_WAREHOUSE_NAME,
  LOOM_ADOPTABLE_WAREHOUSE_NAMES,
  WAREHOUSE_ENV_VAR,
  warehouseErrorBody,
  warehouseErrorStatus,
  withResolvedWarehouse,
  type WarehouseFailureKind,
  __testing,
} from '../databricks-sql-warehouse';
import { clearRuntimeProduced, readRuntimeFailure } from '../runtime-produced-env';
import { gateStatus, getGate, gateAdminDiagnostic } from '@/lib/gates/registry';

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
  h.cosmos.hideNextRead = false;
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
    // Round 3: the compare-and-adopt persist must not re-probe the binding this
    // resolution already found dead. Breaks (2 GETs) if the `discardedId` guard
    // in persistBinding is removed and the live check has to reject it again.
    expect(h.dbx.getWarehouse).toHaveBeenCalledTimes(1);
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
    // Nit #8: never claims a "concurrent create won" — it names what it measured,
    // and (round 3) claims only what THIS replica did: the lowest id IT listed.
    expect(r.detail).toMatch(/This replica's create returned wh-zzz; bound to the lowest-id 'loom-default' it listed \(wh-aaa\)/);
    expect(r.detail).not.toMatch(/every replica binds/);
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
    // B-6: the identity listing lives in `diagnostic`, NOT in the message any
    // signed-in caller receives. Breaks if the name/entitlement list moves back.
    expect(err.diagnostic).toMatch(/workspace-access, databricks-sql-access/);
    expect(err.diagnostic).toMatch(/loom-console-uami/);
    expect(err.message).not.toMatch(/loom-console-uami|workspace-access/);
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

  it('a serverless refusal (400 naming serverless) falls back to classic PRO, same size/auto-stop', async () => {
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
    // #4767 made the body a `printf` template whose serverless flag is `%s`,
    // filled by `create_warehouse true|false`. Both the template and the
    // argument of the FIRST create call are lifted from the workflow, not
    // transcribed. Breaks if the step is renamed/removed or duplicated (template
    // count ≠ 1), if the template's serverless flag stops being the `%s`
    // placeholder (count 0), if the first create stops being serverless, or if
    // ANY field of the body drifts from the resolver's spec (deep-equal).
    const templates = [...wf.matchAll(/printf '(\{"name":"[^']*"enable_serverless_compute":%s[^']*\})'/g)].map((m) => m[1]);
    expect(templates).toHaveLength(1);
    const firstCreateArg = /\bcreate_warehouse (true|false) /.exec(wf)?.[1];
    expect(firstCreateArg).toBe('true');
    const body = JSON.parse(templates[0].replace('%s', firstCreateArg!));
    expect(LOOM_DEFAULT_WAREHOUSE_SPEC).toEqual(body);
    // And the adopt-by-name select uses the same name (whitespace around `==` tolerated).
    const selects = [...wf.matchAll(/select\(\.name\s*==\s*"([^"]+)"\)/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(0);
    expect(new Set(selects)).toEqual(new Set([LOOM_DEFAULT_WAREHOUSE_NAME]));
  });
});

describe('round 3 (#4776 re-review)', () => {
  const REPO = path.resolve(__dirname, '../../../../..');
  /** The `"name":"<x>"` of the create body a producer POSTs — lifted, not transcribed. */
  function producerCreateName(rel: string): string[] {
    const src = readFileSync(path.join(REPO, rel), 'utf8');
    return [...src.matchAll(/-d '\{"name":"([^"]+)"/g)].map((m) => m[1]);
  }

  it('B-1: the Gov producers\' warehouse name is lifted from BOTH producers and is adoptable', () => {
    const wf = producerCreateName('.github/workflows/gov-provision-dbx-sql.yml');
    const init = producerCreateName('apps/loom-dbx-init/init.sh');
    // Breaks if a producer is renamed (the resolver would adopt a name nobody
    // creates). The workflow POSTs twice (serverless, then the classic
    // fallback), so compare the DISTINCT names — and require at least one body,
    // so a regex that stops matching cannot pass on an empty list.
    expect(wf.length).toBeGreaterThanOrEqual(1);
    expect([...new Set(wf)]).toEqual([LOOM_GOV_WAREHOUSE_NAME]);
    expect([...new Set(init)]).toEqual([LOOM_GOV_WAREHOUSE_NAME]);
    // Order is the #4769 discover script's: loom-default first.
    expect(LOOM_ADOPTABLE_WAREHOUSE_NAMES).toEqual([LOOM_DEFAULT_WAREHOUSE_NAME, LOOM_GOV_WAREHOUSE_NAME]);
  });

  it('B-1: a Gov workspace listing ONLY loom-governance (no pin) adopts it — 0 creates', async () => {
    vi.stubEnv('LOOM_CLOUD', 'gcc-high');
    vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', 'adb-1.2.databricks.azure.us');
    h.dbx.listWarehouses.mockResolvedValue([
      { id: 'wh-other', name: 'analyst-adhoc', state: 'RUNNING' },
      { id: 'gov1', name: LOOM_GOV_WAREHOUSE_NAME, state: 'STOPPED' },
    ]);
    const r = await resolveDatabricksSqlWarehouseId();
    // The measured defect: { id:'new1', source:'created', creates:1 } — a
    // second warehouse beside the one the Gov producers made.
    expect(h.dbx.createWarehouse).toHaveBeenCalledTimes(0);
    expect(r).toMatchObject({ id: 'gov1', source: 'listed', name: LOOM_GOV_WAREHOUSE_NAME });
    expect(r.detail).toMatch(/Adopted the existing 'loom-governance' SQL warehouse \(gov1\)/);
    expect(h.cosmos.doc.databricksSqlWarehouse).toMatchObject({ id: 'gov1', name: LOOM_GOV_WAREHOUSE_NAME });
  });

  it('B-1: both names listed (loom-governance FIRST) → loom-default is preferred, whatever the list order', async () => {
    h.dbx.listWarehouses.mockResolvedValue([
      { id: 'aaa-gov', name: LOOM_GOV_WAREHOUSE_NAME, state: 'RUNNING' },
      { id: 'zzz-default', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' },
    ]);
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if the pick is list-order or lowest-id across names: 'aaa-gov'.
    expect(r.id).toBe('zzz-default');
    expect(h.dbx.createWarehouse).not.toHaveBeenCalled();
  });

  it('B-2: the network remediation names the Gov private DNS zone in Gov, the Commercial one in Commercial', () => {
    const t: any = new TypeError('fetch failed');
    t.cause = { code: 'ECONNREFUSED' };
    vi.stubEnv('LOOM_CLOUD', 'gcc-high');
    const gov = classifyWarehouseFailure('list', t);
    // Breaks if the zone is hard-coded again: the Gov text would name privatelink.azuredatabricks.net.
    expect(gov.remediation).toContain('privatelink.databricks.azure.us');
    expect(gov.remediation).not.toContain('privatelink.azuredatabricks.net');
    vi.stubEnv('LOOM_CLOUD', 'commercial');
    const com = classifyWarehouseFailure('list', t);
    expect(com.remediation).toContain('privatelink.azuredatabricks.net');
  });

  it('A-2: a replica that finds ANOTHER replica\'s live binding already stored ADOPTS it (P1)', async () => {
    // Replica B lists both and binds the lowest id it listed: wh-a.
    h.dbx.listWarehouses.mockResolvedValue([
      { id: 'wh-b', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' },
      { id: 'wh-a', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' },
    ]);
    const rB = await resolveDatabricksSqlWarehouseId();
    expect(rB.id).toBe('wh-a');
    // Replica A: a fresh process that read the doc BEFORE B's binding landed
    // (hideNextRead) and whose list is stale ([wh-b] only).
    __testing.reset();
    h.cosmos.hideNextRead = true;
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-b', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    h.dbx.getWarehouse.mockResolvedValue({ id: 'wh-a', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' });
    const writesBefore = h.cosmos.writes;
    const rA = await resolveDatabricksSqlWarehouseId();
    // Measured before the fix: B=wh-a | A=wh-b | persisted=wh-b (last writer wins).
    expect(rA.id).toBe(rB.id);
    expect(h.cosmos.doc.databricksSqlWarehouse.id).toBe('wh-a');
    expect(h.cosmos.writes).toBe(writesBefore); // adopted, nothing overwritten
    expect(rA.source).toBe('persisted');
    expect(rA.detail).toMatch(/Another Console replica had already bound 'loom-default' \(wh-a\)/);
    expect(h.dbx.getWarehouse).toHaveBeenCalledWith('wh-a'); // verified live before adopting
  });

  it('A-2 control: a stored binding whose warehouse is GONE is overwritten, not adopted', async () => {
    seedBinding('wh-dead');
    h.cosmos.hideNextRead = true; // this replica's (b) read missed it
    h.dbx.getWarehouse.mockRejectedValue(httpErr('getWarehouse', 404, '{"error_code":"RESOURCE_DOES_NOT_EXIST"}'));
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-live', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    const r = await resolveDatabricksSqlWarehouseId();
    // Breaks if adoption skips the live check: 'wh-dead' would be served.
    expect(r.id).toBe('wh-live');
    expect(h.cosmos.doc.databricksSqlWarehouse.id).toBe('wh-live');
  });

  it('nit: a stored binding with NO hostname is ignored, not dereferenced', async () => {
    h.cosmos.doc = {
      id: '__platform__', tenantId: '__platform__',
      databricksSqlWarehouse: { id: 'wh-nohost', name: LOOM_DEFAULT_WAREHOUSE_NAME, source: 'created', boundAt: 'x' },
      _etag: String(++h.cosmos.etag),
    };
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-ok', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    // Breaks (TypeError: Cannot read properties of undefined) if hostname is not validated.
    const r = await resolveDatabricksSqlWarehouseId();
    expect(r.id).toBe('wh-ok');
    expect(h.dbx.getWarehouse).not.toHaveBeenCalledWith('wh-nohost');
  });

  it('A-3: a statement that finds the warehouse GONE invalidates the cache and retries ONCE on a fresh resolution', async () => {
    h.dbx.listWarehouses.mockResolvedValueOnce([{ id: 'wh-1', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    expect((await resolveDatabricksSqlWarehouseId()).id).toBe('wh-1'); // now cached
    // The warehouse is deleted out-of-band.
    h.dbx.getWarehouse.mockRejectedValue(httpErr('getWarehouse', 404, '{"error_code":"RESOURCE_DOES_NOT_EXIST"}'));
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-2', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    const seen: string[] = [];
    const out = await withResolvedWarehouse(async (id) => {
      seen.push(id);
      if (id === 'wh-1') throw new Error('executeStatement submit failed 404: {"error_code":"RESOURCE_DOES_NOT_EXIST","message":"warehouse wh-1 does not exist"}');
      return 'ran';
    });
    // Breaks if the cache is not invalidated: the retry is served 'wh-1' again
    // with 0 GETs (the reviewer's P2) and the call fails twice.
    expect(seen).toEqual(['wh-1', 'wh-2']);
    expect(out).toBe('ran');
    expect(h.dbx.getWarehouse).toHaveBeenCalledWith('wh-1');
  });

  it('A-3 controls: a non-"gone" statement error is NOT retried; an env pin is never second-guessed', async () => {
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-1', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    let calls = 0;
    const sqlErr = await withResolvedWarehouse(async () => { calls++; throw new Error('TABLE_OR_VIEW_NOT_FOUND t'); }).catch((e) => e);
    expect(sqlErr.message).toMatch(/TABLE_OR_VIEW_NOT_FOUND/);
    expect(calls).toBe(1);
    vi.stubEnv(WAREHOUSE_ENV_VAR, 'wh-pinned');
    calls = 0;
    const pinErr = await withResolvedWarehouse(async () => { calls++; throw new Error('executeStatement submit failed 404: gone'); }).catch((e) => e);
    expect(pinErr.message).toMatch(/submit failed 404/);
    expect(calls).toBe(1);
  });

  it('A-3: a bare submit 404 (no RESOURCE_DOES_NOT_EXIST body) is "gone"; a missing TABLE is not', async () => {
    h.dbx.listWarehouses.mockResolvedValue([{ id: 'wh-1', name: LOOM_DEFAULT_WAREHOUSE_NAME, state: 'RUNNING' }]);
    await resolveDatabricksSqlWarehouseId();
    const seen: string[] = [];
    // Breaks if the predicate keys only on `status === 404`: executeStatement
    // throws a plain Error whose only 404 is in the message, so no retry.
    await withResolvedWarehouse(async (id) => {
      seen.push(id);
      if (seen.length === 1) throw new Error('executeStatement submit failed 404: Not Found');
      return 'ok';
    });
    expect(seen).toHaveLength(2);
    // Control: RESOURCE_DOES_NOT_EXIST about a TABLE (no "warehouse") is a SQL
    // error for the caller, not a dead warehouse — no retry.
    let calls = 0;
    const e = await withResolvedWarehouse(async () => { calls++; throw new Error('[RESOURCE_DOES_NOT_EXIST] table main.s.t not found'); }).catch((x) => x);
    expect(e.message).toMatch(/table main\.s\.t/);
    expect(calls).toBe(1);
  });

  it('A-4: SCIM Me with NO groups field does not assert non-membership', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 403, '{"error_code":"PERMISSION_DENIED","message":"no"}'));
    meReturns({ displayName: 'sp' }); // no `groups` key at all (P3)
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.kind).toBe('permission');
    // Breaks if an absent field is mapped to [] and reported as a measured non-membership.
    expect(err.message).not.toMatch(/not in the admins group/);
    expect(err.message).toMatch(/SCIM Me returned no group membership, so whether it is a workspace admin is not established/);
    expect(err.diagnostic).toMatch(/groups not reported/);
  });

  it('A-4 control: an EMPTY groups list is a measured non-membership', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 403, '{"error_code":"PERMISSION_DENIED","message":"no"}'));
    meReturns({ displayName: 'sp', groups: [] });
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.message).toMatch(/it is not in the admins group/);
  });

  it('A-5: a create refused as ALREADY EXISTS with no visible loom-default names the unseen warehouse + CAN_USE', async () => {
    h.dbx.listWarehouses.mockResolvedValue([]); // before AND after the create
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 400, '{"error_code":"RESOURCE_ALREADY_EXISTS","message":"loom-default exists"}'));
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.kind).toBe('unknown');
    // Breaks if the conflicted branch falls to the "returned no warehouse id" text (P4).
    expect(err.message).not.toMatch(/returned no warehouse id/);
    expect(err.message).toMatch(/refused the create because a 'loom-default' SQL warehouse already exists/);
    expect(err.message).toMatch(/no 'loom-default' is visible to the Console identity/);
    expect(err.remediation).toMatch(/CAN_USE/);
  });

  it('round 5 (N2): a Databricks 403 that NAMES the principal is redacted in `message`; the raw quote is admin-only', async () => {
    const APP = '9b1d2c3e-4f50-4a6b-8c7d-0e1f2a3b4c5d';
    const UPN = 'uami-console@contoso.onmicrosoft.com';
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 403,
      `{"error_code":"PERMISSION_DENIED","message":"Service principal ${APP} (${UPN}) does not have permission to create SQL warehouses"}`));
    meReturns({ displayName: 'sp', entitlements: [], groups: [] });
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    expect(err.kind).toBe('permission');
    // Positive half: the rest of Databricks' text is still quoted, so the cause stays readable.
    expect(err.message).toMatch(/does not have permission to create SQL warehouses/);
    expect(err.message).toContain('<id>');
    // Breaks if the quote reaches `message` unredacted: the route body AND the
    // non-admin self-audit detail would both carry the principal.
    expect(err.message).not.toContain(APP);
    expect(err.message).not.toContain(UPN);
    expect(JSON.stringify(warehouseErrorBody(err))).not.toMatch(new RegExp(`${APP}|${UPN.replace('.', '\\.')}`));
    const f = readRuntimeFailure(WAREHOUSE_ENV_VAR)!;
    expect(f.message).not.toContain(APP);
    expect(gateStatus('svc-databricks-sql')!.check.detail).not.toContain(APP);
    // …while the admin-only diagnostic keeps the unredacted response AND the
    // SCIM measurement (breaks if either half is dropped from the join).
    expect(f.diagnostic).toContain(APP);
    expect(f.diagnostic).toContain(UPN);
    expect(f.diagnostic).toMatch(/SCIM Me: identity sp/);
  });

  it('round 5 (N2) control: a quote with no identifier-shaped token is not rewritten and adds no diagnostic', () => {
    const e = classifyWarehouseFailure('list', httpErr('listWarehouses', 403, 'Unauthorized network access to workspace: 1111'));
    // Breaks if redaction rewrites ordinary text (the short workspace number) or always sets a diagnostic.
    expect(e.message).toMatch(/Unauthorized network access to workspace: 1111/);
    expect(e.diagnostic).toBeUndefined();
  });

  it('A-6: warehouseErrorStatus maps EVERY failure kind (authentication 503, unknown 502)', () => {
    const kinds: Record<WarehouseFailureKind, number> = {
      'not-configured': 503, authentication: 503, permission: 403, network: 503, quota: 503, unknown: 502,
    };
    const got = Object.fromEntries(
      (Object.keys(kinds) as WarehouseFailureKind[]).map((k) =>
        [k, warehouseErrorStatus(new WarehouseResolutionError({ kind: k, step: 'list', message: 'm', remediation: 'r' }))]),
    );
    // Breaks on `case 'authentication': return 401` (the reviewer's blind arm)
    // and on dropping the unknown → 502 case (it would read 503).
    expect(got).toEqual(kinds);
  });

  it('B-6: the SCIM identity diagnostic is published SEPARATELY — never in a route body or the evalEnv detail', async () => {
    h.dbx.createWarehouse.mockRejectedValue(httpErr('createWarehouse', 403, '{"error_code":"PERMISSION_DENIED","message":"no"}'));
    meReturns({ displayName: 'loom-console-uami', applicationId: '0000-app', entitlements: [{ value: 'workspace-access' }], groups: [{ display: 'users' }] });
    const err = await resolveDatabricksSqlWarehouseId().catch((e) => e);
    const body = warehouseErrorBody(err);
    // Positive half: the classified cause + remediation still reach every caller.
    expect(body).toMatchObject({ kind: 'permission', entitlement: 'allow-cluster-create' });
    expect(body.remediation).toMatch(/cannot grant this to itself/);
    // Breaks if the identity detail leaks into the route body (message or a field).
    expect(JSON.stringify(body)).not.toMatch(/0000-app|loom-console-uami|workspace-access/);
    // Round 4: the published `message` — which evalEnv turns into the check
    // detail that NON-admin readers get (GET /api/admin/self-audit, the Copilot
    // self-audit tool) — carries none of it. Breaks if the resolver joins the
    // diagnostic into the published message again (the round-3 leak).
    const f = readRuntimeFailure(WAREHOUSE_ENV_VAR)!;
    expect(f.message).not.toMatch(/0000-app|loom-console-uami/);
    expect(gateStatus('svc-databricks-sql')!.check.detail).not.toMatch(/0000-app|loom-console-uami/);
    expect(gateStatus('svc-databricks-sql')!.check.detail).toMatch(/failed \(permission\)/);
    // …while the separate field, read only by admin routes, still has it.
    // Breaks if the diagnostic is dropped entirely.
    expect(f.diagnostic).toMatch(/loom-console-uami \(application 0000-app\)/);
    expect(gateAdminDiagnostic('svc-databricks-sql')).toBe(f.diagnostic);
  });
});
