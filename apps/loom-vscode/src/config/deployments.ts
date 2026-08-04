/**
 * Deployment configuration parsing — PURE (no `vscode` import) so it is unit
 * testable without the extension host.
 *
 * `loom.deployments` is an array of { id?, name?, apiUrl, cloud? }. Multi-
 * deployment IS the Loom tenancy model (PRP A2/A4/W11): a Commercial and a
 * Government deployment can be listed side by side and shown simultaneously,
 * because token acquisition happens server-side and `apiUrl` is the only
 * per-cloud difference.
 *
 * The extension reads the raw setting value and hands it here; the caller in
 * `extension.ts` supplies `vscode.workspace.getConfiguration('loom').get('deployments')`.
 */

export type Cloud = 'commercial' | 'gov' | 'gcc' | 'gcc-high' | 'il5';

const CLOUDS: readonly Cloud[] = ['commercial', 'gov', 'gcc', 'gcc-high', 'il5'];

export interface Deployment {
  /** Stable id — secrets and per-deployment UI state are keyed by this. */
  id: string;
  /** Display name shown as the tree root. */
  name: string;
  /** Normalized base URL (no trailing slash). The only per-cloud difference. */
  apiUrl: string;
  /** Cloud the deployment lives in (informational; labels only). */
  cloud: Cloud;
}

interface RawDeployment {
  id?: unknown;
  name?: unknown;
  apiUrl?: unknown;
  cloud?: unknown;
}

/** Strip trailing slashes without a backtracking regex (matches the SDK). */
export function normalizeUrl(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === url.length ? url : url.slice(0, end);
}

/** Derive a stable, human-ish id from an apiUrl (host + first path segment). */
export function deploymentIdFromUrl(apiUrl: string): string {
  try {
    const u = new URL(apiUrl);
    // First non-empty path segment. Split + filter (no run-trim regex) so there
    // is no quadratic backtracking on a pathological path (ReDoS-safe).
    const seg = u.pathname.split('/').find(Boolean) || '';
    const base = seg ? `${u.host}-${seg}` : u.host;
    return base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  } catch {
    return apiUrl.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  }
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeCloud(v: unknown): Cloud {
  if (typeof v === 'string') {
    const lc = v.toLowerCase().trim();
    if ((CLOUDS as readonly string[]).includes(lc)) return lc as Cloud;
    // Friendly aliases.
    if (lc === 'government' || lc === 'usgov' || lc === 'gov-cloud') return 'gov';
    if (lc === 'commercial-cloud' || lc === 'public') return 'commercial';
  }
  return 'commercial';
}

/**
 * Parse + validate the raw `loom.deployments` value.
 *
 * - Non-array input → `[]`.
 * - Entries without a valid http(s) `apiUrl` are skipped (never invented — an
 *   invalid deployment is dropped, not silently defaulted to a fake host).
 * - `name` defaults to the apiUrl host; `id` defaults to a slug of the host;
 *   `cloud` defaults to `commercial`.
 * - Duplicate ids are de-duplicated (first wins) so one deployment can't shadow
 *   another's secret.
 */
export function parseDeployments(raw: unknown): Deployment[] {
  if (!Array.isArray(raw)) return [];
  const out: Deployment[] = [];
  const seen = new Set<string>();
  for (const entry of raw as RawDeployment[]) {
    if (!entry || typeof entry !== 'object') continue;
    const apiUrlRaw = typeof entry.apiUrl === 'string' ? entry.apiUrl.trim() : '';
    if (!apiUrlRaw || !isHttpUrl(apiUrlRaw)) continue;
    const apiUrl = normalizeUrl(apiUrlRaw);
    const id =
      (typeof entry.id === 'string' && entry.id.trim()) || deploymentIdFromUrl(apiUrl);
    if (seen.has(id)) continue;
    seen.add(id);
    let host = apiUrl;
    try {
      host = new URL(apiUrl).host;
    } catch {
      /* already validated above */
    }
    const name = (typeof entry.name === 'string' && entry.name.trim()) || host;
    out.push({ id, name, apiUrl, cloud: normalizeCloud(entry.cloud) });
  }
  return out;
}

/** Human label for a cloud, for tree/tooltip display. */
export function cloudLabel(cloud: Cloud): string {
  switch (cloud) {
    case 'gov':
      return 'Government';
    case 'gcc':
      return 'GCC';
    case 'gcc-high':
      return 'GCC High';
    case 'il5':
      return 'IL5';
    default:
      return 'Commercial';
  }
}
