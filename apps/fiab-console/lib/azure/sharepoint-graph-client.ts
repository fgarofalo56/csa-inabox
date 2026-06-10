/**
 * SharePoint / OneDrive shortcut connector — Microsoft Graph (Files API).
 *
 * Azure-native parity with Microsoft Fabric OneLake's "New shortcut → Microsoft
 * 365 / SharePoint" source (Fabric Build 2026 ask #10), with NO Fabric
 * dependency. A shortcut points at a SharePoint document library (drive) or a
 * folder/file inside it; reads go through Microsoft Graph on the Console UAMI
 * (application permission `Sites.Read.All`) — no Fabric capacity, no Power BI.
 *
 * Browse model (3 levels mirror the Fabric / SharePoint UI):
 *   1. Sites   — GET /sites?search=<q>  (root browse lists frequented sites)
 *   2. Drives  — GET /sites/{siteId}/drives          (document libraries)
 *   3. Items   — GET /drives/{driveId}/root/children  /  .../items/{id}/children
 *
 * The shortcut targetUri is the canonical address:
 *   sharepoint://<siteId>/<driveId>/<itemId-or-empty>
 * which `parseSharePointUri` resolves back to its parts. The browse "prefix" the
 * wizard passes is the same `siteId/driveId/itemId` triplet (segments optional)
 * so one BFF query lists exactly one level.
 *
 * Token + sovereign-cloud correctness: the Graph base AND token scope both come
 * from cloud-endpoints `graphBase()` / `graphScope()` so GCC-High
 * (graph.microsoft.us) and IL5/DoD (dod-graph.microsoft.us) acquire a
 * sovereign-scoped token. The Graph SharePoint/Files APIs are available in all
 * national clouds (Global, GCC L4, GCC-High L5/DoD, 21Vianet).
 *
 * Per .claude/rules/no-vaporware.md — real Graph REST, no mock arrays. Errors
 * carry a stable `code` so the BFF maps them to honest, actionable hints. Per
 * .claude/rules/no-fabric-dependency.md — Microsoft Graph is an Azure/M365
 * service, not Fabric; this works with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { graphBase, graphScope } from './cloud-endpoints';
import { ShortcutSourceError, type BrowseResult, type RemoteEntry } from './shortcut-client';

// ----------------------------------------------------------------------------
// Token credential — Console UAMI first, az-login dev fallback (same chain as
// graph-identity-client.ts / mip-graph-client.ts).
// ----------------------------------------------------------------------------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/**
 * Microsoft Graph application permission required for SharePoint/OneDrive
 * shortcut browse + read. `Sites.Read.All` (application) covers site search,
 * listing a site's drives, and listing driveItem children — and is available in
 * all national clouds. Surfaced in the honest-gate hint + the bootstrap script.
 */
export const SHAREPOINT_APP_ROLE = {
  name: 'Sites.Read.All',
  /** appRole id under the Microsoft Graph service principal (type=Role). */
  appRoleId: '332a536c-c7ef-4017-ab91-336970924f0d',
  scope: 'Microsoft Graph (application permission, admin-consented)',
  reason: 'Search SharePoint sites, list document libraries (drives), and read driveItems for shortcuts.',
} as const;

/** True when the SharePoint shortcut source is enabled on this deployment. */
export function sharePointConfigGate(): { code: string; hint: string } | null {
  if (process.env.LOOM_SHAREPOINT_SHORTCUTS_ENABLED !== 'true') {
    return {
      code: 'sharepoint_not_configured',
      hint:
        'SharePoint / OneDrive shortcuts read through Microsoft Graph on the Console UAMI but are off ' +
        'by default. Operator action: (1) set LOOM_SHAREPOINT_SHORTCUTS_ENABLED=true on the loom-console ' +
        'Container App (or loomSharePointShortcutsEnabled=true in the admin-plane bicepparam + redeploy), ' +
        '(2) run scripts/csa-loom/grant-sharepoint-graph-approle.sh to grant the Console UAMI ' +
        'Sites.Read.All, (3) a Tenant Administrator grants admin consent. Until consented, Graph returns 403.',
    };
  }
  return null;
}

// ----------------------------------------------------------------------------
// Low-level Graph fetch
// ----------------------------------------------------------------------------

async function graphFetch(path: string): Promise<Response> {
  const token = await credential.getToken(graphScope());
  if (!token?.token) {
    throw new ShortcutSourceError('Failed to acquire a Microsoft Graph token for the Console UAMI', 'sharepoint_token_failure', 502);
  }
  const url = path.startsWith('http') ? path : `${graphBase()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: 'application/json',
        ConsistencyLevel: 'eventual',
        'user-agent': 'CSA-Loom-Console/1.0',
      },
    });
  } catch (e: any) {
    throw new ShortcutSourceError(`Microsoft Graph unreachable: ${e?.message || e}`, 'sharepoint_unreachable', 502);
  }
  return res;
}

async function graphJson<T = any>(path: string): Promise<T> {
  const res = await graphFetch(path);
  const text = await res.text().catch(() => '');
  let parsed: any = undefined;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (res.status === 401 || res.status === 403) {
    throw new ShortcutSourceError(
      `Microsoft Graph denied the request (HTTP ${res.status}). The Console UAMI needs the ` +
        `${SHAREPOINT_APP_ROLE.name} application permission with admin consent. Run ` +
        `scripts/csa-loom/grant-sharepoint-graph-approle.sh and have a Tenant Administrator grant consent.`,
      'sharepoint_auth_failure',
      res.status,
    );
  }
  if (res.status === 404) {
    throw new ShortcutSourceError('SharePoint resource not found (HTTP 404).', 'sharepoint_not_found', 404);
  }
  if (!res.ok) {
    const msg = parsed?.error?.message || (typeof parsed === 'string' ? parsed.slice(0, 200) : `HTTP ${res.status}`);
    throw new ShortcutSourceError(`Microsoft Graph SharePoint call failed: ${msg}`, 'sharepoint_graph_error', res.status || 502);
  }
  return (parsed ?? {}) as T;
}

// ----------------------------------------------------------------------------
// targetUri parsing
// ----------------------------------------------------------------------------

export interface SharePointTarget {
  siteId: string;
  driveId: string;
  /** driveItem id of a folder/file inside the drive; '' = drive root. */
  itemId: string;
}

/**
 * Parse `sharepoint://<siteId>/<driveId>/<itemId?>` into its parts. SharePoint
 * site ids themselves contain commas (host,siteCollectionId,webId) which are
 * URI-safe, so we split on the FIRST two '/' boundaries only and keep the rest
 * (an itemId never contains '/').
 */
export function parseSharePointUri(uri: string): SharePointTarget | null {
  const m = (uri || '').trim().match(/^sharepoint:\/\/(.+)$/i);
  if (!m) return null;
  const rest = m[1];
  const parts = rest.split('/');
  if (parts.length < 2) return null;
  const siteId = parts[0];
  const driveId = parts[1];
  const itemId = parts.slice(2).join('/');
  if (!siteId || !driveId) return null;
  return { siteId, driveId, itemId };
}

/** Build the canonical sharepoint:// targetUri from parts. */
export function buildSharePointUri(t: SharePointTarget): string {
  const segs = [t.siteId, t.driveId, t.itemId].filter((s) => s != null && s !== '');
  return `sharepoint://${segs.join('/')}`;
}

// ----------------------------------------------------------------------------
// Browse — one level at a time (sites → drives → items)
// ----------------------------------------------------------------------------

interface GraphSite {
  id: string;
  displayName?: string;
  name?: string;
  webUrl?: string;
}
interface GraphDrive {
  id: string;
  name?: string;
  driveType?: string;
  webUrl?: string;
  quota?: { used?: number };
}
interface GraphDriveItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
}

export interface SharePointBrowseArgs {
  /** `<siteId>/<driveId>/<itemId>` — segments optional; '' = list sites. */
  prefix?: string;
  /** Free-text site search when listing the top (sites) level. */
  search?: string;
  maxResults?: number;
}

/**
 * List exactly one level of the SharePoint/OneDrive hierarchy and return it as a
 * uniform browse tree the wizard renders. The `path` on each entry is the next
 * `prefix` to drill into (siteId, then siteId/driveId, then …/itemId), and the
 * `path` of a leaf/folder at the items level is the full `siteId/driveId/itemId`
 * triplet a shortcut targets.
 */
export async function browseSharePoint(args: SharePointBrowseArgs): Promise<BrowseResult> {
  const prefix = (args.prefix || '').replace(/^\/+|\/+$/g, '');
  const max = Math.min(Math.max(args.maxResults ?? 100, 1), 200);
  const segs = prefix ? prefix.split('/') : [];

  // --- Level 1: sites ---
  if (segs.length === 0) {
    const q = (args.search || '').trim();
    // `*` returns the caller's frequented + followed sites; a query searches.
    const search = q ? encodeURIComponent(q) : '*';
    const j = await graphJson<{ value?: GraphSite[] }>(`/sites?search=${search}&$top=${max}`);
    const entries: RemoteEntry[] = (j.value || []).map((s) => ({
      name: s.displayName || s.name || s.id,
      path: s.id,
      isDirectory: true,
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, prefix, truncated: entries.length >= max };
  }

  // --- Level 2: drives (document libraries) of a site ---
  if (segs.length === 1) {
    const siteId = segs[0];
    const j = await graphJson<{ value?: GraphDrive[] }>(`/sites/${encodeURIComponent(siteId)}/drives?$top=${max}`);
    const entries: RemoteEntry[] = (j.value || []).map((d) => ({
      name: d.name || d.id,
      path: `${siteId}/${d.id}`,
      isDirectory: true,
      size: d.quota?.used,
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, prefix, truncated: entries.length >= max };
  }

  // --- Level 3+: driveItems (folders/files) ---
  const siteId = segs[0];
  const driveId = segs[1];
  const itemId = segs.slice(2).join('/');
  const childrenPath = itemId
    ? `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`
    : `/drives/${encodeURIComponent(driveId)}/root/children`;
  const select = '$select=id,name,size,folder,file,lastModifiedDateTime,webUrl';
  const j = await graphJson<{ value?: GraphDriveItem[]; '@odata.nextLink'?: string }>(
    `${childrenPath}?${select}&$top=${max}`,
  );
  const entries: RemoteEntry[] = (j.value || []).map((it) => ({
    name: it.name || it.id,
    // The drill-down / target path keeps the same siteId/driveId, swapping itemId.
    path: `${siteId}/${driveId}/${it.id}`,
    isDirectory: !!it.folder,
    size: it.folder ? undefined : it.size,
    lastModified: it.lastModifiedDateTime,
  }));
  entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  return { entries, prefix, truncated: !!j['@odata.nextLink'] };
}

/**
 * Prove a SharePoint shortcut target is reachable on the Console UAMI. For a
 * drive-root target it reads the drive; for an item target it reads the
 * driveItem. Throws a ShortcutSourceError (mapped by the route) on failure.
 * This is the reachability test both create and the Test action use.
 */
export async function testSharePointTarget(t: SharePointTarget): Promise<{ webUrl?: string }> {
  if (t.itemId) {
    const it = await graphJson<GraphDriveItem>(
      `/drives/${encodeURIComponent(t.driveId)}/items/${encodeURIComponent(t.itemId)}?$select=id,name,webUrl`,
    );
    return { webUrl: it.webUrl };
  }
  const d = await graphJson<GraphDrive>(`/drives/${encodeURIComponent(t.driveId)}?$select=id,name,webUrl`);
  return { webUrl: d.webUrl };
}
