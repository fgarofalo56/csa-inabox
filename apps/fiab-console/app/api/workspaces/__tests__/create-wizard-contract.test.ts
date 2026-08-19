/**
 * POST /api/workspaces — the create contract the WorkspaceCreateWizard depends on.
 *
 * FGC-31: the 5-step wizard (lib/wizards/workspace-create.tsx) posts to
 * /api/admin/workspaces when `isAdmin`, and to THIS route otherwise. Both
 * surfaces render the identical wizard, so both routes must accept the
 * identical body — otherwise the same form silently discards inputs on one of
 * them (a no-vaporware defect: a control that doesn't persist).
 *
 * Before this spec the user route destructured only
 * `{ name, description, capacity, domain }` and dropped `contacts`,
 * `licenseMode`, `storageAccountId`, and `provisionBackingRg` on the floor.
 * These tests assert each of those reaches the persisted Cosmos doc / the
 * bindings call, so a future narrowing of the parse goes red here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const created: any[] = [];
const replaced: any[] = [];
const bindingCalls: any[] = [];
const domainExistsScopes: string[] = [];
let session: any;

vi.mock('@/lib/auth/session', () => ({
  getSession: () => session,
  // Real behaviour (`tid || oid`). The domain-existence check keys the
  // per-TENANT domains registry with this rather than the caller's oid (#3753).
  tenantScopeId: (s: any) => s?.claims?.tid || s?.claims?.oid,
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: async () => ({
    items: {
      create: async (doc: any) => {
        created.push(doc);
        return { resource: doc };
      },
    },
    item: () => ({ replace: async (doc: any) => { replaced.push(doc); return { resource: doc }; } }),
  }),
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));

vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(),
  docForWorkspace: (ws: any) => ws,
}));

vi.mock('@/lib/azure/workspace-bindings', () => ({
  applyWorkspaceBindings: async (ws: any, opts: any) => {
    bindingCalls.push({ ws, opts });
    return opts?.provisionBackingRg
      ? { backingRgProvision: { status: 'provisioned', rgName: 'rg-loom-ws-deadbeef' } }
      : {};
  },
}));

vi.mock('@/lib/azure/domain-registry', () => ({
  domainExists: async (tenant: string, id: string) => {
    // #3753 — record the scope the domain registry was consulted with. The
    // registry is per-TENANT; validating it against the caller's oid resolved a
    // private, auto-seeded copy, so only the five STARTER domain ids were ever
    // accepted. `_tenant` was ignored here before, which is exactly why the
    // suite could not tell the fix from the defect.
    domainExistsScopes.push(tenant);
    return id !== 'nope';
  },
  DEFAULT_DOMAIN_ID: 'default',
}));

vi.mock('@/lib/auth/workspace-access', () => ({ listAccessibleWorkspaces: async () => [] }));

const audited: any[] = [];
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (ev: any) => { audited.push(ev); } }));

import { POST } from '../route';

function req(body: any) {
  return new Request('https://console.test/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  created.length = 0;
  replaced.length = 0;
  bindingCalls.length = 0;
  audited.length = 0;
  domainExistsScopes.length = 0;
  session = { claims: { oid: 'tenant-1', tid: 'tid-1', upn: 'u@example.com' } };
});

describe('POST /api/workspaces — wizard field contract', () => {
  // #3753 — the domains registry is per-TENANT (keyed tenantScopeId() since
  // #3282). Validating the requested domain against the caller's raw oid read a
  // private, auto-seeded copy, so a workspace could only ever be bound to one of
  // the five STARTER domains and every real tenant domain was rejected with
  // "it is not registered in this tenant" — about a domain that IS registered.
  // oid and tid are deliberately different values in this fixture.
  it('validates the domain against the TENANT scope, not the caller oid', async () => {
    const { POST } = await import('@/app/api/workspaces/route');
    await POST(req({ name: 'W', domain: 'finance' }));
    expect(domainExistsScopes).toEqual(['tid-1']);
    expect(domainExistsScopes).not.toContain('tenant-1');
  });

  it('persists licenseMode, contacts and storageAccountId from the wizard body', async () => {
    const res = await POST(req({
      name: 'Finance Analytics',
      description: 'FP&A',
      licenseMode: 'PremiumPerUser',
      contacts: ['a@example.com', ' b@example.com '],
      storageAccountId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lake',
      domain: 'default',
    }));
    expect(res.status).toBe(201);
    const doc = created[0];
    expect(doc.licenseMode).toBe('PremiumPerUser');
    expect(doc.contacts).toEqual(['a@example.com', 'b@example.com']);
    expect(doc.storageAccountId).toContain('storageAccounts/lake');
  });

  it('defaults licenseMode to the Azure-native Org mode and rejects unknown modes', async () => {
    await POST(req({ name: 'A', licenseMode: 'NotAMode' }));
    expect(created[0].licenseMode).toBe('Org');
    created.length = 0;
    await POST(req({ name: 'B' }));
    expect(created[0].licenseMode).toBe('Org');
  });

  it('threads provisionBackingRg into applyWorkspaceBindings and records the RG name', async () => {
    const res = await POST(req({ name: 'Ops', provisionBackingRg: true }));
    expect(res.status).toBe(201);
    expect(bindingCalls[0].opts).toEqual({ provisionBackingRg: true });
    const merged = await res.json();
    expect(merged.backingRgProvision?.status).toBe('provisioned');
    expect(merged.backingRgName).toBe('rg-loom-ws-deadbeef');
  });

  it('does not provision a backing RG unless explicitly opted in', async () => {
    await POST(req({ name: 'Ops' }));
    expect(bindingCalls[0].opts).toEqual({ provisionBackingRg: false });
  });

  it('emits a workspace.create audit event on this surface too', async () => {
    await POST(req({ name: 'Audited', licenseMode: 'Org' }));
    expect(audited).toHaveLength(1);
    expect(audited[0].action).toBe('workspace.create');
    expect(audited[0].targetType).toBe('workspace');
    expect(audited[0].detail.name).toBe('Audited');
  });

  it('still enforces auth and the domain binding', async () => {
    session = null;
    expect((await POST(req({ name: 'X' }))).status).toBe(401);
    session = { claims: { oid: 'tenant-1', tid: 'tid-1', upn: 'u@example.com' } };
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ name: 'X', domain: 'nope' }))).status).toBe(400);
  });
});
