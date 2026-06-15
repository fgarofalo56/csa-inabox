/**
 * Identity picker — Microsoft Graph client.
 *
 * Reusable user / group / service-principal search with transitive
 * nested-group resolution. Backs the <IdentityPicker> component and the
 * /api/governance/identities/search BFF route. Token acquisition uses the
 * Console UAMI via ChainedTokenCredential (same pattern as
 * mip-graph-client.ts / dlp-graph-client.ts):
 *   1. ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID }) — prod path
 *   2. DefaultAzureCredential — local dev / az login fallback
 *
 * Backing endpoints (Microsoft Graph v1.0 — available in ALL national clouds):
 *   GET /v1.0/users?$search="displayName:<q>" OR "userPrincipalName:<q>"
 *   GET /v1.0/groups?$search="displayName:<q>"
 *   GET /v1.0/servicePrincipals?$search="displayName:<q>"
 *   GET /v1.0/groups/{id}/transitiveMembers
 *
 * All $search calls send `ConsistencyLevel: eventual` — required by Graph for
 * tokenized full-text search on directory objects (without it Graph 400s).
 *
 * App permissions (admin-consent required, granted in post-deploy bootstrap):
 *   - User.Read.All         (df021288-bdef-4463-88db-98f22de89214)
 *   - Group.Read.All        (5b567255-7703-4780-807c-7be8301ae99b)
 *   - Application.Read.All  (9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30)
 *
 * Sovereign-cloud correctness: the Graph base AND token scope are both derived
 * from LOOM_GRAPH_BASE so GCC-High (graph.microsoft.us) and IL5/DoD
 * (dod-graph.microsoft.us) acquire a sovereign-scoped token rather than the
 * commercial `graph.microsoft.com/.default` audience. (The older
 * mip-graph-client / dlp-graph-client hard-code the commercial scope — that is
 * a known gov-cloud gap to fix separately; this client does NOT inherit it.)
 *
 * Env vars:
 *   LOOM_UAMI_CLIENT_ID          — UAMI client id (already wired by main bicep).
 *   LOOM_GRAPH_BASE              — sovereign Graph endpoint; defaults to
 *                                  https://graph.microsoft.com. Bicep injects
 *                                  graph.microsoft.us (GCC-High) /
 *                                  dod-graph.microsoft.us (IL5).
 *   LOOM_IDENTITY_PICKER_ENABLED — must be "true" to call live Graph. When
 *                                  unset, the BFF surfaces the NotConfigured
 *                                  hint naming the exact env var + AppRole grants.
 *   AZURE_CLOUD                  — AzureUSGovernment in gov clouds; used only to
 *                                  pick the correct admin-consent portal URL.
 *
 * Errors:
 *   - GraphIdentityNotConfiguredError (→ 503) — env not set; carries a hint
 *     with remediation (env var, the three AppRole grants, consent step).
 *   - GraphIdentityError (status N)   — Graph returned non-2xx (typically 403
 *     when the AppRole grants are missing / not yet consented).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

// ----------------------------------------------------------------------------
// Sovereign-correct base + scope derivation
// ----------------------------------------------------------------------------

const GRAPH_BASE = (process.env.LOOM_GRAPH_BASE || 'https://graph.microsoft.com').replace(/\/+$/, '');
const GRAPH_V1 = `${GRAPH_BASE}/v1.0`;
const GRAPH_SCOPE = `${GRAPH_BASE}/.default`;

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

export interface GraphIdentityNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; appRoleId: string; scope: string; reason: string }[];
  followUp: string;
}

export class GraphIdentityNotConfiguredError extends Error {
  hint: GraphIdentityNotConfiguredHint;
  constructor(hint: GraphIdentityNotConfiguredHint) {
    super(`Identity picker is not wired in this deployment: missing ${hint.missingEnvVar}`);
    this.name = 'GraphIdentityNotConfiguredError';
    this.hint = hint;
  }
}

export class GraphIdentityError extends Error {
  status: number;
  body: unknown;
  endpoint?: string;
  constructor(status: number, body: unknown, message?: string, endpoint?: string) {
    super(message || `Microsoft Graph identity call failed (${status})`);
    this.name = 'GraphIdentityError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

// Graph AppRole (application permission) ids — type=Role under the Graph SP's
// appRoles[]. Verified against the Microsoft Graph permissions reference and
// the existing principals route / grant-graph-approles.sh.
export const IDENTITY_APP_ROLES = [
  {
    name: 'User.Read.All',
    appRoleId: 'df021288-bdef-4463-88db-98f22de89214',
    scope: 'Microsoft Graph (app permission, admin-consented)',
    reason: 'Search users by displayName or userPrincipalName.',
  },
  {
    name: 'Group.Read.All',
    appRoleId: '5b567255-7703-4780-807c-7be8301ae99b',
    scope: 'Microsoft Graph (app permission, admin-consented)',
    reason: 'Search groups and expand transitive (nested) group members.',
  },
  {
    name: 'Application.Read.All',
    appRoleId: '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30',
    scope: 'Microsoft Graph (app permission, admin-consented)',
    reason: 'Search service principals / managed identities.',
  },
] as const;

function consentPortalUrl(): string {
  const cloud = (process.env.AZURE_CLOUD || '').toLowerCase();
  return cloud.includes('usgov') || cloud.includes('government')
    ? 'https://portal.azure.us'
    : 'https://portal.azure.com';
}

function notConfiguredHint(missing: string): GraphIdentityNotConfiguredHint {
  return {
    missingEnvVar: missing,
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/identity-graph-rbac.bicep',
    bicepStatus:
      'Set loomIdentityPickerEnabled=true in the admin-plane bicepparam (wires LOOM_IDENTITY_PICKER_ENABLED=true into the loom-console Container App env alongside LOOM_UAMI_CLIENT_ID).',
    rolesRequired: IDENTITY_APP_ROLES.map((r) => ({ ...r })),
    followUp:
      `Operator action: (1) set LOOM_IDENTITY_PICKER_ENABLED=true on the loom-console Container App ` +
      `(or loomIdentityPickerEnabled=true in the bicepparam + redeploy admin-plane), ` +
      `(2) run scripts/csa-loom/grant-identity-graph-approles.sh to grant the Console UAMI ` +
      `User.Read.All + Group.Read.All + Application.Read.All, ` +
      `(3) a Tenant Administrator grants admin consent at ${consentPortalUrl()} → Entra ID → ` +
      `Enterprise applications → Console UAMI → Permissions → "Grant admin consent". ` +
      `Until consented, every Graph call returns 403.`,
  };
}

function assertEnabled(): void {
  if (process.env.LOOM_IDENTITY_PICKER_ENABLED !== 'true') {
    throw new GraphIdentityNotConfiguredError(notConfiguredHint('LOOM_IDENTITY_PICKER_ENABLED'));
  }
}

// ----------------------------------------------------------------------------
// Low-level fetch
// ----------------------------------------------------------------------------

async function graphFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await credential.getToken(GRAPH_SCOPE);
  if (!token?.token) throw new GraphIdentityError(500, null, 'Failed to acquire Microsoft Graph token');
  const url = path.startsWith('http') ? path : `${GRAPH_V1}${path}`;
  return fetchWithTimeout(url, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token.token}`,
      accept: 'application/json',
      // Required for $search tokenized search on directory objects.
      ConsistencyLevel: 'eventual',
      'user-agent': 'CSA-Loom-Console/1.0',
    },
  });
}

async function readJson<T>(res: Response, endpoint: string): Promise<T | null> {
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (parsed as any)?.message ||
      (typeof parsed === 'string' ? parsed : `Microsoft Graph ${res.status}`);
    throw new GraphIdentityError(res.status, parsed, msg, endpoint);
  }
  return (parsed as T) ?? ({} as T);
}

// $search clause values are wrapped by Graph in double-quotes; strip embedded
// double-quotes and backslashes so the phrase can't break out of the clause.
function searchPhrase(q: string): string {
  return q.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type IdentityKind = 'user' | 'group' | 'spn';

export interface IdentityHit {
  id: string;
  type: IdentityKind;
  displayName: string;
  upn?: string;          // users only
  mail?: string;
  appId?: string;        // SPNs only
  spnType?: string;      // servicePrincipalType (Application, ManagedIdentity, …)
  description?: string;
}

function clampTop(top: number, max: number): number {
  if (!Number.isFinite(top) || top <= 0) return Math.min(20, max);
  return Math.min(Math.floor(top), max);
}

function odataTypeToKind(odataType: unknown): IdentityKind {
  const t = String(odataType || '').toLowerCase();
  if (t.includes('group')) return 'group';
  if (t.includes('serviceprincipal')) return 'spn';
  return 'user';
}

// ----------------------------------------------------------------------------
// Search — users
// ----------------------------------------------------------------------------

/**
 * Search users by display name OR userPrincipalName using Graph $search
 * (tokenized full-text — a real UPN substring returns the matching user,
 * unlike a pure startswith filter).
 *
 * Backing call: GET /v1.0/users?$search="displayName:<q>" OR "userPrincipalName:<q>"
 */
export async function searchUsers(q: string, top = 20): Promise<IdentityHit[]> {
  assertEnabled();
  const phrase = searchPhrase(q);
  if (phrase.length < 1) return [];
  const search = encodeURIComponent(`"displayName:${phrase}" OR "userPrincipalName:${phrase}" OR "mail:${phrase}"`);
  const endpoint =
    `/users?$search=${search}` +
    `&$select=id,displayName,userPrincipalName,mail` +
    `&$top=${clampTop(top, 50)}` +
    `&$count=true`;
  const res = await graphFetch(endpoint);
  const j = await readJson<{ value?: any[] }>(res, endpoint);
  return (j?.value || []).map((p): IdentityHit => ({
    id: p.id,
    type: 'user',
    displayName: p.displayName || p.userPrincipalName || p.id,
    upn: p.userPrincipalName,
    mail: p.mail,
  }));
}

// ----------------------------------------------------------------------------
// Search — groups
// ----------------------------------------------------------------------------

/**
 * Search groups by display name / description using Graph $search.
 *
 * Backing call: GET /v1.0/groups?$search="displayName:<q>"
 */
export async function searchGroups(q: string, top = 20): Promise<IdentityHit[]> {
  assertEnabled();
  const phrase = searchPhrase(q);
  if (phrase.length < 1) return [];
  const search = encodeURIComponent(`"displayName:${phrase}" OR "description:${phrase}" OR "mail:${phrase}"`);
  const endpoint =
    `/groups?$search=${search}` +
    `&$select=id,displayName,description,mail` +
    `&$top=${clampTop(top, 50)}` +
    `&$count=true`;
  const res = await graphFetch(endpoint);
  const j = await readJson<{ value?: any[] }>(res, endpoint);
  return (j?.value || []).map((p): IdentityHit => ({
    id: p.id,
    type: 'group',
    displayName: p.displayName || p.id,
    mail: p.mail,
    description: p.description,
  }));
}

// ----------------------------------------------------------------------------
// Search — service principals
// ----------------------------------------------------------------------------

/**
 * Search service principals (apps + managed identities) by display name.
 *
 * Backing call: GET /v1.0/servicePrincipals?$search="displayName:<q>"
 */
export async function searchServicePrincipals(q: string, top = 20): Promise<IdentityHit[]> {
  assertEnabled();
  const phrase = searchPhrase(q);
  if (phrase.length < 1) return [];
  const search = encodeURIComponent(`"displayName:${phrase}" OR "description:${phrase}"`);
  const endpoint =
    `/servicePrincipals?$search=${search}` +
    `&$select=id,displayName,appId,servicePrincipalType,description` +
    `&$top=${clampTop(top, 50)}` +
    `&$count=true`;
  const res = await graphFetch(endpoint);
  const j = await readJson<{ value?: any[] }>(res, endpoint);
  return (j?.value || []).map((p): IdentityHit => ({
    id: p.id,
    type: 'spn',
    displayName: p.displayName || p.appId || p.id,
    appId: p.appId,
    spnType: p.servicePrincipalType,
    description: p.description,
  }));
}

// ----------------------------------------------------------------------------
// Search — all kinds (parallel)
// ----------------------------------------------------------------------------

/**
 * Search users + groups + service principals in parallel and merge. Each kind
 * is independent — if one Graph permission is missing (e.g. Application.Read.All
 * not yet consented) the other kinds still return. If ALL three fail, the first
 * error is re-thrown so the route can surface the honest gate.
 */
export async function searchAll(q: string, topPerKind = 10): Promise<IdentityHit[]> {
  assertEnabled();
  const phrase = searchPhrase(q);
  if (phrase.length < 1) return [];
  const settled = await Promise.allSettled([
    searchUsers(phrase, topPerKind),
    searchGroups(phrase, topPerKind),
    searchServicePrincipals(phrase, topPerKind),
  ]);
  const hits: IdentityHit[] = [];
  const seen = new Set<string>();
  let firstError: unknown = undefined;
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      for (const h of r.value) {
        if (h?.id && !seen.has(h.id)) { seen.add(h.id); hits.push(h); }
      }
    } else if (firstError === undefined) {
      firstError = r.reason;
    }
  }
  if (hits.length === 0 && firstError !== undefined) throw firstError;
  return hits;
}

// ----------------------------------------------------------------------------
// Transitive group membership (nested-group resolution)
// ----------------------------------------------------------------------------

/**
 * Resolve all transitive (nested) members of a group — users, nested groups,
 * service principals, devices — flattened into a single list. This is the
 * nesting-resolution capability: a member that is itself a group is expanded
 * recursively by Graph server-side.
 *
 * Backing call: GET /v1.0/groups/{id}/transitiveMembers
 * Paginated via @odata.nextLink up to `max` results.
 */
export async function getGroupTransitiveMembers(groupId: string, max = 200): Promise<IdentityHit[]> {
  assertEnabled();
  if (!groupId) throw new GraphIdentityError(400, null, 'groupId is required');
  const pageSize = Math.min(Math.max(max, 1), 999);
  let endpoint =
    `/groups/${encodeURIComponent(groupId)}/transitiveMembers` +
    `?$select=id,displayName,userPrincipalName,mail,appId,servicePrincipalType` +
    `&$top=${pageSize}`;
  const out: IdentityHit[] = [];
  const seen = new Set<string>();
  // Bound the page-walk so a huge group can't run unbounded.
  for (let guard = 0; guard < 25 && endpoint && out.length < max; guard++) {
    const res = await graphFetch(endpoint);
    const j = await readJson<{ value?: any[]; '@odata.nextLink'?: string }>(res, endpoint);
    for (const m of j?.value || []) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      const kind = odataTypeToKind(m['@odata.type']);
      out.push({
        id: m.id,
        type: kind,
        displayName: m.displayName || m.userPrincipalName || m.appId || m.id,
        upn: m.userPrincipalName,
        mail: m.mail,
        appId: m.appId,
        spnType: m.servicePrincipalType,
      });
      if (out.length >= max) break;
    }
    endpoint = j?.['@odata.nextLink'] || '';
  }
  return out;
}

/**
 * Bulk-resolve Entra group display names by object ID. Used at tenant-settings
 * load time to turn the stored scope `groupIds` back into display names without
 * N serial GET /groups/{id} calls.
 *
 * Backing call: POST /v1.0/directoryObjects/getByIds with types=['group'] —
 * available in all national clouds. Security groups only (types filter), which
 * matches Fabric's tenant-setting group restriction. Individual missing /
 * inaccessible IDs are silently skipped (partial result), never an error.
 */
export async function getGroupsByIds(ids: string[]): Promise<IdentityHit[]> {
  assertEnabled();
  const unique = [...new Set((ids || []).filter(Boolean))].slice(0, 1000);
  if (unique.length === 0) return [];
  const endpoint = '/directoryObjects/getByIds';
  const out: IdentityHit[] = [];
  const seen = new Set<string>();
  // getByIds accepts at most 1000 ids per call; chunk to be safe.
  for (let i = 0; i < unique.length; i += 1000) {
    const batch = unique.slice(i, i + 1000);
    const res = await graphFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: batch, types: ['group'] }),
    });
    const j = await readJson<{ value?: any[] }>(res, endpoint);
    for (const p of j?.value || []) {
      if (!p?.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({
        id: p.id,
        type: 'group',
        displayName: p.displayName || p.id,
        mail: p.mail,
        description: p.description,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Users + licenses (F17 — Users & licenses admin surface)
// ----------------------------------------------------------------------------
//
// These two functions back the /admin/users grid + license roll-up. Unlike the
// identity-picker search functions above (gated on LOOM_IDENTITY_PICKER_ENABLED),
// they are gated on LOOM_GRAPH_USERS_ENABLED — the same flag the existing
// /api/admin/users enrichment uses — so the admin page lights up license data
// the moment Directory.Read.All + User.Read.All land on the Console UAMI, with
// no separate identity-picker opt-in. Both swallow errors and return empty
// results when Graph is not configured / not reachable, so the Cosmos-primary
// path in the route always still renders.

export interface GraphUserWithLicenses {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  department?: string;
  accountEnabled?: boolean;
  /** Raw assignedLicenses from Graph — each skuId joins to subscribedSkus.skuId. */
  assignedLicenses: Array<{ skuId: string; disabledPlans: string[] }>;
}

export interface TenantSubscribedSku {
  skuId: string;
  skuPartNumber: string;
  consumedUnits: number;
  prepaidUnits: { enabled: number; suspended: number; warning: number };
  /** 'Enabled' | 'LockedOut' | 'Warning' | 'Suspended' | 'Deleted' | … */
  capabilityStatus: string;
}

/**
 * Fetch all tenant subscribed SKUs (license plans) — one call per page load.
 *
 * Backing call:
 *   GET /v1.0/subscribedSkus
 *     ?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits,capabilityStatus
 * Permission: Directory.Read.All (already granted by grant-uami-graph-roles.sh;
 *   LicenseAssignment.Read.All is the least-privileged alternative — Directory
 *   .Read.All is a superset that also covers this read).
 * Available in: Commercial, GCC, GCC-High (L4), DoD (L5) — all national clouds.
 * Gated: LOOM_GRAPH_USERS_ENABLED=true (NOT LOOM_IDENTITY_PICKER_ENABLED).
 * Returns [] and swallows errors when Graph is not configured / not reachable.
 */
export async function fetchSubscribedSkus(): Promise<TenantSubscribedSku[]> {
  if (process.env.LOOM_GRAPH_USERS_ENABLED !== 'true') return [];
  try {
    const endpoint =
      '/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits,capabilityStatus';
    const res = await graphFetch(endpoint);
    const j = await readJson<{ value?: any[] }>(res, endpoint);
    return (j?.value || []).map((sku): TenantSubscribedSku => ({
      skuId: sku.skuId,
      skuPartNumber: sku.skuPartNumber,
      consumedUnits: sku.consumedUnits ?? 0,
      prepaidUnits: {
        enabled: sku.prepaidUnits?.enabled ?? 0,
        suspended: sku.prepaidUnits?.suspended ?? 0,
        warning: sku.prepaidUnits?.warning ?? 0,
      },
      capabilityStatus: sku.capabilityStatus ?? 'Unknown',
    }));
  } catch {
    return [];
  }
}

/**
 * Batch-fetch Entra user records for a given list of UPNs, including
 * assignedLicenses, accountEnabled, and the objectId needed for M365 admin
 * deep-links and workspace-roles joins.
 *
 * Uses 15-UPN-per-filter chunking (Graph $filter OR-chain limit). Returns a Map
 * keyed by lowercase UPN.
 *
 * Backing call:
 *   GET /v1.0/users
 *     ?$select=id,userPrincipalName,displayName,department,accountEnabled,assignedLicenses
 *     &$filter=userPrincipalName eq '…' or …&$count=true
 * Permission: User.Read.All (already granted).
 * ConsistencyLevel: eventual — sent by graphFetch on every call (required for
 *   $count=true + $filter on directory properties).
 * Gated: LOOM_GRAPH_USERS_ENABLED=true.
 */
export async function listUsersWithLicenses(
  upns: string[],
): Promise<Map<string, GraphUserWithLicenses>> {
  const out = new Map<string, GraphUserWithLicenses>();
  if (!upns.length || process.env.LOOM_GRAPH_USERS_ENABLED !== 'true') return out;
  try {
    for (let i = 0; i < upns.length; i += 15) {
      const slice = upns.slice(i, i + 15);
      const filter = slice
        .map((u) => `userPrincipalName eq '${u.replace(/'/g, "''")}'`)
        .join(' or ');
      const endpoint =
        `/users?$select=id,userPrincipalName,displayName,department,accountEnabled,assignedLicenses` +
        `&$filter=${encodeURIComponent(filter)}&$count=true`;
      const res = await graphFetch(endpoint);
      const j = await readJson<{ value?: any[] }>(res, endpoint);
      for (const u of j?.value || []) {
        if (!u.userPrincipalName) continue;
        out.set(u.userPrincipalName.toLowerCase(), {
          id: u.id,
          userPrincipalName: u.userPrincipalName,
          displayName: u.displayName,
          department: u.department,
          accountEnabled: u.accountEnabled,
          assignedLicenses: u.assignedLicenses || [],
        });
      }
    }
  } catch {
    /* Graph optional — return whatever accumulated */
  }
  return out;
}

// Test-only: expose internal helpers for unit tests.
export const __testing = {
  notConfiguredHint,
  assertEnabled,
  searchPhrase,
  odataTypeToKind,
  GRAPH_BASE,
  GRAPH_SCOPE,
};
