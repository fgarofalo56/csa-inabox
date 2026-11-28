/**
 * Server-only `x5c` check for an inline JWKS (#5151). The browser-safe validator
 * (smart-registration.ts) checks `x5c` structurally; this parses every entry as
 * an X.509 certificate with node:crypto and requires the FIRST certificate's
 * public key to be the JWK's own key (RFC 7517 4.7: "The key in the first
 * certificate MUST match the public key represented by other members of the
 * JWK"). Later entries are the chain, so they must parse but carry other keys.
 *
 * Why it matters: the CP stores `x5c` verbatim, so an unparsed `x5c` is a place
 * to smuggle arbitrary bytes, e.g. a PKCS#8 private-key DER. Parsing as a
 * certificate refuses that.
 */
import { X509Certificate, createHash } from 'node:crypto';
import type { PublicJwks } from './smart-registration';

const b64url = (b: Buffer) => b.toString('base64url');

export function verifyX5c(jwks: PublicJwks): { ok: true } | { error: string } {
  for (let i = 0; i < jwks.keys.length; i++) {
    const k = jwks.keys[i] as Record<string, unknown>;
    if (k.x5c === undefined) {
      if (k.x5t !== undefined || k['x5t#S256'] !== undefined) return { error: `jwks: key ${i + 1}: x5t / x5t#S256 need the x5c they are a thumbprint of` };
      continue;
    }
    const at = `jwks: key ${i + 1}: x5c`;
    const certs: X509Certificate[] = [];
    const ders: Buffer[] = [];
    for (let j = 0; j < (k.x5c as string[]).length; j++) {
      const der = Buffer.from((k.x5c as string[])[j] as string, 'base64');
      try { certs.push(new X509Certificate(der)); ders.push(der); } catch {
        return { error: `${at} entry ${j + 1} is not an X.509 certificate; nothing was sent` };
      }
    }
    let pub: Record<string, unknown>;
    try { pub = (certs[0] as X509Certificate).publicKey.export({ format: 'jwk' }) as Record<string, unknown>; } catch {
      return { error: `${at}: the first certificate's public key could not be read` };
    }
    const same = k.kty === 'RSA'
      ? pub.kty === 'RSA' && pub.n === k.n && pub.e === k.e
      : pub.kty === 'EC' && pub.crv === k.crv && pub.x === k.x && pub.y === k.y;
    if (!same) return { error: `${at}: the first certificate's public key is not this JWK's key` };
    const first = ders[0] as Buffer;
    if (k.x5t !== undefined && k.x5t !== b64url(createHash('sha1').update(first).digest())) return { error: `jwks: key ${i + 1}: x5t does not match x5c[0]` };
    if (k['x5t#S256'] !== undefined && k['x5t#S256'] !== b64url(createHash('sha256').update(first).digest())) {
      return { error: `jwks: key ${i + 1}: x5t#S256 does not match x5c[0]` };
    }
  }
  return { ok: true };
}
