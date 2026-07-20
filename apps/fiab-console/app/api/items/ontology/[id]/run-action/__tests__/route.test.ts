/**
 * BFF route test for POST /api/items/ontology/[id]/run-action (WS-4.3 — Entra-
 * group ACTION markings enforced server-side: a restricted caller is blocked
 * 403 before any write-back, a cleared caller proceeds to runActionType).
 *
 * All stores are mocked (hermetic — no PG/Cosmos I/O). We assert the object-
 * security action ACL gate, not the downstream write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'o', groups: [] }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: vi.fn(async () => null) }));
const isTenantAdminTierMock = vi.fn(() => false);
vi.mock('@/lib/auth/domain-role', () => ({ isTenantAdminTier: (...a: any[]) => isTenantAdminTierMock(...a) }));
const auditMock = vi.fn();
vi.mock('@/lib/azure/object-security-audit', () => ({ auditObjectSecurity: (...a: any[]) => auditMock(...a) }));

const loadOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a) }));

const weaveGateMock = vi.fn(() => null as any);
const runActionTypeMock = vi.fn(async () => ({ kind: 'create', object: { id: '42', objectType: 'Customer', properties: {} } }));
vi.mock('@/lib/azure/weave-ontology-store', () => ({
  weaveGate: () => weaveGateMock(),
  runActionType: (...a: any[]) => runActionTypeMock(...a),
}));
vi.mock('@/lib/azure/postgres-flex-client', () => ({ PostgresError: class PostgresError extends Error { status = 502; } }));
vi.mock('@/lib/azure/action-justification-store', () => ({
  recordActionJustification: vi.fn(async () => ({ id: 'j1' })),
  isValidReason: (r: unknown) => typeof r === 'string' && r.trim().length >= 4,
  MIN_JUSTIFICATION_LEN: 4,
}));
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: vi.fn(async () => {}) }));
vi.mock('@/lib/azure/action-approval-store', () => ({
  paramsHash: () => 'h',
  findUsableApproval: vi.fn(async () => ({ id: 'a1' })),
  requestApproval: vi.fn(async () => ({ id: 'r1' })),
  consumeApproval: vi.fn(async () => {}),
}));

import { POST } from '../route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: any) => ({ json: async () => body } as any);

const ONTO = {
  id: 'onto1',
  displayName: 'Onto',
  state: {
    objectTypes: [{ apiName: 'Customer', properties: [{ apiName: 'name', baseType: 'string' }] }],
    actionTypes: [{ name: 'createCustomer', objectType: 'Customer', kind: 'create', parameters: [{ apiName: 'name', type: 'string' }] }],
    objectSecurity: {
      actions: [{ action: 'createCustomer', allowGroups: [{ id: 'g-writers', name: 'Writers' }] }],
    },
  },
};

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: [] }, exp: Date.now() / 1000 + 3600 } as any);
  isTenantAdminTierMock.mockReset().mockReturnValue(false);
  auditMock.mockReset();
  loadOwnedItemMock.mockReset().mockResolvedValue(ONTO);
  weaveGateMock.mockReset().mockReturnValue(null);
  runActionTypeMock.mockClear();
});

describe('POST /run-action — WS-4.3 action ACL', () => {
  it('403s a caller not in the action allow-group and does NOT run the write-back', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: ['g-other'] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await POST(post({ action: 'createCustomer', params: { name: 'x' } }), ctx('onto1'));
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.code).toBe('action_forbidden');
    expect(runActionTypeMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1].decision).toBe('action-denied');
  });

  it('allows a caller in the action allow-group to run it (and audits the allow)', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: ['g-writers'] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await POST(post({ action: 'createCustomer', params: { name: 'x' } }), ctx('onto1'));
    expect(r.status).toBe(200);
    expect(runActionTypeMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1].decision).toBe('action-allowed');
  });

  it('a tenant admin bypasses the action ACL', async () => {
    isTenantAdminTierMock.mockReturnValue(true);
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: [] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await POST(post({ action: 'createCustomer', params: { name: 'x' } }), ctx('onto1'));
    expect(r.status).toBe(200);
    expect(runActionTypeMock).toHaveBeenCalledTimes(1);
  });

  it('an ungated action runs for anyone (no marking configured)', async () => {
    loadOwnedItemMock.mockResolvedValue({
      ...ONTO,
      state: { ...ONTO.state, objectSecurity: { actions: [] } },
    });
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: ['g-other'] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await POST(post({ action: 'createCustomer', params: { name: 'x' } }), ctx('onto1'));
    expect(r.status).toBe(200);
    expect(runActionTypeMock).toHaveBeenCalledTimes(1);
  });
});
