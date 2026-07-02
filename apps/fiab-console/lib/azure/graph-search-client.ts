/**
 * Microsoft Graph grounding search — the backend for the data-agent
 * `microsoft-graph` source type (site / drive / mail scopes).
 *
 * Real Microsoft Graph v1.0 REST only (no SDK, no mocks), on the Console
 * UAMI → DefaultAzureCredential chain, sovereign-correct via the shared
 * `graphBase()`/`graphScope()` helpers (Commercial graph.microsoft.com,
 * GCC-High/IL5 graph.microsoft.us). Per .claude/rules/no-vaporware.md the only
 * non-functional state is an honest gate: a 401/403 from Graph throws
 * {@link GraphSearchAccessError} whose message names the EXACT app-role consent
 * missing, and the data-agent executor surfaces it verbatim in the tool trace.
 *
 * Endpoints used (all support application permissions, admin-consented):
 *   site  scope: GET /sites/{site-id}/drive/root/search(q='…')      Sites.Read.All + Files.Read.All
 *   drive scope: GET /drives/{drive-id}/root/search(q='…')          Files.Read.All
 *   mail  scope: GET /users/{mailbox}/messages?$search="…"          Mail.Read
 * (`POST /search/query` is NOT used for mail — message search there is
 * delegated-only; the per-mailbox $search endpoint works app-only.)
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { graphBase, graphScope } from './cloud-endpoints';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ----------------------------------------------------------------------------
// Scope + errors
// ----------------------------------------------------------------------------

export type GraphGroundingScopeKind = 'site' | 'drive' | 'mail';

export interface GraphGroundingScope {
  kind: GraphGroundingScopeKind;
  /** SharePoint site id (`host,siteGuid,webGuid`) or full https site URL. */
  site?: string;
  /** Microsoft Graph drive id. */
  driveId?: string;
  /** Mailbox UPN / user id (mail scope). */
  mailbox?: string;
}

/** Graph app-role consent each scope needs (application permissions). */
export const GRAPH_GROUNDING_ROLES: Record<GraphGroundingScopeKind, string[]> = {
  site: ['Sites.Read.All', 'Files.Read.All'],
  drive: ['Files.Read.All'],
  mail: ['Mail.Read'],
};

/**
 * 401/403 from Graph — the tenant app (Console UAMI service principal) lacks
 * the admin-consented app role for this scope. The message is the honest gate
 * the editor / tool trace shows.
 */
export class GraphSearchAccessError extends Error {
  status: number;
  code = 'graph_access_denied';
  constructor(scopeKind: GraphGroundingScopeKind, status: number, detail?: string) {
    const roles = GRAPH_GROUNDING_ROLES[scopeKind].join(' + ');
    super(
      `Microsoft Graph denied the ${scopeKind} search (${status}). Grant the Console UAMI the ` +
      `${roles} Microsoft Graph application permission(s) and have a tenant admin consent them ` +
      `(Entra ID → Enterprise applications → Console UAMI → Permissions → “Grant admin consent”; ` +
      `scripts/csa-loom/grant-shortcut-graph-approles.sh grants the file roles).` +
      (detail ? ` Graph said: ${detail}` : ''),
    );
    this.name = 'GraphSearchAccessError';
    this.status = status;
  }
}

export class GraphSearchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GraphSearchError';
    this.status = status;
  }
}

// ----------------------------------------------------------------------------
// Low-level fetch
// ----------------------------------------------------------------------------

async function graphGet<T>(path: string, scopeKind: GraphGroundingScopeKind): Promise<T> {
  const token = await credential.getToken(graphScope());
  if (!token?.token) throw new GraphSearchError(500, 'Failed to acquire a Microsoft Graph token');
  const url = path.startsWith('http') ? path : `${graphBase()}${path}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: 'application/json',
        // $search on /messages requires eventual consistency semantics.
        ...(path.includes('$search') ? { ConsistencyLevel: 'eventual' } : {}),
        'user-agent': 'CSA-Loom-Console/1.0',
      },
    });
  } catch (e: any) {
    throw new GraphSearchError(502, `Microsoft Graph unreachable: ${e?.message || e}`);
  }
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (res.status === 401 || res.status === 403) {
    throw new GraphSearchAccessError(scopeKind, res.status, parsed?.error?.message);
  }
  if (!res.ok) {
    const msg = parsed?.error?.message || parsed?.message || `Microsoft Graph ${res.status}`;
    throw new GraphSearchError(res.status, String(msg).slice(0, 400));
  }
  return parsed as T;
}

// ----------------------------------------------------------------------------
// Scope resolution helpers
// ----------------------------------------------------------------------------

/** Escape a value for the drive `search(q='…')` function segment. */
function escapeSearchQ(q: string): string {
  return (q || '').replace(/'/g, "''").replace(/[\r\n]+/g, ' ').trim();
}

/** Strip quotes/backslashes for the messages `$search="…"` clause. */
function escapeMailSearch(q: string): string {
  return (q || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve a site reference to a Graph site id. Accepts a raw Graph site id
 * (`host,guid,guid` — passed through) or a full https SharePoint URL, resolved
 * via the colon-addressed `GET /sites/{host}:{server-relative-path}` form.
 */
export async function resolveGraphSiteId(siteRef: string): Promise<string> {
  const ref = (siteRef || '').trim();
  if (!ref) throw new GraphSearchError(400, 'A SharePoint site id or URL is required');
  if (!/^https?:\/\//i.test(ref)) return ref; // already a Graph site id
  let u: URL;
  try { u = new URL(ref); } catch { throw new GraphSearchError(400, `Not a valid site URL: ${ref}`); }
  const path = u.pathname.replace(/\/+$/, '');
  const addressed = path && path !== '/'
    ? `/sites/${u.hostname}:${path}`
    : `/sites/${u.hostname}`;
  const site = await graphGet<{ id?: string }>(`${addressed}?$select=id`, 'site');
  if (!site?.id) throw new GraphSearchError(404, `Could not resolve the SharePoint site for ${ref}`);
  return site.id;
}

// ----------------------------------------------------------------------------
// Grounding search
// ----------------------------------------------------------------------------

export interface GraphGroundingResult {
  columns: string[];
  rows: unknown[][];
  count: number;
}

const clip = (v: unknown, max = 200): unknown =>
  typeof v === 'string' && v.length > max ? `${v.slice(0, max)}…` : v;

/**
 * Run one grounding search against the scope's real Graph endpoint and flatten
 * the results into a columns/rows table for the data-agent executor.
 */
export async function graphGroundingSearch(
  scope: GraphGroundingScope,
  query: string,
  top = 25,
): Promise<GraphGroundingResult> {
  const n = Math.min(Math.max(Math.floor(top) || 25, 1), 50);
  const q = (query || '').trim();
  if (!q) throw new GraphSearchError(400, 'A search phrase is required');

  if (scope.kind === 'mail') {
    const mailbox = (scope.mailbox || '').trim();
    if (!mailbox) throw new GraphSearchError(400, 'The mail scope needs a mailbox UPN');
    const qs = new URLSearchParams({
      $search: `"${escapeMailSearch(q)}"`,
      $top: String(n),
      $select: 'subject,from,receivedDateTime,bodyPreview,webLink,hasAttachments',
    });
    const page = await graphGet<{ value?: any[] }>(
      `/users/${encodeURIComponent(mailbox)}/messages?${qs.toString()}`,
      'mail',
    );
    const msgs = Array.isArray(page?.value) ? page.value : [];
    return {
      columns: ['subject', 'from', 'received', 'preview', 'webLink'],
      rows: msgs.map((m) => [
        clip(m?.subject),
        m?.from?.emailAddress?.address || m?.from?.emailAddress?.name || '',
        m?.receivedDateTime || '',
        clip(m?.bodyPreview),
        m?.webLink || '',
      ]),
      count: msgs.length,
    };
  }

  // site / drive scopes → driveItem search.
  let path: string;
  if (scope.kind === 'drive') {
    const driveId = (scope.driveId || '').trim();
    if (!driveId) throw new GraphSearchError(400, 'The drive scope needs a Graph drive id');
    path = `/drives/${encodeURIComponent(driveId)}/root/search(q='${encodeURIComponent(escapeSearchQ(q))}')`;
  } else {
    const siteId = await resolveGraphSiteId(scope.site || '');
    path = `/sites/${encodeURIComponent(siteId)}/drive/root/search(q='${encodeURIComponent(escapeSearchQ(q))}')`;
  }
  const qs = new URLSearchParams({
    $top: String(n),
    $select: 'name,webUrl,size,lastModifiedDateTime,parentReference,file,folder',
  });
  const page = await graphGet<{ value?: any[] }>(`${path}?${qs.toString()}`, scope.kind);
  const items = Array.isArray(page?.value) ? page.value.slice(0, n) : [];
  return {
    columns: ['name', 'path', 'size', 'lastModified', 'webUrl'],
    rows: items.map((it) => [
      clip(it?.name),
      clip((it?.parentReference?.path || '').replace(/^.*root:\/?/, '') || '/'),
      it?.folder ? 'folder' : (it?.size ?? ''),
      it?.lastModifiedDateTime || '',
      it?.webUrl || '',
    ]),
    count: items.length,
  };
}
