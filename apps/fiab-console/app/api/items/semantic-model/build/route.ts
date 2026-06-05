/**
 * POST /api/items/semantic-model/build?workspaceId=...
 *
 * Builds a REAL Power BI semantic model (a "push" dataset) with tables,
 * typed columns, measures, and relationships via the Power BI Push Datasets
 * REST API (POST /groups/{ws}/datasets). This is the supported REST path to
 * AUTHOR a model without the XMLA endpoint — imported / Direct Lake model
 * writes still require XMLA / Desktop, which the editor gates honestly.
 *
 * Body: {
 *   name: string,
 *   tables: [{ name, columns: [{ name, dataType, formatString? }], measures?: [{ name, expression, formatString? }] }],
 *   relationships?: [{ name, fromTable, fromColumn, toTable, toColumn, crossFilteringBehavior? }],
 *   sampleRows?: { [tableName]: Array<Record<string, unknown>> }
 * }
 *
 * 200 → { ok: true, datasetId, name, pushedRows }
 * 4xx/5xx → { ok: false, error }  (Power BI's verbatim message, e.g. 401/403)
 *
 * No mock data — calls api.powerbi.com directly. See no-vaporware.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createPushDataset, postPushRows, PowerBiError,
  type PushTable, type PushRelationship, type PushColumnType,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TYPES: PushColumnType[] = ['Int64', 'Double', 'Boolean', 'DateTime', 'String', 'Decimal'];

/**
 * Normalize Tabular / semantic-model column dataTypes (which a Loom
 * SemanticModelContent bundle uses — e.g. DimDate's `Date` column) onto the
 * six types the Power BI Push Datasets REST API accepts. `Date` is a valid
 * Tabular type but push datasets only expose `DateTime`; likewise `Decimal`/
 * `Double` aliases. Mapping here (rather than 400-ing) lets a bundle-installed
 * model actually push to Power BI without the user hand-editing every column.
 */
const PUSH_TYPE_ALIASES: Record<string, PushColumnType> = {
  date: 'DateTime',
  datetime: 'DateTime',
  time: 'DateTime',
  int64: 'Int64',
  integer: 'Int64',
  int: 'Int64',
  double: 'Double',
  decimal: 'Decimal',
  currency: 'Decimal',
  boolean: 'Boolean',
  bool: 'Boolean',
  string: 'String',
  text: 'String',
};

function normalizePushType(dataType: string | undefined): PushColumnType | null {
  if (!dataType) return null;
  if (VALID_TYPES.includes(dataType as PushColumnType)) return dataType as PushColumnType;
  return PUSH_TYPE_ALIASES[dataType.trim().toLowerCase()] || null;
}

interface BuildBody {
  name?: string;
  tables?: Array<{
    name?: string;
    columns?: Array<{ name?: string; dataType?: string; formatString?: string }>;
    measures?: Array<{ name?: string; expression?: string; formatString?: string }>;
  }>;
  relationships?: Array<{
    name?: string; fromTable?: string; fromColumn?: string; toTable?: string; toColumn?: string;
    crossFilteringBehavior?: string;
  }>;
  sampleRows?: Record<string, Array<Record<string, unknown>>>;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as BuildBody;
  const name = (body.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!Array.isArray(body.tables) || body.tables.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one table is required' }, { status: 400 });
  }

  // Validate + normalize the table/column/measure shape before calling PBI so
  // we return precise 400s rather than an opaque engine error.
  const tables: PushTable[] = [];
  for (const t of body.tables) {
    const tName = (t.name || '').trim();
    if (!tName) return NextResponse.json({ ok: false, error: 'every table needs a name' }, { status: 400 });
    const cols = (t.columns || []).filter((c) => (c.name || '').trim());
    if (cols.length === 0) return NextResponse.json({ ok: false, error: `table "${tName}" needs at least one column` }, { status: 400 });
    for (const c of cols) {
      if (!normalizePushType(c.dataType)) {
        return NextResponse.json({ ok: false, error: `column "${c.name}" has invalid dataType "${c.dataType}". Allowed: ${VALID_TYPES.join(', ')}` }, { status: 400 });
      }
    }
    tables.push({
      name: tName,
      columns: cols.map((c) => ({ name: (c.name || '').trim(), dataType: normalizePushType(c.dataType) as PushColumnType, formatString: c.formatString || undefined })),
      measures: (t.measures || [])
        .filter((m) => (m.name || '').trim() && (m.expression || '').trim())
        .map((m) => ({ name: (m.name || '').trim(), expression: (m.expression || '').trim(), formatString: m.formatString || undefined })),
    });
  }

  const relationships: PushRelationship[] | undefined = Array.isArray(body.relationships) && body.relationships.length
    ? body.relationships
        .filter((r) => r.fromTable && r.fromColumn && r.toTable && r.toColumn)
        .map((r, i) => ({
          name: (r.name || `rel-${i + 1}`).trim(),
          fromTable: r.fromTable!.trim(),
          fromColumn: r.fromColumn!.trim(),
          toTable: r.toTable!.trim(),
          toColumn: r.toColumn!.trim(),
          crossFilteringBehavior: (r.crossFilteringBehavior as PushRelationship['crossFilteringBehavior']) || 'OneDirection',
        }))
    : undefined;

  try {
    const ds = await createPushDataset(workspaceId, { name, tables, relationships });

    // Optionally push starter rows so the model is immediately queryable.
    let pushedRows = 0;
    if (body.sampleRows && ds.id) {
      for (const [tableName, rows] of Object.entries(body.sampleRows)) {
        if (Array.isArray(rows) && rows.length) {
          try { await postPushRows(workspaceId, ds.id, tableName, rows); pushedRows += rows.length; }
          catch { /* row push is best-effort; the model already exists */ }
        }
      }
    }

    return NextResponse.json({ ok: true, datasetId: ds.id, name: ds.name, pushedRows });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
