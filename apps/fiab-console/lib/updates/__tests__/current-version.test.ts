/**
 * Version-comparison edge cases for the SHARED resolver (used by both
 * /api/version and the apply pre-flight). The critical class: this deployment
 * channel stamps images per git SHA, so "current" can be a `build-<sha>`
 * fingerprint while upstream releases are `csa-inabox-vX.Y.Z` tags — the
 * comparison must offer the update (treat the sha build as older), never
 * report a false "Up to date" or a false "already up to date" refusal.
 */
import { describe, it, expect } from 'vitest';
import { parseSemverCore, compareSemver } from '../current-version';

describe('parseSemverCore', () => {
  it('parses bare, v-prefixed, and repo-scoped release tags', () => {
    expect(parseSemverCore('0.68.0')).toEqual([0, 68, 0]);
    expect(parseSemverCore('v0.68.0')).toEqual([0, 68, 0]);
    expect(parseSemverCore('csa-inabox-v0.68.0')).toEqual([0, 68, 0]);
    expect(parseSemverCore('1.2')).toEqual([1, 2, 0]);
  });

  it('returns null for sha fingerprints and non-versions', () => {
    expect(parseSemverCore('build-d07f330d094b')).toBeNull();
    expect(parseSemverCore('dev')).toBeNull();
    expect(parseSemverCore('')).toBeNull();
  });
});

describe('compareSemver', () => {
  it('a sha-tagged current build is OLDER than any semver release (update offered)', () => {
    expect(compareSemver('build-d07f330d094b', 'csa-inabox-v0.68.0')).toBe(-1);
    expect(compareSemver('dev', 'csa-inabox-v0.68.0')).toBe(-1);
  });

  it('compares across prefix forms', () => {
    expect(compareSemver('0.67.2', 'csa-inabox-v0.68.0')).toBe(-1);
    expect(compareSemver('0.68.0', 'csa-inabox-v0.68.0')).toBe(0);
    expect(compareSemver('0.68.1', 'csa-inabox-v0.68.0')).toBe(1);
  });

  it('a semver current vs a non-version upstream compares as newer', () => {
    expect(compareSemver('0.68.0', 'weird-tag')).toBe(1);
  });

  it('two non-versions compare equal (no false update)', () => {
    expect(compareSemver('dev', 'unknown')).toBe(0);
  });
});
