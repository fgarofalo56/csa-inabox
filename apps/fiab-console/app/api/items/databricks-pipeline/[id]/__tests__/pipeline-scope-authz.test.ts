/**
 * #2996 — route-level proof that the `databricks-pipeline` (Lakeflow DLT)
 * family authorizes the caller AND binds every coordinate it acts on.
 *
 * WHAT SHIPPED. `POST [id]/spec` ran on nothing but `getSession()`. It compiled
 * a caller-supplied canvas model to SQL, wrote it to `/Shared/loom-dlt/<name>`
 * with **`overwrite=true`** — a path whose leaf came straight from `model.name`,
 * in the ONE shared Databricks workspace every Loom tenant sits on — and then
 * created a DLT pipeline over it that executes as the Console. So: replace
 * another tenant's notebook, then have the platform run your code. `start`,
 * `stop`, `updates`, `events` and the `spec` GET were the same shape on a
 * caller-supplied `pipelineId`.
 *
 * `databricksConfigGate()` is not a guard — it checks CONFIGURATION, not
 * authorization, and it appears in every one of these files.
 *
 * WHY THE BINDING IS ANCHORED ON DATABRICKS, NOT ON THE ITEM. A state-only
 * binding is INERT here: `PATCH /api/cosmos-items/[type]/[id]` replaces `state`
 * WHOLESALE from the request body, so `state.content.pipelineId` is
 * CLIENT-WRITABLE. An attacker points their own item at the victim's pipeline
 * and a "matches the item" check passes. See the `forged item claim` test.
 *
 * WHY `toHaveBeenCalledWith` AND NOT `expect.objectContaining` — part of the
 * property under test is the ABSENCE of `allowReadRoles` on the executing
 * handlers, and `objectContaining` ignores an added key. Do not loosen.
 *
 * MUTATION PROOF — every mutation below was EXECUTED by
 * `temp/mutation-proof-2996-2997.py`, confirmed tsc-valid
 * (`tsc -p tsconfig.build.json --noEmit` exit 0 — `allowUnreachableCode:false`
 * rules out `if (false && …)`), confirmed to turn this suite RED, then
 * restored. Result: 18/18 tsc-CLEAN and RED across both families.
 *
 *   P1. `_lib/pipeline-scope.ts` `authorizeDatabricksPipelineItem` — replace
 *       `if (denied) return { denied };` with `if (denied) void denied;`
 *         → "an unrelated caller is refused" fails on every route, and the
 *           #2996 exploit suite returns to HTTP 200 with the pipeline created.
 *   P2. `_lib/pipeline-scope.ts` — always pass `allowReadRoles: true`
 *         → the strict write-guard-shape assertions fail on the extra key.
 *   P3. `_lib/pipeline-scope.ts` `resolveAuthorizedPipelineId` — return
 *       `{ ok: true, pipelineId }` before `getDltPipeline` resolves its owner
 *         → "refuses a pipelineId owned by another item" fails.
 *   P4. `_lib/pipeline-scope.ts` — short-circuit `{ ok: true, pipelineId: 'x' }`
 *       when `pipelineId` is omitted, instead of deriving the item's binding
 *         → "omitting pipelineId is still authorized" fails.
 *   P5. `_lib/pipeline-scope.ts` `pipelineLibraryPath` — return the SHIPPED
 *       caller-derived path `` `/Shared/loom-dlt/${safe}` ``
 *         → "derives the import path from the ITEM" fails, and the #2996
 *           exploit suite reverts to the shared clobber path.
 *   P6. `_lib/pipeline-scope.ts` `ownerConfiguration` — return `{ ...base }`
 *         → "stamps the created pipeline with its owning item" fails.
 *   P7. `_lib/pipeline-scope.ts` `ownerConfiguration` — spread `base` AFTER the
 *       marker
 *         → "a caller cannot overwrite the marker via model.configuration" fails.
 *   P8. `[id]/spec/route.ts` POST — build `libraryPath` from `model.name`
 *       directly instead of `pipelineLibraryPath(id, …)`
 *         → the write-target tests fail.
 *
 *  (J1–J8 and C1–C2, the `databricks-job` half plus the two shared
 *  `_lib/databricks-resource-binding.ts` mutations, are listed in the sibling
 *  suite `databricks-job/[id]/__tests__/job-scope-authz.test.ts`.)
 *
 *  NOT a valid mutation (recorded by #2995, re-confirmed here): substituting
 *  the raw `body.pipelineId` at the `startDltUpdate` call site while KEEPING
 *  the `if (!bound.ok) return …` early return — the guard still refuses and the
 *  suite correctly stays green. Mutate the control, not the value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

const OURS = 'pl-ours';
const FOREIGN = 'pl-theirs';
const LEGACY = 'pl-legacy'; // real, but carries no Loom ownership marker

const ITEM = {
  id: 'pipe-1',
  itemType: 'databricks-pipeline',
  workspaceId: 'ws-1',
  displayName: 'Sales DLT',
  state: { content: { pipelineId: OURS } },
};

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
  getDltPipeline: vi.fn(async (pipelineId: string) => {
    if (pipelineId === OURS) return { pipeline_id: OURS, spec: { configuration: { loom_item_id: 'pipe-1' } } };
    if (pipelineId === FOREIGN) return { pipeline_id: FOREIGN, spec: { configuration: { loom_item_id: 'other-item' } } };
    if (pipelineId === LEGACY) return { pipeline_id: LEGACY, spec: {} };
    const e: any = new Error('not found'); e.status = 404; throw e;
  }),
  createDltPipelineFromSql: vi.fn(async (_spec: any, libraryPath: string) => ({
    pipeline_id: 'pl-new',
    libraryPath,
  })),
  startDltUpdate: vi.fn(async () => ({ update_id: 'up-1' })),
  stopDltUpdate: vi.fn(async () => undefined),
  getDltPipelineUpdates: vi.fn(async () => [] as any[]),
  getDltPipelineEvents: vi.fn(async () => [] as any[]),
  listDltPipelines: vi.fn(async () => [] as any[]),
  databricksConfigGate: () => null,
}));
vi.mock('@/lib/azure/databricks-client', () => dbx);

import { GET as specGET, POST as specPOST } from '../spec/route';
import { POST as startPOST } from '../start/route';
import { POST as stopPOST } from '../stop/route';
import { GET as updatesGET } from '../updates/route';
import { GET as eventsGET } from '../events/route';

const ctx = { params: Promise.resolve({ id: 'pipe-1' }) } as any;

function req(query: Record<string, string> = {}, body: any = {}) {
  const url = new URL('http://x/');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
}

/** A model that passes `validateDltModel` — the real compiler runs on it. */
const VALID_MODEL = {
  name: 'sales_pipeline',
  continuous: false, development: true, photon: true, serverless: true, channel: 'CURRENT',
  catalog: 'main', target: 'bronze',
  nodes: [
    { id: 'src1', kind: 'source', name: 'raw', sourceKind: 'files', path: 'abfss://raw@a.dfs.core.windows.net/e/', fileFormat: 'json' },
    { id: 'st1', kind: 'streaming_table', name: 'events_bronze' },
  ],
  edges: [{ id: 'e1', source: 'src1', target: 'st1' }],
};

const EXPECTED_WRITE_GUARD = {
  workspaceId: null,
  itemId: 'pipe-1',
  itemType: 'databricks-pipeline',
  notFound: 'databricks pipeline not found',
};
const EXPECTED_READ_GUARD = { ...EXPECTED_WRITE_GUARD, allowReadRoles: true };

async function denyGuard() {
  const { NextResponse } = await import('next/server');
  guard.authorizeItemWorkspace.mockResolvedValue(
    NextResponse.json({ ok: false, error: 'databricks pipeline not found' }, { status: 404 }) as any,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null as any);
  cosmos.itemRows = [ITEM as any];
  cosmos.competingClaims = 0;
  cosmos.queries = [];
});

// ── LAYER 1 ──────────────────────────────────────────────────────────────────

describe('layer 1 — caller authorization', () => {
  it('an unrelated caller is refused and never reaches Databricks', async () => {
    await denyGuard();

    expect((await specPOST(req({}, { model: VALID_MODEL }), ctx)).status).toBe(404);
    expect((await specGET(req({ pipelineId: OURS }), ctx)).status).toBe(404);
    expect((await startPOST(req({}, { pipelineId: OURS }), ctx)).status).toBe(404);
    expect((await stopPOST(req({}, { pipelineId: OURS }), ctx)).status).toBe(404);
    expect((await updatesGET(req({ pipelineId: OURS }), ctx)).status).toBe(404);
    expect((await eventsGET(req({ pipelineId: OURS }), ctx)).status).toBe(404);

    expect(dbx.createDltPipelineFromSql).not.toHaveBeenCalled();
    expect(dbx.startDltUpdate).not.toHaveBeenCalled();
    expect(dbx.stopDltUpdate).not.toHaveBeenCalled();
    expect(dbx.getDltPipeline).not.toHaveBeenCalled();
  });

  it('the EXECUTING handlers are WRITE-scoped — no allowReadRoles key', async () => {
    await specPOST(req({}, { model: VALID_MODEL }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await startPOST(req({}, { pipelineId: OURS }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await stopPOST(req({}, { pipelineId: OURS }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_WRITE_GUARD);
  });

  it('the strictly read-only handlers opt in to read roles — decided per BODY', async () => {
    await updatesGET(req({ pipelineId: OURS }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);

    vi.clearAllMocks();
    guard.authorizeItemWorkspace.mockResolvedValue(null as any);
    await eventsGET(req({ pipelineId: OURS }), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, EXPECTED_READ_GUARD);
  });

  it('an id naming no item is refused, not fallen through to Databricks', async () => {
    cosmos.itemRows = [];
    const res = await specPOST(req({}, { model: VALID_MODEL }), ctx);
    expect(res.status).toBe(404);
    expect(dbx.createDltPipelineFromSql).not.toHaveBeenCalled();
  });
});

// ── LAYER 2a — the WRITE TARGET is no longer caller-influenced ───────────────

describe('layer 2 — the spec POST write target', () => {
  it('derives the import path from the ITEM, so overwrite cannot clobber another tenant', async () => {
    const res = await specPOST(req({}, { model: VALID_MODEL }), ctx);
    expect(res.status).toBe(200);

    const [, libraryPath] = dbx.createDltPipelineFromSql.mock.calls[0] as any[];
    // Pre-fix this was `/Shared/loom-dlt/sales_pipeline` — a path any tenant
    // could address by naming their model `sales_pipeline`, then overwrite.
    expect(libraryPath).toBe('/Shared/loom-dlt/pipe-1/sales_pipeline');
  });

  it('a hostile model name cannot escape the item folder', async () => {
    await specPOST(req({}, { model: { ...VALID_MODEL, name: '../../Shared/victim/etl' } }), ctx);
    const [, libraryPath] = dbx.createDltPipelineFromSql.mock.calls[0] as any[];
    expect(libraryPath.startsWith('/Shared/loom-dlt/pipe-1/')).toBe(true);
    expect(libraryPath).not.toContain('..');
  });

  it('stamps the created pipeline with its owning item', async () => {
    await specPOST(req({}, { model: VALID_MODEL }), ctx);
    const [spec] = dbx.createDltPipelineFromSql.mock.calls[0] as any[];
    expect(spec.configuration).toEqual({ loom_item_id: 'pipe-1' });
  });

  it('a caller cannot overwrite the marker via model.configuration', async () => {
    await specPOST(
      req({}, { model: { ...VALID_MODEL, configuration: { loom_item_id: 'other-item', tier: 'gold' } } }),
      ctx,
    );
    const [spec] = dbx.createDltPipelineFromSql.mock.calls[0] as any[];
    expect(spec.configuration).toEqual({ tier: 'gold', loom_item_id: 'pipe-1' });
  });
});

// ── LAYER 2b — the pipelineId coordinate ─────────────────────────────────────

describe('layer 2 — pipelineId binding', () => {
  it('refuses a pipelineId owned by another item (spec GET / start / stop / updates / events)', async () => {
    const start = await startPOST(req({}, { pipelineId: FOREIGN }), ctx);
    expect(start.status).toBe(403);
    expect((await start.json()).error).toBe('that Databricks resource belongs to a different Loom item.');

    expect((await specGET(req({ pipelineId: FOREIGN }), ctx)).status).toBe(403);
    expect((await stopPOST(req({}, { pipelineId: FOREIGN }), ctx)).status).toBe(403);
    expect((await updatesGET(req({ pipelineId: FOREIGN }), ctx)).status).toBe(403);
    expect((await eventsGET(req({ pipelineId: FOREIGN }), ctx)).status).toBe(403);

    expect(dbx.startDltUpdate).not.toHaveBeenCalled();
    expect(dbx.stopDltUpdate).not.toHaveBeenCalled();
    expect(dbx.getDltPipelineUpdates).not.toHaveBeenCalled();
    expect(dbx.getDltPipelineEvents).not.toHaveBeenCalled();
  });

  it('a forged item claim does not confer ownership — the RESOURCE attests, not the item', async () => {
    cosmos.itemRows = [{ ...ITEM, state: { content: { pipelineId: FOREIGN } } } as any];
    const res = await startPOST(req({}, {}), ctx);
    expect(res.status).toBe(403);
    expect(dbx.startDltUpdate).not.toHaveBeenCalled();
  });

  it('omitting pipelineId is still authorized, not skipped — it derives the item binding', async () => {
    const res = await startPOST(req({}, { fullRefresh: true }), ctx);
    expect(res.status).toBe(202);
    expect(dbx.getDltPipeline).toHaveBeenCalledWith(OURS);
    expect(dbx.startDltUpdate).toHaveBeenCalledWith(OURS, true);
  });

  it('omitting pipelineId on an UNBOUND item refuses instead of falling through', async () => {
    cosmos.itemRows = [{ ...ITEM, state: {} } as any];
    const res = await startPOST(req({}, {}), ctx);
    expect(res.status).toBe(409);
    expect(dbx.startDltUpdate).not.toHaveBeenCalled();
  });

  it('accepts the pipeline this item genuinely owns', async () => {
    expect((await stopPOST(req({}, { pipelineId: OURS }), ctx)).status).toBe(200);
    expect(dbx.stopDltUpdate).toHaveBeenCalledWith(OURS);
  });
});

// ── Legacy (unmarked) pipelines ──────────────────────────────────────────────

describe('legacy adoption', () => {
  beforeEach(() => {
    cosmos.itemRows = [{ ...ITEM, state: { content: { pipelineId: LEGACY } } } as any];
  });

  it('adopts an unmarked pipeline when this item is its only claimant', async () => {
    cosmos.competingClaims = 0;
    const res = await startPOST(req({}, {}), ctx);
    expect(res.status).toBe(202);
    expect(dbx.startDltUpdate).toHaveBeenCalledWith(LEGACY, false);
    expect(cosmos.queries.some((q) => q.includes('COUNT(1)'))).toBe(true);
  });

  it('an unmarked pipeline claimed by two items is refused — ambiguity is not ownership', async () => {
    cosmos.competingClaims = 1;
    const res = await startPOST(req({}, {}), ctx);
    expect(res.status).toBe(409);
    expect(dbx.startDltUpdate).not.toHaveBeenCalled();
  });
});
