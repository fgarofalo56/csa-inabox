/**
 * N7c — activation-sync RUN SERVICE (server-only).
 *
 * The single place that wires the pure sync-engine to REAL backends and
 * persists the outcome, shared by BOTH callers so their run/watermark/audit
 * records can never diverge:
 *   • POST /api/items/activation-sync/[id]/run   (the Run button)
 *   • the N5 asset materializer                  (a data-change trigger)
 *
 * It loads the owned item, validates the spec, runs the engine (full or Delta-
 * CDF incremental) against DuckDB + the destination, prepends the run to the
 * bounded run history, advances the incremental watermark on success, writes an
 * `_auditLog` row (AUDIT), and routes an O1 alert on failure (inside the engine).
 *
 * Azure-native, no Fabric. DuckDB reads the lake in place; when the serving tier
 * is not deployed the run is an HONEST gate naming LOOM_DUCKDB_URL rather than a
 * fabricated success.
 */

import type { SessionPayload } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { duckdbQueryJson, isDuckDbConfigured } from '@/lib/azure/duckdb-client';
import { listDeltaVersions } from '@/lib/azure/delta-history';
import { downloadFile, getAccountName } from '@/lib/azure/adls-client';
import { dfsSuffix } from '@/lib/azure/cloud-endpoints';
import { dispatchAlert } from '@/lib/azure/alert-dispatch';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { writeToDataverse } from './dataverse-sink';
import { sendWebhook, sendEventGrid, sendServiceBus } from './destinations';
import { runActivationSync, type SyncEngineDeps } from './sync-engine';
import { commitFileName } from './cdf-planner';
import {
  coerceSpec, validateForRun, MAX_RUN_HISTORY,
  type ActivationMode, type ActivationRun, type ActivationSyncSpec,
} from './types';

export const ACTIVATION_ITEM_TYPE = 'activation-sync';

export interface RunServiceResult {
  ok: boolean;
  /** Present on a completed attempt (succeeded OR failed). */
  run?: ActivationRun;
  /** HTTP-ish status for the BFF layer. */
  status: number;
  /** Precise error / gate message when ok=false and no run was produced. */
  error?: string;
  /** The env var an operator must set to clear a config gate. */
  missing?: string;
  /** The persisted spec after the run (for the caller to echo). */
  spec?: ActivationSyncSpec;
}

/** Build the REAL engine deps (DuckDB + lake + destinations + alerting). */
export function realEngineDeps(): SyncEngineDeps {
  return {
    runDuckSql: async (sql, maxRows) => {
      const body = await duckdbQueryJson(sql, maxRows);
      return { columns: (body.columns || []).map((c) => ({ name: c.name })), rows: body.rows || [] };
    },
    listVersions: async (container, tablePath) => {
      const vs = await listDeltaVersions(container, tablePath);
      return vs.map((v) => ({ version: v.version }));
    },
    downloadCommit: async (container, tablePath, version) => {
      const { body } = await downloadFile(container, `${tablePath}/_delta_log/${commitFileName(version)}`);
      return body.toString('utf8');
    },
    account: () => getAccountName(),
    dfsSuffix: () => dfsSuffix(),
    writeDataverse: (config, rows) => writeToDataverse(config, rows),
    sendWebhook: (dest, rows, meta) => sendWebhook(dest, rows, meta),
    sendEventGrid: (dest, rows, meta) => sendEventGrid(dest, rows, meta),
    sendServiceBus: (dest, rows, meta) => sendServiceBus(dest, rows, meta),
    dispatchAlert: (a) => dispatchAlert(a),
  };
}

/**
 * Execute one activation run for an owned item and persist the outcome. Returns
 * a structured result — never throws for a data/destination failure (that is a
 * `failed` run), only for an unexpected programming error.
 */
export async function executeActivationRun(
  session: SessionPayload,
  itemId: string,
  mode: ActivationMode,
  deps: SyncEngineDeps = realEngineDeps(),
): Promise<RunServiceResult> {
  const item = await loadOwnedItem(itemId, ACTIVATION_ITEM_TYPE, session.claims.oid);
  if (!item) return { ok: false, status: 404, error: 'not found' };

  const spec = coerceSpec(item.state);
  const problems = validateForRun(spec, mode);
  if (problems.length) {
    return { ok: false, status: 400, error: problems.map((p) => p.message).join(' ') };
  }

  // Reading Delta needs the DuckDB serving tier. Honest gate when it is not
  // deployed (no fabricated success) — every other surface stays up.
  if (!isDuckDbConfigured()) {
    return {
      ok: false, status: 503, missing: 'LOOM_DUCKDB_URL',
      error: 'The DuckDB serving tier that reads the lake in place is not deployed. Set LOOM_DUCKDB_URL on the console app (deploy the loom-duckdb Container App) to run activation syncs.',
    };
  }

  const outcome = await runActivationSync(deps, { itemId, spec, mode });
  const run = outcome.run;

  // Prepend to bounded run history + advance the watermark on success.
  const nextRuns: ActivationRun[] = [run, ...(spec.runs || [])].slice(0, MAX_RUN_HISTORY);
  const nextSpec: ActivationSyncSpec = {
    ...spec,
    runs: nextRuns,
    ...(typeof outcome.lastSyncedVersion === 'number' ? { lastSyncedVersion: outcome.lastSyncedVersion } : {}),
  };
  await updateOwnedItem(itemId, ACTIVATION_ITEM_TYPE, session.claims.oid, { state: nextSpec as unknown as Record<string, unknown> });

  await writeAudit(session, item.workspaceId, itemId, run).catch(() => { /* audit is best-effort */ });

  return { ok: run.status !== 'failed', status: run.status === 'failed' ? 502 : 200, run, spec: nextSpec };
}

async function writeAudit(
  session: SessionPayload, workspaceId: string, itemId: string, run: ActivationRun,
): Promise<void> {
  const al = await auditLogContainer();
  await al.items.create({
    id: globalThis.crypto?.randomUUID?.() ?? `act-${Date.now()}`,
    tenantId: session.claims.tid || session.claims.oid,
    itemId,
    itemType: ACTIVATION_ITEM_TYPE,
    workspaceId,
    action: `activation-sync.run.${run.mode}`,
    summary:
      `Activation sync ${run.mode} by ${session.claims.upn} — ${run.status} `
      + `(${run.rowsRead} read, ${run.upserts} upsert, ${run.deletes} delete, ${run.errors} error)`
      + (run.detail ? ` — ${run.detail.slice(0, 200)}` : ''),
    runId: run.runId,
    outcome: run.status === 'succeeded' ? 'success' : 'failure',
    upn: session.claims.upn,
    actorOid: session.claims.oid,
    at: run.finishedAt || run.startedAt,
  });
}
