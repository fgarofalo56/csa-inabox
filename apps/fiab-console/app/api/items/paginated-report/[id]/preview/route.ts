/**
 * POST /api/items/paginated-report/[id]/preview
 *   body: { dataSource: { type, server, database }, query: string }
 *
 * Executes a dataset's query against its (AzureSQL | Synapse) data source over
 * real TDS and returns columns + a capped row sample, so the designer can infer
 * dataset fields and capture `sampleRows` for the renderer. Real backend, no
 * mock data (no-vaporware.md). Cosmos / ADLS sources are not SQL-previewable —
 * the route says so honestly and the designer lets you enter fields manually.
 *
 * Azure-native; no Microsoft Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery as executeAzureSql } from '@/lib/azure/azure-sql-client';
import { executeQuery as executeSynapse, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import type { RdlDataSourceType, RdlFieldType } from '@/lib/azure/paginated-report-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 55;

const PREVIEW_ROWS = 50;

function inferType(v: unknown): RdlFieldType {
  if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Decimal';
  if (typeof v === 'boolean') return 'Boolean';
  if (v instanceof Date) return 'DateTime';
  return 'String';
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: { dataSource?: { type?: RdlDataSourceType; server?: string; database?: string }; query?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 }); }

  const ds = body.dataSource;
  const query = (body.query || '').trim();
  if (!ds?.type) return NextResponse.json({ ok: false, error: 'dataSource.type required' }, { status: 400 });
  if (!query) return NextResponse.json({ ok: false, error: 'query required' }, { status: 400 });
  if (!ds.server || !ds.database) {
    return NextResponse.json({ ok: false, error: 'dataSource server and database are required to preview' }, { status: 400 });
  }

  try {
    let columns: string[];
    let rows: unknown[][];
    if (ds.type === 'AzureSQL') {
      const r = await executeAzureSql(ds.server, ds.database, query);
      columns = r.columns; rows = r.rows;
    } else if (ds.type === 'Synapse') {
      const target: SynapseTarget = { server: ds.server, database: ds.database, cacheKey: `prpt:${ds.server}:${ds.database}` };
      const r = await executeSynapse(target, query);
      columns = r.columns; rows = r.rows;
    } else {
      return NextResponse.json(
        { ok: false, error: `Live preview supports AzureSQL and Synapse sources; for ${ds.type} enter fields manually.` },
        { status: 400 },
      );
    }

    const capped = rows.slice(0, PREVIEW_ROWS);
    // Field types inferred from the first non-null value in each column.
    const fields = columns.map((name, ci) => {
      const sample = capped.find((row) => row[ci] !== null && row[ci] !== undefined);
      return { name, type: sample ? inferType(sample[ci]) : ('String' as RdlFieldType) };
    });
    // sampleRows as objects keyed by column name — the shape the renderer expects.
    const sampleRows = capped.map((row) => {
      const o: Record<string, unknown> = {};
      columns.forEach((c, ci) => { o[c] = row[ci]; });
      return o;
    });

    return NextResponse.json({ ok: true, fields, columns, sampleRows, rowCount: rows.length, truncated: rows.length > PREVIEW_ROWS });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
