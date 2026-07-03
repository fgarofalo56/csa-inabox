/**
 * MSAL BFF (Backend-for-Frontend) configuration.
 *
 * Pattern: confidential client running server-side. Cookies stay
 * httpOnly + Secure + SameSite=Strict; access tokens never reach
 * the browser. Mirrors the ADR-0014 pattern from the parent csa-inabox
 * repo.
 *
 * Cloud detection: AAD authority differs per boundary.
 *   Commercial / GCC: login.microsoftonline.com
 *   GCC-High / IL5:   login.microsoftonline.us
 */

import {
  ConfidentialClientApplication,
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node';
import { getPbiScope } from '@/lib/azure/cloud-endpoints';

function authorityHost(): string {
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  return cloud === 'azureusgovernment'
    ? 'https://login.microsoftonline.us'
    : 'https://login.microsoftonline.com';
}

function getAuthority(tenantId?: string): string {
  const tid = tenantId || process.env.AZURE_TENANT_ID || 'common';
  return `${authorityHost()}/${tid}`;
}

// ---------------------------------------------------------------------------
// Distributed MSAL token-cache persistence (Cosmos-backed) — makes the silent
// SLIDING-session refresh reliable on a multi-replica / restarted deployment.
//
// WHY (the principal issue behind the "signed out after lunch" reports):
//   The confidential client's token cache — which holds each signed-in user's
//   long-lived (~24h) REFRESH token — lived ONLY in the process memory of
//   whichever replica served the login. loom-console runs minReplicas:2
//   (admin-plane/main.bicep) with Front Door session affinity DISABLED
//   (front-door.bicep) and NO ACA sticky sessions, so POST /api/auth/refresh
//   (and the keepalive ping, and every OBO/silent acquire) round-robins to a
//   DIFFERENT replica whose getTokenCache().getAllAccounts() is empty. The
//   refresh route then 401s {reauth:true} and the user is bounced to interactive
//   sign-in even though their refresh token is still alive — and a container
//   restart wiped every replica's cache the same way. The 8h sliding cookie
//   masks this for the first 8h, but the advertised "stay signed in all
//   afternoon via SILENT refresh" is not reliable without persisting the cache.
//
// WHAT:
//   An MSAL ICachePlugin that persists the serialized token cache to Cosmos,
//   PARTITIONED per user (one doc per oid = homeAccountId.split('.')[0] — the
//   same id the session cookie + the /api/auth/refresh account-match use),
//   encrypted at rest with the SAME SESSION_SECRET-derived AES-256-GCM helpers
//   the sibling user-token stores use (encryptAtRest/decryptAtRest in
//   lib/auth/session — they exist for exactly this). On ANY replica a refresh
//   first loads that user's persisted cache, so getAllAccounts() finds the
//   account and acquireTokenSilent re-slides the session without an interactive
//   bounce; the cache also survives container restarts.
//
// SAFETY / reversibility / no-regression:
//   - Reversible: no-op unless LOOM_COSMOS_ENDPOINT is set, and hard-disableable
//     via LOOM_MSAL_CACHE_PERSIST_ENABLED=false (reverts to today's pure
//     in-memory cache, byte-for-byte).
//   - No new crypto and no new container: reuses encryptAtRest and the
//     tenant-settings container (partition-by-oid), exactly like the ARM / SQL /
//     Power BI user-token stores. Tokens are NEVER logged and NEVER leave the
//     server — only the encrypted blob is stored.
//   - beforeCacheAccess MERGES the requesting user's persisted account INTO the
//     in-memory cache and NEVER wipes it: (a) when the request has no session
//     cookie — the login callback, whose post-exchange ARM/SQL/PBI/MCP captures
//     rely on the just-created account still being in memory; (b) when nothing
//     is persisted yet. This also sidesteps the shared-singleton race the stock
//     DistributedCachePlugin has — it REPLACES in-memory state on every access,
//     so two concurrent users on one replica would clobber each other; we only
//     ever ADD the requesting user's account.
//   - afterCacheAccess SPLITS the cache by oid and writes one single-account doc
//     per user, so a multi-account in-memory cache never cross-contaminates a
//     partition and no single doc approaches the Cosmos 2 MB item limit.
//
// Cosmos + session helpers are DYNAMICALLY imported inside the async plugin
// methods so msal.ts's STATIC import graph (shared by the lightweight sign-in /
// cli-session / setup-identity routes) stays free of the Cosmos client — the
// same discipline captureUserMcpOboTokens uses below.
// ---------------------------------------------------------------------------

/** Top-level sections of the MSAL serialized token cache. */
const CACHE_SECTIONS = ['Account', 'IdToken', 'AccessToken', 'RefreshToken', 'AppMetadata'] as const;
/** The sections whose entries carry a `home_account_id` (so they partition per user). */
const ACCOUNT_SCOPED_SECTIONS = ['Account', 'IdToken', 'AccessToken', 'RefreshToken'] as const;

interface MsalCacheDoc {
  id: string; // msalcache:<oid>
  tenantId: string; // == oid (tenant-settings partition key)
  kind: 'msalcache';
  enc: string; // AES-256-GCM(base64url) of the SINGLE-account serialized cache blob
  updatedAt: string;
}

/**
 * Whether the Cosmos-backed MSAL cache persistence is active. Off (pure
 * in-memory, today's behavior) when Cosmos isn't configured in this deployment
 * or when explicitly disabled — a single-flip kill switch for the auth path.
 */
function msalCachePersistEnabled(): boolean {
  if ((process.env.LOOM_MSAL_CACHE_PERSIST_ENABLED ?? 'true').toLowerCase() === 'false') return false;
  return !!process.env.LOOM_COSMOS_ENDPOINT;
}

/** oid (== session claims.oid) for a homeAccountId — the per-user partition key. */
function oidOfHomeAccountId(homeAccountId: string): string {
  return (homeAccountId || '').split('.')[0];
}

/**
 * Resolve the current request's user oid from the session cookie. Returns '' for
 * requests with no session (the login callback, before the cookie is set) or any
 * non-request context — in which case the plugin never wipes the in-memory cache.
 */
async function currentSessionOid(): Promise<string> {
  try {
    const { getSession } = await import('@/lib/auth/session');
    return getSession()?.claims.oid ?? '';
  } catch {
    return '';
  }
}

/** Read + decrypt the persisted single-account cache blob for a user (null on miss). */
async function loadMsalAccountBlob(oid: string): Promise<string | null> {
  try {
    const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
    const { decryptAtRest } = await import('@/lib/auth/session');
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(`msalcache:${oid}`, oid).read<MsalCacheDoc>();
    if (!resource || resource.kind !== 'msalcache') return null;
    return decryptAtRest(resource.enc);
  } catch {
    // Cold/unreachable Cosmos or a tampered blob → treat as "nothing persisted".
    return null;
  }
}

/** Encrypt + upsert one user's single-account cache blob. Best-effort (never throws). */
async function saveMsalAccountBlob(oid: string, blob: string): Promise<void> {
  try {
    const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
    const { encryptAtRest } = await import('@/lib/auth/session');
    const c = await tenantSettingsContainer();
    const doc: MsalCacheDoc = {
      id: `msalcache:${oid}`,
      tenantId: oid,
      kind: 'msalcache',
      enc: encryptAtRest(blob),
      updatedAt: new Date().toISOString(),
    };
    await c.items.upsert(doc);
  } catch {
    // A cache-persist failure must NEVER break login/refresh — silent acquire
    // just falls back to whatever this replica holds in memory.
  }
}

/** True when the serialized cache already contains an Account for `oid`. */
function blobHasOid(serialized: string, oid: string): boolean {
  try {
    const parsed = JSON.parse(serialized || '{}');
    const accounts = parsed.Account || {};
    for (const key of Object.keys(accounts)) {
      if (oidOfHomeAccountId(accounts[key]?.home_account_id) === oid) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Merge a persisted single-account blob INTO the current in-memory blob without
 * dropping any account already present (additive). `current` wins on key
 * collisions so a freshly-acquired in-memory access token is never overwritten
 * by a staler stored copy.
 */
function mergeCacheBlobs(stored: string, current: string): string {
  try {
    const s = JSON.parse(stored || '{}');
    const c = JSON.parse(current || '{}');
    const out: Record<string, unknown> = {};
    for (const section of CACHE_SECTIONS) {
      out[section] = { ...(s[section] || {}), ...(c[section] || {}) };
    }
    return JSON.stringify(out);
  } catch {
    return current || '{}';
  }
}

/**
 * Split a (possibly multi-account) serialized cache into one single-account blob
 * per oid. AppMetadata is per-app (no home_account_id) and is copied into every
 * bucket so each blob deserializes cleanly. App-only (client-credential) tokens
 * with no home_account_id are intentionally dropped — they're cheap to re-acquire
 * and stay in each replica's memory.
 */
function splitCacheByOid(serialized: string): Record<string, string> {
  const buckets: Record<string, Record<string, Record<string, unknown>>> = {};
  const ensure = (oid: string) => {
    if (!buckets[oid]) {
      buckets[oid] = {};
      for (const section of CACHE_SECTIONS) buckets[oid][section] = {};
    }
    return buckets[oid];
  };
  try {
    const parsed = JSON.parse(serialized || '{}');
    for (const section of ACCOUNT_SCOPED_SECTIONS) {
      const bag = parsed[section] || {};
      for (const key of Object.keys(bag)) {
        const oid = oidOfHomeAccountId(bag[key]?.home_account_id);
        if (!oid) continue;
        ensure(oid)[section][key] = bag[key];
      }
    }
    const appMetadata = parsed.AppMetadata || {};
    for (const oid of Object.keys(buckets)) {
      buckets[oid].AppMetadata = { ...appMetadata };
    }
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const oid of Object.keys(buckets)) result[oid] = JSON.stringify(buckets[oid]);
  return result;
}

/**
 * Cosmos-backed, per-user MSAL token-cache plugin. See the block comment above.
 * Every failure degrades to "use whatever this replica holds in memory" so a
 * token operation is never broken by the persistence layer.
 */
const cosmosTokenCachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
    if (!msalCachePersistEnabled()) return;
    const oid = await currentSessionOid();
    // No session cookie (login callback, before the cookie is set) → NEVER wipe
    // the in-memory cache; the post-exchange captures depend on the just-created
    // account still being in memory.
    if (!oid) return;
    try {
      const current = ctx.tokenCache.serialize();
      // Warm replica already holds this user → skip the Cosmos round-trip.
      if (blobHasOid(current, oid)) return;
      const stored = await loadMsalAccountBlob(oid);
      // Nothing persisted for this user → don't wipe; interactive reauth (if any)
      // will repopulate it.
      if (!stored) return;
      ctx.tokenCache.deserialize(mergeCacheBlobs(stored, current));
    } catch {
      // Never break a token operation on a cache-load failure.
    }
  },
  async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
    if (!msalCachePersistEnabled() || !ctx.cacheHasChanged) return;
    try {
      const buckets = splitCacheByOid(ctx.tokenCache.serialize());
      const oid = await currentSessionOid();
      // Refresh path (oid known): persist ONLY this user's partition so we never
      // clobber another user's (possibly fresher) doc. Login path (oid '' — no
      // cookie yet): persist every account present, which includes the account
      // just minted by acquireTokenByCode so a later cross-replica refresh finds
      // it.
      const targets = oid && buckets[oid] ? [oid] : Object.keys(buckets);
      await Promise.all(targets.map((k) => saveMsalAccountBlob(k, buckets[k])));
    } catch {
      // Best-effort persist — login/refresh proceed regardless.
    }
  },
};

const config: Configuration = {
  auth: {
    // Prefer LOOM_MSAL_CLIENT_ID (separate from AZURE_CLIENT_ID which is
    // the UAMI client id for DefaultAzureCredential). Fall back to
    // AZURE_CLIENT_ID for v1.x compat.
    clientId: process.env.LOOM_MSAL_CLIENT_ID || process.env.AZURE_CLIENT_ID || '',
    authority: getAuthority(),
    clientSecret: process.env.LOOM_MSAL_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET,
  },
  // Persist the token cache (per-user, encrypted) to Cosmos so silent refresh
  // works across replicas + restarts. No-op unless LOOM_COSMOS_ENDPOINT is set;
  // disable with LOOM_MSAL_CACHE_PERSIST_ENABLED=false. See the block above.
  cache: {
    cachePlugin: cosmosTokenCachePlugin,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => {
        if (level <= 1) console.error('[msal]', message);
      },
      piiLoggingEnabled: false,
      logLevel: 2,
    },
  },
};

let _client: ConfidentialClientApplication | null = null;
export function getMsalClient(): ConfidentialClientApplication {
  if (!_client) _client = new ConfidentialClientApplication(config);
  return _client;
}

/**
 * Public-client application for the OAuth 2.0 device-authorization grant
 * (RFC 8628). Used by `POST /api/auth/cli-session` so the `loom` CLI can
 * sign a human in from a terminal without a browser redirect — the same
 * interactive method `fab auth login` offers.
 *
 * Reuses the SAME `LOOM_MSAL_CLIENT_ID` app registration and the SAME
 * sovereign-cloud authority switch as the confidential client. No client
 * secret is sent (device code is a public-client flow); the Entra app must
 * have "Allow public client flows" enabled — see docs/fiab/MSAL-handoff.md.
 *
 * `tenantId` overrides the env default so a single deployment can mint CLI
 * sessions for a guest's home tenant when needed.
 */
let _publicClient: PublicClientApplication | null = null;
let _publicClientTenant: string | null = null;
export function getMsalPublicClient(tenantId?: string): PublicClientApplication {
  const tid = tenantId || process.env.AZURE_TENANT_ID || 'common';
  if (_publicClient && _publicClientTenant === tid) return _publicClient;
  _publicClient = new PublicClientApplication({
    auth: {
      clientId: process.env.LOOM_MSAL_CLIENT_ID || process.env.AZURE_CLIENT_ID || '',
      authority: getAuthority(tid),
    },
    system: config.system,
  });
  _publicClientTenant = tid;
  return _publicClient;
}

/**
 * Confidential client bound to an EXPLICIT service-principal credential
 * (client id + secret + tenant) supplied by the caller — used by the
 * non-interactive `loom auth login --service-principal` / CI path. This is
 * NOT the deployment's own app registration; it's whatever SP the operator
 * authenticates as, exactly like `fab auth login --service-principal`.
 */
export function getSpConfidentialClient(
  clientId: string,
  clientSecret: string,
  tenantId: string,
): ConfidentialClientApplication {
  return new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: getAuthority(tenantId),
    },
    system: config.system,
  });
}

/** Microsoft Graph base host for the active sovereign cloud (token audience). */
export function graphBase(): string {
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  return cloud === 'azureusgovernment'
    ? 'https://graph.microsoft.us'
    : 'https://graph.microsoft.com';
}

export interface UserClaims {
  oid: string;
  /**
   * Entra TENANT id (`tid` claim). Used to partition tenant-shared state
   * (feature grants) and to enforce the tenant boundary on shared workspace
   * reads (rel-T11). Optional so sessions minted before rel-T11 (which lacked
   * it) still decode; the tenant-scope helper falls back to `oid` when absent.
   */
  tid?: string;
  name: string;
  email?: string;
  upn: string;
  groups?: string[];
}

/**
 * Acquire a token on-behalf-of the calling user for the requested
 * downstream scope. The user's session token (a raw user assertion) is
 * exchanged for a new token scoped to (for example) Databricks SQL Warehouse /
 * Synapse / Power BI XMLA / ADX.
 *
 * POWER BI REMOTE MCP — which path mints the token:
 *   - DEFAULT Console path: it does NOT call this OBO exchange. The signed-in
 *     user's Power BI token is minted at login via
 *     `acquireTokenSilent({ account, scopes: pbiOboScopes() })` and cached
 *     (encrypted at rest) in the Cosmos pbi-user-token-store — the exact mirror
 *     of the SQL user-token store. The chat orchestrator / MCP client then reads
 *     that cached token back per-call (the session cookie holds claims only, not
 *     a raw assertion, so silent-then-cache is the only workable path there).
 *   - FALLBACK path: `acquireOboToken(userAssertion, pbiOboScopes())` — used
 *     only where a RAW user assertion is actually available (e.g. the
 *     internal-token MAF callback path), exchanging it on_behalf_of for the same
 *     Power BI delegated scopes.
 * Both are OPT-IN only (gated on LOOM_POWERBI_MCP_CLIENT_ID + the Power BI
 * tenant setting) and never run on a default code path — Loom's Azure-native
 * semantic-model / report authoring stays the default (no-fabric-dependency).
 */
export async function acquireOboToken(
  userAssertion: string,
  scopes: string[],
): Promise<string> {
  const client = getMsalClient();
  const result = await client.acquireTokenOnBehalfOf({
    oboAssertion: userAssertion,
    scopes,
  });
  if (!result?.accessToken) {
    throw new Error('OBO token acquisition failed');
  }
  return result.accessToken;
}

// ---------------------------------------------------------------------------
// Power BI remote-MCP delegated (OBO) scopes — opt-in only
// ---------------------------------------------------------------------------

/**
 * The three READ-ONLY Power BI delegated permissions the opt-in Power BI remote
 * MCP server (https://api.fabric.microsoft.com/v1/mcp/powerbi) requests
 * on-behalf-of the signed-in user: schema-aware QUERY of semantic models +
 * Copilot-powered DAX generation, all under the user's own RBAC. These are the
 * UNPREFIXED scope names; `pbiOboScopes()` prepends the sovereign-cloud-aware
 * resource audience. Kept in lock-step with `REMOTE_BUILTIN_MCP.delegatedScopes`
 * (lib/mcp/catalog.ts) — change both together.
 */
const PBI_DELEGATED_SCOPES = [
  'Dataset.Read.All',
  'MLModel.Execute.All',
  'Workspace.Read.All',
] as const;

/**
 * Resource-prefixed, sovereign-cloud-aware delegated scopes for the Power BI
 * remote MCP OBO exchange. On Commercial this is, e.g.:
 *   ['https://analysis.windows.net/powerbi/api/Dataset.Read.All',
 *    'https://analysis.windows.net/powerbi/api/MLModel.Execute.All',
 *    'https://analysis.windows.net/powerbi/api/Workspace.Read.All']
 * and on GCC / GCC-High / DoD the audience shifts to the matching
 * `analysis.usgovcloudapi.net` / `high.…` / `mil.…` host. The audience is
 * derived from the canonical gov-aware `getPbiScope()` (its `/.default` suffix
 * stripped) so the `analysis.* powerbi/api` host literal lives in exactly ONE
 * place (cloud-endpoints.ts) and every sovereign boundary resolves correctly.
 *
 * Single source of truth for the Power BI OBO scope strings so callers
 * (app/auth/callback's `acquireTokenSilent`, and the `acquireOboToken`
 * assertion-fallback above) don't duplicate them. OPT-IN only — invoked solely
 * when the Power BI remote MCP has been opted into (LOOM_POWERBI_MCP_CLIENT_ID +
 * the Power BI tenant setting); never on a default code path
 * (no-fabric-dependency).
 */
export function pbiOboScopes(): string[] {
  // getPbiScope() → 'https://<analysis-host>/powerbi/api/.default'; strip the
  // trailing '/.default' to recover the bare resource audience to prefix.
  const resource = getPbiScope().replace(/\/\.default$/i, '');
  // Power BI is now just the canonical specialization of the generalized
  // resource-prefixed scope builder below.
  return mcpOboScopes(resource, [...PBI_DELEGATED_SCOPES]);
}

// ---------------------------------------------------------------------------
// Remote Microsoft MCP servers — generalized per-user delegated (OBO) tokens
// ---------------------------------------------------------------------------
//
// GENERALIZES the Power BI login-time capture (captureUserPbiToken in
// app/auth/callback/route.ts) to EVERY opt-in remote Microsoft MCP server that
// authenticates with a per-USER delegated token — Azure Resource Manager, AI
// Foundry, Microsoft Graph / M365 / Teams / OneDrive-SharePoint, Sentinel, Admin
// Center, Dataverse — and Power BI itself. It is NOT a parallel system: it reuses
// the SAME confidential client (LOOM_MSAL_CLIENT_ID + the loom-msal-client-secret
// Key Vault secret) and the SAME acquireTokenSilent call Power BI uses, and
// persists through the SAME generalized per-(user, resource) store
// (lib/azure/mcp-obo-token-store, which routes ARM / SQL / Power BI back to their
// existing sibling stores and caches every other audience itself). The remote MCP
// client (lib/azure/mcp-client via buildMcpShim) later reads the token back per
// server via getUserOboToken(oid, oboResource), exactly as the Power BI row does.
//
// no-fabric-dependency: tokens are minted ONLY for servers an admin OPTED INTO
// (each entra-obo entry is gated on its enableEnv + the shared confidential
// client, and Power BI additionally on LOOM_POWERBI_MCP_CLIENT_ID). Microsoft
// Learn (auth 'none', the sole default-on server) needs no token and is skipped;
// GitHub (auth 'key-vault', a stored PAT) carries no Entra token and is skipped.
// No api.fabric / api.powerbi host is ever reached on a default path.
//
// no-vaporware: a REAL acquireTokenSilent against the server's REAL audience. Any
// failure (scope not consented, silent-acquire fails, store write fails) is
// swallowed per-server so login proceeds unchanged; the absence of a cached token
// is the signal for the remote MCP client's honest "sign in again / consent the
// server's scopes" gate (surfaced in the admin panel), never a silent mid-call
// failure and never a stored secret literal.

/**
 * Generalized resource-prefixed delegated-scope builder for the remote Microsoft
 * MCP servers. Given an OBO resource audience and the BARE scope names a server
 * requests, returns the fully-qualified scope URIs the per-user OBO exchange asks
 * for: `['<resource>/<scope>', ...]`. This is the generalization of
 * `pbiOboScopes()` (now `mcpOboScopes(<pbi resource>, PBI_DELEGATED_SCOPES)`) over
 * an arbitrary `(resource, scopes)` pair, so ARM / AI Foundry / Microsoft Graph /
 * Sentinel / Dataverse each request scopes on their OWN audience.
 *
 * A scope already absolute (contains '://') is passed through unchanged; the
 * resource's trailing slash is trimmed so `https://ai.azure.com/` + `.default`
 * yields `https://ai.azure.com/.default` (never a doubled slash). Mirrors the
 * catalog's `msRemoteMcpScopeUris()` derivation so the token minted here matches
 * the audience the remote MCP client presents.
 */
export function mcpOboScopes(resource: string, scopes: string[]): string[] {
  const base = (resource || '').trim().replace(/\/+$/, '');
  return (scopes || []).map((scope) =>
    scope.includes('://') ? scope : `${base}/${scope}`,
  );
}

/** Safe origin of a URL ('' on parse failure) — for per-org OBO audiences (Dataverse). */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Acquire a delegated (On-Behalf-Of the signed-in user) access token for an
 * arbitrary OBO `resource` + bare `scopes` via acquireTokenSilent on the EXISTING
 * confidential client — the generalization of the Power BI capture's
 * acquireTokenSilent call to any `(resource, scopes)`. The account must already be
 * in the shared client's token cache (true immediately after the auth-callback's
 * acquireTokenByCode). Returns the token + its expiry, or null on ANY failure
 * (scope not consented / silent-acquire fails) — never throws, so callers treat
 * it as best-effort exactly like the ARM / SQL / Power BI login captures.
 */
export async function acquireUserDelegatedToken(
  account: AccountInfo,
  resource: string,
  scopes: string[],
): Promise<{ accessToken: string; expiresOn: Date | null } | null> {
  try {
    const client = getMsalClient();
    const result = await client.acquireTokenSilent({
      account,
      scopes: mcpOboScopes(resource, scopes),
    });
    if (!result?.accessToken) return null;
    return { accessToken: result.accessToken, expiresOn: result.expiresOn ?? null };
  } catch {
    // Scope not consented / silent-acquire failed — the remote MCP client surfaces
    // an honest "sign in again / consent the server's scopes" gate.
    return null;
  }
}

/**
 * Best-effort login-time capture of the signed-in user's delegated tokens for
 * EVERY configured opt-in remote Microsoft MCP server that uses Entra OBO — the
 * generalization of captureUserPbiToken over the whole REMOTE_BUILTIN_MCP_CATALOG.
 * For each entra-obo entry whose `configured()` gate is satisfied it mints the
 * per-user token against that server's OWN audience and caches it via the
 * generalized mcp-obo-token-store (which routes ARM / SQL / Power BI back to their
 * existing sibling stores and caches everything else under its own
 * per-(resourceKey, oid) doc). Wire this into app/auth/callback alongside the
 * ARM / SQL / Power BI captures — same swallow-all contract; it NEVER blocks login.
 *
 * The catalog + store are dynamically imported so msal.ts's STATIC import graph
 * (shared by the lightweight sign-in / cli-session / setup-identity routes) stays
 * free of the Cosmos client; that cost is paid only at login, when this runs.
 *
 * Servers using auth 'none' (Microsoft Learn) or 'key-vault' (GitHub PAT) carry no
 * per-user Entra token and are skipped, as are unconfigured opt-in servers (no
 * token minted, no host reached) — no-fabric-dependency. Power BI is naturally
 * covered here (its projected entry is entra-obo, gated by isPbiMcpConfigured()),
 * so this is a superset of captureUserPbiToken; the per-resource store write is
 * idempotent, so running both is harmless.
 */
export async function captureUserMcpOboTokens(
  account: AccountInfo,
  oid: string,
): Promise<void> {
  if (!oid) return;
  try {
    const { REMOTE_BUILTIN_MCP_CATALOG } = await import('@/lib/mcp/catalog');
    const { saveUserOboToken } = await import('@/lib/azure/mcp-obo-token-store');
    for (const entry of REMOTE_BUILTIN_MCP_CATALOG) {
      // Only Entra-OBO servers mint a per-user delegated token here.
      if (entry.auth !== 'entra-obo') continue;
      // Opt-in gate: skip any server the admin hasn't enabled / endpoint-configured.
      if (!entry.configured()) continue;
      // Resolve the OBO audience: the entry's oboResource, or — for a per-org
      // server like Dataverse (oboResource '') — the configured endpoint origin,
      // matching the catalog's msRemoteMcpScopeUris() derivation so the token is
      // cached under the same resource the remote MCP client looks it up by.
      const resource = entry.oboResource?.trim() || originOf(entry.endpoint);
      if (!resource) continue;
      const minted = await acquireUserDelegatedToken(account, resource, entry.oboScopes ?? []);
      if (minted?.accessToken) {
        await saveUserOboToken(oid, resource, minted.accessToken, minted.expiresOn);
      }
    }
  } catch {
    // Catalog/store import or iteration failed — login MUST proceed unchanged.
  }
}
