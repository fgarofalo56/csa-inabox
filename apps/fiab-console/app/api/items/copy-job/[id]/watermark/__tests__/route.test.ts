/**
 * Authorization + honest-gate contract tests for
 * GET /api/items/copy-job/[id]/watermark.
 *
 * WHY THIS FILE EXISTS.
 *   The route was migrated off a hand-rolled `getSession()` prologue onto
 *   `withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true })` (route-toolkit R3),
 *   and NOTHING pinned its 401 / 404 / read-role behaviour — `check-route-guards`
 *   watches that an id-addressed route IS authorized, not WHICH roles it admits,
 *   and it stays green either way (measured). On #3499 six 401 guards were
 *   rewritten with nothing watching them; these tests are that lesson applied.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED.
 *   `withWorkspaceOwner` itself runs for real. Only its two leaves are stubbed —
 *   `getSession` and `loadOwnedItem` — so the assertions below exercise the
 *   actual wrapper (401-before-lookup ordering, 404-not-403, and the options it
 *   forwards). Mocking the toolkit would leave a suite that models the code
 *   instead of running it, and would pass even if the wrapper were deleted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSession() }));

const loadOwnedItem = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', async () => {
  const respond = await vi.importActual<any>('@/lib/api/respond');
  return {
    loadOwnedItem: (...a: any[]) => loadOwnedItem(...a),
    jerr: (error: string, status = 500) => respond.apiError(error, status),
  };
});

const executeParameterized = vi.fn();
vi.mock('@/lib/azure/azure-sql-client', () => ({
  executeParameterized: (...a: any[]) => executeParameterized(...a),
}));

import { GET } from '../route';

const ctx = { params: Promise.resolve({ id: 'cj-1' }) } as any;
const req = {} as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
const ITEM = {
  id: 'cj-1',
  workspaceId: 'ws-1',
  itemType: 'copy-job',
  state: { sourceName: 'contoso', source: { sourceTable: 'dbo.orders' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(SESSION);
  loadOwnedItem.mockResolvedValue(ITEM);
  executeParameterized.mockResolvedValue([]);
  process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER = 'sql-loom-control';
  delete process.env.LOOM_COPYJOB_CONTROL_SQL_DB;
});

describe('watermark GET — authentication', () => {
  it('401s when there is no session, and never reaches the item lookup', async () => {
    getSession.mockReturnValue(null);
    const res = await GET(req, ctx);
    expect(res.status).toBe(401);
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });
});

describe('watermark GET — authorization', () => {
  it('404s (not 403) when the caller cannot reach the item, so an id cannot be probed', async () => {
    loadOwnedItem.mockResolvedValue(null);
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    expect(executeParameterized).not.toHaveBeenCalled();
  });

  it('admits shared READ roles — the regression this migration fixed', async () => {
    // The hand-rolled prologue called loadOwnedItem with NO options, and that
    // helper is write-scoped by default, so a Viewer/Contributor with real read
    // access to the workspace got a 404 on this panel while the rest of the
    // editor loaded. Assert the option is actually forwarded; the wrapper is
    // real, so this fails if the flag is dropped.
    await GET(req, ctx);
    expect(loadOwnedItem).toHaveBeenCalledWith(
      'cj-1',
      'copy-job',
      'oid-1',
      expect.objectContaining({ allowReadRoles: true }),
    );
  });

  it('threads the caller session so the cross-tenant tid boundary runs from claims (#2703)', async () => {
    await GET(req, ctx);
    const opts = loadOwnedItem.mock.calls[0][3];
    expect(opts.session).toBe(SESSION);
  });

  it('authorizes BEFORE disclosing deployment config — an unreachable item never sees the gate', async () => {
    // The pre-migration order returned the honest gate first, so any signed-in
    // caller could name any id and learn the env var + bicep module path.
    delete process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER;
    loadOwnedItem.mockResolvedValue(null);
    const res = await GET(req, ctx);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.not.toHaveProperty('missing');
  });
});

describe('watermark GET — honest config gate', () => {
  it('reports configured:false with the exact env var + bicep module when unset', async () => {
    delete process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER;
    const res = await GET(req, ctx);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      configured: false,
      missing: 'LOOM_COPYJOB_CONTROL_SQL_SERVER',
      module: 'platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep',
    });
    expect(executeParameterized).not.toHaveBeenCalled();
  });

  it('reports configured:true with a null watermark when the job has no source yet', async () => {
    loadOwnedItem.mockResolvedValue({ ...ITEM, state: {} });
    const res = await GET(req, ctx);
    await expect(res.json()).resolves.toEqual({ ok: true, configured: true, watermark: null });
    expect(executeParameterized).not.toHaveBeenCalled();
  });
});

describe('watermark GET — the read itself', () => {
  it('binds source + table as parameters (never interpolated) and defaults the control DB', async () => {
    executeParameterized.mockResolvedValue([
      { source: 'contoso', table_name: 'dbo.orders', last_value: '42', updated_utc: '2026-08-15T00:00:00Z' },
    ]);
    const res = await GET(req, ctx);
    const [server, database, sqlText, params] = executeParameterized.mock.calls[0];
    expect(server).toBe('sql-loom-control');
    expect(database).toBe('loom-control');
    expect(params).toEqual(['contoso', 'dbo.orders']);
    // The values reach the statement only as @p0/@p1 markers.
    expect(sqlText).toContain('WHERE source = @p0 AND table_name = @p1');
    expect(sqlText).not.toContain('contoso');
    await expect(res.json()).resolves.toEqual({
      ok: true,
      configured: true,
      watermark: { source: 'contoso', table_name: 'dbo.orders', last_value: '42', updated_utc: '2026-08-15T00:00:00Z' },
    });
  });

  it('returns null (not an error) when the control table has no row yet', async () => {
    executeParameterized.mockResolvedValue([]);
    await expect((await GET(req, ctx)).json()).resolves.toEqual({ ok: true, configured: true, watermark: null });
  });

  it('surfaces a TDS failure as 502 rather than a 200 with empty data', async () => {
    executeParameterized.mockRejectedValue(new Error('Login failed for user'));
    const res = await GET(req, ctx);
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: 'Login failed for user' });
  });
});
