/**
 * Protection-policy reconciler — PURE target/diff acceptance (EH Phase-1 §2.3).
 *
 * Exercises computeReconcile (pure) + normalizePolicy/validatePolicy. The
 * Azure-importing deps are mocked so this runs in the vitest node env.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@azure/cosmos', () => ({ CosmosClient: class {} }));
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {}, DefaultAzureCredential: class {}, ManagedIdentityCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/azure/rbac-client', () => ({ enforceAccessGrant: vi.fn(), revokeAccessGrant: vi.fn(), listContainerRoleAssignments: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: vi.fn(), auditLogContainer: vi.fn() }));
vi.mock('@/lib/azure/label-protection', () => ({ resolveItemBackingScope: vi.fn() }));

import { computeReconcile } from '../protection-policy-reconciler';
import { normalizePolicy, validatePolicy, type ProtectionPolicy } from '../protection-policy-client';

const base = (over: Partial<ProtectionPolicy> = {}): ProtectionPolicy => ({
  id: 'pp:fin:secret', resourceId: 'fin', domainId: 'fin', label: 'secret',
  allowPrincipals: ['alice', 'bob'], issuer: 'owner', mode: 'sovereign-rbac',
  tenantId: 't1', updatedAt: 'now', ...over,
});

describe('computeReconcile (pure)', () => {
  it('target = allowPrincipals + issuer', () => {
    const p = computeReconcile(base(), []);
    expect(p.target.sort()).toEqual(['alice', 'bob', 'owner']);
    expect(p.toGrant.sort()).toEqual(['alice', 'bob', 'owner']);
  });
  it('toRevoke = live − target, issuer never revoked', () => {
    const p = computeReconcile(base(), ['alice', 'mallory', 'owner']);
    expect(p.toRevoke).toEqual(['mallory']);
    expect(p.toGrant.sort()).toEqual(['bob']);
  });
  it('sovereign mode needs no Purview', () => {
    expect(computeReconcile(base(), []).purviewRequired).toBe(false);
    expect(computeReconcile(base({ mode: 'purview' }), []).purviewRequired).toBe(true);
  });
  it('exportBlock flag flows through', () => {
    expect(computeReconcile(base({ exportBlock: true }), []).exportBlock).toBe(true);
  });
  it('retainFullControl=false drops issuer from target', () => {
    const p = computeReconcile(base({ retainFullControl: false }), []);
    expect(p.target).not.toContain('owner');
  });
});

describe('validate/normalize (pure)', () => {
  it('requires domainId + label', () => {
    expect(validatePolicy({ domainId: '', label: 'x' })).toMatch(/domainId/);
    expect(validatePolicy({ domainId: 'd', label: '' })).toMatch(/label/);
    expect(validatePolicy({ domainId: 'd', label: 'l' })).toBeNull();
  });
  it('defaults mode sovereign-rbac, resourceId = domainId, dedups allow', () => {
    const n = normalizePolicy({ domainId: 'fin', label: 'secret', allowPrincipals: ['a', 'a'] }, { tenantId: 't1', updatedBy: 'o' });
    expect(n.mode).toBe('sovereign-rbac');
    expect(n.resourceId).toBe('fin');
    expect(n.allowPrincipals).toEqual(['a']);
  });
});
