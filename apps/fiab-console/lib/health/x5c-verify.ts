/**
 * Server-only normalization of an inline JWKS (#5151, review of #5517). Runs on
 * the BFF after the browser-safe structural validator (smart-registration.ts).
 *
 * PRINCIPLE: the CP receives ONLY data the BFF re-derived itself, never caller
 * bytes. The CP stores the JWKS as given, so any caller byte that survives to
 * the forward is a place to smuggle something (measured on #5517: a valid
 * certificate with a PKCS#8 private key appended passed a parse-only check,
 * because `new X509Certificate(der)` ignores trailing bytes).
 *
 *  - The key: `createPublicKey({key: jwk, format: 'jwk'})` (rejects an off-curve
 *    point or a malformed modulus), then ONLY its `export({format:'jwk'})`.
 *  - Metadata: kid, alg, use, key_ops, already allowlisted and type-checked.
 *  - x5c: every entry must parse AND be exactly the certificate's own DER
 *    (`der.equals(cert.raw)`), and what is forwarded is `cert.raw` re-encoded.
 *    The first certificate's key must equal the JWK's key (RFC 7517 4.7); the
 *    rest are the chain and must parse cleanly.
 *  - x5t / x5t#S256: if supplied they must match x5c[0], and the forwarded
 *    value is recomputed from `cert.raw`.
 */
import { X509Certificate, createHash, createPublicKey, type JsonWebKey } from 'node:crypto';
import type { PublicJwks } from './smart-registration';

const b64url = (b: Buffer) => b.toString('base64url');
const KEY_PARAMS = { RSA: ['n', 'e'], EC: ['crv', 'x', 'y'] } as const;

export function normalizePublicJwks(jwks: PublicJwks): { jwks: PublicJwks } | { error: string } {
  const keys: Array<Record<string, unknown>> = [];
  for (let i = 0; i < jwks.keys.length; i++) {
    const k = jwks.keys[i] as Record<string, unknown>;
    const at = `jwks: key ${i + 1}`;
    const kty = k.kty === 'RSA' ? 'RSA' : 'EC';
    const input: Record<string, unknown> = { kty };
    for (const p of KEY_PARAMS[kty]) input[p] = k[p];
    let key: Record<string, unknown>;
    try {
      key = createPublicKey({ key: input as JsonWebKey, format: 'jwk' }).export({ format: 'jwk' }) as Record<string, unknown>;
    } catch {
      return { error: `${at}: not a valid ${kty} public key (for EC: the point is not on P-384); nothing was sent` };
    }
    // Compared and forwarded against the RE-DERIVED key, never the caller's strings.
    const same = (a: Record<string, unknown>) => KEY_PARAMS[kty].every((p) => a[p] === key[p]);

    const out: Record<string, unknown> = { kty, kid: k.kid };
    for (const m of ['alg', 'use'] as const) if (typeof k[m] === 'string') out[m] = k[m];
    if (Array.isArray(k.key_ops)) out.key_ops = ['verify'];
    for (const p of KEY_PARAMS[kty]) out[p] = key[p];

    if (k.x5c === undefined) {
      if (k.x5t !== undefined || k['x5t#S256'] !== undefined) return { error: `${at}: x5t / x5t#S256 need the x5c they are a thumbprint of` };
    } else {
      const raws: Buffer[] = [];
      for (let j = 0; j < (k.x5c as string[]).length; j++) {
        const der = Buffer.from((k.x5c as string[])[j] as string, 'base64');
        let cert: X509Certificate;
        try { cert = new X509Certificate(der); } catch {
          return { error: `${at}: x5c entry ${j + 1} is not an X.509 certificate; nothing was sent` };
        }
        const raw = Buffer.from(cert.raw);
        // X509Certificate ignores trailing bytes; the entry must be the certificate and nothing else.
        if (!der.equals(raw)) return { error: `${at}: x5c entry ${j + 1} carries bytes beyond the certificate; nothing was sent` };
        if (j === 0) {
          let pub: Record<string, unknown>;
          try { pub = cert.publicKey.export({ format: 'jwk' }) as Record<string, unknown>; } catch {
            return { error: `${at}: x5c: the first certificate's public key could not be read` };
          }
          if (pub.kty !== kty || !same(pub)) return { error: `${at}: x5c: the first certificate's public key is not this JWK's key` };
        }
        raws.push(raw);
      }
      const first = raws[0] as Buffer;
      const x5t = b64url(createHash('sha1').update(first).digest());
      const s256 = b64url(createHash('sha256').update(first).digest());
      if (k.x5t !== undefined && k.x5t !== x5t) return { error: `${at}: x5t does not match x5c[0]` };
      if (k['x5t#S256'] !== undefined && k['x5t#S256'] !== s256) return { error: `${at}: x5t#S256 does not match x5c[0]` };
      out.x5c = raws.map((r) => r.toString('base64'));
      if (k.x5t !== undefined) out.x5t = x5t;
      if (k['x5t#S256'] !== undefined) out['x5t#S256'] = s256;
    }
    keys.push(out);
  }
  return { jwks: { keys } };
}
