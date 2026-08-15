/**
 * Authorization contract tests for GET /api/items/copy-job/[id]/runs.
 *
 * WHY THIS FILE EXISTS.
 *   The route took `[id]` from the URL, built the ADF pipeline name from it, and
 *   queried the shared factory — with no item lookup at all, so read access to a
 *   job's run history was not scoped to the workspace that owns the job. Its two
 *   siblings ([id]/run POST, [id]/watermark GET) both resolve the item first.
 *   It passed CI because it sat in check-route-guards' SHARED_BACKEND_ITEM_ROUTES
 *   under the premise "per-item-TYPE route over a shared backend, no per-tenant
 *   Cosmos ownership to scope" — false on both halves for an ID-addressed route
 *   whose siblings scope it.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED.
 *   `withWorkspaceOwner` runs for real; only `getSession` and `loadOwnedItem` are
 *   stubbed. Mocking the wrapper would leave a suite that passes with the wrapper
 *   deleted, which is the exact failure this route already had.
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

const listPipelineRuns = vi.fn();
vi.mock('@/lib/azure/adf-client', () => ({
  listPipelineRuns: (...a: any[]) => listPipelineRuns(...a),
}));

import { GET } from '../route';

const req = {} as any;
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) }) as any;

const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1' } };
const ITEM = { id: 'cj-1', workspaceId: 'ws-1', itemType: 'copy-job', state: {} };

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(SESSION);
  loadOwnedItem.mockResolvedValue(ITEM);
  listPipelineRuns.mockResolvedValue([]);
});

describe('runs GET — authentication', () => {
  it('401s with no session, and never reaches the item lookup or the factory', async () => {
    getSession.mockReturnValue(null);
    const res = await GET(req, ctxFor('cj-1'));
    expect(res.status).toBe(401);
    expect(loadOwnedItem).not.toHaveBeenCalled();
    expect(listPipelineRuns).not.toHaveBeenCalled();
  });
});

describe('runs GET — authorization (the defect this route had)', () => {
  it('404s a NON-OWNER and never queries the factory for that job', async () => {
    // Before the fix this returned 200 with the job's real run history to any
    // signed-in caller who named the id.
    loadOwnedItem.mockResolvedValue(null);
    const res = await GET(req, ctxFor('someone-elses-job'));
    expect(res.status).toBe(404);
    expect(listPipelineRuns).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the caller and the copy-job type', async () => {
    await GET(req, ctxFor('cj-1'));
    expect(loadOwnedItem).toHaveBeenCalledWith(
      'cj-1',
      'copy-job',
      'oid-1',
      expect.objectContaining({ allowReadRoles: true }),
    );
  });

  it('lets an owner with shared READ roles through to the run history', async () => {
    listPipelineRuns.mockResolvedValue([{ runId: 'r1', status: 'Succeeded' }]);
    const res = await GET(req, ctxFor('cj-1'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      pipelineName: 'loom-copy-cj-1',
      runs: [{ runId: 'r1', status: 'Succeeded' }],
    });
  });

  it('threads the caller session so the cross-tenant tid boundary runs from claims (#2703)', async () => {
    await GET(req, ctxFor('cj-1'));
    expect(loadOwnedItem.mock.calls[0][3].session).toBe(SESSION);
  });
});

describe('runs GET — pipeline naming', () => {
  it('names the pipeline from the RAW route id, not the resolved item id', async () => {
    // A bundle-installed job is addressed as `loom:<cosmosId>`; loadOwnedItem
    // resolves that prefix for the OWNERSHIP lookup, but [id]/run materialises
    // the pipeline as `loom-copy-${rawId}`. Naming this query from `item.id`
    // would silently list zero runs for every bundle-installed job.
    loadOwnedItem.mockResolvedValue({ ...ITEM, id: 'cj-1' });
    await GET(req, ctxFor('loom:cj-1'));
    expect(listPipelineRuns).toHaveBeenCalledWith('loom-copy-loom:cj-1');
  });
});

describe('runs GET — failures are honest', () => {
  it('surfaces an ADF failure as 502 rather than an empty list', async () => {
    listPipelineRuns.mockRejectedValue(new Error('factory not found'));
    const res = await GET(req, ctxFor('cj-1'));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: 'factory not found' });
  });
});
