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
  /** #4016 — whether the mocked Resource Graph pull reports itself complete. */
  collectionComplete: true,
  /**
   * What the mocked pull says the service reported, `null` for "it did not say".
   *
   * DRIVABLE, because the refusal's message branches on it and a fixture pinned
   * to a single non-zero value cannot reach either of the other two arms. A
   * REPORTED 0 and an UNREPORTED total are different facts and the refusal has
   * to say which one it saw.
   */
  collectionTotalRecords: 2 as number | null,
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
          rowsFetched: H.collectionComplete ? 2 : 1,
          totalRecords: H.collectionTotalRecords,
          pages: 1,
          // #4016: drivable, so the INCOMPLETE arm is reachable. A stat the
          // fixture pins to `true` makes the refusal below untestable, which is
          // how the old post-hoc `warning` shipped with no coverage at all.
          complete: H.collectionComplete,
          subscriptionsSeen: 1,
          durationMs: 5,
          cloud: 'Commercial',
          truncatedByPageCap: !H.collectionComplete,
        },
      };
    },
  };
});

import { GET, POST } from '@/app/api/admin/brain/history/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { BASELINE, ESTATE, nodeIdOf, versionFrom, type EstateSpec } from './fixtures';

const ADMIN = {
  claims: { oid: 'oid-1', upn: 'admin@example.test', tid: 'tid-1', name: 'Admin' },
  exp: 9_999_999_999,
};

/** The canonical 403 the real `requireTenantAdmin` returns for a non-admin. */
function adminOnly403() {
  return NextResponse.json({ ok: false, error: 'admin_only' }, { status: 403 });
}

/**
 * THE REQUEST FIXTURE CARRIES ITS VERB.
 *
 * It did not, and that omission had teeth: with `method` absent, a mutation
 * making `withTenantAdmin` skip the gate when `req.method === 'POST'` passed
 * this whole suite RC=0 — an authorization bypass, escaped, because
 * `undefined === 'POST'` is false in every spec. Hard-coding `'POST'` would
 * only move the blind spot to a GET-keyed bypass, so each verb's specs send
 * their own verb and both bypass shapes are now reachable.
 */
function req(search = '', method: 'GET' | 'POST' = 'GET') {
  return { method, nextUrl: new URL(`http://x/api/admin/brain/history${search}`) } as never;
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
  H.collectionComplete = true;
  H.collectionTotalRecords = 2;
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
    const res = await POST(req('', 'POST'), ctx);
    expect(res.status).toBe(401);
    expect(H.collectCalls).toBe(0);
  });

  it('403s for a signed-in NON-admin, and writes nothing — THE MUTATION TARGET', async () => {
    asMock(requireTenantAdmin).mockReturnValue(adminOnly403());
    const res = await POST(req('', 'POST'), ctx);
    expect(res.status).toBe(403);
    // An unauthorized caller must not be able to drive a Resource Graph pull,
    // nor append to the estate's history.
    expect(H.collectCalls).toBe(0);
    expect(await H.store!.listSummaries(ESTATE)).toEqual([]);
  });

  it('captures for a tenant admin — the positive control', async () => {
    const res = await POST(req('', 'POST'), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; mutatedAzure: boolean };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('created');
    expect(body.mutatedAzure).toBe(false);
    expect((await H.store!.listSummaries(ESTATE))).toHaveLength(1);
  });

  it('a second identical capture writes nothing', async () => {
    await POST(req('', 'POST'), ctx);
    const res = await POST(req('', 'POST'), ctx);
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
    await POST(req('', 'POST'), ctx);
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

/**
 * ── THE READ WINDOW IS A COST BOUND, NOT A CORRECTNESS BOUND ───────────────
 *
 * `READ_WINDOW` is 8; retention keeps up to 50. Every other spec in this file
 * builds at most 3 versions, so the whole region past the window was untested —
 * and in it, `?base=<a retained id>` returned 400 `unknown_base_version` whose
 * message asserted TWO things the code had not established: that no retained
 * version had that id (it did) and that 8 were retained (12 were). The
 * response's own `versions` array listed all 12 ids at the same time.
 *
 * These specs build MORE versions than the window and ask for a base outside
 * it, which is the only way to reach that region at all.
 */
describe('a base OUTSIDE the read window — deploy-integrity R7', () => {
  const RETAINED = 12; // > READ_WINDOW (8), < the retention ceiling (50)

  /** Twelve genuinely different estates, one per day, oldest first. */
  function twelve() {
    return Array.from({ length: RETAINED }, (_, i) => {
      const spec: EstateSpec = {
        ...BASELINE,
        apps: [
          ...BASELINE.apps,
          ...Array.from({ length: i }, (_, k) => ({ name: `loom-w${k + 1}`, minReplicas: 1 })),
        ],
      };
      // 2026-08-01T09:00Z + i days. Distinct instants -> distinct version ids.
      const day = String(i + 1).padStart(2, '0');
      return versionFrom(spec, `2026-08-${day}T09:00:00.000Z`);
    });
  }

  async function seed() {
    const versions = twelve();
    for (const v of versions) await H.store!.append(v);
    return versions;
  }

  it('resolves a RETAINED base the window never loaded, instead of calling it unknown', async () => {
    const versions = await seed();
    const oldest = versions[0];
    const head = versions[versions.length - 1];

    // The premise, asserted rather than assumed: the default read reports all
    // 12 as retained while loading only the newest 8.
    const def = await GET(req(), ctx);
    expect(def.status).toBe(200);
    const defBody = (await def.json()) as {
      versions: { id: string }[];
      readWindow: number;
      newNodes: unknown[];
    };
    expect(defBody.versions.map((v) => v.id)).toContain(oldest.id);
    expect(defBody.versions).toHaveLength(RETAINED);
    expect(defBody.readWindow).toBeLessThan(RETAINED);

    const res = await GET(req(`?base=${encodeURIComponent(oldest.id)}`), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      base: { id: string };
      head: { id: string };
      newNodes: { id: string }[];
      baseResolvedOutsideReadWindow: boolean;
      population: { versionsRetained: number; blind: boolean };
      note: string;
    };
    expect(body.base.id).toBe(oldest.id);
    expect(body.head.id).toBe(head.id);
    expect(body.baseResolvedOutsideReadWindow).toBe(true);
    // The retained count is the STORE's, never the window's.
    expect(body.population.versionsRetained).toBe(RETAINED);
    expect(body.population.blind).toBe(false);
    // The answer really did reach back: every app added since the oldest
    // version is new relative to it — strictly more than the default question,
    // which only reaches the start of the window.
    expect(body.newNodes.length).toBe(RETAINED - 1);
    expect(body.newNodes.length).toBeGreaterThan(defBody.newNodes.length);
    // The control from the fixtures: wired and untouched in every version, so
    // it must never appear as new no matter how far back the base is.
    expect(body.newNodes.map((n) => n.id)).not.toContain(nodeIdOf('loom-direct-lake'));
    // The out-of-window read is DISCLOSED, not silent.
    expect(body.note).toContain('OUTSIDE that window');
  });

  it('a base id that is genuinely not retained is still refused — with the RETAINED count', async () => {
    const versions = await seed();

    const res = await GET(req('?base=not-a-version'), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      detail: string;
      available: string[];
      retainedCount: number;
    };
    expect(body.error).toBe('unknown_base_version');
    expect(body.retainedCount).toBe(RETAINED);
    expect(body.available).toHaveLength(RETAINED);
    expect(body.detail).toContain(`${RETAINED} version(s) are retained`);
    // The window size must never be quoted as the retained count — the exact
    // false claim this describe block exists for.
    expect(body.detail).not.toContain('8 version(s) are retained');
    expect(body.detail).toContain('REFUSING');
    // Fail closed: no diff is fabricated from an unresolvable base.
    expect((body as unknown as { diff?: unknown }).diff).toBeUndefined();
    expect(versions).toHaveLength(RETAINED);
  });
});

// ---------------------------------------------------------------------------
// #4016 — an INCOMPLETE Resource Graph pull is never stored as a version
// ---------------------------------------------------------------------------

describe('#4016 — POST REFUSES to record a partial estate', () => {
  it('EMBEDDED CONTROL: with a COMPLETE pull the same call WRITES a version', () => {
    // Without this the refusal below is indistinguishable from a route that
    // never writes at all.
    return (async () => {
      const res = await POST(req('', 'POST'), ctx);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.status).toBe('created');
      expect((await H.store!.listSummaries(ESTATE)).length).toBe(1);
    })();
  });

  it('an INCOMPLETE pull returns ok:false and writes NOTHING', async () => {
    H.collectionComplete = false;
    const before = (await H.store!.listSummaries(ESTATE)).length;
    const res = await POST(req('', 'POST'), ctx);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('incomplete_collection');
    // THE POINT: the store is untouched. A version that recorded a partial
    // estate would make every later diff report the unread remainder as a change.
    expect((await H.store!.listSummaries(ESTATE)).length).toBe(before);
  });

  it('the refusal states the NUMBERS it established, not a generic failure', async () => {
    H.collectionComplete = false;
    const body = await (await POST(req('', 'POST'), ctx)).json();
    expect(body.detail).toMatch(/1 row\(s\) were read of 2/);
    expect(body.detail).toMatch(/NOTHING was written/);
    expect(body.collection.complete).toBe(false);
    expect(body.mutatedAzure).toBe(false);
  });

  // ── R7: A REPORTED 0 IS NOT AN UNREPORTED TOTAL ──────────────────────────
  //
  // The refusal's message branches on `totalRecords`, and the three arms are
  // different FACTS: the service said N, the service said 0, the service said
  // nothing. A guard of `!== null && > 0` collapses the middle arm into the
  // last one and makes the message assert an absence the code never
  // established — while throwing away the most diagnostic thing it knows.
  //
  // Pinned here because the arms are only reachable now that the mock's
  // `totalRecords` is drivable: with it frozen at 2, the reported-0 and
  // unreported branches had no coverage at all and the false claim shipped.

  it('a REPORTED total of 0 is stated as 0 — never as "did not report a total"', async () => {
    H.collectionComplete = false;
    H.collectionTotalRecords = 0;
    const body = await (await POST(req('', 'POST'), ctx)).json();

    // THE POINT: the service DID report, and it reported 0. Saying otherwise is
    // an R7 message-truth violation, and it drops the whole diagnosis — we read
    // rows the service says do not exist.
    expect(body.detail).toMatch(/1 row\(s\) were read of 0 the service reported/);
    expect(body.detail).not.toMatch(/did not report a total/);
    expect(body.collection.totalRecords).toBe(0);
    expect(body.collection.complete).toBe(false);
  });

  it('an UNREPORTED total says so, and quotes no number', async () => {
    // The other side of the same coin, and the reason the fix is `!== null`
    // rather than a different threshold: this arm must keep working.
    H.collectionComplete = false;
    H.collectionTotalRecords = null;
    const body = await (await POST(req('', 'POST'), ctx)).json();

    expect(body.detail).toMatch(/1 row\(s\) were read, and the service did not report a total/);
    expect(body.detail).not.toMatch(/the service reported/);
    expect(body.collection.totalRecords).toBeNull();
  });

  it('a COMPLETE pull records its completeness ON the version', async () => {
    // The flag has to outlive the response. The old implementation put it in a
    // `warning` string that only the caller of that one POST ever saw.
    await POST(req('', 'POST'), ctx);
    const [summary] = await H.store!.listSummaries(ESTATE);
    expect(summary.collection).toEqual({ complete: true, rowsFetched: 2, totalRecords: 2 });
  });

  it('GET still answers after a refused POST — the read side is unaffected', async () => {
    H.collectionComplete = false;
    await POST(req('', 'POST'), ctx);
    const res = await GET(req('', 'GET'), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
