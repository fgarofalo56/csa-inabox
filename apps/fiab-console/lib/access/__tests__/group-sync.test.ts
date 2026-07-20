/**
 * Unit tests for the pure group-sync reconcile logic (access-governance W4).
 */
import { describe, it, expect } from 'vitest';
import { diffGroupMembership, type GroupMember } from '../group-sync';
import type { AccessAssignment } from '@/lib/types/access-assignment';

function assign(over: Partial<AccessAssignment> = {}): AccessAssignment {
  return {
    id: over.id ?? 'a1',
    principalId: over.principalId ?? 'p1',
    principalType: over.principalType ?? 'User',
    tenantId: 't1',
    resourceType: over.resourceType ?? 'workspace',
    resourceRef: over.resourceRef ?? 'ws-1',
    role: over.role ?? 'Viewer',
    source: over.source ?? 'group:g1',
    grantedAt: '2026-07-01T00:00:00Z',
    state: over.state ?? 'active',
    updatedAt: '2026-07-01T00:00:00Z',
  } as AccessAssignment;
}

const member = (id: string, type: GroupMember['type'] = 'User'): GroupMember => ({ id, type });

describe('diffGroupMembership', () => {
  it('grants joiners with no active row', () => {
    const d = diffGroupMembership([member('p1'), member('p2')], [assign({ principalId: 'p1' })]);
    expect(d.toGrant.map((m) => m.id)).toEqual(['p2']);
    expect(d.toRevoke).toHaveLength(0);
  });
  it('revokes active rows for principals who left', () => {
    const d = diffGroupMembership([member('p1')], [assign({ principalId: 'p1' }), assign({ id: 'a2', principalId: 'p2' })]);
    expect(d.toGrant).toHaveLength(0);
    expect(d.toRevoke.map((a) => a.principalId)).toEqual(['p2']);
  });
  it('does not revoke already-revoked rows and re-grants them', () => {
    const d = diffGroupMembership([member('p2')], [assign({ id: 'a2', principalId: 'p2', state: 'revoked' })]);
    expect(d.toGrant.map((m) => m.id)).toEqual(['p2']); // revoked row does not suppress a re-grant
    expect(d.toRevoke).toHaveLength(0);
  });
  it('ignores nested-group members (only users/SPNs get grants)', () => {
    const d = diffGroupMembership([member('p1'), member('nested', 'Group')], []);
    expect(d.toGrant.map((m) => m.id)).toEqual(['p1']);
  });
  it('no-op when membership matches the ledger', () => {
    const d = diffGroupMembership([member('p1')], [assign({ principalId: 'p1' })]);
    expect(d.toGrant).toHaveLength(0);
    expect(d.toRevoke).toHaveLength(0);
  });
});
