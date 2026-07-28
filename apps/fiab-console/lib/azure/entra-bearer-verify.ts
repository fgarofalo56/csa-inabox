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

/** Test hook: inject a JWKS document (bypasses the network fetch). */
export function __setEntraJwksForTest(keys: EntraJwk[] | null): void {
  jwksOverrideForTest = keys;
  jwksCache = null;
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

  let keys: EntraJwk[];
  try {
    keys = await loadJwks(tenant);
    if (header.kid && !keys.some((k) => k.kid === header.kid)) keys = await loadJwks(tenant, true);
  } catch (e) {
    return { ok: false, status: 503, error: `could not load the Entra signing keys: ${(e as Error)?.message || e}` };
  }
  const jwk = keys.find((k) => k.kid === header.kid) || null;
  if (!jwk) return { ok: false, status: 401, error: 'unknown token signing key' };
  if (!verifyRs256(`${parts[0]}.${parts[1]}`, b64url(parts[2]), jwk)) {
    return { ok: false, status: 401, error: 'invalid token signature' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp || 0);
  const nbf = Number(payload.nbf || 0);
  if (!exp || nowSec > exp + CLOCK_SKEW_SEC) return { ok: false, status: 401, error: 'token expired' };
  if (nbf && nowSec < nbf - CLOCK_SKEW_SEC) return { ok: false, status: 401, error: 'token not yet valid' };

  const iss = String(payload.iss || '');
  if (!allowedIssuers(tenant).includes(iss)) {
    return { ok: false, status: 401, error: 'token issuer is not the estate tenant' };
  }
  const aud = String(payload.aud || '');
  if (!audiences.includes(aud)) return { ok: false, status: 401, error: 'token audience mismatch' };

  return {
    ok: true,
    claims: {
      appId: payload.appid ? String(payload.appid) : (payload.azp ? String(payload.azp) : undefined),
      objectId: payload.oid ? String(payload.oid) : undefined,
      tenantId: payload.tid ? String(payload.tid) : undefined,
      upn: payload.upn ? String(payload.upn) : (payload.preferred_username ? String(payload.preferred_username) : undefined),
      audience: aud,
      expiresAt: exp,
    },
  };
}
