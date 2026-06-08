/**
 * card-badges — pure-logic unit tests (node env, no jsdom).
 *
 * Covers the two DOM-free helpers that drive the OneLake catalog card badges:
 *   - initials(): owner-avatar monogram from a UPN / email / display name,
 *   - endorsementOf(): effective endorsement label honoring legacy certified.
 *
 * These are exercised directly (per .claude/rules/no-vaporware.md — real logic,
 * no faked backend). The card's visual row (tileFooter) composes these.
 */
import { describe, it, expect } from 'vitest';
import { initials, endorsementOf } from '../card-badges';

describe('initials', () => {
  it('splits a UPN local-part on dots → two letters', () => {
    expect(initials('jane.doe@contoso.com')).toBe('JD');
  });
  it('handles an email with underscores / dashes', () => {
    expect(initials('jane_doe@x.com')).toBe('JD');
    expect(initials('jane-doe@x.com')).toBe('JD');
  });
  it('uses first+last token of a display name', () => {
    expect(initials('Jane Q Doe')).toBe('JD');
  });
  it('falls back to first two chars of a single token', () => {
    expect(initials('jane')).toBe('JA');
  });
  it('returns ? for empty / undefined input', () => {
    expect(initials('')).toBe('?');
    expect(initials(undefined as unknown as string)).toBe('?');
  });
  it('handles a bare OID (single token, no separators)', () => {
    expect(initials('a1b2c3d4')).toBe('A1');
  });
});

describe('endorsementOf', () => {
  it('returns the explicit endorsement when present', () => {
    expect(endorsementOf({ endorsement: 'Certified' })).toBe('Certified');
    expect(endorsementOf({ endorsement: 'Promoted' })).toBe('Promoted');
  });
  it('falls back to Certified for legacy state.certified items', () => {
    expect(endorsementOf({ state: { certified: true } })).toBe('Certified');
  });
  it('prefers the explicit endorsement over the legacy flag', () => {
    expect(endorsementOf({ endorsement: 'Promoted', state: { certified: true } })).toBe('Promoted');
  });
  it('returns null when the item is not endorsed (→ no chip)', () => {
    expect(endorsementOf({})).toBeNull();
    expect(endorsementOf({ state: { certified: false } })).toBeNull();
    expect(endorsementOf({ state: {} })).toBeNull();
  });
});
