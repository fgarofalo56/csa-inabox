// Registration-time guards for client key material (#5134).
//
// SCOPE, stated so it is not over-claimed: isPrivateHost judges the URL as
// written. A public DNS name that RESOLVES to a private address is NOT caught
// here; that needs a resolve-time check in the JWKS fetcher (tracked in #5134).

import { isIP } from 'node:net';

export const MIN_RSA_BITS = 2048;

/** Bit length of an RSA modulus given as a base64url JWK `n`; 0 if unreadable. */
export function rsaModulusBits(n: unknown): number {
  if (typeof n !== 'string' || n.length === 0) return 0;
  let buf = Buffer.from(n, 'base64url');
  let i = 0;
  while (i < buf.length && buf[i] === 0) i++;
  buf = buf.subarray(i);
  if (buf.length === 0) return 0;
  return (buf.length - 1) * 8 + (32 - Math.clz32(buf[0] as number));
}

function privateV4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True for loopback, link-local, RFC1918/CGNAT, unique-local, multicast and internal-only names. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const fam = isIP(h);
  if (fam === 4) return privateV4(h.split('.').map(Number));
  if (fam === 6) {
    // Expand enough to read the first hextet and any IPv4-mapped tail.
    if (h === '::' || h === '::1') return true;
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mapped) {
      const hi = parseInt(mapped[1] as string, 16);
      const lo = parseInt(mapped[2] as string, 16);
      return privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    }
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (dotted) return privateV4((dotted[1] as string).split('.').map(Number));
    const first = parseInt(h.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return !h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
}
