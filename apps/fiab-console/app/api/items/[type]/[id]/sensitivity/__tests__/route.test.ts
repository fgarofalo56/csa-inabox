/**
 * BFF route tests for /api/items/[type]/[id]/sensitivity (Purview Data Map flavour).
 *
 * Asserts:
 *  - GET unauthed → 401
 *  - GET when Purview is NOT configured → 503 purview_not_configured + named hint
 *  - GET happy path → 200 with the LIVE Data Map label taxonomy + current label
 *  - PUT applying a label with a bound Purview asset → 200, PATCHes item.state,
 *    ensures + adds the Atlas classification, purviewStatus:'written', audit row
 *  - PUT when Purview is NOT configured → 200, Cosmos write succeeds (Azure-native
 *    default / IL5 fallback), purviewStatus:'skipped:purview_not_configured'
 *  - PUT with empty labelId → clears the label
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
}));

// --- Purview Data Map mock ------------------------------------------------
class FakePurviewNotConfigured extends Error {
  hint = { missingEnvVar: 'LOOM_PURVIEW_ACCOUNT' };
  constructor() { super('Microsoft Purview is not provisioned: missing LOOM_PURVIEW_ACCOUNT'); }
}
class FakePurviewError extends Error {
  status: number; body: unknown;
  constructor(status: number, body: unknown, message?: string) { super(message || `Purview ${status}`); this.status = status; this.body = body; }
}
let purviewConfigured = true;
const ensureDefs = vi.fn(async () => {});
const addClassification = vi.fn(async () => {});
const labels = [
  { typedefName: 'MICROSOFT.GOVERNANCE.LABELS.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', displayName: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
  { typedefName: 'MICROSOFT.GOVERNANCE.LABELS.confidential', id: 'MICROSOFT.GOVERNANCE.LABELS.confidential', displayName: 'confidential' },
];
vi.mock('@/lib/azure/purview-client', () => ({
  isPurviewConfigured: () => purviewConfigured,
  listSensitivityLabels: async () => labels,
  ensureClassificationDefs: (...a: any[]) => ensureDefs(...a),
  addAssetClassification: (...a: any[]) => addClassification(...a),
  SENSITIVITY_LABEL_TYPEDEF_PREFIX: 'MICROSOFT.GOVERNANCE.LABELS.',
  PurviewNotConfiguredError: FakePurviewNotConfigured,
  PurviewError: FakePurviewError,
}));

let gov = false;
vi.mock('@/lib/azure/cloud-endpoints', () => ({ isGovCloud: () => gov }));

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) });

beforeEach(() => {
  purviewConfigured = true;
  gov = false;
  item.state = { purviewAssetGuid: 'guid-asset-1' };
  getSessionMock.mockReturnValue({ claims: { oid: 'ten-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 } as any);
});
afterEach(() => { vi.clearAllMocks(); });

describe('GET /api/items/[type]/[id]/sensitivity', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    expect(r.status).toBe(401);
  });

  it('503 purview_not_configured with named hint when Purview is unset', async () => {
    purviewConfigured = false;
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.code).toBe('purview_not_configured');
    expect(j.error).toMatch(/LOOM_PURVIEW_ACCOUNT/);
  });

  it('503 in a Gov boundary carries the IL5/GCC-H gov note (MIP unavailable)', async () => {
    purviewConfigured = false;
    gov = true;
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.gov).toBe(true);
    expect(j.govNote).toMatch(/Cosmos|catalog/i);
    expect(j.govNote).toMatch(/LOOM_PURVIEW_ACCOUNT/);
  });

  it('200 with the live Data Map taxonomy + current label', async () => {
    item.state = { purviewAssetGuid: 'guid-asset-1', sensitivityLabel: 'confidential', sensitivityLabelId: 'lab-x' };
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.source).toBe('purview-datamap');
    expect(j.labels).toHaveLength(2);
    expect(j.currentLabelName).toBe('confidential');
    expect(j.hasPurviewAsset).toBe(true);
  });
});

describe('PUT /api/items/[type]/[id]/sensitivity', () => {
  const req = (b: any) => ({ json: async () => b }) as any;

  it('applies a label: persists Cosmos + tags the Atlas asset + audits', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(req({ labelId: 'lab-conf', labelName: 'Confidential' }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.labelName).toBe('Confidential');
    expect(j.purviewStatus).toBe('written');
    const patched = replaceMock.mock.calls.at(-1)?.[0];
    expect(patched.state.sensitivityLabel).toBe('Confidential');
    expect(patched.state.sensitivityLabelId).toBe('lab-conf');
    expect(ensureDefs).toHaveBeenCalledWith(['MICROSOFT.GOVERNANCE.LABELS.lab-conf']);
    expect(addClassification).toHaveBeenCalledWith('guid-asset-1', ['MICROSOFT.GOVERNANCE.LABELS.lab-conf']);
    expect(auditCreate).toHaveBeenCalledOnce();
  });

  it('writes Cosmos even when Purview is NOT configured (Azure-native / IL5 fallback)', async () => {
    purviewConfigured = false;
    const { PUT } = await import('../route');
    const r = await PUT(req({ labelId: 'lab-conf', labelName: 'Confidential' }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.purviewStatus).toBe('skipped:purview_not_configured');
    expect(replaceMock).toHaveBeenCalledOnce();
    expect(addClassification).not.toHaveBeenCalled();
  });

  it('skips Atlas tagging when the item has no bound Purview asset', async () => {
    item.state = {};
    const { PUT } = await import('../route');
    const r = await PUT(req({ labelId: 'lab-conf', labelName: 'Confidential' }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(j.purviewStatus).toBe('skipped:no-asset');
    expect(addClassification).not.toHaveBeenCalled();
  });

  it('clears the label on empty labelId', async () => {
    item.state = { purviewAssetGuid: 'g', sensitivityLabel: 'Confidential', sensitivityLabelId: 'lab-conf' };
    const { PUT } = await import('../route');
    const r = await PUT(req({ labelId: '' }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.cleared).toBe(true);
    const patched = replaceMock.mock.calls.at(-1)?.[0];
    expect(patched.state.sensitivityLabel).toBeUndefined();
    expect(patched.state.sensitivityLabelId).toBeUndefined();
  });
});
