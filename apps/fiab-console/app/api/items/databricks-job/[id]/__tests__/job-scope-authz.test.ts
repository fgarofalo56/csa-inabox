/**
 * #2997 — route-level proof that the `databricks-job` family authorizes the
 * caller AND binds every coordinate it acts on.
 *
 * WHAT SHIPPED. `POST [id]/run?jobId=` called `runJob` on a CALLER-SUPPLIED job
 * id behind nothing but `getSession()`. Its handler signature was `POST(req)` —
 * it never accepted `ctx.params`, so `[id]` was not merely unenforced, it was
 * never read. The Console UAMI holds workspace-wide access to the ONE shared
 * Databricks workspace every Loom tenant sits on, so any signed-in user could
 * execute any tenant's job as the Console. `[id]` GET/PUT/DELETE were identical
 * (read / `jobs/reset` / `jobs/delete` on a foreign id); `[id]/runs` widened to
 * the WHOLE workspace when `jobId` was omitted; `[id]/run-output` accepted a
 * `runId` with no job coordinate at all.
 *
 * `databricksConfigGate()` is not a guard — it checks CONFIGURATION, not
 * authorization. Grepping this family for a gate-shaped call marks these routes
 * protected. They were not.
 *
 * WHY THE BINDING IS ANCHORED ON DATABRICKS, NOT ON THE ITEM. The obvious layer
 * 2 — "the jobId must match the one recorded on the item" — is INERT.
 * `PATCH /api/cosmos-items/[type]/[id]` replaces `state` WHOLESALE from the
 * request body with no preservation of `state.provisioning`, so
 * `secondaryIds.jobId` is CLIENT-WRITABLE. An attacker points their OWN item at
 * the victim's job and a state-only check passes. Mutation J3 below IS that
 * mistake, executed — it is tsc-clean and turns this suite red, which is the
 * evidence that anchoring on the resource rather than the item is load-bearing.
 *
 * WHY `toHaveBeenCalledWith` AND NOT `expect.objectContaining`. Part of the
 * security property is the ABSENCE of one key: the executing handlers must stay
 * write-scoped and must never gain `allowReadRoles: true`. `objectContaining`
 * ignores extra keys, so that one-word widening would leave such an assertion
 * GREEN — exactly how an `allowReadRoles: true` slipped past a suite earlier in
 * this program. `toHaveBeenCalledWith` is deep equality over the whole argument.
 * Do not loosen.
 *
 * MUTATION PROOF — every mutation below was EXECUTED by
 * `temp/mutation-proof-2996-2997.py`, confirmed tsc-valid
 * (`tsc -p tsconfig.build.json --noEmit` exit 0 — `allowUnreachableCode:false`
 * rules out `if (false && …)`), confirmed to turn this suite RED, then
 * restored. Result: 18/18 tsc-CLEAN and RED.
 *
 *   J1. `_lib/job-scope.ts` `authorizeDatabricksJobItem` — replace
 *       `if (denied) return { denied };` with `if (denied) void denied;`
 *         → "an unrelated caller is refused" fails on every route, and the
 *           #2997 exploit suite returns to HTTP 200 with runJob called.
 *   J2. `_lib/job-scope.ts` — always pass `allowReadRoles: true` instead of
 *       `...(opts.read ? … : {})`
 *         → every strict guard-shape assertion fails on the extra key.
 *   J3. `_lib/job-scope.ts` `resolveAuthorizedJobId` — derive the marker from
 *       the ITEM's claim (`claimedJobId(item) === jobId ? itemId : undefined`)
 *       instead of from `getJob(...).settings.tags`
 *         → "a forged item claim does not confer ownership" fails. THIS IS THE
 *           INERT-FIX MUTATION: it is precisely what a state-only binding would
 *           have been, and it is why the marker lives on the Databricks side.
 *   J4. `_lib/job-scope.ts` — short-circuit `{ ok: true, jobId: 1 }` when
 *       `jobId` is omitted, instead of deriving the item's binding
 *         → "omitting jobId is still authorized, not skipped" fails.
 *   J5. `_lib/job-scope.ts` `resolveAuthorizedRunId` — accept the run when its
 *       parent job fails binding (`return { ok: true, runId, jobId: parentJobId }`)
 *         → "refuses another tenant's run output" fails.
 *   J6. `_lib/databricks-resource-binding.ts` `judgeOwnerMarker` — accept any
 *       present marker (`if (owner) return { ok: true }`)
 *         → "refuses a jobId owned by another item" fails.
 *   J7. `_lib/databricks-resource-binding.ts` `resolveLegacyClaim` — return
 *       `{ ok: true }` without running the exclusivity query
 *         → "an unmarked job claimed by two items is refused" fails.
 *   J8. `[id]/route.ts` PUT — `updateJob(bound.jobId, spec)` instead of
 *       `withOwnerTag(spec, id)`
 *         → both ownership-stamping tests fail.
 *   C1. `databricks-job/route.ts` POST — drop the `itemId` requirement, so a
 *       created job is unowned and therefore adoptable by any item
 *         → "refuses a create with no itemId" fails.
 *   C2. `databricks-job/route.ts` POST — `createJob(spec)` instead of
 *       `createJob(withOwnerTag(spec, itemId))`
 *         → "stamps the created job with its owning item" fails.
 *
 *  NOT a valid mutation (recorded by #2995, re-confirmed here): substituting
 *  the raw `searchParams.get('jobId')` at the `runJob` call site while KEEPING
 *  the `if (!bound.ok) return …` early return does NOT turn this suite red —
 *  the guard still refuses, so the suite correctly stays green.
 *  The check is the control; the variable is not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

/**
 * The item under test claims Databricks job 4242, and job 4242's OWN settings
 * carry `tags.loom_item_id = 'job-1'` — the server-attested half of the binding.
 * Job 9999 is another tenant's: it exists in the same shared workspace and is
 * marked for a different item.
 */
const OURS = 4242;
const FOREIGN = 9999;
const LEGACY = 777; // real, but carries no Loom ownership marker (pre-#2997)

const ITEM = {
  id: 'job-1',
  itemType: 'databricks-job',
  workspaceId: 'ws-1',
  displayName: 'Medallion',
  state: { provisioning: { secondaryIds: { jobId: String(OURS) } } },
};

/** Cosmos: the item lookup and the legacy-exclusivity COUNT share one container. */
const cosmos = vi.hoisted(() => ({ itemRows: [] as any[], competingClaims: 0, queries: [] as string[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => {
        const text = typeof spec === 'string' ? spec : spec.query;
        cosmos.queries.push(text);
        return {
          fetchAll: async () =>
            text.includes('COUNT(1)')
              ? { resources: [cosmos.competingClaims] }
              : { resources: cosmos.itemRows },
        };
      },
    },
  }),
}));

const dbx = vi.hoisted(() => ({
  getJob: vi.fn(async (jobId: number) => {
    if (jobId === OURS) return { job_id: OURS, settings: { name: 'ours', tags: { loom_item_id: 'job-1' } } };
    if (jobId === FOREIGN) return { job_id: FOREIGN, settings: { name: 'theirs', tags: { loom_item_id: 'other-item' } } };
    if (jobId === LEGACY) return { job_id: LEGACY, settings: { name: 'legacy' } };
    const e: any = new Error('not found'); e.status = 404; throw e;
  }),
  getJobRun: vi.fn(async (runId: number) => ({ run_id: runId, job_id: runId === 51 ? OURS : FOREIGN })),
  getRunOutput: vi.fn(async () => ({ notebook_output: { result: 'secret-rows' } })),
  runJob: vi.fn(async () => ({ run_id: 11, number_in_job: 1 })),
  listJobRuns: vi.fn(async () => [] as any[]),
  updateJob: vi.fn(async () => undefined),
  deleteJob: vi.fn(async () => undefined),
  listJobs: vi.fn(async () => [] as any[]),
  createJob: vi.fn(async () => ({ job_id: 5 })),
  databricksConfigGate: () => null,
}));
vi.mock('@/lib/azure/databricks-client', () => dbx);

const fallback = vi.hoisted(() => ({
  loadContentBackedItem: vi.fn(async () => null as any),
  databricksJobFromContent: vi.fn(() => null as any),
}));
vi.mock('@/app/api/items/_lib/ai-content-fallback', () => fallback);
vi.mock('../../_lib/ai-content-fallback', () => fallback);

import { GET as itemGET, PUT as itemPUT, DELETE as itemDELETE } from '../route';
import { POST as runPOST } from '../run/route';
import { GET as runsGET } from '../runs/route';
import { GET as runOutputGET } from '../run-output/route';
import { POST as collectionPOST } from '../../route';

const ctx = { params: Promise.resolve({ id: 'job-1' }) } as any;

/** A request with an optional query string and JSON body. */
function req(query: Record<string, string> = {}, body: any = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

/** The EXACT guard argument an EXECUTING/MUTATING handler must produce. */
const EXPECTED_WRITE_GUARD = {
  workspaceId: null,
  itemId: 'job-1',
  itemType: 'databricks-job',
  notFound: 'databricks job not found',
};
/** …and the read-only variant, which differs by exactly one key. */
const EXPECTED_READ_GUARD = { ...EXPECTED_WRITE_GUARD, allowReadRoles: true };

async function denyGuard() {
  const { NextResponse } = await import('next/server');
  guard.authorizeItemWorkspace.mockResolvedValue(
    NextResponse.json({ ok: false, error: 'databricks job not found' }, { status: 404 }) as any,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  cosmos.itemRows = [ITEM as any];
  cosmos.competingClaims = 0;
  cosmos.queries = [];
});

// ── LAYER 1 — the caller is authorized against the item ──────────────────────

describe('layer 1 — caller authorization', () => {
  it('an unrelated caller is refused and never reaches Databricks', async () => {
    await denyGuard();

    expect((await runPOST(req({ jobId: String(OURS) }), ctx)).status).toBe(404);
    expect((await itemGET(req({ jobId: String(OURS) }), ctx)).status).toBe(404);
    expect((await itemPUT(req({ jobId: String(OURS) }, { spec: { name: 'x' } }), ctx)).status).toBe(404);
    expect((await itemDELETE(req({ jobId: String(OURS) }), ctx)).status).toBe(404);
    expect((await runsGET(req({ jobId: String(OURS) }), ctx)).status).toBe(404);
    expect((await runOutputGET(req({ runId: '51' }), ctx)).status).toBe(404);

    expect(dbx.runJob).not.toHaveBeenCalled();
    expect(dbx.updateJob).not.toHaveBeenCalled();
    expect(dbx.deleteJob).not.toHaveBeenCalled();
    expect(dbx.getJob).not.toHaveBeenCalled();
    expect(dbx.getRunOutput).not.toHaveBeenCalled();
  });

  it('the EXECUTING and MUTATING handlers are WRITE-scoped — no allowReadRoles key', async () => {
    await runPOST(req({ jobId: String(OURS) }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await itemPUT(req({ jobId: String(OURS) }, { spec: { name: 'x' } }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await itemDELETE(req({ jobId: String(OURS) }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
  });

  it('the strictly read-only handlers opt in to read roles — decided per BODY', async () => {
    await runsGET(req({ jobId: String(OURS) }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await runOutputGET(req({ runId: '51' }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);
  });

  it('an id naming no item is refused, not fallen through to Databricks', async () => {
    cosmos.itemRows = [];
    const res = await runPOST(req({ jobId: String(OURS) }), ctx);
    expect(res.status).toBe(404);
    expect(dbx.runJob).not.toHaveBeenCalled();
  });
});

// ── LAYER 2 — the coordinate is bound to that item ───────────────────────────

describe('layer 2 — jobId binding', () => {
  it('refuses a jobId owned by another item (run / get / reset / delete / runs)', async () => {
    const run = await runPOST(req({ jobId: String(FOREIGN) }), ctx);
    expect(run.status).toBe(403);
    expect(await run.json()).toEqual({
      ok: false,
      error: 'that Databricks resource belongs to a different Loom item.',
    });

    expect((await itemGET(req({ jobId: String(FOREIGN) }), ctx)).status).toBe(403);
    expect((await itemPUT(req({ jobId: String(FOREIGN) }, { spec: { name: 'x' } }), ctx)).status).toBe(403);
    expect((await itemDELETE(req({ jobId: String(FOREIGN) }), ctx)).status).toBe(403);
    expect((await runsGET(req({ jobId: String(FOREIGN) }), ctx)).status).toBe(403);

    expect(dbx.runJob).not.toHaveBeenCalled();
    expect(dbx.updateJob).not.toHaveBeenCalled();
    expect(dbx.deleteJob).not.toHaveBeenCalled();
    expect(dbx.listJobRuns).not.toHaveBeenCalled();
  });

  it('a forged item claim does not confer ownership — the RESOURCE attests, not the item', async () => {
    // Exactly the attack a state-only binding leaves open: the attacker owns
    // this item and rewrites its client-writable `secondaryIds.jobId` to point
    // at the victim's job, then omits the query parameter entirely.
    cosmos.itemRows = [
      { ...ITEM, state: { provisioning: { secondaryIds: { jobId: String(FOREIGN) } } } } as any,
    ];
    const res = await runPOST(req({}), ctx);
    expect(res.status).toBe(403);
    expect(dbx.runJob).not.toHaveBeenCalled();
  });

  it('omitting jobId is still authorized, not skipped — it derives the item binding', async () => {
    const res = await runPOST(req({}), ctx);
    expect(res.status).toBe(200);
    // Derived from the item's own claim AND confirmed against the job's marker.
    expect(dbx.getJob).toHaveBeenCalledWith(OURS);
    expect(dbx.runJob).toHaveBeenCalledWith(OURS, undefined);
  });

  it('omitting jobId on an UNBOUND item refuses instead of falling through', async () => {
    cosmos.itemRows = [{ ...ITEM, state: {} } as any];
    const res = await runPOST(req({}), ctx);
    expect(res.status).toBe(409);
    expect(dbx.runJob).not.toHaveBeenCalled();
  });

  it('narrows the run listing to this item — an omitted jobId no longer lists the whole workspace', async () => {
    const res = await runsGET(req({}), ctx);
    expect(res.status).toBe(200);
    // The pre-fix route called listJobRuns(undefined, 25) here, which returns
    // recent runs across every tenant in the shared workspace.
    expect(dbx.listJobRuns).toHaveBeenCalledWith(OURS, 25);
  });

  it('accepts the job this item genuinely owns', async () => {
    const res = await runPOST(req({ jobId: String(OURS) }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, run_id: 11, number_in_job: 1 });
    expect(dbx.runJob).toHaveBeenCalledWith(OURS, undefined);
  });
});

// ── LAYER 2b — the run-output pivot (the coordinate neither issue names) ─────

describe('layer 2 — runId binding (the live-output pivot)', () => {
  it("refuses another tenant's run output — a runId names no job, so binding jobId alone would miss it", async () => {
    // Run 52's parent is FOREIGN. The pre-fix route took runId with NO job
    // coordinate at all and returned notebook output + stdout + error trace.
    const res = await runOutputGET(req({ runId: '52' }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'that run is not owned by this job item.' });
    expect(dbx.getRunOutput).not.toHaveBeenCalled();
  });

  it('accepts a run belonging to this item’s own job', async () => {
    const res = await runOutputGET(req({ runId: '51' }), ctx);
    expect(res.status).toBe(200);
    expect(dbx.getRunOutput).toHaveBeenCalledWith(51);
  });
});

// ── Legacy (unmarked) resources — adoption only when the claim is exclusive ──

describe('legacy adoption', () => {
  beforeEach(() => {
    cosmos.itemRows = [
      { ...ITEM, state: { provisioning: { secondaryIds: { jobId: String(LEGACY) } } } } as any,
    ];
  });

  it('adopts an unmarked job when this item is its only claimant', async () => {
    cosmos.competingClaims = 0;
    const res = await runPOST(req({}), ctx);
    expect(res.status).toBe(200);
    expect(dbx.runJob).toHaveBeenCalledWith(LEGACY, undefined);
    // The exclusivity check genuinely ran (it is the only thing admitting this).
    expect(cosmos.queries.some((q) => q.includes('COUNT(1)'))).toBe(true);
  });

  it('an unmarked job claimed by two items is refused — ambiguity is not ownership', async () => {
    cosmos.competingClaims = 1;
    const res = await runPOST(req({}), ctx);
    expect(res.status).toBe(409);
    expect(dbx.runJob).not.toHaveBeenCalled();
  });
});

// ── Ownership is re-stamped on every write ───────────────────────────────────

describe('ownership stamping', () => {
  it('a save re-stamps the ownership marker — jobs/reset replaces settings wholesale', async () => {
    const res = await itemPUT(req({ jobId: String(OURS) }, { spec: { name: 'renamed', tasks: [] } }), ctx);
    expect(res.status).toBe(200);
    // Without the re-stamp, a spec that omits `tags` would silently un-own the
    // job and drop it back into legacy adoption.
    expect(dbx.updateJob).toHaveBeenCalledWith(OURS, {
      name: 'renamed',
      tasks: [],
      tags: { loom_item_id: 'job-1' },
    });
  });

  it('a caller cannot overwrite the marker through the spec', async () => {
    await itemPUT(
      req({ jobId: String(OURS) }, { spec: { name: 'x', tags: { loom_item_id: 'other-item', team: 'a' } } }),
      ctx,
    );
    expect(dbx.updateJob).toHaveBeenCalledWith(OURS, {
      name: 'x',
      tags: { loom_item_id: 'job-1', team: 'a' },
    });
  });
});

// -- The CREATE path establishes ownership ----------------------------------

describe('collection create — ownership at birth', () => {
  it('refuses a create with no itemId — an unowned job would be adoptable', async () => {
    const res = await collectionPOST(req({}, { spec: { name: 'x' } }));
    expect(res.status).toBe(400);
    expect(dbx.createJob).not.toHaveBeenCalled();
  });

  it('refuses a create against an item the caller is not authorized for', async () => {
    await denyGuard();
    const res = await collectionPOST(req({}, { itemId: 'job-1', spec: { name: 'x' } }));
    expect(res.status).toBe(404);
    expect(dbx.createJob).not.toHaveBeenCalled();
  });

  it('is WRITE-scoped and stamps the created job with its owning item', async () => {
    const res = await collectionPOST(req({}, { itemId: 'job-1', spec: { name: 'x', tasks: [] } }));
    expect(res.status).toBe(200);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
    expect(dbx.createJob).toHaveBeenCalledWith({
      name: 'x',
      tasks: [],
      tags: { loom_item_id: 'job-1' },
    });
  });
});
