import { describe, expect, it } from 'vitest';
import { isPrivateHost, rsaModulusBits } from '../src/auth/jwks-guard.js';

describe('isPrivateHost range edges (#5134)', () => {
  // [host, private?] pairs sit either side of each range boundary, so an off-by-one flips one of them.
  const cases: Array<[string, boolean]> = [
    ['172.15.255.255', false], ['172.16.0.1', true], ['172.31.255.255', true], ['172.32.0.1', false],
    ['100.63.255.255', false], ['100.64.0.1', true], ['100.127.255.255', true], ['100.128.0.1', false],
    ['169.253.0.1', false], ['169.254.0.1', true], ['192.168.1.1', true], ['192.167.1.1', false],
    ['8.8.8.8', false], ['[fc00::1]', true], ['[fd12::1]', true], ['[fe80::1]', true], ['[2001:db8::1]', false],
    ['[::ffff:a00:1]', true], ['[::ffff:808:808]', false], ['keys.example.com', false], ['svc.internal', true],
  ];
  for (const [host, priv] of cases) {
    it(`${host} -> ${priv ? 'private' : 'public'}`, () => {
      expect(isPrivateHost(host)).toBe(priv);
    });
  }
});

describe('rsaModulusBits', () => {
  it('counts the exact bit length, ignoring leading zero bytes', () => {
    const n2048 = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(255, 1)]).toString('base64url');
    const n2047 = Buffer.concat([Buffer.from([0x40]), Buffer.alloc(255, 1)]).toString('base64url');
    const padded = Buffer.concat([Buffer.from([0, 0]), Buffer.from([0x80]), Buffer.alloc(255, 1)]).toString('base64url');
    expect(rsaModulusBits(n2048)).toBe(2048); // breaks at 2056 if the byte count is used instead of the bit count
    expect(rsaModulusBits(n2047)).toBe(2047);
    expect(rsaModulusBits(padded)).toBe(2048);
    expect(rsaModulusBits(undefined)).toBe(0);
    expect(rsaModulusBits('')).toBe(0);
  });
});
