/**
 * N7c — Delta Change Data Feed (CDF) planner (PURE where possible).
 *
 * Incremental activation reads ONLY the rows that changed in the source Delta
 * table since the last successful run. The authoritative, engine-free way to
 * enumerate those change rows is the Delta transaction log:
 *
 *   • For each commit version in (fromVersionExclusive, toVersion]:
 *       – if the commit contains any `cdc` actions, those `_change_data/*.parquet`
 *         files ARE the change feed for that version (they carry a `_change_type`
 *         column: insert / update_preimage / update_postimage / delete). Per the
 *         Delta protocol a reader MUST use the cdc files and ignore add/remove
 *         for CDF when they are present.
 *       – otherwise the commit is an append: every `add` action with
 *         `dataChange:true` is a set of INSERT rows (Delta's optimization writes
 *         no cdc files for pure appends — the added data files are the change).
 *       – a `remove` with `dataChange:true` and NO cdc files in the same commit
 *         is a delete whose row data is gone; it cannot be represented as a
 *         row-level delete, so we flag it (the run reports the limitation).
 *
 * This module parses commit-JSON action lines into that plan. The physical read
 * of the planned parquet files is done by the sync engine via DuckDB; keeping
 * the PLANNING pure makes the protocol logic unit-testable against fixtures with
 * no lake or engine.
 *
 * Grounded in the Delta CDF + transaction-log protocol:
 *   https://learn.microsoft.com/azure/databricks/delta/delta-change-data-feed
 *   https://github.com/delta-io/delta/blob/master/PROTOCOL.md#change-data-files
 */

/** The CDF change types the postimage-oriented apply path cares about. */
export type DeltaChangeType = 'insert' | 'update_preimage' | 'update_postimage' | 'delete';

/** A parquet file to read for a CDF range, tagged with how to interpret it. */
export interface CdfFileRef {
  /** File path RELATIVE to the table root (as recorded in the commit `path`). */
  path: string;
  /** True for a `_change_data` cdc file (has a `_change_type` column). When
   *  false the file is an `add` data file whose rows are all inserts. */
  isCdc: boolean;
  /** The commit version this file belongs to. */
  version: number;
}

export interface CommitCdfPlan {
  files: CdfFileRef[];
  /** True when the commit deleted rows without cdc files (data unrecoverable). */
  hasUnrepresentableDeletes: boolean;
}

/** Parse a raw commit body (newline-delimited JSON actions) into action objects. */
export function parseCommitActions(body: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of String(body || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') out.push(obj as Record<string, unknown>);
    } catch {
      /* skip a malformed line — a partial commit is never applied */
    }
  }
  return out;
}

/**
 * Plan the CDF-relevant files for ONE commit's parsed actions.
 *
 * Precedence (protocol): cdc files win. If any `cdc` action is present, the
 * commit's change feed is exactly those files and `add`/`remove` are ignored
 * for CDF. Otherwise `add` files with dataChange are inserts, and a dataChange
 * `remove` with no cdc is an unrepresentable delete.
 */
export function planCommitCdf(actions: Record<string, unknown>[], version: number): CommitCdfPlan {
  const cdc: CdfFileRef[] = [];
  const adds: CdfFileRef[] = [];
  let sawDataChangeRemove = false;

  for (const a of actions) {
    const cdcAction = a.cdc as { path?: string } | undefined;
    if (cdcAction && typeof cdcAction.path === 'string' && cdcAction.path) {
      cdc.push({ path: cdcAction.path, isCdc: true, version });
      continue;
    }
    const add = a.add as { path?: string; dataChange?: boolean } | undefined;
    if (add && typeof add.path === 'string' && add.path && add.dataChange !== false) {
      adds.push({ path: add.path, isCdc: false, version });
      continue;
    }
    const remove = a.remove as { path?: string; dataChange?: boolean } | undefined;
    if (remove && remove.dataChange === true) {
      sawDataChangeRemove = true;
    }
  }

  if (cdc.length > 0) {
    // cdc files fully describe the change; adds/removes are the physical layout.
    return { files: cdc, hasUnrepresentableDeletes: false };
  }
  return { files: adds, hasUnrepresentableDeletes: sawDataChangeRemove && adds.length === 0 };
}

/** Deps for reading commit bodies (injected so the range planner is testable). */
export interface CdfRangeDeps {
  /** Newest-first list of committed versions (from delta-history.listDeltaVersions). */
  listVersions: (container: string, tablePath: string) => Promise<{ version: number }[]>;
  /** Download a single commit JSON body for a version. */
  downloadCommit: (container: string, tablePath: string, version: number) => Promise<string>;
}

export interface CdfRangePlan {
  /** All change files across the range, in ascending version order. */
  files: CdfFileRef[];
  /** Highest version included (the new watermark on success). */
  toVersion: number;
  /** Lowest version actually read (exclusive lower bound + 1), for the receipt. */
  fromVersion: number;
  /** True when any commit in range dropped rows without cdc files. */
  hasUnrepresentableDeletes: boolean;
  /** Versions with no change files (metadata-only commits) — informational. */
  emptyVersions: number[];
}

/**
 * Plan the change files for (fromVersionExclusive, toVersion]. When `toVersion`
 * is undefined the newest committed version is used. Returns an empty plan when
 * the source is already at the watermark (nothing to do).
 */
export async function planCdfRange(
  deps: CdfRangeDeps,
  container: string,
  tablePath: string,
  fromVersionExclusive: number,
  toVersion?: number,
): Promise<CdfRangePlan> {
  const versions = (await deps.listVersions(container, tablePath))
    .map((v) => v.version)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const newest = versions.length ? versions[versions.length - 1] : -1;
  const target = typeof toVersion === 'number' ? Math.min(toVersion, newest) : newest;
  const inRange = versions.filter((v) => v > fromVersionExclusive && v <= target);

  const files: CdfFileRef[] = [];
  const emptyVersions: number[] = [];
  let hasUnrepresentableDeletes = false;
  for (const v of inRange) {
    const body = await deps.downloadCommit(container, tablePath, v);
    const plan = planCommitCdf(parseCommitActions(body), v);
    if (plan.files.length === 0) emptyVersions.push(v);
    if (plan.hasUnrepresentableDeletes) hasUnrepresentableDeletes = true;
    for (const f of plan.files) files.push(f);
  }
  return {
    files,
    toVersion: target,
    fromVersion: inRange.length ? inRange[0] : fromVersionExclusive + 1,
    hasUnrepresentableDeletes,
    emptyVersions,
  };
}

/** Zero-pad a Delta commit version to the 20-digit log filename. */
export function commitFileName(version: number): string {
  return `${String(version).padStart(20, '0')}.json`;
}
