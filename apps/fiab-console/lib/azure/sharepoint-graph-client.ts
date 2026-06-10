/**
 * SharePoint Online / OneDrive for Business shortcut connector — Azure-native
 * parity with Microsoft Fabric OneLake's "SharePoint" / "OneDrive" external
 * shortcut sources, with NO Fabric dependency.
 *
 * A SharePoint/OneDrive shortcut is a named, zero-copy pointer that surfaces a
 * SharePoint document library (drive) folder — or a OneDrive for Business user
 * drive folder — under `Files` in a Loom lakehouse, without copying bytes. It
 * resolves through the **Microsoft Graph drives API** on the Console UAMI's
 * **application** token (Sites.Read.All + Files.Read.All AppRoles), exactly the
 * same auth model the existing Identity Picker uses (graph-identity-client.ts).
 *
 * Target URI grammar (canonical, stored on the registry row):
 *   sharepoint://<siteId>/<driveId>/<itemPath>
 *   onedrive://<userId>/<itemPath>
 * where <itemPath> is the drive-relative folder path ('' = drive root). The
 * driveId for OneDrive is resolved per-user at read time (the user's default
 * drive), so the OneDrive URI omits it.
 *
 * Browse model (one Graph page per level, like the S3/GCS connectors):
 *   - sites    → GET /sites?search=<q>                       (site picker)
 *   - drives   → GET /sites/{siteId}/drives                  (document libraries)
 *   - items    → GET /drives/{driveId}/root|items/{id}:/<path>:/children
 *   - me/users → GET /users/{userId}/drive/root:/<path>:/children  (OneDrive)
 *
 * Per .claude/rules/no-vaporware.md — every call hits real Microsoft Graph; no
 * mock arrays. Per .claude/rules/no-fabric-dependency.md — this is the default
 * Azure-native path and never touches api.fabric.microsoft.com / onelake.
 *
 * Sovereign clouds: the Graph host is cloud-derived (getGraphHost) — Commercial
 * & GCC use graph.microsoft.com, GCC-High graph.microsoft.us, IL5/DoD
 * dod-graph.microsoft.us. SharePoint Online + Graph drives are available in all
 * of those boundaries.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { getGraphHost, getGraphScope } from './cloud-endpoints';
import type { BrowseResult, RemoteEntry } from './shortcut-client';
import { ShortcutSourceError } from './shortcut-client';

const GRAPH_V1 = `${getGraphHost()}/v1.0`;
const GRAPH_SCOPE = getGraphScope();

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ----------------------------------------------------------------------------
// Graph AppRoles required for SharePoint / OneDrive shortcuts (type=Role under
// the Microsoft Graph SP appRoles[]). Verified against the Microsoft Graph
// permissions reference. Granted out-of-band by
// scripts/csa-loom/grant-sharepoint-graph-approles.sh + tenant admin consent.
// ----------------------------------------------------------------------------
export const SHAREPOINT_APP_ROLES = [
  {
    name: 'Sites.Read.All',
    appRoleId: '332a536c-c7ef-4017-ab91-336970924f0d',
    scope: 'Microsoft Graph (app permission, admin-consented)',
    reason: 'Search SharePoint sites and list their document libraries (drives).',
  },
  {
    name: 'Files.Read.All',
    appRoleId: '01d4889c-1287-42c6-ac1f-5d1e02578ef6',
    scope: 'Microsoft Graph (app permission, admin-consented)',
    reason: 'List and read SharePoint / OneDrive drive items (folders and files).',
  },
] as const;

/** True when the SharePoint/OneDrive shortcut source is wired on this deployment. */
export function sharepointShortcutsEnabled(): boolean {
  return process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED === 'true';
}

function consentPortalUrl(): string {
  const cloud = (process.env.AZURE_CLOUD || '').toLowerCase();
  return cloud.includes('usgov') || cloud.includes('government')
    ? 'https://portal.azure.us'
    : 'https://portal.azure.com';
}

/** Honest-gate detail naming the exact env var + AppRole grants + consent step. */
export function sharepointConfigGateDetail(): string {
  return (
    'SharePoint / OneDrive shortcuts are not wired on this deployment. ' +
    'Set LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true on the Console Container App ' +
    '(or loomSharePointShortcutsEnabled=true in the admin-plane bicepparam + redeploy), ' +
    'run scripts/csa-loom/grant-sharepoint-graph-approles.sh to grant the Console UAMI ' +
    'Sites.Read.All + Files.Read.All, then a Tenant Administrator grants admin consent at ' +
    `${consentPortalUrl()} → Entra ID → Enterprise applications → Console UAMI → Permissions. ` +
    'ADLS Gen2 and internal Loom lakehouse shortcuts need none of this.'
  );
}

function assertEnabled(): void {
  if (!sharepointShortcutsEnabled()) {
    throw new ShortcutSourceError(sharepointConfigGateDetail(), 'sharepoint_not_configured', 503);
  }
}

// ----------------------------------------------------------------------------
// Low-level Graph fetch (app-only token, same pattern as graph-identity-client)
// ----------------------------------------------------------------------------

async function graphFetch(path: string): Promise<Response> {
  const token = await credential.getToken(GRAPH_SCOPE);
  if (!token?.token) {
    throw new ShortcutSourceError('Failed to acquire a Microsoft Graph token for the Console UAMI.', 'sharepoint_token_failure', 502);
  }
  const url = path.startsWith('http') ? path : `${GRAPH_V1}${path}`;
  return fetch(url, {
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${token.token}`,
      accept: 'application/json',
      ConsistencyLevel: 'eventual',
      'user-agent': 'CSA-Loom-Console/1.0',
    },
  });
}

function mapGraphError(status: number, body: any, what: string): ShortcutSourceError {
  const detail =
    body?.error?.message || body?.message || (typeof body === 'string' ? body : `Microsoft Graph HTTP ${status}`);
  if (status === 401 || status === 403) {
    return new ShortcutSourceError(
      `Microsoft Graph denied the request (HTTP ${status}) while ${what}. The Console UAMI needs ` +
        'Sites.Read.All + Files.Read.All (admin-consented). Run ' +
        'scripts/csa-loom/grant-sharepoint-graph-approles.sh and grant admin consent, then retry. ' +
        `(${detail})`,
      'sharepoint_auth_failure',
      status,
    );
  }
  if (status === 404) {
    return new ShortcutSourceError(`Not found while ${what}: ${detail}`, 'sharepoint_not_found', 404);
  }
  return new ShortcutSourceError(`Graph error while ${what} (HTTP ${status}): ${detail}`, 'sharepoint_graph_error', status || 502);
}

async function graphJson<T>(path: string, what: string): Promise<T> {
  let res: Response;
  try {
    res = await graphFetch(path);
  } catch (e: any) {
    if (e instanceof ShortcutSourceError) throw e;
    throw new ShortcutSourceError(`Microsoft Graph unreachable while ${what}: ${e?.message || e}`, 'sharepoint_unreachable', 502);
  }
  const text = await res.text().catch(() => '');
  let body: any = undefined;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) throw mapGraphError(res.status, body, what);
  return (body as T) ?? ({} as T);
}

// ----------------------------------------------------------------------------
// Target URI parse / build
// ----------------------------------------------------------------------------

export interface SharePointTarget {
  kind: 'sharepoint';
  siteId: string;
  driveId: string;
  itemPath: string;
}
export interface OneDriveTarget {
  kind: 'onedrive';
  userId: string;
  itemPath: string;
}
export type GraphTarget = SharePointTarget | OneDriveTarget;

/** Build the canonical `sharepoint://<siteId>/<driveId>/<itemPath>` URI. */
export function buildSharePointUri(siteId: string, driveId: string, itemPath = ''): string {
  const p = (itemPath || '').replace(/^\/+|\/+$/g, '');
  return `sharepoint://${encodeURIComponent(siteId)}/${encodeURIComponent(driveId)}${p ? `/${p}` : ''}`;
}

/** Build the canonical `onedrive://<userId>/<itemPath>` URI. */
export function buildOneDriveUri(userId: string, itemPath = ''): string {
  const p = (itemPath || '').replace(/^\/+|\/+$/g, '');
  return `onedrive://${encodeURIComponent(userId)}${p ? `/${p}` : ''}`;
}

/** Parse a sharepoint:// or onedrive:// URI into typed coordinates. Throws on a bad URI. */
export function parseGraphTarget(uri: string): GraphTarget {
  const u = (uri || '').trim();
  const sp = u.match(/^sharepoint:\/\/([^/]+)\/([^/]+)\/?(.*)$/i);
  if (sp) {
    return {
      kind: 'sharepoint',
      siteId: decodeURIComponent(sp[1]),
      driveId: decodeURIComponent(sp[2]),
      itemPath: (sp[3] || '').replace(/^\/+|\/+$/g, ''),
    };
  }
  const od = u.match(/^onedrive:\/\/([^/]+)\/?(.*)$/i);
  if (od) {
    return {
      kind: 'onedrive',
      userId: decodeURIComponent(od[1]),
      itemPath: (od[2] || '').replace(/^\/+|\/+$/g, ''),
    };
  }
  throw new ShortcutSourceError(
    `Target URI must be sharepoint://<siteId>/<driveId>/<path> or onedrive://<userId>/<path>; got: ${u}`,
    'sharepoint_bad_target',
    400,
  );
}

// ----------------------------------------------------------------------------
// Site / drive discovery (browse step 1 + 2)
// ----------------------------------------------------------------------------

export interface SiteHit {
  id: string;
  displayName: string;
  webUrl?: string;
  description?: string;
}

/** Search SharePoint sites by name. GET /sites?search=<q>. */
export async function searchSites(q: string, top = 25): Promise<SiteHit[]> {
  assertEnabled();
  const phrase = (q || '').replace(/["\\]/g, '').trim();
  // An empty search returns the followed/most-relevant sites for app context;
  // Graph requires the `search` param so pass '*' to list broadly.
  const search = encodeURIComponent(phrase || '*');
  const data = await graphJson<{ value?: any[] }>(
    `/sites?search=${search}&$select=id,displayName,name,webUrl,description&$top=${Math.min(Math.max(top, 1), 50)}`,
    'searching SharePoint sites',
  );
  return (data.value || []).map((s) => ({
    id: String(s.id || ''),
    displayName: String(s.displayName || s.name || s.id || ''),
    webUrl: s.webUrl,
    description: s.description,
  }));
}

export interface DriveHit {
  id: string;
  name: string;
  driveType?: string;
  webUrl?: string;
}

/** List the document libraries (drives) of a SharePoint site. */
export async function listSiteDrives(siteId: string): Promise<DriveHit[]> {
  assertEnabled();
  if (!siteId) throw new ShortcutSourceError('siteId is required to list document libraries', 'sharepoint_bad_target', 400);
  const data = await graphJson<{ value?: any[] }>(
    `/sites/${encodeURIComponent(siteId)}/drives?$select=id,name,driveType,webUrl`,
    'listing SharePoint document libraries',
  );
  return (data.value || []).map((d) => ({
    id: String(d.id || ''),
    name: String(d.name || d.id || ''),
    driveType: d.driveType,
    webUrl: d.webUrl,
  }));
}

// ----------------------------------------------------------------------------
// Drive-item browse (folders + files), one level per call
// ----------------------------------------------------------------------------

function driveChildrenPath(driveId: string, itemPath: string): string {
  const clean = (itemPath || '').replace(/^\/+|\/+$/g, '');
  if (!clean) return `/drives/${encodeURIComponent(driveId)}/root/children`;
  // Graph addresses a folder by path with the `root:/<path>:` colon syntax.
  const encoded = clean.split('/').map((s) => encodeURIComponent(s)).join('/');
  return `/drives/${encodeURIComponent(driveId)}/root:/${encoded}:/children`;
}

function userDriveChildrenPath(userId: string, itemPath: string): string {
  const clean = (itemPath || '').replace(/^\/+|\/+$/g, '');
  const who = encodeURIComponent(userId);
  if (!clean) return `/users/${who}/drive/root/children`;
  const encoded = clean.split('/').map((s) => encodeURIComponent(s)).join('/');
  return `/users/${who}/drive/root:/${encoded}:/children`;
}

function driveItemsToEntries(items: any[], basePrefix: string): RemoteEntry[] {
  const base = (basePrefix || '').replace(/^\/+|\/+$/g, '');
  const entries: RemoteEntry[] = (items || []).map((it) => {
    const name = String(it?.name || '');
    const isDirectory = !!it?.folder;
    const path = base ? `${base}/${name}` : name;
    return {
      name,
      path,
      isDirectory,
      size: isDirectory ? undefined : (it?.size != null ? Number(it.size) : undefined),
      lastModified: it?.lastModifiedDateTime,
      etag: typeof it?.eTag === 'string' ? it.eTag.replace(/^"|"$/g, '') : undefined,
    };
  });
  entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  return entries;
}

export interface SharePointBrowseArgs {
  siteId: string;
  driveId: string;
  prefix?: string;
  maxResults?: number;
}

/** List one level of a SharePoint document library (drive). */
export async function browseSharePoint(args: SharePointBrowseArgs): Promise<BrowseResult> {
  assertEnabled();
  const { siteId, driveId } = args;
  if (!siteId || !driveId) {
    throw new ShortcutSourceError('siteId and driveId are required for SharePoint browse', 'sharepoint_bad_target', 400);
  }
  const prefix = (args.prefix || '').replace(/^\/+|\/+$/g, '');
  const top = Math.min(Math.max(args.maxResults ?? 200, 1), 999);
  const path =
    driveChildrenPath(driveId, prefix) +
    `?$select=id,name,size,folder,file,lastModifiedDateTime,eTag&$top=${top}`;
  const data = await graphJson<{ value?: any[]; '@odata.nextLink'?: string }>(path, 'listing SharePoint drive items');
  return { entries: driveItemsToEntries(data.value || [], prefix), prefix, truncated: !!data['@odata.nextLink'] };
}

export interface OneDriveBrowseArgs {
  userId: string;
  prefix?: string;
  maxResults?: number;
}

/** List one level of a OneDrive for Business user drive. */
export async function browseOneDrive(args: OneDriveBrowseArgs): Promise<BrowseResult> {
  assertEnabled();
  const userId = (args.userId || '').trim();
  if (!userId) {
    throw new ShortcutSourceError('userId (UPN or object id) is required for OneDrive browse', 'sharepoint_bad_target', 400);
  }
  const prefix = (args.prefix || '').replace(/^\/+|\/+$/g, '');
  const top = Math.min(Math.max(args.maxResults ?? 200, 1), 999);
  const path =
    userDriveChildrenPath(userId, prefix) +
    `?$select=id,name,size,folder,file,lastModifiedDateTime,eTag&$top=${top}`;
  const data = await graphJson<{ value?: any[]; '@odata.nextLink'?: string }>(path, 'listing OneDrive items');
  return { entries: driveItemsToEntries(data.value || [], prefix), prefix, truncated: !!data['@odata.nextLink'] };
}

// ----------------------------------------------------------------------------
// Reachability test (Files shortcut "Test" action + create-time validation)
// ----------------------------------------------------------------------------

/**
 * Prove a SharePoint/OneDrive shortcut target is reachable with a real Graph
 * read of the target folder's children (top=1). Throws a ShortcutSourceError on
 * failure (401/403 → auth, 404 → missing), which the route maps to status='error'.
 */
export async function testGraphTarget(uri: string): Promise<void> {
  assertEnabled();
  const t = parseGraphTarget(uri);
  if (t.kind === 'sharepoint') {
    const path = driveChildrenPath(t.driveId, t.itemPath) + '?$select=id&$top=1';
    await graphJson<unknown>(path, 'validating the SharePoint target folder');
    return;
  }
  const path = userDriveChildrenPath(t.userId, t.itemPath) + '?$select=id&$top=1';
  await graphJson<unknown>(path, 'validating the OneDrive target folder');
}
