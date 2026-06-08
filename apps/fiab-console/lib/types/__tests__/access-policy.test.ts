import { describe, it, expect } from 'vitest';
import {
  defaultAccessPolicy,
  normalizeAccessPolicy,
  policyTiers,
  DEFAULT_PURPOSES,
  type DataProductAccessPolicy,
} from '../access-policy';

describe('defaultAccessPolicy', () => {
  it('returns an empty, non-gating policy', () => {
    const p = defaultAccessPolicy();
    expect(p.allowedPurposes).toEqual([]);
    expect(p.requireManagerApproval).toBe(false);
    expect(p.requirePrivacyReview).toBe(false);
    expect(p.approvers).toEqual([]);
    expect(p.accessProvider).toBeNull();
  });
});

describe('normalizeAccessPolicy', () => {
  it('coerces junk into a well-formed policy', () => {
    const p = normalizeAccessPolicy(null);
    expect(p).toEqual(defaultAccessPolicy());
  });

  it('keeps valid purposes and drops nameless ones', () => {
    const p = normalizeAccessPolicy({
      allowedPurposes: [
        { name: 'Analytics', description: 'reporting' },
        { name: '   ', description: 'blank name dropped' },
        { description: 'no name dropped' },
      ],
    });
    expect(p.allowedPurposes).toEqual([{ name: 'Analytics', description: 'reporting' }]);
  });

  it('sanitizes approver principals and resolves a UPN fallback', () => {
    const p = normalizeAccessPolicy({
      approvers: [
        { id: 'oid-1', upn: 'alice@contoso.com', displayName: 'Alice', type: 'User' },
        { id: 'grp-1', displayName: 'Data Stewards', type: 'Group' }, // no upn → falls back to displayName
        { displayName: 'no id dropped' },
      ],
    });
    expect(p.approvers).toHaveLength(2);
    expect(p.approvers[0]).toMatchObject({ id: 'oid-1', upn: 'alice@contoso.com', type: 'User' });
    expect(p.approvers[1]).toMatchObject({ id: 'grp-1', upn: 'Data Stewards', type: 'Group' });
  });

  it('defaults principal type to User for unknown values', () => {
    const p = normalizeAccessPolicy({ accessProvider: { id: 'x', upn: 'x@c.com', type: 'weird' } });
    expect(p.accessProvider?.type).toBe('User');
  });
});

describe('policyTiers', () => {
  it('returns no tiers for an empty policy (auto-approve)', () => {
    expect(policyTiers(defaultAccessPolicy())).toEqual([]);
  });

  it('orders manager → privacy → approver → provider, skipping empty tiers', () => {
    const policy: DataProductAccessPolicy = {
      allowedPurposes: [...DEFAULT_PURPOSES],
      requireManagerApproval: true,
      requirePrivacyReview: false,
      approvers: [
        { id: 'a', upn: 'alice@contoso.com', displayName: 'Alice', type: 'User' },
        { id: 'b', upn: 'bob@contoso.com', displayName: 'Bob', type: 'User' },
      ],
      accessProvider: { id: 'p', upn: 'prov@contoso.com', displayName: 'Prov', type: 'User' },
    };
    const tiers = policyTiers(policy);
    expect(tiers.map((t) => t.key)).toEqual(['manager', 'approver', 'provider']);
    expect(tiers.find((t) => t.key === 'approver')?.detail).toBe('alice@contoso.com, bob@contoso.com');
    expect(tiers.find((t) => t.key === 'provider')?.detail).toBe('prov@contoso.com');
  });

  it('includes the privacy tier when enabled', () => {
    const policy = { ...defaultAccessPolicy(), requirePrivacyReview: true };
    expect(policyTiers(policy).map((t) => t.key)).toEqual(['privacy']);
  });
});
