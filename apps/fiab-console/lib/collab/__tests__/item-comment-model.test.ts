/**
 * Unit tests for the PURE BR-COMMENTS edit/resolve model:
 *  - normalizeItemCommentPatch (blank-body reject, nothing-to-do reject, coerce)
 *  - authorizeItemCommentPatch (author-only body edit; open resolve)
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeItemCommentBody,
  normalizeItemCommentPatch,
  authorizeItemCommentPatch,
  MAX_ITEM_COMMENT_LEN,
} from '@/lib/collab/item-comment-model';

describe('normalizeItemCommentBody', () => {
  it('trims and caps', () => {
    expect(normalizeItemCommentBody('  hi  ')).toBe('hi');
    expect(normalizeItemCommentBody('x'.repeat(MAX_ITEM_COMMENT_LEN + 10)).length).toBe(MAX_ITEM_COMMENT_LEN);
    expect(normalizeItemCommentBody(42)).toBe('');
  });
});

describe('normalizeItemCommentPatch', () => {
  it('rejects empty patch and blank body edits', () => {
    expect(normalizeItemCommentPatch({})).toBeNull();
    expect(normalizeItemCommentPatch({ body: '   ' })).toBeNull();
  });
  it('coerces resolved and keeps a valid body', () => {
    expect(normalizeItemCommentPatch({ resolved: 'yes' as unknown })).toEqual({ resolved: false });
    expect(normalizeItemCommentPatch({ resolved: true })).toEqual({ resolved: true });
    expect(normalizeItemCommentPatch({ body: 'edited', resolved: true })).toEqual({ body: 'edited', resolved: true });
  });
});

describe('authorizeItemCommentPatch', () => {
  it('lets the author edit the body; blocks others', () => {
    expect(authorizeItemCommentPatch({ body: 'e' }, 'a', 'a')).toEqual({ body: 'e' });
    expect(authorizeItemCommentPatch({ body: 'e' }, 'a', 'b')).toBeNull();
  });
  it('lets anyone resolve, and drops a forbidden body edit while keeping resolve', () => {
    expect(authorizeItemCommentPatch({ resolved: true }, 'a', 'b')).toEqual({ resolved: true });
    // non-author asks to edit body AND resolve → body edit is forbidden entirely
    expect(authorizeItemCommentPatch({ body: 'e', resolved: true }, 'a', 'b')).toBeNull();
    // author edits body AND resolves → both allowed
    expect(authorizeItemCommentPatch({ body: 'e', resolved: true }, 'a', 'a')).toEqual({ body: 'e', resolved: true });
  });
});
