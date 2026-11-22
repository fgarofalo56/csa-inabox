import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { KeyVaultBundleSigner } from '../src/auth/signer.js';
import { BundleSignError, bundleFileHashes, canonicalJson, signBundle, verificationKeyPem } from '../src/pdp/bundle-sign.js';
import { readTar, TarError, writeTar } from '../src/pdp/tar.js';
import { bundleWithNameBytes, entriesOf, localBundleSigner, unsignedBundle } from './bundle-fixtures.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// VECTOR from a REAL OPA v1.9.0: `opa build --signing-key <k> --signing-alg ES256` over these three members produced these
// claims (temp run 2026-11-21). The members are what the archive holds; the hashes are OPA's, not ours.
const OPA_MEMBERS = {
  '/data.json': Buffer.from('{"a":["\\u003c\\u003e\\u0026","\\u2028","\\b\\f\\u0001","😀",{"～":1,"😀":2}],"b":{"c":true,"d":null,"e":-7},"z":1}\n'),
  '/policy.rego': Buffer.from('package lhds.t\n\nallow if input.x == "<&>"\n'),
  '/.manifest': Buffer.from('{"revision":"r1","roots":[""],"rego_version":1}\n'),
};
const OPA_CLAIMS = {
  'policy.rego': '68dc8ddf5a0db601710bd201994756bb00210eb2e1310a175bd3787f09bcd686',
  'data.json': '29345cf13dec70dff111b3fce6ed1cfa851cdcb4721a28f6f64965d1eae067da',
  '.manifest': 'ac782d63ed62993941fa1bac30548a970424c2993c7ba7e4acbc65d5a419964f',
};
const opaEntries = Object.entries(OPA_MEMBERS).map(([name, data]) => ({ name, data }));

describe('file hashes equal what a real OPA computes', () => {
  it('data.json, .manifest and the module hash to OPA\'s own values (breaks on key order, escaping, or hashing raw bytes)', () => {
    const got = Object.fromEntries(bundleFileHashes(opaEntries).map((f) => [f.name, f.hash]));
    // Breaks if data.json is hashed as raw bytes (it ends in "\n" and carries < escapes: raw hash differs), if keys are
    // sorted by UTF-16 code unit (U+1F600 would sort before U+FF5E; OPA sorts by UTF-8 bytes), or if the manifest is hashed raw.
    expect(got).toEqual(OPA_CLAIMS);
    expect(bundleFileHashes(opaEntries).every((f) => f.algorithm === 'SHA-256')).toBe(true);
    // The naive hash is demonstrably different, so the equality above is not a tautology.
    expect(sha(OPA_MEMBERS['/data.json'])).not.toBe(OPA_CLAIMS['data.json']);
  });

  it('canonicalJson: Go escaping with HTML escaping off, U+2028 escaped, keys sorted by UTF-8 bytes', () => {
    expect(canonicalJson({ b: '<>&', a: '\u2028' })).toBe('{"a":"\\u2028","b":"<>&"}');
    expect(canonicalJson({ '😀': 1, '～': 2 })).toBe('{"～":2,"😀":1}');
    expect(() => canonicalJson({ n: 1.5 })).toThrow(BundleSignError); // a non-integer cannot be proven byte-exact
  });
});

describe('signBundle', () => {
  it('adds a verifiable ES256 .signatures.json over exactly the original entries, which stay byte-identical', async () => {
    const signer = localBundleSigner();
    const src = unsignedBundle('a');
    const out = await signBundle(src, signer);
    const before = entriesOf(src);
    const after = entriesOf(out);
    expect([...after.keys()].sort()).toEqual([...before.keys(), '.signatures.json'].sort());
    for (const [n, d] of before) expect(after.get(n)?.equals(d), n).toBe(true); // nothing the signature covers was altered
    const jwt = JSON.parse((after.get('.signatures.json') as Buffer).toString()).signatures as string[];
    expect(jwt).toHaveLength(1);
    const [h, p, s] = (jwt[0] as string).split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'global', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.keyid).toBe('global');
    expect(Object.fromEntries(claims.files.map((f: { name: string; hash: string }) => [f.name, f.hash]))).toEqual(
      Object.fromEntries(bundleFileHashes([...before].map(([name, data]) => ({ name, data }))).map((f) => [f.name, f.hash])),
    );
    // Breaks if the signature is over anything but "<header>.<payload>" or is not raw R||S of 64 bytes.
    expect(Buffer.from(s, 'base64url')).toHaveLength(64);
    expect(signer.verifies(Buffer.from(`${h}.${p}`), Buffer.from(s, 'base64url'))).toBe(true);
    expect(signer.calls).toBe(1);
  });

  it.each([
    ['already signed (a pipeline-signed bundle must not be re-signed silently)', () => gzipSync(writeTar([...readTar(gunzipSync(unsignedBundle())), { name: '/.signatures.json', data: Buffer.from('{}') }])), /already contains .signatures.json/],
    ['a file type OPA signing here cannot cover', () => gzipSync(writeTar([{ name: '/plan.json', data: Buffer.from('{}') }])), /unsupported file/],
    ['a path-traversal name', () => gzipSync(writeTar([{ name: '/a/../b.rego', data: Buffer.from('package a') }])), /\.\./],
    ['the same name twice', () => gzipSync(writeTar([{ name: '/a.rego', data: Buffer.from('package a') }, { name: 'a.rego', data: Buffer.from('package a') }])), /twice/],
    ['data.json that is not an object', () => gzipSync(writeTar([{ name: '/data.json', data: Buffer.from('[1]') }])), /JSON object/],
    ['data.json holding a float', () => gzipSync(writeTar([{ name: '/data.json', data: Buffer.from('{"a":1.5}') }])), /non-integer/],
    ['an empty archive', () => gzipSync(writeTar([])), /empty/],
    ['bytes that are not a tarball', () => gzipSync(Buffer.from('not a tar at all, just text'.repeat(40))), /tar/],
  ])('rejects %s with a BundleSignError and never calls the vault', async (_n, make, msg) => {
    const signer = localBundleSigner();
    await expect(signBundle(make(), signer)).rejects.toThrow(BundleSignError);
    await expect(signBundle(make(), signer)).rejects.toThrow(msg);
    expect(signer.calls).toBe(0); // a rejected archive costs no Key Vault operation
  });

  it('an entry name of 101 bytes is a BundleSignError that says so (never a vault failure) and costs no vault call; 100 bytes signs', async () => {
    const signer = localBundleSigner();
    // Breaks if the over-long name reaches writeTar after the vault was already called (a TarError would then surface as a
    // "could not sign" fault) or if the limit moves: 101 must be refused, 100 must still sign.
    const e = await signBundle(bundleWithNameBytes(101), signer).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BundleSignError);
    expect((e as Error).message).toMatch(/101 bytes/);
    expect((e as Error).message).not.toMatch(/key vault/i);
    expect(signer.calls).toBe(0);
    await expect(signBundle(bundleWithNameBytes(100), signer)).resolves.toBeInstanceOf(Buffer);
    expect(signer.calls).toBe(1);
  });

  it('a decompression bomb is refused before unpacking past the cap', async () => {
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024));
    await expect(signBundle(bomb, localBundleSigner())).rejects.toThrow(BundleSignError);
  });

  it('a vault that returns a signature which does not verify is NOT stored: a plain Error (502 upstream), not a signed archive', async () => {
    const signer = localBundleSigner();
    const liar = { ...signer, sign: async () => Buffer.alloc(64, 7) };
    const e = await signBundle(unsignedBundle(), liar).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(BundleSignError); // the publisher did nothing wrong
  });

  it('tar reader refuses a symlink entry instead of skipping it (a signature must cover every byte OPA reads)', () => {
    const t = writeTar([{ name: '/a.rego', data: Buffer.from('x') }]);
    t[156] = '2'.charCodeAt(0); // symlink typeflag...
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (t[i] as number);
    t.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii'); // ...with a valid checksum, so only the type check can refuse it
    expect(() => readTar(t)).toThrow(TarError);
    expect(() => readTar(t)).toThrow(/unsupported tar entry type/);
  });
});

describe('KeyVaultBundleSigner (ES256 on a P-256 key)', () => {
  const keyId = `https://v.vault.azure.net/keys/lhds-pdp-bundle-sign/${'a'.repeat(32)}`;
  const mk = (key: Record<string, unknown>, sigLen = 64) => {
    const calls: Array<{ url: string; body?: { alg: string; value: string } }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const body = String(url).includes('/sign') ? { value: Buffer.alloc(sigLen, 1).toString('base64url') } : { key };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { s: new KeyVaultBundleSigner({ cloud: 'commercial', keyId, getToken: async () => 't', fetchImpl }), calls };
  };
  const good = { kty: 'EC-HSM', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };

  it('signs a SHA-256 digest with alg ES256 and returns 64 bytes; an HSM key (kty EC-HSM) and a software key (EC) are both accepted', async () => {
    const { s, calls } = mk(good);
    expect((await s.sign(Buffer.from('input'))).length).toBe(64);
    // Breaks if the digest is sha384 or the alg is ES384 (the token signer's values).
    expect(calls[0]?.body?.alg).toBe('ES256');
    expect(calls[0]?.body?.value).toBe(createHash('sha256').update('input').digest().toString('base64url'));
    expect((await mk({ ...good, kty: 'EC' }).s.publicJwk()).kty).toBe('EC');
    expect((await s.publicJwk()).kty).toBe('EC'); // published as the standard EC, not EC-HSM
    expect((await verificationKeyPem(s)).startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
  });

  it('rejects a wrong key type, a P-384 key and a 96-byte signature (the token signer\'s shape)', async () => {
    await expect(mk({ ...good, kty: 'RSA' }).s.publicJwk()).rejects.toThrow(/EC P-256/);
    await expect(mk({ ...good, crv: 'P-384' }).s.publicJwk()).rejects.toThrow(/EC P-256/);
    await expect(mk(good, 96).s.sign(Buffer.from('x'))).rejects.toThrow(/malformed ES256/);
  });
});
