import { describe, it, expect } from 'vitest';
import { applyUserPatch, applyGroupPatch } from '../patch';
import type { ScimUserDoc, ScimGroupDoc } from '../types';

const baseUser = (): ScimUserDoc => ({
  id: 'u1',
  tenantId: 't',
  userName: 'alice@contoso.com',
  active: true,
  displayName: 'Alice',
  groupIds: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const baseGroup = (members: string[] = []): ScimGroupDoc => ({
  id: 'g1',
  tenantId: 't',
  displayName: 'Engineers',
  memberIds: members,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('applyUserPatch', () => {
  it('deactivates via path-less replace (Entra shape)', () => {
    const out = applyUserPatch(baseUser(), [{ op: 'replace', value: { active: false } }]);
    expect(out.active).toBe(false);
  });

  it('deactivates via path=active with a string "false"', () => {
    const out = applyUserPatch(baseUser(), [{ op: 'replace', path: 'active', value: 'False' }]);
    expect(out.active).toBe(false);
  });

  it('updates displayName via a targeted path', () => {
    const out = applyUserPatch(baseUser(), [{ op: 'replace', path: 'displayName', value: 'Alice B' }]);
    expect(out.displayName).toBe('Alice B');
  });

  it('ignores unknown ops without throwing', () => {
    const out = applyUserPatch(baseUser(), [{ op: 'bogus', path: 'x', value: 1 }]);
    expect(out.active).toBe(true);
  });
});

describe('applyGroupPatch', () => {
  it('adds members', () => {
    const out = applyGroupPatch(baseGroup(['a']), [{ op: 'add', path: 'members', value: [{ value: 'b' }, { value: 'c' }] }]);
    expect(out.memberIds).toEqual(['a', 'b', 'c']);
  });

  it('de-dupes on add', () => {
    const out = applyGroupPatch(baseGroup(['a']), [{ op: 'add', path: 'members', value: [{ value: 'a' }] }]);
    expect(out.memberIds).toEqual(['a']);
  });

  it('removes a single member via the members[value eq "id"] path', () => {
    const out = applyGroupPatch(baseGroup(['a', 'b']), [{ op: 'remove', path: 'members[value eq "a"]' }]);
    expect(out.memberIds).toEqual(['b']);
  });

  it('removes all members via a pathed remove', () => {
    const out = applyGroupPatch(baseGroup(['a', 'b']), [{ op: 'remove', path: 'members' }]);
    expect(out.memberIds).toEqual([]);
  });

  it('replaces the full member set', () => {
    const out = applyGroupPatch(baseGroup(['a', 'b']), [{ op: 'replace', path: 'members', value: [{ value: 'x' }] }]);
    expect(out.memberIds).toEqual(['x']);
  });

  it('renames via displayName', () => {
    const out = applyGroupPatch(baseGroup(), [{ op: 'replace', path: 'displayName', value: 'Data Eng' }]);
    expect(out.displayName).toBe('Data Eng');
  });
});
