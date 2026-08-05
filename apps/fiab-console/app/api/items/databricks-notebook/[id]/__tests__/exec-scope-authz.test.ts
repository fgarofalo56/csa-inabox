/**
 * #2988 — route-level proof that the databricks-notebook EXECUTION family
 * authorizes the caller AND binds every coordinate it executes on.
 *
 * WHAT SHIPPED. `POST [id]/command` accepted a caller-chosen `clusterId`, a
 * caller-chosen `contextId`, and an ARBITRARY `command` string behind nothing
 * but `getSession()`. Its handler did not even accept `ctx.params`, so `[id]`
 * was not merely unenforced — it was never read. `[id]/context` was identical,
 * and `[id]/run` passed a caller-chosen `path` + `clusterId` straight to
 * `jobs/runs/submit`. The Console UAMI holds workspace-wide access to the ONE
 * shared Databricks workspace every tenant sits on, so any signed-in user could
 * execute arbitrary code as the Console on a shared cluster. `[id]/schedule` had
 * layer 1 (`loadOwnedItem`) but NO layer 2, so an authorized caller could
 * schedule a job running ANOTHER tenant's notebook path on a cron.
 *
 * WHY `toHaveBeenCalledWith` AND NOT `expect.objectContaining`. The security
 * property under test is partly the ABSENCE of one key: these handlers all
 * EXECUTE, so the guard must stay write-scoped and must never gain
 * `allowReadRoles: true`. `objectContaining` ignores extra keys, so that
 * one-word widening would leave such an assertion GREEN — which is exactly how
 * an `allowReadRoles: true` slipped past a suite earlier in this program.
 * `toHaveBeenCalledWith` is deep equality over the whole argument. Do not loosen.
 *
 * MUTATION PROOF — each of these is tsc-valid (`allowUnreachableCode:false`
 * rules out `if (false && …)`) and turns this file RED:
 *   1. `_lib/notebook-exec-scope.ts` `resolveAuthorizedClusterId` — return
 *      `{ ok: true, clusterId: asked }` before the entitlement check
 *        → every "foreign / non-all-purpose cluster is refused" test fails.
 *   2. `_lib/notebook-exec-scope.ts` — drop `isAllPurposeCluster(c)` from
 *      `entitledClusterIds` (accept every listed cluster)
 *        → "refuses a JOB-source cluster" fails.
 *   3. `_lib/notebook-exec-scope.ts` `verifyExecContextHandle` — return
 *      `String(handle)` instead of verifying
 *        → "refuses a raw Databricks context id" and "refuses a handle minted
 *          for another notebook" fail.
 *   4. `_lib/notebook-exec-scope.ts` — drop the scope re-comparison
 *      (`claims.i !== scope.itemId || …`), keeping only the signature check
 *        → "refuses a handle minted for another notebook" fails.
 *   5. `_lib/notebook-exec-scope.ts` `authorizeNotebookItem` — add
 *      `allowReadRoles: true` to the `authorizeItemWorkspace` call
 *        → every strict guard-shape assertion fails on the extra key.
 *   6. `_lib/notebook-exec-scope.ts` — drop the `if (denied) return { denied }`
 *        → "a denied caller never reaches Databricks" fails on all four routes.
 *   7. `_lib/notebook-exec-scope.ts` — return `{ item: null as any }` instead of
 *      the 404 when `loadNotebookItemRaw` finds nothing
 *        → "an id naming no item is refused" fails.
 *   8. `[id]/run/route.ts` — drop the `if (!scoped.ok) return …` scope CHECK
 *      (fall through to the caller's raw `body.path`)
 *        → "refuses a path outside the item's scope" and "omitting the path is
 *          refused" fail. NOTE: substituting `body?.path` at the `runNotebook`
 *          call site while KEEPING the check is NOT an equivalent mutation —
 *          the early return still refuses, so the suite correctly stays green.
 *          The check is the control; the variable is not.
 *   9. `[id]/schedule/route.ts` — same, on the POST scope check
 *        → "refuses scheduling another tenant's notebook" fails.
 *  10. `[id]/schedule/route.ts` — drop the `loadScopedJob` call in PATCH/DELETE
 *        → the out-of-scope jobId tests fail.
 *
 * All ten were executed against this suite; each was confirmed tsc-clean
 * (`tsc -p tsconfig.build.json --noEmit` exit 0) and RED before being restored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SESSION_SECRET = 'unit-test-session-secret-for-exec-context-handles';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

/**
 * The item under test is a bundle-installed notebook at
 * `/Shared/loom-installs/app-a/Silver`, so its authorized scope is the app's own
 * folder `/Shared/loom-installs/app-a`. `/Shared/loom-installs/app-b/...` is
 * another tenant's app and must never be reachable.
 */
const ITEM = {
  id: 'nb-1',
  itemType: 'databricks-notebook',
  workspaceId: 'ws-1',
  displayName: 'Silver',
  state: { provisioning: { secondaryIds: { notebookPath: '/Shared/loom-installs/app-a/Silver' } } },
};
const FOREIGN_PATH = '/Shared/loom-installs/app-b/Steal';

const cosmos = vi.hoisted(() => ({ fetchAll: vi.fn(async () => ({ resources: [] as any[] })) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: cosmos.fetchAll }) } }),
}));

/**
 * The shared Databricks workspace as this deployment can see it: ONE all-purpose
 * cluster we are entitled to, plus a JOB-source cluster (ephemeral compute
 * created for someone else's workload — it can carry that workload's
 * cluster-scoped secrets, so it is not a legitimate interactive target).
 * `cl-foreign` is deliberately ABSENT: it models a cluster id from a different
 * Databricks workspace.
 */
const OURS = 'cl-ours';
const JOB_CLUSTER = 'cl-job-source';
const FOREIGN_CLUSTER = 'cl-foreign';

const dbx = vi.hoisted(() => ({
  listClusters: vi.fn(async () => [
    { cluster_id: 'cl-ours', cluster_source: 'UI', state: 'RUNNING' },
    { cluster_id: 'cl-job-source', cluster_source: 'JOB', state: 'RUNNING' },
  ]),
  isAllPurposeCluster: (c: any) => !c.cluster_source || c.cluster_source === 'UI' || c.cluster_source === 'API',
  createExecutionContext: vi.fn(async () => ({ id: 'dbx-ctx-raw' })),
  executeCommand: vi.fn(async () => ({ id: 'cmd', status: 'Finished', results: { resultType: 'text', data: 'hi' } })),
  destroyExecutionContext: vi.fn(async () => undefined),
  runNotebook: vi.fn(async () => ({ run_id: 42 })),
  databricksConfigGate: () => null,
  listJobs: vi.fn(async () => [] as any[]),
  getJob: vi.fn(async () => ({ job_id: 7, settings: { tasks: [{ notebook_task: { notebook_path: FOREIGN_PATH } }] } })),
  createJob: vi.fn(async () => ({ job_id: 9 })),
  updateJob: vi.fn(async () => undefined),
  deleteJob: vi.fn(async () => undefined),
  runJob: vi.fn(async () => ({ run_id: 11 })),
  listJobRuns: vi.fn(async () => [] as any[]),
}));
vi.mock('@/lib/azure/databricks-client', () => dbx);

const cluster = vi.hoisted(() => ({ ensureRunnableCluster: vi.fn(async () => ({ clusterId: 'cl-ours' })) }));
vi.mock('@/lib/azure/databricks-default-cluster', () => cluster);

import { POST as commandPOST } from '../command/route';
import { POST as contextPOST, DELETE as contextDELETE } from '../context/route';
import { POST as runPOST } from '../run/route';
import { POST as schedulePOST, PATCH as schedulePATCH, DELETE as scheduleDELETE } from '../schedule/route';
import { mintExecContextHandle } from '../../_lib/notebook-exec-scope';

const ctx = { params: Promise.resolve({ id: 'nb-1' }) } as any;

/** A request carrying a JSON body (and optional query string). */
function req(body: any = {}, query: Record<string, string> = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

/** The EXACT guard argument every handler in this family must produce: the
 *  canonical ladder, write-scoped, with the workspace resolved from the item. */
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
  cluster.ensureRunnableCluster.mockResolvedValue({ clusterId: OURS } as any);
  dbx.getJob.mockResolvedValue({
    job_id: 7,
    settings: { tasks: [{ notebook_task: { notebook_path: FOREIGN_PATH } }] },
  } as any);
});

// ── LAYER 1 — the caller is authorized against the item ──────────────────────

describe('layer 1 — caller authorization', () => {
  it('a denied caller never reaches Databricks (command / context / run / schedule)', async () => {
    const { NextResponse } = await import('next/server');
    guard.authorizeItemWorkspace.mockResolvedValue(
      NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 }) as any,
    );

    expect((await commandPOST(req({ language: 'python', command: 'print(1)' }), ctx)).status).toBe(404);
    expect((await contextPOST(req({ language: 'python' }), ctx)).status).toBe(404);
    expect((await runPOST(req({ path: '/Shared/loom-installs/app-a/Silver' }), ctx)).status).toBe(404);
    expect((await schedulePOST(req({ path: '/Shared/loom-installs/app-a/Silver' }), ctx)).status).toBe(404);

    expect(dbx.createExecutionContext).not.toHaveBeenCalled();
    expect(dbx.executeCommand).not.toHaveBeenCalled();
    expect(dbx.runNotebook).not.toHaveBeenCalled();
    expect(dbx.createJob).not.toHaveBeenCalled();
  });

  it('guards WRITE-scoped — the argument carries no allowReadRoles key', async () => {
    await commandPOST(req({ language: 'python', command: 'print(1)' }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await runPOST(req({ path: '/Shared/loom-installs/app-a/Silver' }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await schedulePOST(req({ path: '/Shared/loom-installs/app-a/Silver' }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);
  });

  it('an id naming no item is refused, not fallen through to Databricks', async () => {
    cosmos.fetchAll.mockResolvedValue({ resources: [] });
    const res = await commandPOST(req({ language: 'python', command: 'print(1)' }), ctx);
    expect(res.status).toBe(404);
    expect(dbx.executeCommand).not.toHaveBeenCalled();
  });
});

// ── MUTATION CASE 1 — a cluster from another workspace is refused ────────────

describe('mutation case 1 — clusterId binding', () => {
  it('refuses a clusterId belonging to a different workspace (command)', async () => {
    const res = await commandPOST(
      req({ clusterId: FOREIGN_CLUSTER, language: 'python', command: 'print(open("/dbfs/other").read())' }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/entitled/i);
    expect(dbx.createExecutionContext).not.toHaveBeenCalled();
    expect(dbx.executeCommand).not.toHaveBeenCalled();
  });

  it('refuses a clusterId belonging to a different workspace (context, run, schedule)', async () => {
    expect((await contextPOST(req({ clusterId: FOREIGN_CLUSTER, language: 'python' }), ctx)).status).toBe(403);
    expect(
      (await runPOST(req({ path: '/Shared/loom-installs/app-a/Silver', clusterId: FOREIGN_CLUSTER }), ctx)).status,
    ).toBe(403);
    expect(
      (await schedulePOST(req({ path: '/Shared/loom-installs/app-a/Silver', clusterId: FOREIGN_CLUSTER }), ctx)).status,
    ).toBe(403);
    expect(dbx.createExecutionContext).not.toHaveBeenCalled();
    expect(dbx.runNotebook).not.toHaveBeenCalled();
    expect(dbx.createJob).not.toHaveBeenCalled();
  });

  it("refuses a JOB-source cluster — another workload's ephemeral compute is not an interactive target", async () => {
    const res = await commandPOST(req({ clusterId: JOB_CLUSTER, language: 'python', command: 'print(1)' }), ctx);
    expect(res.status).toBe(403);
    expect(dbx.executeCommand).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the entitled set cannot be enumerated', async () => {
    dbx.listClusters.mockRejectedValueOnce(new Error('SCIM not bootstrapped'));
    const res = await commandPOST(req({ clusterId: OURS, language: 'python', command: 'print(1)' }), ctx);
    expect(res.status).toBe(502);
    expect(dbx.executeCommand).not.toHaveBeenCalled();
  });

  it('accepts an entitled cluster the user legitimately picked', async () => {
    const res = await commandPOST(req({ clusterId: OURS, language: 'sql', command: 'SELECT 1' }), ctx);
    expect(res.status).toBe(200);
    expect(dbx.executeCommand).toHaveBeenCalledWith(OURS, 'dbx-ctx-raw', 'sql', 'SELECT 1');
  });
});

// ── MUTATION CASE 2 — an out-of-scope context / path is refused ──────────────

describe('mutation case 2 — execution-context and path binding', () => {
  it('refuses a RAW Databricks context id (the shipped wire value)', async () => {
    const res = await commandPOST(
      req({ clusterId: OURS, language: 'python', command: 'print(secret)', contextId: 'dbx-ctx-raw' }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(dbx.executeCommand).not.toHaveBeenCalled();
  });

  it("refuses a handle minted for ANOTHER notebook — no attaching to another tenant's REPL", async () => {
    const foreign = mintExecContextHandle(
      { itemId: 'nb-OTHER-TENANT', clusterId: OURS, language: 'python' },
      'dbx-ctx-raw',
    );
    const res = await commandPOST(
      req({ clusterId: OURS, language: 'python', command: 'print(df)', contextId: foreign }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(dbx.executeCommand).not.toHaveBeenCalled();
  });

  it('refuses a handle minted for another cluster or another language', async () => {
    const otherCluster = mintExecContextHandle({ itemId: 'nb-1', clusterId: 'cl-else', language: 'python' }, 'raw');
    expect(
      (await commandPOST(req({ clusterId: OURS, language: 'python', command: 'x', contextId: otherCluster }), ctx)).status,
    ).toBe(403);

    const otherLang = mintExecContextHandle({ itemId: 'nb-1', clusterId: OURS, language: 'scala' }, 'raw');
    expect(
      (await commandPOST(req({ clusterId: OURS, language: 'python', command: 'x', contextId: otherLang }), ctx)).status,
    ).toBe(403);
    expect(dbx.executeCommand).not.toHaveBeenCalled();
  });

  it('round-trips its OWN handle so REPL state still persists across cells', async () => {
    const first = await commandPOST(req({ clusterId: OURS, language: 'python', command: 'a=1' }), ctx);
    const handle = (await first.json()).contextId as string;
    expect(handle).not.toBe('dbx-ctx-raw'); // never hands out the raw id

    dbx.createExecutionContext.mockClear();
    const second = await commandPOST(
      req({ clusterId: OURS, language: 'python', command: 'print(a)', contextId: handle }),
      ctx,
    );
    expect(second.status).toBe(200);
    expect(dbx.createExecutionContext).not.toHaveBeenCalled(); // reused, not recreated
    expect(dbx.executeCommand).toHaveBeenCalledWith(OURS, 'dbx-ctx-raw', 'python', 'print(a)');
  });

  it("refuses destroying another notebook's execution context", async () => {
    const foreign = mintExecContextHandle(
      { itemId: 'nb-OTHER-TENANT', clusterId: OURS, language: 'python' },
      'dbx-ctx-raw',
    );
    const res = await contextDELETE(req({ clusterId: OURS, language: 'python', contextId: foreign }), ctx);
    expect(res.status).toBe(403);
    expect(dbx.destroyExecutionContext).not.toHaveBeenCalled();
  });

  it("refuses running a path outside the item's scope", async () => {
    const res = await runPOST(req({ path: FOREIGN_PATH, clusterId: OURS }), ctx);
    expect(res.status).toBe(403);
    expect(dbx.runNotebook).not.toHaveBeenCalled();
  });

  it("refuses SCHEDULING another tenant's notebook (the layer-2 defect)", async () => {
    const res = await schedulePOST(req({ path: FOREIGN_PATH, clusterId: OURS, cron: '0 0 * * * ?' }), ctx);
    expect(res.status).toBe(403);
    expect(dbx.createJob).not.toHaveBeenCalled();
  });

  it('refuses run-now / pause / delete on a job that runs a foreign notebook', async () => {
    // getJob returns a job whose notebook_task targets app-b (see beforeEach).
    expect((await schedulePATCH(req({ jobId: 7, action: 'run' }), ctx)).status).toBe(404);
    expect((await schedulePATCH(req({ jobId: 7, action: 'pause' }), ctx)).status).toBe(404);
    expect((await scheduleDELETE(req({}, { jobId: '7' }), ctx)).status).toBe(404);
    expect(dbx.runJob).not.toHaveBeenCalled();
    expect(dbx.updateJob).not.toHaveBeenCalled();
    expect(dbx.deleteJob).not.toHaveBeenCalled();
  });

  it("lists only jobs bound to this item's scope", async () => {
    const { GET: scheduleGET } = await import('../schedule/route');
    dbx.listJobs.mockResolvedValue([
      { job_id: 1, settings: { name: 'mine', tasks: [{ notebook_task: { notebook_path: '/Shared/loom-installs/app-a/Silver' } }] } },
      { job_id: 2, settings: { name: 'theirs', tasks: [{ notebook_task: { notebook_path: FOREIGN_PATH } }] } },
    ] as any);
    const res = await scheduleGET(req({}), ctx);
    const j = await res.json();
    expect(j.jobs.map((x: any) => x.job_id)).toEqual([1]);
  });

  it('accepts an in-scope path (run + schedule still work)', async () => {
    const ok = await runPOST(req({ path: '/Shared/loom-installs/app-a/Silver', clusterId: OURS }), ctx);
    expect(ok.status).toBe(200);
    expect(dbx.runNotebook).toHaveBeenCalledWith('/Shared/loom-installs/app-a/Silver', OURS, undefined, undefined);
  });
});

// ── MUTATION CASE 3 — omitting coordinates does not skip authorization ───────

describe('mutation case 3 — omitted coordinates', () => {
  it('omitting clusterId still authorizes, and DERIVES the cluster server-side', async () => {
    const res = await commandPOST(req({ language: 'python', command: 'print(1)' }), ctx);
    expect(res.status).toBe(200);
    // The guard still ran with the full write-scoped shape...
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);
    // ...and the cluster came from the platform resolver, not the caller.
    expect(cluster.ensureRunnableCluster).toHaveBeenCalledWith({ autoStart: true });
    expect(dbx.executeCommand).toHaveBeenCalledWith(OURS, 'dbx-ctx-raw', 'python', 'print(1)');
    expect((await res.json()).clusterId).toBe(OURS);
  });

  it('omitting workspaceId still authorizes — it is resolved FROM THE ITEM', async () => {
    await commandPOST(req({ language: 'python', command: 'print(1)' }), ctx);
    // workspaceId: null (not undefined, not absent) → authorizeItemWorkspace
    // resolves it from the item, so dropping the param cannot skip the check.
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);
  });

  it('omitting BOTH clusterId and workspaceId on run/schedule still authorizes + binds', async () => {
    const r = await runPOST(req({ path: '/Shared/loom-installs/app-a/Silver' }), ctx);
    expect(r.status).toBe(200);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);
    expect(dbx.runNotebook).toHaveBeenCalledWith('/Shared/loom-installs/app-a/Silver', OURS, undefined, undefined);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    cluster.ensureRunnableCluster.mockResolvedValue({ clusterId: OURS } as any);
    const s = await schedulePOST(req({ path: '/Shared/loom-installs/app-a/Silver' }), ctx);
    expect(s.status).toBe(200);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_GUARD);
    expect(dbx.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          {
            task_key: 'notebook',
            existing_cluster_id: OURS,
            notebook_task: { notebook_path: '/Shared/loom-installs/app-a/Silver', base_parameters: {} },
          },
        ],
      }),
    );
  });

  it('omitting the path is refused, not defaulted to something broad', async () => {
    expect((await runPOST(req({ clusterId: OURS }), ctx)).status).toBe(400);
    expect((await schedulePOST(req({ clusterId: OURS }), ctx)).status).toBe(400);
    expect(dbx.runNotebook).not.toHaveBeenCalled();
    expect(dbx.createJob).not.toHaveBeenCalled();
  });
});
