/**
 * Unit specs for the shared domain-hierarchy invariants used by BOTH domain
 * move endpoints (admin tenant-settings store + governance Cosmos store).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { validateDomainMove, isDomainTenantAdmin } from '../domain-hierarchy';

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

  it('rejects nesting under a subdomain (two-level cap)', () => {
    const err = validateDomainMove(tree, 'other', 'child');
    expect(err).toMatchObject({ status: 400 });
    expect(err!.message).toMatch(/two levels|subdomain/i);
  });

  it('rejects moving a domain that itself has subdomains', () => {
    // root has subdomain `child`; moving root under `other` would push child to L3.
    const err = validateDomainMove(tree, 'root', 'other');
    expect(err).toMatchObject({ status: 400 });
    expect(err!.message).toMatch(/subdomains out first/i);
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
