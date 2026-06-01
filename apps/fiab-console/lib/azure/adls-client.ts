/**
 * ADLS Gen2 client — wraps @azure/storage-file-datalake with the shared
 * BFF credential pattern used by synapse-sql-client.ts.
 *
 * Auth chain:
 *   - Container Apps: user-assigned MI via LOOM_UAMI_CLIENT_ID
 *   - Local dev: az CLI / VS Code login via DefaultAzureCredential
 *
 * Storage account + container URLs come from LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL
 * (set by the DLZ Bicep deploy). The account name is parsed from those URLs
 * — single source of truth, no extra env var.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import {
  DataLakeServiceClient,
  type DataLakeFileSystemClient,
  type PathAccessControlItem,
} from '@azure/storage-file-datalake';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export const KNOWN_CONTAINERS = ['bronze', 'silver', 'gold', 'landing'] as const;
export type KnownContainer = (typeof KNOWN_CONTAINERS)[number];

const CONTAINER_URL_ENV: Record<KnownContainer, string> = {
  bronze: 'LOOM_BRONZE_URL',
  silver: 'LOOM_SILVER_URL',
  gold: 'LOOM_GOLD_URL',
  landing: 'LOOM_LANDING_URL',
};

function containerUrl(name: KnownContainer): string | undefined {
  return process.env[CONTAINER_URL_ENV[name]];
}

/** Parse the storage account name from any configured container URL. */
function resolveAccountName(): string {
  for (const c of KNOWN_CONTAINERS) {
    const url = containerUrl(c);
    if (!url) continue;
    const m = url.match(/^https:\/\/([^.]+)\.dfs\.core\.windows\.net/i);
    if (m) return m[1];
  }
  throw new Error('No LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL configured — cannot resolve ADLS account.');
}

const serviceClients = new Map<string, DataLakeServiceClient>();

/**
 * Service client for a SPECIFIC storage account (used by Lakehouse shortcuts to
 * reach EXTERNAL accounts — any account the Console UAMI has Storage Blob Data
 * Reader on, in any sub/RG). Works for ADLS Gen2 (HNS) and blob-only accounts
 * alike — the .dfs endpoint serves both via multi-protocol access.
 */
export function getServiceClientFor(account: string): DataLakeServiceClient {
  const key = account.toLowerCase();
  let c = serviceClients.get(key);
  if (!c) {
    c = new DataLakeServiceClient(`https://${account}.dfs.core.windows.net`, credential);
    serviceClients.set(key, c);
  }
  return c;
}

export function getServiceClient(): DataLakeServiceClient {
  return getServiceClientFor(resolveAccountName());
}

export function getAccountName(): string {
  return resolveAccountName();
}

export interface ContainerInfo {
  name: string;
  url: string;
}

/**
 * Probe each known container via exists() and return only those that
 * actually exist. This avoids needing list-account-level permission.
 */
export async function listContainers(): Promise<ContainerInfo[]> {
  const svc = getServiceClient();
  const out: ContainerInfo[] = [];
  for (const name of KNOWN_CONTAINERS) {
    const url = containerUrl(name);
    if (!url) continue;
    const fs = svc.getFileSystemClient(name);
    try {
      const exists = await fs.exists();
      if (exists) out.push({ name, url });
    } catch {
      // skip on auth/network failures — surface elsewhere via listPaths
    }
  }
  return out;
}

export interface PathEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  lastModified?: string;
  etag?: string;
}

function getFileSystem(container: string, account?: string): DataLakeFileSystemClient {
  const svc = account ? getServiceClientFor(account) : getServiceClient();
  return svc.getFileSystemClient(container);
}

/**
 * Flat directory listing — recursive=false so it behaves like a tree level.
 * `prefix` is treated as a directory path (no leading slash).
 */
export async function listPaths(
  container: string,
  prefix = '',
  maxResults = 200,
  account?: string,
): Promise<PathEntry[]> {
  const fs = getFileSystem(container, account);
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  const iter = fs.listPaths({
    path: cleanPrefix || undefined,
    recursive: false,
  });
  const out: PathEntry[] = [];
  for await (const p of iter) {
    out.push({
      name: p.name ?? '',
      isDirectory: !!p.isDirectory,
      size: typeof p.contentLength === 'number' ? p.contentLength : Number(p.contentLength ?? 0),
      lastModified: p.lastModified ? new Date(p.lastModified).toISOString() : undefined,
      etag: p.etag,
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

export interface PathMetadata {
  exists: boolean;
  size: number;
  lastModified?: string;
  contentType?: string;
  etag?: string;
  isDirectory: boolean;
}

export async function getMetadata(container: string, path: string): Promise<PathMetadata> {
  const fs = getFileSystem(container);
  const file = fs.getFileClient(path);
  try {
    const props = await file.getProperties();
    return {
      exists: true,
      size: typeof props.contentLength === 'number' ? props.contentLength : 0,
      lastModified: props.lastModified ? new Date(props.lastModified).toISOString() : undefined,
      contentType: props.contentType,
      etag: props.etag,
      isDirectory: (props.metadata?.hdi_isfolder ?? '').toLowerCase() === 'true',
    };
  } catch (e: any) {
    if (e?.statusCode === 404) return { exists: false, size: 0, isDirectory: false };
    throw e;
  }
}

export async function uploadFile(
  container: string,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<{ ok: true; size: number; etag?: string }> {
  const fs = getFileSystem(container);
  const file = fs.getFileClient(path);
  await file.upload(body, {
    pathHttpHeaders: { contentType },
  });
  const props = await file.getProperties();
  return { ok: true, size: body.length, etag: props.etag };
}

/**
 * Read a file's bytes from ADLS Gen2 for download passthrough. Returns the
 * buffer + content metadata so the BFF can stream it to the browser with the
 * right headers. Throws (with statusCode) on 404 / auth errors.
 */
export async function downloadFile(
  container: string,
  path: string,
): Promise<{ body: Buffer; contentType?: string; size: number }> {
  const fs = getFileSystem(container);
  const file = fs.getFileClient(path);
  const buf = await file.readToBuffer();
  let contentType: string | undefined;
  try {
    const props = await file.getProperties();
    contentType = props.contentType;
  } catch { /* best-effort */ }
  return { body: buf, contentType, size: buf.length };
}

export async function deletePath(
  container: string,
  path: string,
  recursive = false,
): Promise<{ ok: true }> {
  const fs = getFileSystem(container);
  // file or directory? Try directory delete with recursive flag; fall back to file.
  try {
    const dir = fs.getDirectoryClient(path);
    if (await dir.exists()) {
      await dir.delete(recursive);
      return { ok: true };
    }
  } catch {
    // ignore and try file path
  }
  const file = fs.getFileClient(path);
  await file.delete();
  return { ok: true };
}

export async function createDirectory(
  container: string,
  path: string,
): Promise<{ ok: true }> {
  const fs = getFileSystem(container);
  const dir = fs.getDirectoryClient(path);
  await dir.createIfNotExists();
  return { ok: true };
}

/** Build the full abfss-style URL for OPENROWSET BULK. */
export function pathToHttpsUrl(container: string, path: string): string {
  const account = getAccountName();
  const clean = path.replace(/^\/+/, '');
  return `https://${account}.dfs.core.windows.net/${container}/${clean}`;
}

// Re-export to suppress unused-import warning when tree-shaken.
export type { PathAccessControlItem };

// ============================================================
// POSIX ACL access (DFS endpoint) — directory & file ACLs
// ============================================================

export interface AclItem {
  /** ACL scope: 'access' (default) or 'default' (inherited) */
  scope: 'access' | 'default';
  /** Principal type */
  type: 'user' | 'group' | 'mask' | 'other';
  /** Entra object id of the principal (omitted for 'mask' / 'other') */
  entityId?: string;
  /** rwx permission bits */
  permissions: { read: boolean; write: boolean; execute: boolean };
}

function aclItemToAzure(a: AclItem): PathAccessControlItem {
  return {
    accessControlType: a.type,
    entityId: a.entityId || '',
    defaultScope: a.scope === 'default',
    permissions: {
      read: a.permissions.read,
      write: a.permissions.write,
      execute: a.permissions.execute,
    },
  };
}

function azureToAclItem(a: PathAccessControlItem): AclItem {
  return {
    scope: a.defaultScope ? 'default' : 'access',
    type: a.accessControlType as AclItem['type'],
    entityId: a.entityId,
    permissions: {
      read: !!a.permissions?.read,
      write: !!a.permissions?.write,
      execute: !!a.permissions?.execute,
    },
  };
}

export async function getAcl(container: string, path = ''): Promise<AclItem[]> {
  const fs = getFileSystem(container);
  // Directory client works for the root path as well (`/`).
  const dir = fs.getDirectoryClient(path || '/');
  const res = await dir.getAccessControl();
  return (res.acl || []).map(azureToAclItem);
}

export async function setAcl(
  container: string,
  path: string,
  acl: AclItem[],
): Promise<{ ok: true }> {
  const fs = getFileSystem(container);
  const dir = fs.getDirectoryClient(path || '/');
  await dir.setAccessControl(acl.map(aclItemToAzure));
  return { ok: true };
}

// ============================================================
// Azure RBAC role-assignments at the container scope.
// Used by the Lakehouse "Permissions" dialog to grant Storage
// Blob Data Reader/Contributor roles to a user/group on the
// container (separate from POSIX ACLs).
// ============================================================

import {
  DefaultAzureCredential as _DefaultCredential,
  ManagedIdentityCredential as _MICredential,
  ChainedTokenCredential as _ChainedCredential,
  type TokenCredential as _TokenCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const armCred: _TokenCredential = uamiClientId
  ? new _ChainedCredential(
      new _MICredential({ clientId: uamiClientId }),
      new _DefaultCredential(),
    )
  : new _DefaultCredential();

async function armToken(): Promise<string> {
  const t = await armCred.getToken(ARM_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire ARM token for ADLS RBAC');
  return t.token;
}

export interface ContainerRoleAssignment {
  id: string;            // Full ARM id of the role-assignment
  principalId: string;   // Entra object id
  principalType?: 'User' | 'Group' | 'ServicePrincipal' | string;
  roleDefinitionId: string;
  roleName?: string;     // 'Storage Blob Data Reader' etc — populated by listContainerRoleAssignments
}

const BLOB_DATA_ROLES: Record<string, string> = {
  // GUIDs are global across all Azure tenants.
  'Storage Blob Data Reader':       '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1',
  'Storage Blob Data Contributor':  'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
  'Storage Blob Data Owner':        'b7e6dc6d-f1e8-4753-8033-0f276bb0955b',
};

export function listKnownBlobDataRoles(): Array<{ name: string; id: string }> {
  return Object.entries(BLOB_DATA_ROLES).map(([name, id]) => ({ name, id }));
}

function resolveStorageScope(container: string): string {
  // Storage RBAC supports scoping to a single container via the
  // `blobServices/default/containers/<name>` sub-resource path on the
  // storage account ARM id. We rebuild the storage account ARM id from
  // env (LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG) + the resolved account name.
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  const rg = process.env.LOOM_DLZ_RG;
  if (!sub || !rg) {
    throw new Error('LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG required to resolve container scope');
  }
  const account = getAccountName();
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${account}/blobServices/default/containers/${container}`;
}

async function armCall<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await armToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = json?.error?.message || text || `ARM ${res.status}`;
    const err: any = new Error(msg);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json as T;
}

export async function listContainerRoleAssignments(container: string): Promise<ContainerRoleAssignment[]> {
  const scope = resolveStorageScope(container);
  const url = `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()`;
  const res = await armCall<{ value: any[] }>(url);
  const out: ContainerRoleAssignment[] = [];
  for (const r of (res.value || [])) {
    const roleDef = r.properties?.roleDefinitionId || '';
    const roleGuid = roleDef.split('/').pop();
    const known = Object.entries(BLOB_DATA_ROLES).find(([, id]) => id === roleGuid);
    out.push({
      id: r.id,
      principalId: r.properties?.principalId,
      principalType: r.properties?.principalType,
      roleDefinitionId: roleDef,
      roleName: known ? known[0] : undefined,
    });
  }
  // Only show storage-data-plane roles by default; admin/control-plane
  // assignments aren't actionable from the Lakehouse Permissions dialog.
  return out.filter((r) => !!r.roleName);
}

export async function grantContainerRole(
  container: string,
  principalId: string,
  roleNameOrId: string,
  principalType: 'User' | 'Group' | 'ServicePrincipal' = 'User',
): Promise<ContainerRoleAssignment> {
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) throw new Error('LOOM_SUBSCRIPTION_ID required');
  const scope = resolveStorageScope(container);
  const roleGuid = BLOB_DATA_ROLES[roleNameOrId] || roleNameOrId;
  const roleDefinitionId = `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${roleGuid}`;
  // ARM role-assignment names are random GUIDs. Use crypto.randomUUID() so
  // re-grants get distinct ids; the principalId+role pair would 409 anyway
  // if it already exists at the scope.
  const guid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  const url = `https://management.azure.com${scope}/providers/Microsoft.Authorization/roleAssignments/${guid}?api-version=2022-04-01`;
  const res = await armCall<any>(url, {
    method: 'PUT',
    body: JSON.stringify({
      properties: {
        roleDefinitionId,
        principalId,
        principalType,
      },
    }),
  });
  return {
    id: res.id,
    principalId,
    principalType,
    roleDefinitionId,
    roleName: Object.entries(BLOB_DATA_ROLES).find(([, id]) => id === roleGuid)?.[0],
  };
}

export async function revokeContainerRoleAssignment(roleAssignmentArmId: string): Promise<void> {
  const url = `https://management.azure.com${roleAssignmentArmId}?api-version=2022-04-01`;
  await armCall<void>(url, { method: 'DELETE' });
}
