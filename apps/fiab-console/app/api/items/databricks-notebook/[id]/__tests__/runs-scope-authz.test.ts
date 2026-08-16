/**
 * GHSA-v2g8-gp3r-rg4r — route-level proof that
 * `GET /api/items/databricks-notebook/[id]/runs` is bound to ITS OWN notebook.
 *
 * WHAT SHIPPED. `export async function GET(req: NextRequest)` — the handler did
 * not accept `ctx` at all, so `[id]` was never read. `listJobRuns(undefined, 25)`
 * returned recent runs across the ENTIRE shared Databricks workspace that every
 * Loom tenant sits on, and `getRunOutput(runId)` returned NOTEBOOK CELL OUTPUT
 * for any run id a caller named. Read-only, but cross-tenant — and cell output
 * is the notebook's actual results, not just run metadata.
 *
 * This is the route the #2988 sweep of this family left behind. `[id]/run`,
 * `[id]/command`, `[id]/context` and `[id]/schedule` all adopted
 * `_lib/notebook-exec-scope.ts` + `_lib/notebook-path-scope.ts` then; this one
 * did not, precisely BECAUSE it never consumed `[id]` and so did not present as
 * a route with an id to enforce.
 *
 * WHY SCOPE BY NOTEBOOK PATH AND NOT BY JOB ID. `[id]/run` submits one-off runs
 * through `jobs/runs/submit`, which produces runs with no job of their own. A
 * job-id filter would therefore have silently emptied the editor's run history —
 * a fix that refuses real users. The path is the coordinate the sibling routes
 * already bind, so the two agree by construction.
 *
 * MUTATION PROOF — each was executed against this suite and restored. All turn
 * it RED; one is ALSO rejected by `tsc`, noted rather than glossed because it is
 * a stronger property than a red test:
 *   1. `[id]/runs/route.ts` — drop `if (denied) return denied;`
 *        → "a denied caller never reaches Databricks" and "an id naming no
 *          notebook is refused" fail — AND `tsc` fails with TS2345
 *          (`WorkspaceItem | undefined` is not assignable), because
 *          `authorizeNotebookItem`'s two-shape return makes discarding the
 *          answer a COMPILE error rather than merely an untested one.
 *   2. `[id]/runs/route.ts` — return `all` unfiltered from the list branch
 *        → "lists only this notebook's runs" and "a run with no notebook path
 *          is OUT of scope" fail. tsc-clean (exit 0).
 *   3. `[id]/runs/route.ts` — discard the `runInScope` check on the runId branch
 *        → the three "refuses a run id …" tests fail and `getRunOutput` is
 *          reached. tsc-clean (exit 0).
 *   4. `[id]/runs/route.ts` `runInScope` — `return paths.length === 0 ||
 *      paths.every(...)` (treat an unattributable run as in scope)
 *        → three tests fail, incl. "a run with no notebook path is OUT of
 *          scope". tsc-clean (exit 0).
 *   5. `[id]/runs/route.ts` `runInScope` — `paths.some(...)` instead of
 *      `paths.every(...)`
 *        → "refuses a multi-task run that ALSO touches a foreign notebook"
 *          fails. tsc-clean (exit 0).
 *
 * NOT PROVABLE HERE, and stated rather than implied: mutating
 * `lib/azure/databricks-client.ts` to ignore `opts.expandTasks` leaves THIS file
 * GREEN — it mocks that module wholesale, so it asserts the route's CALL
 * (`{ expandTasks: true }`), not the wire contract. That mutation was executed
 * and measured green here. The wire contract is pinned instead by
 * `lib/azure/__tests__/databricks-jobs.test.ts` → "requests expand_tasks=true
 * when asked", which does go red, because it asserts the real URL. Without the
 * parameter no run carries a notebook path, every run becomes unattributable,
 * and this route — which fails closed — would return an EMPTY history to a
 * legitimate owner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

/**
 * The notebook under test is a bundle-installed notebook at
 * `/Shared/loom-installs/app-a/Silver`, so its authorized scope is the app's own
 * folder `/Shared/loom-installs/app-a`. `app-b` is another tenant's app.
 */
const OWN_PATH = '/Shared/loom-installs/app-a/Silver';
const SIBLING_PATH = '/Shared/loom-installs/app-a/Gold';
const FOREIGN_PATH = '/Shared/loom-installs/app-b/Steal';

const ITEM = {
  id: 'nb-1',
  itemType: 'databricks-notebook',
  workspaceId: 'ws-1',
  displayName: 'Silver',
  state: { provisioning: { secondaryIds: { notebookPath: OWN_PATH } } },
};

const cosmos = vi.hoisted(() => ({ fetchAll: vi.fn(async () => ({ resources: [] as any[] })) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: cosmos.fetchAll }) } }),
}));

function nbRun(run_id: number, ...paths: string[]) {
  return {
    run_id,
    start_time: run_id,
    state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' },
    tasks: paths.map((p, i) => ({ task_key: `t${i}`, notebook_task: { notebook_path: p } })),
  };
}

const dbx = vi.hoisted(() => ({
  listJobRuns: vi.fn(async () => [] as any[]),
  getJobRun: vi.fn(async () => ({ run_id: 1, tasks: [] } as any)),
  getRunOutput: vi.fn(async () => ({ notebook_output: { result: 'secret rows' } })),
}));
vi.mock('@/lib/azure/databricks-client', () => dbx);

import { GET } from '../runs/route';

const ctx = { params: Promise.resolve({ id: 'nb-1' }) } as any;
function req(query: Record<string, string> = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), nextUrl: url } as any;
}

const EXPECTED_GUARD = {
  workspaceId: null,
  itemId: 'nb-1',
  itemType: 'databricks-notebook',
  notFound: 'notebook not found',
};

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  cosmos.fetchAll.mockResolvedValue({ resources: [ITEM as any] });
  dbx.listJobRuns.mockResolvedValue([
    nbRun(1, OWN_PATH),
    nbRun(2, FOREIGN_PATH),
    nbRun(3, SIBLING_PATH),
    { run_id: 4, start_time: 4 }, // a run declaring no notebook at all
  ] as any);
});

// ── LAYER 1 — the caller is authorized against the item ──────────────────────

describe('layer 1 — caller authorization', () => {
  it('a denied caller never reaches Databricks', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 }) as any,
    );
    expect((await GET(req(), ctx)).status).toBe(404);
    expect((await GET(req({ runId: '2' }), ctx)).status).toBe(404);
    expect(dbx.listJobRuns).not.toHaveBeenCalled();
    expect(dbx.getJobRun).not.toHaveBeenCalled();
    expect(dbx.getRunOutput).not.toHaveBeenCalled();
  });

  it('runs the canonical guard with the workspace resolved FROM THE ITEM', async () => {
    await GET(req(), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);
  });

  it('an id naming no notebook is refused, not fallen through to Databricks', async () => {
    cosmos.fetchAll.mockResolvedValue({ resources: [] });
    expect((await GET(req(), ctx)).status).toBe(404);
    expect(dbx.listJobRuns).not.toHaveBeenCalled();
  });
});

// ── LAYER 2 — every run is bound to this notebook's own path scope ───────────

describe('layer 2 — run scoping', () => {
  it("lists only this notebook's runs, not the shared workspace's", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.runs.map((r: any) => r.run_id)).toEqual([1, 3]);
  });

  it('asks Databricks to expand tasks — without them nothing is attributable', async () => {
    await GET(req(), ctx);
    expect(dbx.listJobRuns).toHaveBeenCalledWith(undefined, 200, { expandTasks: true });
  });

  it('a run with no notebook path is OUT of scope (fail closed)', async () => {
    dbx.listJobRuns.mockResolvedValue([{ run_id: 9, start_time: 9 }] as any);
    const j = await (await GET(req(), ctx)).json();
    expect(j.runs).toEqual([]);
  });

  it('refuses a run id belonging to another notebook — and never fetches its output', async () => {
    dbx.getJobRun.mockResolvedValue(nbRun(2, FOREIGN_PATH) as any);
    const res = await GET(req({ runId: '2' }), ctx);
    expect(res.status).toBe(404);
    expect(dbx.getRunOutput).not.toHaveBeenCalled();
  });

  it('refuses a multi-task run that ALSO touches a foreign notebook', async () => {
    dbx.getJobRun.mockResolvedValue(nbRun(5, OWN_PATH, FOREIGN_PATH) as any);
    const res = await GET(req({ runId: '5' }), ctx);
    expect(res.status).toBe(404);
    expect(dbx.getRunOutput).not.toHaveBeenCalled();
  });

  it('refuses a run id that declares no notebook path', async () => {
    dbx.getJobRun.mockResolvedValue({ run_id: 7 } as any);
    const res = await GET(req({ runId: '7' }), ctx);
    expect(res.status).toBe(404);
    expect(dbx.getRunOutput).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric runId before calling Databricks', async () => {
    const res = await GET(req({ runId: 'abc' }), ctx);
    expect(res.status).toBe(400);
    expect(dbx.getJobRun).not.toHaveBeenCalled();
  });
});

// ── The legitimate owner is NOT refused ──────────────────────────────────────

describe('a legitimate owner still succeeds', () => {
  it("returns this notebook's own run with its cell output", async () => {
    dbx.getJobRun.mockResolvedValue(nbRun(1, OWN_PATH) as any);
    const res = await GET(req({ runId: '1' }), ctx);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.run.run_id).toBe(1);
    expect(j.output.notebook_output.result).toBe('secret rows');
    expect(dbx.getRunOutput).toHaveBeenCalledWith(1);
  });

  it('returns a run in a SIBLING path of the same app install', async () => {
    dbx.getJobRun.mockResolvedValue(nbRun(3, SIBLING_PATH) as any);
    expect((await GET(req({ runId: '3' }), ctx)).status).toBe(200);
  });

  it('still returns a run when its output cannot be fetched', async () => {
    dbx.getJobRun.mockResolvedValue(nbRun(1, OWN_PATH) as any);
    dbx.getRunOutput.mockRejectedValue(new Error('no output for this run'));
    const j = await (await GET(req({ runId: '1' }), ctx)).json();
    expect(j.ok).toBe(true);
    expect(j.output).toBeNull();
  });
});
