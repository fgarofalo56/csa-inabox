/**
 * obo-token-store — DORMANT per-principal On-Behalf-Of token cache (EH Phase-1).
 *
 * ## What this is
 *
 * A default-OFF scaffold for the eventual "data-plane calls run under the
 * SIGNED-IN USER'S identity" mode. Today every server-side data-plane call uses
 * the SHARED Console UAMI ({@link uamiArmCredential}); ~233 callers are
 * unchanged. This store is the opt-in alternative: given a raw user assertion it
 * exchanges it for a per-USER delegated token via the standard OBO flow
 * (`urn:ietf:params:oauth:grant-type:jwt-bearer`) and caches it in-process,
 * keyed per-principal+scope, with a TTL derived from the token's own `exp`.
 *
 * It is reached ONLY by {@link data-access-mode}'s `shadow`/`on` paths — never on
 * the default `off` path. With OBO unset it is a no-op honest gate.
 *
 * ## Honest gate (no-vaporware)
 *
 * OBO requires its OWN confidential-client app reg (separate from the MSAL BFF /
 * the UAMI): `LOOM_OBO_CLIENT_ID` + `LOOM_OBO_CLIENT_SECRET`. When either is
 * unset {@link acquireOboToken} throws {@link OboNotConfiguredError} — the caller
 * logs it and falls back to the shared UAMI. No mock token, ever. The tenant +
 * sovereign-cloud authority reuse the SAME pattern as the AOAI/MSAL token path.
 *
 * No `@azure/identity` import: the OBO exchange is a plain token-endpoint POST,
 * so this file stays out of the heavy credential graph.
 */

const SAFETY_MARGIN_MS = 60_000;

export class OboNotConfiguredError extends Error {
  constructor() {
    super(
      'OBO data-plane not configured: set LOOM_OBO_CLIENT_ID + LOOM_OBO_CLIENT_SECRET ' +
        '(a confidential-client app reg with delegated data-plane scopes consented) to enable per-user OBO.',
    );
    this.name = 'OboNotConfiguredError';
  }
}

/** True only when the OBO confidential client (id + secret) is configured. */
export function isOboConfigured(): boolean {
  return !!(process.env.LOOM_OBO_CLIENT_ID && process.env.LOOM_OBO_CLIENT_SECRET);
}

/** Sovereign-cloud-aware AAD authority host — mirrors lib/auth/msal.ts. */
function authorityHost(): string {
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  return cloud === 'azureusgovernment'
    ? 'https://login.microsoftonline.us'
    : 'https://login.microsoftonline.com';
}

interface CacheEntry {
  token: string;
  /** Unix ms expiry (already reduced by the safety margin). */
  exp: number;
}
const cache = new Map<string, CacheEntry>();

/** Per-principal+scope cache key. Hashes the assertion so no token is keyed in clear. */
function cacheKey(userAssertion: string, scope: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const h = crypto.createHash('sha256').update(userAssertion).digest('base64url').slice(0, 24);
  return `${h}:${scope}`;
}

/**
 * Exchange a raw user assertion for a per-user delegated token for `scope` via
 * the OBO flow. In-proc cached until ~60s before expiry. Throws
 * {@link OboNotConfiguredError} when the OBO app reg is unset (the gate), or a
 * plain Error when the real exchange fails — never returns a fake token.
 */
export async function acquireOboToken(userAssertion: string, scope: string): Promise<string> {
  if (!isOboConfigured()) throw new OboNotConfiguredError();
  const key = cacheKey(userAssertion, scope);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.token;

  const tenant = process.env.AZURE_TENANT_ID || 'common';
  const body = new URLSearchParams({
    client_id: process.env.LOOM_OBO_CLIENT_ID!,
    client_secret: process.env.LOOM_OBO_CLIENT_SECRET!,
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: userAssertion,
    scope,
    requested_token_use: 'on_behalf_of',
  });
  const res = await fetch(`${authorityHost()}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    throw new Error(json?.error_description || `OBO token exchange failed (${res.status})`);
  }
  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  cache.set(key, { token: json.access_token, exp: now + ttlMs - SAFETY_MARGIN_MS });
  return json.access_token;
}

/** Test/diagnostic helper — clears the in-proc cache. */
export function _clearOboCache(): void {
  cache.clear();
}
