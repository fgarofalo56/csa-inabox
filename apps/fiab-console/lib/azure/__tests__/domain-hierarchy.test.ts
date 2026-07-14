/**
 * Unit specs for the shared domain-hierarchy invariants used by BOTH domain
 * move endpoints (admin tenant-settings store + governance Cosmos store).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  validateDomainMove, isDomainTenantAdmin, domainDepth, rootAncestorId, MAX_DOMAIN_DEPTH,
} from '../domain-hierarchy';

describe('validateDomainMove', () => {
  // root → child, plus an unrelated root
  const tree = [
    { id: 'root' },
    { id: 'child', parentId: 'root' },
    { id: 'other' },
  ];

  it('allows a move to root (undefined parent)', () => {
    expect(validateDomainMove(tree, 'child', undefined)).toBeNull();
  });

  it('allows nesting a root under another root', () => {
    expect(validateDomainMove(tree, 'other', 'root')).toBeNull();
  });

  it('rejects self-parent', () => {
    expect(validateDomainMove(tree, 'root', 'root')).toMatchObject({ status: 400 });
  });

  it('rejects a non-existent target parent', () => {
    expect(validateDomainMove(tree, 'other', 'ghost')).toMatchObject({ status: 400 });
  });

  it('rejects a cycle (root under its own child)', () => {
    const err = validateDomainMove(tree, 'root', 'child');
    expect(err).toMatchObject({ status: 400 });
    expect(err!.message).toMatch(/own subdomain/i);
  });

  it('ALLOWS nesting under a subdomain (arbitrary depth — #1483 Wave 2)', () => {
    // 'other' → under 'child' creates a level-3 node; that is now valid.
    expect(validateDomainMove(tree, 'other', 'child')).toBeNull();
  });

  it('ALLOWS moving a domain that itself has subdomains (its subtree travels with it)', () => {
    // root has subdomain `child`; moving root under `other` is fine — child just
    // lands at level 3.
    expect(validateDomainMove(tree, 'root', 'other')).toBeNull();
  });

  it('rejects a move that would exceed the max depth', () => {
    // A straight chain a→b→c→…: moving the deepest under the last leaf would push
    // past MAX_DOMAIN_DEPTH. Build a chain exactly at the cap, plus a spare root.
    const chain = Array.from({ length: MAX_DOMAIN_DEPTH }, (_, i) => ({
      id: `n${i}`, parentId: i === 0 ? undefined : `n${i - 1}`,
    }));
    // n0..n{MAX-1} is a chain of depth MAX. A spare root 'spare' with one child.
    const withSpare = [...chain, { id: 'spare' }, { id: 'spare-kid', parentId: 'spare' }];
    // Moving 'spare' (height 2) under the deepest chain node (depth MAX) → MAX+1.
    const err = validateDomainMove(withSpare, 'spare', `n${MAX_DOMAIN_DEPTH - 1}`);
    expect(err).toMatchObject({ status: 400 });
    expect(err!.message).toMatch(/levels deep/i);
  });
});

describe('domainDepth + rootAncestorId', () => {
  const deep = [
    { id: 'dept' },
    { id: 'agency', parentId: 'dept' },
    { id: 'subagency', parentId: 'agency' },
    { id: 'office', parentId: 'subagency' },
    { id: 'lone' },
  ];

  it('computes depth (root = 1) down an arbitrary chain', () => {
    expect(domainDepth(deep, 'dept')).toBe(1);
    expect(domainDepth(deep, 'agency')).toBe(2);
    expect(domainDepth(deep, 'subagency')).toBe(3);
    expect(domainDepth(deep, 'office')).toBe(4);
    expect(domainDepth(deep, 'lone')).toBe(1);
  });

  it('resolves the root ancestor for a deep node (and itself for a root)', () => {
    expect(rootAncestorId(deep, 'office')).toBe('dept');
    expect(rootAncestorId(deep, 'agency')).toBe('dept');
    expect(rootAncestorId(deep, 'dept')).toBe('dept');
    expect(rootAncestorId(deep, 'lone')).toBe('lone');
  });

  it('is cycle-safe on a corrupt chain', () => {
    const cyclic = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }];
    expect(() => domainDepth(cyclic, 'a')).not.toThrow();
    expect(() => rootAncestorId(cyclic, 'a')).not.toThrow();
  });
});

describe('isDomainTenantAdmin', () => {
  const ORIG = { ...process.env };
  afterEach(() => { process.env = { ...ORIG }; });

  it('treats every session as admin when no admin env is configured', () => {
    delete process.env.LOOM_TENANT_ADMIN_OID;
    delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
    expect(isDomainTenantAdmin('anyone')).toBe(true);
  });

  it('honors an explicit LOOM_TENANT_ADMIN_OID allow-list', () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
    expect(isDomainTenantAdmin('admin-oid')).toBe(true);
    expect(isDomainTenantAdmin('someone-else')).toBe(false);
  });

  it('is not admin when only a group is configured and the oid is not in the list', () => {
    process.env.LOOM_TENANT_ADMIN_GROUP_ID = 'grp-1';
    expect(isDomainTenantAdmin('random-oid')).toBe(false);
  });
});
