/**
 * Unit tests for the notebook run POLL route
 *   GET /api/items/notebook/[id]/runs/[runId]
 * covering the R3 wave-1 fixes:
 *   • #2 — phase-2 per-cell output accumulation ("Run all" renders every cell).
 *   • #3 — honest terminal-state mapping (a cancelled statement → error output,
 *          not a null the client polls to timeout; a shutting_down session →
 *          ok:false).
 *
 * The Livy client (getLivySession / submitLivyStatement / getLivyStatement) is
 * dynamically imported by the route and fully mocked, so @azure/identity never
 * loads under the pnpm-junctioned test sandbox.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => ({ assertOwner: vi.fn(async () => true) }));

const replaceMock = vi.fn();
const readMock = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    item: () => ({ read: readMock, replace: replaceMock }),
  })),
}));

vi.mock('@/lib/azure/synapse-dev-client', () => ({
  getLivySession: vi.fn(),
  submitLivyStatement: vi.fn(),
  getLivyStatement: vi.fn(),
}));

import { GET } from '../[id]/runs/[runId]/route';
import { getSession } from '@/lib/auth/session';
import { getLivySession, submitLivyStatement, getLivyStatement } from '@/lib/azure/synapse-dev-client';

const NB = { id: 'nb1', itemType: 'notebook', displayName: 'nb', state: {} };

function getReq(ws = 'ws1') {
  return { nextUrl: new URL(`http://x/api/items/notebook/nb1/runs/x?workspaceId=${ws}`) } as any;
}
function ctxFor(runId: string) {
  return { params: Promise.resolve({ id: 'nb1', runId }) } as any;
}
function withState(state: any) {
  readMock.mockResolvedValue({ resource: { ...NB, state } });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'u1' } });
  replaceMock.mockResolvedValue({});
});

describe('phase-2 cellOutputs accumulation (R3 #2)', () => {
  const twoCellPending = () => ({
    pendingRuns: {
      'spark:pool1:5': {
        queue: [
          { source: 'print(1)', lang: 'pyspark', cellId: 'c1' },
          { source: 'print(2)', lang: 'pyspark', cellId: 'c2' },
        ],
        qIdx: 1,
        startedAt: new Date().toISOString(),
      },
    },
  });

  it('attributes the finished cell output and submits the next cell', async () => {
    withState(twoCellPending());
    (getLivyStatement as any).mockResolvedValue({ id: 10, state: 'available', output: { status: 'ok', data: { 'text/plain': 'out-c1' } } });
    (submitLivyStatement as any).mockResolvedValue({ id: 11, state: 'running' });

    const res = await GET(getReq(), ctxFor('spark:pool1:5:10'));
    const j = await res.json();

    // The just-finished cell c1 is attributed; c2 is now running.
    expect(j.cellOutputs.c1.status).toBe('ok');
    expect(j.cellOutputs.c1.textPlain).toBe('out-c1');
    expect(j.runId).toBe('spark:pool1:5:11');
    expect(submitLivyStatement).toHaveBeenCalledWith('pool1', 5, { code: 'print(2)', kind: 'pyspark' });
    // qIdx advanced + cellOutputs persisted for the next poll.
    const persisted = replaceMock.mock.calls.at(-1)![0].state.pendingRuns['spark:pool1:5'];
    expect(persisted.qIdx).toBe(2);
    expect(persisted.cellOutputs.c1.textPlain).toBe('out-c1');
  });

  it('on the LAST cell returns every cell output + the top-level output, and drops the queue entry', async () => {
    withState({
      pendingRuns: {
        'spark:pool1:5': {
          queue: [
            { source: 'print(1)', lang: 'pyspark', cellId: 'c1' },
            { source: 'print(2)', lang: 'pyspark', cellId: 'c2' },
          ],
          qIdx: 2,
          cellOutputs: { c1: { status: 'ok', textPlain: 'out-c1' } },
        },
      },
    });
    (getLivyStatement as any).mockResolvedValue({ id: 11, state: 'available', output: { status: 'ok', data: { 'text/plain': 'out-c2' } } });

    const res = await GET(getReq(), ctxFor('spark:pool1:5:11'));
    const j = await res.json();

    expect(j.output.status).toBe('ok');
    expect(j.output.textPlain).toBe('out-c2');
    expect(j.cellOutputs.c1.textPlain).toBe('out-c1');
    expect(j.cellOutputs.c2.textPlain).toBe('out-c2');
    expect(submitLivyStatement).not.toHaveBeenCalled();
    // Terminal → the queue entry is deleted so a re-run starts fresh.
    const persisted = replaceMock.mock.calls.at(-1)![0].state.pendingRuns;
    expect(persisted['spark:pool1:5']).toBeUndefined();
  });
});

describe('honest terminal-state mapping (R3 #3)', () => {
  it('maps a cancelled statement to an error output instead of null', async () => {
    withState({
      pendingRuns: {
        'spark:pool1:5': { queue: [{ source: 'print(1)', lang: 'pyspark', cellId: 'c1' }], qIdx: 1 },
      },
    });
    (getLivyStatement as any).mockResolvedValue({ id: 10, state: 'cancelled', output: null });

    const res = await GET(getReq(), ctxFor('spark:pool1:5:10'));
    const j = await res.json();

    expect(j.status).toBe('cancelled');
    expect(j.output.status).toBe('error');
    expect(j.output.ename).toBe('Cancelled');
    expect(j.cellOutputs.c1.status).toBe('error');
  });

  it('surfaces a shutting_down session as ok:false (phase 1)', async () => {
    withState({});
    (getLivySession as any).mockResolvedValue({ id: 5, state: 'shutting_down' });

    const res = await GET(getReq(), ctxFor('spark:pool1:5'));
    const j = await res.json();

    expect(j.ok).toBe(false);
    expect(j.status).toBe('shutting_down');
  });
});
