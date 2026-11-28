// CP-side JWK normalization (#5518). The CP is the authority for client key material: the console BFF normalizes
// too (apps/fiab-console/lib/health/x5c-verify.ts), but any other admin-API caller reaches the CP directly, so the
// CP stores, and verifies with, ONLY key material it re-derived itself. Never a caller byte.
//
//  - An allowlist of members per kty, read from the key's OWN keys (Object.keys over JSON.parse output, so a
//    "__proto__" member is visible and refused). A boolean `ext` (the WebCrypto flag Inferno's JWKS carries) is
//    accepted and dropped. Everything else, including the SHA-1 `x5t`, is refused.
//  - Exact parameter sizes: P-384 x/y are 48 bytes, RSA e at most 4 bytes, n within [MIN_RSA_BITS, 8192] bits.
//  - The key is round-tripped through createPublicKey({format:'jwk'}) (which refuses an off-curve point) and ONLY
//    its export({format:'jwk'}) is kept, plus allowlisted, type-checked metadata (kid, alg, use, key_ops).
//  - x5c: each entry must be EXACTLY one certificate's DER (`der.equals(cert.raw)`): X509Certificate ignores
//    trailing bytes, so a certificate with a PKCS#8 private key appended would otherwise parse. Only cert.raw is
//    kept, x5c[0]'s key must be the JWK's key, and x5t#S256 is recomputed from cert.raw.

import { X509Certificate, createHash, createPublicKey, type JsonWebKey } from 'node:crypto';
import type { JWK } from 'jose';
import { MIN_RSA_BITS, rsaModulusBits } from './jwks-guard.js';

export const JWK_COMMON_MEMBERS: readonly string[] = ['kty', 'kid', 'alg', 'use', 'key_ops', 'x5c', 'x5t#S256'];
export const JWK_KEY_PARAMS = { EC: ['crv', 'x', 'y'], RSA: ['n', 'e'] } as const;
/** Accepted on input (a boolean only) and never stored. */
export const JWK_DROPPED_MEMBERS: readonly string[] = ['ext'];
export const JWK_ALGS: Readonly<Record<'EC' | 'RSA', string>> = { EC: 'ES384', RSA: 'RS384' };
export const JWK_LIMITS = { p384CoordinateBytes: 48, maxRsaExponentBytes: 4, maxRsaBits: 8192, maxX5c: 5, maxKidLength: 200 } as const;

const B64URL = /^[A-Za-z0-9_-]+$/;
const B64_STD = /^[A-Za-z0-9+/]+={0,2}$/;
const shown = (m: string): string => JSON.stringify(m.slice(0, 40));

/** base64url bytes, or undefined when the string is not strict base64url. */
function b64urlBytes(v: unknown): Buffer | undefined {
  return typeof v === 'string' && B64URL.test(v) ? Buffer.from(v, 'base64url') : undefined;
}

export type JwkResult = { jwk: JWK } | { error: string };

/** Normalize one public JWK. `at` prefixes the error (e.g. "jwks: key 2"). */
export function normalizeJwk(input: unknown, at = 'jwk'): JwkResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: `${at} is not an object` };
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return { error: `${at} is not a plain JSON object` };
  const k = input as Record<string, unknown>;
  const own = Object.keys(k);
  if (k.kty !== 'EC' && k.kty !== 'RSA') return { error: `${at}: kty must be EC or RSA` };
  const kty = k.kty;
  // SHA-1 is accepted nowhere (CodeQL js/weak-cryptographic-algorithm); a true message rather than "not allowed".
  if (own.includes('x5t')) return { error: `${at}: x5t (SHA-1) is not accepted; use x5t#S256 or omit it` };
  const allowed = [...JWK_COMMON_MEMBERS, ...JWK_KEY_PARAMS[kty]];
  const unknown = own.filter((m) => !allowed.includes(m) && !JWK_DROPPED_MEMBERS.includes(m));
  if (unknown.length) return { error: `${at}: member ${unknown.slice(0, 3).map(shown).join(', ')} is not allowed on an ${kty} public key` };
  if (k.ext !== undefined && typeof k.ext !== 'boolean') return { error: `${at}: ext must be a boolean` };
  if (typeof k.kid !== 'string' || k.kid.length === 0 || k.kid.length > JWK_LIMITS.maxKidLength) {
    return { error: `${at}: kid is required (1 to ${JWK_LIMITS.maxKidLength} characters)` };
  }
  if (k.alg !== undefined && k.alg !== JWK_ALGS[kty]) return { error: `${at}: alg must be ${JWK_ALGS[kty]} for an ${kty} key` };
  if (k.use !== undefined && k.use !== 'sig') return { error: `${at}: use must be sig` };
  if (k.key_ops !== undefined && !(Array.isArray(k.key_ops) && k.key_ops.length === 1 && k.key_ops[0] === 'verify')) {
    return { error: `${at}: key_ops may only be ["verify"]` };
  }

  const params: Record<string, unknown> = { kty };
  if (kty === 'EC') {
    if (k.crv !== 'P-384') return { error: `${at}: EC key must use crv P-384` };
    const x = b64urlBytes(k.x);
    const y = b64urlBytes(k.y);
    if (x?.length !== JWK_LIMITS.p384CoordinateBytes || y?.length !== JWK_LIMITS.p384CoordinateBytes) {
      return { error: `${at}: EC P-384 x and y must each be ${JWK_LIMITS.p384CoordinateBytes} base64url bytes` };
    }
    Object.assign(params, { crv: 'P-384', x: k.x, y: k.y });
  } else {
    const e = b64urlBytes(k.e);
    if (!e || e.length === 0 || e.length > JWK_LIMITS.maxRsaExponentBytes) return { error: `${at}: RSA e must be 1 to ${JWK_LIMITS.maxRsaExponentBytes} bytes` };
    if (!b64urlBytes(k.n)) return { error: `${at}: RSA n must be base64url` };
    const bits = rsaModulusBits(k.n);
    if (bits < MIN_RSA_BITS || bits > JWK_LIMITS.maxRsaBits) return { error: `${at}: RSA keys must be ${MIN_RSA_BITS} to ${JWK_LIMITS.maxRsaBits} bits` };
    Object.assign(params, { n: k.n, e: k.e });
  }

  let key: Record<string, unknown>;
  try {
    key = createPublicKey({ key: params as JsonWebKey, format: 'jwk' }).export({ format: 'jwk' }) as Record<string, unknown>;
  } catch {
    return { error: `${at}: not a valid ${kty} public key${kty === 'EC' ? ' (the point is not on P-384)' : ''}` };
  }
  // Built from the RE-DERIVED key and the allowlisted metadata only.
  const out: Record<string, unknown> = { kty, kid: k.kid };
  if (k.alg !== undefined) out.alg = k.alg;
  if (k.use !== undefined) out.use = 'sig';
  if (k.key_ops !== undefined) out.key_ops = ['verify'];
  for (const p of JWK_KEY_PARAMS[kty]) out[p] = key[p];

  if (k.x5c === undefined) {
    if (k['x5t#S256'] !== undefined) return { error: `${at}: x5t#S256 needs the x5c it is a thumbprint of` };
  } else {
    const list = k.x5c;
    if (!Array.isArray(list) || list.length === 0 || list.length > JWK_LIMITS.maxX5c || list.some((c) => typeof c !== 'string' || !B64_STD.test(c))) {
      return { error: `${at}: x5c must be 1 to ${JWK_LIMITS.maxX5c} base64 DER certificates` };
    }
    const raws: Buffer[] = [];
    for (let j = 0; j < list.length; j++) {
      const der = Buffer.from(list[j] as string, 'base64');
      let cert: X509Certificate;
      try {
        cert = new X509Certificate(der);
      } catch {
        return { error: `${at}: x5c entry ${j + 1} is not an X.509 certificate` };
      }
      const raw = Buffer.from(cert.raw);
      // X509Certificate ignores trailing bytes: the entry must be the certificate and nothing else.
      if (!der.equals(raw)) return { error: `${at}: x5c entry ${j + 1} carries bytes beyond the certificate` };
      if (j === 0) {
        let pub: Record<string, unknown>;
        try {
          pub = cert.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
        } catch {
          return { error: `${at}: x5c: the first certificate's public key could not be read` };
        }
        if (pub.kty !== kty || !JWK_KEY_PARAMS[kty].every((p) => pub[p] === key[p])) {
          return { error: `${at}: x5c: the first certificate's public key is not this JWK's key` };
        }
      }
      raws.push(raw);
    }
    const s256 = createHash('sha256').update(raws[0] as Buffer).digest('base64url');
    if (k['x5t#S256'] !== undefined && k['x5t#S256'] !== s256) return { error: `${at}: x5t#S256 does not match x5c[0]` };
    out.x5c = raws.map((r) => r.toString('base64'));
    if (k['x5t#S256'] !== undefined) out['x5t#S256'] = s256;
  }
  return { jwk: out as JWK };
}

/** Normalize every key; the first refusal refuses the set. */
export function normalizeJwks(keys: readonly unknown[]): { keys: JWK[] } | { error: string } {
  const out: JWK[] = [];
  for (let i = 0; i < keys.length; i++) {
    const r = normalizeJwk(keys[i], `jwks: key ${i + 1}`);
    if ('error' in r) return r;
    out.push(r.jwk);
  }
  return { keys: out };
}
