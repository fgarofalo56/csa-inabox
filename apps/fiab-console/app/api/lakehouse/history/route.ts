/**
 * Table history / time travel (F20) — Delta Lake version log for a lakehouse table.
 *
 *   GET  /api/lakehouse/history?container=&tablePath=
 *        Lists committed Delta versions by reading the table's `_delta_log/*.json`
 *        commit files directly from ADLS Gen2. NO SQL engine required — the
 *        `commitInfo` action in each commit file carries the exact fields that
 *        Spark's `DESCRIBE HISTORY` returns (version, timestamp, operation,
 *        operationMetrics, userName). This is Azure-native and has zero Fabric
 *        dependency.
 *
 *   POST /api/lakehouse/history
 *        { container, tablePath, version, action: 'restore' | 'preview' }
 *        Restore: `RESTORE TABLE delta.`<abfss>` TO VERSION AS OF <n>`
 *        Preview: `SELECT * FROM delta.`<abfss>` VERSION AS OF <n> LIMIT 100`
 *        Both run on a Databricks SQL Warehouse (the only Azure-native engine
 *        that speaks Delta time-travel SQL — Synapse Serverless does not).
 *        Honest-gates with a precise MessageBar payload when Databricks is not
 *        configured / has no warehouse.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  KNOWN_CONTAINERS,
  listPaths,
  downloadFile,
  getAccountName,
} from '@/lib/azure/adls-client';
import {
  databricksConfigGate,
  listWarehouses,
  executeStatement,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HistoryRow {
  version: number;
  timestamp: string; // ISO8601
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

function isKnownContainer(c: string): boolean {
  return (KNOWN_CONTAINERS as readonly string[]).includes(c);
}

/** Reject path traversal + leading/trailing slashes. */
function cleanTablePath(p: string): string | null {
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

// ------------------------------------------------------------------
// GET — version listing from _delta_log
// ------------------------------------------------------------------
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const container = req.nextUrl.searchParams.get('container') || '';
  const tablePathRaw = req.nextUrl.searchParams.get('tablePath') || '';

  if (!container || !tablePathRaw) {
    return NextResponse.json({ ok: false, error: 'container and tablePath are required' }, { status: 400 });
  }
  if (!isKnownContainer(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }
  const tablePath = cleanTablePath(tablePathRaw);
  if (!tablePath) {
    return NextResponse.json({ ok: false, error: 'invalid tablePath' }, { status: 400 });
  }

  try {
    const logDir = `${tablePath}/_delta_log`;
    const entries = await listPaths(container, logDir, 500);
    // Commit files are zero-padded 20-digit decimals: 00000000000000000001.json.
    // Skip checkpoints (.checkpoint.parquet), CRC files (.crc) and directories.
    const commitFiles = entries
      .filter((e) => !e.isDirectory && /\/\d{20}\.json$/.test(e.name))
      .map((e) => ({
        name: e.name,
        version: Number(e.name.split('/').pop()!.replace('.json', '')),
      }))
      .filter((e) => Number.isFinite(e.version))
      .sort((a, b) => b.version - a.version) // newest first
      .slice(0, 50);

    const versions: HistoryRow[] = [];
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
            try {
              action = JSON.parse(trimmed);
            } catch {
              continue;
            }
            if (action && action.commitInfo) {
              commitInfo = action.commitInfo;
              break;
            }
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
          // A single unreadable commit file shouldn't sink the whole listing.
          versions.push({
            version: cf.version,
            timestamp: '',
            operation: 'UNKNOWN',
            metrics: {},
          });
        }
      }),
    );

    versions.sort((a, b) => b.version - a.version);
    return NextResponse.json({ ok: true, container, table: tablePath, versions });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    const msg =
      e?.statusCode === 404
        ? `No _delta_log found under ${tablePath}/_delta_log — the table may not be materialized yet, or the path is not a Delta table.`
        : e?.message || String(e);
    return NextResponse.json({ ok: false, error: msg, code: e?.code }, { status });
  }
}

// ------------------------------------------------------------------
// POST — restore / preview-as-of (Databricks Delta time-travel SQL)
// ------------------------------------------------------------------
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const container = String(body?.container || '');
  const tablePath = cleanTablePath(String(body?.tablePath || ''));
  const action = body?.action === 'restore' ? 'restore' : body?.action === 'preview' ? 'preview' : null;
  const version = num(body?.version);

  if (!container || !isKnownContainer(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }
  if (!tablePath) {
    return NextResponse.json({ ok: false, error: 'invalid tablePath' }, { status: 400 });
  }
  if (!action) {
    return NextResponse.json({ ok: false, error: "action must be 'restore' or 'preview'" }, { status: 400 });
  }
  if (version === undefined || version < 0 || !Number.isInteger(version)) {
    return NextResponse.json({ ok: false, error: 'version must be a non-negative integer' }, { status: 400 });
  }

  // Honest infra-gate: Delta time-travel SQL requires Databricks. Synapse
  // Serverless does not support RESTORE / VERSION AS OF.
  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        gated: true,
        code: 'no_databricks',
        hint:
          `Set ${gate.missing} (Databricks workspace hostname) to enable Restore and ` +
          `Preview-as-of. Delta time-travel SQL (RESTORE TABLE … TO VERSION AS OF, ` +
          `SELECT … VERSION AS OF) runs on a Databricks SQL Warehouse — Synapse ` +
          `Serverless does not support it. The History version list above still ` +
          `works without Databricks (read directly from _delta_log).`,
      },
      { status: 503 },
    );
  }

  let warehouseId: string;
  try {
    const warehouses = await listWarehouses();
    const wh = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
    if (!wh) {
      return NextResponse.json(
        {
          ok: false,
          gated: true,
          code: 'no_warehouse',
          hint:
            'Databricks is configured but the workspace has no SQL Warehouse to run ' +
            'the time-travel SQL. Create one in Databricks (Compute → SQL Warehouses).',
        },
        { status: 503 },
      );
    }
    warehouseId = wh.id;
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Failed to list Databricks SQL Warehouses: ${e?.message || String(e)}` },
      { status: 502 },
    );
  }

  // Build the abfss URI for the Delta table. Backtick-quoted path literal in
  // Spark SQL — strip any backticks from the resolved value defensively.
  let account: string;
  try {
    account = getAccountName();
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'Could not resolve ADLS account name' },
      { status: 502 },
    );
  }
  const abfss = `abfss://${container}@${account}.dfs.core.windows.net/${tablePath}`.replace(/`/g, '');

  try {
    if (action === 'restore') {
      const sql = `RESTORE TABLE delta.\`${abfss}\` TO VERSION AS OF ${version}`;
      const result = await executeStatement(warehouseId, sql);
      return NextResponse.json({ ok: true, action: 'restore', version, sql, result });
    }
    // preview
    const sql = `SELECT * FROM delta.\`${abfss}\` VERSION AS OF ${version} LIMIT 100`;
    const result = await executeStatement(warehouseId, sql);
    return NextResponse.json({
      ok: true,
      action: 'preview',
      version,
      sql,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      truncated: result.truncated,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
}
