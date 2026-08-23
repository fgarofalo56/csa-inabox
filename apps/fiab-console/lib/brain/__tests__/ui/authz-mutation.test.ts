/**
 * AUTHORIZATION — proven against the REAL wrapper, with a mutation that must
 * turn this file red.
 *
 * ── WHY THE OBVIOUS VERSION OF THIS TEST IS WORTHLESS ──────────────────────
 * The established pattern in this repo (see
 * `app/api/admin/audit-logs/__tests__/route.test.ts`) mocks `withTenantAdmin`
 * itself and re-implements the guard inside the mock:
 *
 *     vi.mock('@/lib/api/route-toolkit', () => ({
 *       withTenantAdmin: (h) => async (req, ctx) => {
 *         const gate = requireTenantAdmin(session);
 *         if (gate) return gate;         // <- the TEST's copy of the guard
 *         return h(req, ctx);
 *       },
 *     }));
 *
 * That test asserts the guard the TEST wrote, not the guard that ships. Delete
 * `if (gate) return gate;` from `lib/api/route-toolkit.ts` and it stays green,
 * because the shipped line is never executed. This repo has already been bitten
 * by exactly that: removing one such line left three route guards still
 * reporting green.
 *
 * So this file does NOT mock the wrapper. It mocks only the two leaves BENEATH
 * it — `getSession` (who is calling) and `requireTenantAdmin` (are they an
 * admin) — and runs the real `withSession` -> `requireTenantAdmin` -> `if
 * (gate) return gate` -> handler composition from the shipped module.
 *
 * ── THE MUTATION, AND THE MEASURED RESULT ──────────────────────────────────
 * Mutation: delete `if (gate) return gate;` from `withTenantAdmin` in
 * `lib/api/route-toolkit.ts`.
 *
 *     clean    RC=0   all specs pass
 *     mutated  RC=1   the 403 specs fail: the handler runs and returns 200
 *
 * The RCs are recorded in the PR body. If you change this file, re-run the
 * mutation — a guard whose verdict does not move when its subject is broken is
 * not watching anything.
 *
 * ── NOTE ON THE NEEDLE (a landmine in this repo) ───────────────────────────
 * `lib/api/route-toolkit.ts` has CRLF line endings. A mutation needle written
 * with LF matches ZERO times, the "mutation" silently does nothing, the suite
 * passes, and the run reads exactly like a test that cannot fail. The mutation
 * was applied with the Edit tool, which fails on a non-unique or absent match,
 * and the resulting diff was inspected before the run.
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

// The estate read is not under test here; stub it so an AUTHORIZED call reaches
// a 200 and the "the handler ran" assertion has a positive control.
const loadSnapshot = vi.fn(async () => ({
  generatedAt: '2026-08-23T00:00:00Z',
  nodes: [],
  edges: [],
  findings: [],
  detectors: [],
  coverage: {},
  ownership: { confirmed: 0, examined: 0, indeterminate: 0, blind: true, note: '' },
  collection: {},
  nodesByKind: {},
  edgesByProvenance: {},
  edgesByResolution: { resolved: 0, dangling: 0 },
  skipped: [],
  cloud: 'Commercial',
}));
vi.mock('@/app/api/admin/brain/_lib/snapshot', () => ({
  loadSnapshot: (...a: unknown[]) => loadSnapshot(...(a as [])),
  ESTATE_QUERY_TEXT: 'Resources',
}));

const emitAuditEvent = vi.fn();
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (...a: unknown[]) => emitAuditEvent(...a) }));

import { GET } from '@/app/api/admin/brain/graph/route';
import { POST } from '@/app/api/admin/brain/proposals/route';
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

function getReq() {
  return { nextUrl: new URL('http://x/api/admin/brain/graph') } as never;
}
function postReq(body: unknown) {
  return {
    nextUrl: new URL('http://x/api/admin/brain/proposals'),
    json: async () => body,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
});

describe('GET /api/admin/brain/graph — the REAL withTenantAdmin', () => {
  it('401s with no session, and never reads the estate', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await GET(getReq(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(401);
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('403s for a signed-in NON-admin — THE MUTATION TARGET', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
    (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adminOnly403());

    const res = await GET(getReq(), { params: Promise.resolve({}) } as never);

    // Delete `if (gate) return gate;` in lib/api/route-toolkit.ts and this line
    // reads 200 instead of 403.
    expect(res.status).toBe(403);
    // ...and this one is the stronger claim: the body never executed. A guard
    // that returns 403 AFTER doing the work has still leaked the work.
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('returns the estate for a tenant admin — the positive control', async () => {
    // Without this, "403 for everyone" would satisfy the spec above and the
    // guard could be a hard-coded denial.
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
    const res = await GET(getReq(), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { ok: boolean; snapshot?: unknown };
    expect(body.ok).toBe(true);
    // Envelope convention: fields SPREAD next to `ok`, never nested under `data`.
    expect(body.snapshot).toBeDefined();
    expect((body as Record<string, unknown>).data).toBeUndefined();
  });

  it('the guard is actually consulted on every call', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
    await GET(getReq(), { params: Promise.resolve({}) } as never);
    expect(requireTenantAdmin).toHaveBeenCalledTimes(1);
    expect(requireTenantAdmin).toHaveBeenCalledWith(ADMIN);
  });
});

describe('POST /api/admin/brain/proposals — the REAL withTenantAdmin', () => {
  const body = { findingId: 'unreachable-always-on:azure:/x', decision: 'approved' };

  it('401s with no session, and records nothing', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await POST(postReq(body), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(401);
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });

  it('403s for a signed-in NON-admin, and records nothing — THE MUTATION TARGET', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
    (requireTenantAdmin as unknown as ReturnType<typeof vi.fn>).mockReturnValue(adminOnly403());

    const res = await POST(postReq(body), { params: Promise.resolve({}) } as never);

    expect(res.status).toBe(403);
    // An unauthorized caller must not be able to write into the audit stream —
    // forging review decisions is its own attack, separate from reading the estate.
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });

  it('records the decision for a tenant admin — the positive control', async () => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
    const res = await POST(postReq(body), { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
  });
});

describe('the recorded decision is a decision, not an action', () => {
  beforeEach(() => {
    (getSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(ADMIN);
  });

  it('the audit row states explicitly that Azure was not mutated', async () => {
    await POST(
      postReq({ findingId: 'f1', decision: 'approved', note: 'agreed' }),
      { params: Promise.resolve({}) } as never,
    );
    const ev = emitAuditEvent.mock.calls[0]![0] as {
      action: string;
      detail: { mutatedAzure: boolean; recommendOnly: boolean; note: string };
    };
    expect(ev.action).toBe('brain-proposal.approved');
    expect(ev.detail.mutatedAzure).toBe(false);
    expect(ev.detail.recommendOnly).toBe(true);
    expect(ev.detail.note).toBe('agreed');
  });

  it('the response tells the caller nothing was changed', async () => {
    const res = await POST(
      postReq({ findingId: 'f1', decision: 'approved' }),
      { params: Promise.resolve({}) } as never,
    );
    const json = (await res.json()) as { mutatedAzure: boolean; note: string };
    expect(json.mutatedAzure).toBe(false);
    expect(json.note).toContain('NOTHING was changed in Azure');
  });

  it('rejects a decision verb that is not approve/dismiss', async () => {
    // The allow-list is what stops `decision: 'apply'` ever becoming meaningful
    // by accident.
    for (const bad of ['apply', 'execute', 'delete', 'scale', '']) {
      const res = await POST(
        postReq({ findingId: 'f1', decision: bad }),
        { params: Promise.resolve({}) } as never,
      );
      expect(res.status, `decision '${bad}' was accepted`).toBe(400);
    }
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing findingId rather than recording an unattributable decision', async () => {
    const res = await POST(
      postReq({ decision: 'approved' }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(400);
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });
});
