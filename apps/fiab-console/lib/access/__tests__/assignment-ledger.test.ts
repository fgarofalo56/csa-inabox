/**
 * Unit tests for the entitlement-ledger write helpers (access-governance W1).
 * Covers deterministic id, doc mapping, best-effort upsert, and revoke. The
 * Cosmos container is stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/azure/cosmos-client', () => ({ accessAssignmentsContainer: vi.fn() }));

import { assignmentId, toAssignmentDoc, recordAssignment, revokeAssignmentLedger } from '../assignment-ledger';
import { accessAssignmentsContainer } from '@/lib/azure/cosmos-client';

beforeEach(() => { vi.resetAllMocks(); });

describe('assignmentId', () => {
  it('is deterministic for the same tuple and differs across tuples', () => {
    const a = assignmentId('p1', 'workspace', 'ws-1', 'workspace-acl');
    const b = assignmentId('p1', 'workspace', 'ws-1', 'workspace-acl');
    const c = assignmentId('p1', 'workspace', 'ws-2', 'workspace-acl');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('toAssignmentDoc', () => {
  it('defaults principalType/state and stamps timestamps', () => {
    const doc = toAssignmentDoc({
      principalId: 'p1', tenantId: 't', resourceType: 'workspace', resourceRef: 'ws-1',
      role: 'Viewer', source: 'workspace-acl',
    }, '2026-07-20T00:00:00Z');
    expect(doc.id).toBe(assignmentId('p1', 'workspace', 'ws-1', 'workspace-acl'));
    expect(doc.principalType).toBe('User');
    expect(doc.state).toBe('active');
    expect(doc.expiresAt).toBeNull();
    expect(doc.grantedAt).toBe('2026-07-20T00:00:00Z');
  });
});

describe('recordAssignment', () => {
  it('upserts the doc and returns true', async () => {
    const upsert = vi.fn(async () => ({}));
    (accessAssignmentsContainer as any).mockResolvedValue({ items: { upsert } });
    const ok = await recordAssignment({ principalId: 'p1', tenantId: 't', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'workspace-acl' });
    expect(ok).toBe(true);
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0].principalId).toBe('p1');
  });
  it('is best-effort — returns false (never throws) on a Cosmos error', async () => {
    (accessAssignmentsContainer as any).mockResolvedValue({ items: { upsert: async () => { throw new Error('cosmos down'); } } });
    const ok = await recordAssignment({ principalId: 'p1', tenantId: 't', resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer', source: 'workspace-acl' });
    expect(ok).toBe(false);
  });
  it('skips when required fields are missing', async () => {
    const ok = await recordAssignment({ principalId: '', tenantId: 't', resourceType: 'workspace', resourceRef: '', role: 'Viewer', source: 'workspace-acl' });
    expect(ok).toBe(false);
  });
});

describe('revokeAssignmentLedger', () => {
  it('marks the matched row revoked', async () => {
    const doc = { id: 'x', principalId: 'p1', state: 'active' };
    const replace = vi.fn(async () => ({}));
    const item = vi.fn(() => ({ read: async () => ({ resource: doc }), replace }));
    (accessAssignmentsContainer as any).mockResolvedValue({ item });
    const ok = await revokeAssignmentLedger('p1', 'workspace', 'ws-1', 'workspace-acl', 'admin@x');
    expect(ok).toBe(true);
    expect(replace).toHaveBeenCalledOnce();
    expect(replace.mock.calls[0][0].state).toBe('revoked');
    expect(replace.mock.calls[0][0].revokedBy).toBe('admin@x');
  });
  it('returns false when the row does not exist', async () => {
    const item = vi.fn(() => ({ read: async () => ({ resource: undefined }), replace: vi.fn() }));
    (accessAssignmentsContainer as any).mockResolvedValue({ item });
    const ok = await revokeAssignmentLedger('p1', 'workspace', 'ws-1', 'workspace-acl');
    expect(ok).toBe(false);
  });
});
