/**
 * BFF route test for GET /api/items/ontology/[id]/objects (WS-4.3 object-level
 * security — Entra-group property/row markings enforced on the instance list).
 *
 * getObject/listObjects are mocked so we test the route's row-filter + property-
 * mask enforcement + audit, no PG I/O. pdpCheck + isTenantAdminTier + audit are
 * mocked (hermetic — no Cosmos).
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
const listObjectsMock = vi.fn();
vi.mock('@/lib/azure/weave-ontology-store', () => ({
  weaveGate: () => weaveGateMock(),
  listObjects: (...a: any[]) => listObjectsMock(...a),
  createObject: vi.fn(),
}));
vi.mock('@/lib/azure/postgres-flex-client', () => ({ PostgresError: class PostgresError extends Error { status = 502; } }));

import { GET } from '../route';

const req = (objectType?: string) => ({
  nextUrl: { searchParams: new URLSearchParams(objectType ? { objectType } : {}) },
} as any);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const ONTO = {
  id: 'onto1',
  displayName: 'Onto',
  state: {
    objectTypes: [{ apiName: 'Customer', properties: [{ apiName: 'name', baseType: 'string' }, { apiName: 'ssn', baseType: 'string' }, { apiName: 'tier', baseType: 'string' }] }],
    objectSecurity: {
      objectTypes: [{
        objectType: 'Customer',
        propertyMarkings: [{ property: 'ssn', allowGroups: [{ id: 'g-pii', name: 'PII' }] }],
        rowMarking: { markingProperty: 'tier', clearances: [{ value: 'secret', allowGroups: [{ id: 'g-secret' }] }] },
      }],
    },
  },
};

const INSTANCES = [
  { id: '1', objectType: 'Customer', properties: { name: 'A', ssn: '111', tier: 'public' } },
  { id: '2', objectType: 'Customer', properties: { name: 'B', ssn: '222', tier: 'secret' } },
];

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: [] }, exp: Date.now() / 1000 + 3600 } as any);
  isTenantAdminTierMock.mockReset().mockReturnValue(false);
  auditMock.mockReset();
  loadOwnedItemMock.mockReset().mockResolvedValue(ONTO);
  weaveGateMock.mockReset().mockReturnValue(null);
  listObjectsMock.mockReset().mockResolvedValue(INSTANCES);
});

describe('GET /objects — WS-4.3 masking + row filtering', () => {
  it('masks ssn AND hides the secret-tier row for an uncleared caller, and audits', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: ['g-other'] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await GET(req('Customer'), ctx('onto1'));
    expect(r.status).toBe(200);
    const j = await r.json();
    // row 2 (tier=secret) filtered out; only the public row remains
    expect(j.objects).toHaveLength(1);
    expect(j.objects[0].id).toBe('1');
    // ssn masked (dropped) on the visible row
    expect(j.objects[0].properties.ssn).toBeUndefined();
    expect(j.objects[0].properties.name).toBe('A');
    expect(j.objects[0].maskedProperties).toContain('ssn');
    expect(j.security.restricted).toBe(true);
    expect(j.security.filteredCount).toBe(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1].decision).toBe('read-masked');
  });

  it('a caller cleared for both PII and secret sees every row + property', async () => {
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: ['g-pii', 'g-secret'] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await GET(req('Customer'), ctx('onto1'));
    const j = await r.json();
    expect(j.objects).toHaveLength(2);
    expect(j.objects[1].properties.ssn).toBe('222');
    expect(j.security.restricted).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('a tenant admin bypasses all markings', async () => {
    isTenantAdminTierMock.mockReturnValue(true);
    const r = await GET(req('Customer'), ctx('onto1'));
    const j = await r.json();
    expect(j.objects).toHaveLength(2);
    expect(j.objects[0].properties.ssn).toBe('111');
    expect(j.security.restricted).toBe(false);
  });

  it('404s when the ontology is not owned by the caller', async () => {
    loadOwnedItemMock.mockResolvedValue(null);
    const r = await GET(req('Customer'), ctx('onto1'));
    expect(r.status).toBe(404);
  });
});
