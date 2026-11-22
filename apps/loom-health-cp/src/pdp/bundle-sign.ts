// Signs a PDP policy bundle with the stamp's Key Vault key (ES256), so the private key never leaves
// Key Vault and no pipeline or GitHub secret ever holds it (#5422, operator decision 6).
//
// WHAT OPA VERIFIES. A signed bundle carries `.signatures.json` = {"signatures":[<JWT>]}. The JWT payload is
//   {"files":[{"name","hash","algorithm":"SHA-256"}...],"keyid":"<id>"}
// and OPA recomputes each file's hash from the archive. The hashing rules are OPA's (v1/bundle/hash.go and
// bundle.go GenerateSignature, read at v1.9.0): a module is hashed over its raw bytes; data.json and .manifest
// are PARSED and hashed through a canonical walk (keys sorted bytewise, compact, Go string escaping with HTML
// escaping off, numbers verbatim). This file reimplements exactly that, and is checked against a real OPA in
// test/bundle-sign-opa.test.ts when an `opa` binary is supplied (OPA=<path>); that test is skipped, and SAYS so,
// when it is not.

import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { JWK } from 'jose';
import { authoredMessage } from '../safe-error.js';
import { readTar, TarError, writeTar, type TarEntry } from './tar.js';

/** The OPA `signing.keyid` the stamp PDP is deployed with (engines.bicep opaConfig) and the key id in `keys:`. */
export const BUNDLE_KEY_ID = 'global';
/** Largest archive we will unpack (a signed bundle is ~10 KB; this bounds a decompression bomb). */
export const MAX_UNPACKED_BYTES = 256 * 1024;
const SIGNATURES_FILE = '.signatures.json';
/** Longest entry name writeTar can store (USTAR name field). */
export const MAX_NAME_BYTES = 100;

export interface BundleSigner {
  readonly alg: 'ES256';
  /** Raw R||S (64 bytes) over the JWS signing input. */
  sign(signingInput: Buffer): Promise<Buffer>;
  publicJwk(): Promise<JWK>;
}

/** The uploaded archive cannot be signed (the publisher's fault): a 400, with a message safe to show. */
export class BundleSignError extends Error {}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Go encoding/json string output with SetEscapeHTML(false): JSON.stringify plus the two line separators Go escapes. */
function goString(s: string): string {
  return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** OPA's `walk` (v1/bundle/hash.go): the byte stream a parsed JSON document is hashed over. */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return goString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    // Numbers keep their source text in OPA; JSON.parse does not, so only integers are provably the same text.
    if (!Number.isSafeInteger(v)) throw new BundleSignError('bundle JSON holds a non-integer number; only integers can be signed byte-exactly');
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `{${keys.map((k) => `${goString(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new BundleSignError('bundle JSON holds an unsupported value');
}

function parseObject(entry: TarEntry): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(entry.data.toString('utf8'));
  } catch {
    throw new BundleSignError(`${entry.name} is not valid JSON`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new BundleSignError(`${entry.name} must be a JSON object`);
  return v as Record<string, unknown>;
}

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/** Hash list OPA expects for an `opa build` archive; rejects anything it cannot hash with OPA's own rules. */
export function bundleFileHashes(entries: readonly TarEntry[]): Array<{ name: string; hash: string; algorithm: 'SHA-256' }> {
  const seen = new Set<string>();
  const files: Array<{ name: string; hash: string; algorithm: 'SHA-256' }> = [];
  for (const e of entries) {
    // writeTar can store at most 100 bytes of name; refuse here, before the vault is called, with a message that is true.
    if (Buffer.byteLength(e.name) > MAX_NAME_BYTES) throw new BundleSignError(`a file name in the bundle is ${Buffer.byteLength(e.name)} bytes; the archive format holds at most ${MAX_NAME_BYTES}`);
    const name = e.name.replace(/^\/+/, '');
    if (name === SIGNATURES_FILE) throw new BundleSignError('the bundle already contains .signatures.json: upload it UNSIGNED, the control plane signs it');
    if (!SAFE_NAME.test(name) && name !== '.manifest') throw new BundleSignError(`unsupported file name in the bundle: ${name.slice(0, 60)}`);
    if (name.split('/').includes('..')) throw new BundleSignError('a file name in the bundle contains ..');
    if (seen.has(name)) throw new BundleSignError(`the bundle lists ${name} twice`);
    seen.add(name);
    if (name === 'data.json' || name === '.manifest') {
      files.push({ name, hash: sha256Hex(Buffer.from(canonicalJson(parseObject(e)), 'utf8')), algorithm: 'SHA-256' });
    } else if (name.endsWith('.rego')) {
      files.push({ name, hash: sha256Hex(e.data), algorithm: 'SHA-256' });
    } else {
      throw new BundleSignError(`unsupported file in the bundle: ${name} (only data.json, .manifest and .rego modules are signable)`);
    }
  }
  if (files.length === 0) throw new BundleSignError('the bundle is empty');
  return files;
}

/** gzip tar in, gzip tar out with `.signatures.json` added. Never returns an archive it did not sign AND verify. */
export async function signBundle(tgz: Buffer, signer: BundleSigner): Promise<Buffer> {
  let entries: TarEntry[];
  try {
    entries = readTar(gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED_BYTES }));
  } catch (e) {
    if (e instanceof TarError) throw new BundleSignError(authoredMessage(e));
    throw new BundleSignError('the bundle is not a readable gzip tarball (or unpacks past the size limit)');
  }
  const files = bundleFileHashes(entries);
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: BUNDLE_KEY_ID, typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ files, keyid: BUNDLE_KEY_ID }));
  const input = Buffer.from(`${header}.${payload}`);
  const sig = await signer.sign(input);
  const jwk = await signer.publicJwk();
  const key = createPublicKey({ key: { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y } as JWK, format: 'jwk' });
  // The vault's answer is checked against the vault's own public key before anything is stored.
  if (!nodeVerify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, sig)) {
    throw new Error('key vault signature did not verify against the key it published');
  }
  let signed: Buffer;
  try {
    signed = writeTar([
      ...entries,
      { name: `/${SIGNATURES_FILE}`, data: Buffer.from(JSON.stringify({ signatures: [`${header}.${payload}.${b64u(sig)}`] })) },
    ]);
  } catch (e) {
    // The archive, not the vault, is why this failed: say so (deploy-integrity R7).
    if (e instanceof TarError) throw new BundleSignError(authoredMessage(e));
    throw e;
  }
  return gzipSync(signed);
}

/** PEM (SPKI) of the verification key, the value of pdpBundleVerificationPublicKeyPem. */
export async function verificationKeyPem(signer: BundleSigner): Promise<string> {
  const jwk = await signer.publicJwk();
  const key = createPublicKey({ key: { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y } as JWK, format: 'jwk' });
  return key.export({ type: 'spki', format: 'pem' }).toString();
}
