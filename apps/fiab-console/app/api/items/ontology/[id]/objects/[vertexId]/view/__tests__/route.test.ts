/**
 * BFF route test for GET /api/items/ontology/[id]/objects/[vertexId]/view
 * (WS-4.1 Object View, Foundry-parity row Foundry-1.1-A8).
 *
 * Asserts the real-AGE assembly: owner-scoped ontology load, a single vertex
 * fetch, link traversal shaped into sections, a timeseries built from real
 * neighbour properties, and every honest gate (undeclared type / weave not
 * configured / instance not found). getObject + traverseObject are mocked so we
 * test the route's shaping + gating, no PG I/O.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'o', groups: [] }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: vi.fn(async () => null) }));
const isTenantAdminTierMock = vi.fn(() => false);
vi.mock('@/lib/auth/domain-role', () => ({ isTenantAdminTier: (...a: any[]) => isTenantAdminTierMock(...a) }));
vi.mock('@/lib/azure/object-security-audit', () => ({ auditObjectSecurity: vi.fn() }));

const loadOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a) }));

const weaveGateMock = vi.fn(() => null as any);
const getObjectMock = vi.fn();
vi.mock('@/lib/azure/weave-ontology-store', () => ({
  weaveGate: () => weaveGateMock(),
  getObject: (...a: any[]) => getObjectMock(...a),
}));

const traverseObjectMock = vi.fn();
vi.mock('@/lib/azure/weave-explore', () => ({ traverseObject: (...a: any[]) => traverseObjectMock(...a) }));

import { GET } from '../route';

const req = (objectType?: string) => ({
  nextUrl: { searchParams: new URLSearchParams(objectType ? { objectType } : {}) },
} as any);
const ctx = (id: string, vertexId: string) => ({ params: Promise.resolve({ id, vertexId }) });

const ONTO = {
  id: 'onto1',
  state: {
    objectTypes: [
      { apiName: 'Reading', properties: [{ apiName: 'ts', baseType: 'timestamp' }, { apiName: 'value', baseType: 'double' }], titleKey: 'value' },
      { apiName: 'Sensor', properties: [{ apiName: 'name', baseType: 'string' }] },
    ],
    linkTypes: [{ apiName: 'measuredBy', displayName: 'Measured by', fromType: 'Reading', toType: 'Sensor', cardinality: 'one-to-many' }],
  },
};

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: [] }, exp: Date.now() / 1000 + 3600 } as any);
  isTenantAdminTierMock.mockReset().mockReturnValue(false);
  loadOwnedItemMock.mockReset().mockResolvedValue(ONTO);
  weaveGateMock.mockReset().mockReturnValue(null);
  getObjectMock.mockReset().mockResolvedValue({ id: '5', objectType: 'Reading', properties: { ts: '2024-01-02', value: 20 } });
  traverseObjectMock.mockReset().mockResolvedValue([
    { linkType: 'measuredBy', direction: 'out', neighbor: { id: '9', objectType: 'Sensor', properties: { name: 'S1', ts: '2024-01-01', value: 10 } } },
  ]);
});

describe('GET object view', () => {
  it('assembles overview/properties/linked/timeseries from real AGE data', async () => {
    const r = await GET(req('Reading'), ctx('onto1', '5'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.object.id).toBe('5');
    expect(j.linked).toHaveLength(1);
    expect(j.linked[0].label).toBe('Measured by');
    expect(j.linked[0].count).toBe(1);
    // ts+value present on the instance + neighbour → a real two-point series.
    expect(j.timeseries).not.toBeNull();
    expect(j.timeseries.timeProp).toBe('ts');
    expect(j.view.panels).toContain('timeseries');
    expect(j.titleKey).toBe('value');
  });

  it('404s when the vertex does not exist', async () => {
    getObjectMock.mockResolvedValue(null);
    const r = await GET(req('Reading'), ctx('onto1', '999'));
    expect(r.status).toBe(404);
  });

  it('409s for an undeclared object type', async () => {
    const r = await GET(req('Ghost'), ctx('onto1', '5'));
    expect(r.status).toBe(409);
  });

  it('503s with the honest gate when the AGE backend is unconfigured', async () => {
    weaveGateMock.mockReturnValue({ missing: 'LOOM_WEAVE_PG_FQDN', detail: 'x', remediation: 'y' });
    const r = await GET(req('Reading'), ctx('onto1', '5'));
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.code).toBe('weave_not_configured');
  });

  it('404s when the ontology is not owned by the caller', async () => {
    loadOwnedItemMock.mockResolvedValue(null);
    const r = await GET(req('Reading'), ctx('onto1', '5'));
    expect(r.status).toBe(404);
  });

  it('400s when objectType is missing', async () => {
    const r = await GET(req(), ctx('onto1', '5'));
    expect(r.status).toBe(400);
  });
});

describe('GET object view — WS-4.3 object-level security', () => {
  // Reading has a property marking on `value` (cleared group g-cleared) and a
  // row marking on `ts` — clearance value "2024-01-02" needs g-cleared.
  const SECURED = {
    id: 'onto1',
    state: {
      ...ONTO.state,
      objectSecurity: {
        objectTypes: [
          {
            objectType: 'Reading',
            propertyMarkings: [{ property: 'value', allowGroups: [{ id: 'g-cleared', name: 'Cleared' }] }],
          },
        ],
      },
    },
  };

  it('masks a gated property for a restricted caller (server-side drop)', async () => {
    loadOwnedItemMock.mockResolvedValue(SECURED);
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: ['g-other'] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await GET(req('Reading'), ctx('onto1', '5'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.object.properties.value).toBeUndefined(); // masked value never serialized
    expect(j.object.properties.ts).toBe('2024-01-02'); // ungated property still present
    expect(j.security.restricted).toBe(true);
    expect(j.security.maskedProperties).toContain('value');
  });

  it('returns the gated property to a cleared caller', async () => {
    loadOwnedItemMock.mockResolvedValue(SECURED);
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: ['g-cleared'] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await GET(req('Reading'), ctx('onto1', '5'));
    const j = await r.json();
    expect(j.object.properties.value).toBe(20);
    expect(j.security.restricted).toBe(false);
  });

  it('403s a row-restricted instance for a caller not cleared for its marking value', async () => {
    loadOwnedItemMock.mockResolvedValue({
      id: 'onto1',
      state: {
        ...ONTO.state,
        objectSecurity: {
          objectTypes: [{
            objectType: 'Reading',
            rowMarking: { markingProperty: 'ts', clearances: [{ value: '2024-01-02', allowGroups: [{ id: 'g-cleared' }] }] },
          }],
        },
      },
    });
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: ['g-other'] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await GET(req('Reading'), ctx('onto1', '5'));
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.code).toBe('row_forbidden');
  });

  it('tenant admins bypass all markings', async () => {
    loadOwnedItemMock.mockResolvedValue(SECURED);
    isTenantAdminTierMock.mockReturnValue(true);
    getSessionMock.mockReturnValue({ claims: { oid: 'o', groups: [] }, exp: Date.now() / 1000 + 3600 } as any);
    const r = await GET(req('Reading'), ctx('onto1', '5'));
    const j = await r.json();
    expect(j.object.properties.value).toBe(20);
    expect(j.security.restricted).toBe(false);
  });
});
