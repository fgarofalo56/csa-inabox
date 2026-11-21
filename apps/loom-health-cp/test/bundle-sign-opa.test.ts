// The ground truth for bundle signing: a REAL OPA verifies what the control plane signs.
//
// Needs an `opa` binary (v1.9.0, the version the stamp PDP runs): OPA=<path> npx vitest run test/bundle-sign-opa.test.ts
// Without it every test here is SKIPPED, and the skip names itself: signing correctness is then established only by
// the hash vectors in bundle-sign.test.ts, which are lifted from OPA's source, not by an OPA run.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createPublicKey, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { JWK } from 'jose';
import { afterAll, describe, expect, it } from 'vitest';
import { readTar, writeTar } from '../src/pdp/tar.js';
import { signBundle, type BundleSigner } from '../src/pdp/bundle-sign.js';

const OPA = process.env.OPA ?? '';
const d = describe.skipIf(!OPA);
const dir = mkdtempSync(join(tmpdir(), 'lhds-opa-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = kp.publicKey.export({ format: 'jwk' }) as JWK;
const signer: BundleSigner = {
  alg: 'ES256',
  sign: async (i) => nodeSign('sha256', i, { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }),
  publicJwk: async () => jwk,
};
const pubFile = join(dir, 'verify-key');
writeFileSync(pubFile, createPublicKey(kp.publicKey.export({ format: 'pem', type: 'spki' })).export({ type: 'spki', format: 'pem' }));

const rego = 'package lhds.t\n\nallow := true if input.x == "<&>"\n';
// Strings OPA's hasher and JS disagree about unless the canonical walk is right: HTML characters, U+2028, control chars, an astral
// character, and keys whose UTF-8 byte order differs from UTF-16 order (U+FF5E sorts before U+1F600 in UTF-16, after it in UTF-8).
const data = { z: 1, a: ['<>&', '\u2028', '\b\f\u0001', '\u{1F600}', { '～': 1, '\u{1F600}': 2 }], b: { c: true, d: null, e: -7 } };

function unsignedBundle(): string {
  const src = join(dir, 'src');
  execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(src)},{recursive:true})`]);
  writeFileSync(join(src, 'policy.rego'), rego);
  writeFileSync(join(src, 'data.json'), JSON.stringify(data));
  const out = join(dir, 'unsigned.tar.gz');
  execFileSync(OPA, ['build', '-b', '.', '-o', out, '--revision', 'r1'], { cwd: src });
  return out;
}

// `opa build -b <signed bundle> --verification-key` verifies every signature before it rebuilds (same gate as tools/build-bundle.sh).
const verify = (file: string, key: string): string => {
  try {
    return execFileSync(OPA, ['build', '-b', file, '-o', join(dir, 'verified.tar.gz'), '--verification-key', key, '--verification-key-id', 'global', '--signing-alg', 'ES256'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    throw new Error(`opa refused the bundle: ${String((e as { stderr?: string; stdout?: string; status?: number }).stdout) + String((e as { stderr?: string }).stderr) + String((e as { status?: number }).status)}`);
  }
};

d('the control-plane signature is accepted by a real OPA (v1.9.0)', () => {
  it('an opa-built unsigned bundle, signed by signBundle, verifies; a tampered module does not (positive control + break value)', async () => {
    const unsigned = readFileSync(unsignedBundle());
    const signed = await signBundle(unsigned, signer);
    const f = join(dir, 'signed.tar.gz');
    writeFileSync(f, signed);
    // Breaks if any file hash, the key id or the JWT shape differs from what OPA computes: OPA then refuses the bundle.
    expect(() => verify(f, pubFile)).not.toThrow();
    // Tamper: change the module bytes but keep the signature. OPA must reject, proving the verification above could fail.
    const entries = readTar(gunzipSync(signed));
    const tampered = writeTar(entries.map((e) => (e.name.endsWith('.rego') ? { ...e, data: Buffer.from(e.data.toString().replace('"<&>"', '"x"')) } : e)));
    const t = join(dir, 'tampered.tar.gz');
    writeFileSync(t, (await import('node:zlib')).gzipSync(tampered));
    expect(() => verify(t, pubFile)).toThrow();
  });

  it('a different key id or a different public key is refused (the bundle is bound to the key it was signed with)', async () => {
    const signed = await signBundle(readFileSync(unsignedBundle()), signer);
    const f = join(dir, 'signed2.tar.gz');
    writeFileSync(f, signed);
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const otherFile = join(dir, 'other-key');
    writeFileSync(otherFile, other.publicKey.export({ format: 'pem', type: 'spki' }));
    expect(() => verify(f, otherFile)).toThrow();
  });
});

describe('opa-backed signing check', () => {
  it.skipIf(!!OPA)('SKIPPED: set OPA=<path to opa v1.9.0> to run the real-OPA verification above', () => {
    expect(OPA).toBe('');
  });
});
