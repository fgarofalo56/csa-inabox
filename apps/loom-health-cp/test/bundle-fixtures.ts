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
