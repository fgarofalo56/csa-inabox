/**
 * Generic Microsoft Entra bearer verifier for INBOUND requests (LU-9).
 *
 * Loom terminates two classes of inbound machine traffic that are NOT a browser
 * session: OpenLineage ingest and — since LU-9 — external Delta Sharing
 * recipients. Both need the same primitive: prove that an `Authorization:
 * Bearer <jwt>` was minted by the estate's own Entra tenant, for one of the
 * audiences we accept, and has not expired; then hand back the caller's
 * principal so the route can authorize it against real data.
 *
 * This module is that primitive and nothing more. It deliberately does NOT know
 * about recipients, workspaces, or grants — a verifier that also decides
 * authorization is a verifier you cannot reason about. Callers get claims;
 * callers decide access.
 *
 * Pure Node crypto (no new dependency): JWKS keys are imported via
 * `crypto.createPublicKey({format:'jwk'})` and RS256-verified with
 * `crypto.verify`. The JWKS document is fetched from the cloud-correct Entra
 * host (login.microsoftonline.com / .us) and cached for 1 h, with exactly one
 * refetch on an unknown `kid` (key rollover).
 *
 * SIBLING NOTE (honest duplication): `lib/azure/openlineage-auth.ts` predates
 * this module and carries its own copy of the same verification. It is not
 * migrated here because that path has bespoke 401/403/503 mapping and its own
 * test hook, and quietly re-writing a shipped security path while adding a new
 * one is how both end up subtly wrong. This module is the canonical one for new
 * inbound surfaces; folding OpenLineage onto it is tracked as a follow-up.
 */

import crypto from 'node:crypto';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SEC = 300;
/**
 * Minimum interval between FORCED JWKS refetches (unknown-`kid` rollover path).
 *
 * Without this, `kid` is an unauthenticated remote-fetch trigger: the kid lookup
 * necessarily happens BEFORE signature verification, so a token that is merely
 * three base64 segments with `alg:RS256` and a random `kid` costs us one
 * outbound request to login.microsoftonline.com. On a public, credential-free
 * route (`/api/delta-sharing/*`) that is a free amplifier — 20 forged tokens
 * produced 21 outbound fetches before this guard existed.
 *
 * Entra publishes rollover keys well ahead of first use, so bounding the forced
 * refresh to once a minute costs nothing operationally.
 */
const JWKS_FORCED_REFRESH_MIN_INTERVAL_MS = 60_000;
/** Bound on the remembered-unknown-`kid` set (a flood must not grow memory). */
const UNKNOWN_KID_MAX = 200;

export interface EntraJwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

/** The subset of claims Loom routes actually authorize against. */
export interface EntraBearerClaims {
  /** Application (client) id for a client-credentials token, else undefined. */
  appId?: string;
  /** Object id of the user or service principal in the token's tenant. */
  objectId?: string;
  /** Home tenant of the caller (`tid`) — for a guest/B2B recipient this is OUR tenant. */
  tenantId?: string;
  /** UPN / preferred username when the token is a user token. */
  upn?: string;
  /** Raw audience. */
  audience: string;
  /** Delegated scopes (`scp`), split. Empty for an app-only token. */
  scopes: string[];
  /** App roles (`roles`). Empty for a delegated token. */
  roles: string[];
  /** Expiry (epoch seconds). */
  expiresAt: number;
}

export type EntraBearerResult =
  | { ok: true; claims: EntraBearerClaims }
  // 401 = the credential is bad. 503 = WE are not configured to check it, which
  // is never the caller's fault and must never be reported as "unauthorized".
  | { ok: false; status: 401 | 503; error: string };

let jwksCache: { tenant: string; keys: EntraJwk[]; fetchedAt: number } | null = null;
let jwksOverrideForTest: EntraJwk[] | null = null;
/** `kid`s a forced refresh has already failed to find — never refetched for. */
const unknownKids = new Set<string>();
let lastForcedRefreshAt = 0;
/** Observability + test hook: how many FORCED (unknown-kid) refetches ran. */
let forcedRefreshCount = 0;

/** Test hook: inject a JWKS document (bypasses the network fetch). */
export function __setEntraJwksForTest(keys: EntraJwk[] | null): void {
  jwksOverrideForTest = keys;
  jwksCache = null;
  unknownKids.clear();
  lastForcedRefreshAt = 0;
  forcedRefreshCount = 0;
}

/** Test hook: forced-refetch counter, so a spec can assert the amplifier is shut. */
export function __entraForcedJwksRefreshCountForTest(): number {
  return forcedRefreshCount;
}

/** The active cloud's Entra authority host. Mirrors lib/auth/msal.ts without
 *  dragging the MSAL SDK into a verifier. */
export function entraAuthorityHost(): string {
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  return cloud === 'azureusgovernment'
    ? 'https://login.microsoftonline.us'
    : 'https://login.microsoftonline.com';
}

/** The estate tenant whose tokens we accept. */
export function estateTenantId(): string {
  return (
    process.env.LOOM_ENTRA_TENANT_ID
    || process.env.LOOM_MSAL_TENANT_ID
    || process.env.AZURE_TENANT_ID
    || ''
  ).trim();
}

function allowedIssuers(tenant: string): string[] {
  return [
    // v2.0 tokens from the active cloud's authority.
    `${entraAuthorityHost()}/${tenant}/v2.0`,
    // v1.0 tokens (the client-credentials default for api:// audiences).
    `https://sts.windows.net/${tenant}/`,
  ];
}

function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function loadJwks(tenant: string, forceRefresh = false): Promise<EntraJwk[]> {
  if (jwksOverrideForTest) return jwksOverrideForTest;
  const now = Date.now();
  if (!forceRefresh && jwksCache && jwksCache.tenant === tenant && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const url = `${entraAuthorityHost()}/${tenant}/discovery/v2.0/keys`;
  const res = await fetchWithTimeout(url, { cache: 'no-store' }, 8000);
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const doc = (await res.json()) as { keys?: EntraJwk[] };
  const keys = Array.isArray(doc.keys) ? doc.keys : [];
  jwksCache = { tenant, keys, fetchedAt: now };
  return keys;
}

/**
 * Resolve the signing key for `kid`, refetching the JWKS at most once per
 * {@link JWKS_FORCED_REFRESH_MIN_INTERVAL_MS} — and only for a token that has
 * already passed the cheap, non-cryptographic claim checks.
 *
 * The ordering matters and is the whole point: `kid` is attacker-chosen and is
 * consulted before any signature can be verified, so an unthrottled "unknown kid
 * ⇒ refetch" rule turns every forged token into an outbound request we make on
 * the attacker's behalf. Two independent brakes:
 *
 *   1. `eligibleForRefresh` — the caller only sets it when issuer, audience and
 *      expiry already line up, so garbage never reaches the network path.
 *   2. the interval + `unknownKids` memo — even a caller who guesses those
 *      (they are not secrets) gets one refetch per minute, not one per request.
 *
 * A real key rollover still resolves: Entra publishes the new key ahead of first
 * use, and the worst case here is that the first request in a minute window
 * fails 401 and the next one succeeds.
 */
async function resolveSigningKey(
  tenant: string,
  kid: string | undefined,
  eligibleForRefresh: boolean,
): Promise<EntraJwk | null> {
  let keys = await loadJwks(tenant);
  const hit = () => keys.find((k) => k.kid === kid) || null;
  if (!kid) return null;
  const found = hit();
  if (found) return found;
  if (!eligibleForRefresh) return null;
  if (unknownKids.has(kid)) return null;
  const now = Date.now();
  if (now - lastForcedRefreshAt < JWKS_FORCED_REFRESH_MIN_INTERVAL_MS) return null;
  lastForcedRefreshAt = now;
  forcedRefreshCount += 1;
  keys = await loadJwks(tenant, true);
  const afterRefresh = hit();
  if (!afterRefresh) {
    if (unknownKids.size >= UNKNOWN_KID_MAX) unknownKids.clear();
    unknownKids.add(kid);
  }
  return afterRefresh;
}

function verifyRs256(signingInput: string, signature: Buffer, jwk: EntraJwk): boolean {
  try {
    const pub = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
    return crypto.verify('RSA-SHA256', Buffer.from(signingInput, 'utf-8'), pub, signature);
  } catch {
    return false;
  }
}

export interface VerifyEntraBearerOptions {
  /** Audiences the token may carry. A token for ANY other audience is rejected —
   *  an unpinned audience means any app in the tenant can call us with a token
   *  minted for itself. */
  audiences: string[];
  /** Override the estate tenant (tests / multi-tenant callers). */
  tenantId?: string;
  /**
   * Accept ID tokens as well as access tokens. DEFAULT false, and callers that
   * authorize data access must leave it false.
   *
   * An ID token is minted for the CLIENT (aud = the app registration's client id
   * or App ID URI) as proof of who signed in — it is not an authorization to call
   * an API. Because a Console-audience ID token and a Console-audience access
   * token have the same `iss`/`aud`/`exp` shape, signature+audience verification
   * alone cannot tell them apart, so an ordinary interactive sign-in to the
   * Console would otherwise mint a credential accepted at the data-export
   * endpoint. The discriminator used here is the one Entra actually guarantees:
   * an access token carries `scp` (delegated) or `roles` (app-only); an ID token
   * carries neither, and carries `nonce` when it came from an interactive flow.
   */
  allowIdTokens?: boolean;
  /**
   * When set, the token must carry at least one of these values in `scp` or
   * `roles`. Unset = any access token for the pinned audience is accepted (the
   * audience is then the only authorization surface).
   */
  requiredScopes?: string[];
}

/**
 * Verify an inbound Entra bearer. Fails CLOSED in every unconfigured state and
 * never reports a configuration problem as an authentication failure.
 */
export async function verifyEntraBearer(
  authorizationHeader: string | null | undefined,
  opts: VerifyEntraBearerOptions,
): Promise<EntraBearerResult> {
  const token = (authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'missing bearer credential' };

  const tenant = (opts.tenantId || estateTenantId()).trim();
  if (!tenant) {
    return {
      ok: false, status: 503,
      error: 'inbound Entra verification is not configured — set LOOM_ENTRA_TENANT_ID (or AZURE_TENANT_ID) so the verifier can pin the estate tenant.',
    };
  }
  const audiences = opts.audiences.map((a) => a.trim()).filter(Boolean);
  if (!audiences.length) {
    return {
      ok: false, status: 503,
      error: 'inbound Entra verification is not configured — no token audience is pinned, and a verifier that accepts any audience accepts tokens minted for other applications.',
    };
  }

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, status: 401, error: 'malformed bearer token' };
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64url(parts[0]).toString('utf-8'));
    payload = JSON.parse(b64url(parts[1]).toString('utf-8'));
  } catch {
    return { ok: false, status: 401, error: 'malformed bearer token' };
  }
  // `alg: none` and HMAC algorithms are the classic JWT forgery vectors — an
  // asymmetric verifier must pin the algorithm, not read it from the token.
  if (header.alg !== 'RS256') return { ok: false, status: 401, error: 'unsupported token algorithm' };

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp || 0);
  const nbf = Number(payload.nbf || 0);
  const iss = String(payload.iss || '');
  const aud = String(payload.aud || '');
  /**
   * Cheap, non-cryptographic pre-flight over the UNVERIFIED claims, used for one
   * decision only: may this token trigger an outbound JWKS refetch?
   *
   * It deliberately does NOT short-circuit the result — the checks below still
   * run in their original order and return their original messages, so this
   * introduces no new "which field did I get right?" oracle. It only denies the
   * network path to a token that could not possibly verify anyway.
   */
  const claimsPlausible =
    !!exp && nowSec <= exp + CLOCK_SKEW_SEC
    && (!nbf || nowSec >= nbf - CLOCK_SKEW_SEC)
    && allowedIssuers(tenant).includes(iss)
    && audiences.includes(aud);

  let jwk: EntraJwk | null;
  try {
    jwk = await resolveSigningKey(tenant, header.kid, claimsPlausible);
  } catch (e) {
    return { ok: false, status: 503, error: `could not load the Entra signing keys: ${(e as Error)?.message || e}` };
  }
  if (!jwk) return { ok: false, status: 401, error: 'unknown token signing key' };
  if (!verifyRs256(`${parts[0]}.${parts[1]}`, b64url(parts[2]), jwk)) {
    return { ok: false, status: 401, error: 'invalid token signature' };
  }

  if (!exp || nowSec > exp + CLOCK_SKEW_SEC) return { ok: false, status: 401, error: 'token expired' };
  if (nbf && nowSec < nbf - CLOCK_SKEW_SEC) return { ok: false, status: 401, error: 'token not yet valid' };

  if (!allowedIssuers(tenant).includes(iss)) {
    return { ok: false, status: 401, error: 'token issuer is not the estate tenant' };
  }
  if (!audiences.includes(aud)) return { ok: false, status: 401, error: 'token audience mismatch' };

  // ── Token TYPE ──────────────────────────────────────────────────────────
  // See VerifyEntraBearerOptions.allowIdTokens: iss/aud/exp/signature are
  // identical between an ID token and an access token for the same app, so the
  // audience pin alone does NOT keep an interactive sign-in credential out of an
  // API that authorizes data access.
  const scopes = typeof payload.scp === 'string'
    ? payload.scp.split(' ').map((s) => s.trim()).filter(Boolean)
    : Array.isArray(payload.scp) ? payload.scp.map(String) : [];
  const roles = Array.isArray(payload.roles) ? payload.roles.map(String) : [];
  if (!opts.allowIdTokens) {
    if (payload.nonce !== undefined) {
      return { ok: false, status: 401, error: 'an ID token is not accepted here — present an access token issued for this API' };
    }
    if (!scopes.length && !roles.length) {
      return { ok: false, status: 401, error: 'an ID token is not accepted here — present an access token issued for this API (it carries scp or roles)' };
    }
  }
  const required = (opts.requiredScopes || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (required.length) {
    const held = new Set([...scopes, ...roles].map((s) => s.toLowerCase()));
    if (!required.some((r) => held.has(r))) {
      return { ok: false, status: 401, error: 'the token does not carry a scope or app role that authorizes this API' };
    }
  }

  return {
    ok: true,
    claims: {
      appId: payload.appid ? String(payload.appid) : (payload.azp ? String(payload.azp) : undefined),
      objectId: payload.oid ? String(payload.oid) : undefined,
      tenantId: payload.tid ? String(payload.tid) : undefined,
      upn: payload.upn ? String(payload.upn) : (payload.preferred_username ? String(payload.preferred_username) : undefined),
      audience: aud,
      scopes,
      roles,
      expiresAt: exp,
    },
  };
}
