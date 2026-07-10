/**
 * Power BI user-passthrough (On-Behalf-Of) token service — v1.
 *
 * Mints a DELEGATED Power BI / Fabric access token for the SIGNED-IN user so
 * every Power BI integration authenticates as the USER's own identity (their
 * Power BI RBAC) instead of the Loom console service principal / UAMI — exactly
 * how Power BI auth works inside Synapse. Operator requirement:
 *
 *   "all powerbi tie ins integrations builders etc should use user-based
 *    passthrough auth not the SP of loom — just like the way Power BI
 *    integration in Synapse works, so authentication will match Power BI auth."
 *
 * WHY silent-acquire, NOT a literal grant_type=jwt-bearer OBO exchange:
 *   The `loom_session` cookie holds CLAIMS ONLY (oid/name/upn/tid) — it never
 *   carries the user's raw access token. That is deliberate: the ~3KB access
 *   token inflated the encrypted cookie past Front Door's ~4KB per-header limit
 *   and FD silently dropped the Set-Cookie (see lib/auth/session.ts). So there
 *   is NO raw user assertion available in a request to feed jwt-bearer. Instead
 *   we do exactly what the ARM / SQL / PBI-MCP user-token captures already do:
 *   resolve the user's account from the confidential-client MSAL cache (which is
 *   persisted per-user, encrypted, in Cosmos via the cosmosTokenCachePlugin in
 *   lib/auth/msal.ts) and `acquireTokenSilent` the delegated Power BI token. MSAL
 *   transparently exchanges the user's cached ~24h refresh token. The result is
 *   the SAME delegated per-user token an OBO exchange would yield, obtained
 *   WITHOUT changing the cookie shape — so this is fully backward-compatible and
 *   never touches the MSAL login hot zone (csa_loom_msal_login_breakage).
 *
 * NO-FABRIC-DEPENDENCY: Power BI itself remains OPT-IN. This module only changes
 * HOW an already-opted-in Power BI call authenticates (as the user, not the SP);
 * it is invoked solely from the Power BI REST client's token path and never
 * forces a Fabric/Power BI dependency onto a default Azure-native code path.
 *
 * SECURITY: tokens are held only in a short-lived per-replica in-memory cache
 * (below) and handed straight to the outbound Power BI REST call. They are NEVER
 * logged and NEVER returned to the browser.
 */

import { getMsalClient, pbiOboScopes } from '@/lib/auth/msal';

/** Typed OBO failure reasons the Power BI client + routes map to honest gates. */
export type OboErrorCode =
  /** The Loom app registration lacks admin-consented delegated Power BI scopes
   *  for this user (AADSTS65001 / interaction_required / invalid_grant). */
  | 'consent_required'
  /** No signed-in user in scope (background job / no session cookie), or the
   *  user's account is not in the MSAL cache (cold + not-yet-persisted). */
  | 'no_user_token'
  /** Silent acquisition failed for any other reason (transient / config). */
  | 'exchange_failed';

export type OboResult =
  | { ok: true; token: string; expiresOn: Date | null }
  | { ok: false; error: OboErrorCode };

/**
 * Per-replica in-memory cache of minted user tokens, keyed by `oid|scope`. A
 * cross-replica cache is unnecessary: the MSAL token cache (which backs
 * acquireTokenSilent) is ALREADY persisted per-user in Cosmos, so a cold replica
 * re-mints silently. This tier only avoids a silent-acquire round-trip on every
 * REST call within a replica. Tokens are dropped `SAFETY_MARGIN_MS` before their
 * real expiry so a caller never receives an about-to-expire token.
 */
const SAFETY_MARGIN_MS = 60_000;
interface CacheEntry {
  token: string;
  expEpochMs: number;
}
const tokenCache = new Map<string, CacheEntry>();

function cacheKey(oid: string, scope: string): string {
  return `${oid}|${scope}`;
}

/**
 * Resolve the ambient request's session oid, or '' when there is no session
 * (background job / non-request context). Mirrors msal.ts's `currentSessionOid`:
 * `getSession()` reads `next/headers` cookies() which THROWS outside a request
 * scope, so this is defensively wrapped — a throw simply means "no user". The
 * dynamic import keeps a background importer of the Power BI client from pulling
 * the next/headers request machinery into a non-request graph (same discipline
 * as msal.ts).
 */
async function currentOid(): Promise<string> {
  try {
    const { getSession } = await import('@/lib/auth/session');
    return getSession()?.claims.oid ?? '';
  } catch {
    return '';
  }
}

/**
 * Map an MSAL silent-acquire failure to a typed OBO error. A missing/expired
 * consent shows up as AADSTS65001, `interaction_required`, `consent_required`,
 * or `invalid_grant` depending on MSAL version — all mean "the user must
 * (re-)consent the delegated Power BI scopes", which is an ADMIN action here
 * (the delegated Power BI permissions must be granted + admin-consented on the
 * Loom app registration). Everything else is a transient exchange failure.
 */
function classifyError(err: unknown): OboErrorCode {
  const e = err as { errorCode?: string; message?: string } | undefined;
  const hay = `${e?.errorCode ?? ''} ${e?.message ?? ''}`.toLowerCase();
  if (
    hay.includes('aadsts65001') ||
    hay.includes('interaction_required') ||
    hay.includes('consent') ||
    hay.includes('invalid_grant')
  ) {
    return 'consent_required';
  }
  return 'exchange_failed';
}

/**
 * Acquire a DELEGATED Power BI access token for the signed-in user for the given
 * resource `scope` (e.g. `https://analysis.windows.net/powerbi/api/.default` for
 * Power BI REST, or `https://api.fabric.microsoft.com/.default` for Fabric REST).
 * Requesting the `.default` scope returns a token carrying ALL of the user's
 * admin-consented delegated permissions for that resource — true passthrough;
 * per-workspace RBAC is then enforced by Power BI.
 *
 * Returns a typed result (never throws). `no_user_token` is the SIGNAL for the
 * Power BI client to fall back to the console service principal on background /
 * non-request code paths; `consent_required` / `exchange_failed` are surfaced as
 * honest MessageBar gates (the user IS present but a delegated token can't be
 * minted — we do NOT silently downgrade to the SP, which would defeat
 * passthrough and leak the SP's broader rights).
 */
export async function getUserPbiToken(scope: string): Promise<OboResult> {
  const oid = await currentOid();
  if (!oid) return { ok: false, error: 'no_user_token' };

  const key = cacheKey(oid, scope);
  const cached = tokenCache.get(key);
  if (cached && cached.expEpochMs - SAFETY_MARGIN_MS > Date.now()) {
    return { ok: true, token: cached.token, expiresOn: new Date(cached.expEpochMs) };
  }

  try {
    const client = getMsalClient();
    // Resolve the user's account from the (Cosmos-persisted) MSAL cache the same
    // way /api/auth/refresh does — match on oid via homeAccountId prefix OR
    // localAccountId (robust across MSAL account shapes).
    const accounts = await client.getTokenCache().getAllAccounts();
    const account = accounts.find(
      (a) => a.homeAccountId.split('.')[0] === oid || a.localAccountId === oid,
    );
    if (!account) {
      // Account not in cache (cold replica whose persisted blob is absent, or an
      // evicted session) → interactive reauth is required to repopulate it.
      return { ok: false, error: 'no_user_token' };
    }
    const res = await client.acquireTokenSilent({ account, scopes: [scope] });
    if (!res?.accessToken) return { ok: false, error: 'exchange_failed' };
    const expMs = (res.expiresOn ?? new Date(Date.now() + 60 * 60 * 1000)).getTime();
    tokenCache.set(key, { token: res.accessToken, expEpochMs: expMs });
    return { ok: true, token: res.accessToken, expiresOn: res.expiresOn ?? null };
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
}

/**
 * The delegated Power BI scopes the Loom app registration must be granted +
 * admin-consented for user-passthrough to work. Surfaced in honest gates + the
 * bootstrap doc. `pbiOboScopes()` (lib/auth/msal.ts) is the sovereign-cloud-aware
 * resource-prefixed form used by the remote-MCP read path; user-passthrough for
 * the WRITE-capable REST surface additionally needs the ReadWrite + Content.Create
 * permissions below (a token minted for the resource `.default` scope carries
 * whichever of these the tenant has consented).
 */
export const PBI_PASSTHROUGH_DELEGATED_SCOPES = [
  'Workspace.Read.All',
  'Report.ReadWrite.All',
  'Dataset.ReadWrite.All',
  'Content.Create',
] as const;

/** Honest, actionable MessageBar text for each OBO failure. */
export function oboRemediation(error: OboErrorCode): string {
  switch (error) {
    case 'consent_required':
      return (
        'Power BI is configured to use your own identity (user passthrough), but the ' +
        'Loom app registration has not been granted the delegated Power BI permissions ' +
        `for your account. A tenant admin must add the delegated scopes (${PBI_PASSTHROUGH_DELEGATED_SCOPES.join(', ')}) ` +
        'to the Loom app registration and grant admin consent — see ' +
        'docs/fiab/v3-tenant-bootstrap.md (Power BI delegated permissions). Then sign out and back in.'
      );
    case 'no_user_token':
      return (
        'No signed-in user token is available to call Power BI as your identity. ' +
        'Sign out and sign back in, then retry.'
      );
    case 'exchange_failed':
    default:
      return (
        'Could not acquire a Power BI access token for your identity. Sign out and back ' +
        'in, then retry; if it persists, verify the Loom app registration has the ' +
        'delegated Power BI permissions granted and admin-consented.'
      );
  }
}

/** True unless explicitly disabled — user-passthrough is the DEFAULT for Power BI
 *  (default-on / opt-out). `LOOM_POWERBI_USER_PASSTHROUGH=false` reverts every
 *  Power BI call to the console service-principal path (single-flip kill switch). */
export function userPassthroughEnabled(): boolean {
  return (process.env.LOOM_POWERBI_USER_PASSTHROUGH ?? 'true').toLowerCase() !== 'false';
}

/** Re-export so callers needing the read-only MCP scope form don't reach into msal. */
export { pbiOboScopes };

/** Test-only: clear the in-memory token cache between cases. */
export function __clearOboCacheForTests(): void {
  tokenCache.clear();
}
