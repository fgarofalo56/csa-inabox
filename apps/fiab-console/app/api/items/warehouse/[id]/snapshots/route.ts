/**
 * GET  /api/items/warehouse/[id]/snapshots?container=&tablePath=
 *   Lists a Delta table's recoverable SNAPSHOTS — its committed versions and
 *   the `*.checkpoint.parquet` consistency snapshots — read directly from
 *   `_delta_log` on ADLS Gen2. No engine required, zero Fabric dependency.
 *
 * POST /api/items/warehouse/[id]/snapshots
 *   { container, tablePath, targetPath?, version? }
 *   Creates a point-in-time SNAPSHOT of the table as a zero-copy Delta SHALLOW
 *   CLONE (a read-only point-in-time copy — Fabric "warehouse snapshot"
 *   semantics) on a Databricks SQL Warehouse. Honest-gates when Databricks is
 *   not configured; the snapshot LIST above still works.
 *
 * Fabric parity: Azure-native equivalent of Fabric Warehouse snapshots.
 *   https://learn.microsoft.com/fabric/data-warehouse/warehouse-snapshot
 *   https://learn.microsoft.com/azure/databricks/delta/clone
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { databricksConfigGate, listWarehouses, executeStatement } from '@/lib/azure/databricks-client';
import { getAccountName } from '@/lib/azure/adls-client';
import { toAbfss } from '@/lib/azure/delta-source-uri';
import { listDeltaVersions, listDeltaCheckpoints, cleanTablePath, isKnownContainer } from '@/lib/azure/delta-history';

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
    const [versions, checkpoints] = await Promise.all([
      listDeltaVersions(container, tablePath),
      listDeltaCheckpoints(container, tablePath).catch(() => []),
    ]);
    return apiOk({ container, table: tablePath, versions, checkpoints });
  } catch (e: any) {
    if (e?.statusCode === 404) {
      return apiError(
        `No _delta_log under ${tablePath}/_delta_log — not a Delta table, or not materialized yet.`,
        404, { code: 'not_delta' },
      );
    }
    return apiServerError(e, 'Failed to list snapshots', 'list_failed');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const body = await req.json().catch(() => ({}));
  const container = String(body?.container || '');
  const tablePath = cleanTablePath(String(body?.tablePath || ''));
  const version = body?.version === undefined || body?.version === null ? undefined : Number(body.version);
  if (!isKnownContainer(container)) return apiError(`unknown container: ${container}`, 404);
  if (!tablePath) return apiError('invalid tablePath', 400);
  if (version !== undefined && (!Number.isInteger(version) || version < 0)) {
    return apiError('version must be a non-negative integer', 400);
  }
  // Default snapshot target: <table>_snapshot_<utc>; a caller-supplied path is
  // validated + traversal-checked just like the source.
  const targetPath = body?.targetPath
    ? cleanTablePath(String(body.targetPath))
    : `${tablePath}_snapshot_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  if (!targetPath) return apiError('invalid targetPath', 400);

  const gate = databricksConfigGate();
  if (gate) {
    return apiError(
      `Set ${gate.missing} to create snapshots. A zero-copy Delta snapshot (SHALLOW CLONE) runs on a Databricks SQL Warehouse — Synapse Serverless cannot. The snapshot list (GET) still works without Databricks.`,
      503, { gated: true, code: 'no_databricks' },
    );
  }
  let warehouseId: string;
  let account: string;
  try {
    const warehouses = await listWarehouses();
    const wh = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
    if (!wh) return apiError('Databricks has no SQL Warehouse to create the snapshot. Create one (Compute → SQL Warehouses).', 503, { gated: true, code: 'no_warehouse' });
    warehouseId = wh.id;
    account = getAccountName();
  } catch (e) {
    return apiServerError(e, 'Failed to resolve Databricks warehouse / storage account', 'setup_failed');
  }

  const srcUri = toAbfss({ account, container, path: tablePath }).replace(/`/g, '');
  const tgtUri = toAbfss({ account, container, path: targetPath }).replace(/`/g, '');
  const asOf = version !== undefined ? ` VERSION AS OF ${version}` : '';
  const sql = `CREATE TABLE delta.\`${tgtUri}\` SHALLOW CLONE delta.\`${srcUri}\`${asOf}`;
  try {
    const result = await executeStatement(warehouseId, sql);
    return apiOk({
      container, source: tablePath, snapshot: targetPath, version: version ?? null, sql, result,
    });
  } catch (e) {
    return apiServerError(e, 'Snapshot creation failed', 'snapshot_failed');
  }
}
