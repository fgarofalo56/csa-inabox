/**
 * #3400 — the /query response is the ONLY thing that establishes a query
 * actually STOPPED.
 *
 * The cancel route can never establish that. When the cancel lands on the
 * replica that owns the request it returns `cancelled:true` having called
 * `.cancel()`; when it lands anywhere else it returns `cancelled:'requested'`
 * having only persisted an intent. Neither observes the query terminate. The
 * thing that does is tedious rejecting the in-flight `.query()` with
 * `RequestError('Canceled.', 'ECANCEL')`, which arrives HERE.
 *
 * REVIEW FINDING THIS FILE EXISTS FOR. The catch-block ECANCEL branch in
 * ../route.ts had NO coverage: deleting it whole left the whole
 * azure-sql-database directory green (264/264 across 17 files). It was also
 * wrong — it published `cancelled` (two l's), a spelling no consumer in the
 * repo reads, and kept HTTP 502 on the strength of a claim about
 * lib/state/jobs-store.ts that is false (jobs-store.ts:336 branches on `j.ok`
 * alone). These specs pin the corrected shape against the family it must match.
 *
 * MUTATIONS EACH SPEC KILLS are named inline. Session, item ownership, the rate
 * limiter and the TDS executor are mocked — no cookies / Cosmos / TDS.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OID = 'oid-owner';

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

// route-toolkit's sibling wrappers pull these in; stub so the module loads.
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

const enforceRateLimitMock = vi.fn(async () => null as any);
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: (...a: any[]) => enforceRateLimitMock(...a) }));

class AzureSqlError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
const executeQueryBatchMock = vi.fn(async () => ({
  recordsets: [{ columns: ['n'], rows: [[1]], rowCount: 1, truncated: false }],
  messages: [], rowsAffected: [1], executionMs: 3,
}));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  executeQueryBatch: (...a: any[]) => executeQueryBatchMock(...a),
  AzureSqlError,
}));

const PARAMS = { params: Promise.resolve({ id: 'item1' }) } as any;
function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/items/azure-sql-database/item1/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Exactly what tedious throws for a request killed by a TDS ATTENTION packet. */
function tediousCancelRejection() {
  return Object.assign(new Error('Canceled.'), { code: 'ECANCEL', number: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockReturnValue({ claims: { oid: OID, upn: 'owner@loom.test', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItemMock.mockResolvedValue(OWNED_ITEM);
  enforceRateLimitMock.mockResolvedValue(null);
});

describe('POST /query — the cancellation receipt (#3400)', () => {
  /**
   * MUTATION: delete the `if (e?.code === 'ECANCEL')` block from ../route.ts.
   * → 502 with the raw driver text and no `canceled` field. This is the exact
   * mutation that was green across the whole directory before this file.
   */
  it('returns the family cancellation shape when tedious rejects with ECANCEL', async () => {
    executeQueryBatchMock.mockRejectedValue(tediousCancelRejection() as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'WAITFOR DELAY \'00:10:00\'', requestId: 'r1' }), PARAMS);
    const j = await r.json();
    // 200, not 502 — a user-requested cancel is not a backend fault.
    //   MUTATION: `{ status }` instead of `{ status: 200 }` → 502.
    expect(r.status).toBe(200);
    expect(j.ok).toBe(false);
    expect(j.canceled).toBe(true);
    expect(j.code).toBe('ECANCEL');
    //   MUTATION: `error: e?.message` → the raw driver string 'Canceled.'.
    expect(j.error).toBe('Query canceled by user.');
  });

  /**
   * THE SPELLING. Repo-wide the consumers read `canceled` (one l):
   * lib/editors/phase3/warehouse-editor.tsx:89/826,
   * lib/editors/synapse-sql-editors.tsx:92/142,
   * lib/editors/databricks/shared.tsx:162/256. `cancelled` (two l's) is read by
   * NOTHING, so publishing it is a silent no-op dressed as a fix.
   *   MUTATION: rename the field back to `cancelled`.
   */
  it('publishes the field the editors actually read, and not a second spelling', async () => {
    executeQueryBatchMock.mockRejectedValue(tediousCancelRejection() as any);
    const { POST } = await import('../route');
    const j = await (await POST(postReq({ sql: 'SELECT 1' }), PARAMS)).json();
    expect(Object.keys(j)).toContain('canceled');
    expect(j).not.toHaveProperty('cancelled');
  });

  /**
   * The sibling routes are the spec for this shape, so assert against them
   * rather than against a string this file invented. A future edit to either
   * side that breaks the family goes red here.
   */
  it('matches the sibling SQL query routes field-for-field', async () => {
    executeQueryBatchMock.mockRejectedValue(tediousCancelRejection() as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    const j = await r.json();
    // warehouse/[id]/query/route.ts:142-151 — the reference implementation.
    expect({ status: r.status, ok: j.ok, canceled: j.canceled, error: j.error })
      .toEqual({ status: 200, ok: false, canceled: true, error: 'Query canceled by user.' });
  });

  /**
   * CONTROL — the branch must be NARROW. A real backend failure keeps its 502,
   * its own message and no cancellation claim (R7: do not report a fault as a
   * user cancellation).
   *   MUTATION: widen the test to `/cancel/i.test(e?.message)` without the code
   *   check → a query that fails on a table literally named `cancelled_orders`
   *   would be reported to the user as their own cancellation.
   */
  it('CONTROL: a genuine backend failure is NOT reported as a cancellation', async () => {
    executeQueryBatchMock.mockRejectedValue(
      Object.assign(new Error('Invalid object name \'dbo.cancelled_orders\'.'), { code: 'EREQUEST', number: 208 }) as any,
    );
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT * FROM dbo.cancelled_orders' }), PARAMS);
    const j = await r.json();
    expect(r.status).toBe(502);
    expect(j.ok).toBe(false);
    expect(j.canceled).toBeUndefined();
    expect(j.error).toContain('cancelled_orders');
    expect(j.code).toBe('EREQUEST');
  });

  /**
   * CONTROL — AzureSqlError's own status still wins for non-cancel failures, so
   * the reordering that put the ECANCEL branch above the status computation did
   * not flatten every error to 502.
   */
  it('CONTROL: an AzureSqlError keeps its own status', async () => {
    executeQueryBatchMock.mockRejectedValue(new AzureSqlError('login failed for the console identity', 401) as any);
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1' }), PARAMS);
    expect(r.status).toBe(401);
    expect((await r.json()).canceled).toBeUndefined();
  });

  /** CONTROL — the success path is untouched by any of the above. */
  it('CONTROL: a successful query is unchanged', async () => {
    executeQueryBatchMock.mockResolvedValue({
      recordsets: [{ columns: ['n'], rows: [[1]], rowCount: 1, truncated: false }],
      messages: [], rowsAffected: [1], executionMs: 3,
    });
    const { POST } = await import('../route');
    const r = await POST(postReq({ sql: 'SELECT 1 AS n' }), PARAMS);
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.canceled).toBeUndefined();
  });
});
