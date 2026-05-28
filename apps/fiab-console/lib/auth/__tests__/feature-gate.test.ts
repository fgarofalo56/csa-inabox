/**
 * Feature-gate tests — verify capability resolution, parent-chain
 * propagation, role precedence, and tenant-admin bypass.
 *
 * The Cosmos container is mocked so the test doesn't need a live
 * Cosmos endpoint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let mockGrants: any[] = [];

vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: async () => ({
    items: {
      query: () => ({ fetchAll: async () => ({ resources: mockGrants }) }),
    },
  }),
}));

beforeEach(() => {
  mockGrants = [];
  delete process.env.LOOM_TENANT_ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
});
afterEach(() => {
  vi.resetAllMocks();
});

const session = (oid: string, groups: string[] = []) => ({
  claims: { oid, name: 'X', upn: `${oid}@example.com`, groups },
  exp: Math.floor(Date.now() / 1000) + 3600,
} as any);

describe('checkCapability', () => {
  it('allows tenant admin by oid bypass', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'tenant-admin-oid';
    const { checkCapability } = await import('../feature-gate');
    const r = await checkCapability(session('tenant-admin-oid'), 'editor.notebook');
    expect(r.allow).toBe(true);
    expect(r.role).toBe('Admin');
  });

  it('allows tenant admin by group bypass', async () => {
    process.env.LOOM_TENANT_ADMIN_GROUP_ID = 'g-admin,g-admin2';
    const { checkCapability } = await import('../feature-gate');
    const r = await checkCapability(session('user-1', ['g-admin']), 'editor.notebook');
    expect(r.allow).toBe(true);
  });

  it('denies when no grant exists', async () => {
    const { checkCapability } = await import('../feature-gate');
    mockGrants = [];
    const r = await checkCapability(session('user-1'), 'editor.notebook');
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('No grant');
  });

  it('allows when grant exists on the capability itself', async () => {
    mockGrants = [{
      id: 'g1', tenantId: 'user-1', capabilityId: 'editor.notebook',
      principalId: 'user-1', principalType: 'user', role: 'Reader',
      grantedBy: 'admin', grantedAt: '2026-01-01',
    }];
    const { checkCapability } = await import('../feature-gate');
    const r = await checkCapability(session('user-1'), 'editor.notebook', 'Reader');
    expect(r.allow).toBe(true);
    expect(r.role).toBe('Reader');
  });

  it('allows when grant exists on parent workload (capability inheritance)', async () => {
    mockGrants = [{
      id: 'g1', tenantId: 'user-1', capabilityId: 'workload.notebooks',
      principalId: 'user-1', principalType: 'user', role: 'Contributor',
      grantedBy: 'admin', grantedAt: '2026-01-01',
    }];
    const { checkCapability } = await import('../feature-gate');
    const r = await checkCapability(session('user-1'), 'editor.notebook', 'Reader');
    expect(r.allow).toBe(true);
    expect(r.matchedCapability).toBe('workload.notebooks');
  });

  it('denies when caller has Reader but Contributor required', async () => {
    mockGrants = [{
      id: 'g1', tenantId: 'user-1', capabilityId: 'editor.notebook',
      principalId: 'user-1', principalType: 'user', role: 'Reader',
      grantedBy: 'admin', grantedAt: '2026-01-01',
    }];
    const { checkCapability } = await import('../feature-gate');
    const r = await checkCapability(session('user-1'), 'editor.notebook', 'Contributor');
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('requires Contributor');
  });

  it('allows when caller is in a group that has the grant', async () => {
    mockGrants = [{
      id: 'g1', tenantId: 'user-1', capabilityId: 'editor.notebook',
      principalId: 'group-eng', principalType: 'group', role: 'Admin',
      grantedBy: 'admin', grantedAt: '2026-01-01',
    }];
    const { checkCapability } = await import('../feature-gate');
    const r = await checkCapability(session('user-1', ['group-eng']), 'editor.notebook', 'Admin');
    expect(r.allow).toBe(true);
    expect(r.role).toBe('Admin');
  });
});

describe('ancestor chain', () => {
  it('walks parent ids', async () => {
    const { ancestorIds } = await import('../feature-catalog');
    const chain = ancestorIds('editor.notebook');
    expect(chain).toContain('editor.notebook');
    expect(chain).toContain('workload.notebooks');
  });
});
