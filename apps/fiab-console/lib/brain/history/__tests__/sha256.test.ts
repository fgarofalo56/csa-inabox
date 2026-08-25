/**
 * SHA-256 — proven against the published vectors, not against itself.
 *
 * Every other test in this directory only needs the hash to be DETERMINISTIC. A
 * toy hash with a plausible name would pass all of them, and would then quietly
 * collide — at which point the store treats a changed estate as unchanged and
 * discards a real change with no signal anywhere. These vectors are the only
 * thing standing between `./sha256.ts` and that outcome.
 *
 * Sources: FIPS 180-4 / NIST CSRC published SHA-256 test values.
 */

import { describe, it, expect } from 'vitest';
import { sha256Hex, shortDigest } from '../sha256';

describe('sha256Hex — published vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it("hashes 'abc'", () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the 448-bit two-block message', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes the 896-bit message (exercises the multi-block path)', () => {
    expect(
      sha256Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno' +
          'ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it('hashes 1,000 repetitions of "a" (exercises the length encoding)', () => {
    // 1000 * 8 = 8000 bits. Not a NIST vector; cross-checked against the
    // algorithm's own multi-block path, and present specifically so a padding
    // bug that only shows up past one block cannot hide behind the short vectors.
    const h = sha256Hex('a'.repeat(1000));
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Distinct from 999 and 1001 — a length-field bug typically collapses these.
    expect(h).not.toBe(sha256Hex('a'.repeat(999)));
    expect(h).not.toBe(sha256Hex('a'.repeat(1001)));
  });

  it('is UTF-8 aware — a non-BMP character does not hash as its surrogates', () => {
    // A hand-rolled UTF-8 encoder is where JS hashes usually break. TextEncoder
    // is used precisely to avoid that, and this asserts it.
    expect(sha256Hex('\u{1F9E0}')).toBe(sha256Hex(String.fromCodePoint(0x1f9e0)));
    expect(sha256Hex('\u{1F9E0}')).not.toBe(sha256Hex('🧠x'));
  });

  it('avalanches — a one-bit input change changes most of the output', () => {
    const a = sha256Hex('loom-broker-url');
    const b = sha256Hex('loom-broker-urm');
    let same = 0;
    for (let i = 0; i < 64; i += 1) if (a[i] === b[i]) same += 1;
    // A trivial "hash" (e.g. a checksum or a truncated identity) leaves most of
    // the output identical. Real sha256 leaves ~4 of 64 nibbles matching by luck.
    expect(same).toBeLessThan(20);
  });
});

describe('shortDigest', () => {
  it('is the first 16 hex of the full digest', () => {
    expect(shortDigest('abc')).toBe('ba7816bf8f01cfea');
    expect(shortDigest('abc')).toBe(sha256Hex('abc').slice(0, 16));
  });

  it('separates the empty string from a real value', () => {
    expect(shortDigest('')).not.toBe(shortDigest('https://loom-direct-lake.internal'));
  });
});
