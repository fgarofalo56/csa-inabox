/**
 * purview-endpoints — the single source of truth for how a Microsoft Purview
 * (classic Data Map) data-plane BASE URL is derived, in every sovereign cloud.
 *
 * WHY THIS FILE EXISTS (Gov incident 2026-07-14)
 * ----------------------------------------------
 * The live Gov console governance gate reported:
 *   "The account name 'dmlz-dev-purview001' did not resolve as a classic
 *    Purview Data Map host (dmlz-dev-purview001.purview.azure.com): fetch failed"
 * The gate MESSAGE hard-coded the Commercial `.purview.azure.com` suffix, and
 * several routes/provisioners convention-built the host with the Commercial
 * suffix too — in Azure Government the classic Purview data plane is
 * `{account}.purview.azure.us` (Microsoft Learn:
 * purview/data-map-integration-runtime-self-hosted → networking table, and
 * azure/private-link/private-endpoint-dns → privatelink.purview.azure.us).
 *
 * Convention-building `{name}.purview.azure.{com|us}` is a HEURISTIC. The
 * AUTHORITATIVE endpoints live on the ARM resource itself:
 *   GET {armBase}/subscriptions/{sub}/resourceGroups/{rg}
 *       /providers/Microsoft.Purview/accounts/{name}?api-version=2021-12-01
 *   → properties.endpoints = { catalog, scan, guardian }
 * which is correct in every cloud (Commercial, GCC, GCC-High/IL5, DoD, China)
 * and for accounts with custom/private-link DNS. So this module resolves the
 * REAL endpoints from ARM (discovered by name via Azure Resource Graph across
 * every subscription the Console identity can read — same self-heal pattern as
 * resource-graph-coords.ts), caches them per process, and only falls back to
 * the CLOUD-AWARE convention host when the ARM read fails.
 *
 * Resolution order:
 *   1. LOOM_PURVIEW_ENDPOINT — explicit data-plane base URL override (wins).
 *   2. ARM-derived properties.endpoints.catalog origin (cached, TTL 15 min).
 *   3. Cloud-aware convention: https://{account}.purview.azure.{us|com}
 *      (negative-cached for 60 s so a transient ARM failure is retried).
 *
 * Token audience note: the Purview DATA-PLANE token resource is
 * `https://purview.azure.net` per Microsoft Learn (purview/data-gov-api-rest-
 * data-plane → "resource: https://purview.azure.net"); Learn documents no
 * Gov-specific audience, so the scope is cloud-invariant (unlike the host).
 */

import { armBase, armScope, isGovCloud } from './cloud-endpoints';
import { loomServerCredential } from '@/lib/azure/aca-managed-identity';
import { fetchWithTimeout } from './fetch-with-timeout';

const RESOURCE_GRAPH_API = '2022-10-01';
const PURVIEW_ARM_API = '2021-12-01';

/** How long a successful ARM-derived resolution stays cached (ms). */
const ARM_TTL_MS = 15 * 60 * 1000;
/** How long a convention fallback (ARM lookup failed) stays cached (ms). */
const FALLBACK_TTL_MS = 60 * 1000;

/**
 * Classic Purview data-plane hostname suffix (no leading dot, no account
 * prefix). Commercial / GCC → `purview.azure.com`; GCC-High / IL5 / DoD
 * (AzureUSGovernment) → `purview.azure.us`. Grounded in Microsoft Learn
 * (purview/data-map-integration-runtime-self-hosted networking table).
 */
export function purviewDataPlaneSuffix(): string {
  return isGovCloud() ? 'purview.azure.us' : 'purview.azure.com';
}

/**
 * Normalize a LOOM_PURVIEW_ACCOUNT value down to the short account name.
 * Tolerates a pasted full URL for the classic OR the `-api` host, in the
 * Commercial (`.purview.azure.com`), Gov (`.purview.azure.us`) and China
 * (`.purview.azure.cn`) clouds.
 */
export function normalizePurviewAccountName(raw: string): string {
  return (raw || '')
    .replace(/^https?:\/\//, '')
    .replace(/-api\.purview\.azure\.(com|us|cn).*$/, '')
    .replace(/\.purview\.azure\.(com|us|cn).*$/, '')
    .replace(/\/+$/, '');
}

/**
 * CLOUD-AWARE convention host — `https://{account}.purview.azure.{us|com}`.
 * This is the FALLBACK when the ARM read fails; prefer
 * `resolvePurviewEndpoints()` / `purviewBaseSync()` which return the
 * ARM-authoritative endpoint when available.
 */
export function purviewConventionBase(account: string): string {
  return `https://${normalizePurviewAccountName(account)}.${purviewDataPlaneSuffix()}`;
}

/**
 * Classic Purview portal deep-link to a catalog asset by GUID, on the
 * cloud-correct account host.
 */
export function purviewPortalAssetLink(account: string, guid: string): string {
  return `${purviewConventionBase(account)}/main.html#/asset/${encodeURIComponent(guid)}`;
}

export interface ResolvedPurviewEndpoints {
  /** Normalized short account name. */
  account: string;
  /** Data-plane base URL (origin, no trailing slash) all client paths hang off. */
  base: string;
  /** Raw ARM properties.endpoints values when the ARM read succeeded. */
  catalog?: string;
  scan?: string;
  guardian?: string;
  /** Where `base` came from. */
  source: 'env' | 'arm' | 'convention';
  /** Set when source === 'convention': why the ARM lookup did not produce endpoints. */
  armError?: string;
}

interface CacheEntry {
  value: ResolvedPurviewEndpoints;
  expires: number;
}

// Keyed by `${account}|${suffix}` so a cloud-env change (tests, config reload)
// never serves a stale cross-cloud base.
const cache = new Map<string, CacheEntry>();

function cacheKey(account: string): string {
  return `${account.toLowerCase()}|${purviewDataPlaneSuffix()}`;
}

/** Test-only: clear the per-process endpoint cache. */
export function __clearPurviewEndpointCache(): void {
  cache.clear();
}

function envOverride(account: string): ResolvedPurviewEndpoints | null {
  const explicit = (process.env.LOOM_PURVIEW_ENDPOINT || '').trim();
  if (!explicit) return null;
  let v = explicit.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  return { account, base: v, source: 'env' };
}

/**
 * Synchronous base-URL resolution for hot data-plane call paths:
 *   env override → cached ARM-derived base → cloud-aware convention host.
 * Never blocks on ARM; `resolvePurviewEndpoints()` (async, called by the
 * status probe) warms the cache so subsequent data-plane calls use the
 * ARM-authoritative endpoint.
 */
export function purviewBaseSync(rawAccount: string): string {
  const account = normalizePurviewAccountName(rawAccount);
  const env = envOverride(account);
  if (env) return env.base;
  const hit = cache.get(cacheKey(account));
  if (hit && hit.expires > Date.now()) return hit.value.base;
  return purviewConventionBase(account);
}

/**
 * Resolve the account's REAL data-plane endpoints from ARM (Resource Graph
 * discovery by name → properties.endpoints; ARM GET fallback when ARG returns
 * coordinates without properties). Cached per process. Falls back to the
 * cloud-aware convention host — with `armError` explaining why — when the ARM
 * read fails, so callers can surface an honest, diagnostic gate message.
 */
export async function resolvePurviewEndpoints(rawAccount: string): Promise<ResolvedPurviewEndpoints> {
  const account = normalizePurviewAccountName(rawAccount);
  const env = envOverride(account);
  if (env) return env;

  const key = cacheKey(account);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let armError: string | undefined;
  try {
    const resolved = await lookupViaArm(account);
    if (resolved) {
      cache.set(key, { value: resolved, expires: Date.now() + ARM_TTL_MS });
      return resolved;
    }
    armError = `no Microsoft.Purview/accounts resource named "${account}" was found via Azure Resource Graph in any subscription the Console identity can read`;
  } catch (e: any) {
    armError = e?.message || String(e);
  }

  const fallback: ResolvedPurviewEndpoints = {
    account,
    base: purviewConventionBase(account),
    source: 'convention',
    armError,
  };
  cache.set(key, { value: fallback, expires: Date.now() + FALLBACK_TTL_MS });
  return fallback;
}

/** Extract + validate `properties.endpoints` into a resolved record. */
function fromArmProperties(account: string, properties: any): ResolvedPurviewEndpoints | null {
  const endpoints = properties?.endpoints;
  const catalog = typeof endpoints?.catalog === 'string' ? endpoints.catalog : undefined;
  if (!catalog) return null;
  let base: string;
  try {
    base = new URL(catalog).origin;
  } catch {
    return null;
  }
  // Accounts upgraded to the NEW Purview platform report a tenant-scoped
  // `{guid}-api.purview-service.microsoft.com` host here. That host is NOT the
  // classic Data Map data plane this client speaks: it rejects the UAMI with a
  // bare 403 even when the collection metadata-policy roles are granted (seen
  // live 2026-07-15 on purview-csa-loom-eastus2 — the classic
  // `{account}.purview.azure.{com|us}` host answered 200 with the same token).
  // Prefer the classic convention host for those accounts.
  if (/-api\.purview-service\.microsoft\.com$/i.test(new URL(base).hostname)) {
    return {
      account,
      base: purviewConventionBase(account),
      catalog: undefined,
      scan: undefined,
      guardian: undefined,
      source: 'convention',
      armError: `ARM endpoints.catalog is the new-platform host (${base}) — using the classic Data Map convention host instead`,
    };
  }
  return {
    account,
    base,
    catalog,
    scan: typeof endpoints?.scan === 'string' ? endpoints.scan : undefined,
    guardian: typeof endpoints?.guardian === 'string' ? endpoints.guardian : undefined,
    source: 'arm',
  };
}

/**
 * ARM lookup: one Azure Resource Graph query (by name, across every readable
 * subscription — the resource typically lives in the DLZ sub, not the admin
 * sub) projecting the full `properties`; when ARG returns the row without
 * usable endpoints, a direct ARM GET on the discovered coordinates.
 * Returns null when the account is not found; throws on transport/auth errors.
 */
async function lookupViaArm(account: string): Promise<ResolvedPurviewEndpoints | null> {
  const token = await loomServerCredential.getToken(armScope());
  if (!token?.token) throw new Error('failed to acquire an ARM token for the Purview endpoint lookup');
  const base = armBase().replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' };

  const nameLit = account.replace(/'/g, "\\'");
  const query = [
    'Resources',
    `| where type =~ 'microsoft.purview/accounts' and name =~ '${nameLit}'`,
    '| project name, subscriptionId, resourceGroup, properties',
    '| limit 1',
  ].join('\n');

  const argRes = await fetchWithTimeout(
    `${base}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API}`,
    {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ query, options: { resultFormat: 'objectArray', $top: 1 } }),
    },
  );
  if (!argRes.ok) {
    throw new Error(`Resource Graph lookup answered ${argRes.status}`);
  }
  const argJson: any = await argRes.json().catch(() => null);
  const row = Array.isArray(argJson?.data) ? argJson.data[0] : undefined;
  if (!row) return null;

  const fromArg = fromArmProperties(account, row.properties);
  if (fromArg) return fromArg;

  // ARG row without usable endpoints — read the resource directly from ARM.
  const sub = row.subscriptionId ? String(row.subscriptionId) : '';
  const rg = row.resourceGroup ? String(row.resourceGroup) : '';
  if (!sub || !rg) return null;
  const armRes = await fetchWithTimeout(
    `${base}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Purview/accounts/${encodeURIComponent(account)}?api-version=${PURVIEW_ARM_API}`,
    { headers: auth },
  );
  if (!armRes.ok) throw new Error(`ARM GET Microsoft.Purview/accounts/${account} answered ${armRes.status}`);
  const armJson: any = await armRes.json().catch(() => null);
  return fromArmProperties(account, armJson?.properties);
}
