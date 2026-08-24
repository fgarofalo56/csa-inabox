/**
 * AUTHORIZATION ON THE SYNAPSES ROUTE — proven against the REAL wrapper, with a
 * mutation that must turn this file red.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM `authz-mutation.test.ts` ──────────
 * That file proves the two ORIGINAL Brain routes are guarded. It says nothing
 * about a route added afterwards, and "the sibling route is guarded" is exactly
 * the reasoning that lets an unguarded one ship. #3934 adds
 * `GET /api/admin/brain/synapses`; this file is that route's own receipt.
 *
 * ── WHY THE OBVIOUS VERSION OF THIS TEST WOULD BE WORTHLESS ───────────────
 * The established pattern elsewhere in this repo mocks `withTenantAdmin` itself
 * and re-implements the guard inside the mock:
 *
 *     vi.mock('@/lib/api/route-toolkit', () => ({
 *       withTenantAdmin: (h) => async (req, ctx) => {
 *         const gate = requireTenantAdmin(session);
 *         if (gate) return gate;         // <- the TEST's copy of the guard
 *         return h(req, ctx);
 *       },
 *     }));
 *
 * That asserts the guard the TEST wrote. Delete `if (gate) return gate;` from
 * `lib/api/route-toolkit.ts` and it stays green, because the shipped line never
 * executes. This repo has already been bitten by precisely that: removing one
 * such line left three route guards reporting green over defeated authorization.
 *
 * So this file mocks ONLY the two leaves beneath the wrapper — `getSession` (who
 * is calling) and `requireTenantAdmin` (are they an admin) — and runs the real
 * `withSession` -> `requireTenantAdmin` -> `if (gate) return gate` -> handler
 * composition from the shipped module.
 *
 * ── THE MUTATION, AND THE MEASURED RESULT ─────────────────────────────────
 * Mutation: delete `if (gate) return gate;` from `withTenantAdmin` in
 * `lib/api/route-toolkit.ts` (line 169 at the time of writing).
 *
 *     clean    RC=0   8 passed
 *     mutated  RC=1   1 failed, 7 passed — the 403 spec returns 200 instead
 *
 * Both RCs are recorded in the PR body. If you change this file, RE-RUN the
 * mutation: a guard whose verdict does not move when its subject is broken is
 * not watching anything.
 *
 * ── NOTE ON THE NEEDLE (a landmine in this repo) ──────────────────────────
 * `lib/api/route-toolkit.ts` has CRLF line endings. A mutation needle written
 * with LF matches ZERO times, the "mutation" silently does nothing, the suite
 * passes, and the run reads exactly like a test that cannot fail. The mutation
 * was applied with the Edit tool, which fails on an absent or non-unique match,
 * and the diff was inspected before the run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ── the two leaves, and ONLY these ─────────────────────────────────────────
vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session');
  return { ...actual, getSession: vi.fn() };
});
vi.mock('@/lib/auth/feature-gate', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/feature-gate')>('@/lib/auth/feature-gate');
  return { ...actual, requireTenantAdmin: vi.fn(() => null) };
});

/**
 * The analysis is not under test here; spy on it so "the handler body ran" has a
 * POSITIVE control and a NEGATIVE one. Without the spy, a 403 with the body
 * having already executed would be indistinguishable from a 403 that refused
 * first — and a guard that answers 403 after doing the work has still done it.
 */
const buildRiskLayer = vi.fn(() => ({
  evaluated: false as const,
  reason: 'stubbed for the authorization test',
  registry: [],
}));
vi.mock('@/app/api/admin/brain/_lib/risk-layer', () => ({
  buildRiskLayer: (...a: unknown[]) => buildRiskLayer(...(a as [])),
  riskDetectorRegistry: () => [],
}));

import { GET } from '@/app/api/admin/brain/synapses/route';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';

const ADMIN = {
  claims: { oid: 'oid-1', upn: 'admin@example.test', tid: 'tid-1', name: 'Admin' },
  exp: 9_999_999_999,
};

/** The canonical 403 the real `requireTenantAdmin` returns for a non-admin. */
function adminOnly403() {
  return NextResponse.json({ ok: false, error: 'admin_only' }, { status: 403 });
}

function req() {
  return { nextUrl: new URL('http://x/api/admin/brain/synapses') } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
});

describe('GET /api/admin/brain/synapses — the REAL withTenantAdmin', () => {
  it('401s with no session, and runs no analysis', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await GET(req(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(401);
    expect(buildRiskLayer).not.toHaveBeenCalled();
  });

  it('403s for a signed-in NON-admin — THE MUTATION TARGET', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
    (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adminOnly403());

    const res = await GET(req(), { params: Promise.resolve({}) } as never);

    // Delete `if (gate) return gate;` in lib/api/route-toolkit.ts and this line
    // reads 200 instead of 403.
    expect(res.status).toBe(403);
    // …and this is the stronger claim: the body never executed. Security
    // analysis of the estate is not something to hand a non-admin and then
    // refuse to print.
    expect(buildRiskLayer).not.toHaveBeenCalled();
  });

  it('returns the layers for a tenant admin — the positive control', async () => {
    // Without this, "403 for everyone" would satisfy the spec above and the
    // guard could be a hard-coded denial.
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
    const res = await GET(req(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    expect(buildRiskLayer).toHaveBeenCalledTimes(1);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // Envelope convention: fields SPREAD next to `ok`, never nested under `data`.
    expect(body.risk).toBeDefined();
    expect(body.history).toBeDefined();
    expect(body.data).toBeUndefined();
  });

  it('the guard is actually consulted on every call, with the real session', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
    await GET(req(), { params: Promise.resolve({}) } as never);
    expect(requireTenantAdmin).toHaveBeenCalledTimes(1);
    expect(requireTenantAdmin).toHaveBeenCalledWith(ADMIN);
  });
});

describe('a failed sweep is reported as failed, never as clean (R7)', () => {
  beforeEach(() => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
  });

  it('a throwing detector produces a 500 that says NO verdict was drawn', async () => {
    // The security detectors throw deliberately on an incoherent population.
    // Swallowing that into `findings: []` would convert a broken detector into a
    // reassuring green — the exact failure this whole surface exists to prevent.
    buildRiskLayer.mockImplementationOnce(() => {
      throw new Error('[security.c1] SILENT NARROWING: enumerated 1 of 15');
    });
    const res = await GET(req(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/NO risk verdict has been drawn/i);
    expect(body.error).toMatch(/no partial findings/i);
  });

  it('and the failure body does not present itself as an empty result set', async () => {
    buildRiskLayer.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const res = await GET(req(), { params: Promise.resolve({}) } as never);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.risk).toBeUndefined();
    expect(body.history).toBeUndefined();
  });
});

describe('the route is a READ and cannot be anything else', () => {
  it('exports GET and no mutating verb', async () => {
    const mod = (await import('@/app/api/admin/brain/synapses/route')) as Record<string, unknown>;
    expect(typeof mod.GET).toBe('function');
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(mod[verb], `the synapses route exports ${verb}`).toBeUndefined();
    }
  });

  it('is force-dynamic, so a cached risk verdict cannot be served as a live one', async () => {
    const mod = (await import('@/app/api/admin/brain/synapses/route')) as Record<string, unknown>;
    expect(mod.dynamic).toBe('force-dynamic');
    expect(mod.revalidate).toBe(0);
  });
});
