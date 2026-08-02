/**
 * Unit spec for the shared audit-log tenant scope (#2635).
 *
 * The rule this pins is small but load-bearing: the Cosmos `audit-log`
 * container partitions on `/itemId`, and its writers record `tenantId` as
 * either the actor's `oid` or the Entra `tid`. Every reader therefore has to
 * bind BOTH ids and query cross-partition. Four surfaces had independently
 * drifted back to `c.tenantId = @t` with `@t = oid`; this module is the single
 * definition they now share.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// feature-gate pulls in next/headers via session.ts; stub the ONE predicate
// auditScopeIdsForViewer consumes so this stays a pure unit spec.
const isTenantAdminMock = vi.fn(() => false);
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: (s: any) => isTenantAdminMock(s) }));

import { AUDIT_TENANT_PREDICATE, auditScopeIds, auditScopeIdsForViewer } from '../audit-scope';

describe('auditScopeIds', () => {
  it('covers BOTH the actor oid and the Entra tid when they differ', () => {
    expect(auditScopeIds({ oid: 'user-oid', tid: 'entra-tid' })).toEqual(['user-oid', 'entra-tid']);
  });

  it('falls back to the oid alone when tid is absent (bootstrap session)', () => {
    expect(auditScopeIds({ oid: 'user-oid' })).toEqual(['user-oid']);
    expect(auditScopeIds({ oid: 'user-oid', tid: undefined })).toEqual(['user-oid']);
  });

  it('never emits a duplicate when tid === oid', () => {
    expect(auditScopeIds({ oid: 'same', tid: 'same' })).toEqual(['same']);
  });

  it('never returns an empty set (an empty ARRAY_CONTAINS matches nothing)', () => {
    for (const claims of [{ oid: 'a' }, { oid: 'a', tid: '' }, { oid: 'a', tid: 'b' }]) {
      expect(auditScopeIds(claims).length).toBeGreaterThan(0);
    }
  });

  it('pairs with a predicate that binds @tenants — never the oid-only form', () => {
    expect(AUDIT_TENANT_PREDICATE).toContain('@tenants');
    expect(AUDIT_TENANT_PREDICATE).not.toMatch(/c\.tenantId\s*=/);
  });
});

describe('auditScopeIdsForViewer (session-only surfaces)', () => {
  const session = { claims: { oid: 'user-oid', tid: 'entra-tid' } } as any;

  beforeEach(() => { isTenantAdminMock.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('widens to oid + tid for a tenant admin', () => {
    isTenantAdminMock.mockReturnValue(true);
    expect(auditScopeIdsForViewer(session)).toEqual(['user-oid', 'entra-tid']);
  });

  it('narrows a NON-admin back to their own oid — no org-wide activity volume', () => {
    isTenantAdminMock.mockReturnValue(false);
    expect(auditScopeIdsForViewer(session)).toEqual(['user-oid']);
  });

  it('consults the real tenant-admin predicate with the caller session', () => {
    isTenantAdminMock.mockReturnValue(false);
    auditScopeIdsForViewer(session);
    expect(isTenantAdminMock).toHaveBeenCalledWith(session);
  });
});
