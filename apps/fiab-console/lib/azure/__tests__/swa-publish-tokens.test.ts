import { describe, it, expect, beforeAll } from 'vitest';
import { signSwaBundleToken, verifySwaBundleToken, signAppReadToken, verifyAppReadToken } from '../swa-publish';

beforeAll(() => { process.env.SESSION_SECRET = 'unit-test-secret-0123456789abcdef'; });

describe('swa bundle token', () => {
  it('round-trips for the same type/item and rejects mismatches', () => {
    const { exp, sig } = signSwaBundleToken('workshop-app', 'item-1');
    expect(verifySwaBundleToken('workshop-app', 'item-1', exp, sig)).toBe(true);
    expect(verifySwaBundleToken('slate-app', 'item-1', exp, sig)).toBe(false);
    expect(verifySwaBundleToken('workshop-app', 'item-2', exp, sig)).toBe(false);
    expect(verifySwaBundleToken('workshop-app', 'item-1', exp + 1, sig)).toBe(false);
    expect(verifySwaBundleToken('workshop-app', 'item-1', exp, 'AAAA')).toBe(false);
  });

  it('rejects expired tokens', () => {
    const { sig } = signSwaBundleToken('workshop-app', 'item-1');
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(verifySwaBundleToken('workshop-app', 'item-1', past, sig)).toBe(false);
  });
});

describe('app read token', () => {
  it('round-trips per item+version; version bump revokes', () => {
    const t1 = signAppReadToken('item-9', 1);
    expect(verifyAppReadToken('item-9', 1, t1)).toBe(true);
    expect(verifyAppReadToken('item-9', 2, t1)).toBe(false); // rotated
    expect(verifyAppReadToken('other', 1, t1)).toBe(false);
    expect(verifyAppReadToken('item-9', 1, '')).toBe(false);
  });
});
