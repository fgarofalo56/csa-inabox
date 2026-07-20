/**
 * Unit tests for the who-has-access merge logic (access-governance W1).
 * Pure — no Cosmos/Graph. Covers normalization, de-dup + state preference,
 * per-principal / per-resource filtering, and CSV quoting.
 */
import { describe, it, expect } from 'vitest';
import {
  assignmentToEntry, workspaceRoleToEntry, mergeEntries,
  buildPrincipalReport, buildResourceReport, entriesToCsv, type AccessEntry,
} from '../access-report';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import type { WorkspaceRoleAssignment } from '@/lib/azure/workspace-roles-client';

const assignment = (o: Partial<AccessAssignment>): AccessAssignment => ({
  id: 'x', principalId: 'p1', principalType: 'User', tenantId: 't',
  resourceType: 'workspace', resourceRef: 'ws-1', role: 'Viewer',
  source: 'workspace-acl', grantedAt: '2026-07-01T00:00:00Z', state: 'active',
  updatedAt: '2026-07-01T00:00:00Z', expiresAt: null, ...o,
});

describe('mappers', () => {
  it('assignmentToEntry carries the lifecycle + source', () => {
    const e = assignmentToEntry(assignment({ state: 'revoked', permission: 'read' }));
    expect(e.principalId).toBe('p1');
    expect(e.state).toBe('revoked');
    expect(e.permission).toBe('read');
    expect(e.source).toBe('workspace-acl');
  });
  it('workspaceRoleToEntry normalizes to a workspace resource', () => {
    const w = { id: 'ws-1:p1', workspaceId: 'ws-1', principalId: 'p1', principalType: 'User', displayName: 'Ann', role: 'Admin', addedBy: 'boss@x', addedAt: '2026-07-02T00:00:00Z' } as unknown as WorkspaceRoleAssignment;
    const e = workspaceRoleToEntry(w);
    expect(e.resourceType).toBe('workspace');
    expect(e.resourceRef).toBe('ws-1');
    expect(e.source).toBe('workspace-acl');
    expect(e.role).toBe('Admin');
    expect(e.grantedBy).toBe('boss@x');
  });
});

describe('mergeEntries', () => {
  it('de-dups the same effective grant (ledger + live ACL) to one row', () => {
    const led = assignmentToEntry(assignment({ grantedAt: '2026-07-01T00:00:00Z' }));
    const live = workspaceRoleToEntry({ id: 'ws-1:p1', workspaceId: 'ws-1', principalId: 'p1', principalType: 'User', displayName: 'Ann', role: 'Viewer', addedBy: 'x', addedAt: '2026-07-03T00:00:00Z' } as any);
    const merged = mergeEntries([led, live]);
    expect(merged).toHaveLength(1);
    // most-recent grantedAt wins when both active
    expect(merged[0].grantedAt).toBe('2026-07-03T00:00:00Z');
  });
  it('prefers an active row over a revoked one for the same tuple', () => {
    const revoked = assignmentToEntry(assignment({ state: 'revoked', grantedAt: '2026-07-05T00:00:00Z' }));
    const active = assignmentToEntry(assignment({ state: 'active', grantedAt: '2026-07-01T00:00:00Z' }));
    const merged = mergeEntries([revoked, active]);
    expect(merged).toHaveLength(1);
    expect(merged[0].state).toBe('active');
  });
  it('keeps distinct roles/sources as separate rows and sorts newest-first', () => {
    const a = assignmentToEntry(assignment({ role: 'Viewer', grantedAt: '2026-07-01T00:00:00Z' }));
    const b = assignmentToEntry(assignment({ role: 'Admin', grantedAt: '2026-07-09T00:00:00Z' }));
    const merged = mergeEntries([a, b]);
    expect(merged.map((e) => e.role)).toEqual(['Admin', 'Viewer']);
  });
});

describe('report builders', () => {
  const entries: AccessEntry[] = [
    assignmentToEntry(assignment({ principalId: 'p1', resourceRef: 'ws-1' })),
    assignmentToEntry(assignment({ principalId: 'p2', resourceRef: 'ws-1', role: 'Admin' })),
    assignmentToEntry(assignment({ principalId: 'p1', resourceType: 'kql-database', resourceRef: 'db-9', role: 'viewer', source: 'direct' })),
  ];
  it('buildPrincipalReport returns only that principal', () => {
    const r = buildPrincipalReport(entries, 'p1');
    expect(r).toHaveLength(2);
    expect(r.every((e) => e.principalId === 'p1')).toBe(true);
  });
  it('buildResourceReport returns every principal on the resource', () => {
    const r = buildResourceReport(entries, 'ws-1');
    expect(r.map((e) => e.principalId).sort()).toEqual(['p1', 'p2']);
  });
  it('buildResourceReport respects resourceType when given', () => {
    const r = buildResourceReport(entries, 'db-9', 'kql-database');
    expect(r).toHaveLength(1);
    expect(r[0].principalId).toBe('p1');
  });
});

describe('entriesToCsv', () => {
  it('emits a header + quotes values with commas', () => {
    const csv = entriesToCsv([assignmentToEntry(assignment({ resourceName: 'Sales, EU', role: 'Viewer' }))]);
    const [header, row] = csv.split('\r\n');
    expect(header.startsWith('principalUpn,principalId')).toBe(true);
    expect(row).toContain('"Sales, EU"');
  });
});
