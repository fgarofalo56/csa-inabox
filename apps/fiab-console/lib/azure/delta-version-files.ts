/**
 * delta-version-files — reconstruct the exact set of ACTIVE data files a Delta
 * table had at a given commit version, by replaying the `add`/`remove` actions
 * in its `_delta_log/*.json` commits. This is what lets N7d's data-diff read one
 * table AS OF two different versions through DuckDB `read_parquet([...])` — an
 * exact, extension-independent time-travel that works fully in an air-gapped
 * IL5 enclave (no Spark, no Fabric, no delta-extension version-pin feature).
 *
 * The pure {@link replayActiveFiles} does the add/remove folding and is
 * unit-tested; {@link activeFilesAtVersion} is the thin ADLS-reading wrapper
 * (reuses adls-client, exactly like delta-history).
 *
 * Grounded in the Delta transaction-log protocol:
 *   https://github.com/delta-io/delta/blob/master/PROTOCOL.md
 *
 * NOTE (honest limitation): this replays the JSON commit chain from version 0.
 * If the table has a checkpoint AND older commit JSONs were vacuumed past the
 * log-retention window, versions before the earliest retained commit cannot be
 * reconstructed from JSON alone — the caller surfaces that as an honest error
 * rather than a wrong diff. Typical lakehouse tables retain 30 days of log.
 */

import { listPaths, downloadFile } from './adls-client';

/** One parsed Delta log commit's file mutations (paths are table-relative). */
export interface CommitFileActions {
  version: number;
  added: string[];
  removed: string[];
}

/**
 * Fold a version-ordered list of commit actions into the set of active file
 * paths at `targetVersion` (inclusive). Pure + deterministic. A path added then
 * later removed is absent; a path removed then re-added is present. Commits with
 * a version greater than the target are ignored (time-travel to the past).
 */
export function replayActiveFiles(commits: CommitFileActions[], targetVersion: number): string[] {
  const active = new Set<string>();
  const ordered = commits.slice().sort((a, b) => a.version - b.version);
  for (const c of ordered) {
    if (c.version > targetVersion) break;
    for (const rm of c.removed) active.delete(rm);
    for (const add of c.added) active.add(add);
  }
  return Array.from(active);
}

/** Reject path traversal; trim slashes. Returns null if invalid. */
export function cleanTablePath(p: string): string | null {
  const raw = (p || '').trim();
  let a = 0;
  let b = raw.length;
  while (a < b && raw.charCodeAt(a) === 47) a++;
  while (b > a && raw.charCodeAt(b - 1) === 47) b--;
  const t = raw.slice(a, b);
  if (!t || t.includes('..')) return null;
  return t;
}

/** Read + parse every JSON commit file's add/remove actions for a table. */
export async function readCommitActions(container: string, tablePath: string, cap = 2000): Promise<CommitFileActions[]> {
  const logDir = `${tablePath}/_delta_log`;
  const entries = await listPaths(container, logDir, cap);
  const commitFiles = entries
    .filter((e) => !e.isDirectory && /\/\d{20}\.json$/.test(e.name))
    .map((e) => ({ name: e.name, version: Number(e.name.split('/').pop()!.replace('.json', '')) }))
    .filter((e) => Number.isFinite(e.version))
    .sort((a, b) => a.version - b.version);

  const out: CommitFileActions[] = [];
  await Promise.all(
    commitFiles.map(async (cf) => {
      const added: string[] = [];
      const removed: string[] = [];
      try {
        const { body } = await downloadFile(container, cf.name);
        for (const line of body.toString('utf8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let action: Record<string, unknown>;
          try { action = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
          const addAction = action.add as { path?: string } | undefined;
          const removeAction = action.remove as { path?: string } | undefined;
          if (addAction?.path) added.push(decodePath(addAction.path));
          if (removeAction?.path) removed.push(decodePath(removeAction.path));
        }
      } catch {
        /* an unreadable commit contributes nothing — the caller may 404 upstream */
      }
      out.push({ version: cf.version, added, removed });
    }),
  );
  return out.sort((a, b) => a.version - b.version);
}

/** Delta log paths are URL-encoded (spaces, partition `=`); DuckDB wants the raw path. */
function decodePath(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}

/** The highest committed version present in the log (for validating a requested version). */
export function maxVersion(commits: CommitFileActions[]): number {
  return commits.reduce((mx, c) => Math.max(mx, c.version), -1);
}

/**
 * Reconstruct the active table-relative data-file paths at `version`. Throws
 * (statusCode 404) when the log has no commits, or (statusCode 400) when the
 * requested version is newer than the latest commit — an honest error, never a
 * silently-wrong file set.
 */
export async function activeFilesAtVersion(
  container: string,
  tablePath: string,
  version: number,
): Promise<{ files: string[]; latestVersion: number }> {
  const commits = await readCommitActions(container, tablePath);
  if (commits.length === 0) {
    const err = new Error(`No Delta commit log under ${container}/${tablePath}/_delta_log (not a Delta table, or not materialized).`) as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  const latestVersion = maxVersion(commits);
  const earliest = commits[0].version;
  if (version > latestVersion) {
    const err = new Error(`Version ${version} does not exist — the table's latest committed version is ${latestVersion}.`) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  if (version < earliest) {
    const err = new Error(`Version ${version} predates the earliest retained commit (${earliest}); older log files were vacuumed and cannot be reconstructed from JSON.`) as Error & { statusCode?: number };
    err.statusCode = 400;
    throw err;
  }
  return { files: replayActiveFiles(commits, version), latestVersion };
}
