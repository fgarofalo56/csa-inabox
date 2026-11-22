// Fixtures for bundle signing tests: an unsigned `opa build`-shaped archive, and a signer backed by a local P-256 key
// (the Key Vault stand-in; the real signer is exercised against a fake fetch in bundle-sign.test.ts).
import { createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { JWK } from 'jose';
import type { BundleSigner } from '../src/pdp/bundle-sign.js';
import { readTar, writeTar } from '../src/pdp/tar.js';

/** An unsigned bundle whose content depends on `label`, so two labels never share bytes. */
export function unsignedBundle(label = 'x'): Buffer {
  return gzipSync(
    writeTar([
      { name: '/data.json', data: Buffer.from(`${JSON.stringify({ lhds: { label, n: 1 } })}\n`) },
      { name: '/policy.rego', data: Buffer.from(`package lhds.t\n\nlabel := "${label}"\n`) },
      { name: '/.manifest', data: Buffer.from('{"revision":"r1","roots":[""],"rego_version":1}\n') },
    ]),
  );
}

/**
 * An unsigned bundle whose single module has an entry name of EXACTLY `nameBytes` bytes once a reader joins the USTAR prefix and
 * name fields (an archive another tool wrote: writeTar itself refuses names over 100 bytes).
 */
export function bundleWithNameBytes(nameBytes: number): Buffer {
  const t = writeTar([{ name: '/a.rego', data: Buffer.from('package a\n') }]);
  const prefix = 'p'.repeat(nameBytes - 1 - 'a.rego'.length); // name = prefix + '/' + 'a.rego'
  t.fill(0, 0, 100);
  t.write('a.rego', 0, 'ascii');
  t.write(prefix, 345, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (t[i] as number);
  t.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return gzipSync(t);
}

export interface LocalBundleSigner extends BundleSigner {
  calls: number;
  /** true when `sig` verifies over `input` with this signer's public key. */
  verifies(input: Buffer, sig: Buffer): boolean;
  publicPem(): string;
}

export function localBundleSigner(): LocalBundleSigner {
  const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = kp.publicKey.export({ format: 'jwk' }) as JWK;
  const s: LocalBundleSigner = {
    alg: 'ES256',
    calls: 0,
    sign: async (input) => {
      s.calls++;
      return nodeSign('sha256', input, { key: kp.privateKey, dsaEncoding: 'ieee-p1363' });
    },
    publicJwk: async () => jwk,
    verifies: (input, sig) => nodeVerify('sha256', input, { key: createPublicKey(kp.publicKey.export({ format: 'pem', type: 'spki' })), dsaEncoding: 'ieee-p1363' }, sig),
    publicPem: () => kp.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
  return s;
}

/** The entries of a gzip tar, by name without a leading slash. */
export function entriesOf(tgz: Buffer): Map<string, Buffer> {
  return new Map(readTar(gunzipSync(tgz)).map((e) => [e.name.replace(/^\/+/, ''), e.data]));
}
