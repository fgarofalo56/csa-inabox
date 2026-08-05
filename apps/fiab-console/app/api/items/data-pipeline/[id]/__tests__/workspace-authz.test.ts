/**
 * #2947 — route-level proof for the `assertOwner` → `authorizeItemWorkspace`
 * migration, on the data-pipeline detail route (the family with the largest
 * number of migrated call sites).
 *
 * WHY `toHaveBeenCalledWith` AND NOT `expect.objectContaining`. The security
 * property under test is the ABSENCE of one key. `objectContaining` ignores
 * extra keys, so a one-word change adding `allowReadRoles: true` to the PUT or
 * DELETE guard — which would let a read-only Viewer overwrite or delete another
 * user's pipeline and its live ADF backing — would leave such an assertion
 * GREEN. `toHaveBeenCalledWith` is a deep equality on the whole argument, so an
 * added key fails. Do not loosen these.
 *
 * MUTATION PROOF (run any of these; each turns this file RED):
 *   1. add `allowReadRoles: true` to the PUT/DELETE guard  → the strict-shape
 *      assertions fail on the extra key.
 *   2. drop `allowReadRoles: true` from the GET guard      → the GET assertion
 *      fails (and the #2941 bug — non-creators cannot read — returns).
 *   3. make the guard return a 404 and the handler ignore it → the "denied
 *      short-circuits" assertions fail (the backend is never reached).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const SESSION = { claims: { oid: 'oid-caller', tid: 'tid-1', upn: 'u@loom.test', groups: [] } } as any;

vi.mock('@/lib/auth/session', () => ({ getSession: () => SESSION }));

const guard = vi.hoisted(() => ({ authorizeItemWorkspace: vi.fn(async () => null as any) }));
vi.mock('@/lib/auth/workspace-guard', () => guard);

const cosmos = vi.hoisted(() => ({
  read: vi.fn(async () => ({
    resource: {
      id: 'pipe-1',
      itemType: 'data-pipeline',
      workspaceId: 'ws-1',
      displayName: 'P',
      state: { adfPipelineName: 'P_abc123' },
    },
  })),
  replace: vi.fn(async (doc: any) => ({ resource: doc })),
  del: vi.fn(async () => ({})),
}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    item: () => ({ read: cosmos.read, replace: cosmos.replace, delete: cosmos.del }),
  }),
}));

const adf = vi.hoisted(() => ({
  getPipeline: vi.fn(async () => ({ name: 'P_abc123', properties: { activities: [] } })),
  upsertPipeline: vi.fn(async () => ({})),
  deletePipeline: vi.fn(async () => ({})),
  adfConfigGate: vi.fn(() => null as any),
}));
vi.mock('@/lib/azure/adf-client', () => adf);
vi.mock('@/lib/azure/pipeline-binding', () => ({ pipelineDefinitionFromContent: () => null }));

import { GET, PUT, DELETE } from '../route';

const ctx = { params: Promise.resolve({ id: 'pipe-1' }) } as any;
function req(body?: any) {
  const url = new URL('https://loom.test/api/items/data-pipeline/pipe-1?workspaceId=ws-1');
  return { nextUrl: url, url: url.toString(), json: async () => body ?? {} } as any;
}

/** The one shape every data-pipeline guard call must have, minus the scope key. */
const BASE = { workspaceId: 'ws-1', itemId: 'pipe-1', itemType: 'data-pipeline', notFound: 'pipeline not found' };

beforeEach(() => {
  vi.clearAllMocks();
  guard.authorizeItemWorkspace.mockResolvedValue(null);
  cosmos.read.mockResolvedValue({
    resource: {
      id: 'pipe-1', itemType: 'data-pipeline', workspaceId: 'ws-1',
      displayName: 'P', state: { adfPipelineName: 'P_abc123' },
    },
  } as any);
});

describe('#2947 data-pipeline/[id] runs the canonical ladder, correctly scoped', () => {
  it('GET is READ-scoped — exactly { …, allowReadRoles: true } and nothing more', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledTimes(1);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, {
      ...BASE,
      allowReadRoles: true,
    });
  });

  it('PUT is WRITE-scoped — the exact opts, WITHOUT allowReadRoles', async () => {
    const res = await PUT(req({ displayName: 'P2' }), ctx);
    expect(res.status).toBe(200);
    // Deep equality: an added `allowReadRoles` key fails here. That key would
    // let a read-only Viewer rewrite the pipeline definition AND push it to the
    // live ADF factory (upsertPipeline below).
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, BASE);
  });

  it('DELETE is WRITE-scoped — the exact opts, WITHOUT allowReadRoles', async () => {
    await DELETE(req(), ctx);
    expect(guard.authorizeItemWorkspace).toHaveBeenCalledWith(SESSION, BASE);
  });

  it('a denied caller gets the route wording and the ADF/Cosmos backend is never touched', async () => {
    // A FRESH response per call — a single shared NextResponse can only have
    // its body read once, which would fail for reasons unrelated to the guard.
    guard.authorizeItemWorkspace.mockImplementation(
      async () => NextResponse.json({ ok: false, error: 'pipeline not found' }, { status: 404 }) as any,
    );
    for (const [name, call] of [
      ['GET', () => GET(req(), ctx)],
      ['PUT', () => PUT(req({ definition: { properties: { activities: [] } } }), ctx)],
      ['DELETE', () => DELETE(req(), ctx)],
    ] as const) {
      const res = await call();
      expect(res.status, name).toBe(404);
      expect(await res.json(), name).toEqual({ ok: false, error: 'pipeline not found' });
    }
    expect(cosmos.read).not.toHaveBeenCalled();
    expect(cosmos.replace).not.toHaveBeenCalled();
    expect(cosmos.del).not.toHaveBeenCalled();
    expect(adf.upsertPipeline).not.toHaveBeenCalled();
    expect(adf.deletePipeline).not.toHaveBeenCalled();
  });

  it('authorization is not skippable: no workspaceId → 400 before any backend call', async () => {
    // These routes REQUIRE the param (unlike the three #2946 fixed, which used
    // the `workspaceId && …` shape), so the caller cannot reach a handler body
    // with the guard un-run. Proven, not assumed.
    const url = new URL('https://loom.test/api/items/data-pipeline/pipe-1');
    const bare = { nextUrl: url, url: url.toString(), json: async () => ({}) } as any;
    for (const call of [() => GET(bare, ctx), () => PUT(bare, ctx), () => DELETE(bare, ctx)]) {
      const res = await call();
      expect(res.status).toBe(400);
    }
    expect(guard.authorizeItemWorkspace).not.toHaveBeenCalled();
    expect(cosmos.read).not.toHaveBeenCalled();
    expect(adf.upsertPipeline).not.toHaveBeenCalled();
  });
});
