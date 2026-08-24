/**
 * /api/admin/brain/history — AUTHORIZATION, proven against the REAL wrapper,
 * plus the honest states the route must not collapse into "no changes".
 *
 * ── WHY THE OBVIOUS VERSION OF THE AUTHZ TEST IS WORTHLESS ─────────────────
 * The common pattern in this repo mocks `withTenantAdmin` itself and
 * re-implements the guard inside the mock. That asserts the guard the TEST
 * wrote. Delete `if (gate) return gate;` from `lib/api/route-toolkit.ts` and it
 * stays green, because the shipped line never runs. Measured on 2026-08-07:
 * removing exactly that line left three route guards reporting green.
 *
 * So this file does NOT mock the wrapper. It mocks only the two leaves BENEATH
 * it — `getSession` (who is calling) and `requireTenantAdmin` (are they an
 * admin) — and runs the real `withSession` -> `requireTenantAdmin` ->
 * `if (gate) return gate` -> handler composition from the shipped module.
 *
 * THE MUTATION AND ITS MEASURED RESULT are recorded in the PR body. If you edit
 * this file, re-run it: a guard whose verdict does not move when its subject is
 * broken is not watching anything.
 *
 * ── THE OTHER HALF: EVERY EMPTY ANSWER STATES WHY IT IS EMPTY ──────────────
 * A history endpoint has three ways to return nothing, and only one of them
 * means the estate is unchanged:
 *
 *     no versions retained          -> no BASIS. Must not read as "no changes".
 *     one version retained          -> no BASIS either.
 *     a corrupt version in the way  -> REFUSED. Must not read as mass deletion.
 *
 * Each is asserted below, because collapsing any of them into a clean 200 with
 * empty lists is the 2026-08-05 incident's exact shape.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { InMemoryGraphHistoryStore } from '../store';

// ── the two authorization leaves, and ONLY these ───────────────────────────
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, getSession: vi.fn() };
});
vi.mock('@/lib/auth/feature-gate', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/feature-gate')>('@/lib/auth/feature-gate');
  return { ...actual, requireTenantAdmin: vi.fn(() => null) };
});

// ── the backing store: the REAL in-memory implementation of the REAL contract,
//    swapped in for Cosmos. Not a stub — every store property under test
//    (dedupe, retention, ordering) is exercised for real.
const H = vi.hoisted(() => ({
  store: null as InMemoryGraphHistoryStore | null,
  collectCalls: 0,
  storeReads: 0,
}));

vi.mock('@/lib/brain/history/cosmos-store', () => ({
  BrainHistoryNotConfiguredError: class extends Error {},
  CosmosGraphHistoryStore: class {
    constructor() {
      H.storeReads += 1;
      return H.store as never;
    }
  },
}));

// The estate id is env-derived in production; pinned here so the fixtures and
// the route agree on a partition key.
vi.mock('@/lib/estate/pause-orchestrator', () => ({ resolveEstateId: () => 'estate-alpha' }));

vi.mock('@/app/api/admin/brain/_lib/arg-collect', async () => {
  const fixtures = await import('./fixtures');
  return {
    ResourceGraphCollectionError: class extends Error {
      status = 500;
      detail = '';
    },
    collectEstate: async () => {
      H.collectCalls += 1;
      return {
        rows: [
          fixtures.appRow({ name: 'loom-console', minReplicas: 2, external: true }),
          fixtures.appRow({ name: 'loom-capacity-broker', minReplicas: 2 }),
        ],
        stats: {
          rowsFetched: 2,
          totalRecords: 2,
          pages: 1,
          complete: true,
          subscriptionsSeen: 1,
          durationMs: 5,
          cloud: 'Commercial',
          truncatedByPageCap: false,
        },
      };
    },
  };
});

import { GET, POST } from '@/app/api/admin/brain/history/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { BASELINE, ESTATE, versionFrom, type EstateSpec } from './fixtures';

const ADMIN = {
  claims: { oid: 'oid-1', upn: 'admin@example.test', tid: 'tid-1', name: 'Admin' },
  exp: 9_999_999_999,
};

/** The canonical 403 the real `requireTenantAdmin` returns for a non-admin. */
function adminOnly403() {
  return NextResponse.json({ ok: false, error: 'admin_only' }, { status: 403 });
}

function req(search = '') {
  return { nextUrl: new URL(`http://x/api/admin/brain/history${search}`) } as never;
}
const ctx = { params: Promise.resolve({}) } as never;

function asMock(fn: unknown) {
  return fn as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
  H.store = new InMemoryGraphHistoryStore();
  H.collectCalls = 0;
  H.storeReads = 0;
  asMock(requireTenantAdmin).mockReturnValue(null);
  asMock(getSession).mockReturnValue(ADMIN);
});

describe('GET — the REAL withTenantAdmin', () => {
  it('401s with no session, and never touches the store', async () => {
    asMock(getSession).mockReturnValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);
    expect(H.storeReads).toBe(0);
  });

  it('403s for a signed-in NON-admin — THE MUTATION TARGET', async () => {
    asMock(requireTenantAdmin).mockReturnValue(adminOnly403());
    const res = await GET(req(), ctx);
    // Delete `if (gate) return gate;` in lib/api/route-toolkit.ts and this reads
    // 200 instead of 403.
    expect(res.status).toBe(403);
    // The stronger claim: the handler body never ran. A guard that denies AFTER
    // doing the work has still done the work.
    expect(H.storeReads).toBe(0);
  });

  it('serves a tenant admin — the positive control', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(H.storeReads).toBeGreaterThan(0);
  });

  it('consults the guard on every call, with the real session', async () => {
    await GET(req(), ctx);
    expect(requireTenantAdmin).toHaveBeenCalledTimes(1);
    expect(requireTenantAdmin).toHaveBeenCalledWith(ADMIN);
  });
});

describe('POST — the REAL withTenantAdmin', () => {
  it('401s with no session, and never pulls the estate', async () => {
    asMock(getSession).mockReturnValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
    expect(H.collectCalls).toBe(0);
  });

  it('403s for a signed-in NON-admin, and writes nothing — THE MUTATION TARGET', async () => {
    asMock(requireTenantAdmin).mockReturnValue(adminOnly403());
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    // An unauthorized caller must not be able to drive a Resource Graph pull,
    // nor append to the estate's history.
    expect(H.collectCalls).toBe(0);
    expect(await H.store!.listSummaries(ESTATE)).toEqual([]);
  });

  it('captures for a tenant admin — the positive control', async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; mutatedAzure: boolean };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('created');
    expect(body.mutatedAzure).toBe(false);
    expect((await H.store!.listSummaries(ESTATE))).toHaveLength(1);
  });

  it('a second identical capture writes nothing', async () => {
    await POST(req(), ctx);
    const res = await POST(req(), ctx);
    const body = (await res.json()) as { status: string; unchangedReason: string };
    expect(body.status).toBe('unchanged');
    expect(body.unchangedReason).toBe('identical-digest');
    expect((await H.store!.listSummaries(ESTATE))).toHaveLength(1);
  });
});

describe('honest empty states — none of them is "no changes"', () => {
  it('an EMPTY history says it has no basis, and is marked blind', async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versions: unknown[];
      population: { blind: boolean; versionsRetained: number };
      note: string;
      diff?: unknown;
    };
    expect(body.versions).toEqual([]);
    expect(body.population.blind).toBe(true);
    expect(body.population.versionsRetained).toBe(0);
    expect(body.note).toContain('not a clean estate');
    // No diff is fabricated out of a single snapshot.
    expect(body.diff).toBeUndefined();
  });

  it('ONE retained version is also blind, not clean', async () => {
    await POST(req(), ctx);
    const res = await GET(req(), ctx);
    const body = (await res.json()) as {
      population: { blind: boolean; versionsExamined: number };
      note: string;
      diff?: unknown;
    };
    expect(body.population.blind).toBe(true);
    expect(body.population.versionsExamined).toBe(1);
    expect(body.note).toContain('second capture is required');
    expect(body.diff).toBeUndefined();
  });

  it('TWO versions produce a real diff with a non-blind population', async () => {
    const older = versionFrom(BASELINE, '2026-08-20T09:00:00.000Z');
    const CHANGED: EstateSpec = {
      ...BASELINE,
      apps: [...BASELINE.apps, { name: 'loom-new', minReplicas: 1 }],
    };
    const newer = versionFrom(CHANGED, '2026-08-22T09:00:00.000Z');
    await H.store!.append(older);
    await H.store!.append(newer);

    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      population: { blind: boolean; versionsExamined: number; nodesPerVersion: number[] };
      newEdges: unknown[];
      newNodes: unknown[];
      retention: { maxVersions: number; ttlSeconds: number };
    };
    expect(body.population.blind).toBe(false);
    expect(body.population.versionsExamined).toBe(2);
    expect(body.population.nodesPerVersion).toEqual([older.counts.nodes, newer.counts.nodes]);
    expect(body.newNodes).toHaveLength(1);
    expect(body.newEdges.length).toBeGreaterThan(0);
    // Retention is STATED on every read, not buried in a comment.
    expect(body.retention.maxVersions).toBeGreaterThan(0);
    expect(body.retention.ttlSeconds).toBeGreaterThan(0);
  });
});

describe('fail closed — the route refuses rather than reporting a catastrophe', () => {
  it('a CORRUPT retained version returns an honest 500, not a mass deletion', async () => {
    const older = versionFrom(BASELINE, '2026-08-20T09:00:00.000Z');
    const CHANGED: EstateSpec = {
      ...BASELINE,
      apps: [...BASELINE.apps, { name: 'loom-new', minReplicas: 1 }],
    };
    const newer = versionFrom(CHANGED, '2026-08-22T09:00:00.000Z');
    // Truncate the BASE — the corruption that would otherwise render as every
    // missing node having been deleted.
    await H.store!.append({
      ...older,
      content: { ...older.content, nodes: older.content.nodes.slice(0, 1) },
    });
    await H.store!.append(newer);

    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('REFUSED');
    expect(body.error).toContain('brain-graph-versions');
    // The failure mode being prevented, named: the truncated base held 1 node
    // of several, so an unguarded diff would have reported the rest as removed.
    expect(older.content.nodes.length).toBeGreaterThan(1);
  });

  it('an unknown ?base= is a 400 naming what IS retained, not a whole-estate diff', async () => {
    const older = versionFrom(BASELINE, '2026-08-20T09:00:00.000Z');
    const CHANGED: EstateSpec = {
      ...BASELINE,
      apps: [...BASELINE.apps, { name: 'loom-new', minReplicas: 1 }],
    };
    await H.store!.append(older);
    await H.store!.append(versionFrom(CHANGED, '2026-08-22T09:00:00.000Z'));

    const res = await GET(req('?base=not-a-version'), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; available: string[] };
    expect(body.error).toBe('unknown_base_version');
    expect(body.available).toContain(older.id);
  });
});
