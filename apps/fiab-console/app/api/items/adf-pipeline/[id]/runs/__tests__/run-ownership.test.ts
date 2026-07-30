/**
 * ROUND-3 ROUTE SPEC — the S2 CLASS on the ADF sibling.
 *
 * Same shape, same hole, different client: `?runId=` went straight into
 * `withFactoryOverride(…, () => listActivityRuns(runId))` with nothing tying
 * the run to the item's bound pipeline. ADF run ids are factory-scoped.
 *
 * The extra property asserted here that the Synapse sibling cannot have: the
 * ownership oracle must be evaluated INSIDE the same factory override as the
 * activity read. Proving a run belongs to pipeline X in factory A says nothing
 * about the activities read from factory B.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = {
  runs: {} as Record<string, any>,
  armError: null as Error | null,
  factoryStack: [] as string[],
  calls: [] as string[],
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

const adf = vi.hoisted(() => ({
  listPipelineRuns: vi.fn(async () => []),
  listActivityRuns: vi.fn(async () => {
    state.calls.push(`listActivityRuns@${state.factoryStack[state.factoryStack.length - 1] ?? 'default'}`);
    return ACTIVITIES;
  }),
  getPipelineRun: vi.fn(async (id: string) => {
    state.calls.push(`getPipelineRun@${state.factoryStack[state.factoryStack.length - 1] ?? 'default'}`);
    if (state.armError) throw state.armError;
    return state.runs[id] ?? null;
  }),
}));
vi.mock('@/lib/azure/adf-client', () => adf);

vi.mock('@/lib/azure/adf-factory-context', () => ({
  withFactoryOverride: async (override: any, fn: any) => {
    state.factoryStack.push(override?.factoryName ?? 'override');
    try { return await fn(); } finally { state.factoryStack.pop(); }
  },
}));

const E = vi.hoisted(() => ({
  UnboundPipelineError: class UnboundPipelineError extends Error {},
  ItemNotFoundError: class ItemNotFoundError extends Error {},
}));
const UnboundPipelineError = E.UnboundPipelineError;
vi.mock('@/lib/azure/pipeline-binding', () => ({
  resolveBinding: vi.fn(async () => ({ pipelineName: 'my_pipeline', factoryName: 'their-factory' })),
  bindingFactoryOverride: vi.fn((b: any) => ({ factoryName: b.factoryName })),
  UnboundPipelineError: E.UnboundPipelineError,
  ItemNotFoundError: E.ItemNotFoundError,
}));

import { GET } from '../route';

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/items/adf-pipeline/guid-1/runs?${qs}`);
}
const CTX = { params: { id: 'guid-1' } };

beforeEach(() => {
  vi.clearAllMocks();
  state.armError = null;
  state.factoryStack = [];
  state.calls = [];
  state.runs = {
    'run-mine': { runId: 'run-mine', pipelineName: 'my_pipeline', status: 'Succeeded' },
    'run-theirs': { runId: 'run-theirs', pipelineName: 'payroll_pipeline', status: 'Succeeded' },
  };
});

describe('adf-pipeline runs: `?runId=` ownership', () => {
  // MUTATION: restore
  //   const acts = await withFactoryOverride(bindingFactoryOverride(binding),
  //                                          () => listActivityRuns(runId));
  // → observed: 3 failures — the foreign run's `sqlReaderQuery` and row count
  //   are returned with a 200.
  it('404s a run bound to a different pipeline', async () => {
    const r = await GET(req('runId=run-theirs'), CTX as any);
    expect(r.status).toBe(404);
  });

  it('never reads the foreign run\'s activity payloads', async () => {
    await GET(req('runId=run-theirs'), CTX as any);
    expect(adf.listActivityRuns).not.toHaveBeenCalled();
  });

  it('404s an unknown run id without reading anything', async () => {
    const r = await GET(req('runId=nope'), CTX as any);
    expect(r.status).toBe(404);
    expect(adf.listActivityRuns).not.toHaveBeenCalled();
  });

  it('still serves the caller\'s OWN run', async () => {
    const r = await GET(req('runId=run-mine'), CTX as any);
    expect(r.status).toBe(200);
    expect((await r.json()).activities).toHaveLength(1);
  });

  // MUTATION: hoist `getPipelineRun` OUT of the withFactoryOverride callback.
  // → observed: 1 failure — the oracle runs against the default factory while
  //   the activities are read from the binding's factory.
  it('evaluates the ownership oracle in the SAME factory it reads from', async () => {
    await GET(req('runId=run-mine'), CTX as any);
    expect(state.calls).toEqual([
      'getPipelineRun@their-factory',
      'listActivityRuns@their-factory',
    ]);
  });

  it('a transient ARM failure is a 502, not "run not found"', async () => {
    state.armError = new Error('ARM 429 throttled');
    const r = await GET(req('runId=run-mine'), CTX as any);
    expect(r.status).toBe(502);
  });
});
