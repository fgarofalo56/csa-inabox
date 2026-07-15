/**
 * Unit tests for the PURE canvas-comment model (W4):
 *  - normalizeCommentInput (text cap/trim, coord clamp, kind/colour whitelist)
 *  - applyCommentPatch (partial patch, blank-text rejection)
 *  - commentsToPrune (oldest-evicted cap)
 *  - toCommentView (mine flag)
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeCommentInput,
  applyCommentPatch,
  commentsToPrune,
  toCommentView,
  newCommentId,
  MAX_CANVAS_COMMENT_LEN,
  DEFAULT_CANVAS_COMMENT_COLOR,
  type CanvasCommentDoc,
} from '@/lib/collab/canvas-comment-model';

function doc(over: Partial<CanvasCommentDoc> = {}): CanvasCommentDoc {
  return {
    id: 'cc:i1:default:u1',
    docType: 'canvas-comment',
    itemId: 'i1',
    itemType: 'eventstream',
    canvasKey: 'default',
    kind: 'sticky',
    text: 'hi',
    x: 10,
    y: 20,
    color: 'amber',
    authorOid: 'oid-a',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

describe('normalizeCommentInput', () => {
  it('rejects empty / whitespace-only text', () => {
    expect(normalizeCommentInput({ text: '   ' })).toBeNull();
    expect(normalizeCommentInput({})).toBeNull();
  });

  it('trims + caps text, clamps coords, whitelists kind + colour', () => {
    const long = 'x'.repeat(MAX_CANVAS_COMMENT_LEN + 50);
    const f = normalizeCommentInput({ text: `  ${long}  `, x: 1e9, y: 'nope', kind: 'bogus', color: 'chartreuse' })!;
    expect(f.text.length).toBe(MAX_CANVAS_COMMENT_LEN);
    expect(f.x).toBe(1_000_000); // clamped
    expect(f.y).toBe(0); // non-finite → 0
    expect(f.kind).toBe('comment'); // unknown kind → default
    expect(f.color).toBe(DEFAULT_CANVAS_COMMENT_COLOR); // unknown colour → default
  });

  it('accepts a valid sticky', () => {
    const f = normalizeCommentInput({ text: 'note', kind: 'sticky', color: 'violet', x: 3.14159, y: -7.005 })!;
    expect(f).toMatchObject({ kind: 'sticky', color: 'violet', text: 'note' });
    expect(f.x).toBeCloseTo(3.14);
    expect(f.y).toBeCloseTo(-7); // Math.round(-700.5) = -700 → -7.00
  });
});

describe('applyCommentPatch', () => {
  it('applies only present fields', () => {
    const p = applyCommentPatch(doc(), { color: 'teal', resolved: true });
    expect(p).toEqual({ color: 'teal', resolved: true });
  });

  it('rejects a blanked text but allows other-only patches', () => {
    expect(applyCommentPatch(doc(), { text: '   ' })).toBeNull();
    expect(applyCommentPatch(doc(), { x: 5 })).toEqual({ x: 5 });
  });
});

describe('commentsToPrune', () => {
  it('evicts the oldest beyond the cap', () => {
    const all = [
      { id: 'a', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'c', createdAt: '2026-01-03T00:00:00Z' },
    ];
    expect(commentsToPrune(all, 2)).toEqual(['a']);
    expect(commentsToPrune(all, 3)).toEqual([]);
    expect(commentsToPrune(all, 5)).toEqual([]);
  });

  it('is deterministic on ties (id tiebreak)', () => {
    const all = [
      { id: 'b', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'a', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'c', createdAt: '2026-01-02T00:00:00Z' },
    ];
    expect(commentsToPrune(all, 2)).toEqual(['a']);
  });
});

describe('toCommentView', () => {
  it('sets mine=true only for the author', () => {
    expect(toCommentView(doc(), 'oid-a').mine).toBe(true);
    expect(toCommentView(doc(), 'oid-b').mine).toBe(false);
  });
});

describe('newCommentId', () => {
  it('encodes item + canvas + uuid', () => {
    expect(newCommentId('i1', 'default', 'uuid1')).toBe('cc:i1:default:uuid1');
  });
});
