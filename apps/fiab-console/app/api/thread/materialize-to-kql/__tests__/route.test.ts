/**
 * BFF route test for POST /api/thread/materialize-to-kql — the Weave
 * "Materialize to KQL (ADX)" edge. Mocks the session, item loads, lakehouse
 * abfss resolver, and the kusto-client external-table commands.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a) }));

const recordThreadEdgeMock = vi.fn(async () => {});
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: (...a: any[]) => recordThreadEdgeMock(...a) }));

const resolveLakehouseAbfssMock = vi.fn(async () => ({
  abfss: 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/sales', container: 'bronze', root: 'lakehouses/sales',
}));
// `resolveLakehouseStorage` delegates to the mock: a bound value is ok, null is
// `no-storage`, `{ withheld: <reason> }` is that reason. Real withheld wording.
vi.mock('@/lib/azure/lakehouse-abfss', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
  return {
    lakehouseStorageWithheldFields: actual.lakehouseStorageWithheldFields,
    resolveLakehouseStorage: async (...a: any[]) => {
      const b: any = await resolveLakehouseAbfssMock(...a);
      if (b && typeof b === 'object' && 'withheld' in b) return { ok: false, reason: b.withheld };
      return b ? { ok: true, bound: b } : { ok: false, reason: 'no-storage' };
    },
  };
});

const createExternalDeltaTableMock = vi.fn(async () => ({ columns: [], rows: [] }));
const setQueryAccelerationPolicyMock = vi.fn(async () => ({ columns: [], rows: [] }));
const kustoConfigGateMock = vi.fn(() => null);
vi.mock('@/lib/azure/kusto-client', () => {
  class KustoError extends Error {
    status?: number;
    constructor(m: string, status?: number) { super(m); this.name = 'KustoError'; this.status = status; }
  }
  return {
    createExternalDeltaTable: (...a: any[]) => createExternalDeltaTableMock(...a),
    setQueryAccelerationPolicy: (...a: any[]) => setQueryAccelerationPolicyMock(...a),
    kustoConfigGate: () => kustoConfigGateMock(),
    defaultDatabase: () => 'loomdb',
    KustoError,
  };
});
import { KustoError } from '@/lib/azure/kusto-client';
import { POST } from '../route';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/thread/materialize-to-kql', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const FROM = { id: 'lh-1', type: 'lakehouse', name: 'Sales LH' };
const VALUES = { table: 'orders|bronze/Tables/orders', kqlDatabaseId: 'kql-1', accelerate: true };

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  kustoConfigGateMock.mockReturnValue(null);
  resolveLakehouseAbfssMock.mockResolvedValue({ abfss: 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/sales', container: 'bronze', root: 'lakehouses/sales' } as any);
  createExternalDeltaTableMock.mockResolvedValue({ columns: [], rows: [] } as any);
  setQueryAccelerationPolicyMock.mockResolvedValue({ columns: [], rows: [] } as any);
  loadOwnedItemMock.mockImplementation(async (id: string, type: string) => {
    if (type === 'lakehouse') return { id: 'lh-1', displayName: 'Sales LH', workspaceId: 'ws-1' };
    if (type === 'kql-database') return { id: 'kql-1', itemType: 'kql-database', displayName: 'Telemetry', workspaceId: 'ws-1', state: {} };
    return null;
  });
  [createExternalDeltaTableMock, setQueryAccelerationPolicyMock, recordThreadEdgeMock].forEach((m) => m.mockClear());
});

describe('materialize-to-kql route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(401);
  });

  it('503 honest gate when ADX is not configured', async () => {
    kustoConfigGateMock.mockReturnValueOnce({ missing: 'LOOM_KUSTO_CLUSTER_URI' });
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.gate.missing).toBe('LOOM_KUSTO_CLUSTER_URI');
  });

  it('creates the ADX external table + acceleration, records lineage', async () => {
    const res = await POST(post({ from: FROM, values: VALUES }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.database).toBe('Telemetry');
    expect(j.accelerated).toBe(true);
    // Delta external table bound to the resolved abfss Tables/<name> path.
    expect(createExternalDeltaTableMock).toHaveBeenCalledWith(
      'Telemetry', expect.any(String), 'abfss://bronze@acct.dfs.core.windows.net/lakehouses/sales/Tables/orders', expect.any(Object),
    );
    expect(setQueryAccelerationPolicyMock).toHaveBeenCalled();
    expect(recordThreadEdgeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'materialize-to-kql', toType: 'kql-database' }));
  });

  it('skips acceleration when accelerate:false', async () => {
    const res = await POST(post({ from: FROM, values: { ...VALUES, accelerate: false } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.accelerated).toBe(false);
    expect(setQueryAccelerationPolicyMock).not.toHaveBeenCalled();
  });

  it('surfaces a KustoError status (401/403 → AllDatabasesAdmin hint)', async () => {
    createExternalDeltaTableMock.mockRejectedValueOnce(new KustoError('Forbidden', 403));
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toMatch(/AllDatabasesAdmin/);
  });

  it('non-fatal acceleration failure still succeeds with a note', async () => {
    setQueryAccelerationPolicyMock.mockRejectedValueOnce(new Error('policy denied'));
    const res = await POST(post({ from: FROM, values: VALUES }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.accelerated).toBe(false);
    expect(j.message).toMatch(/query acceleration could not be enabled/);
  });

  // A withheld location is not "no storage configured". FAILS IF the route
  // words root-shared as the LOOM_*_URL gate (503), loses the readiness check
  // title the resolver names, or loses the link. No ADX table is created.
  it('a shared storage root answers the true reason and the readiness link', async () => {
    const { LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE } = await import('@/lib/admin/env-checks/lakehouse-shared-roots');
    resolveLakehouseAbfssMock.mockResolvedValueOnce({ withheld: 'root-shared' } as any);
    const res = await POST(post({ from: FROM, values: VALUES }));
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.error).not.toContain('LOOM_');
    expect(j.error).toContain(LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE);
    expect(j.fixHref).toBe('/admin/readiness');
    expect(createExternalDeltaTableMock).not.toHaveBeenCalled();
  });
});

/**
 * The table name becomes the `Tables/<name>` segment of the ADX storage
 * location, so it must be ONE path segment. Each refusal case asserts 400, the
 * message of the rule it trips, and that nothing downstream ran: no item load
 * (Cosmos), no lakehouse-root resolution (storage binding), no ADX command.
 *
 * What breaks these (mutation arms run in a sandbox, see the PR body):
 *  - deleting the `tableNameProblem` call → every refusal case reaches
 *    `createExternalDeltaTable` and returns 200 (status 200 ≠ 400);
 *  - moving the check below `resolveLakehouseStorage` → the status still reads
 *    400 but the storage resolver (backed by `resolveLakehouseAbfssMock`) has
 *    been called, so the `not.toHaveBeenCalled()` line fails;
 *  - dropping the control-character rule → 'a\nb' and 'a\u007fb' become one
 *    segment and are accepted (200); 'a\u0000b' is still refused by
 *    `pathSegments` but with the segment message, so its message assertion
 *    fails (that row pins the MESSAGE, not the status);
 *  - not calling `pathSegments` (treating the name as one segment) → '.',
 *    '..', '../x', 'a/b', 'a\\b' and 'orders/' are accepted;
 *  - dropping the `segs[0] !== name` comparison → 'a/b', 'a\\b' and
 *    'orders/' are accepted ('.', '..' and '../x' are still refused inside
 *    `pathSegments`, which is why those rows exist separately);
 *  - dropping any one character from the `;?#%@` rule → that character's row
 *    ('orders;x', 'orders?x', 'orders#x', 'a%2Fb', 'orders@x') is accepted.
 */
describe('materialize-to-kql table-name validation', () => {
  const SEGMENT_MSG = /single folder name under Tables\//;
  const META_MSG = /";", "\?", "#", "%" and "@" are not accepted/;
  const cases: Array<[label: string, table: string, msg: RegExp]> = [
    ['parent reference', '../x|bronze/Tables/x', SEGMENT_MSG],
    ['bare parent', '..|bronze/Tables/x', SEGMENT_MSG],
    ['forward slash', 'a/b|bronze/Tables/a/b', SEGMENT_MSG],
    ['backslash', 'a\\b|bronze/Tables/a', SEGMENT_MSG],
    ['trailing slash', 'orders/|bronze/Tables/orders', SEGMENT_MSG],
    ['single dot', '.|bronze/Tables', SEGMENT_MSG],
    ['empty name', '|bronze/Tables/orders', /table name is empty/],
    ['whitespace-only name', '   |bronze/Tables/orders', /table name is empty/],
    ['embedded newline', 'a\nb|bronze/Tables/a', /control character/],
    ['embedded DEL (0x7F)', 'a\u007fb|bronze/Tables/a', /control character/],
    ['embedded NUL', 'a\u0000b|bronze/Tables/a', /control character/],
    ['connection-string separator', 'orders;x|bronze/Tables/orders', META_MSG],
    ['query marker', 'orders?x|bronze/Tables/orders', META_MSG],
    ['fragment marker', 'orders#x|bronze/Tables/orders', META_MSG],
    ['percent escape', 'a%2Fb|bronze/Tables/a', META_MSG],
    ['user-part separator', 'orders@x|bronze/Tables/orders', META_MSG],
  ];

  it.each(cases)('refuses %s with 400 before any Cosmos / storage / ADX call', async (_label, table, msg) => {
    loadOwnedItemMock.mockClear();
    resolveLakehouseAbfssMock.mockClear();
    const res = await POST(post({ from: FROM, values: { ...VALUES, table } }));
    expect(res.status, `table=${JSON.stringify(table)}`).toBe(400);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(msg);
    expect(loadOwnedItemMock).not.toHaveBeenCalled();
    expect(resolveLakehouseAbfssMock).not.toHaveBeenCalled();
    expect(createExternalDeltaTableMock).not.toHaveBeenCalled();
    expect(setQueryAccelerationPolicyMock).not.toHaveBeenCalled();
  });

  // POSITIVE CONTROLS — pair every refusal above with the thing still working.
  // Breaks if the validator over-refuses (status ≠ 200) or if the name is
  // rewritten instead of refused (e.g. swapping in a `[A-Za-z0-9_]`
  // sanitizer turns 'sales-2024 v2' into 'sales_2024_v2', so the exact URI
  // assertion fails).
  it.each([
    ['orders', 'orders'],
    ['sales-2024 v2', 'sales-2024 v2'],
    ['  orders  ', 'orders'], // surrounding whitespace is trimmed, as before
  ])('accepts %j and binds <root>/Tables/%s', async (name, expected) => {
    const res = await POST(post({ from: FROM, values: { ...VALUES, table: `${name}|bronze/Tables/${name}` } }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(createExternalDeltaTableMock).toHaveBeenCalledTimes(1);
    expect(createExternalDeltaTableMock.mock.calls[0][2]).toBe(
      `abfss://bronze@acct.dfs.core.windows.net/lakehouses/sales/Tables/${expected}`,
    );
  });

  // The ADX identifier side: the external table name is derived through
  // `adxIdent`, so an accepted name with a space/hyphen still yields a plain
  // `[A-Za-z0-9_]` identifier. Breaks if the raw name is passed as `extName`.
  it('derives an [A-Za-z0-9_] external-table name from an accepted name', async () => {
    await POST(post({ from: FROM, values: { ...VALUES, table: 'sales-2024 v2|x' } }));
    const extName = createExternalDeltaTableMock.mock.calls[0][1] as string;
    expect(extName).toBe('Sales_LH_sales_2024_v2');
    expect(extName).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

/**
 * The target database is WRITTEN (external table + policy), the source
 * lakehouse only read. `loadOwnedItem` admits a read-only member only when
 * called with `{ allowReadRoles: true }`, so the mock below models that: a
 * reader of the target sees it on the read-scoped load and gets null on the
 * write-scoped one.
 *
 * What breaks these (sandbox arms, see the PR body):
 *  - loading the target with `allowReadRoles: true` (the previous behaviour)
 *    → the reader is admitted and reaches ADX (200 ≠ 403), and the writer
 *    test counts zero write-scoped loads;
 *  - running the write check after `resolveLakehouseStorage` → still 403, but
 *    the storage resolver has been called (the `not.toHaveBeenCalled` line);
 *  - write-loading a fixed 'kql-database' type → the eventhouse writer gets
 *    null from the write load and a 403 (≠ 200);
 *  - dropping the read-scoped visibility load → an invisible target reads 403
 *    instead of 404, and the writer test counts two write-scoped loads.
 */
describe('materialize-to-kql target-database access', () => {
  type Role = 'writer' | 'reader' | 'none';
  function access(target: Role, targetType: 'kql-database' | 'eventhouse' = 'kql-database') {
    loadOwnedItemMock.mockReset();
    loadOwnedItemMock.mockImplementation(async (_id: string, type: string, _oid: string, opts?: { allowReadRoles?: boolean }) => {
      // Source lakehouse: the caller is a reader of it in every case here.
      if (type === 'lakehouse') return opts?.allowReadRoles ? { id: 'lh-1', displayName: 'Sales LH', workspaceId: 'ws-1' } : null;
      if (type !== targetType) return null;
      const item = { id: 'kql-1', itemType: targetType, displayName: 'Telemetry', workspaceId: 'ws-2', state: {} };
      if (target === 'writer') return item;
      if (target === 'reader') return opts?.allowReadRoles ? item : null;
      return null;
    });
    resolveLakehouseAbfssMock.mockClear();
  }

  it('403 for a read-only member of the target, before any storage or ADX call', async () => {
    access('reader');
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toBe('materializing requires write access to the target database');
    expect(resolveLakehouseAbfssMock).not.toHaveBeenCalled();
    expect(createExternalDeltaTableMock).not.toHaveBeenCalled();
    expect(setQueryAccelerationPolicyMock).not.toHaveBeenCalled();
  });

  it('a writer of the target (reader of the source) materializes, via a write-scoped load', async () => {
    access('writer');
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(createExternalDeltaTableMock).toHaveBeenCalledTimes(1);
    // The target was loaded once WITHOUT read roles (the write-scoped check).
    const writeLoads = loadOwnedItemMock.mock.calls.filter(
      (c) => c[1] === 'kql-database' && !(c[3] && c[3].allowReadRoles),
    );
    expect(writeLoads).toHaveLength(1);
  });

  it('an eventhouse target is write-checked as an eventhouse', async () => {
    access('writer', 'eventhouse');
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(200);
    expect((await res.json()).linkLabel).toBe('Open the Eventhouse');
  });

  it('404 when the caller cannot see the target at all', async () => {
    access('none');
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('KQL database not found');
    expect(createExternalDeltaTableMock).not.toHaveBeenCalled();
  });
});
