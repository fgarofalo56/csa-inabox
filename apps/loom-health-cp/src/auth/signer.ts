// Signing seams for LHDS-issued tokens. Access tokens are ES384; id_tokens are
// RS256 (OIDC's mandatory-to-implement alg, which Inferno's SMART STU2.2 kit
// requires; #5454 A7). The preferred implementation is a NON-EXPORTABLE Key
// Vault key (HSM-backed) signed through the Key Vault `sign` operation, so the
// private key never enters this process (operator decision, security.md A10
// criterion 3). LocalSigner / LocalRsaSigner are the disclosed fallback
// authorizer / test doubles: in-process keys, never the default.

import { createHash, createPrivateKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, type JWK } from 'jose';
import type { Cloud } from '../config.js';
import { KEYVAULT_SUFFIX_BY_CLOUD, keyVaultScope } from './clouds.js';
import { MIN_RSA_BITS, rsaModulusBits } from './jwks-guard.js';
import { isSameOrigin } from './same-origin.js';

/** What signJwt needs: an alg for the header, a kid, and a signature over the JWS signing input. */
export interface JwsSigner {
  readonly alg: string;
  /** Key id placed in the JWS header and in the published JWKS. */
  kid(): Promise<string>;
  /** JWS signature over the signing input (raw R||S for EC, PKCS#1 v1.5 bytes for RSA). */
  sign(signingInput: Buffer): Promise<Buffer>;
}

/** The access-token signer. */
export interface Signer extends JwsSigner {
  readonly alg: 'ES384';
  /** Public JWK for the AS JWKS document. Never contains private members. */
  publicJwk(): Promise<JWK>;
}

/** The id_token signer (#5454 A7). Access tokens never use it. */
export interface IdTokenSigner extends JwsSigner {
  readonly alg: 'RS256';
  /**
   * Every RSA public key this signer may sign with, for the AS JWKS. Normally one; more than one only while a
   * creation race or an operator rotation leaves several enabled versions (see KeyVaultRsaSigner).
   */
  publicJwks(): Promise<JWK[]>;
}

const b64u = (b: Buffer): string => b.toString('base64url');

async function withKid(jwk: JWK, alg: 'ES256' | 'ES384' | 'RS256' = 'ES384'): Promise<JWK> {
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

/** In-process RSA test double for the id_token signer. Never the default: production wires KeyVaultRsaSigner. */
export class LocalRsaSigner implements IdTokenSigner {
  readonly alg = 'RS256' as const;
  private readonly priv: KeyObject;
  private readonly pub: Promise<JWK>;
  constructor(privateKey?: KeyObject) {
    this.priv = privateKey ?? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const { kty, n, e } = this.priv.export({ format: 'jwk' }) as JWK; // d, p, q, dp, dq, qi are dropped on purpose
    this.pub = withKid({ kty, n, e }, 'RS256');
  }
  async kid(): Promise<string> {
    return (await this.pub).kid as string;
  }
  async sign(signingInput: Buffer): Promise<Buffer> {
    return nodeSign('sha256', signingInput, this.priv); // RSASSA-PKCS1-v1_5 over SHA-256 = JWS RS256
  }
  async publicJwks(): Promise<JWK[]> {
    return [await this.pub];
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

// ---- id_token RS256 signer (#5454 A7) ----

/** Fixed name of the id_token key, in the stamp vault that already holds the ES384 access-token key. */
export const ID_TOKEN_KEY_NAME = 'lhds-as-idtoken-rs256';
export const ID_TOKEN_RSA_BITS = 3072;

/**
 * The unversioned id_token key URL, derived from the access-token key id (`https://<vault>.<suffix>/keys/<name>/<v>`),
 * so no new environment variable is needed: same vault, fixed name.
 */
export function idTokenKeyUrlFrom(cloud: Cloud, signingKeyId: string): string {
  return `${validateKeyVaultKeyId(cloud, signingKeyId).origin}/keys/${ID_TOKEN_KEY_NAME}`;
}

/** A non-2xx Key Vault answer. `statusCode` is what classifyError logs; the message states only the status seen. */
export class KeyVaultHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'KeyVaultHttpError';
  }
}

export interface KeyVaultRsaSignerOptions {
  cloud: Cloud;
  /** Unversioned key URL, https://<vault>.<suffix>/keys/<name> (idTokenKeyUrlFrom). */
  keyUrl: string;
  getToken: (scope: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Wait after creating the key before choosing a version (default 3000 ms); see the race note on the class. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface KvVersionItem {
  kid?: unknown;
  attributes?: { enabled?: unknown; created?: unknown; exp?: unknown; nbf?: unknown };
}
interface RsaState {
  signUrl: string;
  sigBytes: number;
  kid: string;
  jwks: JWK[];
}
const MAX_VERSION_PAGES = 10;
const MAX_PUBLISHED_VERSIONS = 25;
const ok = (status: number): boolean => status >= 200 && status <= 299;

/**
 * Key Vault RS256 signing for id_tokens, on an RSA-HSM key the control plane creates in its own vault at runtime if
 * it is missing (no bicep: the CP identity holds Key Vault Crypto Officer on that vault, which covers keys/create).
 *
 * Get-or-create: GET the key by name; on 404 create it (`RSA-HSM`, 3072 bits, key_ops sign/verify; an HSM key is
 * non-exportable). Signing always goes to a VERSIONED key URL.
 *
 * Why a token's kid appears in the JWKS served by every replica (maxReplicas 2 may race the very first create):
 *   1. Two replicas that both see 404 both create, leaving two enabled versions.
 *   2. After its create, each replica waits `settleMs`, then LISTS the versions, so a racing create that was in
 *      flight is visible to both. Both then hold the same set of enabled versions.
 *   3. Every replica signs with the SAME pick from that set: the oldest enabled version (created asc, then version
 *      URL asc). Two replicas holding the same set cannot pick differently.
 *   4. The JWKS publishes EVERY enabled version in the set, not only the one that signs, so a replica's own signing
 *      version is always in its own JWKS, and any version another replica could pick from the same set is too.
 * The residual window is a racing create slower than `settleMs` (3 s default) on the first-ever start; it closes on
 * the next restart of either replica. Rotation: add a version, disable the old one, restart.
 *
 * Failures are never cached (the KeyVaultEcSigner rule): a rejected resolve is cleared, so the next call reads Key
 * Vault again. A refused create (403) is reported as exactly that; there is no ES384 fallback for id_tokens.
 */
export class KeyVaultRsaSigner implements IdTokenSigner {
  readonly alg = 'RS256' as const;
  readonly keyUrl: string;
  private readonly name: string;
  private readonly origin: string;
  private readonly f: typeof fetch;
  private state: Promise<RsaState> | undefined;
  constructor(private readonly o: KeyVaultRsaSignerOptions) {
    const u = new URL(o.keyUrl);
    const suffix = KEYVAULT_SUFFIX_BY_CLOUD[o.cloud];
    const m = /^\/keys\/([A-Za-z0-9-]{1,127})$/.exec(u.pathname);
    if (u.protocol !== 'https:' || !u.hostname.endsWith(`.${suffix}`) || !m || u.search || u.hash) {
      throw new Error(`id_token key url must be https://<vault>.${suffix}/keys/<name>`);
    }
    this.origin = u.origin;
    this.name = m[1] as string;
    this.keyUrl = `${u.origin}/keys/${this.name}`;
    this.f = o.fetchImpl ?? fetch;
  }

  private async req(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    // nextLink and version URLs come from Key Vault's answers; never follow one off the vault. Checked BEFORE
    // getToken, so no bearer token is fetched or sent for an off-vault URL. A parsed-origin comparison, not a prefix.
    if (!isSameOrigin(url, this.origin)) throw new Error('key vault link left the vault origin');
    const token = await this.o.getToken(keyVaultScope(this.o.cloud));
    const full = url.includes('api-version=') ? url : `${url}${url.includes('?') ? '&' : '?'}api-version=7.4`;
    const res = await this.f(full, {
      method,
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }

  /** Key Vault's own error code from a failure body, when it is a short token. */
  private static kvCode(json: Record<string, unknown>): string | undefined {
    const c = (json.error as { code?: unknown } | undefined)?.code;
    return typeof c === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(c) ? c : undefined;
  }

  private fail(status: number, json: Record<string, unknown>, doing: string): KeyVaultHttpError {
    // States only what was observed: the status and Key Vault's code. It does not guess a cause (deploy-integrity R7).
    const code = KeyVaultRsaSigner.kvCode(json);
    return new KeyVaultHttpError(`key vault returned ${status}${code ? ` (${code})` : ''} ${doing} id_token key ${this.name}`, status, code);
  }

  private async resolve(): Promise<RsaState> {
    const latest = await this.req('GET', this.keyUrl);
    if (latest.status === 404) {
      const c = await this.req('POST', `${this.keyUrl}/create`, { kty: 'RSA-HSM', key_size: ID_TOKEN_RSA_BITS, key_ops: ['sign', 'verify'] });
      if (!ok(c.status)) throw this.fail(c.status, c.json, 'creating');
      await (this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(this.o.settleMs ?? 3000);
    } else if (!ok(latest.status)) {
      throw this.fail(latest.status, latest.json, 'reading');
    }

    const nowS = Math.floor((this.o.now ?? (() => new Date()))().getTime() / 1000);
    const items: KvVersionItem[] = [];
    let next: string | undefined = `${this.keyUrl}/versions`;
    for (let page = 0; next && page < MAX_VERSION_PAGES; page++) {
      const r = await this.req('GET', next);
      if (!ok(r.status)) throw this.fail(r.status, r.json, 'listing versions of');
      items.push(...((Array.isArray(r.json.value) ? r.json.value : []) as KvVersionItem[]));
      next = typeof r.json.nextLink === 'string' && r.json.nextLink ? r.json.nextLink : undefined;
    }
    const prefix = `${this.keyUrl}/`;
    const created = (v: KvVersionItem): number => (typeof v.attributes?.created === 'number' ? v.attributes.created : Number.MAX_SAFE_INTEGER);
    const usable = items
      .filter((v): v is KvVersionItem & { kid: string } => typeof v.kid === 'string' && v.kid.startsWith(prefix) && /^[0-9a-f]{32}$/.test(v.kid.slice(prefix.length)))
      .filter((v) => v.attributes?.enabled === true)
      .filter((v) => typeof v.attributes?.exp !== 'number' || v.attributes.exp > nowS)
      .filter((v) => typeof v.attributes?.nbf !== 'number' || v.attributes.nbf <= nowS)
      .sort((a, b) => created(a) - created(b) || (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0))
      .slice(0, MAX_PUBLISHED_VERSIONS);
    if (usable.length === 0) throw new Error(`id_token key ${this.name} has no enabled version`);

    const versions = await Promise.all(
      usable.map(async (v) => {
        const r = await this.req('GET', v.kid);
        if (!ok(r.status)) throw this.fail(r.status, r.json, 'reading a version of');
        const k = r.json.key as JWK | undefined;
        const bits = rsaModulusBits(k?.n);
        if (!k || (k.kty !== 'RSA' && k.kty !== 'RSA-HSM') || !k.e || bits < MIN_RSA_BITS) {
          throw new Error(`id_token key ${this.name} is not an RSA key of at least ${MIN_RSA_BITS} bits`);
        }
        // The published JWK is the standard RFC 7517 "RSA" (the HSM suffix is a Key Vault storage detail), public
        // members only; its kid is the RFC 7638 thumbprint, distinct per version.
        return { jwk: await withKid({ kty: 'RSA', n: k.n as string, e: k.e }, 'RS256'), bytes: Math.ceil(bits / 8), url: v.kid };
      }),
    );
    const signing = versions[0] as (typeof versions)[number];
    return { signUrl: signing.url, sigBytes: signing.bytes, kid: signing.jwk.kid as string, jwks: versions.map((x) => x.jwk) };
  }

  private current(): Promise<RsaState> {
    this.state ??= this.resolve().catch((e: unknown) => {
      this.state = undefined; // never cache a failure
      throw e;
    });
    return this.state;
  }

  async kid(): Promise<string> {
    return (await this.current()).kid;
  }
  async publicJwks(): Promise<JWK[]> {
    return (await this.current()).jwks;
  }
  async sign(signingInput: Buffer): Promise<Buffer> {
    const st = await this.current();
    const digest = createHash('sha256').update(signingInput).digest();
    const r = await this.req('POST', `${st.signUrl}/sign`, { alg: 'RS256', value: b64u(digest) });
    if (!ok(r.status)) {
      // A 4xx (a disabled, deleted or expired version; a lost permission) must not wedge this replica on the old
      // version until a restart: drop the resolved state so the next request re-reads the key and its versions.
      if (r.status >= 400 && r.status < 500 && this.state) this.state = undefined;
      throw this.fail(r.status, r.json, 'signing with');
    }
    const sig = Buffer.from(String(r.json.value ?? ''), 'base64url');
    if (sig.length !== st.sigBytes) throw new Error('key vault returned a malformed RS256 signature');
    return sig;
  }
}
