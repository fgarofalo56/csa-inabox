/**
 * Generalized per-(user, resource) delegated-token store for the remote
 * Microsoft MCP servers (Microsoft Learn, Azure Resource Manager, AI Foundry,
 * Microsoft Graph / M365 / Teams / OneDrive-SharePoint, Sentinel, Admin Center,
 * and the existing opt-in Power BI remote MCP).
 *
 * WHY THIS EXISTS — generalizing the Power BI plumbing, NOT a parallel system:
 *   The committed Power BI remote MCP caches the signed-in user's delegated
 *   Power BI access token (the `analysis.windows.net/powerbi/api` audience) in
 *   `pbi-user-token-store.ts`, keyed by oid, so the remote MCP client can call
 *   On-Behalf-Of the USER's own RBAC. That store hard-codes exactly one audience.
 *   The new remote Microsoft MCP servers each need their OWN delegated audience —
 *   ARM (`https://management.azure.com`), Foundry (`https://ai.azure.com`),
 *   Graph (`https://graph.microsoft.com`), Sentinel, etc. — so this store
 *   generalizes the same mechanism to a (oid, resourceKey) key:
 *
 *       getUserOboToken(oid, oboResource)   // read a still-valid delegated token
 *       saveUserOboToken(oid, oboResource, token, expiresOn)
 *
 *   `oboResource` is the McpServerConfig.oboResource audience the server carries
 *   (lib/types/mcp-config.ts). buildMcpShim (lib/azure/mcp-shim.ts) — generalized
 *   to look the per-user token up by the server's oboResource instead of always
 *   calling getPbiUserToken — threads the result through listMcpTools/callMcpTool
 *   as the per-user `userToken`, exactly as the Power BI row does today. No new
 *   client, no new loop, no second container.
 *
 * BACK-COMPAT — NO MIGRATION, NO DOUBLE-STORAGE:
 *   Three audiences are ALREADY cached at login (app/auth/callback/route.ts) by
 *   dedicated sibling stores, and we MUST keep reading/writing those same docs so
 *   the existing login flow stays the single source of truth:
 *     - Power BI  (`analysis.<cloud>/powerbi/api`) → pbi-user-token-store
 *     - ARM       (`management.<cloud>`)           → user-token-store
 *     - Azure SQL (`database.<cloud>`)             → sql-user-token-store
 *   For those, getUserOboToken/saveUserOboToken DELEGATE to the existing store
 *   (so e.g. an ARM-audience Microsoft MCP server works day-one from the token
 *   the login already cached at `usertoken:<oid>` — no extra consent, no parallel
 *   doc). Every OTHER audience (Graph / Foundry / Sentinel / M365 / Teams /
 *   OneDrive-SharePoint / Admin Center) is cached HERE, generically, one doc per
 *   (resourceKey, oid).
 *
 * NO-FABRIC-DEPENDENCY: this file only ever caches a delegated token that an
 * admin OPTED INTO (each remote MS MCP server is opt-in + endpoint/scope gated).
 * It never reaches a Fabric / Power BI host itself — it stores the token the MCP
 * client later presents. Microsoft Learn, the sole default-on server, needs NO
 * auth at all, so it never touches this store.
 *
 * SECURITY (identical to the sibling stores):
 *   - Tokens are encrypted AT REST with AES-256-GCM (a key derived from
 *     SESSION_SECRET via a distinct HKDF label — see lib/auth/session.ts).
 *   - They are NEVER returned to the browser; only server-side MCP/copilot code
 *     reads them and hands them straight to the outbound MCP request.
 *   - They are NEVER logged. There is NO static secret on the McpServerConfig doc
 *     for entra-obo — the only persisted material is this encrypted token cache.
 *
 * STORAGE: one doc per (resourceKey, user) in the Cosmos `tenant-settings`
 * container (partition key /tenantId), id `oboutok:<resourceKey>:<oid>`,
 * partition = oid — the same reuse-an-existing-container, partition-by-oid trick
 * the ARM / SQL / Power BI token stores use, so no new container is provisioned.
 *
 * EXPIRY: delegated access tokens live ~60–90 min. We store the expiry and treat
 * the token as missing once it's within a 60s safety margin of expiring, so
 * callers surface an honest "sign in again / consent the server's scopes" gate
 * rather than failing mid-call.
 *
 * BEST-EFFORT WRITE: saveUserOboToken swallows its own errors and degrades to
 * "no cached token" rather than throwing — login / token-refresh MUST keep
 * working even when a given scope wasn't consented or Cosmos is down.
 */
import { tenantSettingsContainer } from './cosmos-client';
import { encryptAtRest, decryptAtRest } from '@/lib/auth/session';
import { getPbiUserToken, savePbiUserToken } from './pbi-user-token-store';
import { getUserArmToken, saveUserToken } from './user-token-store';
import { getUserSqlToken, saveUserSqlToken } from './sql-user-token-store';

const SAFETY_MARGIN_MS = 60_000;

/**
 * Canonical OBO resource audiences for the remote Microsoft MCP servers. These
 * are the strings the matching McpServerConfig.oboResource carries (and what
 * lib/mcp/catalog.ts pins). Commercial hosts; the classifier below matches the
 * sovereign-cloud variants (usgovcloudapi / .us / chinacloudapi) by host stem so
 * GCC / GCC-High / DoD resolve through the same delegation.
 */
export const OBO_RESOURCE = {
  /** Power BI data-plane — delegated to pbi-user-token-store (login-cached). */
  powerbi: 'https://analysis.windows.net/powerbi/api',
  /** Azure Resource Manager — delegated to user-token-store (login-cached). */
  arm: 'https://management.azure.com',
  /** Azure SQL / Synapse SQL — delegated to sql-user-token-store (login-cached). */
  sql: 'https://database.windows.net',
  /** Microsoft Graph (M365 / Teams / OneDrive-SharePoint / Admin Center). */
  graph: 'https://graph.microsoft.com',
  /** Azure AI Foundry remote MCP (cognitive-services audience). */
  foundry: 'https://ai.azure.com',
} as const;

/**
 * Normalize an OBO resource audience (or an already-normalized key) into a
 * stable, doc-id-safe slug. Idempotent: a raw URI
 * (`https://management.azure.com/`) and the slug it produces
 * (`management_azure_com`) both map to the same key, so callers may pass either
 * McpServerConfig.oboResource or a precomputed McpServerConfig.oboResourceKey.
 * Single source of truth for the key derivation so the shim/orchestrator and
 * this store never disagree on the cache key.
 */
export function oboResourceKey(resource: string): string {
  return (resource || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

type DelegatedAudience = 'powerbi' | 'arm' | 'sql' | 'generic';

/**
 * Classify a normalized resource key into one of the three login-cached
 * audiences (delegated to their existing sibling store) or `generic` (cached in
 * this store's own Cosmos doc). Host-stem matching keeps the sovereign clouds
 * (analysis.usgovcloudapi.net, management.usgovcloudapi.net, database.*, etc.)
 * routing to the same delegate as Commercial. Short symbolic aliases
 * (`powerbi` / `arm` / `sql`) are also honored for callers that key by alias.
 */
function classify(key: string): DelegatedAudience {
  if (!key) return 'generic';
  // Power BI: any analysis.*/powerbi/api host → `..._powerbi_api`, the catalog
  // slug `powerbiremote`, or the bare alias `powerbi`.
  if (key.includes('powerbi')) return 'powerbi';
  // ARM: management.azure.com / management.usgovcloudapi.net / management.azure.us
  // / management.core.windows.net → `management_*`; alias `arm`.
  if (key === 'arm' || key.startsWith('management_')) return 'arm';
  // Azure SQL / Synapse SQL: database.windows.net / database.usgovcloudapi.net →
  // `database_*`; aliases `sql` / `azuresql`.
  if (key === 'sql' || key === 'azuresql' || key.startsWith('database_')) return 'sql';
  return 'generic';
}

interface OboUserTokenDoc {
  id: string; // oboutok:<resourceKey>:<oid>
  tenantId: string; // == oid (partition key)
  kind: 'oboutok';
  resourceKey: string; // normalized OBO resource key (oboResourceKey)
  enc: string; // AES-256-GCM(base64url) of the raw delegated access token
  expiresOn: number; // unix ms — when the token itself expires
  updatedAt: string;
}

function docId(resourceKey: string, oid: string): string {
  return `oboutok:${resourceKey}:${oid}`;
}

/**
 * Persist the user's delegated access token (encrypted) for `resource`, for
 * later server-side use by the remote MS MCP client. For the three login-cached
 * audiences this delegates to the existing sibling store (one source of truth,
 * no migration); every other audience is upserted into this store's own Cosmos
 * doc. Best-effort: returns false instead of throwing on any failure so the
 * caller (auth callback / token refresh) can proceed regardless of whether the
 * scope was consented.
 */
export async function saveUserOboToken(
  oid: string,
  resource: string,
  token: string,
  expiresOn: Date | number | null | undefined,
): Promise<boolean> {
  if (!oid || !resource || !token) return false;
  const key = oboResourceKey(resource);
  switch (classify(key)) {
    case 'powerbi':
      return savePbiUserToken(oid, token, expiresOn);
    case 'arm':
      return saveUserToken(oid, token, expiresOn);
    case 'sql':
      return saveUserSqlToken(oid, token, expiresOn);
    default:
      break;
  }
  try {
    const expMs =
      expiresOn instanceof Date
        ? expiresOn.getTime()
        : typeof expiresOn === 'number'
          ? expiresOn
          : Date.now() + 60 * 60 * 1000; // default 60m if MSAL didn't give one
    const c = await tenantSettingsContainer();
    const doc: OboUserTokenDoc = {
      id: docId(key, oid),
      tenantId: oid,
      kind: 'oboutok',
      resourceKey: key,
      enc: encryptAtRest(token),
      expiresOn: expMs,
      updatedAt: new Date().toISOString(),
    };
    await c.items.upsert(doc);
    return true;
  } catch {
    // Never surface — login/refresh must not break on a cache write failure.
    return false;
  }
}

/**
 * Return a still-valid cached delegated access token for the user + `resource`,
 * or null if there is no token, it's expired (within the safety margin), or
 * anything goes wrong. For the three login-cached audiences this reads back
 * through the existing sibling store; every other audience reads this store's
 * own Cosmos doc. The raw token is decrypted only here, server-side, and handed
 * straight to the outbound MCP request (Authorization: Bearer) by the caller —
 * a null result is the signal for the honest "sign in again / consent the
 * server's scopes" MessageBar gate (no-vaporware).
 */
export async function getUserOboToken(oid: string, resource: string): Promise<string | null> {
  if (!oid || !resource) return null;
  const key = oboResourceKey(resource);
  switch (classify(key)) {
    case 'powerbi':
      return getPbiUserToken(oid);
    case 'arm':
      return getUserArmToken(oid);
    case 'sql':
      return getUserSqlToken(oid);
    default:
      break;
  }
  try {
    const c = await tenantSettingsContainer();
    const { resource: doc } = await c.item(docId(key, oid), oid).read<OboUserTokenDoc>();
    if (!doc || doc.kind !== 'oboutok') return null;
    if (!doc.expiresOn || doc.expiresOn - SAFETY_MARGIN_MS <= Date.now()) return null;
    const tok = decryptAtRest(doc.enc);
    return tok || null;
  } catch {
    return null;
  }
}
