/**
 * N7c — activation-sync ENGINE: read the source, map, push to the destination.
 *
 * FULL mode reads the whole source Delta table (DuckDB `delta_scan` on the
 * loom-duckdb serving tier, reading the lake in place). INCREMENTAL mode plans
 * the source table's Change Data Feed via the transaction log (cdf-planner) and
 * reads ONLY the changed rows' parquet files (`read_parquet`), so a run after a
 * small edit moves a handful of rows, not the whole table. Both paths apply the
 * dropdown-picked field mapping and hand idempotent upsert/delete rows to the
 * destination (Dataverse first-class; webhook / Event Grid / Service Bus).
 *
 * Idempotency: Dataverse upserts key by an alternate key (create-or-update);
 * the other destinations carry a stable `<itemId>:<key>:<version>` dedup id. A
 * replayed run therefore converges to the same destination state.
 *
 * O1: a failed run routes an alert through the ONE alert-dispatch convention.
 *
 * Every external effect is an injected dep so the whole orchestration is
 * unit-testable with no lake, no DuckDB tier, and no Azure. No Fabric on any
 * path. IL5: the DuckDB tier + webhook/EG/SB endpoints are in-boundary; the
 * Dataverse SaaS leg is honest-gated, never required.
 */

import type {
  ActivationSyncSpec, ActivationMode, ActivationRun, FieldMapping,
} from './types';
import { planCdfRange, type CdfFileRef } from './cdf-planner';
import type { DataverseSinkResult, DataverseWriteRow } from './dataverse-sink';
import type { ActivationOutRow, DestinationResult } from './destinations';

/** A source row read from the lake (column name → value), plus its CDF change type. */
export interface EngineRow {
  data: Record<string, unknown>;
  /** insert | update_postimage | update_preimage | delete | undefined(=full read). */
  changeType?: string;
}

export interface AlertLike {
  source: string;
  severity: 'P1' | 'P2' | 'P3';
  title: string;
  body: string;
  dedupKey?: string;
}

/** Everything the engine needs from the outside world — all injectable. */
export interface SyncEngineDeps {
  /** Run a SQL statement on the DuckDB serving tier → columns + row arrays. */
  runDuckSql: (sql: string, maxRows?: number) => Promise<{ columns: { name: string }[]; rows: unknown[][] }>;
  /** Newest-first committed versions of a Delta table. */
  listVersions: (container: string, tablePath: string) => Promise<{ version: number }[]>;
  /** Download one commit JSON body for a version. */
  downloadCommit: (container: string, tablePath: string, version: number) => Promise<string>;
  /** Lake storage account name (for abfss URIs). */
  account: () => string;
  /** DFS host suffix (cloud-aware). */
  dfsSuffix: () => string;
  /** Apply Dataverse upsert/delete rows. */
  writeDataverse: (
    config: { environmentId: string; entitySetName: string; keyAttribute: string; instanceUrl?: string },
    rows: DataverseWriteRow[],
  ) => Promise<DataverseSinkResult>;
  sendWebhook: (dest: any, rows: ActivationOutRow[], meta: { itemId: string; mode: string; toVersion?: number }) => Promise<DestinationResult>;
  sendEventGrid: (dest: any, rows: ActivationOutRow[], meta: { itemId: string; toVersion?: number }) => Promise<DestinationResult>;
  sendServiceBus: (dest: any, rows: ActivationOutRow[], meta: { itemId: string; toVersion?: number }) => Promise<DestinationResult>;
  /** Route a failure alert (defaults to the real alert-dispatch). */
  dispatchAlert?: (alert: AlertLike) => Promise<unknown>;
  /** Clock + id seams for deterministic tests. */
  now?: () => Date;
  newId?: () => string;
}

const CHANGE_META_COLS = new Set(['_change_type', '_commit_version', '_commit_timestamp']);
/** DuckDB read cap per source read (mirrors buildLakeScanSql's ceiling). */
const READ_CAP = 200_000;

/** Turn a DuckDB {columns, rows[][]} result into row objects. */
export function rowsToObjects(res: { columns: { name: string }[]; rows: unknown[][] }): Record<string, unknown>[] {
  const names = res.columns.map((c) => c.name);
  return res.rows.map((r) => {
    const obj: Record<string, unknown> = {};
    names.forEach((n, i) => { obj[n] = r[i]; });
    return obj;
  });
}

/** Build an abfss URI for a table-relative file (or the table root when file is ''). */
export function buildAbfssUri(account: string, suffix: string, container: string, tablePath: string, file = ''): string {
  const path = `${tablePath.replace(/^\/+|\/+$/g, '')}${file ? `/${file.replace(/^\/+/, '')}` : ''}`;
  return `abfss://${container}@${account}.${suffix}/${path}`;
}

/** Reject a lake file path that could break out of a single-quoted SQL literal. */
export function isSafeFilePath(p: string): boolean {
  return typeof p === 'string' && p.length > 0 && !p.includes("'") && /^[A-Za-z0-9._\-/=%+ ]+$/.test(p);
}

/** SELECT full source rows via delta_scan. */
export async function readFullRows(
  deps: SyncEngineDeps, container: string, tablePath: string,
): Promise<EngineRow[]> {
  const uri = buildAbfssUri(deps.account(), deps.dfsSuffix(), container, tablePath);
  const sql = `SELECT * FROM delta_scan('${uri}') LIMIT ${READ_CAP}`;
  const res = await deps.runDuckSql(sql, READ_CAP);
  return rowsToObjects(res).map((data) => ({ data }));
}

/**
 * Read change rows for a CDF range. cdc files carry `_change_type`; add files
 * are pure inserts. update_preimage rows are dropped (only postimages apply).
 */
export async function readIncrementalRows(
  deps: SyncEngineDeps, container: string, tablePath: string, fromVersionExclusive: number,
): Promise<{ rows: EngineRow[]; toVersion: number; hasUnrepresentableDeletes: boolean; changedFiles: number }> {
  const plan = await planCdfRange(
    { listVersions: deps.listVersions, downloadCommit: deps.downloadCommit },
    container, tablePath, fromVersionExclusive,
  );
  const cdcFiles = plan.files.filter((f) => f.isCdc);
  const addFiles = plan.files.filter((f) => !f.isCdc);
  const rows: EngineRow[] = [];

  const toUri = (f: CdfFileRef) => buildAbfssUri(deps.account(), deps.dfsSuffix(), container, tablePath, f.path);

  if (cdcFiles.length) {
    for (const f of cdcFiles) if (!isSafeFilePath(f.path)) throw new Error(`Unsafe CDF file path: ${f.path}`);
    const list = cdcFiles.map((f) => `'${toUri(f)}'`).join(', ');
    const res = await deps.runDuckSql(`SELECT * FROM read_parquet([${list}]) LIMIT ${READ_CAP}`, READ_CAP);
    for (const obj of rowsToObjects(res)) {
      const ct = String(obj['_change_type'] ?? 'insert');
      if (ct === 'update_preimage') continue;
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) if (!CHANGE_META_COLS.has(k)) data[k] = v;
      rows.push({ data, changeType: ct });
    }
  }
  if (addFiles.length) {
    for (const f of addFiles) if (!isSafeFilePath(f.path)) throw new Error(`Unsafe add-file path: ${f.path}`);
    const list = addFiles.map((f) => `'${toUri(f)}'`).join(', ');
    const res = await deps.runDuckSql(`SELECT * FROM read_parquet([${list}]) LIMIT ${READ_CAP}`, READ_CAP);
    for (const obj of rowsToObjects(res)) rows.push({ data: obj, changeType: 'insert' });
  }
  return { rows, toVersion: plan.toVersion, hasUnrepresentableDeletes: plan.hasUnrepresentableDeletes, changedFiles: plan.files.length };
}

/** Apply the field mapping to a source row → destination payload. */
export function mapFields(row: Record<string, unknown>, mapping: FieldMapping[]): Record<string, unknown> {
  if (mapping.length === 0) {
    // Pass-through: drop CDF meta columns.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (!CHANGE_META_COLS.has(k)) out[k] = v;
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const m of mapping) out[m.target] = row[m.source];
  return out;
}

function isDeleteChange(changeType?: string): boolean {
  return changeType === 'delete';
}

/** Params for one sync run (the persisted spec + run coordinates). */
export interface RunParams {
  itemId: string;
  spec: ActivationSyncSpec;
  mode: ActivationMode;
}

export interface RunOutcome {
  run: ActivationRun;
  /** New watermark to persist on success (undefined = leave unchanged). */
  lastSyncedVersion?: number;
}

/**
 * Execute one activation sync. Reads the source (full or CDF-incremental), maps,
 * writes to the destination, and returns a run record + the watermark to persist.
 * Never throws for a data/destination failure — it records a `failed` run and
 * routes an O1 alert. A programming error still propagates.
 */
export async function runActivationSync(deps: SyncEngineDeps, params: RunParams): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}`));
  const { itemId, spec, mode } = params;
  const startedAt = now().toISOString();
  const runId = newId();
  const source = spec.source!;
  const dest = spec.destination!;

  const run: ActivationRun = {
    runId, startedAt, mode, status: 'running', rowsRead: 0, upserts: 0, deletes: 0, errors: 0,
  };

  try {
    let rows: EngineRow[];
    let toVersion: number | undefined;
    if (mode === 'incremental') {
      const from = typeof spec.lastSyncedVersion === 'number' ? spec.lastSyncedVersion : -1;
      const inc = await readIncrementalRows(deps, source.container, source.path, from);
      rows = inc.rows;
      toVersion = inc.toVersion;
      run.fromVersion = from + 1;
      run.toVersion = inc.toVersion;
      if (inc.hasUnrepresentableDeletes) {
        run.detail = 'Some source deletes had no Change Data Feed files and were skipped — enable delta.enableChangeDataFeed on the source table to propagate deletes.';
      }
    } else {
      rows = await readFullRows(deps, source.container, source.path);
      // Record the current watermark so a later incremental run starts here.
      const versions = await deps.listVersions(source.container, source.path).catch(() => []);
      toVersion = versions.length ? Math.max(...versions.map((v) => v.version)) : undefined;
      run.toVersion = toVersion;
    }
    run.rowsRead = rows.length;

    const result = await applyToDestination(deps, itemId, spec, dest, rows, mode, toVersion);
    run.upserts = result.upserts;
    run.deletes = result.deletes;
    run.errors = result.errors;
    run.status = result.errors > 0 ? 'failed' : 'succeeded';
    run.finishedAt = now().toISOString();
    if (result.firstError) run.detail = `${run.detail ? run.detail + ' ' : ''}${result.firstError}`;

    if (run.status === 'failed') {
      await routeAlert(deps, itemId, run);
      return { run };
    }
    return { run, lastSyncedVersion: toVersion };
  } catch (e) {
    run.status = 'failed';
    run.finishedAt = now().toISOString();
    run.errors = run.errors || 1;
    run.detail = (e as Error)?.message || String(e);
    await routeAlert(deps, itemId, run);
    return { run };
  }
}

interface ApplyResult { upserts: number; deletes: number; errors: number; firstError?: string }

async function applyToDestination(
  deps: SyncEngineDeps,
  itemId: string,
  spec: ActivationSyncSpec,
  dest: NonNullable<ActivationSyncSpec['destination']>,
  rows: EngineRow[],
  mode: ActivationMode,
  toVersion: number | undefined,
): Promise<ApplyResult> {
  const keyColumn = spec.keyColumn;

  if (dest.kind === 'dataverse') {
    const writeRows: DataverseWriteRow[] = rows.map((r) => ({
      keyValue: keyColumn ? r.data[keyColumn] : undefined,
      fields: mapFields(r.data, spec.mapping),
      op: isDeleteChange(r.changeType) ? 'delete' : 'upsert',
    }));
    const res = await deps.writeDataverse(
      { environmentId: dest.environmentId, entitySetName: dest.entitySetName, keyAttribute: dest.keyAttribute, instanceUrl: dest.instanceUrl },
      writeRows,
    );
    return res;
  }

  // Non-Dataverse: build ActivationOutRow[] with stable dedup ids.
  const outRows: ActivationOutRow[] = rows.map((r, i) => {
    const key = keyColumn && r.data[keyColumn] != null ? String(r.data[keyColumn]) : `row-${i}`;
    return {
      dedupId: `${itemId}:${key}:${toVersion ?? 'full'}`,
      key,
      op: isDeleteChange(r.changeType) ? 'delete' : 'upsert',
      data: mapFields(r.data, spec.mapping),
    };
  });

  if (dest.kind === 'webhook') return deps.sendWebhook(dest, outRows, { itemId, mode, toVersion });
  if (dest.kind === 'event-grid') return deps.sendEventGrid(dest, outRows, { itemId, toVersion });
  if (dest.kind === 'service-bus') return deps.sendServiceBus(dest, outRows, { itemId, toVersion });
  return { upserts: 0, deletes: 0, errors: rows.length, firstError: 'Unknown destination kind' };
}

async function routeAlert(deps: SyncEngineDeps, itemId: string, run: ActivationRun): Promise<void> {
  if (!deps.dispatchAlert) return;
  try {
    await deps.dispatchAlert({
      source: 'activation-sync',
      severity: 'P2',
      title: `Activation sync failed (${itemId})`,
      body: `Run ${run.runId} (${run.mode}) failed with ${run.errors} error(s). ${run.detail || ''}`.trim(),
      dedupKey: `activation-sync:${itemId}`,
    });
  } catch {
    /* alerting is a best-effort side channel — never fail the run for it */
  }
}
