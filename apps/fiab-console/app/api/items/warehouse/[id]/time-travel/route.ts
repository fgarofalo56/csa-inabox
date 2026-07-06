/**
 * GET  /api/items/warehouse/[id]/time-travel?container=&tablePath=
 *   Lists committed Delta versions for a table by reading its `_delta_log`
 *   directly from ADLS Gen2 — no engine required, zero Fabric dependency.
 *
 * POST /api/items/warehouse/[id]/time-travel
 *   { container, tablePath, mode: 'version'|'timestamp', version?, timestamp? }
 *   Runs the REAL Delta time-travel read and returns the rows as they existed
 *   at that point:
 *     version   → SELECT * FROM delta.`<abfss>` VERSION AS OF <n> LIMIT 100
 *     timestamp → SELECT * FROM delta.`<abfss>` TIMESTAMP AS OF '<ts>' LIMIT 100
 *   Executes on a Databricks SQL Warehouse — the Azure-native engine that
 *   speaks Delta time-travel SQL (Synapse Serverless does not). Honest-gates
 *   when Databricks is not configured; the version LIST above still works.
 *
 * Fabric parity: this is the Azure-native equivalent of the Warehouse
 * `OPTION (FOR TIMESTAMP AS OF …)` statement-level time travel.
 *   https://learn.microsoft.com/fabric/data-warehouse/time-travel
 *   https://learn.microsoft.com/azure/databricks/delta/history
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { databricksConfigGate, listWarehouses, executeStatement } from '@/lib/azure/databricks-client';
import { getAccountName } from '@/lib/azure/adls-client';
import { toAbfss } from '@/lib/azure/delta-source-uri';
import { listDeltaVersions, cleanTablePath, isKnownContainer } from '@/lib/azure/delta-history';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const container = req.nextUrl.searchParams.get('container') || '';
  const tablePath = cleanTablePath(req.nextUrl.searchParams.get('tablePath') || '');
  if (!container || !tablePath) return apiError('container and tablePath are required', 400);
  if (!isKnownContainer(container)) return apiError(`unknown container: ${container}`, 404);

  try {
    const versions = await listDeltaVersions(container, tablePath);
    return apiOk({ container, table: tablePath, versions });
  } catch (e: any) {
    if (e?.statusCode === 404) {
      return apiError(
        `No _delta_log under ${tablePath}/_delta_log — not a Delta table, or not materialized yet.`,
        404, { code: 'not_delta' },
      );
    }
    return apiServerError(e, 'Failed to read Delta history', 'history_failed');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const body = await req.json().catch(() => ({}));
  const container = String(body?.container || '');
  const tablePath = cleanTablePath(String(body?.tablePath || ''));
  const mode = body?.mode === 'timestamp' ? 'timestamp' : body?.mode === 'version' ? 'version' : null;
  const version = body?.version === undefined || body?.version === null ? undefined : Number(body.version);
  const timestamp = String(body?.timestamp || '').trim();

  if (!isKnownContainer(container)) return apiError(`unknown container: ${container}`, 404);
  if (!tablePath) return apiError('invalid tablePath', 400);
  if (!mode) return apiError("mode must be 'version' or 'timestamp'", 400);
  if (mode === 'version' && (version === undefined || !Number.isInteger(version) || version < 0)) {
    return apiError('version must be a non-negative integer', 400);
  }
  // Accept ISO8601 / 'YYYY-MM-DD[THH:MM:SS]' — reject anything with control or
  // quote chars before it reaches the (still quote-doubled) literal.
  if (mode === 'timestamp' && !/^[0-9T:\- .+Z]{4,40}$/.test(timestamp)) {
    return apiError('timestamp must be an ISO8601 date/datetime', 400);
  }

  // Honest infra-gate: Delta time-travel SQL requires Databricks.
  const gate = databricksConfigGate();
  if (gate) {
    return apiError(
      `Set ${gate.missing} to run point-in-time reads. Delta time-travel SQL (VERSION AS OF / TIMESTAMP AS OF) runs on a Databricks SQL Warehouse — Synapse Serverless does not support it. The version list (GET) still works without Databricks.`,
      503, { gated: true, code: 'no_databricks' },
    );
  }

  let warehouseId: string;
  let account: string;
  try {
    const warehouses = await listWarehouses();
    const wh = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
    if (!wh) return apiError('Databricks has no SQL Warehouse to run the time-travel query. Create one (Compute → SQL Warehouses).', 503, { gated: true, code: 'no_warehouse' });
    warehouseId = wh.id;
    account = getAccountName();
  } catch (e) {
    return apiServerError(e, 'Failed to resolve Databricks warehouse / storage account', 'setup_failed');
  }

  const abfss = toAbfss({ account, container, path: tablePath }).replace(/`/g, '');
  const asOf = mode === 'version'
    ? `VERSION AS OF ${version}`
    : `TIMESTAMP AS OF '${escapeSqlLiteral(timestamp)}'`;
  const sql = `SELECT * FROM delta.\`${abfss}\` ${asOf} LIMIT 100`;
  try {
    const result = await executeStatement(warehouseId, sql);
    return apiOk({
      mode, version: version ?? null, timestamp: mode === 'timestamp' ? timestamp : null, sql,
      columns: result.columns, rows: result.rows, rowCount: result.rowCount,
      executionMs: result.executionMs, truncated: result.truncated,
    });
  } catch (e) {
    return apiServerError(e, 'Delta time-travel query failed', 'timetravel_failed');
  }
}
