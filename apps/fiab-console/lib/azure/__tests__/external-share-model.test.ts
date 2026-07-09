import { describe, it, expect } from 'vitest';
import {
  validateExternalShare,
  nextShareState,
  deriveAclGrantPlan,
  isExpired,
} from '../external-share-model';

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

describe('validateExternalShare', () => {
  const base = { sourceItemId: 'i1', container: 'bronze', sharedPath: 'Tables/orders', expiry: FUTURE };

  it('accepts a full foreign UPN', () => {
    const v = validateExternalShare({ ...base, targetUpnOrDomain: 'jo@contoso.com' });
    expect(v.ok).toBe(true);
    expect(v.targetDomain).toBe('contoso.com');
    expect(v.targetIsUpn).toBe(true);
  });

  it('accepts a bare tenant domain', () => {
    const v = validateExternalShare({ ...base, targetUpnOrDomain: 'Contoso.COM' });
    expect(v.ok).toBe(true);
    expect(v.targetDomain).toBe('contoso.com');
    expect(v.targetIsUpn).toBe(false);
  });

  it('rejects an empty / malformed target', () => {
    expect(validateExternalShare({ ...base, targetUpnOrDomain: '' }).ok).toBe(false);
    expect(validateExternalShare({ ...base, targetUpnOrDomain: 'not-an-email@' }).ok).toBe(false);
    expect(validateExternalShare({ ...base, targetUpnOrDomain: 'nodot' }).ok).toBe(false);
  });

  it('requires a shared path and container', () => {
    expect(validateExternalShare({ ...base, sharedPath: '', targetUpnOrDomain: 'jo@contoso.com' }).ok).toBe(false);
    expect(validateExternalShare({ ...base, container: '', targetUpnOrDomain: 'jo@contoso.com' }).ok).toBe(false);
  });

  it('rejects path traversal in the shared subset', () => {
    const v = validateExternalShare({ ...base, sharedPath: 'Tables/../secrets', targetUpnOrDomain: 'jo@contoso.com' });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/\.\./);
  });

  it('requires an expiry in the future', () => {
    expect(validateExternalShare({ ...base, expiry: '', targetUpnOrDomain: 'jo@contoso.com' }).ok).toBe(false);
    expect(validateExternalShare({ ...base, expiry: PAST, targetUpnOrDomain: 'jo@contoso.com', now: FUTURE }).ok).toBe(false);
    expect(validateExternalShare({ ...base, expiry: FUTURE, targetUpnOrDomain: 'jo@contoso.com', now: PAST }).ok).toBe(true);
  });
});

describe('nextShareState (lifecycle machine)', () => {
  it('pending → accepted only', () => {
    expect(nextShareState('pending', 'accept')).toBe('accepted');
    expect(nextShareState('accepted', 'accept')).toBeNull();
    expect(nextShareState('revoked', 'accept')).toBeNull();
    expect(nextShareState('expired', 'accept')).toBeNull();
  });

  it('pending/accepted → revoked; terminal cannot revoke', () => {
    expect(nextShareState('pending', 'revoke')).toBe('revoked');
    expect(nextShareState('accepted', 'revoke')).toBe('revoked');
    expect(nextShareState('revoked', 'revoke')).toBeNull();
    expect(nextShareState('expired', 'revoke')).toBeNull();
  });

  it('pending/accepted → expired; terminal cannot expire', () => {
    expect(nextShareState('pending', 'expire')).toBe('expired');
    expect(nextShareState('accepted', 'expire')).toBe('expired');
    expect(nextShareState('revoked', 'expire')).toBeNull();
    expect(nextShareState('expired', 'expire')).toBeNull();
  });
});

describe('isExpired', () => {
  it('true when expiry has passed and not revoked', () => {
    expect(isExpired({ expiry: PAST, state: 'accepted' }, Date.parse(FUTURE))).toBe(true);
  });
  it('false for a future expiry', () => {
    expect(isExpired({ expiry: FUTURE, state: 'accepted' }, Date.parse(PAST))).toBe(false);
  });
  it('false for a revoked share (already terminal)', () => {
    expect(isExpired({ expiry: PAST, state: 'revoked' }, Date.parse(FUTURE))).toBe(false);
  });
  it('false when no expiry set', () => {
    expect(isExpired({ state: 'accepted' })).toBe(false);
  });
});

describe('deriveAclGrantPlan (scoped grant — just the shared path)', () => {
  it('grants leaf r-x and every ancestor --x (traverse-only)', () => {
    const plan = deriveAclGrantPlan('lakehouses/sales/Tables/orders');
    // ancestors: '', lakehouses, lakehouses/sales, lakehouses/sales/Tables ; leaf: full path
    const paths = plan.map((p) => p.path);
    expect(paths).toEqual([
      '', 'lakehouses', 'lakehouses/sales', 'lakehouses/sales/Tables', 'lakehouses/sales/Tables/orders',
    ]);
    // every ancestor is traverse-only (no read)
    for (const step of plan.slice(0, -1)) {
      expect(step.leaf).toBe(false);
      expect(step.permissions).toEqual({ read: false, write: false, execute: true });
    }
    // leaf is read + traverse, never write
    const leaf = plan[plan.length - 1];
    expect(leaf.leaf).toBe(true);
    expect(leaf.permissions).toEqual({ read: true, write: false, execute: true });
  });

  it('never grants write anywhere (read-only share)', () => {
    const plan = deriveAclGrantPlan('a/b/c');
    expect(plan.every((p) => p.permissions.write === false)).toBe(true);
  });

  it('handles a single-segment path (leaf only under root traverse)', () => {
    const plan = deriveAclGrantPlan('orders');
    expect(plan.map((p) => p.path)).toEqual(['', 'orders']);
    expect(plan[0].permissions).toEqual({ read: false, write: false, execute: true });
    expect(plan[1].permissions).toEqual({ read: true, write: false, execute: true });
  });

  it('normalizes leading/trailing slashes', () => {
    const plan = deriveAclGrantPlan('/a/b/');
    expect(plan.map((p) => p.path)).toEqual(['', 'a', 'a/b']);
  });
});
