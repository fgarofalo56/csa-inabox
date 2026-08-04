import { describe, it, expect } from 'vitest';
import { computeMirrorState, decorationFor, type MirrorState } from '../src/fs/decorations';

describe('computeMirrorState — the 4-state machine (N7)', () => {
  it('remote-only when there is no local copy', () => {
    expect(computeMirrorState({ base: 'a', local: undefined, remote: 'a' })).toBe('remote');
    expect(computeMirrorState({})).toBe('remote');
  });

  it('local (L) when the local copy is identical to remote', () => {
    expect(computeMirrorState({ base: 'a', local: 'a', remote: 'a' })).toBe('local');
    // remote not refreshed → defaults to base
    expect(computeMirrorState({ base: 'a', local: 'a' })).toBe('local');
  });

  it('modified (M) when only the local side changed', () => {
    expect(computeMirrorState({ base: 'a', local: 'b', remote: 'a' })).toBe('modified');
    // remote unknown, local differs from base → unpublished edit
    expect(computeMirrorState({ base: 'a', local: 'b' })).toBe('modified');
  });

  it('conflict (C) when both sides diverged', () => {
    expect(computeMirrorState({ base: 'a', local: 'b', remote: 'c' })).toBe('conflict');
  });

  it('conflict (C) when remote advanced under a clean local copy (reconcile via Update)', () => {
    expect(computeMirrorState({ base: 'a', local: 'a', remote: 'c' })).toBe('conflict');
  });
});

describe('decorationFor — badge/colour per state', () => {
  const cases: Array<[MirrorState, string | undefined, string | undefined]> = [
    ['remote', undefined, undefined],
    ['local', 'L', 'gitDecoration.addedResourceForeground'],
    ['modified', 'M', 'gitDecoration.modifiedResourceForeground'],
    ['conflict', 'C', 'gitDecoration.conflictingResourceForeground'],
  ];
  it.each(cases)('%s → badge %s', (state, badge, colorId) => {
    const spec = decorationFor(state);
    if (badge === undefined) {
      expect(spec).toBeUndefined();
    } else {
      expect(spec?.badge).toBe(badge);
      expect(spec?.colorId).toBe(colorId);
      expect(spec?.tooltip).toBeTruthy();
    }
  });
});
