/**
 * Unit tests for the pure access-review campaign logic (access-governance W4).
 */
import { describe, it, expect } from 'vitest';
import {
  reviewItemId, matchesScope, buildReviewItems, computeStats, applyDecision,
  selectAutoRevoke, isOverdue, nextDueDate, canReview,
} from '../access-reviews';
import type { AccessEntry } from '../access-report';

function entry(over: Partial<AccessEntry> = {}): AccessEntry {
  return {
    id: over.id ?? 'led-1',
    principalId: over.principalId ?? 'p1',
    principalUpn: over.principalUpn ?? 'p1@x',
    principalType: over.principalType ?? 'User',
    resourceType: over.resourceType ?? 'workspace',
    resourceRef: over.resourceRef ?? 'ws-1',
    resourceName: over.resourceName,
    role: over.role ?? 'Viewer',
    permission: over.permission,
    source: over.source ?? 'direct',
    state: over.state ?? 'active',
    viaGroupId: over.viaGroupId,
  } as AccessEntry;
}

describe('reviewItemId', () => {
  it('is deterministic for the same campaign + tuple', () => {
    const e = entry();
    expect(reviewItemId('c1', e)).toBe(reviewItemId('c1', e));
    expect(reviewItemId('c1', e)).not.toBe(reviewItemId('c2', e));
  });
});

describe('matchesScope', () => {
  it("'all' matches everything", () => {
    expect(matchesScope(entry(), { kind: 'all' })).toBe(true);
  });
  it("'package' matches package-sourced rows", () => {
    expect(matchesScope(entry({ source: 'package:pk1' }), { kind: 'package', ref: 'pk1' })).toBe(true);
    expect(matchesScope(entry({ source: 'direct' }), { kind: 'package', ref: 'pk1' })).toBe(false);
  });
  it("'group' matches group source, viaGroup, or a group principal", () => {
    expect(matchesScope(entry({ source: 'group:g1' }), { kind: 'group', ref: 'g1' })).toBe(true);
    expect(matchesScope(entry({ viaGroupId: 'g1' }), { kind: 'group', ref: 'g1' })).toBe(true);
    expect(matchesScope(entry({ principalType: 'Group', principalId: 'g1' }), { kind: 'group', ref: 'g1' })).toBe(true);
  });
  it("'resource' narrows by ref + optional type", () => {
    expect(matchesScope(entry({ resourceRef: 'ws-1' }), { kind: 'resource', ref: 'ws-1' })).toBe(true);
    expect(matchesScope(entry({ resourceRef: 'ws-1', resourceType: 'item' }), { kind: 'resource', ref: 'ws-1', resourceType: 'workspace' })).toBe(false);
  });
});

describe('buildReviewItems', () => {
  it('snapshots active/eligible in-scope grants, skips revoked, de-dups', () => {
    const entries = [
      entry({ id: 'a', principalId: 'p1' }),
      entry({ id: 'b', principalId: 'p2', state: 'eligible' }),
      entry({ id: 'c', principalId: 'p3', state: 'revoked' }),
      entry({ id: 'a2', principalId: 'p1' }), // same tuple as first → de-dup
    ];
    const items = buildReviewItems('c1', entries, { kind: 'all' });
    expect(items.length).toBe(2);
    expect(items.every((i) => i.decision === 'pending')).toBe(true);
    expect(items[0].assignmentId).toBe('a');
  });
});

describe('applyDecision', () => {
  const base = buildReviewItems('c1', [entry({ id: 'a', principalId: 'p1' }), entry({ id: 'b', principalId: 'p2' })], { kind: 'all' });
  it('marks attest and reports no revokes', () => {
    const { items, newlyRevoked } = applyDecision(base, [base[0].id], 'attest', { oid: 'admin', upn: 'admin@x' });
    expect(items[0].decision).toBe('attest');
    expect(items[0].decidedBy).toBe('admin@x');
    expect(newlyRevoked).toHaveLength(0);
  });
  it('reports newly-revoked items and is idempotent', () => {
    const first = applyDecision(base, [base[0].id, base[1].id], 'revoke', { oid: 'admin' });
    expect(first.newlyRevoked).toHaveLength(2);
    const second = applyDecision(first.items, [base[0].id], 'revoke', { oid: 'admin' });
    expect(second.newlyRevoked).toHaveLength(0); // already revoked → no re-revoke
  });
  it('does not mutate the input array', () => {
    applyDecision(base, [base[0].id], 'revoke', { oid: 'admin' });
    expect(base[0].decision).toBe('pending');
  });
});

describe('computeStats', () => {
  it('rolls up decisions', () => {
    const items = buildReviewItems('c1', [entry({ id: 'a', principalId: 'p1' }), entry({ id: 'b', principalId: 'p2' }), entry({ id: 'c', principalId: 'p3' })], { kind: 'all' });
    const after = applyDecision(applyDecision(items, [items[0].id], 'attest', { oid: 'a' }).items, [items[1].id], 'revoke', { oid: 'a' }).items;
    expect(computeStats(after)).toEqual({ total: 3, attested: 1, revoked: 1, pending: 1 });
  });
});

describe('selectAutoRevoke', () => {
  const items = buildReviewItems('c1', [entry({ id: 'a', principalId: 'p1' }), entry({ id: 'b', principalId: 'p2' })], { kind: 'all' });
  it('returns pending items only when auto-revoke is on', () => {
    const decided = applyDecision(items, [items[0].id], 'attest', { oid: 'a' }).items;
    expect(selectAutoRevoke({ autoRevokeOnExpiry: true, items: decided })).toHaveLength(1);
    expect(selectAutoRevoke({ autoRevokeOnExpiry: false, items: decided })).toHaveLength(0);
  });
});

describe('isOverdue / nextDueDate', () => {
  const now = new Date('2026-07-20T00:00:00Z');
  it('is overdue only when active and past due', () => {
    expect(isOverdue({ status: 'active', dueAt: '2026-07-19T00:00:00Z' }, now)).toBe(true);
    expect(isOverdue({ status: 'active', dueAt: '2026-07-21T00:00:00Z' }, now)).toBe(false);
    expect(isOverdue({ status: 'closed', dueAt: '2026-07-19T00:00:00Z' }, now)).toBe(false);
    expect(isOverdue({ status: 'active', dueAt: null }, now)).toBe(false);
  });
  it('computes the next recurrence date', () => {
    expect(nextDueDate({ cadenceDays: 30 }, now)).toBe(new Date('2026-08-19T00:00:00Z').toISOString());
    expect(nextDueDate({ cadenceDays: null }, now)).toBeNull();
  });
});

describe('canReview', () => {
  const review = { reviewers: [{ type: 'user' as const, id: 'u1' }, { type: 'group' as const, id: 'g1' }], delegatedTo: [{ type: 'user' as const, id: 'd1' }] };
  it('admin always may', () => {
    expect(canReview(review, 'nobody', [], true)).toBe(true);
  });
  it('named user, group member, and delegate may', () => {
    expect(canReview(review, 'u1', [], false)).toBe(true);
    expect(canReview(review, 'x', ['g1'], false)).toBe(true);
    expect(canReview(review, 'd1', [], false)).toBe(true);
  });
  it('a stranger may not', () => {
    expect(canReview(review, 'x', ['g9'], false)).toBe(false);
  });
  it('no reviewers → admin-only', () => {
    expect(canReview({ reviewers: [] }, 'x', [], false)).toBe(false);
  });
});
