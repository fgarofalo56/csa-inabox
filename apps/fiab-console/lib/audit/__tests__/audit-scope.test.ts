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
import { describe, it, expect } from 'vitest';
import { AUDIT_TENANT_PREDICATE, auditScopeIds } from '../audit-scope';

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
