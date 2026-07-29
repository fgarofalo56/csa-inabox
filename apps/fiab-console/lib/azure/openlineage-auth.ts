/**
 * OpenLineage ingest credential verifier (loom-next-level L2, rev-2 SRE F2
 * security redesign).
 *
 * The rev-1 design (one static shared token, internet-reachable) was an
 * ATO-blocking SI-7/SC-8 finding: a single leaked token could forge lineage
 * for ANY workspace. This verifier implements the binding redesign:
 *
 *   1. **Never one global static secret.** Two modes, selected by
 *      `LOOM_OPENLINEAGE_AUTH_MODE` (default `entra`):
 *        - `entra` — the ingest validates an Azure AD **bearer token** (JWKS
 *          signature, RS256), with issuer pinned to the estate tenant and
 *          audience pinned to the console app registration. The presented
 *          principal (client `appid`/`azp`, or `oid`) must be REGISTERED for
 *          exactly one workspace via `LOOM_OPENLINEAGE_POOL_PRINCIPALS`
 *          (`<principalId>=<workspaceId>` pairs) — the per-pool credential →
 *          workspace binding the Fix-it wizard / pool-setup script mints.
 *        - `workspace-token` — per-WORKSPACE minted tokens (rotated by
 *          re-running the pool-setup script), stored as
 *          `LOOM_OPENLINEAGE_WORKSPACE_TOKEN` = `<workspaceId>=<token>` pairs
 *          (an ACA secretRef). Each token authorizes ONE workspace; compare is
 *          constant-time. This is the mode the openlineage-spark http
 *          transport's static `auth.apiKey` pairs with.
 *   2. **Workspace scope is the verifier's output.** The route then asserts
 *      every resolved output item belongs to the returned workspace — a
 *      cross-workspace write is 403 + audit (see the route).
 *   3. **Fail closed.** Verifier unconfigured → 503 (honest gate naming the
 *      setup script); bad/expired/foreign-tenant credential → 401; valid
 *      credential with no workspace registration → 403.
 *
 * Pure Node crypto (no new dependency): JWKS keys are imported via
 * `crypto.createPublicKey({format:'jwk'})` and RS256-verified with
 * `crypto.verify`. The JWKS document is fetched from the cloud-correct AAD
 * host (login.microsoftonline.com / .us) and cached for 1 h, with one refetch
 * on an unknown `kid` (key rollover).
 */

import crypto from 'node:crypto';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SEC = 300;
/** See the identical guard in `entra-bearer-verify.ts` — `kid` is attacker-chosen
 *  and is read before any signature can be checked, so an unthrottled
 *  "unknown kid ⇒ refetch" rule makes every forged token an outbound request we
 *  issue on the attacker's behalf. Bounded to one forced refetch per minute, and
 *  only for a token whose issuer/audience/expiry already line up. */
const JWKS_FORCED_REFRESH_MIN_INTERVAL_MS = 60_000;
const UNKNOWN_KID_MAX = 200;

export type OpenLineageAuthResult =
  | { ok: true; workspaceId: string; principal: string; mode: 'entra' | 'workspace-token' }
  | { ok: false; status: 401 | 403 | 503; error: string };

interface JwksKey {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  x5c?: string[];
}

let jwksCache: { tenant: string; keys: JwksKey[]; fetchedAt: number } | null = null;
let jwksOverrideForTest: JwksKey[] | null = null;
const unknownKids = new Set<string>();
let lastForcedRefreshAt = 0;
let forcedRefreshCount = 0;

/** Test hook: inject a JWKS document (bypasses the network fetch). */
export function __setOpenLineageJwksForTest(keys: JwksKey[] | null): void {
  jwksOverrideForTest = keys;
  jwksCache = null;
  unknownKids.clear();
  lastForcedRefreshAt = 0;
  forcedRefreshCount = 0;
}

/** Test hook: how many FORCED (unknown-kid) JWKS refetches ran. */
export function __openLineageForcedJwksRefreshCountForTest(): number {
  return forcedRefreshCount;
}

function authorityHost(): string {
  // Mirrors lib/auth/msal.ts authorityHost() — kept local so this verifier
  // (and its unit tests) never drag the MSAL SDK in.
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  return cloud === 'azureusgovernment'
    ? 'https://login.microsoftonline.us'
    : 'https://login.microsoftonline.com';
}

function pinnedTenant(): string {
  return (
    process.env.LOOM_ENTRA_TENANT_ID
    || process.env.LOOM_MSAL_TENANT_ID
    || process.env.AZURE_TENANT_ID
    || ''
  ).trim();
}

function allowedAudiences(): string[] {
  const out: string[] = [];
  const explicit = (process.env.LOOM_OPENLINEAGE_AUDIENCE || '').trim();
  if (explicit) out.push(explicit);
  // The console's MSAL app registration is the default audience (bicep-wired).
  const clientId = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  if (clientId) {
    out.push(clientId);
    out.push(`api://${clientId}`);
  }
  return out;
}

function allowedIssuers(tenant: string): string[] {
  return [
    // v2.0 tokens from the active cloud's authority.
    `${authorityHost()}/${tenant}/v2.0`,
    // v1.0 tokens (client-credential default for api:// audiences).
    `https://sts.windows.net/${tenant}/`,
  ];
}

function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Parse `a=b,c=d` (comma/whitespace-separated) pair lists. */
function parsePairs(raw: string): Array<{ key: string; value: string }> {
  return raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      if (i <= 0) return null;
      return { key: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
    })
    .filter((x): x is { key: string; value: string } => !!x && !!x.key && !!x.value);
}

function constantTimeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf-8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf-8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function loadJwks(tenant: string, forceRefresh = false): Promise<JwksKey[]> {
  if (jwksOverrideForTest) return jwksOverrideForTest;
  const now = Date.now();
  if (!forceRefresh && jwksCache && jwksCache.tenant === tenant && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const url = `${authorityHost()}/${tenant}/discovery/v2.0/keys`;
  const res = await fetchWithTimeout(url, { cache: 'no-store' }, 8000);
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const doc = (await res.json()) as { keys?: JwksKey[] };
  const keys = Array.isArray(doc.keys) ? doc.keys : [];
  jwksCache = { tenant, keys, fetchedAt: now };
  return keys;
}

/**
 * Resolve the signing key for `kid`, with the forced-refetch amplifier shut —
 * see {@link JWKS_FORCED_REFRESH_MIN_INTERVAL_MS}. `eligibleForRefresh` is set by
 * the caller only once issuer / audience / expiry already line up, so a garbage
 * token never reaches the network path; the interval + `unknownKids` memo bound
 * the rest.
 */
async function resolveSigningKey(
  tenant: string,
  kid: string | undefined,
  eligibleForRefresh: boolean,
): Promise<JwksKey | null> {
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

function verifyRs256(signingInput: string, signature: Buffer, jwk: JwksKey): boolean {
  try {
    const pub = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
    return crypto.verify('RSA-SHA256', Buffer.from(signingInput, 'utf-8'), pub, signature);
  } catch {
    return false;
  }
}

async function verifyEntraBearer(token: string): Promise<OpenLineageAuthResult> {
  const tenant = pinnedTenant();
  if (!tenant) {
    return {
      ok: false, status: 503,
      error: 'OpenLineage ingest (entra mode) is not configured — set LOOM_ENTRA_TENANT_ID (or AZURE_TENANT_ID) so the verifier can pin the estate tenant.',
    };
  }
  const audiences = allowedAudiences();
  if (!audiences.length) {
    return {
      ok: false, status: 503,
      error: 'OpenLineage ingest (entra mode) is not configured — set LOOM_MSAL_CLIENT_ID (or LOOM_OPENLINEAGE_AUDIENCE) so the verifier can pin the token audience.',
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
  if (header.alg !== 'RS256') return { ok: false, status: 401, error: 'unsupported token algorithm' };

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp || 0);
  const nbf = Number(payload.nbf || 0);
  const iss = String(payload.iss || '');
  const aud = String(payload.aud || '');
  // Cheap pre-flight over UNVERIFIED claims, used ONLY to decide whether this
  // token may trigger an outbound JWKS refetch. It does not short-circuit the
  // result: every check below still runs in its original order and returns its
  // original message, so no new "which field did I get right?" oracle appears.
  const claimsPlausible =
    !!exp && nowSec <= exp + CLOCK_SKEW_SEC
    && (!nbf || nowSec >= nbf - CLOCK_SKEW_SEC)
    && allowedIssuers(tenant).includes(iss)
    && audiences.includes(aud);

  // Signature — JWKS by kid, with the unknown-kid refetch throttled.
  let jwk: JwksKey | null;
  try {
    jwk = await resolveSigningKey(tenant, header.kid, claimsPlausible);
  } catch (e) {
    return { ok: false, status: 503, error: `could not load the AAD signing keys: ${(e as Error)?.message || e}` };
  }
  if (!jwk) return { ok: false, status: 401, error: 'unknown token signing key' };
  const sigOk = verifyRs256(`${parts[0]}.${parts[1]}`, b64url(parts[2]), jwk);
  if (!sigOk) return { ok: false, status: 401, error: 'invalid token signature' };

  // Temporal validity (±5 min skew).
  if (!exp || nowSec > exp + CLOCK_SKEW_SEC) return { ok: false, status: 401, error: 'token expired' };
  if (nbf && nowSec < nbf - CLOCK_SKEW_SEC) return { ok: false, status: 401, error: 'token not yet valid' };

  // Issuer pinned to the estate tenant (rejects foreign-tenant tokens).
  if (!allowedIssuers(tenant).includes(iss)) {
    return { ok: false, status: 401, error: 'token issuer is not the estate tenant' };
  }
  // Audience pinned to the console app registration.
  if (!audiences.includes(aud)) return { ok: false, status: 401, error: 'token audience mismatch' };

  // Principal → workspace registration (per-pool credential binding).
  const principal = String(payload.appid || payload.azp || payload.oid || '').toLowerCase();
  if (!principal) return { ok: false, status: 401, error: 'token carries no client principal (appid/azp/oid)' };
  const registrations = parsePairs(process.env.LOOM_OPENLINEAGE_POOL_PRINCIPALS || '');
  const match = registrations.find((r) => r.key.toLowerCase() === principal);
  if (!match) {
    return {
      ok: false, status: 403,
      error: `principal ${principal} is not registered for any workspace — run scripts/csa-loom/openlineage-pool-setup.sh (mints the per-pool credential and appends it to LOOM_OPENLINEAGE_POOL_PRINCIPALS).`,
    };
  }
  return { ok: true, workspaceId: match.value, principal, mode: 'entra' };
}

function verifyWorkspaceToken(token: string): OpenLineageAuthResult {
  const pairs = parsePairs(process.env.LOOM_OPENLINEAGE_WORKSPACE_TOKEN || '');
  if (!pairs.length) {
    return {
      ok: false, status: 503,
      error: 'OpenLineage ingest (workspace-token mode) is not configured — run scripts/csa-loom/openlineage-pool-setup.sh to mint a per-workspace token (stored as the LOOM_OPENLINEAGE_WORKSPACE_TOKEN secret).',
    };
  }
  // Evaluate EVERY pair (no early exit) so timing does not leak which
  // workspace matched; each compare is itself constant-time.
  let matched: string | null = null;
  for (const p of pairs) {
    if (constantTimeEquals(p.value, token)) matched = p.key;
  }
  if (!matched) return { ok: false, status: 401, error: 'invalid workspace token' };
  return { ok: true, workspaceId: matched, principal: `workspace-token:${matched}`, mode: 'workspace-token' };
}

/** The active verifier mode (`entra` default — never a global static secret). */
export function openLineageAuthMode(): 'entra' | 'workspace-token' {
  const raw = (process.env.LOOM_OPENLINEAGE_AUTH_MODE || 'entra').trim().toLowerCase();
  return raw === 'workspace-token' ? 'workspace-token' : 'entra';
}

/**
 * Verify the ingest credential presented on an OpenLineage POST. Accepts
 * `Authorization: Bearer <credential>` (the openlineage-spark http transport's
 * `auth.type=api_key` sends exactly this). Fail-closed in every unset state.
 */
export async function verifyOpenLineageAuth(authorizationHeader: string | null): Promise<OpenLineageAuthResult> {
  const bearer = (authorizationHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return { ok: false, status: 401, error: 'missing bearer credential' };
  return openLineageAuthMode() === 'workspace-token'
    ? verifyWorkspaceToken(bearer)
    : verifyEntraBearer(bearer);
}
