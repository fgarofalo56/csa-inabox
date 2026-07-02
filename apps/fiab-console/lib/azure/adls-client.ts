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

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import {
  DataLakeServiceClient,
  type DataLakeFileSystemClient,
  type PathAccessControlItem,
} from '@azure/storage-file-datalake';
import {
  BlobServiceClient,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
  type BlobClient as AzureBlobClient,
} from '@azure/storage-blob';
import { getBlobSuffix } from './cloud-endpoints';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
// MI-FIRST: ManagedIdentityCredential is always the first link (system-assigned
// when no clientId), never a bare DefaultAzureCredential on the container path —
// a bare DAC can collapse to dev-only credentials and skip Managed Identity.
const credential: TokenCredential = new ChainedTokenCredential(
  new AcaManagedIdentityCredential(),
  new ManagedIdentityCredential(uamiClientId ? { clientId: uamiClientId } : {}),
  new DefaultAzureCredential(),
);

export const KNOWN_CONTAINERS = ['bronze', 'silver', 'gold', 'landing', 'csv-imports'] as const;
export type KnownContainer = (typeof KNOWN_CONTAINERS)[number];

const CONTAINER_URL_ENV: Record<KnownContainer, string> = {
  bronze: 'LOOM_BRONZE_URL',
  silver: 'LOOM_SILVER_URL',
  gold: 'LOOM_GOLD_URL',
  landing: 'LOOM_LANDING_URL',
  'csv-imports': 'LOOM_CSV_IMPORTS_URL',
};

function containerUrl(name: KnownContainer): string | undefined {
  return process.env[CONTAINER_URL_ENV[name]];
}

/** Parse the storage account name from any configured container URL. */
function resolveAccountName(): string {
  for (const c of KNOWN_CONTAINERS) {
    const url = containerUrl(c);
    if (!url) continue;
    const m = url.match(/^https:\/\/([^.]+)\./i);
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
    c = new DataLakeServiceClient(dfsUrl(account), credential);
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
/** True when at least one DLZ container URL is configured (LOOM_*_URL). */
export function hasConfiguredContainers(): boolean {
  return KNOWN_CONTAINERS.some((c) => !!containerUrl(c));
}

export async function listContainers(): Promise<ContainerInfo[]> {
  // Day-1, no-config: if no LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL is set there is
  // nothing to probe — return an honest empty list FAST (never throw, never hang).
  if (!hasConfiguredContainers()) return [];

  let svc: DataLakeServiceClient;
  try {
    svc = getServiceClient();
  } catch {
    return [];
  }

  // Probe each configured container in PARALLEL with a hard per-probe timeout.
  // Without the abort signal, fs.exists() against an unreachable account
  // (private-endpoint-only / wrong DNS) retries with backoff and HANGS — the
  // request never returns and Front Door answers 504. The abort guarantees the
  // route returns within ~6s with whatever it could reach.
  const probes = KNOWN_CONTAINERS.map(async (name): Promise<ContainerInfo | null> => {
    const url = containerUrl(name);
    if (!url) return null;
    const fs = svc.getFileSystemClient(name);
    try {
      const exists = await fs.exists({ abortSignal: AbortSignal.timeout(6000) });
      return exists ? { name, url } : null;
    } catch {
      // timeout / auth / network — skip this container, don't fail the whole list
      return null;
    }
  });
  const results = await Promise.all(probes);
  return results.filter((c): c is ContainerInfo => c !== null);
}

export interface PathEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  lastModified?: string;
  etag?: string;
  tier?: string;
}

function getFileSystem(container: string, account?: string): DataLakeFileSystemClient {
  const svc = account ? getServiceClientFor(account) : getServiceClient();
  return svc.getFileSystemClient(container);
}

// ============================================================
// Blob access tiers (Hot / Cool / Cold) — data-plane blob API.
//
// ADLS Gen2 multi-protocol access lets us reach the same files via the
// .blob endpoint, where Set Blob Tier / Copy Blob / getProperties expose
// the access tier that the .dfs (DataLake) surface does not.
//
//   - Hot → Cool / Cold  : Set Blob Tier (instantaneous, no penalty on write)
//   - Cool / Cold → Hot  : Copy Blob (avoids the early-deletion penalty that
//                          Set Blob Tier would charge on the source blob)
//
// GA in all four clouds. No Fabric dependency — the .blob host is resolved
// from getBlobSuffix() (sovereign-cloud-correct).
// ============================================================

export type BlobAccessTier = 'Hot' | 'Cool' | 'Cold';

export interface TierResult {
  ok: true;
  tier: BlobAccessTier;
  method: 'set' | 'copy';
}

const blobServiceClients = new Map<string, BlobServiceClient>();

function getBlobServiceClient(account?: string): BlobServiceClient {
  const acct = account ?? resolveAccountName();
  const key = acct.toLowerCase();
  let c = blobServiceClients.get(key);
  if (!c) {
    c = new BlobServiceClient(`https://${acct}.${getBlobSuffix()}`, credential);
    blobServiceClients.set(key, c);
  }
  return c;
}

function getBlobClient(container: string, path: string, account?: string): AzureBlobClient {
  const clean = path.replace(/^\/+/, '');
  return getBlobServiceClient(account).getContainerClient(container).getBlobClient(clean);
}

// ============================================================
// Org-visuals / embed-codes blob surface (F23 + F22).
//
// uploadBlob: raw block-blob upload for opaque bundles (.pbiviz custom-visual
//   packages). Uses the .blob endpoint (block-blob API) rather than the .dfs
//   DataLake path API — bundles are opaque binaries, not HNS directory trees,
//   and the block-blob surface is what a user-delegation SAS later reads.
//
// generateReadSasUrl: a read-only, time-bounded USER-DELEGATION SAS URL —
//   signed with the Console UAMI's Microsoft Entra credentials via
//   getUserDelegationKey() (NEVER the storage account key). This is the
//   Azure-native "embed code": a real, loadable signed URL. Per Azure, a
//   user-delegation SAS lifetime is capped at 7 days from the delegation
//   key's start, so ttlHours is clamped to 7*24.
// ============================================================

const SAS_MAX_TTL_HOURS = 7 * 24; // Azure user-delegation SAS hard cap.

/** Block-blob upload of an opaque bundle (e.g. a .pbiviz custom visual). */
export async function uploadBlob(
  container: string,
  path: string,
  body: Buffer,
  contentType: string,
  account?: string,
): Promise<{ ok: true; size: number; etag?: string; url: string }> {
  const clean = path.replace(/^\/+/, '');
  const block = getBlobServiceClient(account)
    .getContainerClient(container)
    .getBlockBlobClient(clean);
  const res = await block.uploadData(body, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return { ok: true, size: body.length, etag: res.etag, url: block.url };
}

export interface ReadSasUrl {
  url: string;
  expiresAt: string;
}

/**
 * Mint a read-only user-delegation SAS URL for a single blob. The returned URL
 * is directly loadable (HTTPS-only) for `ttlHours` (clamped to Azure's 7-day
 * user-delegation maximum). Throws if the account / RBAC is not configured so
 * the BFF can surface an honest gate.
 */
export async function generateReadSasUrl(
  container: string,
  blobPath: string,
  ttlHours: number,
  account?: string,
): Promise<ReadSasUrl> {
  const acct = account ?? resolveAccountName();
  const clean = blobPath.replace(/^\/+/, '');
  const svc = getBlobServiceClient(acct);

  const now = Date.now();
  // Start a few minutes in the past to tolerate clock skew.
  const startsOn = new Date(now - 5 * 60 * 1000);
  const cappedHours = Math.min(Math.max(ttlHours, 1), SAS_MAX_TTL_HOURS);
  const expiresOn = new Date(now + cappedHours * 60 * 60 * 1000);

  // getUserDelegationKey requires Storage Blob Delegator (or a Blob Data role)
  // at account scope — granted by org-visuals-rbac.bicep.
  const delegationKey = await svc.getUserDelegationKey(startsOn, expiresOn);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: container,
      blobName: clean,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
    },
    delegationKey,
    acct,
  ).toString();

  const blobUrl = svc.getContainerClient(container).getBlobClient(clean).url;
  return { url: `${blobUrl}?${sas}`, expiresAt: expiresOn.toISOString() };
}

/** Read the current access tier of a single blob via Get Blob Properties. */
export async function getBlobTier(
  container: string,
  path: string,
  account?: string,
): Promise<{ tier: BlobAccessTier | 'Archive' | null }> {
  const client = getBlobClient(container, path, account);
  const props = await client.getProperties();
  return { tier: (props.accessTier as BlobAccessTier | 'Archive' | null) ?? null };
}

/**
 * Downgrade to a cooler tier (Hot→Cool / Hot→Cold / Cool→Cold) via Set Blob
 * Tier. Instantaneous; no early-deletion penalty fires on the destination
 * (the newly-cooled blob has not yet accrued its minimum retention).
 */
export async function setBlobTier(
  container: string,
  path: string,
  tier: 'Cool' | 'Cold',
  account?: string,
): Promise<TierResult> {
  const client = getBlobClient(container, path, account);
  await client.setAccessTier(tier);
  return { ok: true, tier, method: 'set' };
}

const TIER_TMP_PREFIX = '__loom_tier_tmp__';

/**
 * Upgrade to a warmer tier (Cool/Cold → Hot) using Copy Blob rather than Set
 * Blob Tier. Set Blob Tier on a still-under-minimum Cool/Cold blob would
 * charge the early-deletion penalty; Copy Blob writes a fresh Hot blob and
 * lets us delete + rename the original (the operator is warned before this
 * runs that the source delete may incur the penalty if below minimum days).
 *
 * Steps (HNS / ADLS Gen2 account — DLZ accounts are always HNS-enabled):
 *   1. Copy source → temp path at the Hot tier (brief dual billing).
 *   2. Delete the original blob.
 *   3. Rename temp → original via the DFS Rename Path (atomic on HNS).
 */
export async function copyBlobToTier(
  container: string,
  path: string,
  targetTier: 'Hot',
  account?: string,
): Promise<TierResult> {
  const clean = path.replace(/^\/+/, '');
  const tmpPath = `${TIER_TMP_PREFIX}/${Date.now()}/${clean}`;

  // Step 1 — Copy source → tmp at the target (Hot) tier.
  const srcClient = getBlobClient(container, clean, account);
  const dstClient = getBlobClient(container, tmpPath, account);
  const copyPoller = await dstClient.beginCopyFromURL(srcClient.url, { tier: targetTier });
  await copyPoller.pollUntilDone();

  // Step 2 — Delete the original (warned: may trigger early-deletion penalty).
  await srcClient.delete();

  // Step 3 — Rename tmp → original path via DFS (atomic on HNS accounts).
  const fs = getFileSystem(container, account);
  const tmpFile = fs.getFileClient(tmpPath);
  await tmpFile.move(clean);

  return { ok: true, tier: 'Hot', method: 'copy' };
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

/**
 * Recursively count the live Parquet data files under a Delta table directory,
 * skipping the `_delta_log/` transaction log. Used by the OPTIMIZE route to
 * prove compaction occurred (file count before vs after). Walks the table
 * folder recursively (Delta data files may be nested under partition folders).
 * `cap` bounds the walk so a pathological table can't hang the request; when the
 * cap is hit the returned count is `cap` and `capped` is true.
 */
export async function countParquetFiles(
  container: string,
  prefix: string,
  account?: string,
  cap = 100_000,
): Promise<{ count: number; bytes: number; capped: boolean }> {
  const fs = getFileSystem(container, account);
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  const iter = fs.listPaths({ path: cleanPrefix || undefined, recursive: true });
  let count = 0;
  let bytes = 0;
  let capped = false;
  for await (const p of iter) {
    if (p.isDirectory) continue;
    const name = p.name ?? '';
    // Delta transaction log + checkpoint files are not data files.
    if (name.includes('/_delta_log/') || name.endsWith('/_delta_log')) continue;
    if (!name.toLowerCase().endsWith('.parquet')) continue;
    count++;
    bytes += typeof p.contentLength === 'number' ? p.contentLength : Number(p.contentLength ?? 0);
    if (count >= cap) { capped = true; break; }
  }
  return { count, bytes, capped };
}

// ============================================================
// OneLake item-size reporting — recursive prefix byte aggregation.
//
// Parity with Fabric "OneLake — item storage" (workspace storage usage per
// item, including system files + soft-deleted data). The Azure-native backend
// walks the item's ADLS Gen2 prefix:
//
//   - LIVE usage   : recursive DataLake listPaths (recursive=true) over the
//                    prefix, summing EVERY file's contentLength — system files
//                    (Delta `_delta_log/`, checkpoints, `_SUCCESS`, `_metadata`)
//                    are INCLUDED (Fabric counts them toward item storage).
//   - SOFT-DELETED : blob listBlobsFlat({ prefix, includeDeleted:true }) over
//                    the SAME prefix on the .blob endpoint, summing the
//                    contentLength of blobs whose `deleted === true`. These are
//                    the bytes still billed during the soft-delete retention
//                    window (HNS blob soft-delete enabled by storage.bicep).
//
// No Fabric dependency — both surfaces are the storage account itself, reached
// via the sovereign-correct .dfs / .blob hosts. Required role: Storage Blob
// Data Reader on the account/container (the Console UAMI already holds it).
// Docs: https://learn.microsoft.com/azure/storage/blobs/soft-delete-blob-overview
// ============================================================

export interface PrefixUsage {
  /** Live (non-deleted) bytes under the prefix, system files INCLUDED. */
  liveBytes: number;
  /** Live (non-deleted) file count under the prefix. */
  liveFiles: number;
  /** Bytes of system/metadata files (Delta `_delta_log/`, checkpoints) — a
   *  subset of liveBytes, surfaced so the UI can break the total apart. */
  systemBytes: number;
  /** Soft-deleted bytes still billed during the retention window. */
  deletedBytes: number;
  /** Soft-deleted blob count. */
  deletedFiles: number;
  /** liveBytes + deletedBytes — total billed storage for the item. */
  totalBytes: number;
  /** True when the walk hit `cap` and the numbers are a lower bound. */
  capped: boolean;
}

const SYSTEM_PATH_RE = /(^|\/)(_delta_log|_metadata|_SUCCESS|_committed_|_started_|_temporary)/i;

/**
 * Recursively aggregate the ADLS Gen2 storage a single OneLake item consumes
 * under `prefix` (its `state.rootPath` inside `state.container`). Counts live
 * bytes (system files included) plus soft-deleted bytes. Never throws on a
 * missing prefix — a never-materialised item returns all-zero. The `cap` bounds
 * each of the two walks so a pathological tree cannot hang the request.
 */
export async function aggregatePrefixUsage(
  container: string,
  prefix: string,
  account?: string,
  cap = 250_000,
): Promise<PrefixUsage> {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, '');
  const out: PrefixUsage = {
    liveBytes: 0,
    liveFiles: 0,
    systemBytes: 0,
    deletedBytes: 0,
    deletedFiles: 0,
    totalBytes: 0,
    capped: false,
  };

  // ── Live walk (DataLake recursive listPaths — system files included) ──
  try {
    const fs = getFileSystem(container, account);
    const iter = fs.listPaths({ path: cleanPrefix || undefined, recursive: true });
    for await (const p of iter) {
      if (p.isDirectory) continue;
      const name = p.name ?? '';
      const sz = typeof p.contentLength === 'number' ? p.contentLength : Number(p.contentLength ?? 0);
      out.liveBytes += sz;
      out.liveFiles += 1;
      if (SYSTEM_PATH_RE.test(name)) out.systemBytes += sz;
      if (out.liveFiles >= cap) { out.capped = true; break; }
    }
  } catch (e: any) {
    // A 404 means the prefix never materialised (item created but no data yet) —
    // that is a legitimate all-zero result, not an error. Anything else
    // (auth/network) propagates so the BFF can surface an honest gate.
    if (e?.statusCode !== 404) throw e;
  }

  // ── Soft-deleted walk (.blob listBlobsFlat with includeDeleted) ──
  try {
    const cc = getBlobServiceClient(account).getContainerClient(container);
    const dprefix = cleanPrefix ? `${cleanPrefix}/` : undefined;
    let seen = 0;
    for await (const b of cc.listBlobsFlat({ prefix: dprefix, includeDeleted: true })) {
      if (!b.deleted) continue;
      out.deletedBytes += b.properties?.contentLength ?? 0;
      out.deletedFiles += 1;
      seen += 1;
      if (seen >= cap) { out.capped = true; break; }
    }
  } catch (e: any) {
    // Soft-delete may not be enabled (no deleted blobs to enumerate) or the
    // account is blob-only without the flag — treat as zero soft-deleted bytes
    // rather than failing the whole item. The 404/feature-not-enabled cases are
    // benign; only re-throw genuine auth failures (403) so the gate fires.
    if (e?.statusCode === 403) throw e;
  }

  out.totalBytes = out.liveBytes + out.deletedBytes;
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

// ============================================================
// Soft-delete / restore (Recycle bin) — HNS blob soft-delete.
// Requires the account's blobServices deleteRetentionPolicy to be
// enabled (it is, via storage.bicep). When a directory is deleted the
// DELETE response carries a `deletionId` that is REQUIRED to restore it
// via DataLakeFileSystemClient.undeletePath().
// ============================================================

/**
 * Soft-delete a directory in ADLS Gen2 (HNS + blob soft-delete enabled).
 * Returns the `deletionId` from the delete response (PathDeleteHeaders) —
 * required to restore the path later via unDeleteDirectory().
 * Returns null when the path does not exist (already gone / never created)
 * OR when soft-delete is not enabled on the account (no deletionId issued).
 * Never throws on 404.
 */
export async function softDeleteDirectory(
  container: string,
  path: string,
): Promise<{ deletionId: string } | null> {
  const fs = getFileSystem(container);
  const dir = fs.getDirectoryClient(path);
  try {
    if (!(await dir.exists())) return null;
    const resp = await dir.delete(true /* recursive */);
    const deletionId = resp.deletionId;
    if (!deletionId) return null; // soft-delete not enabled on this account
    return { deletionId };
  } catch (e: any) {
    if (e?.statusCode === 404) return null;
    throw e;
  }
}

/**
 * Restore a soft-deleted ADLS Gen2 directory (HNS) via undeletePath().
 *   container   the file-system (e.g. 'bronze')
 *   path        the container-relative path that was soft-deleted
 *   deletionId  the id returned by softDeleteDirectory() — required by ADLS
 */
export async function unDeleteDirectory(
  container: string,
  path: string,
  deletionId: string,
): Promise<void> {
  const fs = getFileSystem(container);
  await fs.undeletePath(path, deletionId);
}

/** Build the full https URL for OPENROWSET BULK against a SPECIFIC account. */
export function pathToHttpsUrlFor(account: string, container: string, path: string): string {
  const clean = path.replace(/^\/+/, '');
  return `${dfsUrl(account)}/${container}/${clean}`;
}

/**
 * Build the canonical `abfss://<container>@<dfsHost>/<rootPath>` URI for a
 * known DLZ container. Used as the LOCATION of a Synapse Serverless external
 * data source pointing at a lakehouse's ADLS Gen2 root.
 *
 * The DFS host is parsed straight from the configured LOOM_{container}_URL
 * (set by the DLZ Bicep deploy with `environment().suffixes.storage`), so the
 * result is sovereign-cloud-correct automatically — `dfs.core.windows.net` in
 * Commercial/GCC, `dfs.core.usgovcloudapi.net` in GCC-High/IL5 — with no
 * hard-coded domain. Returns null when the container URL isn't configured.
 */
export function resolveAbfssRoot(container: KnownContainer, rootPath: string): string | null {
  const url = containerUrl(container);
  if (!url) return null;
  const m = url.match(/^https:\/\/([^/]+)/i);
  const dfsHost = m?.[1];
  if (!dfsHost) return null;
  const clean = rootPath.replace(/^\/+|\/+$/g, '');
  return `abfss://${container}@${dfsHost}/${clean}`;
}

/** Build the full abfss-style URL for OPENROWSET BULK on the PRIMARY account. */
export function pathToHttpsUrl(container: string, path: string): string {
  return pathToHttpsUrlFor(getAccountName(), container, path);
}

/**
 * Probe whether the Console UAMI can reach a filesystem (container) on a given
 * account. Used by Reference-Lakehouse federation to flag references whose
 * containers the UAMI lacks Storage Blob Data Reader on (cross-account refs).
 * Returns false on any auth/network/404 error rather than throwing.
 */
export async function containerExistsOn(account: string, container: string): Promise<boolean> {
  try {
    const fs = getServiceClientFor(account).getFileSystemClient(container);
    return await fs.exists();
  } catch {
    return false;
  }
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

export interface PathAclRevokeResult {
  /** true when the principal's ACL entries were present and have been removed. */
  removed: boolean;
  /** true when a read-back of the path ACL confirms no entry for the principal remains. */
  aclConfirmed: boolean;
  /** Number of ACL entries (access + default scope) removed for the principal. */
  removedEntries: number;
  /** ACL scopes the principal still resolved through (informational). */
  scopesRemoved: Array<'access' | 'default'>;
}

/**
 * DLP path-level restrict for ADLS Gen2: remove a principal from the POSIX ACL
 * of a directory/file (both the `access` and `default` scopes so newly-created
 * children do not re-inherit the grant), then read the ACL back to CONFIRM the
 * principal no longer holds an explicit entry. Mirrors the ARM read-back used
 * for container-level RBAC revoke.
 *
 * Caveat (encoded honestly by the caller): an ACL edit only restricts a
 * principal granted *via ACL*. A principal that holds container-level Storage
 * RBAC (Storage Blob Data *) is unaffected by an ACL change — the caller should
 * surface that rather than report a silent success.
 */
export async function removePrincipalFromPathAcl(
  container: string,
  path: string,
  principalId: string,
): Promise<PathAclRevokeResult> {
  const current = await getAcl(container, path);
  const mine = current.filter(
    (a) => (a.type === 'user' || a.type === 'group') && a.entityId === principalId,
  );
  if (mine.length === 0) {
    return { removed: false, aclConfirmed: true, removedEntries: 0, scopesRemoved: [] };
  }
  const reduced = current.filter(
    (a) => !((a.type === 'user' || a.type === 'group') && a.entityId === principalId),
  );
  await setAcl(container, path, reduced);
  // Read-back confirmation.
  const after = await getAcl(container, path);
  const stillThere = after.some(
    (a) => (a.type === 'user' || a.type === 'group') && a.entityId === principalId,
  );
  return {
    removed: true,
    aclConfirmed: !stillThere,
    removedEntries: mine.length,
    scopesRemoved: Array.from(new Set(mine.map((a) => a.scope))),
  };
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
import { armBase, armScope, dfsUrl } from './cloud-endpoints';
import { discoverResourceCoordsByName } from './resource-graph-coords';

const ARM_SCOPE = armScope();
// MI-FIRST (see top-of-file credential): never a bare DefaultAzureCredential.
const armCred: _TokenCredential = new _ChainedCredential(
  new _MICredential(uamiClientId ? { clientId: uamiClientId } : {}),
  new _DefaultCredential(),
);

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

/**
 * Resolve the storage account's REAL ARM coordinates ({sub, rg}).
 *
 * Self-heal (systemic dlz-attach env-wiring bug): the env `LOOM_DLZ_RG` /
 * `LOOM_SUBSCRIPTION_ID` frequently point at the ADMIN plane (or a guessed
 * `rg-csa-loom-dlz-…` name) that the DLZ storage account does NOT live in — so
 * an ARM call built from env 404s ("Resource group '…' could not be found").
 * We discover where the account ACTUALLY lives BY NAME via Azure Resource Graph
 * (cached per-process), and only fall back to env when discovery returns
 * nothing. ARG is authoritative, so this fixes the wrong-RG case transparently.
 */
async function resolveStorageCoords(): Promise<{ sub: string; rg: string }> {
  const account = getAccountName();
  const coords = await discoverResourceCoordsByName({
    resourceType: 'Microsoft.Storage/storageAccounts',
    name: account,
  }).catch(() => null);
  const sub = coords?.subscriptionId || process.env.LOOM_SUBSCRIPTION_ID;
  const rg = coords?.resourceGroup || process.env.LOOM_DLZ_RG;
  if (!sub || !rg) {
    throw new Error(
      `Could not locate storage account "${account}" in Azure. Set LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG ` +
      'to the account\'s real subscription + resource group, or ensure the Console identity can read the ' +
      'subscription via Resource Graph (Reader on the DLZ subscription).',
    );
  }
  return { sub, rg };
}

async function resolveStorageScope(container: string): Promise<string> {
  // Storage RBAC supports scoping to a single container via the
  // `blobServices/default/containers/<name>` sub-resource path on the
  // storage account ARM id. Coordinates are resolved by name (self-heal) so a
  // wrong env RG never breaks the Permissions surface.
  const { sub, rg } = await resolveStorageCoords();
  const account = getAccountName();
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${account}/blobServices/default/containers/${container}`;
}

async function armCall<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await armToken();
  const res = await fetchWithTimeout(url, {
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
  const scope = await resolveStorageScope(container);
  const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()`;
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
  // Self-heal coords (see resolveStorageCoords): the role-definition id must be
  // scoped to the SAME subscription the account lives in, not the env default.
  const { sub } = await resolveStorageCoords();
  const scope = await resolveStorageScope(container);
  const roleGuid = BLOB_DATA_ROLES[roleNameOrId] || roleNameOrId;
  const roleDefinitionId = `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${roleGuid}`;
  // ARM role-assignment names are random GUIDs. Use crypto.randomUUID() so
  // re-grants get distinct ids; the principalId+role pair would 409 anyway
  // if it already exists at the scope.
  const guid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments/${guid}?api-version=2022-04-01`;
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
  const url = `${armBase()}${roleAssignmentArmId}?api-version=2022-04-01`;
  await armCall<void>(url, { method: 'DELETE' });
}

// ============================================================
// OneLake Lifecycle Management — ADLS Gen2 blob lifecycle
// management policies via the ARM management plane.
//
// Parity with Fabric "OneLake — Manage lifecycle" (≤10 rules per
// workspace). The Azure-native backend is the storage account's
// singleton `managementPolicies/default` resource — read/written in
// FULL (partial updates are not supported by ARM). Each rule tiers or
// deletes block blobs after N days since modification / last-access /
// creation.
//
// Required role: Storage Account Contributor
//   (17d1049b-9a84-46fb-8f53-869881c3d3ab) on the storage account —
// grants Microsoft.Storage/storageAccounts/managementPolicies/write.
// Granted by storage-lifecycle-rbac.bicep. A 403 surfaces as an honest
// MessageBar naming that role (no Fabric dependency).
// Docs: https://learn.microsoft.com/azure/storage/blobs/lifecycle-management-overview
// ============================================================

const STORAGE_MGMT_API = '2023-05-01';

/** Built-in Storage Account Contributor role GUID (global across all Azure clouds). */
export const STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID = '17d1049b-9a84-46fb-8f53-869881c3d3ab';

import {
  deserialiseRule,
  serialiseRule,
  type ConditionField,
  type LifecycleAction,
  type LifecycleRule,
} from './lifecycle-policy-shapes';
export type { ConditionField, LifecycleAction, LifecycleRule } from './lifecycle-policy-shapes';

/** Pointer to the storage account whose lifecycle policy is being read/written. */
export interface LifecycleAccountRef {
  /** Storage account name. Defaults to the primary DLZ account. */
  account?: string;
  /** Subscription id override (parsed from a workspace's bound ARM id). Defaults to LOOM_SUBSCRIPTION_ID. */
  subscriptionId?: string;
  /** Resource group override. Defaults to LOOM_DLZ_RG. */
  resourceGroup?: string;
}

export type LifecyclePolicyErrorCode = 'missing_config' | 'forbidden' | 'arm_error';

export class LifecyclePolicyError extends Error {
  code: LifecyclePolicyErrorCode;
  status?: number;
  constructor(message: string, code: LifecyclePolicyErrorCode, status?: number) {
    super(message);
    this.name = 'LifecyclePolicyError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Build the storage-account-level ARM resource path (no container suffix) for
 * the lifecycle policy. Honours per-workspace overrides (sub/rg parsed from a
 * bound storage-account ARM id) before falling back to env.
 */
function resolveAccountScope(ref?: LifecycleAccountRef): string {
  const sub = ref?.subscriptionId || process.env.LOOM_SUBSCRIPTION_ID;
  const rg = ref?.resourceGroup || process.env.LOOM_DLZ_RG;
  if (!sub || !rg) {
    throw new LifecyclePolicyError(
      'LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG required to resolve the storage account scope for lifecycle policies',
      'missing_config',
    );
  }
  const account = ref?.account || getAccountName();
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${account}`;
}

/** Translate an ARM error into a typed LifecyclePolicyError. */
function asLifecycleError(e: any): LifecyclePolicyError {
  if (e instanceof LifecyclePolicyError) return e;
  const status: number | undefined = typeof e?.status === 'number' ? e.status : undefined;
  if (status === 403) {
    return new LifecyclePolicyError(
      e?.message || 'Forbidden — missing Storage Account Contributor on the storage account',
      'forbidden', 403,
    );
  }
  return new LifecyclePolicyError(e?.message || `ARM error ${status ?? ''}`.trim(), 'arm_error', status);
}

/**
 * Read the live lifecycle management policy for the storage account. Returns
 * `[]` when no policy exists yet (HTTP 404 from ARM — not an error).
 */
export async function getLifecyclePolicy(ref?: LifecycleAccountRef): Promise<LifecycleRule[]> {
  const scope = resolveAccountScope(ref);
  const url = `${armBase()}${scope}/managementPolicies/default?api-version=${STORAGE_MGMT_API}`;
  try {
    const res = await armCall<any>(url);
    const rules: any[] = res?.properties?.policy?.rules || [];
    return rules.map(deserialiseRule).filter((r): r is LifecycleRule => r != null);
  } catch (e: any) {
    if (e?.status === 404) return []; // no policy yet
    throw asLifecycleError(e);
  }
}

/**
 * Replace the lifecycle management policy in FULL (ARM does not support partial
 * updates). Returns the re-serialised rules echoed by the PUT response.
 */
export async function setLifecyclePolicy(
  rules: LifecycleRule[],
  ref?: LifecycleAccountRef,
): Promise<LifecycleRule[]> {
  const scope = resolveAccountScope(ref);
  const url = `${armBase()}${scope}/managementPolicies/default?api-version=${STORAGE_MGMT_API}`;
  const body = {
    properties: { policy: { rules: rules.map(serialiseRule) } },
  };
  try {
    const res = await armCall<any>(url, { method: 'PUT', body: JSON.stringify(body) });
    const out: any[] = res?.properties?.policy?.rules || [];
    return out.map(deserialiseRule).filter((r): r is LifecycleRule => r != null);
  } catch (e: any) {
    throw asLifecycleError(e);
  }
}
