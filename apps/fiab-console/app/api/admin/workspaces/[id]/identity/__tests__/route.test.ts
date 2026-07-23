/**
 * Contract tests for /api/admin/workspaces/[id]/identity (I6 — per-workspace
 * identity enforcement toggle).
 *
 *   - GET rolls up the I7 preflight + I4 14-day divergence + I9 review into a
 *     readiness verdict (canEnable) — tenant-admin only.
 *   - POST enforce:true when READY (grants green, zero divergence, review signed)
 *     → persists workspaceIdentity.enforce + writes the ATO `identity.enforce`
 *     audit row.
 *   - POST enforce:true when NOT ready → 409 `not_ready`, names the exact missing
 *     grant, and does NOT persist or audit.
 *   - POST enforce:false (disable) → persists + audits, no readiness gate (the
 *     I7 instant fail-safe rollback).
 *   - 403 for a non-admin session (both verbs).
 *
 * ARM / data-plane / preflight boundaries are mocked; the persist + audit + gate
 * logic is exercised for real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/workspace-guard', () => ({ resolveAdminWorkspace: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(),
  auditLogContainer: vi.fn(),
}));
vi.mock('@/lib/azure/workspace-identity-preflight', () => ({ preflightWorkspaceEnforce: vi.fn() }));
vi.mock('@/lib/azure/workspace-identity-shadow', () => ({ identityDivergenceRollup: vi.fn() }));
vi.mock('@/lib/azure/workspace-identity-client', () => ({ workspaceIdentityMode: vi.fn(() => 'shadow') }));
vi.mock('@/lib/security/identity-enforce-review', () => ({ identityEnforceReview: vi.fn() }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
vi.mock('@/lib/admin/runtime-flags', () => ({ runtimeFlag: vi.fn(async () => true) }));

import { GET, POST } from '../route';
import { resolveAdminWorkspace } from '@/lib/auth/workspace-guard';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { workspacesContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { preflightWorkspaceEnforce } from '@/lib/azure/workspace-identity-preflight';
import { identityDivergenceRollup } from '@/lib/azure/workspace-identity-shadow';
import { identityEnforceReview } from '@/lib/security/identity-enforce-review';

const ADMIN = { claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tenant-1' } };

function ctx(id = 'ws-1') {
  return { params: Promise.resolve({ id }) };
}
function makeReq(body?: any) {
  return { json: async () => (body === undefined ? (() => { throw new Error('no body'); })() : body) } as any;
}

function baseWs(overrides: Partial<any> = {}) {
  return {
    id: 'ws-1',
    tenantId: 'admin-oid',
    name: 'Analytics',
    createdBy: 'admin@contoso.com',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    workspaceIdentity: { status: 'provisioned', uamiName: 'uami-ws-ws-1', principalId: 'p-1' },
    ...overrides,
  };
}

function readyPreflight() {
  return {
    workspaceId: 'ws-1', ready: true, uamiProvisioned: true, missingGrants: [],
    divergences: 0, observedCalls: 42, grantEvaluations: [
      { backend: 'adls-lake', wouldAllow: true, reason: 'granted', source: 'arm', checkedAt: 'now' },
    ], reasons: [], warnings: [], checkedAt: 'now',
  };
}
function notReadyPreflight() {
  return {
    workspaceId: 'ws-1', ready: false, uamiProvisioned: true,
    missingGrants: ['synapse-sql'], divergences: 0, observedCalls: 10,
    grantEvaluations: [
      { backend: 'adls-lake', wouldAllow: true },
      { backend: 'synapse-sql', wouldAllow: false, reason: 'external user missing' },
    ],
    reasons: ['The workspace UAMI is missing 1 grant(s): synapse-sql. Re-run grant provisioning (ensureWorkspaceGrants) before enforcing.'],
    warnings: [], checkedAt: 'now',
  };
}
function cleanRollup() {
  return { workspaceId: 'ws-1', windowDays: 14, since: 's', observedCalls: 42, divergences: 0, byBackend: {}, unreadable: false, checkedAt: 'now' };
}
function signedReview() {
  return { signedOff: true, reviewer: 'Jane Doe, AppSec Lead', reviewDate: '2026-07-23', program: 'p', docPath: 'd', openHighFindings: 0 };
}
function unsignedReview() {
  return { signedOff: false, reviewDate: '2026-07-23', program: 'p', docPath: 'd', openHighFindings: 0, reason: 'The I9 AppSec review is not signed off in this estate.' };
}

/** Fake workspaces container capturing the replace(next). */
function fakeWsContainer(ws: any) {
  const store = { doc: ws, replaced: null as any };
  return {
    container: {
      item: () => ({
        replace: async (next: any) => { store.replaced = next; store.doc = next; return { resource: next }; },
      }),
    },
    store,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (isTenantAdmin as any).mockReturnValue(true);
  (identityEnforceReview as any).mockReturnValue(signedReview());
  (auditLogContainer as any).mockResolvedValue({ items: { create: vi.fn(async () => ({})) } });
});

describe('GET /api/admin/workspaces/[id]/identity', () => {
  it('403 for a non-admin session', async () => {
    (resolveAdminWorkspace as any).mockResolvedValue({ session: { claims: { oid: 'owner' } }, ws: baseWs() });
    (isTenantAdmin as any).mockReturnValue(false);
    const res = await GET(makeReq(), ctx());
    expect(res.status).toBe(403);
  });

  it('returns canEnable=true when preflight ready + zero divergence + review signed', async () => {
    (resolveAdminWorkspace as any).mockResolvedValue({ session: ADMIN, ws: baseWs() });
    (preflightWorkspaceEnforce as any).mockResolvedValue(readyPreflight());
    (identityDivergenceRollup as any).mockResolvedValue(cleanRollup());
    const res = await GET(makeReq(), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.data.readiness.canEnable).toBe(true);
    expect(j.data.readiness.blockers).toEqual([]);
    expect(j.data.review.signedOff).toBe(true);
    expect(j.data.preflight.grantEvaluations.length).toBeGreaterThan(0);
  });

  it('reports blockers (and canEnable=false) when the review is unsigned', async () => {
    (resolveAdminWorkspace as any).mockResolvedValue({ session: ADMIN, ws: baseWs() });
    (preflightWorkspaceEnforce as any).mockResolvedValue(readyPreflight());
    (identityDivergenceRollup as any).mockResolvedValue(cleanRollup());
    (identityEnforceReview as any).mockReturnValue(unsignedReview());
    const res = await GET(makeReq(), ctx());
    const j = await res.json();
    expect(j.data.readiness.canEnable).toBe(false);
    expect(j.data.readiness.blockers.some((b: string) => /not signed off/i.test(b))).toBe(true);
  });
});

describe('POST /api/admin/workspaces/[id]/identity', () => {
  it('403 for a non-admin session', async () => {
    (resolveAdminWorkspace as any).mockResolvedValue({ session: { claims: { oid: 'owner' } }, ws: baseWs() });
    (isTenantAdmin as any).mockReturnValue(false);
    const res = await POST(makeReq({ enforce: true }), ctx());
    expect(res.status).toBe(403);
  });

  it('400 when enforce is not a boolean', async () => {
    (resolveAdminWorkspace as any).mockResolvedValue({ session: ADMIN, ws: baseWs() });
    const res = await POST(makeReq({ enforce: 'yes' }), ctx());
    expect(res.status).toBe(400);
  });

  it('enables + persists + writes the audit row when ready', async () => {
    const { container, store } = fakeWsContainer(baseWs());
    (resolveAdminWorkspace as any).mockResolvedValue({ session: ADMIN, ws: baseWs() });
    (workspacesContainer as any).mockResolvedValue(container);
    (preflightWorkspaceEnforce as any).mockResolvedValue(readyPreflight());
    (identityDivergenceRollup as any).mockResolvedValue(cleanRollup());
    const auditCreate = vi.fn(async () => ({}));
    (auditLogContainer as any).mockResolvedValue({ items: { create: auditCreate } });

    const res = await POST(makeReq({ enforce: true }), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.data.enforce).toBe(true);
    expect(store.replaced.workspaceIdentity.enforce).toBe(true);
    expect(store.replaced.workspaceIdentity.enforceBy).toBe('admin@contoso.com');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const row = auditCreate.mock.calls[0][0];
    expect(row.kind).toBe('identity.enforce');
    expect(row.action).toBe('enable');
    expect(row.prior).toBe(false);
    expect(row.next).toBe(true);
  });

  it('REFUSES to enable when a grant is missing — 409, names the grant, no persist/audit', async () => {
    const { container, store } = fakeWsContainer(baseWs());
    (resolveAdminWorkspace as any).mockResolvedValue({ session: ADMIN, ws: baseWs() });
    (workspacesContainer as any).mockResolvedValue(container);
    (preflightWorkspaceEnforce as any).mockResolvedValue(notReadyPreflight());
    (identityDivergenceRollup as any).mockResolvedValue(cleanRollup());
    const auditCreate = vi.fn(async () => ({}));
    (auditLogContainer as any).mockResolvedValue({ items: { create: auditCreate } });

    const res = await POST(makeReq({ enforce: true }), ctx());
    const j = await res.json();
    expect(res.status).toBe(409);
    expect(j.code).toBe('not_ready');
    expect(j.error).toContain('synapse-sql');
    expect(j.blockers.some((b: string) => b.includes('synapse-sql'))).toBe(true);
    expect(store.replaced).toBeNull();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('REFUSES to enable when the review is unsigned even if grants are green', async () => {
    (resolveAdminWorkspace as any).mockResolvedValue({ session: ADMIN, ws: baseWs() });
    (workspacesContainer as any).mockResolvedValue(fakeWsContainer(baseWs()).container);
    (preflightWorkspaceEnforce as any).mockResolvedValue(readyPreflight());
    (identityDivergenceRollup as any).mockResolvedValue(cleanRollup());
    (identityEnforceReview as any).mockReturnValue(unsignedReview());
    const res = await POST(makeReq({ enforce: true }), ctx());
    expect(res.status).toBe(409);
  });

  it('disables without a readiness gate + audits the disable', async () => {
    const { container, store } = fakeWsContainer(baseWs({ workspaceIdentity: { status: 'provisioned', enforce: true } }));
    (resolveAdminWorkspace as any).mockResolvedValue({ session: ADMIN, ws: baseWs({ workspaceIdentity: { status: 'provisioned', enforce: true } }) });
    (workspacesContainer as any).mockResolvedValue(container);
    const auditCreate = vi.fn(async () => ({}));
    (auditLogContainer as any).mockResolvedValue({ items: { create: auditCreate } });

    const res = await POST(makeReq({ enforce: false }), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.data.enforce).toBe(false);
    expect(store.replaced.workspaceIdentity.enforce).toBe(false);
    // Disable path never calls the preflight (no readiness gate on rollback).
    expect(preflightWorkspaceEnforce).not.toHaveBeenCalled();
    const row = auditCreate.mock.calls[0][0];
    expect(row.action).toBe('disable');
    expect(row.prior).toBe(true);
    expect(row.next).toBe(false);
  });
});
