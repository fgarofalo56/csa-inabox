// CP-side JWK normalization (#5518). Every probe is built at test time from a real key pair, and each refusal
// asserts WHICH rule refused it (the error text), so a probe cannot pass by tripping an unrelated check.

import { X509Certificate, createHash, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeJwk, normalizeJwks } from '../src/auth/jwk-normalize.js';
import { MAX_JWKS_BYTES, httpsJwksFetcher, verificationKeys } from '../src/auth/backend-auth.js';
import type { ClientDoc } from '../src/auth/types.js';
import { selfSignedCertB64 } from './self-signed-cert.js';

const ec = () => generateKeyPairSync('ec', { namedCurve: 'P-384' });
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubJwk = (k: KeyObject) => k.export({ format: 'jwk' }) as Record<string, string>;
const b64u = (b: Buffer) => b.toString('base64url');
const refused = (input: unknown) => {
  const r = normalizeJwk(input);
  return 'error' in r ? r.error : `ACCEPTED ${JSON.stringify(r.jwk)}`;
};

describe('normalizeJwk refuses every carrier probe (#5518)', () => {
  const { publicKey, privateKey } = ec();
  const base = { ...pubJwk(publicKey), kid: 'k1', alg: 'ES384' };
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;

  it('"D" (a case variant of the private member) is refused by the allowlist', () => {
    // Breaks (ACCEPTED) with the allowlist off: a denylist of d/p/q/... is case-sensitive and passes "D".
    expect(refused({ ...base, D: pubJwk(privateKey).d })).toMatch(/member "D" is not allowed/);
  });

  it('an own "__proto__" member carrying d is refused, not silently dropped', () => {
    // JSON.parse makes "__proto__" an OWN member (an object literal would set the prototype instead).
    const k = JSON.parse(JSON.stringify(base).replace(/^\{/, `{"__proto__":{"d":"${pubJwk(privateKey).d}"},`));
    expect(Object.keys(k)).toContain('__proto__'); // the fixture really carries it
    expect(refused(k)).toMatch(/member "__proto__" is not allowed/); // breaks (ACCEPTED) with the allowlist off
  });

  it('"nd" and "xd" (names that only contain a private member) are refused', () => {
    expect(refused({ ...base, nd: 'AQAB' })).toMatch(/member "nd" is not allowed/); // breaks with the allowlist off
    expect(refused({ ...base, xd: 'AQAB' })).toMatch(/member "xd" is not allowed/);
  });

  it('x5t (SHA-1) is refused by name', () => {
    expect(refused({ ...base, x5t: b64u(Buffer.alloc(20, 1)) })).toMatch(/x5t \(SHA-1\) is not accepted/);
  });

  it('a valid certificate with a PKCS#8 private key appended is refused (trailing bytes)', () => {
    const cert = Buffer.from(selfSignedCertB64(publicKey, privateKey), 'base64');
    const smuggle = Buffer.concat([cert, pkcs8]).toString('base64');
    // The vector is real: node parses the padded DER and reports the SAME raw certificate.
    expect(Buffer.from(new X509Certificate(Buffer.from(smuggle, 'base64')).raw).equals(cert)).toBe(true);
    // Breaks (ACCEPTED) without the der.equals(cert.raw) check.
    expect(refused({ ...base, x5c: [smuggle] })).toMatch(/x5c entry 1 carries bytes beyond the certificate/);
    // Paired permit: the certificate alone is accepted.
    expect(refused({ ...base, x5c: [cert.toString('base64')] })).toMatch(/^ACCEPTED/);
  });

  it('x as the private scalar d is refused (not on the curve)', () => {
    const d = pubJwk(privateKey).d as string;
    expect(Buffer.from(d, 'base64url').length).toBe(48); // the size check alone cannot refuse it
    expect(refused({ ...base, x: d })).toMatch(/not a valid EC public key \(the point is not on P-384\)/);
  });

  it('y as a PKCS#8 DER is refused (not 48 bytes)', () => {
    expect(refused({ ...base, y: b64u(pkcs8) })).toMatch(/x and y must each be 48 base64url bytes/);
  });

  it('an off-curve point is refused by the createPublicKey round trip', () => {
    const y = Buffer.from(base.y as string, 'base64url');
    y[47] = (y[47] as number) ^ 1; // one bit: still 48 bytes, no longer on P-384
    expect(refused({ ...base, y: b64u(y) })).toMatch(/the point is not on P-384/);
  });

  it('refuses P-256, a wrong alg, use enc, key_ops sign, and an RSA modulus over 8192 bits', () => {
    expect(refused({ ...pubJwk(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey), kid: 'k' })).toMatch(/crv P-384/);
    expect(refused({ ...base, alg: 'ES256' })).toMatch(/alg must be ES384/);
    expect(refused({ ...base, use: 'enc' })).toMatch(/use must be sig/);
    expect(refused({ ...base, key_ops: ['sign'] })).toMatch(/key_ops may only be \["verify"\]/);
    expect(refused({ ...base, key_ops: ['verify', 'verify'] })).toMatch(/key_ops/);
    const big = { kty: 'RSA', kid: 'r', e: 'AQAB', n: b64u(Buffer.concat([Buffer.from([0x80]), Buffer.alloc(1024)])) }; // 8200 bits
    expect(refused(big)).toMatch(/RSA keys must be 2048 to 8192 bits/);
    expect(refused({ ...pubJwk(rsa().publicKey), kid: 'r', e: b64u(Buffer.alloc(5, 1)) })).toMatch(/RSA e must be 1 to 4 bytes/);
  });

  it('refuses more than 5 x5c entries and an x5c[0] of another key', () => {
    const cert = selfSignedCertB64(publicKey, privateKey);
    expect(refused({ ...base, x5c: Array(6).fill(cert) })).toMatch(/x5c must be 1 to 5/);
    const other = ec();
    expect(refused({ ...base, x5c: [selfSignedCertB64(other.publicKey, other.privateKey)] })).toMatch(/is not this JWK's key/);
  });
});

describe('normalizeJwk keeps only the re-derived key (#5518)', () => {
  it('an EC public key is stored exactly as its re-export plus the allowlisted metadata', () => {
    const { publicKey } = ec();
    const r = normalizeJwk({ ...pubJwk(publicKey), kid: 'k1', alg: 'ES384', use: 'sig' });
    expect(r).toStrictEqual({ jwk: { ...createPublicKey({ key: pubJwk(publicKey), format: 'jwk' }).export({ format: 'jwk' }), kid: 'k1', alg: 'ES384', use: 'sig' } });
  });

  it('an RSA n with a leading zero byte is stored as the RE-EXPORT, not the caller string', () => {
    const { publicKey } = rsa();
    const j = pubJwk(publicKey);
    const padded = b64u(Buffer.concat([Buffer.from([0]), Buffer.from(j.n as string, 'base64url')]));
    expect(padded).not.toBe(j.n); // the fixture's two operands differ, so a spread of the input is visible
    const r = normalizeJwk({ kty: 'RSA', kid: 'r1', alg: 'RS384', n: padded, e: j.e });
    // Breaks (n === padded) if the input is spread instead of the createPublicKey re-export.
    expect(r).toStrictEqual({ jwk: { kty: 'RSA', kid: 'r1', alg: 'RS384', n: j.n, e: j.e } });
  });

  it("an Inferno-shape key (ext:true, key_ops verify) is accepted and ext is dropped", () => {
    const { publicKey } = ec();
    const inferno = { ...pubJwk(publicKey), kid: 'inferno-es384', alg: 'ES384', key_ops: ['verify'], ext: true };
    const r = normalizeJwk(inferno);
    // Breaks (ext present) if the input is spread; breaks (error) if ext is refused rather than dropped.
    expect(r).toStrictEqual({ jwk: { ...pubJwk(publicKey), kid: 'inferno-es384', alg: 'ES384', key_ops: ['verify'] } });
    expect(refused({ ...inferno, ext: 'yes' })).toMatch(/ext must be a boolean/);
  });

  it('x5c is stored as cert.raw and x5t#S256 is recomputed from it', () => {
    const { publicKey, privateKey } = ec();
    const cert = selfSignedCertB64(publicKey, privateKey);
    const s256 = createHash('sha256').update(Buffer.from(cert, 'base64')).digest('base64url');
    const r = normalizeJwk({ ...pubJwk(publicKey), kid: 'k1', x5c: [cert], 'x5t#S256': s256 });
    expect(r).toStrictEqual({ jwk: { ...pubJwk(publicKey), kid: 'k1', x5c: [cert], 'x5t#S256': s256 } });
    expect(refused({ ...pubJwk(publicKey), kid: 'k1', x5c: [cert], 'x5t#S256': b64u(Buffer.alloc(32)) })).toMatch(/x5t#S256 does not match/);
  });
});

describe('verificationKeys: stored docs fail closed, fetched keys are filtered (#5518)', () => {
  const doc = (keys: unknown[]): ClientDoc => ({
    id: 'client-svc', kind: 'client', clientId: 'svc', tenant: 'visn-01', clientType: 'backend', displayName: 'x', status: 'active',
    allowedScopes: [], roleIds: [], redirectUris: [], pou: 'TREAT', updatedAt: 't', updatedBy: 'x', jwks: { keys: keys as never },
  });

  it('a stored set with ONE bad key yields no keys and logs only the client id', () => {
    const good = { ...pubJwk(ec().publicKey), kid: 'k1' };
    const logs: Array<[string, Record<string, string | number>]> = [];
    expect(verificationKeys(doc([good, { ...good, kid: 'k2', D: 'x' }]), undefined, (e, f) => logs.push([e, f]))).toEqual([]);
    expect(logs).toStrictEqual([['auth.client_jwks_invalid', { clientId: 'svc' }]]); // breaks if key material is logged
    expect(verificationKeys(doc([good]), undefined)).toStrictEqual([good]); // paired permit: the clean set
  });

  it('a fetched JWKS drops only the bad key and returns re-derived keys', () => {
    const good = { ...pubJwk(ec().publicKey), kid: 'k1' };
    const logs: string[] = [];
    const keys = verificationKeys(doc([]), [{ ...good, kid: 'bad', D: 'x' }, { ...good, ext: true }], (e) => logs.push(e));
    expect(keys).toStrictEqual([good]); // breaks (2 keys, or ext kept) with the allowlist off or the input spread
    expect(logs).toEqual(['auth.client_jwks_keys_dropped']);
  });

  it('normalizeJwks names the failing key', () => {
    const good = { ...pubJwk(ec().publicKey), kid: 'k1' };
    expect(normalizeJwks([good, { ...good, x5t: 'AA' }])).toStrictEqual({ error: 'jwks: key 2: x5t (SHA-1) is not accepted; use x5t#S256 or omit it' });
  });
});

// ---- #5521 review should-fixes ----
describe('RSA e is exactly 65537 (#5521 review)', () => {
  const j = pubJwk(rsa().publicKey);
  it('e=1 and e=2 are refused; e=65537 is accepted (also with a leading zero byte)', () => {
    // e = 1 means s^1 = m: anyone could forge this client's assertions. Breaks (ACCEPTED) with the e check removed.
    expect(refused({ kty: 'RSA', kid: 'r', n: j.n, e: 'AQ' })).toMatch(/RSA e must be 65537/);
    expect(refused({ kty: 'RSA', kid: 'r', n: j.n, e: 'Ag' })).toMatch(/RSA e must be 65537/); // even
    expect(refused({ kty: 'RSA', kid: 'r', n: j.n, e: 'Aw' })).toMatch(/RSA e must be 65537/); // 3: odd, but not 65537
    expect(j.e).toBe('AQAB');
    expect(refused({ kty: 'RSA', kid: 'r', n: j.n, e: 'AQAB' })).toMatch(/^ACCEPTED/);
    expect(refused({ kty: 'RSA', kid: 'r', n: j.n, e: 'AAEAAQ' })).toMatch(/^ACCEPTED/); // 0x00010001, same value
  });
});

describe('kid is printable ASCII without < > " \' \\ (#5521 review)', () => {
  const base = { ...pubJwk(ec().publicKey) };
  it('refuses markup, quotes, backslash and control characters; accepts an ordinary kid', () => {
    for (const kid of ['<script>\u0000', 'a\u0000b', 'a"b', "a'b", 'a\\b', 'a>b', 'a\nb', 'é', 'x'.repeat(201)]) {
      expect([kid, refused({ ...base, kid })]).toEqual([kid, expect.stringMatching(/kid is required/)]);
    }
    expect(refused({ ...base, kid: 'inferno-es384_2024.1 k=v' })).toMatch(/^ACCEPTED/); // paired permit
    expect(refused({ ...base, kid: 'x'.repeat(200) })).toMatch(/^ACCEPTED/); // the 200 boundary
  });
});

/** An Entra-shaped published key (measured 2026-11-28: kty use kid x5t n e x5c cloud_instance_name issuer). */
function entraShaped() {
  const { publicKey, privateKey } = rsa();
  const j = pubJwk(publicKey);
  return {
    privateKey,
    key: {
      kty: 'RSA', use: 'sig', kid: 'entra-k1', x5t: b64u(randomBytes(20)), n: j.n, e: j.e, x5c: [selfSignedCertB64(publicKey, privateKey)],
      cloud_instance_name: 'microsoftonline.com', issuer: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0',
    },
  };
}

describe('fetched keys: IdP metadata is skipped, inline keys stay strict (#5521 review)', () => {
  it('an Entra-shaped key is kept when FETCHED (x5t, issuer, cloud_instance_name skipped) and refused INLINE', () => {
    const { key } = entraShaped();
    const r = normalizeJwk(key, 'jwk', { fetched: true });
    // Breaks (error) if fetched keys are held to the inline refusal; breaks (x5t/issuer present) if they are copied.
    expect(r).toStrictEqual({ jwk: { kty: 'RSA', use: 'sig', kid: 'entra-k1', n: key.n, e: key.e, x5c: key.x5c } });
    expect(refused(key)).toMatch(/x5t \(SHA-1\) is not accepted/); // inline: unchanged
    const { x5t: _x5t, ...noX5t } = key;
    void _x5t;
    expect(refused(noX5t)).toMatch(/member "cloud_instance_name", "issuer" is not allowed/);
    // Only the NAMED members are skipped: anything else on a fetched key is still refused.
    expect(normalizeJwk({ ...key, d: 'x' }, 'jwk', { fetched: true })).toStrictEqual({ error: 'jwk: member "d" is not allowed on an RSA public key' });
  });

  it('only the key matching the assertion kid and alg is normalized (the rest is never read)', () => {
    const good = { ...pubJwk(ec().publicKey), kid: 'k1' };
    let touched = 0;
    // ownKeys is what normalizeJwk calls first (Object.keys); the kid/kty filter reads only `get`.
    const other = new Proxy({ ...pubJwk(ec().publicKey), kid: 'k2' }, { ownKeys(t) { touched++; return Reflect.ownKeys(t); } });
    const sameKidOtherKty = new Proxy({ ...pubJwk(rsa().publicKey), kid: 'k1' }, { ownKeys(t) { touched++; return Reflect.ownKeys(t); } });
    const doc = { clientId: 'svc' } as ClientDoc;
    expect(verificationKeys(doc, [other, sameKidOtherKty, good], undefined, { kid: 'k1', alg: 'ES384' })).toStrictEqual([good]);
    expect(touched).toBe(0); // breaks (2) if every fetched key is normalized before the kid/alg selection
  });

  it('more than 20 fetched keys yields no keys at verify', () => {
    const good = { ...pubJwk(ec().publicKey), kid: 'k1' };
    const pad = Array.from({ length: 20 }, (_, i) => ({ ...good, kid: `p${i}` }));
    const doc = { clientId: 'svc' } as ClientDoc;
    expect(verificationKeys(doc, [...pad, good], undefined, { kid: 'k1', alg: 'ES384' })).toEqual([]); // 21: breaks ([good]) without the cap
    expect(verificationKeys(doc, [...pad.slice(1), good], undefined, { kid: 'k1', alg: 'ES384' })).toStrictEqual([good]); // 20: paired
  });
});

describe('httpsJwksFetcher bounds (#5521 review)', () => {
  const json = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  it('refuses 21 keys and accepts 20', async () => {
    const k = { kty: 'EC', kid: 'k' };
    await expect(httpsJwksFetcher(json({ keys: Array(21).fill(k) }) as typeof fetch)('https://x.test/jwks')).rejects.toThrow('more than 20 keys');
    await expect(httpsJwksFetcher(json({ keys: Array(20).fill(k) }) as typeof fetch)('https://x.test/jwks')).resolves.toMatchObject({ keys: Array(20).fill(k) });
  });

  it('counts BYTES, not UTF-16 units: 140000 two-byte characters (280 KB, 140 K units) are refused', async () => {
    const body = JSON.stringify({ keys: [], pad: 'é'.repeat(140_000) });
    expect([body.length < MAX_JWKS_BYTES, Buffer.byteLength(body) > MAX_JWKS_BYTES]).toEqual([true, true]); // the fixture straddles the cap
    const f = (() => Promise.resolve(new Response(body))) as unknown as typeof fetch;
    await expect(httpsJwksFetcher(f)('https://x.test/jwks')).rejects.toThrow('jwks document too large'); // breaks (resolves) on text.length
  });

  it('stops reading past the cap instead of buffering the whole body', async () => {
    const CHUNK = 64 * 1024;
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        produced++;
        ctl.enqueue(new Uint8Array(CHUNK).fill(0x20));
        if (produced === 64) ctl.close(); // 4 MiB if read to the end
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const f = (() => Promise.resolve(new Response(stream))) as unknown as typeof fetch;
    await expect(httpsJwksFetcher(f)('https://x.test/jwks')).rejects.toThrow('jwks document too large');
    // 5 chunks (320 KiB) cross the 256 KiB cap. Breaks (64, cancelled false) with res.text().
    expect([produced <= 6, cancelled]).toEqual([true, true]);
  });
});
