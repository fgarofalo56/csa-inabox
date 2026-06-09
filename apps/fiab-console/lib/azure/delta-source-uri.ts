/**
 * delta-source-uri — pure (dependency-free) parsing + building of ADLS Gen2
 * Delta source URIs for the Direct-Lake-shim. Split out from eventgrid-client
 * so it carries NO Azure-SDK import and is unit-testable in isolation (the
 * eventgrid-client re-exports these for its callers).
 *
 * Sovereign-cloud aware via cloud-endpoints (dfsSuffix / getBlobSuffix) — no
 * hard-coded domain.
 */

import { dfsSuffix, getBlobSuffix } from './cloud-endpoints';

export interface DeltaSourceRef {
  account: string;
  container: string;
  /** Container-relative path (no leading/trailing slash); '' for the container root. */
  path: string;
}

/**
 * Parse an ADLS Gen2 Delta source URI into { account, container, path }.
 * Accepts both forms the editor / lakehouse surfaces produce:
 *   abfss://<container>@<account>.dfs.<suffix>/<path>
 *   https://<account>.(dfs|blob).<suffix>/<container>/<path>
 * Returns null when the URI isn't a recognisable ADLS path.
 */
export function parseDeltaSource(uri: string): DeltaSourceRef | null {
  const u = (uri || '').trim();
  // abfss://container@account.dfs.suffix/path
  let m = u.match(/^abfss:\/\/([^@]+)@([^.]+)\.dfs\.[^/]+\/?(.*)$/i);
  if (m) return { container: m[1], account: m[2], path: (m[3] || '').replace(/^\/+|\/+$/g, '') };
  // https://account.(dfs|blob).suffix/container/path
  m = u.match(/^https:\/\/([^.]+)\.(?:dfs|blob)\.[^/]+\/([^/]+)\/?(.*)$/i);
  if (m) return { account: m[1], container: m[2], path: (m[3] || '').replace(/^\/+|\/+$/g, '') };
  return null;
}

/** Build a canonical abfss:// URI from parts (sovereign-correct dfs suffix). */
export function toAbfss(ref: DeltaSourceRef): string {
  const p = ref.path ? `/${ref.path.replace(/^\/+/, '')}` : '';
  return `abfss://${ref.container}@${ref.account}.${dfsSuffix()}${p}`;
}

/** Build the https blob URL for a Delta source (used for display / probes). */
export function toHttps(ref: DeltaSourceRef): string {
  const p = ref.path ? `/${ref.path.replace(/^\/+/, '')}` : '';
  return `https://${ref.account}.${getBlobSuffix()}/${ref.container}${p}`;
}
