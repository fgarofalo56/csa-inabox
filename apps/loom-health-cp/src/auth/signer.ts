// Signing seam for LHDS-issued tokens (ES384). The preferred implementation is
// a NON-EXPORTABLE Key Vault key (HSM-backed) signed through the Key Vault
// `sign` operation, so the private key never enters this process (operator
// decision, security.md A10 criterion 3). LocalSigner is the disclosed
// fallback authorizer / test double: an in-process key, never the default.

import { createHash, createPrivateKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, type JWK } from 'jose';
import type { Cloud } from '../config.js';
import { KEYVAULT_SUFFIX_BY_CLOUD, keyVaultScope } from './clouds.js';

export interface Signer {
  readonly alg: 'ES384';
  /** Key id placed in the JWS header and in the published JWKS. */
  kid(): Promise<string>;
  /** Raw R||S (96 bytes) signature over the JWS signing input. */
  sign(signingInput: Buffer): Promise<Buffer>;
  /** Public JWK for the AS JWKS document. Never contains private members. */
  publicJwk(): Promise<JWK>;
}

const b64u = (b: Buffer): string => b.toString('base64url');

async function withKid(jwk: JWK): Promise<JWK> {
  const kid = await calculateJwkThumbprint(jwk, 'sha256');
  return { ...jwk, kid, alg: 'ES384', use: 'sig' };
}

export class LocalSigner implements Signer {
  readonly alg = 'ES384' as const;
  private readonly key: KeyObject;
  private readonly pub: Promise<JWK>;
  constructor(privateKey?: KeyObject) {
    this.key =
      privateKey ?? createPrivateKey(generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const { kty, crv, x, y } = this.key.export({ format: 'jwk' }) as JWK; // d is dropped on purpose
    this.pub = withKid({ kty, crv, x, y });
  }
  async kid(): Promise<string> {
    return (await this.pub).kid as string;
  }
  async sign(signingInput: Buffer): Promise<Buffer> {
    return nodeSign('sha384', signingInput, { key: this.key, dsaEncoding: 'ieee-p1363' });
  }
  publicJwk(): Promise<JWK> {
    return this.pub;
  }
}

export interface KeyVaultSignerOptions {
  cloud: Cloud;
  /** Full versioned key id, https://<vault>.<suffix>/keys/<name>/<version>. */
  keyId: string;
  getToken: (scope: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

export function validateKeyVaultKeyId(cloud: Cloud, keyId: string): URL {
  const u = new URL(keyId);
  const suffix = KEYVAULT_SUFFIX_BY_CLOUD[cloud];
  if (u.protocol !== 'https:' || !u.hostname.endsWith(`.${suffix}`) || !/^\/keys\/[A-Za-z0-9-]{1,127}\/[0-9a-f]{32}$/.test(u.pathname)) {
    throw new Error(`key id must be https://<vault>.${suffix}/keys/<name>/<version>`);
  }
  return u;
}

export class KeyVaultSigner implements Signer {
  readonly alg = 'ES384' as const;
  private readonly url: URL;
  private pub: Promise<JWK> | undefined;
  private readonly f: typeof fetch;
  constructor(private readonly o: KeyVaultSignerOptions) {
    this.url = validateKeyVaultKeyId(o.cloud, o.keyId);
    this.f = o.fetchImpl ?? fetch;
  }
  private async call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const token = await this.o.getToken(keyVaultScope(this.o.cloud));
    const res = await this.f(`${this.url.origin}${this.url.pathname}${path}?api-version=7.4`, {
      ...init,
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`key vault returned ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  publicJwk(): Promise<JWK> {
    this.pub ??= this.call('', { method: 'GET' }).then((r) => {
      const k = r.key as JWK | undefined;
      if (!k || k.kty !== 'EC' || k.crv !== 'P-384' || !k.x || !k.y) throw new Error('key is not an EC P-384 key');
      return withKid({ kty: k.kty, crv: k.crv, x: k.x, y: k.y });
    });
    return this.pub;
  }
  async kid(): Promise<string> {
    return (await this.publicJwk()).kid as string;
  }
  async sign(signingInput: Buffer): Promise<Buffer> {
    const digest = createHash('sha384').update(signingInput).digest();
    const r = await this.call('/sign', { method: 'POST', body: JSON.stringify({ alg: 'ES384', value: b64u(digest) }) });
    const sig = Buffer.from(String(r.value ?? ''), 'base64url');
    if (sig.length !== 96) throw new Error('key vault returned a malformed ES384 signature');
    return sig;
  }
}
