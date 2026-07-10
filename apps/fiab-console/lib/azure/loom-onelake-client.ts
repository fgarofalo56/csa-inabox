/**
 * Loom OneLake service client (console side of HYP-1).
 *
 * A thin wrapper the lakehouse / shortcut / security editors call to resolve a
 *   loom://<tenant>/<workspace>/<item>/<path>
 * logical address to the REAL physical ADLS Gen2 pointer (abfss + SAS-less
 * managed-identity passthrough auth) via the Loom OneLake namespace service
 * (apps/loom-onelake, LOOM_ONELAKE_URL).
 *
 * When LOOM_ONELAKE_URL is UNSET this is an honest config gate — the caller
 * (BFF) surfaces a 503 naming the env var + bicep module, and the console keeps
 * using the per-item in-process library path (lakehouse-abfss.ts) silently. No
 * Microsoft Fabric dependency: the service resolves onto the customer's own DLZ
 * ADLS Gen2 (no onelake.dfs.fabric host) — see .claude/rules/no-fabric-dependency.md.
 *
 * The parse/build helpers are PURE (no network, no SDK) so they are unit-tested
 * in isolation and callable client-side for validation before a round trip.
 */

import { fetchWithTimeout } from './fetch-with-timeout';

/** Parsed components of a loom:// address. */
export interface LoomUriParts {
  tenant: string;
  workspace: string;
  item: string;
  itemType: string | null;
  path: string;
}

/** Physical resolution result returned by the OneLake service /resolve. */
export interface ResolvedLoomUri {
  loomUri: string;
  tenant: string;
  workspace: string;
  item: string;
  itemType: string | null;
  path: string;
  source: 'convention' | 'registry' | 'stamped-abfss' | 'shortcut';
  physical:
    | { scheme: 'abfss'; abfss: string; dfsUrl: string; account: string; container: string; root: string }
    | { scheme: 'shortcut'; target: string; kind: string };
  auth: {
    mode: 'managed-identity' | 'stored-connection';
    passthrough: boolean;
    sas: null;
    scope?: string;
    credentialRef?: string | null;
    note?: string;
  };
  shortcut: { target: string; kind: string; credentialRef: string | null } | null;
}

/**
 * Sanitise a logical path into safe forward-slash segments (drops empty / `.` /
 * `..` — anti-traversal). Mirrors the service resolver's `safeRelPath`.
 */
export function safeRelPath(p: unknown): string {
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/**
 * Parse a loom:// address. Canonical form:
 *   loom://<tenant>/<workspace>/<item>/<path...>
 * The `<item>` may carry an optional Fabric-style `.<type>` suffix. Returns null
 * for any malformed input (caller answers 400).
 */
export function parseLoomUri(uri: string): LoomUriParts | null {
  if (typeof uri !== 'string' || !uri.trim()) return null;
  const m = uri.trim().match(/^loom:\/\/(.+)$/i);
  if (!m) return null;
  const parts = m[1].split('/').filter((s) => s.length > 0);
  if (parts.length < 3) return null;
  const tenant = decodeURIComponent(parts[0]);
  const workspace = decodeURIComponent(parts[1]);
  const itemRaw = decodeURIComponent(parts[2]);
  const path = parts.slice(3).map((s) => decodeURIComponent(s)).join('/');
  let item = itemRaw;
  let itemType: string | null = null;
  const dot = itemRaw.lastIndexOf('.');
  if (dot > 0 && dot < itemRaw.length - 1) {
    const suffix = itemRaw.slice(dot + 1);
    if (/^[A-Za-z][A-Za-z-]*$/.test(suffix)) {
      item = itemRaw.slice(0, dot);
      itemType = suffix.toLowerCase();
    }
  }
  if (!tenant || !workspace || !item) return null;
  return { tenant, workspace, item, itemType, path: safeRelPath(path) };
}

/** Build a canonical loom:// address from components (inverse of parseLoomUri). */
export function buildLoomUri(c: {
  tenant: string;
  workspace: string;
  item: string;
  itemType?: string | null;
  path?: string;
}): string {
  const enc = (s: string) => encodeURIComponent(String(s));
  const itemSeg = c.itemType ? `${enc(c.item)}.${enc(c.itemType)}` : enc(c.item);
  const tail = c.path ? '/' + safeRelPath(c.path).split('/').map(enc).join('/') : '';
  return `loom://${enc(c.tenant)}/${enc(c.workspace)}/${itemSeg}${tail}`;
}

/** Honest config gate — the missing env var, or null when the service is wired. */
export function onelakeConfigGate(): { missing: string } | null {
  return process.env.LOOM_ONELAKE_URL ? null : { missing: 'LOOM_ONELAKE_URL' };
}

/** True when the OneLake namespace service is deployed + wired. */
export function isOneLakeServiceConfigured(): boolean {
  return !!process.env.LOOM_ONELAKE_URL;
}

export class OneLakeServiceError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'OneLakeServiceError';
    this.status = status;
    this.code = code;
  }
}

/** Bearer header for the internal service call (MI token when running on ACA). */
async function serviceAuthHeader(): Promise<Record<string, string>> {
  // Internal-ingress ACA → ACA reaches the app over the CAE network. A token is
  // optional for the internal hop; return empty headers by default. (A future
  // hardening can add an Easy-Auth / UAMI bearer here without a caller change.)
  return {};
}

/**
 * Resolve a loom:// address via the OneLake service. Throws OneLakeServiceError
 * (with the honest 503 when the service is unset) so the BFF maps it to a
 * structured {ok:false,error} envelope.
 */
export async function resolveLoomUri(uri: string): Promise<ResolvedLoomUri> {
  const base = process.env.LOOM_ONELAKE_URL;
  if (!base) {
    throw new OneLakeServiceError(
      'The Loom OneLake namespace service is not deployed in this environment. ' +
        'Set LOOM_ONELAKE_URL to the internal service FQDN — deploy ' +
        'platform/fiab/bicep/modules/compute/loom-onelake-app.bicep. Until then ' +
        'the console resolves lakehouse paths with the in-process library path. ' +
        'No Microsoft Fabric required.',
      503,
      'not_configured',
    );
  }
  const parts = parseLoomUri(uri);
  if (!parts) throw new OneLakeServiceError(`invalid loom uri: ${uri}`, 400, 'invalid_uri');

  let res: Response;
  try {
    res = await fetchWithTimeout(`${base.replace(/\/$/, '')}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await serviceAuthHeader()) },
      body: JSON.stringify({ uri }),
    });
  } catch (e) {
    throw new OneLakeServiceError(
      `Loom OneLake service unreachable: ${e instanceof Error ? e.message : String(e)}`,
      502,
      'unreachable',
    );
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new OneLakeServiceError(`Loom OneLake service returned non-JSON (HTTP ${res.status})`, 502);
  }
  if (!res.ok || body.ok === false) {
    throw new OneLakeServiceError(
      typeof body.error === 'string' ? body.error : `resolve failed (HTTP ${res.status})`,
      res.status === 200 ? 502 : res.status,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  return body as unknown as ResolvedLoomUri;
}
