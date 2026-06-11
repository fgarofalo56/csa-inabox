/**
 * BFF route tests for /api/items/[type]/[id]/classifications.
 *
 * Asserts:
 *  - GET unauthed → 401
 *  - GET happy path → 200 with current classifications + the tenant taxonomy
 *  - PUT rejects values not in the taxonomy → 400 unknown_classification
 *    (this is what enforces "not free-text" on the server)
 *  - PUT applies taxonomy members (normalised casing) + tags the Atlas asset when
 *    Purview is configured → purviewStatus 'written', PATCHes item.state, audits
 *  - PUT writes Cosmos even when Purview is NOT configured (Azure-native / IL5)
 *  - PUT with [] clears the classifications
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'ten-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

// --- Cosmos mock ----------------------------------------------------------
const item = {
  id: 'item-1',
  workspaceId: 'ws-1',
  itemType: 'lakehouse',
  displayName: 'Sales LH',
  state: { purviewAssetGuid: 'guid-asset-1' } as Record<string, unknown>,
  createdBy: 'u', createdAt: 'now', updatedAt: 'now',
};
const taxonomyDoc = {
  id: 'classification-types:ten-1', tenantId: 'ten-1', kind: 'classification-types',
  items: [
    { id: 'ct-0', name: 'Public', sensitivity: 'Public', color: '#2e7d32' },
    { id: 'ct-3', name: 'PII', sensitivity: 'Highly Confidential', color: '#c62828' },
    { id: 'ct-2', name: 'Confidential', sensitivity: 'Confidential' },
  ],
};
let taxonomyMissing = false;
const replaceMock = vi.fn(async (doc: any) => ({ resource: doc }));
const auditCreate = vi.fn(async (d: any) => ({ resource: d }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [item] }) }) },
    item: () => ({ replace: replaceMock }),
  }),
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: 'ten-1' } }) }),
  }),
  auditLogContainer: async () => ({ items: { create: auditCreate } }),
  tenantSettingsContainer: async () => ({
    item: () => ({
      read: async () => {
        if (taxonomyMissing) { const e: any = new Error('not found'); e.code = 404; throw e; }
        return { resource: taxonomyDoc };
      },
    }),
  }),
}));

// --- Purview mock ---------------------------------------------------------
let purviewConfigured = true;
const ensureDefs = vi.fn(async () => {});
const addClassification = vi.fn(async () => {});
vi.mock('@/lib/azure/purview-client', () => ({
  isPurviewConfigured: () => purviewConfigured,
  ensureClassificationDefs: (...a: any[]) => ensureDefs(...a),
  addAssetClassification: (...a: any[]) => addClassification(...a),
}));

let gov = false;
vi.mock('@/lib/azure/cloud-endpoints', () => ({ isGovCloud: () => gov }));

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) });

beforeEach(() => {
  purviewConfigured = true;
  gov = false;
  taxonomyMissing = false;
  item.state = { purviewAssetGuid: 'guid-asset-1' };
  getSessionMock.mockReturnValue({ claims: { oid: 'ten-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 } as any);
});
afterEach(() => { vi.clearAllMocks(); });

describe('GET /api/items/[type]/[id]/classifications', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    expect(r.status).toBe(401);
  });

  it('200 with current classifications + the tenant taxonomy', async () => {
    item.state = { purviewAssetGuid: 'guid-asset-1', classifications: ['PII'] };
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.classifications).toEqual(['PII']);
    expect(j.taxonomy.map((t: any) => t.name)).toEqual(['Public', 'PII', 'Confidential']);
    expect(j.hasPurviewAsset).toBe(true);
    expect(j.purviewConfigured).toBe(true);
  });

  it('200 with an empty taxonomy when none is defined', async () => {
    taxonomyMissing = true;
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.taxonomy).toEqual([]);
  });
});

describe('PUT /api/items/[type]/[id]/classifications', () => {
  const req = (b: any) => ({ json: async () => b }) as any;

  it('rejects values not in the tenant taxonomy (not free-text)', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(req({ classifications: ['PII', 'MadeUpLabel'] }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.code).toBe('unknown_classification');
    expect(j.unknown).toEqual(['MadeUpLabel']);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('rejects a non-array body', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(req({ classifications: 'PII' }), ctx('lakehouse', 'item-1'));
    expect(r.status).toBe(400);
  });

  it('applies taxonomy members (normalised casing) + tags the Atlas asset + audits', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(req({ classifications: ['pii', 'confidential'] }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.classifications).toEqual(['PII', 'Confidential']);
    expect(j.purviewStatus).toBe('written');
    const patched = replaceMock.mock.calls.at(-1)?.[0];
    expect(patched.state.classifications).toEqual(['PII', 'Confidential']);
    expect(ensureDefs).toHaveBeenCalledWith(['LOOM.CLASSIFICATION.PII', 'LOOM.CLASSIFICATION.CONFIDENTIAL']);
    expect(addClassification).toHaveBeenCalledWith('guid-asset-1', ['LOOM.CLASSIFICATION.PII', 'LOOM.CLASSIFICATION.CONFIDENTIAL']);
    expect(auditCreate).toHaveBeenCalledOnce();
  });

  it('writes Cosmos even when Purview is NOT configured (Azure-native / IL5)', async () => {
    purviewConfigured = false;
    const { PUT } = await import('../route');
    const r = await PUT(req({ classifications: ['PII'] }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.purviewStatus).toBe('skipped:purview_not_configured');
    expect(replaceMock).toHaveBeenCalledOnce();
    expect(addClassification).not.toHaveBeenCalled();
  });

  it('skips Atlas tagging when the item has no bound Purview asset', async () => {
    item.state = {};
    const { PUT } = await import('../route');
    const r = await PUT(req({ classifications: ['PII'] }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(j.purviewStatus).toBe('skipped:no-asset');
    expect(addClassification).not.toHaveBeenCalled();
  });

  it('clears classifications on an empty array', async () => {
    item.state = { purviewAssetGuid: 'g', classifications: ['PII'] };
    const { PUT } = await import('../route');
    const r = await PUT(req({ classifications: [] }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.classifications).toEqual([]);
    expect(j.purviewStatus).toBe('skipped:cleared');
    const patched = replaceMock.mock.calls.at(-1)?.[0];
    expect(patched.state.classifications).toBeUndefined();
  });
});
