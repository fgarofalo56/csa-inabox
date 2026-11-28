// SMART Backend Services client authentication (security.md A6): a signed JWT
// client assertion verified against the client's registered JWKS. Every failure
// is `invalid_client`; no failure reveals which step refused.

import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import type { Collection } from '../store/types.js';
import { StoreConflictError } from '../http/errors.js';
import { normalizeJwk, normalizeJwks } from './jwk-normalize.js';
import { OAuthError, sha256hex, type ClientDoc, type ReplayDoc } from './types.js';

export const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const MAX_ASSERTION_LIFETIME_S = 300;
export const CLOCK_SKEW_S = 60;
const ALGS = ['RS384', 'ES384'] as const;

export interface FetchedJwks {
  keys: JWK[];
  /** Seconds the response may be cached (Cache-Control max-age); 0 when absent. */
  maxAgeS: number;
}
export type JwksFetcher = (url: string) => Promise<FetchedJwks>;

/** A fetched JWKS document is at most this many BYTES (UTF-8 on the wire, not UTF-16 string units). */
export const MAX_JWKS_BYTES = 256 * 1024;
/** The same key-count ceiling as an inline JWKS (ClientCreateSchema keys.max(20)). */
export const MAX_FETCHED_KEYS = 20;

/**
 * The body as UTF-8 text, read chunk by chunk and ABORTED as soon as it passes `cap` bytes, so an oversize document
 * is never buffered beyond the cap plus one chunk.
 */
export async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new Error('jwks document too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Default fetcher: https only, no redirects, bounded time and size. */
export function httpsJwksFetcher(fetchImpl: typeof fetch = fetch): JwksFetcher {
  return async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('jwks url must be https');
    const res = await fetchImpl(u, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`jwks fetch returned ${res.status}`);
    const text = await readCapped(res, MAX_JWKS_BYTES);
    const body = JSON.parse(text) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error('jwks document has no keys array');
    if (body.keys.length > MAX_FETCHED_KEYS) throw new Error(`jwks document has more than ${MAX_FETCHED_KEYS} keys`);
    const cc = /max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '');
    return { keys: body.keys as JWK[], maxAgeS: cc ? Number(cc[1]) : 0 };
  };
}

/** Cache bounded by the client's Cache-Control (the spec says SHALL NOT cache longer). */
export function cachingJwksFetcher(inner: JwksFetcher, now: () => Date): JwksFetcher {
  const cache = new Map<string, { until: number; v: FetchedJwks }>();
  return async (url) => {
    const hit = cache.get(url);
    if (hit && hit.until > now().getTime()) return hit.v;
    const v = await inner(url);
    if (v.maxAgeS > 0) cache.set(url, { until: now().getTime() + v.maxAgeS * 1000, v });
    else cache.delete(url);
    return v;
  };
}

export interface AssertionDeps {
  replay: Collection<ReplayDoc>;
  fetchJwks: JwksFetcher;
  now: () => Date;
  /** Identifiers only (#5518): never key material. */
  log?: (event: string, fields: Record<string, string | number>) => void;
}

/**
 * The keys an assertion may be verified with: ONLY re-derived key material (#5518), never the stored or fetched
 * members as given. A stored inline JWKS is re-normalized on every read: one key that fails (a doc written before
 * the CP normalized, or edited out of band) makes the WHOLE stored set absent, logged as auth.client_jwks_invalid,
 * so the client fails closed. A fetched JWKS is a third party's document that may carry keys for other uses: it is
 * first narrowed to the keys whose `kid` and `kty` fit the assertion header (`pick`), and ONLY those are normalized
 * (with FETCHED_IGNORED_MEMBERS skipped), so the rest of the document is never parsed, on a cache hit or not. A
 * candidate that fails is dropped (logged as a count). More than MAX_FETCHED_KEYS keys yields none.
 */
export function verificationKeys(
  client: ClientDoc,
  fetched: readonly unknown[] | undefined,
  log?: AssertionDeps['log'],
  pick?: { kid: string; alg: string },
): JWK[] {
  if (fetched) {
    if (fetched.length > MAX_FETCHED_KEYS) {
      log?.('auth.client_jwks_too_many_keys', { clientId: client.clientId, keys: fetched.length });
      return [];
    }
    const candidates = pick ? fetched.filter((k) => isObject(k) && k.kid === pick.kid && keyMatchesAlg(k as JWK, pick.alg)) : fetched;
    const keys = candidates.map((k) => normalizeJwk(k, 'jwk', { fetched: true })).flatMap((r) => ('jwk' in r ? [r.jwk] : []));
    if (keys.length < candidates.length) log?.('auth.client_jwks_keys_dropped', { clientId: client.clientId, dropped: candidates.length - keys.length });
    return keys;
  }
  if (!client.jwks) return [];
  const r = normalizeJwks(Array.isArray(client.jwks.keys) ? client.jwks.keys : []);
  if ('error' in r || r.keys.length === 0) {
    log?.('auth.client_jwks_invalid', { clientId: client.clientId });
    return [];
  }
  return r.keys;
}

const refuse = (): OAuthError => new OAuthError('invalid_client', 'client authentication failed');

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function keyMatchesAlg(k: JWK, alg: string): boolean {
  return alg === 'RS384' ? k.kty === 'RSA' : k.kty === 'EC' && k.crv === 'P-384';
}

/**
 * Verify `assertion` for `client` against `tokenUrl`. Order is the A6 order:
 * header, key selection, signature, claims, replay.
 */
export async function verifyClientAssertion(
  assertion: string,
  client: ClientDoc,
  tokenUrl: string,
  deps: AssertionDeps,
): Promise<void> {
  let jti: string;
  let exp: number;
  const nowS = Math.floor(deps.now().getTime() / 1000);
  try {
    // 1. JOSE header
    const header = decodeProtectedHeader(assertion);
    if (header.typ !== 'JWT' || !header.kid || !header.alg || !(ALGS as readonly string[]).includes(header.alg)) throw refuse();
    // 3. jku, when present, must equal the registered URL exactly
    if (header.jku !== undefined && header.jku !== client.jwksUrl) throw refuse();
    // 3/4. key source, then exactly one key with this kid and a kty consistent with alg
    let keys: JWK[];
    if (client.jwksUrl) keys = verificationKeys(client, (await deps.fetchJwks(client.jwksUrl)).keys, deps.log, { kid: header.kid, alg: header.alg });
    else if (client.jwks) keys = verificationKeys(client, undefined, deps.log);
    else throw refuse();
    const matches = keys.filter((k) => k.kid === header.kid && keyMatchesAlg(k, header.alg as string));
    if (matches.length !== 1) throw refuse();
    const key = await importJWK(matches[0] as JWK, header.alg);
    // 5 + 2. signature and claims (iss == sub == client_id, aud == token url, exp, jti)
    const { payload } = await jwtVerify(assertion, key, {
      algorithms: [header.alg],
      typ: 'JWT',
      issuer: client.clientId,
      subject: client.clientId,
      audience: tokenUrl,
      requiredClaims: ['exp', 'jti', 'iss', 'sub', 'aud'],
      clockTolerance: CLOCK_SKEW_S,
      currentDate: deps.now(),
    });
    exp = payload.exp as number;
    if (exp - nowS > MAX_ASSERTION_LIFETIME_S) throw refuse();
    if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > 256) throw refuse();
    jti = payload.jti;
  } catch {
    // Fail closed: a malformed token, an unreachable JWKS or a bad key all read as a failed assertion.
    throw refuse();
  }
  // 6. replay: create-if-absent in the shared store; 409 means seen before.
  // Outside the try so a store fault surfaces as a server error, not as "bad client".
  try {
    await deps.replay.create({ id: sha256hex(`${client.clientId}|${jti}`), ttl: Math.max(exp - nowS, 0) + CLOCK_SKEW_S });
  } catch (e) {
    if (e instanceof StoreConflictError) throw refuse();
    throw e;
  }
}
