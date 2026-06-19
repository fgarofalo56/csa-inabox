/**
 * BFF route tests for /api/items/[type]/[id]/sensitivity-label.
 *
 * Asserts:
 *  - GET unauthed → 401
 *  - GET happy path → 200 with the LIVE Graph taxonomy (no static list) and the
 *    item's current label echoed back
 *  - GET when MIP is not wired → 503 mip_not_configured + structured hint
 *  - PUT applying a valid, appliable label → 200, PATCHes item.state, writes an
 *    assignment + audit row
 *  - PUT applying a policy-blocked (isAppliable:false) label → 400
 *    label_policy_blocked with the restriction reason
 *  - PUT with an unknown labelId → 400 label_not_found
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
const assignCreate = vi.fn(async (d: any) => ({ resource: d }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [item] }) }) },
    item: () => ({ replace: replaceMock }),
  }),
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: 'ten-1' } }) }),
  }),
  auditLogContainer: async () => ({ items: { create: auditCreate } }),
  labelAssignmentsContainer: async () => ({ items: { create: assignCreate } }),
}));

// --- MIP Graph mock -------------------------------------------------------
let mipShouldThrowNotConfigured = false;
const labels = [
  { id: 'lab-general', displayName: 'General', sensitivity: 0, isActive: true, isAppliable: true, color: '#0f0' },
  { id: 'lab-conf', displayName: 'Confidential', sensitivity: 2, isActive: true, isAppliable: true, color: '#f80' },
  { id: 'lab-restricted', displayName: 'Restricted', sensitivity: 4, isActive: true, isAppliable: false, color: '#f00', tooltip: 'Restricted to the Legal team by policy.' },
];
class FakeMipNotConfigured extends Error {
  hint = { missingEnvVar: 'LOOM_MIP_ENABLED' };
  constructor() { super('not configured'); }
}
vi.mock('@/lib/azure/mip-graph-client', () => ({
  listSensitivityLabels: async () => {
    if (mipShouldThrowNotConfigured) throw new FakeMipNotConfigured();
    return labels;
  },
  MipNotConfiguredError: FakeMipNotConfigured,
  MipError: class extends Error { status = 500; body: any; },
}));

// --- Purview mock ---------------------------------------------------------
const registerAtlas = vi.fn(async () => ({ primaryGuid: 'guid-asset-1' }));
vi.mock('@/lib/azure/purview-client', () => ({
  isPurviewConfigured: () => true,
  getAssetDetail: async () => ({ entity: { typeName: 'azure_datalake_gen2_path', attributes: { qualifiedName: 'https://x/y', name: 'Sales LH' } } }),
  registerAtlasEntity: (...a: any[]) => registerAtlas(...a),
}));

vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({ ...(await importOriginal() as any), isGovCloud: () => false }));

// label-protection powers ONLY the PATCH (F20/F21) path, which these tests do
// not exercise. It pulls a heavy transitive graph (ARM/identity access-grant
// clients) whose first-load init blocked the very first handler call for ~2s,
// pushing the unauthenticated GET test over its timeout. Stub it so route
// import is fast; the GET/PUT paths under test never call into it.
vi.mock('@/lib/azure/label-protection', () => ({
  isProtectedLabel: () => false,
  checkLabelChangeRights: vi.fn(async () => ({ allowed: true })),
  enforceLabelRbac: vi.fn(async () => ({ ok: true })),
  resolveItemBackingScope: vi.fn(async () => null),
}));

// @azure/identity is constructed deep in the (now-stubbed) graph; mock it too
// so no real credential/environment probing happens on import.
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) });

beforeEach(() => {
  mipShouldThrowNotConfigured = false;
  item.state = { purviewAssetGuid: 'guid-asset-1' };
  getSessionMock.mockReturnValue({ claims: { oid: 'ten-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 } as any);
});
afterEach(() => { vi.clearAllMocks(); });

describe('GET /api/items/[type]/[id]/sensitivity-label', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    expect(r.status).toBe(401);
  });

  it('200 with live taxonomy + current label', async () => {
    item.state = { purviewAssetGuid: 'guid-asset-1', sensitivityLabel: 'General', sensitivityLabelId: 'lab-general' };
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.source).toBe('graph-beta');
    expect(j.labels).toHaveLength(3);
    expect(j.currentLabelId).toBe('lab-general');
  });

  it('503 mip_not_configured with hint', async () => {
    mipShouldThrowNotConfigured = true;
    const { GET } = await import('../route');
    const r = await GET({} as any, ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.code).toBe('mip_not_configured');
    expect(j.hint?.missingEnvVar).toBe('LOOM_MIP_ENABLED');
  });
});

describe('PUT /api/items/[type]/[id]/sensitivity-label', () => {
  const req = (b: any) => ({ json: async () => b }) as any;

  it('applies an appliable label + persists + writes purview + audit', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(req({ labelId: 'lab-conf' }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.labelName).toBe('Confidential');
    expect(j.purviewStatus).toBe('written');
    // item.state PATCHed
    const patched = replaceMock.mock.calls.at(-1)?.[0];
    expect(patched.state.sensitivityLabel).toBe('Confidential');
    expect(patched.state.sensitivityLabelId).toBe('lab-conf');
    expect(registerAtlas).toHaveBeenCalledOnce();
    expect(assignCreate).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledOnce();
  });

  it('400 label_policy_blocked for a non-appliable label, with reason', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(req({ labelId: 'lab-restricted' }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.code).toBe('label_policy_blocked');
    expect(j.reason).toContain('Legal team');
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('400 label_not_found for an unknown labelId', async () => {
    const { PUT } = await import('../route');
    const r = await PUT(req({ labelId: 'nope' }), ctx('lakehouse', 'item-1'));
    const j = await r.json();
    expect(r.status).toBe(400);
    expect(j.code).toBe('label_not_found');
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
  });
});
