/**
 * status-token — the shared anchor for numeric failure codes.
 *
 * This file exists because `scripts/ci/_az-failure-class.mjs` shipped `\b503\b`,
 * which matched inside `rg-loom-503` and classified a real GatewayTimeout as
 * transient — and because the follow-up fix anchored ONE alternation of three,
 * making two of them worse. The property being pinned here is that BOTH halves
 * of the anchor are load-bearing, with a fixture per half that the OTHER half
 * alone would NOT block. A fixture blocked by either anchor cannot discriminate
 * a half-revert, so it would prove nothing.
 */
import { describe, it, expect } from 'vitest';
import { STATUS_TOKEN_LOOKBEHIND, STATUS_TOKEN_LOOKAHEAD, statusToken } from '../status-token';

const re = (alt: string) => new RegExp(statusToken(alt), 'i');

describe('statusToken', () => {
  it('matches a status that stands alone, however it is punctuated', () => {
    for (const s of [
      'AuthorizationFailed (403)',
      'ERROR: 403',
      'status code: 403',
      'failed 403: {"error":…}',
      '[403] refused',
      '403',
      'answered 403.',
    ]) {
      expect(re('40[13]').test(s), `should have matched ${JSON.stringify(s)}`).toBe(true);
    }
  });

  it('does NOT match a status-shaped run inside a name (the rg-loom-503 defect)', () => {
    for (const s of [
      'storage account st403loom could not be resolved',
      'resource group rg-loom-403 not found',
      'trigger loom_copy_403abc_trg',
      'warehouse WH_394509 is unavailable',
      'code 4031',
      'code 1403',
    ]) {
      expect(re('40[13]|394509').test(s), `should NOT have matched ${JSON.stringify(s)}`).toBe(false);
    }
  });

  it('LOOKBEHIND alone is what blocks a TRAILING token', () => {
    // `WH_394509` ends the string, so the lookahead is satisfied. Only the
    // lookbehind can reject it — drop it and this reopens.
    const lookaheadOnly = new RegExp(`(?:394509)${STATUS_TOKEN_LOOKAHEAD}`, 'i');
    expect(lookaheadOnly.test('warehouse WH_394509')).toBe(true);
    expect(re('394509').test('warehouse WH_394509')).toBe(false);
  });

  it('LOOKAHEAD alone is what blocks a LEADING token', () => {
    // `394509_EU` starts after a space, so the lookbehind is satisfied. Only the
    // lookahead can reject it — drop it and this reopens.
    const lookbehindOnly = new RegExp(`${STATUS_TOKEN_LOOKBEHIND}(?:394509)`, 'i');
    expect(lookbehindOnly.test('database 394509_EU')).toBe(true);
    expect(re('394509').test('database 394509_EU')).toBe(false);
  });
});
