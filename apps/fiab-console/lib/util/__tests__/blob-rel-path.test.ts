/**
 * blobRelPathError — each refusal rule is pinned by an input that ONLY that
 * rule rejects, plus accepted look-alikes that pin the rule is not broader than
 * stated (#4619).
 */
import { describe, it, expect } from 'vitest';
import { blobRelPathError, MAX_BLOB_REL_PATH } from '../blob-rel-path';

describe('blobRelPathError — refusals', () => {
  it('refuses a non-string or empty path', () => {
    // Breaks if the typeof / length-0 guard is removed ('' would reach the
    // segment loop and return null).
    expect(blobRelPathError('')).toBe('path is required');
    expect(blobRelPathError(undefined)).toBe('path is required');
    expect(blobRelPathError(42)).toBe('path is required');
  });

  it('refuses one character over the ceiling, accepts exactly the ceiling', () => {
    // Breaks if the length check is removed (1025 x "a" has no other defect)
    // or turned into >= (1024 would be refused).
    expect(MAX_BLOB_REL_PATH).toBe(1024);
    expect(blobRelPathError('a'.repeat(1025))).toMatch(/at most 1024/);
    expect(blobRelPathError('a'.repeat(1024))).toBeNull();
  });

  it.each([
    ['NUL', 'a\u0000b'],
    ['U+0001', 'a\u0001b'],
    ['U+001F (top of C0)', 'a\u001fb'],
    ['DEL', 'a\u007fb'],
    ['a newline', 'a\nb'],
  ])('refuses %s', (_label, p) => {
    // Breaks if the control-character scan is removed or its bounds narrowed.
    expect(blobRelPathError(p)).toMatch(/control characters/);
  });

  it('accepts the characters either side of the control ranges', () => {
    // U+0020 (space) and U+007E (~) sit just outside C0 and DEL; breaks if the
    // bounds are widened by one.
    expect(blobRelPathError('a b~c')).toBeNull();
  });

  it.each([
    ['a leading "/"', '/Files/a.csv'],
    ['a leading "\\"', '\\Files\\a.csv'],
  ])('refuses %s', (_label, p) => {
    // Breaks if the leading-separator check is removed: neither input has a
    // ".." segment or control char, so it would return null.
    expect(blobRelPathError(p)).toMatch(/no leading/);
  });

  it.each([
    ['a "/" ".." segment', 'Files/../x'],
    ['a "\\" ".." segment', 'Files\\..\\x'],
    ['a mixed-separator ".." segment', 'Files/..\\x'],
    ['a bare ".."', '..'],
    ['a trailing ".."', 'Files/..'],
  ])('refuses %s', (_label, p) => {
    // Breaks if the segment loop is removed, or if it splits on "/" only
    // (the backslash forms would then have no ".." segment).
    expect(blobRelPathError(p)).toMatch(/"\.\." segments/);
  });
});

describe('blobRelPathError — accepted', () => {
  it.each([
    'Files/a.csv',
    'Files/a..b.csv',
    'Files/..hidden',
    'Files/./a.csv',
    'a',
    'Files/sub/',
  ])('accepts %s', (p) => {
    // Breaks if ".." is matched as a substring rather than a whole segment, or
    // if a trailing separator / single dot segment were refused.
    expect(blobRelPathError(p)).toBeNull();
  });
});
