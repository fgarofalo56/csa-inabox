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

let serviceClient: DataLakeServiceClient | null = null;

export function getServiceClient(): DataLakeServiceClient {
  if (serviceClient) return serviceClient;
  const account = resolveAccountName();
  serviceClient = new DataLakeServiceClient(
    `https://${account}.dfs.core.windows.net`,
    credential,
  );
  return serviceClient;
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

function getFileSystem(container: string): DataLakeFileSystemClient {
  return getServiceClient().getFileSystemClient(container);
}

/**
 * Flat directory listing — recursive=false so it behaves like a tree level.
 * `prefix` is treated as a directory path (no leading slash).
 */
export async function listPaths(
  container: string,
  prefix = '',
  maxResults = 200,
): Promise<PathEntry[]> {
  const fs = getFileSystem(container);
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
