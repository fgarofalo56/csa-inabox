/**
 * delta-history — read a Delta Lake table's version history + checkpoints
 * directly from its `_delta_log/` on ADLS Gen2, with NO SQL engine required.
 *
 * The `commitInfo` action in each `NN…NN.json` commit file carries the exact
 * fields Spark's `DESCRIBE HISTORY` returns (version, timestamp, operation,
 * operationMetrics, userName). Checkpoints are `*.checkpoint.parquet` snapshots
 * of the log, pointed at by `_last_checkpoint`. This is the Azure-native,
 * zero-Fabric-dependency backend behind the Warehouse time-travel + snapshots
 * surfaces (rel-T82) — the same mechanism the lakehouse History pane uses.
 *
 * Grounded in the Delta transaction-log protocol:
 *   https://learn.microsoft.com/azure/databricks/delta/history
 *   https://github.com/delta-io/delta/blob/master/PROTOCOL.md
 */

import { KNOWN_CONTAINERS, listPaths, downloadFile } from './adls-client';

export interface DeltaVersion {
  version: number;
  timestamp: string; // ISO8601 ('' when unknown)
  operation: string;
  userName?: string;
  metrics: {
    numOutputRows?: number;
    numFiles?: number;
    numRemovedFiles?: number;
    numDeletedRows?: number;
    numOutputBytes?: number;
  };
  operationParameters?: Record<string, unknown>;
}

export interface DeltaCheckpoint {
  version: number;
  /** true when `_last_checkpoint` currently points at this checkpoint. */
  isLatest: boolean;
  sizeBytes: number;
  parts: number;
}

export function isKnownContainer(c: string): boolean {
  return (KNOWN_CONTAINERS as readonly string[]).includes(c);
}

/** Reject path traversal + leading/trailing slashes; returns null if invalid. */
export function cleanTablePath(p: string): string | null {
  const t = (p || '').trim().replace(/^\/+|\/+$/g, '');
  if (!t) return null;
  if (t.includes('..')) return null;
  return t;
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * List committed Delta versions (newest first, capped) by reading the commit
 * JSON files under `<tablePath>/_delta_log`. Throws with `statusCode` 404 when
 * the log folder does not exist (not a Delta table / not materialized yet).
 */
export async function listDeltaVersions(
  container: string,
  tablePath: string,
  cap = 50,
): Promise<DeltaVersion[]> {
  const logDir = `${tablePath}/_delta_log`;
  const entries = await listPaths(container, logDir, 500);
  // Commit files are zero-padded 20-digit decimals: 00000000000000000001.json.
  const commitFiles = entries
    .filter((e) => !e.isDirectory && /\/\d{20}\.json$/.test(e.name))
    .map((e) => ({ name: e.name, version: Number(e.name.split('/').pop()!.replace('.json', '')) }))
    .filter((e) => Number.isFinite(e.version))
    .sort((a, b) => b.version - a.version)
    .slice(0, cap);

  const versions: DeltaVersion[] = [];
  await Promise.all(
    commitFiles.map(async (cf) => {
      try {
        const { body } = await downloadFile(container, cf.name);
        const text = body.toString('utf8');
        let commitInfo: any = null;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let action: any;
          try { action = JSON.parse(trimmed); } catch { continue; }
          if (action && action.commitInfo) { commitInfo = action.commitInfo; break; }
        }
        const tsMs = num(commitInfo?.timestamp);
        const m = commitInfo?.operationMetrics || {};
        versions.push({
          version: cf.version,
          timestamp: tsMs !== undefined ? new Date(tsMs).toISOString() : '',
          operation: commitInfo?.operation || 'UNKNOWN',
          userName: commitInfo?.userName || commitInfo?.userId || undefined,
          metrics: {
            numOutputRows: num(m.numOutputRows),
            numFiles: num(m.numFiles),
            numRemovedFiles: num(m.numRemovedFiles),
            numDeletedRows: num(m.numDeletedRows),
            numOutputBytes: num(m.numOutputBytes),
          },
          operationParameters: commitInfo?.operationParameters,
        });
      } catch {
        versions.push({ version: cf.version, timestamp: '', operation: 'UNKNOWN', metrics: {} });
      }
    }),
  );
  versions.sort((a, b) => b.version - a.version);
  return versions;
}

/**
 * List Delta checkpoint snapshots for a table (from `*.checkpoint.parquet` +
 * the `_last_checkpoint` pointer). Each checkpoint is a consistent point-in-time
 * snapshot of the table state — Loom surfaces them as recoverable "snapshots".
 */
export async function listDeltaCheckpoints(
  container: string,
  tablePath: string,
): Promise<DeltaCheckpoint[]> {
  const logDir = `${tablePath}/_delta_log`;
  const entries = await listPaths(container, logDir, 500);

  // Resolve the current checkpoint version from _last_checkpoint (best-effort).
  let latestVersion: number | undefined;
  try {
    const { body } = await downloadFile(container, `${logDir}/_last_checkpoint`);
    const j = JSON.parse(body.toString('utf8'));
    latestVersion = num(j?.version);
  } catch { /* no pointer yet — checkpoints may still exist */ }

  // Checkpoint files: NN…NN.checkpoint.parquet  or  NN…NN.checkpoint.MM.PP.parquet
  const byVersion = new Map<number, { size: number; parts: number }>();
  for (const e of entries) {
    if (e.isDirectory) continue;
    const base = e.name.split('/').pop() || '';
    const m = base.match(/^(\d{20})\.checkpoint\..*parquet$/);
    if (!m) continue;
    const version = Number(m[1]);
    if (!Number.isFinite(version)) continue;
    const prev = byVersion.get(version) || { size: 0, parts: 0 };
    byVersion.set(version, { size: prev.size + (e.size || 0), parts: prev.parts + 1 });
  }

  return Array.from(byVersion.entries())
    .map(([version, agg]): DeltaCheckpoint => ({
      version,
      isLatest: latestVersion !== undefined && version === latestVersion,
      sizeBytes: agg.size,
      parts: agg.parts,
    }))
    .sort((a, b) => b.version - a.version);
}
