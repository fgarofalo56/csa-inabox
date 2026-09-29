/**
 * PATCH /api/workspaces/[id] — `storageAccountId` is a tenant-admin field (#4619).
 *
 * A write-capable member may still edit the workspace's other fields, and may
 * re-send the current binding unchanged (a settings form that saves every
 * field). Setting, changing or clearing the binding needs a tenant admin; the
 * refusal comes before the Cosmos replace. The real `isTenantAdmin` runs, keyed
 * on `LOOM_TENANT_ADMIN_OID`. Each load-bearing assertion names the input that
 * breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let session: any;
vi.mock('@/lib/auth/session', () => ({ getSession: () => session }));

const replaced: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    item: () => ({ replace: async (doc: any) => { replaced.push(doc); return { resource: doc }; } }),
  }),
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));
vi.mock('@/lib/azure/loom-search', () => ({ upsertLoomDoc: vi.fn(), deleteLoomDoc: vi.fn(), docForWorkspace: (w: any) => w }));
vi.mock('@/lib/azure/lineage-gc', () => ({ cleanupWorkspaceMetadata: vi.fn() }));
vi.mock('@/lib/azure/resource-teardown', () => ({ teardownWorkspaceBackends: vi.fn() }));
vi.mock('@/lib/azure/workspace-identity-client', () => ({
  cascadeDeleteWorkspaceIdentity: vi.fn(),
  workspaceIdentityProvisioningEnabled: () => false,
}));
vi.mock('@/lib/auth/workspace-denial', () => ({ workspaceDenialResponse: () => null }));

let access: any;
vi.mock('@/lib/auth/workspace-access', () => ({ resolveWorkspaceAccessByOid: async () => access }));

import { PATCH } from '../route';
import { WORKSPACE_STORAGE_ADMIN_ONLY } from '@/lib/util/admin-only-copy';

const CURRENT = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lakea';
const OTHER = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lakeb';
const MEMBER = { claims: { oid: 'member-oid', tid: 't1', upn: 'm@x' } };
const ADMIN = { claims: { oid: 'admin-oid', tid: 't1', upn: 'a@x' } };

function ws(extra: Record<string, unknown> = {}) {
  return { id: 'ws-1', tenantId: 'owner-oid', name: 'Sales', ...extra };
}
function patch(body: Record<string, unknown>) {
  return PATCH({ json: async () => body } as any, { params: Promise.resolve({ id: 'ws-1' }) });
}

beforeEach(() => {
  replaced.length = 0;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  session = MEMBER;
  access = { workspace: ws({ storageAccountId: CURRENT }), role: 'Member', via: 'acl', canWrite: true };
});

describe('PATCH /api/workspaces/[id] — storageAccountId', () => {
  it.each([
    ['changes it to another account', { storageAccountId: OTHER }, CURRENT],
    ['clears it with an empty string', { storageAccountId: '' }, CURRENT],
    ['sets it on a workspace that had none', { storageAccountId: OTHER }, undefined],
  ])('403 admin_only when a write-capable non-admin %s, and nothing is written', async (_l, body, current) => {
    // Breaks if the gate is dropped (200, and `replaced` holds the new binding)
    // or moved after the replace (a doc is written before the refusal).
    access.workspace = ws(current ? { storageAccountId: current } : {});
    const res = await patch({ name: 'Sales', ...body });
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('admin_only');
    expect(j.reason).toBe(WORKSPACE_STORAGE_ADMIN_ONLY.reason);
    expect(replaced).toHaveLength(0);
  });

  it.each([
    ['omits it', { description: 'new text' }],
    ['re-sends the current value', { description: 'new text', storageAccountId: CURRENT }],
    ['re-sends the current value padded', { description: 'new text', storageAccountId: ` ${CURRENT} ` }],
  ])('a write-capable non-admin who %s still saves, binding unchanged (positive pair)', async (_l, body) => {
    // Breaks if the gate fired on any PATCH carrying the field (200 becomes
    // 403), or if an unchanged value were treated as a change.
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].description).toBe('new text');
    expect(replaced[0].storageAccountId).toBe(CURRENT);
  });

  it('a tenant admin changes the binding (positive pair)', async () => {
    // Breaks if admins were refused too, or the new value were not persisted.
    session = ADMIN;
    const res = await patch({ storageAccountId: OTHER });
    expect(res.status).toBe(200);
    expect(replaced[0].storageAccountId).toBe(OTHER);
  });

  it('a tenant admin clears the binding back to the deployment default', async () => {
    // Breaks if an empty string were stored instead of unsetting the field.
    session = ADMIN;
    const res = await patch({ storageAccountId: '' });
    expect(res.status).toBe(200);
    expect(replaced[0].storageAccountId).toBeUndefined();
  });

  it('a read-only role is still refused first, with its own code', async () => {
    // Breaks if the storage gate ran before the canWrite check: the code would
    // be admin_only instead of read_only_role.
    access.canWrite = false;
    const res = await patch({ storageAccountId: OTHER });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('read_only_role');
    expect(replaced).toHaveLength(0);
  });
});
