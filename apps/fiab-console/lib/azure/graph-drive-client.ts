/**
 * Microsoft Graph **Drive** client — SharePoint document libraries + OneDrive.
 *
 * Backs the OneLake-shortcut "SharePoint / OneDrive" source: Azure-native parity
 * with Microsoft Fabric OneLake's "New shortcut → OneDrive/SharePoint" flow, with
 * NO Fabric dependency. Fabric resolves these shortcuts through Microsoft Graph;
 * Loom does exactly the same, on the Console UAMI — so it works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE UNSET (per .claude/rules/no-fabric-dependency.md).
 *
 * Capabilities (all real Graph v1.0 REST — no SDK, no mock arrays):
 *   - searchSites(q)                  GET /sites?search=<q>           (pick a site)
 *   - listSiteDrives(siteId)          GET /sites/{id}/drives          (doc libraries)
 *   - listUserDrives(user?)           GET /users/{u}/drives | /me/drives (OneDrive)
 *   - listDriveChildren(driveId, …)   GET /drives/{id}/root|items children (browse)
 *   - getDrive(driveId)               GET /drives/{id}                (resolve name)
 *   - resolveSharingUrl(url)          GET /shares/{enc}/driveItem     (paste a link)
 *   - headDriveItem(driveId, itemId)  GET /drives/{id}/items/{id}     (Test action)
 *
 * Token acquisition uses the Console UAMI → DefaultAzureCredential chain (same
 * pattern as graph-identity-client.ts). Sovereign-correct: both the Graph base
 * AND the token scope derive from LOOM_GRAPH_BASE, so GCC-High
 * (graph.microsoft.us) / IL5 (dod-graph.microsoft.us) acquire a sovereign-scoped
 * token rather than the commercial audience.
 *
 * App permissions (application, admin-consent required — granted in the
 * post-deploy bootstrap, see scripts/csa-loom/grant-shortcut-graph-approles.sh):
 *   - Sites.Read.All   (332a536c-c7ef-4017-ab91-336970924f0d) — read SharePoint sites/libraries
 *   - Files.Read.All   (01d4889c-1287-42c6-ac1f-5d1e02578ef6) — read OneDrive/SharePoint files
 *
 * Per .claude/rules/no-vaporware.md — every call hits real Graph; the only
 * non-functional state is an honest gate (GraphDriveNotConfiguredError → 503).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';

// ----------------------------------------------------------------------------
// Sovereign-correct base + scope derivation
// ----------------------------------------------------------------------------

const GRAPH_BASE = (process.env.LOOM_GRAPH_BASE || 'https://graph.microsoft.com').replace(/\/+$/, '');
const GRAPH_V1 = `${GRAPH_BASE}/v1.0`;
const GRAPH_SCOPE = `${GRAPH_BASE}/.default`;

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ----------------------------------------------------------------------------
// Graph AppRole ids (application permissions) — verified against the Microsoft
// Graph permissions reference (appRoles[] on the Graph service principal).
// ----------------------------------------------------------------------------

export const DRIVE_APP_ROLES = [
  {
    name: 'Sites.Read.All',
    appRoleId: '332a536c-c7ef-4017-ab91-336970924f0d',
    scope: 'Microsoft Graph (app permission, admin-consented)',
    reason: 'Enumerate SharePoint sites + their document libraries (drives).',
  },
  {
    name: 'Files.Read.All',
    appRoleId: '01d4889c-1287-42c6-ac1f-5d1e02578ef6',
    scope: 'Microsoft Graph (app permission, admin-consented)',
    reason: 'List + read OneDrive / SharePoint drive items the shortcut points at.',
  },
] as const;

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

export interface GraphDriveNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; appRoleId: string; scope: string; reason: string }[];
  followUp: string;
}

export class GraphDriveNotConfiguredError extends Error {
  hint: GraphDriveNotConfiguredHint;
  status = 503;
  code = 'sharepoint_not_configured';
  constructor(missing: string) {
    super(`SharePoint/OneDrive shortcuts are not wired in this deployment: missing ${missing}`);
    this.name = 'GraphDriveNotConfiguredError';
    this.hint = notConfiguredHint(missing);
  }
}

export class GraphDriveError extends Error {
  status: number;
  code: string;
  body: unknown;
  endpoint?: string;
  constructor(status: number, message: string, code = 'graph_drive_error', body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'GraphDriveError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.endpoint = endpoint;
  }
}

function consentPortalUrl(): string {
  const cloud = (process.env.AZURE_CLOUD || '').toLowerCase();
  return cloud.includes('usgov') || cloud.includes('government')
    ? 'https://portal.azure.us'
    : 'https://portal.azure.com';
}

function notConfiguredHint(missing: string): GraphDriveNotConfiguredHint {
  return {
    missingEnvVar: missing,
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/identity-graph-rbac.bicep',
    bicepStatus:
      'Set loomSharepointShortcutsEnabled=true in the admin-plane bicepparam (wires ' +
      'LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true into the loom-console Container App env alongside ' +
      'LOOM_UAMI_CLIENT_ID).',
    rolesRequired: DRIVE_APP_ROLES.map((r) => ({ ...r })),
    followUp:
      `Operator action: (1) set LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true on the loom-console ` +
      `Container App (or loomSharepointShortcutsEnabled=true in the bicepparam + redeploy admin-plane), ` +
      `(2) run scripts/csa-loom/grant-shortcut-graph-approles.sh to grant the Console UAMI ` +
      `Sites.Read.All + Files.Read.All, ` +
      `(3) a Tenant Administrator grants admin consent at ${consentPortalUrl()} → Entra ID → ` +
      `Enterprise applications → Console UAMI → Permissions → "Grant admin consent". ` +
      `Until consented, every Graph call returns 403.`,
  };
}

/** Honest-gate: SharePoint shortcuts require the feature flag set on the Console. */
export function graphDriveConfigGate(): GraphDriveNotConfiguredError | null {
  if (process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED !== 'true') {
    return new GraphDriveNotConfiguredError('LOOM_SHAREPOINT_SHORTCUTS_ENABLED');
  }
  return null;
}

function assertEnabled(): void {
  const gate = graphDriveConfigGate();
  if (gate) throw gate;
}

// ----------------------------------------------------------------------------
// Low-level fetch
// ----------------------------------------------------------------------------

async function graphFetch<T>(path: string): Promise<T> {
  const token = await credential.getToken(GRAPH_SCOPE);
  if (!token?.token) throw new GraphDriveError(500, 'Failed to acquire Microsoft Graph token', 'token_failure');
  const url = path.startsWith('http') ? path : `${GRAPH_V1}${path}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: 'application/json',
        'user-agent': 'CSA-Loom-Console/1.0',
      },
    });
  } catch (e: any) {
    throw new GraphDriveError(502, `Microsoft Graph unreachable: ${e?.message || e}`, 'graph_unreachable', undefined, url);
  }
  const text = await res.text();
  let parsed: unknown;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (parsed as any)?.message ||
      (typeof parsed === 'string' ? parsed : `Microsoft Graph ${res.status}`);
    const code =
      res.status === 401 || res.status === 403
        ? 'graph_access_denied'
        : res.status === 404
        ? 'graph_not_found'
        : 'graph_error';
    throw new GraphDriveError(res.status, sanitize(msg), code, parsed, url);
  }
  return (parsed as T) ?? ({} as T);
}

function sanitize(s: string): string {
  return (s || '').toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Graph $search clause values are double-quoted; strip quotes/backslashes. */
function searchPhrase(q: string): string {
  return (q || '').replace(/["\\]/g, '').replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface GraphSite {
  id: string;
  displayName: string;
  /** webUrl, e.g. https://contoso.sharepoint.com/sites/Finance */
  webUrl?: string;
  /** SharePoint site path name, e.g. "Finance". */
  name?: string;
}

export interface GraphDrive {
  id: string;
  name: string;
  /** documentLibrary | personal | business … */
  driveType?: string;
  webUrl?: string;
  owner?: string;
}

export interface GraphDriveItem {
  id: string;
  name: string;
  /** Path from the drive root (e.g. 'Reports/2026'), '' for root children. */
  path: string;
  isFolder: boolean;
  size?: number;
  lastModified?: string;
  webUrl?: string;
  /** Child count for folders (Graph folder.childCount). */
  childCount?: number;
}

interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

// ----------------------------------------------------------------------------
// Sites + drives
// ----------------------------------------------------------------------------

/**
 * Search SharePoint sites by keyword. `GET /sites?search=<q>` returns the sites
 * the app can read. An empty query returns the org root + followed/recent sites.
 */
export async function searchSites(q: string, top = 25): Promise<GraphSite[]> {
  assertEnabled();
  const phrase = searchPhrase(q);
  const qs = new URLSearchParams();
  qs.set('search', phrase || '*');
  qs.set('$top', String(Math.min(Math.max(top, 1), 50)));
  qs.set('$select', 'id,displayName,name,webUrl');
  const page = await graphFetch<GraphPage<any>>(`/sites?${qs.toString()}`);
  return (page.value || []).map((s) => ({
    id: s.id,
    displayName: s.displayName || s.name || s.id,
    name: s.name,
    webUrl: s.webUrl,
  }));
}

/** List the document libraries (drives) under a SharePoint site. */
export async function listSiteDrives(siteId: string): Promise<GraphDrive[]> {
  assertEnabled();
  if (!siteId) throw new GraphDriveError(400, 'siteId is required', 'bad_request');
  const page = await graphFetch<GraphPage<any>>(
    `/sites/${encodeURIComponent(siteId)}/drives?$select=id,name,driveType,webUrl,owner`,
  );
  return (page.value || []).map(toDrive);
}

/**
 * List OneDrive drives for a user (or the Console identity's own drive when no
 * user is given). For an application token there is no /me, so a user is needed
 * for OneDrive; the wizard passes the signed-in user's UPN/oid.
 */
export async function listUserDrives(userIdOrUpn?: string): Promise<GraphDrive[]> {
  assertEnabled();
  const base = userIdOrUpn ? `/users/${encodeURIComponent(userIdOrUpn)}` : '/me';
  const page = await graphFetch<GraphPage<any>>(`${base}/drives?$select=id,name,driveType,webUrl,owner`);
  return (page.value || []).map(toDrive);
}

/** Get a single drive's metadata (used to resolve a drive name for display). */
export async function getDrive(driveId: string): Promise<GraphDrive> {
  assertEnabled();
  if (!driveId) throw new GraphDriveError(400, 'driveId is required', 'bad_request');
  const d = await graphFetch<any>(`/drives/${encodeURIComponent(driveId)}?$select=id,name,driveType,webUrl,owner`);
  return toDrive(d);
}

function toDrive(d: any): GraphDrive {
  return {
    id: d.id,
    name: d.name || d.id,
    driveType: d.driveType,
    webUrl: d.webUrl,
    owner: d?.owner?.user?.displayName || d?.owner?.group?.displayName,
  };
}

// ----------------------------------------------------------------------------
// Drive items (browse)
// ----------------------------------------------------------------------------

/**
 * List the children of a drive folder. `prefix` is the path from the drive root
 * ('' = root). Folders sort first; the list pages once (Graph default 200/page)
 * so the tree stays responsive.
 */
export async function listDriveChildren(args: {
  driveId: string;
  /** Path from the drive root, e.g. 'Reports/2026'. '' = root. */
  prefix?: string;
  top?: number;
}): Promise<{ entries: GraphDriveItem[]; truncated: boolean }> {
  assertEnabled();
  const { driveId } = args;
  if (!driveId) throw new GraphDriveError(400, 'driveId is required', 'bad_request');
  const prefix = (args.prefix || '').replace(/^\/+|\/+$/g, '');
  const top = Math.min(Math.max(args.top ?? 200, 1), 999);
  const select = 'id,name,size,folder,file,lastModifiedDateTime,webUrl,parentReference';

  // root children vs path-addressed children (colon-escaped path).
  const childPath = prefix
    ? `/drives/${encodeURIComponent(driveId)}/root:/${encodePath(prefix)}:/children`
    : `/drives/${encodeURIComponent(driveId)}/root/children`;
  const page = await graphFetch<GraphPage<any>>(`${childPath}?$top=${top}&$select=${select}`);

  const entries = (page.value || []).map((it) => toDriveItem(it, prefix));
  entries.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1));
  return { entries, truncated: !!page['@odata.nextLink'] };
}

/** HEAD-equivalent reachability probe — read a drive item by path or id. */
export async function headDriveItem(driveId: string, itemPath: string): Promise<GraphDriveItem> {
  assertEnabled();
  if (!driveId) throw new GraphDriveError(400, 'driveId is required', 'bad_request');
  const select = 'id,name,size,folder,file,lastModifiedDateTime,webUrl,parentReference';
  const clean = (itemPath || '').replace(/^\/+|\/+$/g, '');
  const path = clean
    ? `/drives/${encodeURIComponent(driveId)}/root:/${encodePath(clean)}?$select=${select}`
    : `/drives/${encodeURIComponent(driveId)}/root?$select=${select}`;
  const it = await graphFetch<any>(path);
  const parentPrefix = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
  return toDriveItem(it, parentPrefix);
}

/**
 * Resolve a SharePoint/OneDrive sharing URL (or a webUrl pasted by the user) to
 * its driveItem — `GET /shares/{encoded}/driveItem`. Lets a user create a
 * shortcut by pasting a link, exactly like Fabric's "Use a link" affordance.
 * Returns the owning drive id + the item.
 */
export async function resolveSharingUrl(url: string): Promise<{ driveId: string; item: GraphDriveItem }> {
  assertEnabled();
  const u = (url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new GraphDriveError(400, 'A SharePoint/OneDrive https URL is required', 'bad_request');
  // Per Graph: base64url-encode the URL, prefix "u!", strip padding.
  const b64 = Buffer.from(u, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  const shareId = `u!${b64}`;
  const select = 'id,name,size,folder,file,lastModifiedDateTime,webUrl,parentReference';
  const it = await graphFetch<any>(`/shares/${encodeURIComponent(shareId)}/driveItem?$select=${select}&$expand=`);
  const driveId = it?.parentReference?.driveId;
  if (!driveId) {
    throw new GraphDriveError(404, 'Could not resolve the shared item to a drive — check the link and your access.', 'graph_not_found');
  }
  // The path of a shared item is relative to its drive root.
  const root = it?.parentReference?.path; // e.g. /drive/root:/Folder
  const parentPrefix = root ? decodeURIComponent(root.replace(/^.*root:\/?/, '')) : '';
  return { driveId, item: toDriveItem(it, parentPrefix) };
}

function toDriveItem(it: any, parentPrefix: string): GraphDriveItem {
  const isFolder = !!it.folder;
  const name = it.name || it.id;
  const path = parentPrefix ? `${parentPrefix.replace(/\/+$/, '')}/${name}` : name;
  return {
    id: it.id,
    name,
    path,
    isFolder,
    size: isFolder ? undefined : (it.size != null ? Number(it.size) : undefined),
    lastModified: it.lastModifiedDateTime,
    webUrl: it.webUrl,
    childCount: isFolder ? it.folder?.childCount : undefined,
  };
}

/** Encode a drive-relative path for the colon-escaped Graph addressing syntax. */
function encodePath(p: string): string {
  return p.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/');
}

/**
 * Build the canonical Loom shortcut targetUri for a SharePoint/OneDrive item:
 *   sharepoint://<driveId>/<path>
 * Resolvable back to a Graph driveItem on the Console UAMI for read/Test. No
 * Fabric, no abfss — Graph is the data plane (exactly as Fabric resolves these).
 */
export function sharepointTargetUri(driveId: string, path: string): string {
  const clean = (path || '').replace(/^\/+|\/+$/g, '');
  return `sharepoint://${driveId}/${clean}`;
}

/** Parse a sharepoint://<driveId>/<path> target back into its parts. */
export function parseSharepointUri(uri: string): { driveId: string; path: string } | null {
  const m = (uri || '').trim().match(/^sharepoint:\/\/([^/]+)\/?(.*)$/i);
  if (!m) return null;
  return { driveId: m[1], path: (m[2] || '').replace(/^\/+|\/+$/g, '') };
}
