/**
 * BFF route tests for POST /api/admin/batch-labeling.
 *
 * FOCUS: the S4 class — ACCOUNT-GLOBAL Atlas classification typedefs built from
 * TENANT-AUTHORED text. This route took `labelName` straight from the request
 * body and passed it to `ensureClassificationDefs`, so any tenant admin could
 * mint arbitrary permanent typedefs in a shared Purview account and collide
 * with another tenant's identically-named label. `labelName` is now funnelled
 * through the typedef-namespace authority.
 *
 * Also pins the surrounding contract the fix must not break: Cosmos is the
 * authoritative write and happens even when Purview is off, and the SAME
 * namespaced name is both ensured and attached (attaching the raw label would
 * reference a typedef that no longer exists).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'ten-1', tid: 'ten-1', upn: 'a@t.com', name: 'A', roles: ['Admin'] }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));
// requireTenantAdmin is the REAL implementation — the tenant-admin gate this
// route runs through `withTenantAdmin` is production code, not a stub. Admin is
// granted the way production grants it: LOOM_TENANT_ADMIN_OID (set below).

const itemDoc = {
  id: 'item-1', workspaceId: 'ws-1', itemType: 'lakehouse',
  displayName: 'Sales LH', state: {} as Record<string, unknown>,
};
const replaceMock = vi.fn(async (doc: any) => ({ resource: doc }));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    item: () => ({ read: async () => ({ resource: { ...itemDoc } }), replace: replaceMock }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [itemDoc] }) }) },
  }),
  workspacesContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [{ id: 'ws-1', tenantId: 'ten-1' }] }) }) },
  }),
  tenantSettingsContainer: async () => ({
    item: () => ({ read: async () => ({ resource: { items: [] } }) }),
  }),
}));

class FakeMipNotConfigured extends Error {}
vi.mock('@/lib/azure/mip-graph-client', () => ({
  listSensitivityLabels: async () => [],
  MipNotConfiguredError: FakeMipNotConfigured,
}));
vi.mock('@/lib/azure/powerbi-client', () => ({ setLabelsAsAdmin: async () => ({}) }));

let purviewConfigured = true;
const ensureDefs = vi.fn(async () => {});
const addClassification = vi.fn(async () => {});
const searchMock = vi.fn(async () => [{ id: 'guid-asset-1', name: 'Sales LH' }]);
vi.mock('@/lib/azure/purview-client', () => ({
  isPurviewConfigured: () => purviewConfigured,
  searchPurview: (...a: any[]) => (searchMock as any)(...a),
  ensureClassificationDefs: (...a: any[]) => ensureDefs(...a),
  addAssetClassification: (...a: any[]) => addClassification(...a),
}));

const req = (b: any) => ({ json: async () => b }) as any;
const BODY = { items: [{ id: 'item-1', workspaceId: 'ws-1' }], applyToPurview: true };

const ORIG_ENV = { ...process.env };
beforeEach(() => {
  process.env.LOOM_TENANT_ADMIN_OID = 'ten-1';
  purviewConfigured = true;
  itemDoc.state = {};
  getSessionMock.mockReturnValue({ claims: { oid: 'ten-1', tid: 'ten-1', upn: 'a@t.com', name: 'A' }, exp: Date.now() / 1000 + 3600 } as any);
});
afterEach(() => { vi.clearAllMocks(); process.env = { ...ORIG_ENV }; });

describe('POST /api/admin/batch-labeling — Atlas typedef namespace', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(req({ ...BODY, labelName: 'Confidential' }), undefined as any);
    expect(r.status).toBe(401);
  });

  it('ATTACK: a NON tenant-admin is refused — and mints no global typedef', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    const { POST } = await import('../route');
    const r = await POST(req({ ...BODY, labelName: 'Confidential' }), undefined as any);
    expect(r.status).toBe(403);
    expect(ensureDefs).not.toHaveBeenCalled();
    expect(addClassification).not.toHaveBeenCalled();
  });

  it('ATTACK: the raw body labelName never becomes a global typedef', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ ...BODY, labelName: 'Highly Confidential' }));
    expect(r.status).toBe(200);

    const created: string[] = ensureDefs.mock.calls.at(-1)?.[0] as any;
    expect(created).not.toContain('Highly Confidential');
    expect(created[0]).toMatch(/^LOOM\.LABEL\.[0-9a-f]{8}\.HIGHLY_CONFIDENTIAL$/);
    // The SAME name is attached — not the raw label.
    expect(addClassification).toHaveBeenCalledWith('guid-asset-1', created);
  });

  it('ATTACK: a crafted labelName cannot squat MICROSOFT.GOVERNANCE.LABELS.*', async () => {
    const { POST } = await import('../route');
    await POST(req({ ...BODY, labelName: 'MICROSOFT.GOVERNANCE.LABELS.pwn' }));
    const created: string[] = ensureDefs.mock.calls.at(-1)?.[0] as any;
    expect(created[0].startsWith('MICROSOFT.')).toBe(false);
    expect(created[0]).toMatch(/^LOOM\.LABEL\.[0-9a-f]{8}\./);
  });

  it('ATTACK: two tenants labelling with the same word do NOT share a typedef', async () => {
    const { POST } = await import('../route');
    await POST(req({ ...BODY, labelName: 'Confidential' }));
    const first = (ensureDefs.mock.calls.at(-1)?.[0] as any)[0];

    process.env.LOOM_TENANT_ADMIN_OID = 'ten-2';
    getSessionMock.mockReturnValue({ claims: { oid: 'ten-2', tid: 'ten-2', upn: 'b@t2.com', name: 'B' }, exp: Date.now() / 1000 + 3600 } as any);
    const r2 = await POST(req({ ...BODY, labelName: 'Confidential' }));
    expect(r2.status).toBe(200);
    const second = (ensureDefs.mock.calls.at(-1)?.[0] as any)[0];

    expect(first).not.toBe(second);
    expect(first.endsWith('.CONFIDENTIAL')).toBe(true);
    expect(second.endsWith('.CONFIDENTIAL')).toBe(true);
  });

  it('a REAL MIP label GUID still uses the genuine MICROSOFT.GOVERNANCE.LABELS typedef', async () => {
    const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const { POST } = await import('../route');
    await POST(req({ ...BODY, labelName: 'Confidential', labelId: guid }));
    expect(ensureDefs).toHaveBeenCalledWith([`MICROSOFT.GOVERNANCE.LABELS.${guid}`]);
    expect(addClassification).toHaveBeenCalledWith('guid-asset-1', [`MICROSOFT.GOVERNANCE.LABELS.${guid}`]);
  });

  it('Cosmos still records the HUMAN label name (only the typedef is namespaced)', async () => {
    const { POST } = await import('../route');
    await POST(req({ ...BODY, labelName: 'Highly Confidential' }));
    const patched = replaceMock.mock.calls.at(-1)?.[0];
    expect(patched.state.sensitivityLabel).toBe('Highly Confidential');
  });

  it('writes Cosmos with no Purview typedef call at all when Purview is off', async () => {
    purviewConfigured = false;
    const { POST } = await import('../route');
    const r = await POST(req({ items: BODY.items, labelName: 'Confidential' }));
    expect(r.status).toBe(200);
    expect(ensureDefs).not.toHaveBeenCalled();
    expect(replaceMock).toHaveBeenCalled();
  });

  it('400 when labelName is missing (no typedef work on a bad request)', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ items: BODY.items }));
    expect(r.status).toBe(400);
    expect(ensureDefs).not.toHaveBeenCalled();
  });
});
