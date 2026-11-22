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

async function withKid(jwk: JWK, alg: 'ES256' | 'ES384' = 'ES384'): Promise<JWK> {
  const kid = await calculateJwkThumbprint(jwk, 'sha256');
  return { ...jwk, kid, alg, use: 'sig' };
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

export type EcAlg = 'ES256' | 'ES384';
const EC_PARAMS: Record<EcAlg, { crv: string; hash: 'sha256' | 'sha384'; sigBytes: number }> = {
  ES256: { crv: 'P-256', hash: 'sha256', sigBytes: 64 },
  ES384: { crv: 'P-384', hash: 'sha384', sigBytes: 96 },
};

/**
 * Key Vault EC signing, parametrised by algorithm. One implementation for the token signer (ES384, P-384) and the
 * PDP bundle signer (ES256, P-256, #5422): the Key Vault call, the EC-HSM acceptance and the no-cached-failure rule
 * live here once.
 */
export class KeyVaultEcSigner {
  private readonly url: URL;
  private pub: Promise<JWK> | undefined;
  private readonly f: typeof fetch;
  constructor(
    private readonly o: KeyVaultSignerOptions,
    readonly alg: EcAlg,
  ) {
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
    // Key Vault reports an HSM-backed key (the operator-mandated non-exportable key, A10) as
    // kty "EC-HSM", not "EC". Refusing it made kid() throw on EVERY token request on the
    // live dev01 stamp (2026-11-21: auth.internal_error, 500). The published JWK is the
    // standard RFC 7517 "EC" either way; the HSM suffix is a Key Vault storage detail.
    // A REJECTED read is never cached: `??=` on a rejected promise kept one transient Key
    // Vault failure (timeout, 429, 5xx) failing every later request until a restart.
    this.pub ??= this.call('', { method: 'GET' })
      .then((r) => {
        const k = r.key as JWK | undefined;
        const p = EC_PARAMS[this.alg];
        if (!k || (k.kty !== 'EC' && k.kty !== 'EC-HSM') || k.crv !== p.crv || !k.x || !k.y) {
          throw new Error(`key is not an EC ${p.crv} key`);
        }
        return withKid({ kty: 'EC', crv: k.crv, x: k.x, y: k.y }, this.alg);
      })
      .catch((e: unknown) => {
        this.pub = undefined;
        throw e;
      });
    return this.pub;
  }
  async kid(): Promise<string> {
    return (await this.publicJwk()).kid as string;
  }
  async sign(signingInput: Buffer): Promise<Buffer> {
    const p = EC_PARAMS[this.alg];
    const digest = createHash(p.hash).update(signingInput).digest();
    const r = await this.call('/sign', { method: 'POST', body: JSON.stringify({ alg: this.alg, value: b64u(digest) }) });
    const sig = Buffer.from(String(r.value ?? ''), 'base64url');
    if (sig.length !== p.sigBytes) throw new Error(`key vault returned a malformed ${this.alg} signature`);
    return sig;
  }
}

/** The authorization-server token signer: ES384 on a P-384 key. */
export class KeyVaultSigner extends KeyVaultEcSigner implements Signer {
  declare readonly alg: 'ES384';
  constructor(o: KeyVaultSignerOptions) {
    super(o, 'ES384');
  }
}

/** The PDP bundle signer: ES256 on a P-256 key (OPA bundle signing, #5422). */
export class KeyVaultBundleSigner extends KeyVaultEcSigner {
  declare readonly alg: 'ES256';
  constructor(o: KeyVaultSignerOptions) {
    super(o, 'ES256');
  }
}
