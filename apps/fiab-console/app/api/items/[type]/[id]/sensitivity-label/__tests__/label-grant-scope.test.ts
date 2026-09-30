/**
 * PATCH /api/items/[type]/[id]/sensitivity-label — label protection grants.
 *
 * Two rules, each pinned by a value that breaks it:
 *
 *   1. The store a label grant lands on comes from bindings Loom recorded for
 *      the item (`resolveItemBackingScope`), never from a field a request may
 *      write. Every fixture below plants a DIFFERENT value in the old
 *      client-writable keys (`state.container`, `state.dedicatedPool`,
 *      `state.adxDatabase`, the display name) than in the server-recorded one,
 *      so a resolver that read the old keys would grant on the planted value.
 *   2. Naming a principal other than the caller requires `admin.permissions` at
 *      Admin. The feature gate is a switch (`admin`), and the test asserts WHICH
 *      capability/role was asked for, so a weaker gate cannot pass.
 *
 * `label-protection` is REAL here (the sibling route.test.ts stubs it); the
 * grant client is a spy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const CALLER = 'caller-oid';
const getSessionMock = vi.fn(() => ({ claims: { oid: CALLER, upn: 'caller@contoso.com', name: 'Caller' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

let item: any;
const replaceMock = vi.fn(async (doc: any) => ({ resource: doc }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [item] }) }) },
    item: () => ({ replace: replaceMock }),
  }),
  // The caller created the workspace, so `authorizeItemWorkspace` admits them
  // for write on its owner fast path.
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: CALLER } }) }),
  }),
  auditLogContainer: async () => ({ items: { create: vi.fn(async (d: any) => ({ resource: d })) } }),
  labelAssignmentsContainer: async () => ({ items: { create: vi.fn(async (d: any) => ({ resource: d })) } }),
}));

const LABEL = { id: 'lab-conf', displayName: 'Confidential', name: 'Confidential', sensitivity: 3, hasProtection: false, isActive: true, isAppliable: true };
vi.mock('@/lib/azure/mip-graph-client', () => ({
  getSensitivityLabel: vi.fn(async (id: string) => (id === LABEL.id ? LABEL : null)),
  getSensitivityLabelWithRights: vi.fn(async () => null),
  listSensitivityLabels: vi.fn(async () => [LABEL]),
  MipNotConfiguredError: class extends Error {},
  MipError: class extends Error { status = 500; },
}));
vi.mock('@/lib/azure/purview-client', () => ({
  isPurviewConfigured: () => false, getAssetDetail: vi.fn(), registerAtlasEntity: vi.fn(),
}));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({ ...(await importOriginal() as any), isGovCloud: () => false }));

let admin = false;
vi.mock('@/lib/auth/feature-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/feature-gate')>()),
  enforceCapability: vi.fn(async () => (admin ? null : NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }))),
}));
vi.mock('@/lib/azure/access-policy-client', () => ({
  enforceAccessGrant: vi.fn(async () => ({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: 'ra-new' })),
}));
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { PATCH } from '../route';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { enforceAccessGrant } from '@/lib/azure/access-policy-client';

const ctx = (type: string) => ({ params: Promise.resolve({ type, id: 'item-1' }) });
const req = (b: any) => ({ json: async () => b }) as any;
const self = { labelId: LABEL.id, principalId: CALLER, principalType: 'User', principalName: 'caller@contoso.com' };

function makeItem(itemType: string, state: Record<string, unknown>, displayName = 'Sales') {
  return { id: 'item-1', workspaceId: 'ws-1', itemType, displayName, state, createdBy: CALLER, createdAt: 'x', updatedAt: 'x' };
}

const prevPool = process.env.LOOM_SYNAPSE_DEDICATED_POOL;
beforeEach(() => {
  admin = false;
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'deploymentpool';
});
afterEach(() => {
  vi.clearAllMocks();
  if (prevPool === undefined) delete process.env.LOOM_SYNAPSE_DEDICATED_POOL;
  else process.env.LOOM_SYNAPSE_DEDICATED_POOL = prevPool;
});

describe('label grant scope comes from the binding Loom recorded', () => {
  it('lakehouse: grants on the receipt container, not on state.container', async () => {
    // Breaks if the resolver reads `state.container` ('planted') or defaults to 'bronze'.
    item = makeItem('lakehouse', { container: 'planted', provisioning: { status: 'created', secondaryIds: { container: 'lh-own' } } });
    const r = await PATCH(req(self), ctx('lakehouse'));
    expect(r.status).toBe(200);
    expect(enforceAccessGrant).toHaveBeenCalledTimes(1);
    expect((enforceAccessGrant as any).mock.calls[0][0]).toMatchObject({ scopeType: 'adls-container', scopeRef: 'lh-own', principalId: CALLER });
  });

  it('lakehouse: state.adlsContainer is used when there is no receipt', async () => {
    // Breaks if the resolver skips `adlsContainer` (server-recorded by auto-bind) for `state.container`.
    item = makeItem('lakehouse', { container: 'planted', adlsContainer: 'landing' });
    await PATCH(req(self), ctx('lakehouse'));
    expect((enforceAccessGrant as any).mock.calls[0][0]).toMatchObject({ scopeRef: 'landing' });
  });

  it('lakehouse with no recorded container: no grant, an honest pending', async () => {
    // Breaks if the old `state.container || 'bronze'` fallback is restored: a grant would land on 'planted'.
    item = makeItem('lakehouse', { container: 'planted' });
    const r = await PATCH(req(self), ctx('lakehouse'));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(j.rbac.status).toBe('pending');
    expect(j.rbac.detail).toMatch(/no storage container recorded/);
  });

  it('warehouse: grants on the deployment pool, not on state.dedicatedPool', async () => {
    // Breaks if the resolver reads `state.dedicatedPool` ('otherpool').
    item = makeItem('warehouse', { dedicatedPool: 'otherpool' });
    await PATCH(req(self), ctx('warehouse'));
    expect((enforceAccessGrant as any).mock.calls[0][0]).toMatchObject({ scopeType: 'warehouse', scopeRef: 'deploymentpool' });
  });

  it('kql-database: grants on the install receipt database', async () => {
    // Breaks if `state.adxDatabase` ('planteddb') or the display name outranks the receipt.
    item = makeItem('kql-database', { adxDatabase: 'planteddb', provisioning: { status: 'created', secondaryIds: { database: 'kql-own' } } }, 'planteddb');
    await PATCH(req(self), ctx('kql-database'));
    expect((enforceAccessGrant as any).mock.calls[0][0]).toMatchObject({ scopeType: 'kql-database', scopeRef: 'kql-own' });
  });

  it('kql-database with no install receipt: no grant, an honest pending', async () => {
    // Breaks if the old `state.adxDatabase || displayName` fallback is restored.
    item = makeItem('eventhouse', { adxDatabase: 'planteddb' }, 'planteddb');
    const r = await PATCH(req(self), ctx('eventhouse'));
    const j = await r.json();
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(j.rbac.status).toBe('pending');
  });

  it('kql-database: a FAILED install receipt is not a binding', async () => {
    // Breaks if the resolver accepts a receipt whose status is not created/exists.
    item = makeItem('kql-database', { provisioning: { status: 'failed', secondaryIds: { database: 'half-made' } } });
    const r = await PATCH(req(self), ctx('kql-database'));
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect((await r.json()).rbac.status).toBe('pending');
  });
});

describe('naming a principal other than the caller requires admin.permissions', () => {
  const lakehouse = () => makeItem('lakehouse', { adlsContainer: 'landing' });

  it('non-admin naming another user: 403, no grant, nothing written', async () => {
    // Breaks if the principal check is removed or keyed on anything but "not the caller".
    item = lakehouse();
    const r = await PATCH(req({ ...self, principalId: 'someone-else', principalName: 'x@contoso.com' }), ctx('lakehouse'));
    expect(r.status).toBe(403);
    expect(enforceCapability).toHaveBeenCalledWith(expect.anything(), 'admin.permissions', 'Admin');
    expect(enforceAccessGrant).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('non-admin naming a GROUP whose id equals their own oid: 403', async () => {
    // Breaks if "self" is decided on the id alone, ignoring principalType.
    item = lakehouse();
    const r = await PATCH(req({ ...self, principalType: 'Group' }), ctx('lakehouse'));
    expect(r.status).toBe(403);
    expect(enforceAccessGrant).not.toHaveBeenCalled();
  });

  it('non-admin naming themselves: the grant proceeds without the admin check', async () => {
    // Breaks if the admin check is applied to every principal (self-protection would 403).
    item = lakehouse();
    const r = await PATCH(req(self), ctx('lakehouse'));
    expect(r.status).toBe(200);
    expect(enforceCapability).not.toHaveBeenCalled();
    expect(enforceAccessGrant).toHaveBeenCalledTimes(1);
  });

  it('tenant admin naming another user: the grant proceeds', async () => {
    // Breaks if the check refuses admins, or if the grant is skipped after it passes.
    admin = true;
    item = lakehouse();
    const r = await PATCH(req({ ...self, principalId: 'someone-else', principalName: 'x@contoso.com' }), ctx('lakehouse'));
    expect(r.status).toBe(200);
    expect((enforceAccessGrant as any).mock.calls[0][0]).toMatchObject({ principalId: 'someone-else', scopeRef: 'landing' });
  });
});
