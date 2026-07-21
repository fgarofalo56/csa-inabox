/**
 * BFF route test for GET /api/items/ontology/[id]/resolve (WS-6 / BTB-1).
 * Mocks the session, item load, PDP, and the resolver; exercises the route's
 * object-type validation, multi-source shaping, and WS-4.3 security application.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a) }));

vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: vi.fn(async () => null) }));
vi.mock('@/lib/auth/domain-role', () => ({ isTenantAdminTier: vi.fn(() => false) }));
vi.mock('@/lib/azure/object-security-audit', () => ({ auditObjectSecurity: vi.fn() }));

const discoverOntologyBindingsMock = vi.fn(async () => []);
const resolveOntologyObjectInstancesMock = vi.fn();
vi.mock('@/lib/foundry/ontology-resolver', () => ({
  discoverOntologyBindings: (...a: any[]) => discoverOntologyBindingsMock(...a),
  resolveOntologyObjectInstances: (...a: any[]) => resolveOntologyObjectInstancesMock(...a),
}));

import { GET } from '../route';

const ONTOLOGY = {
  id: 'onto-1', itemType: 'ontology', workspaceId: 'ws-1', displayName: 'Sales',
  state: {
    objectTypes: [{
      apiName: 'Customer', primaryKey: 'customerId',
      properties: [
        { apiName: 'customerId', baseType: 'string' },
        { apiName: 'name', baseType: 'string' },
        { apiName: 'secret', baseType: 'string' },
      ],
    }],
    objectSecurity: { objectTypes: [{ objectType: 'Customer', propertyMarkings: [{ property: 'secret', allowGroups: [{ id: 'g-admin' }] }] }] },
  },
};

function get(id: string, objectType?: string): NextRequest {
  const u = new URL(`http://localhost/api/items/ontology/${id}/resolve`);
  if (objectType) u.searchParams.set('objectType', objectType);
  return new NextRequest(u, { method: 'GET' });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1', groups: [] } });
  loadOwnedItemMock.mockResolvedValue(ONTOLOGY);
});

describe('GET /api/items/ontology/[id]/resolve', () => {
  it('401s without a session', async () => {
    getSessionMock.mockReturnValueOnce(null);
    const res = await GET(get('onto-1', 'Customer'), ctx('onto-1'));
    expect(res.status).toBe(401);
  });

  it('400s without objectType', async () => {
    const res = await GET(get('onto-1'), ctx('onto-1'));
    expect(res.status).toBe(400);
  });

  it('409s for an undeclared object type', async () => {
    const res = await GET(get('onto-1', 'Ghost'), ctx('onto-1'));
    expect(res.status).toBe(409);
  });

  it('resolves instances from bound sources and masks a gated property (WS-4.3)', async () => {
    discoverOntologyBindingsMock.mockResolvedValue([{ itemId: 'lh', binding: { objectType: 'Customer' } }]);
    resolveOntologyObjectInstancesMock.mockResolvedValue({
      sources: [{ itemId: 'lh', itemName: 'Lake', sourceKind: 'lakehouse-table', resolved: true, rowCount: 1, instances: [] }],
      instances: [{ id: 'C1', objectType: 'Customer', properties: { customerId: 'C1', name: 'Acme', secret: 'topsecret' } }],
    });

    const res = await GET(get('onto-1', 'Customer'), ctx('onto-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.objectType).toBe('Customer');
    expect(body.sources[0]).toMatchObject({ itemId: 'lh', sourceKind: 'lakehouse-table', resolved: true });
    // 'secret' is masked for a caller not in g-admin — dropped server-side.
    expect(body.instances[0].properties).toEqual({ customerId: 'C1', name: 'Acme' });
    expect(body.security.restricted).toBe(true);
  });

  it('surfaces an honest per-source gate without failing the whole resolve', async () => {
    discoverOntologyBindingsMock.mockResolvedValue([{ itemId: 'kq', binding: { objectType: 'Customer' } }]);
    resolveOntologyObjectInstancesMock.mockResolvedValue({
      sources: [{ itemId: 'kq', itemName: 'Stream', sourceKind: 'kql', resolved: false, rowCount: 0, gate: { code: 'adx_not_configured', hint: 'set LOOM_ADX_CLUSTER_URI' } }],
      instances: [],
    });
    const res = await GET(get('onto-1', 'Customer'), ctx('onto-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources[0].gate.code).toBe('adx_not_configured');
    expect(body.instances).toHaveLength(0);
  });
});
