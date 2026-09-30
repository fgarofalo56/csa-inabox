/**
 * The admin-plane workspace routes: `storageAccountId` is a tenant-admin field
 * (#4619), the same rule as POST /api/workspaces and PATCH /api/workspaces/[id].
 *
 * - POST /api/admin/workspaces is not itself tenant-admin gated (session, rate
 *   limit, PDP), so naming a storage account must be refused there before the
 *   Cosmos create.
 * - PATCH /api/admin/workspaces/[id] admits the workspace OWNER through
 *   resolveAdminWorkspace, so setting, changing or clearing the binding must be
 *   refused there before the Cosmos replace. Omitting the field, or re-sending
 *   the stored value (trimmed), is not a change.
 *
 * The real `isTenantAdmin` runs, keyed on `LOOM_TENANT_ADMIN_OID`. Each
 * load-bearing assertion names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let session: any;
vi.mock('@/lib/auth/session', () => ({
  getSession: () => session,
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));
vi.mock('@/lib/auth/pdp/enforce', () => ({ pdpCheck: async () => null }));
vi.mock('@/lib/azure/rate-limiter', () => ({ enforceRateLimit: async () => null }));
vi.mock('@/lib/azure/domain-registry', () => ({ domainExists: async () => true, DEFAULT_DOMAIN_ID: 'default' }));
vi.mock('@/lib/azure/workspace-bindings', () => ({ applyWorkspaceBindings: async () => ({}) }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
vi.mock('@/lib/clients/workspaces-client', () => ({ listAllWorkspacesAdmin: vi.fn() }));
vi.mock('@/lib/azure/loom-search', () => ({ upsertLoomDoc: vi.fn(), deleteLoomDoc: vi.fn(), docForWorkspace: (w: any) => w }));
vi.mock('@/lib/azure/fabric-client', () => ({ assignWorkspaceToCapacity: vi.fn(), FabricError: class extends Error {} }));
vi.mock('@/lib/azure/workspace-identity-client', () => ({
  cascadeDeleteWorkspaceIdentity: vi.fn(),
  workspaceIdentityProvisioningEnabled: () => false,
}));

const created: any[] = [];
const replaced: any[] = [];
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    items: { create: async (doc: any) => { created.push(doc); return { resource: doc }; } },
    item: () => ({ replace: async (doc: any) => { replaced.push(doc); return { resource: doc }; } }),
  }),
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));

// resolveAdminWorkspace admits the owner or a tenant admin; the gate under test
// runs after it, so the resolver answers with the caller's session and the doc.
let stored: any;
vi.mock('@/lib/auth/workspace-guard', () => ({
  resolveAdminWorkspace: async () => ({ session, ws: stored }),
}));

import { POST } from '../route';
import { PATCH } from '../[id]/route';
import { WORKSPACE_STORAGE_ADMIN_ONLY } from '@/lib/util/admin-only-copy';

const CURRENT = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lakea';
const OTHER = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lakeb';
const OWNER = { claims: { oid: 'owner-oid', tid: 't1', upn: 'o@x' } };
const ADMIN = { claims: { oid: 'admin-oid', tid: 't1', upn: 'a@x' } };

function post(body: Record<string, unknown>) {
  return POST({ json: async () => body } as any);
}
function patch(body: Record<string, unknown>) {
  return PATCH({ json: async () => body } as any, { params: Promise.resolve({ id: 'ws-1' }) });
}

beforeEach(() => {
  created.length = 0;
  replaced.length = 0;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
  process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  session = OWNER;
  stored = { id: 'ws-1', tenantId: 'owner-oid', tid: 't1', name: 'Sales', storageAccountId: CURRENT };
});

describe('POST /api/admin/workspaces — storageAccountId', () => {
  it('403 admin_only when a non-admin names a storage account, and nothing is created', async () => {
    // Breaks if the gate is dropped (201, and `created` holds the account) or
    // moved after the Cosmos create (a doc is written before the refusal).
    const res = await post({ name: 'Sales', storageAccountId: OTHER });
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('admin_only');
    expect(j.reason).toBe(WORKSPACE_STORAGE_ADMIN_ONLY.reason);
    expect(created).toHaveLength(0);
  });

  it.each([
    ['omits it', {}],
    ['sends only whitespace', { storageAccountId: '   ' }],
  ])('a non-admin who %s creates on the deployment default (positive pair)', async (_l, extra) => {
    // Breaks if the gate fired on any body carrying the key (whitespace would be
    // 403), or if a create without an account were refused.
    const res = await post({ name: 'Sales', ...extra });
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
    expect(created[0].storageAccountId).toBeUndefined();
  });

  it('a tenant admin names the account and it is stored trimmed (positive pair)', async () => {
    // Breaks if admins were refused too, or the value were stored untrimmed.
    session = ADMIN;
    const res = await post({ name: 'Sales', storageAccountId: ` ${OTHER} ` });
    expect(res.status).toBe(201);
    expect(created[0].storageAccountId).toBe(OTHER);
  });
});

describe('PATCH /api/admin/workspaces/[id] — storageAccountId', () => {
  it.each([
    ['changes it to another account', { storageAccountId: OTHER }, CURRENT],
    ['clears it with an empty string', { storageAccountId: '' }, CURRENT],
    ['sets it on a workspace that had none', { storageAccountId: OTHER }, undefined],
  ])('403 admin_only when the non-admin owner %s, and nothing is written', async (_l, body, current) => {
    // Breaks if the gate is dropped (200, and `replaced` holds the new binding)
    // or moved after the replace (a doc is written before the refusal).
    stored = { ...stored, storageAccountId: current };
    const res = await patch({ description: 'x', ...body });
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
  ])('the non-admin owner who %s still saves, binding unchanged (positive pair)', async (_l, body) => {
    // Breaks if the gate fired on any PATCH carrying the field, or if an
    // unchanged value were treated as a change (200 becomes 403).
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].description).toBe('new text');
    expect(replaced[0].storageAccountId).toBe(CURRENT);
  });

  it('the owner who omits the field saves even when the stored value is padded', async () => {
    // Breaks if an omitted field were compared as a change: " <id> " differs
    // from its trimmed form, so the gate would answer 403.
    stored = { ...stored, storageAccountId: ` ${CURRENT} ` };
    const res = await patch({ description: 'new text' });
    expect(res.status).toBe(200);
    expect(replaced[0].storageAccountId).toBe(` ${CURRENT} `);
  });

  it('the owner who re-sends the trimmed value saves when the stored value is padded', async () => {
    // Breaks if the re-sent value were compared against the untrimmed stored
    // value: "<id>" !== " <id> " would read as a change and answer 403.
    stored = { ...stored, storageAccountId: ` ${CURRENT} ` };
    const res = await patch({ description: 'new text', storageAccountId: CURRENT });
    expect(res.status).toBe(200);
    expect(replaced[0].storageAccountId).toBe(CURRENT);
  });

  it('a tenant admin changes the binding, and clears it (positive pair)', async () => {
    // Breaks if admins were refused too, if the new value were not persisted,
    // or if a clear stored '' instead of unsetting the field.
    session = ADMIN;
    const changed = await patch({ storageAccountId: OTHER });
    expect(changed.status).toBe(200);
    expect(replaced[0].storageAccountId).toBe(OTHER);
    const cleared = await patch({ storageAccountId: '' });
    expect(cleared.status).toBe(200);
    expect(replaced[1].storageAccountId).toBeUndefined();
  });
});
