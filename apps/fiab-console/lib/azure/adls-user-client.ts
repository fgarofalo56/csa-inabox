/**
 * adls-user-client (EH-P1-OBO, #1800) — ADLS Gen2 data-plane READS executed
 * with the SIGNED-IN USER's delegated Azure Storage token instead of the Loom
 * console service identity (UAMI). The per-user sibling of `adls-client.ts`:
 * same @azure/storage-file-datalake surface, but the TokenCredential resolves
 * the caller's delegated token from `storage-user-token-store.ts` via
 * `user-pool-registry.ts` (Cosmos cache → MSAL silent-acquire refresh).
 *
 * WHY: when an item's data-access mode is 'user', reads must be authorized by
 * the USER's own RBAC/ACLs on the lake (Storage Blob Data Reader / POSIX ACL),
 * not the UAMI's broader rights — Gov posture depends on it. A missing
 * delegated token is an HONEST typed error (`AdlsUserTokenError`, code
 * NO_USER_STORAGE_TOKEN) the route maps to a 403 remediation gate — NEVER a
 * silent downgrade to the service credential.
 *
 * DEFAULT UNCHANGED: nothing imports this on the service path; adls-client.ts
 * and its ~all callers are byte-for-byte untouched.
 *
 * SECURITY: the delegated token is resolved server-side per call and handed
 * straight to the SDK request pipeline. It is never logged, never returned to
 * the browser, and never cached in module state (client objects are built per
 * call so one user's credential can never serve another user's read).
 */
import { DataLakeServiceClient, type DataLakeFileSystemClient } from '@azure/storage-file-datalake';
import type { TokenCredential } from '@azure/identity';
import { dfsUrl } from './cloud-endpoints';
import { getAccountName, type PathEntry } from './adls-client';
import {
  getUserDataPlaneToken,
  userTokenRemediation,
  USER_TOKEN_GATE_CODE,
} from './user-pool-registry';

/** Typed honest-gate error: no delegated Azure Storage token for this user. */
export class AdlsUserTokenError extends Error {
  readonly code = USER_TOKEN_GATE_CODE.storage; // NO_USER_STORAGE_TOKEN
  readonly status = 403;
  constructor() {
    super(userTokenRemediation('storage'));
    this.name = 'AdlsUserTokenError';
  }
}

/**
 * A TokenCredential backed by the user's delegated storage token. The SDK asks
 * per request; a short reported lifetime makes it re-resolve (the store/registry
 * enforce the real safety-margin + silent refresh). Throws AdlsUserTokenError
 * when no delegated token can be minted — surfaced as the 403 gate.
 */
function userStorageCredential(oid: string): TokenCredential {
  return {
    async getToken() {
      const token = await getUserDataPlaneToken('storage', { oid });
      if (!token) throw new AdlsUserTokenError();
      return { token, expiresOnTimestamp: Date.now() + 5 * 60_000 };
    },
  };
}

/** Per-call DataLakeServiceClient for `account`, authorized AS the user. */
export function getUserServiceClientFor(account: string, oid: string): DataLakeServiceClient {
  return new DataLakeServiceClient(dfsUrl(account), userStorageCredential(oid));
}

/** File-system (container) client on the DLZ account, authorized AS the user. */
function getUserFileSystem(container: string, oid: string, account?: string): DataLakeFileSystemClient {
  return getUserServiceClientFor(account || getAccountName(), oid).getFileSystemClient(container);
}

/**
 * Flat directory listing AS THE USER — mirrors adls-client's `listPaths`
 * (recursive=false, prefix as a directory path, same PathEntry shape) so a
 * route can swap executors without reshaping its response. Throws
 * AdlsUserTokenError when the user has no delegated token; storage-side
 * AuthorizationFailure (user lacks RBAC/ACL on the path) propagates with the
 * SDK's statusCode for the route's honest error mapping.
 */
export async function listPathsAsUser(
  oid: string,
  container: string,
  prefix = '',
  maxResults = 200,
  account?: string,
): Promise<PathEntry[]> {
  const fs = getUserFileSystem(container, oid, account);
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  const iter = fs.listPaths({ path: cleanPrefix || undefined, recursive: false });
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

/**
 * Read a file's bytes AS THE USER — mirrors adls-client's `downloadFile`
 * (buffer + content metadata for BFF download passthrough). Same honest-gate
 * contract as listPathsAsUser.
 */
export async function downloadFileAsUser(
  oid: string,
  container: string,
  path: string,
  account?: string,
): Promise<{ body: Buffer; contentType?: string; size: number }> {
  const fs = getUserFileSystem(container, oid, account);
  const file = fs.getFileClient(path);
  const buf = await file.readToBuffer();
  let contentType: string | undefined;
  try {
    const props = await file.getProperties();
    contentType = props.contentType;
  } catch {
    /* best-effort */
  }
  return { body: buf, contentType, size: buf.length };
}
