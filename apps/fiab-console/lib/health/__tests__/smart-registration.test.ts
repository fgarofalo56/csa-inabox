/**
 * lib/health/smart-registration.ts (#5151): the inline-JWKS validator and the
 * backend-client role / scope lists the Apps tab and its BFF share.
 *
 * Keys are generated at test time (node:crypto), so no key material is
 * committed. The mirrored CP lists are checked against the CP SOURCE read at
 * test time (assertion-design.md "done" 3: lift, never transcribe). Each
 * assertion names the value that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { X509Certificate, createHash, generateKeyPairSync } from 'node:crypto';
import { normalizePublicJwks } from '../x5c-verify';
import { selfSignedCertB64 } from './self-signed-cert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALLOWED_JWK_ALGS, BACKEND_ROLE_CHOICES, JWKS_LIMITS, MIN_RSA_BITS, PRIVATE_JWK_MEMBERS, SYSTEM_SCOPE_CHOICES,
  jwksSummary, rsaModulusBits, validatePublicJwks,
} from '../smart-registration';

const CP = resolve(__dirname, '../../../../loom-health-cp/src/auth');
const SERVER = readFileSync(resolve(CP, 'server.ts'), 'utf8');
const GUARD = readFileSync(resolve(CP, 'jwks-guard.ts'), 'utf8');
const ROLE_MAP = JSON.parse(readFileSync(resolve(CP, 'role-scope-map.v1.json'), 'utf8')) as {
  roles: Array<{ id: string; displayName: string; ceiling: { client_credentials: string[] } }>;
};

const rsa = (bits = 2048) => generateKeyPairSync('rsa', { modulusLength: bits });
const ec = (namedCurve = 'P-384') => generateKeyPairSync('ec', { namedCurve });
const pub = (kp: ReturnType<typeof rsa> | ReturnType<typeof ec>, extra: Record<string, unknown>) =>
  ({ ...(kp.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), ...extra });
const RSA_KP = rsa();
const EC_KP = ec();
const RSA_PUB = pub(RSA_KP, { kid: 'rsa-1', alg: 'RS384', use: 'sig' });
const EC_PUB = pub(EC_KP, { kid: 'ec-1', alg: 'ES384' });

describe('mirrors of the CP (lifted from CP source at test time)', () => {
  it('PRIVATE_JWK_MEMBERS covers every member the CP refuses', () => {
    const m = /const PRIVATE_JWK_MEMBERS = \[([^\]]+)\]/.exec(SERVER);
    expect(m, 'PRIVATE_JWK_MEMBERS not found in loom-health-cp server.ts - it moved').toBeTruthy();
    const cpList = [...(m![1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(cpList.length).toBeGreaterThanOrEqual(7); // the probe found the list, not an empty match
    // Breaks if the console drops one the CP refuses (e.g. removes 'k'): the console would forward a key the CP 400s.
    for (const x of cpList) expect([x, PRIVATE_JWK_MEMBERS.includes(x as string)]).toEqual([x, true]);
  });
  it('ALLOWED_JWK_ALGS is the CP token_endpoint_auth_signing_alg_values_supported', () => {
    const m = /token_endpoint_auth_signing_alg_values_supported: \[([^\]]+)\]/.exec(SERVER);
    expect(m).toBeTruthy();
    // Breaks if either side gains or loses an alg (e.g. RS256 added to the console only).
    expect([...ALLOWED_JWK_ALGS]).toEqual([...(m![1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1]));
  });
  it('MIN_RSA_BITS is the CP jwks-guard value', () => {
    const m = /export const MIN_RSA_BITS = (\d+)/.exec(GUARD);
    expect(Number(m?.[1])).toBe(MIN_RSA_BITS); // breaks if either moves off 2048 alone
  });
  it('BACKEND_ROLE_CHOICES is exactly the CP roles with a non-empty client_credentials ceiling, with CP names', () => {
    const expected = ROLE_MAP.roles.filter((r) => r.ceiling.client_credentials.length > 0).map((r) => ({ id: r.id, label: r.displayName }));
    expect(expected.length).toBeGreaterThan(0);
    // Breaks if a role is added to / removed from the CP map with a system ceiling and the console list is not updated.
    expect(BACKEND_ROLE_CHOICES.map((r) => ({ ...r }))).toEqual(expected);
  });
  it('every offered system scope is inside some backend role ceiling', () => {
    const ceilings = new Set(ROLE_MAP.roles.flatMap((r) => r.ceiling.client_credentials));
    // Breaks if a scope no role can ever grant (e.g. system/*.d) is offered: it would register and grant nothing.
    for (const c of SYSTEM_SCOPE_CHOICES) expect([c.scope, ceilings.has(c.scope)]).toEqual([c.scope, true]);
  });
});

describe('validatePublicJwks', () => {
  it('accepts public RSA 2048 and EC P-384 keys and returns a NEW object with the same content', () => {
    const input = { keys: [RSA_PUB, EC_PUB] };
    const r = validatePublicJwks(input);
    // Same content (breaks if an allowlisted member is dropped) but never the input object
    // (breaks if the validator returns the parsed input, which is what forwarded unknown members to the CP).
    expect(r).toEqual({ jwks: input });
    expect('jwks' in r && r.jwks).not.toBe(input);
    // DISCLOSED, NOT COUNTED: a mutant that rebuilds each key as a plain `{...k}` spread is EQUIVALENT here, because
    // the allowlist has already refused any member a spread would carry. This line only pins object identity.
    expect('jwks' in r && r.jwks.keys[0]).not.toBe(RSA_PUB);
    expect(validatePublicJwks(JSON.stringify(input))).toEqual({ jwks: input });
  });

  it('refuses every private member, naming it (LITERAL list, not the list under test)', () => {
    const priv = RSA_KP.privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
    // A real private RSA JWK carries d, p, q, dp, dq, qi; breaks if the private-member check is removed.
    expect(validatePublicJwks({ keys: [{ ...priv, kid: 'k1' }] })).toEqual({ error: expect.stringMatching(/private key material \(d, p, q, dp, dq, qi\)/) });
    // A literal list: dropping any member (e.g. 'oth') from PRIVATE_JWK_MEMBERS turns its row red, because the key is
    // then refused by the allowlist with a different message (not "private key material (oth)").
    for (const m of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth']) {
      expect([m, validatePublicJwks({ keys: [{ ...RSA_PUB, [m]: 'AQAB' }] })]).toEqual([m, { error: expect.stringContaining(`private key material (${m})`) }]);
    }
    expect(PRIVATE_JWK_MEMBERS).toEqual(['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth']);
  });

  it('refuses the review probes (#5517) on an otherwise valid EC P-384 public key, by the ALLOWLIST', () => {
    // Built with JSON.parse: an object literal would set the prototype instead of an own "__proto__" member.
    const probes: Array<[string, string]> = [
      ['__proto__', '{"__proto__":{"d":"AQAB"}}'],
      ['D', '{"D":"AQAB"}'],
      ['constructor', '{"constructor":{"d":"AQAB"}}'],
      ['note', '{"note":"anything"}'],
    ];
    for (const [member, extra] of probes) {
      const key = { ...EC_PUB, ...JSON.parse(extra) };
      // Each was ACCEPTED and forwarded by the denylist this replaces (`m in k` misses all four).
      for (const input of [{ keys: [key] }, `{"keys":[${JSON.stringify(EC_PUB).slice(0, -1)},${extra.slice(1)}]}`]) {
        expect([member, validatePublicJwks(input)]).toEqual([member, { error: expect.stringContaining(`member ${JSON.stringify(member)} is not allowed`) }]);
      }
    }
    // Cross-type members are not allowed either: an RSA member on an EC key.
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, n: RSA_PUB.n }] })).toEqual({ error: expect.stringContaining('member "n" is not allowed') });
  });

  it('refuses key_ops other than ["verify"] and use other than sig', () => {
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, key_ops: ['sign'] }] })).toEqual({ error: expect.stringMatching(/key_ops/) });
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, key_ops: ['verify', 'sign'] }] })).toEqual({ error: expect.stringMatching(/key_ops/) });
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, use: 'enc' }] })).toEqual({ error: expect.stringMatching(/use must be sig/) });
    // Paired permit: key_ops verify is kept in the rebuild.
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, key_ops: ['verify'] }] })).toMatchObject({ jwks: { keys: [{ key_ops: ['verify'] }] } });
  });

  it('x5c-only keys are refused: RSA without n, EC without x / y', () => {
    const cert = selfSignedCertB64(EC_KP.publicKey, EC_KP.privateKey);
    const { n: _n, ...rsaNoN } = RSA_PUB;
    // Breaks if a key may stand on its x5c alone (the CP verifies with n/e or x/y, not the certificate).
    expect(validatePublicJwks({ keys: [{ ...rsaNoN, x5c: [selfSignedCertB64(RSA_KP.publicKey, RSA_KP.privateKey)] }] })).toEqual({ error: expect.stringMatching(/at least 2048 bits/) });
    const { x: _x, y: _y, ...ecNoXY } = EC_PUB;
    expect(validatePublicJwks({ keys: [{ ...ecNoXY, x5c: [cert] }] })).toEqual({ error: expect.stringMatching(/needs x and y/) });
    const { y: _y2, ...ecNoY } = EC_PUB;
    expect(validatePublicJwks({ keys: [{ ...ecNoY, x5c: [cert] }] })).toEqual({ error: expect.stringMatching(/needs x and y/) });
  });

  it('refuses a missing kid, a duplicate kid, a non-RSA/EC kty, and an alg outside RS384/ES384', () => {
    const { kid: _k, ...noKid } = RSA_PUB;
    expect(validatePublicJwks({ keys: [noKid] })).toEqual({ error: expect.stringMatching(/kid is required/) });
    expect(validatePublicJwks({ keys: [RSA_PUB, { ...EC_PUB, kid: 'rsa-1' }] })).toEqual({ error: expect.stringMatching(/used twice/) });
    expect(validatePublicJwks({ keys: [{ kty: 'oct', kid: 'x' }] })).toEqual({ error: expect.stringMatching(/kty must be RSA or EC/) });
    expect(validatePublicJwks({ keys: [{ ...RSA_PUB, alg: 'RS256' }] })).toEqual({ error: expect.stringMatching(/alg must be RS384 or ES384/) });
    // No alg at all is allowed (the CP picks by kid); breaks if alg becomes mandatory.
    const { alg: _a, ...noAlg } = RSA_PUB;
    expect(validatePublicJwks({ keys: [noAlg] })).toMatchObject({ jwks: { keys: [noAlg] } });
  });

  it('refuses an RSA key under 2048 bits and an EC key off P-384', () => {
    const small = pub(rsa(1024), { kid: 's' });
    expect(rsaModulusBits(small.n)).toBe(1024); // the fixture really is 1024 bits
    expect(rsaModulusBits(RSA_PUB.n)).toBe(2048);
    expect(validatePublicJwks({ keys: [small] })).toEqual({ error: expect.stringMatching(/at least 2048 bits/) });
    expect(validatePublicJwks({ keys: [pub(ec('P-256'), { kid: 'p256' })] })).toEqual({ error: expect.stringMatching(/crv P-384/) });
  });

  it('caps key count and serialized size', () => {
    const many = Array.from({ length: JWKS_LIMITS.maxKeys + 1 }, (_, i) => ({ ...EC_PUB, kid: `ec-${i}` }));
    expect(validatePublicJwks({ keys: many })).toEqual({ error: `jwks: at most ${JWKS_LIMITS.maxKeys} keys` });
    expect(validatePublicJwks({ keys: many.slice(0, JWKS_LIMITS.maxKeys) })).toMatchObject({ jwks: {} }); // 10 is fine
    // One valid key padded past 16 KB with an inert member: ONLY the size cap can refuse it.
    const big = { keys: [{ ...EC_PUB, x5u_note: 'a'.repeat(JWKS_LIMITS.maxBytes) }] };
    expect(validatePublicJwks(big)).toEqual({ error: 'jwks: larger than 16 KB' });
    expect(validatePublicJwks(JSON.stringify(big))).toEqual({ error: 'jwks: larger than 16 KB' });
  });

  it('refuses non-JSON, a bare array, no keys, and extra top-level members', () => {
    expect(validatePublicJwks('{not json')).toEqual({ error: 'jwks: not valid JSON' });
    expect(validatePublicJwks([RSA_PUB])).toEqual({ error: expect.stringMatching(/JSON object/) });
    expect(validatePublicJwks({ keys: [] })).toEqual({ error: expect.stringMatching(/non-empty/) });
    expect(validatePublicJwks({ keys: [RSA_PUB], d: 'x' })).toEqual({ error: expect.stringMatching(/only "keys"/) });
  });
});

describe('normalizePublicJwks (BFF only, node:crypto)', () => {
  const checked = (key: Record<string, unknown>) => {
    const v = validatePublicJwks({ keys: [key] });
    if ('error' in v) return v;
    return normalizePublicJwks(v.jwks);
  };
  it('accepts an x5c whose first certificate carries the JWK key, with a matching x5t#S256', () => {
    const cert = selfSignedCertB64(EC_KP.publicKey, EC_KP.privateKey);
    const der = Buffer.from(cert, 'base64');
    const s256 = createHash('sha256').update(der).digest('base64url');
    // Positive control: the builder makes a certificate node:crypto parses, so the refusals below are not vacuous.
    expect(checked({ ...EC_PUB, x5c: [cert], 'x5t#S256': s256 })).toMatchObject({ jwks: {} });
    expect(checked({ ...RSA_PUB, x5c: [selfSignedCertB64(RSA_KP.publicKey, RSA_KP.privateKey)] })).toMatchObject({ jwks: {} });
    // A chain: the second entry must parse but carries another key.
    expect(checked({ ...EC_PUB, x5c: [cert, selfSignedCertB64(RSA_KP.publicKey, RSA_KP.privateKey)] })).toMatchObject({ jwks: {} });
  });
  it('refuses a PKCS#8 private-key DER prefix smuggled in x5c (the review probe)', () => {
    // Structurally valid base64, so the browser-safe validator passes it; only the certificate parse refuses it.
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, x5c: ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'] }] })).toMatchObject({ jwks: {} });
    expect(checked({ ...EC_PUB, x5c: ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'] })).toEqual({ error: expect.stringMatching(/entry 1 is not an X\.509 certificate/) });
    // A good first certificate does not cover a bad later entry.
    expect(checked({ ...EC_PUB, x5c: [selfSignedCertB64(EC_KP.publicKey, EC_KP.privateKey), 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'] })).toEqual({ error: expect.stringMatching(/entry 2/) });
  });
  it('refuses an x5c whose first certificate is for a different key, and a wrong thumbprint', () => {
    const other = ec();
    // Breaks if the key match is dropped: the certificate parses fine, it is just someone else's key.
    expect(checked({ ...EC_PUB, x5c: [selfSignedCertB64(other.publicKey, other.privateKey)] })).toEqual({ error: expect.stringMatching(/not this JWK's key/) });
    expect(checked({ ...RSA_PUB, x5c: [selfSignedCertB64(EC_KP.publicKey, EC_KP.privateKey)] })).toEqual({ error: expect.stringMatching(/not this JWK's key/) });
    const cert = selfSignedCertB64(EC_KP.publicKey, EC_KP.privateKey);
    // Breaks if the x5t#S256 comparison is dropped (a 43-char value of the right shape but the wrong hash).
    expect(checked({ ...EC_PUB, x5c: [cert], 'x5t#S256': 'A'.repeat(43) })).toEqual({ error: expect.stringMatching(/x5t#S256 does not match/) });
    expect(checked({ ...EC_PUB, 'x5t#S256': 'A'.repeat(43) })).toEqual({ error: expect.stringMatching(/needs the x5c/) });
  });

  it('refuses the SHA-1 x5t with a true message, even alongside a valid x5c (CodeQL js/weak-cryptographic-algorithm)', () => {
    const cert = selfSignedCertB64(EC_KP.publicKey, EC_KP.privateKey);
    // Any 27-char base64url value: x5t is refused for being SHA-1, not for its value, so no SHA-1 is computed here.
    // Breaks if x5t is accepted again (allowlisted and passed through, or recomputed).
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, x5c: [cert], x5t: 'A'.repeat(27) }] }))
      .toEqual({ error: 'jwks: key 1: x5t (SHA-1) is not accepted; use x5t#S256 or omit it' });
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, x5t: 'A'.repeat(27) }] })).toEqual({ error: expect.stringContaining('x5t (SHA-1) is not accepted') });
  });

  it('refuses a valid certificate with a PKCS#8 PRIVATE key appended (review of 68d573903), as first or chain entry', () => {
    const cert = Buffer.from(selfSignedCertB64(EC_KP.publicKey, EC_KP.privateKey), 'base64');
    const pkcs8 = EC_KP.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
    const smuggled = Buffer.concat([cert, pkcs8]);
    // The fixture is what it claims: node:crypto parses it as the certificate and ignores the tail.
    expect(Buffer.from(new X509Certificate(smuggled).raw).equals(cert)).toBe(true);
    const s256 = createHash('sha256').update(smuggled).digest('base64url');
    // Breaks if der.equals(cert.raw) is dropped: the entry parses, its key matches, and the tail would be forwarded.
    expect(checked({ ...EC_PUB, x5c: [smuggled.toString('base64')] })).toEqual({ error: expect.stringMatching(/entry 1 carries bytes beyond the certificate/) });
    // A thumbprint over the padded bytes does not make the padding acceptable.
    expect(checked({ ...EC_PUB, x5c: [smuggled.toString('base64')], 'x5t#S256': s256 })).toEqual({ error: expect.stringMatching(/beyond the certificate/) });
    expect(checked({ ...EC_PUB, x5c: [cert.toString('base64'), smuggled.toString('base64')] })).toEqual({ error: expect.stringMatching(/entry 2 carries bytes/) });
  });

  it('forwards only re-derived data: key params from createPublicKey, x5c from cert.raw, thumbprints recomputed', () => {
    const certB64 = selfSignedCertB64(EC_KP.publicKey, EC_KP.privateKey);
    const der = Buffer.from(certB64, 'base64');
    const r = checked({ ...EC_PUB, use: 'sig', key_ops: ['verify'], x5c: [certB64], 'x5t#S256': createHash('sha256').update(der).digest('base64url') });
    const derived = EC_KP.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    // Exactly these members and values; breaks if any caller member or value other than the allowlisted metadata
    // survives, or if x5c / the thumbprint are copied rather than recomputed.
    expect(r).toEqual({ jwks: { keys: [{
      kty: 'EC', kid: 'ec-1', alg: 'ES384', use: 'sig', key_ops: ['verify'], crv: 'P-384', x: derived.x, y: derived.y,
      x5c: [der.toString('base64')], 'x5t#S256': createHash('sha256').update(der).digest('base64url'),
    }] } });
  });

  it('refuses an EC point that is not on P-384 (createPublicKey re-derivation)', () => {
    // Right lengths (48 bytes each), so ONLY the curve check can refuse it.
    const offCurve = { ...EC_PUB, x: Buffer.alloc(48, 1).toString('base64url'), y: Buffer.alloc(48, 2).toString('base64url') };
    expect(validatePublicJwks({ keys: [offCurve] })).toMatchObject({ jwks: {} });
    expect(checked(offCurve)).toEqual({ error: expect.stringMatching(/not a valid EC public key/) }); // breaks if createPublicKey is skipped
  });
});

describe('key parameters cannot carry arbitrary bytes (review of 68d573903)', () => {
  it('EC x and y must be exactly 48 bytes', () => {
    const priv = EC_KP.privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
    expect(Buffer.from(String(priv.d), 'base64url').length).toBe(48); // the scalar d IS 48 bytes: only the curve check catches x=d
    const pkcs8 = (EC_KP.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64url');
    // Breaks if the 48-byte rule is dropped: a PKCS#8 DER in y is structurally base64url.
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, y: pkcs8 }] })).toEqual({ error: expect.stringMatching(/must each be 48 bytes/) });
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, x: Buffer.alloc(47, 1).toString('base64url') }] })).toEqual({ error: expect.stringMatching(/48 bytes/) });
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, x: Buffer.alloc(49, 1).toString('base64url') }] })).toEqual({ error: expect.stringMatching(/48 bytes/) });
  });
  it('RSA e is at most 4 bytes and n at most 8192 bits (MIN_RSA_BITS kept)', () => {
    expect(validatePublicJwks({ keys: [{ ...RSA_PUB, e: Buffer.alloc(5, 1).toString('base64url') }] })).toEqual({ error: expect.stringMatching(/e is at most 4 bytes/) });
    expect(validatePublicJwks({ keys: [{ ...RSA_PUB, e: Buffer.alloc(4, 1).toString('base64url') }] })).toMatchObject({ jwks: {} }); // 4 is fine
    const big = Buffer.alloc(1025, 0xff).toString('base64url'); // 8200 bits
    expect(rsaModulusBits(big)).toBe(8200);
    expect(validatePublicJwks({ keys: [{ ...RSA_PUB, n: big }] })).toEqual({ error: expect.stringMatching(/at most 8192 bits/) });
  });
  it('key_ops must be exactly ["verify"]', () => {
    // Breaks if the length-1 rule is relaxed to "every element is verify".
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, key_ops: ['verify', 'verify'] }] })).toEqual({ error: expect.stringMatching(/key_ops/) });
  });
  it('a member whose name STARTS with an allowed name is still refused', () => {
    // Breaks under a prefix allowlist (`allowed.some((a) => m.startsWith(a))`): nd ~ n, xd ~ x, x5c_priv ~ x5c.
    expect(validatePublicJwks({ keys: [{ ...RSA_PUB, nd: 'AQAB' }] })).toEqual({ error: expect.stringContaining('member "nd" is not allowed') });
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, xd: 'AQAB' }] })).toEqual({ error: expect.stringContaining('member "xd" is not allowed') });
    expect(validatePublicJwks({ keys: [{ ...EC_PUB, x5c_priv: 'AQAB' }] })).toEqual({ error: expect.stringContaining('member "x5c_priv" is not allowed') });
  });
});

describe('jwksSummary', () => {
  it('is the count and kids only, never a modulus or coordinate', () => {
    const s = jwksSummary({ keys: [RSA_PUB, EC_PUB] });
    expect(s).toEqual({ keyCount: 2, kids: ['rsa-1', 'ec-1'] });
    // Breaks if the summary passes the keys through.
    expect(JSON.stringify(s)).not.toContain(String(RSA_PUB.n).slice(0, 40));
    expect(jwksSummary(undefined)).toEqual({ keyCount: 0, kids: [] });
  });
});
