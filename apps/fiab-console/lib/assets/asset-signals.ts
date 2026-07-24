/**
 * N5 — REAL data-change signals for data-aware scheduling.
 *
 * The reconciler must know whether an asset's DATA actually changed, not just
 * whether a clock ticked. Two in-boundary signals, both read straight out of
 * the customer's own ADLS Gen2 — no Fabric, no SaaS, no agent on the cluster:
 *
 *  1. **Delta commit version** — the authoritative watermark for a Delta table.
 *     `lib/azure/delta-history.listDeltaVersions` parses the `_delta_log/`
 *     commit files; the newest commit version IS the table's data version. A
 *     version higher than the one recorded at the last materialization means new
 *     data landed. This is the same mechanism the lakehouse History pane uses.
 *
 *  2. **Eventstream / Capture watermark** — a streaming landing zone (Azure
 *     Event Hubs Capture writing Avro into the lake, the Azure-native
 *     eventstream backend) has no `_delta_log`. There the watermark is the
 *     newest blob's last-modified epoch-second under the asset's path, read with
 *     the same `listPaths` call the lake browser uses. Monotonic and real.
 *
 * Signals are BEST-EFFORT by contract: an unreadable path returns `null` and the
 * reconciler simply falls back to cadence-based freshness for that asset. A
 * signal outage must never cause a spurious materialization.
 *
 * Server-only (ADLS). IL5: both reads are against the deployment's own storage
 * account inside the VNet.
 */

import { listPaths, KNOWN_CONTAINERS } from '@/lib/azure/adls-client';
import { cleanTablePath, listDeltaVersions } from '@/lib/azure/delta-history';

/** A parsed lake location extracted from a `path:` asset key. */
export interface AssetStorageLocation {
  container: string;
  path: string;
}

/** How an observed version was produced (surfaced in the reconciler receipt). */
export type AssetSignalKind = 'delta' | 'capture';

export interface AssetSignal {
  version: number;
  kind: AssetSignalKind;
  detail: string;
}

/**
 * Parse a `path:` asset key into a lake container + table path.
 *
 * Accepts the abfss / wasbs forms unified-lineage normalizes to
 * (`abfss://<container>@<account>.dfs.<suffix>/<path>`) and the https blob form.
 * Returns null for anything outside the deployment's KNOWN_CONTAINERS — a
 * foreign account is not observable by this deployment's identity, and guessing
 * would be worse than an honest null. OneLake (`*.onelake.dfs.*`) is
 * deliberately NOT parsed: that host is Fabric-only and opt-in
 * (.claude/rules/no-fabric-dependency.md), never on the default path.
 */
export function parseAssetStorageLocation(assetKey: string): AssetStorageLocation | null {
  const raw = String(assetKey || '').trim();
  if (!raw.toLowerCase().startsWith('path:')) return null;
  const url = raw.slice('path:'.length);
  if (/onelake\.dfs\./i.test(url)) return null;

  let container = '';
  let path = '';

  const abfss = url.match(/^abfss?:\/\/([^@/]+)@[^/]+\/(.*)$/i);
  const wasbs = url.match(/^wasbs?:\/\/([^@/]+)@[^/]+\/(.*)$/i);
  const https = url.match(/^https:\/\/[^/]+\/([^/]+)\/(.*)$/i);
  const m = abfss || wasbs || https;
  if (!m) return null;
  container = m[1].toLowerCase();
  path = m[2] || '';

  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) return null;
  const clean = cleanTablePath(path);
  if (!clean) return null;
  return { container, path: clean };
}

/**
 * Observe one asset's current data version. Tries the Delta log first (the
 * authoritative signal); falls back to the newest-blob watermark for a
 * streaming/Capture landing path. Returns null when nothing is observable.
 */
export async function observeAssetSignal(assetKey: string): Promise<AssetSignal | null> {
  const loc = parseAssetStorageLocation(assetKey);
  if (!loc) return null;

  try {
    const versions = await listDeltaVersions(loc.container, loc.path, 1);
    if (versions.length > 0) {
      return {
        version: versions[0].version,
        kind: 'delta',
        detail: `Delta commit ${versions[0].version} (${versions[0].operation}) at ${versions[0].timestamp || 'unknown time'}.`,
      };
    }
  } catch {
    /* not a Delta table (or the log is unreadable) — try the capture watermark */
  }

  try {
    const entries = await listPaths(loc.container, loc.path, 200);
    let newest = 0;
    for (const e of entries) {
      if (e.isDirectory || !e.lastModified) continue;
      const t = Date.parse(e.lastModified);
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    if (newest > 0) {
      return {
        version: Math.floor(newest / 1000),
        kind: 'capture',
        detail: `Newest object under ${loc.container}/${loc.path} written ${new Date(newest).toISOString()}.`,
      };
    }
  } catch {
    /* path unreadable — fall through to null (cadence-only for this asset) */
  }

  return null;
}

/**
 * Observe a BOUNDED batch of assets in parallel. `limit` caps the ADLS fan-out
 * per reconciler pass so one pass can never storm the storage account.
 */
export async function observeAssetSignals(
  assetKeys: string[],
  limit = 40,
): Promise<Map<string, AssetSignal>> {
  const observable = assetKeys.filter((k) => parseAssetStorageLocation(k) !== null).slice(0, limit);
  const out = new Map<string, AssetSignal>();
  const results = await Promise.all(
    observable.map(async (key) => ({ key, signal: await observeAssetSignal(key) })),
  );
  for (const r of results) if (r.signal) out.set(r.key, r.signal);
  return out;
}
