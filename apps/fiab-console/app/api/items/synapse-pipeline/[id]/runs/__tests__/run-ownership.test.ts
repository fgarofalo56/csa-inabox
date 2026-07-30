/**
 * ROUND-3 ROUTE SPEC — the S2 CLASS, not the S2 instance.
 *
 * The LU-8 remediation added `getPipelineRun` ownership to ONE route
 * (`data-pipeline/[id]/output`) and left the two routes with the identical
 * shape untouched: this one and `adf-pipeline/[id]/runs`. Both take `?runId=`
 * off the query string and hand it straight to `listActivityRuns`, which
 * returns every activity's `input`/`output` — the source/sink connection
 * details and storage paths of a run in someone else's pipeline. Synapse run
 * ids are workspace-scoped and ADF's are factory-scoped, so "authenticated
 * owner of SOME pipeline item" was the only bar.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = {
  runs: {} as Record<string, any>,
  boundPipeline: 'my_pipeline',
  armError: null as Error | null,
};

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'oid-1', upn: 'u@loom.test' } }),
}));
vi.mock('@/lib/api/route-toolkit', () => ({
  withSession: (fn: any) => (req: any, ctx: any) =>
    fn(req, { session: { claims: { oid: 'oid-1', upn: 'u@loom.test' } }, params: ctx?.params ?? {} }),
}));

const ACTIVITIES = [
  {
    activityRunId: 'a1', activityName: 'Copy', activityType: 'Copy', status: 'Succeeded',
    input: { source: { type: 'AzureSqlSource', sqlReaderQuery: 'SELECT * FROM payroll' } },
    output: { rowsCopied: 12000000 },
  },
];

const syn = vi.hoisted(() => ({
  queryPipelineRuns: vi.fn(async () => ({ value: [] })),
  listActivityRuns: vi.fn(async () => ACTIVITIES),
  getPipelineRunOrNull: vi.fn(async (id: string) => {
    if (state.armError) throw state.armError;
    return state.runs[id] ?? null;
  }),
}));
vi.mock('@/lib/azure/synapse-dev-client', () => syn);

const E = vi.hoisted(() => ({
  UnboundPipelineError: class UnboundPipelineError extends Error {},
  ItemNotFoundError: class ItemNotFoundError extends Error {},
}));
const UnboundPipelineError = E.UnboundPipelineError;
vi.mock('@/lib/azure/pipeline-binding', () => ({
  resolveBinding: vi.fn(async () => ({ pipelineName: state.boundPipeline })),
  UnboundPipelineError: E.UnboundPipelineError,
  ItemNotFoundError: E.ItemNotFoundError,
}));

import { GET } from '../route';

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/items/synapse-pipeline/guid-1/runs?${qs}`);
}
const CTX = { params: { id: 'guid-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  state.boundPipeline = 'my_pipeline';
  state.armError = null;
  state.runs = {
    'run-mine': { runId: 'run-mine', pipelineName: 'my_pipeline', status: 'Succeeded' },
    'run-theirs': { runId: 'run-theirs', pipelineName: 'payroll_pipeline', status: 'Succeeded' },
  };
  syn.listActivityRuns.mockResolvedValue(ACTIVITIES as any);
  syn.getPipelineRunOrNull.mockImplementation(async (id: string) => {
    if (state.armError) throw state.armError;
    return state.runs[id] ?? null;
  });
});

describe('synapse-pipeline runs: `?runId=` ownership', () => {
  // MUTATION: delete the
  //   const run = await getPipelineRunOrNull(runId);
  //   if (!run || run.pipelineName !== pipelineName) return 404;
  // block (i.e. restore the shipped-on-main shape).
  // → observed: 3 failures — the route 200s with `sqlReaderQuery: 'SELECT *
  //   FROM payroll'` and `rowsCopied: 12000000` from another pipeline's run.
  it('404s a run bound to a different pipeline', async () => {
    const r = await GET(req('runId=run-theirs'), CTX as any);
    expect(r.status).toBe(404);
  });

  it('never reads the foreign run\'s activity payloads', async () => {
    await GET(req('runId=run-theirs'), CTX as any);
    expect(syn.listActivityRuns).not.toHaveBeenCalled();
  });

  it('404s an entirely unknown run id', async () => {
    const r = await GET(req('runId=run-does-not-exist'), CTX as any);
    expect(r.status).toBe(404);
    expect(syn.listActivityRuns).not.toHaveBeenCalled();
  });

  it('still serves the caller\'s OWN run', async () => {
    const r = await GET(req('runId=run-mine'), CTX as any);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.activities).toHaveLength(1);
    expect(j.boundTo).toBe('my_pipeline');
  });

  // MUTATION: use `getPipelineRun` (which throws on any non-2xx) instead of
  // `getPipelineRunOrNull`, or wrap it in `.catch(() => null)`.
  // → observed with the `.catch` shape: 1 failure — a throttled read reports
  //   404 'run not found' for a run the caller owns.
  it('a transient Synapse failure is a 502, not "run not found"', async () => {
    state.armError = new Error('getPipelineRun failed 429: throttled');
    const r = await GET(req('runId=run-mine'), CTX as any);
    expect(r.status).toBe(502);
  });

  it('the unbound-item short circuit still returns an empty activity list', async () => {
    const { resolveBinding } = await import('@/lib/azure/pipeline-binding');
    (resolveBinding as any).mockRejectedValueOnce(new UnboundPipelineError('unbound'));
    const r = await GET(req('runId=run-mine'), CTX as any);
    expect(r.status).toBe(200);
    expect((await r.json()).activities).toEqual([]);
    expect(syn.listActivityRuns).not.toHaveBeenCalled();
  });
});
