/**
 * POST /api/realtime-hub/preview
 *
 * Fabric Real-Time Hub "Explore data in motion" / "Preview data" — shows
 * the most recent events flowing through a data stream. In Fabric this
 * previews the events on a stream or KQL table; here we read the recent
 * rows from the backing Kusto (Eventhouse / KQL DB) table via the real
 * Kusto query path used everywhere else in Loom.
 * (https://learn.microsoft.com/fabric/real-time-hub/preview-data-streams)
 *
 * Body:
 *   {
 *     database: string,     // KQL database name (Eventhouse DB)
 *     table: string,        // KQL table to preview
 *     limit?: number,       // default 50, max 200
 *     clusterUri?: string   // optional: a *discovered* ADX cluster to preview
 *                           //   (RTI hub catalog); validated to a bare https
 *                           //   Kusto host. Defaults to the configured cluster.
 *   }
 *
 * The KQL is built server-side as `["table"] | take N` (identifier-quoted)
 * so the caller never injects raw KQL. Real Kusto errors (bad table, auth)
 * surface verbatim with a 502.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery, defaultDatabase, normalizeClusterUri, KustoError } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Quote a Kusto identifier as ["name"] and escape embedded quotes. */
function kqlIdent(name: string): string {
  return `["${String(name).replace(/"/g, '\\"')}"]`;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return NextResponse.json({ ok: false, error: 'Content-Type must be application/json' }, { status: 415 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const table = String(body.table || '').trim();
  if (!table) {
    return NextResponse.json({ ok: false, error: 'table is required to preview a data stream.' }, { status: 400 });
  }
  const database = String(body.database || '').trim() || defaultDatabase();
  let limit = Number.isFinite(body.limit) ? Math.floor(body.limit) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // Optional: target a *discovered* ADX cluster (RTI hub catalog ADX rows)
  // instead of the env-configured default. Validated to a bare https Kusto
  // host so we never query a phantom / non-ADX endpoint. Invalid overrides are
  // rejected up front rather than silently falling back to the wrong cluster.
  let clusterUri: string | undefined;
  if (body.clusterUri != null && String(body.clusterUri).trim()) {
    const norm = normalizeClusterUri(String(body.clusterUri));
    if (!norm) {
      return NextResponse.json({ ok: false, error: 'clusterUri must be a valid https Azure Data Explorer cluster URI.' }, { status: 400 });
    }
    clusterUri = norm;
  }

  const kql = `${kqlIdent(table)} | take ${limit}`;

  try {
    const result = await executeQuery(database, kql, clusterUri ? { clusterUri } : undefined);
    return NextResponse.json({
      ok: true,
      database,
      table,
      kql,
      clusterUri: clusterUri ?? null,
      columns: result.columns,
      columnTypes: result.columnTypes,
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      truncated: result.truncated,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
