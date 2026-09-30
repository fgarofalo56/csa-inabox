/**
 * The notebook editor's caption for an attached lakehouse with no path, read
 * from the answer of `GET /api/items/lakehouse/[id]/abfss`.
 *
 * The answers below are the shapes that route returns (see its header). Each
 * `it` names the value that breaks it.
 */
import { describe, it, expect } from 'vitest';
import {
  attachedLakehouseCaption,
  readAttachedLakehouseResolution,
} from '@/lib/notebook/attached-lakehouse-status';

describe('readAttachedLakehouseResolution', () => {
  // FAILS IF a resolved answer is not read as a path.
  it('reads a resolved answer as its path', () => {
    expect(readAttachedLakehouseResolution({ ok: true, resolved: true, abfss: 'abfss://a@b/c' }))
      .toEqual({ abfss: 'abfss://a@b/c' });
  });

  // FAILS IF the reason or the link is dropped from a withheld answer.
  it('keeps the reason and the link of a withheld answer', () => {
    expect(readAttachedLakehouseResolution({
      ok: true, resolved: false, reason: 'root-shared', hint: 'why', fixHref: '/admin/readiness',
    })).toEqual({ hint: 'why', reason: 'root-shared', fixHref: '/admin/readiness' });
  });

  // FAILS IF a failed or malformed answer is shown as a cause.
  it('reads nothing from a failed or malformed answer', () => {
    expect(readAttachedLakehouseResolution({ ok: false, error: 'x' })).toBeNull();
    expect(readAttachedLakehouseResolution(null)).toBeNull();
  });
});

describe('attachedLakehouseCaption', () => {
  // The visible caption states the cause the route reported. FAILS IF a
  // withheld location is captioned "path not configured" (the cause it is not),
  // or if unconfigured storage loses that caption.
  it('names the cause: shared, unconfirmed, or not configured', () => {
    expect(attachedLakehouseCaption({ hint: 'h', reason: 'root-shared' })).toBe('storage shared with another item');
    expect(attachedLakehouseCaption({ hint: 'h', reason: 'root-unverified' })).toBe('storage ownership not confirmed');
    expect(attachedLakehouseCaption({ hint: 'h' })).toBe('path not configured');
  });
});
