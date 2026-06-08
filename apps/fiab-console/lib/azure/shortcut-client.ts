/**
 * Shortcut external-source CONNECTORS — per-source connectivity validation +
 * remote-tree browsing for Lakehouse shortcuts (Azure-native parity with Fabric
 * OneLake external shortcuts, NO Fabric dependency).
 *
 * Each function takes credentials the CALLER has already resolved out of Key
 * Vault (this module NEVER reads Key Vault and NEVER returns the secret value)
 * and performs a REAL list/read against the external source so the wizard's
 * "Browse" tree shows live objects and the "Test" action proves connectivity:
 *
 *   - S3        → `GET /?list-type=2` (AWS Signature v4, Node `crypto` HMAC; no SDK)
 *   - GCS       → `GET storage/v1/b/<bucket>/o` (self-signed RS256 JWT → OAuth2 token)
 *   - ADLS Gen2 → delegate to adls-client `listPaths()` on the Console UAMI
 *   - Dataverse → list the Synapse-Link exported table folders in ADLS (UAMI)
 *
 * Sovereign clouds: S3 supports AWS GovCloud regions (`us-gov-*`); GCS is honest-
 * gated outside Commercial (Google Cloud is not GCC/GCC-High/IL5-authorized);
 * ADLS/Dataverse inherit the sovereign DFS suffix from adls-client.
 *
 * Per .claude/rules/no-vaporware.md — real REST calls, no mock arrays. Errors
 * carry a stable `code` so the BFF can map them to honest, actionable hints.
 */

import { createHash, createHmac, createSign } from 'crypto';
import { listPaths, type PathEntry } from './adls-client';

/** One entry in a remote browse tree (folder or object). */
export interface RemoteEntry {
  /** Leaf name relative to the listed prefix (folder names end without a slash). */
  name: string;
  /** Full key/path from the bucket/container root (what a shortcut would target). */
  path: string;
  isDirectory: boolean;
  size?: number;
  lastModified?: string;
  etag?: string;
}

export interface BrowseResult {
  entries: RemoteEntry[];
  /** The prefix that was listed (echoed back for the tree). */
  prefix: string;
  /** True when the source had more results than `maxKeys`. */
  truncated: boolean;
}

/** Typed connector error carrying a stable code the BFF maps to an honest hint. */
export class ShortcutSourceError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = 'ShortcutSourceError';
    this.code = code;
    this.status = status;
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** RFC3986 encode a single path/query segment (AWS-style: keep unreserved only). */
function awsUriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const ch of Buffer.from(value, 'utf8').toString('binary')) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += ch;
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Extract the inner text of the FIRST occurrence of <tag> in xml (non-greedy). */
function xmlFirst(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : undefined;
}

/** Extract every <tag>…</tag> block. */
function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Amazon S3 — ListObjectsV2 with AWS Signature Version 4 (no @aws-sdk needed).
// ---------------------------------------------------------------------------

export interface S3BrowseArgs {
  bucket: string;
  /** Key prefix to list (folder-like, e.g. 'data/2026/'). */
  prefix?: string;
  /** AWS region, e.g. 'us-east-1' or GovCloud 'us-gov-west-1'. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional STS session token for temporary credentials. */
  sessionToken?: string;
  maxKeys?: number;
  /** Override host (e.g. for S3-compatible stores); defaults to AWS path-style. */
  endpointHost?: string;
}

/**
 * List one level of an S3 bucket (delimiter '/') signed with SigV4 and parsed
 * from the XML response. Path-style addressing keeps dotted bucket names valid.
 */
export async function listS3Objects(args: S3BrowseArgs): Promise<BrowseResult> {
  const bucket = (args.bucket || '').trim();
  const region = (args.region || '').trim() || 'us-east-1';
  if (!bucket) throw new ShortcutSourceError('S3 bucket is required', 's3_bad_target', 400);
  if (!args.accessKeyId || !args.secretAccessKey) {
    throw new ShortcutSourceError('S3 access key id and secret are required', 's3_missing_credentials', 400);
  }
  const prefix = (args.prefix || '').replace(/^\/+/, '');
  const maxKeys = Math.min(Math.max(args.maxKeys ?? 100, 1), 1000);
  const host = (args.endpointHost || `s3.${region}.amazonaws.com`).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const canonicalUri = '/' + awsUriEncode(bucket, false);

  // Canonical query string — keys sorted, values RFC3986-encoded.
  const query: Record<string, string> = {
    'delimiter': '/',
    'list-type': '2',
    'max-keys': String(maxKeys),
  };
  if (prefix) query['prefix'] = prefix;
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(query[k])}`)
    .join('&');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzDate,
  };
  if (args.sessionToken) headers['x-amz-security-token'] = args.sessionToken;

  const signedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${args.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}?${canonicalQuery}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: { ...headers, authorization }, cache: 'no-store' });
  } catch (e: any) {
    throw new ShortcutSourceError(`S3 endpoint unreachable: ${e?.message || e}`, 's3_unreachable', 502);
  }
  const text = await res.text().catch(() => '');
  if (res.status === 403) {
    throw new ShortcutSourceError(
      `S3 denied the request (HTTP 403). Check the access key/secret and that the IAM principal can s3:ListBucket on '${bucket}'.`,
      's3_auth_failure', 403);
  }
  if (res.status === 404 || /<Code>NoSuchBucket<\/Code>/.test(text)) {
    throw new ShortcutSourceError(`S3 bucket '${bucket}' not found in region '${region}'.`, 's3_bucket_not_found', 404);
  }
  if (!res.ok) {
    const code = xmlFirst(text, 'Code') || `HTTP ${res.status}`;
    const msg = xmlFirst(text, 'Message') || text.slice(0, 200);
    throw new ShortcutSourceError(`S3 list failed (${code}): ${msg}`, 's3_list_failed', res.status || 502);
  }

  const entries: RemoteEntry[] = [];
  for (const cp of xmlAll(text, 'CommonPrefixes')) {
    const p = xmlUnescape(xmlFirst(cp, 'Prefix') || '');
    if (!p) continue;
    const rel = p.slice(prefix.length).replace(/\/$/, '');
    entries.push({ name: rel, path: p, isDirectory: true });
  }
  for (const c of xmlAll(text, 'Contents')) {
    const key = xmlUnescape(xmlFirst(c, 'Key') || '');
    if (!key || key === prefix) continue; // skip the folder marker itself
    const rel = key.slice(prefix.length);
    if (!rel) continue;
    entries.push({
      name: rel,
      path: key,
      isDirectory: false,
      size: Number(xmlFirst(c, 'Size') || 0),
      lastModified: xmlFirst(c, 'LastModified'),
      etag: (xmlUnescape(xmlFirst(c, 'ETag') || '')).replace(/^"|"$/g, '') || undefined,
    });
  }
  const truncated = (xmlFirst(text, 'IsTruncated') || 'false').toLowerCase() === 'true';
  entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  return { entries, prefix, truncated };
}

// ---------------------------------------------------------------------------
// Google Cloud Storage — JSON API with a self-signed RS256 JWT → OAuth2 token.
// ---------------------------------------------------------------------------

export interface GcsServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
  project_id?: string;
  [k: string]: unknown;
}

export interface GcsBrowseArgs {
  bucket: string;
  prefix?: string;
  serviceAccount: GcsServiceAccount;
  maxResults?: number;
  /** Loom cloud boundary; GCS is honest-gated outside 'commercial'. */
  cloud?: string;
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a GCS read-only access token from a service-account JSON (no SDK). */
async function gcsAccessToken(sa: GcsServiceAccount): Promise<string> {
  if (!sa?.client_email || !sa?.private_key) {
    throw new ShortcutSourceError(
      'Service-account JSON must include client_email and private_key.', 'gcs_bad_service_account', 400);
  }
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/devstorage.read_only',
    aud: tokenUri,
    iat,
    exp: iat + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  let signature: string;
  try {
    signature = base64url(createSign('RSA-SHA256').update(signingInput).sign(sa.private_key));
  } catch (e: any) {
    throw new ShortcutSourceError(`Failed to sign GCS JWT (bad private_key?): ${e?.message || e}`, 'gcs_bad_service_account', 400);
  }
  const jwt = `${signingInput}.${signature}`;
  let res: Response;
  try {
    res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
      cache: 'no-store',
    });
  } catch (e: any) {
    throw new ShortcutSourceError(`GCS token endpoint unreachable: ${e?.message || e}`, 'gcs_unreachable', 502);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ShortcutSourceError(
      `GCS token request failed (HTTP ${res.status}): ${body.slice(0, 200)}`, 'gcs_auth_failure', 401);
  }
  const j = await res.json().catch(() => ({}));
  if (!j?.access_token) throw new ShortcutSourceError('GCS token response had no access_token.', 'gcs_auth_failure', 401);
  return j.access_token as string;
}

export async function listGcsObjects(args: GcsBrowseArgs): Promise<BrowseResult> {
  const cloud = (args.cloud || process.env.LOOM_CLOUD_BOUNDARY || 'commercial').toLowerCase();
  if (cloud !== 'commercial' && cloud !== 'public') {
    throw new ShortcutSourceError(
      'Google Cloud Storage is not available in GCC / GCC-High / IL5 boundaries. Use S3 (AWS GovCloud) or ADLS instead.',
      'gcs_not_available_in_cloud', 503);
  }
  const bucket = (args.bucket || '').trim();
  if (!bucket) throw new ShortcutSourceError('GCS bucket is required', 'gcs_bad_target', 400);
  const prefix = (args.prefix || '').replace(/^\/+/, '');
  const maxResults = Math.min(Math.max(args.maxResults ?? 100, 1), 1000);
  const token = await gcsAccessToken(args.serviceAccount);

  const qs = new URLSearchParams({ delimiter: '/', maxResults: String(maxResults) });
  if (prefix) qs.set('prefix', prefix);
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?${qs.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch (e: any) {
    throw new ShortcutSourceError(`GCS endpoint unreachable: ${e?.message || e}`, 'gcs_unreachable', 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ShortcutSourceError(
      `GCS denied the request (HTTP ${res.status}). The service account needs storage.objects.list on '${bucket}'.`,
      'gcs_auth_failure', res.status);
  }
  if (res.status === 404) {
    throw new ShortcutSourceError(`GCS bucket '${bucket}' not found.`, 'gcs_bucket_not_found', 404);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ShortcutSourceError(`GCS list failed (HTTP ${res.status}): ${body.slice(0, 200)}`, 'gcs_list_failed', res.status);
  }
  const j = await res.json().catch(() => ({}));
  const entries: RemoteEntry[] = [];
  for (const p of (j.prefixes as string[] | undefined) || []) {
    const rel = p.slice(prefix.length).replace(/\/$/, '');
    entries.push({ name: rel, path: p, isDirectory: true });
  }
  for (const item of (j.items as any[] | undefined) || []) {
    const key = String(item?.name || '');
    if (!key || key === prefix) continue;
    const rel = key.slice(prefix.length);
    if (!rel) continue;
    entries.push({
      name: rel,
      path: key,
      isDirectory: false,
      size: item?.size != null ? Number(item.size) : undefined,
      lastModified: item?.updated || item?.timeCreated,
      etag: item?.etag,
    });
  }
  entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  return { entries, prefix, truncated: !!j.nextPageToken };
}

// ---------------------------------------------------------------------------
// ADLS Gen2 — delegate to adls-client listPaths on the Console UAMI (cross-acct).
// ---------------------------------------------------------------------------

export interface AdlsBrowseArgs {
  account: string;
  container: string;
  prefix?: string;
  maxResults?: number;
}

function pathEntriesToRemote(rows: PathEntry[], prefix: string): RemoteEntry[] {
  const clean = prefix.replace(/^\/+|\/+$/g, '');
  return rows.map((r) => {
    const full = r.name;
    const rel = clean && full.startsWith(clean + '/') ? full.slice(clean.length + 1) : full;
    return {
      name: rel,
      path: full,
      isDirectory: r.isDirectory,
      size: r.isDirectory ? undefined : r.size,
      lastModified: r.lastModified,
      etag: r.etag,
    };
  });
}

export async function browseAdls(args: AdlsBrowseArgs): Promise<BrowseResult> {
  const account = (args.account || '').trim();
  const container = (args.container || '').trim();
  if (!account) throw new ShortcutSourceError('ADLS storage account is required', 'adls_bad_target', 400);
  if (!container) throw new ShortcutSourceError('ADLS container/filesystem is required', 'adls_bad_target', 400);
  const prefix = (args.prefix || '').replace(/^\/+|\/+$/g, '');
  const maxResults = Math.min(Math.max(args.maxResults ?? 200, 1), 1000);
  let rows: PathEntry[];
  try {
    rows = await listPaths(container, prefix, maxResults, account);
  } catch (e: any) {
    const msg = (e?.message || String(e));
    const denied = /\b403\b|forbidden|denied|AuthorizationPermissionMismatch/i.test(msg);
    throw new ShortcutSourceError(
      denied
        ? `The Console UAMI cannot list '${container}@${account}'. Grant it Storage Blob Data Reader on that account.`
        : `ADLS list failed: ${msg}`,
      denied ? 'adls_access_denied' : 'adls_unreachable',
      denied ? 403 : 502);
  }
  const entries = pathEntriesToRemote(rows, prefix);
  entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  return { entries, prefix, truncated: rows.length >= maxResults };
}

// ---------------------------------------------------------------------------
// Dataverse — list Synapse-Link exported table folders in the linked ADLS path.
// (Azure-native Dataverse parity: Synapse Link / Azure Synapse Link for Dataverse
// continuously exports tables to ADLS Gen2; the shortcut targets that storage.)
// ---------------------------------------------------------------------------

export interface DataverseBrowseArgs {
  /** abfss://<container>@<account>.dfs.core.windows.net/<path> of the Synapse-Link export. */
  exportAbfssUri: string;
  prefix?: string;
  maxResults?: number;
}

/** Parse account/container/path out of an abfss:// URI. */
export function parseAbfss(uri: string): { account: string; container: string; path: string } {
  const m = (uri || '').match(/^abfss:\/\/([^@]+)@([^/]+)\/?(.*)$/i);
  if (!m) throw new ShortcutSourceError(`Not a valid abfss:// URI: ${uri}`, 'dataverse_bad_target', 400);
  const container = m[1];
  const host = m[2];
  const account = host.split('.')[0];
  return { account, container, path: m[3] || '' };
}

export async function listDataverseEntities(args: DataverseBrowseArgs): Promise<BrowseResult> {
  const { account, container, path } = parseAbfss(args.exportAbfssUri);
  const base = path.replace(/\/+$/, '');
  const prefix = args.prefix ? `${base}/${args.prefix.replace(/^\/+/, '')}`.replace(/\/+$/, '') : base;
  const result = await browseAdls({ account, container, prefix, maxResults: args.maxResults });
  // Re-base entry names relative to the export root so the tree reads as tables.
  return result;
}
