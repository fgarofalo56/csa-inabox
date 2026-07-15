import { describe, it, expect } from 'vitest';
import {
  resolveLifecycleState,
  setLifecycleState,
  toLifecycleStatus,
  toStatus,
  toPublishStatus,
  isLifecycleState,
  LIFECYCLE_STATES,
} from '../lifecycle';

describe('lifecycle — canonical vocabulary', () => {
  it('recognises every canonical state', () => {
    for (const s of LIFECYCLE_STATES) expect(isLifecycleState(s)).toBe(true);
    expect(isLifecycleState('Published')).toBe(false); // wrong casing is legacy, not canonical
    expect(isLifecycleState('nope')).toBe(false);
  });

  it('maps canonical → the three legacy vocabularies', () => {
    expect(toLifecycleStatus('published')).toBe('PUBLISHED');
    expect(toStatus('published')).toBe('Published');
    expect(toPublishStatus('published')).toBe('Published');

    // validated/certified are pre-publish → all three read Draft/DRAFT.
    expect(toLifecycleStatus('validated')).toBe('DRAFT');
    expect(toStatus('certified')).toBe('Draft');
    expect(toPublishStatus('draft')).toBe('Draft');

    // deprecated/retired → EXPIRED / Expired / Deprecated.
    expect(toLifecycleStatus('deprecated')).toBe('EXPIRED');
    expect(toStatus('retired')).toBe('Expired');
    expect(toPublishStatus('deprecated')).toBe('Deprecated');
  });
});

describe('resolveLifecycleState — read-time migration shim', () => {
  it('prefers a valid canonical lifecycleState', () => {
    expect(resolveLifecycleState({ lifecycleState: 'certified', status: 'Draft' })).toBe('certified');
  });

  it('defaults to draft when nothing is present', () => {
    expect(resolveLifecycleState({})).toBe('draft');
    expect(resolveLifecycleState(undefined)).toBe('draft');
  });

  it('honors a ribbon Publish even when the details status field is stale (the core defect)', () => {
    // The bug: ribbon Publish set lifecycleStatus=PUBLISHED but left status=Draft
    // → the details badge stayed "Draft" forever. Resolve must surface published.
    expect(resolveLifecycleState({ lifecycleStatus: 'PUBLISHED', status: 'Draft' })).toBe('published');
  });

  it('honors a marketplace-only Published (publishStatus) with no ribbon field', () => {
    expect(resolveLifecycleState({ publishStatus: 'Published' })).toBe('published');
  });

  it('lets a deliberate Expire/Deprecate win over a stale Published', () => {
    expect(resolveLifecycleState({ lifecycleStatus: 'EXPIRED', status: 'Published' })).toBe('deprecated');
  });

  it('folds legacy casings', () => {
    expect(resolveLifecycleState({ status: 'Draft' })).toBe('draft');
    expect(resolveLifecycleState({ publishStatus: 'Deprecated' })).toBe('deprecated');
  });
});

describe('setLifecycleState — the one mutator', () => {
  it('writes the canonical field AND mirrors the legacy trio so publish-here is publish-there', () => {
    const next = setLifecycleState({ owner: 'a@b.com' }, 'published', '2026-07-14T00:00:00.000Z');
    expect(next.lifecycleState).toBe('published');
    expect(next.lifecycleStatus).toBe('PUBLISHED'); // F6 ribbon reads this
    expect(next.status).toBe('Published');          // details badge reads this
    expect(next.publishStatus).toBe('Published');   // AI-Search visibility reads this
    expect(next.lifecycleStateAt).toBe('2026-07-14T00:00:00.000Z');
    expect(next.owner).toBe('a@b.com'); // untouched fields preserved
  });

  it('is a pure, non-mutating copy', () => {
    const orig = { status: 'Draft' as const };
    const next = setLifecycleState(orig, 'deprecated');
    expect(orig.status).toBe('Draft'); // original untouched
    expect(next.status).toBe('Expired');
    expect(next.publishStatus).toBe('Deprecated');
  });

  it('round-trips through resolveLifecycleState', () => {
    for (const s of LIFECYCLE_STATES) {
      expect(resolveLifecycleState(setLifecycleState({}, s))).toBe(s);
    }
  });
});
