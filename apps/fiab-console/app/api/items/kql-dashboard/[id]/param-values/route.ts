/**
 * POST /api/items/kql-dashboard/[id]/param-values
 *
 * Resolve the available values for a *query-based* dashboard parameter
 * (Fabric "single/multiple-selection query-based parameter" — values are
 * retrieved at dashboard load by running a KQL query that returns a single
 * column). Used to populate the parameter dropdown in the builder.
 *
 * Body: { query: string, dataSourceId?: string, database?: string }
 * Returns: { ok, values: string[] } — distinct first-column values (capped).
 *
 * Real backend: executes the param query via executeQuery (Kusto v2 REST).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery, loadKustoItem, resolveDatabase, KustoError } from '@/lib/azure/kusto-client';
import { sanitizeModel, resolveTileDatabase } from '@/lib/azure/kql-dashboard-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_VALUES = 1000;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const query = (body?.query || '').toString().trim();
  if (!query) return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 });
  if (query.length > 65_536) return NextResponse.json({ ok: false, error: 'query too large (>64KB)' }, { status: 413 });

  try {
    const { id } = await ctx.params;
    let fallbackDb: string;
    if (id && id !== 'new') {
      const item = await loadKustoItem(id, 'kql-dashboard', session.claims.oid);
      fallbackDb = resolveDatabase(item);
    } else {
      fallbackDb = resolveDatabase(null);
    }

    // Resolve the database from the optional bound data source.
    const { dataSources } = sanitizeModel({ dataSources: body?.dataSources });
    const db = resolveTileDatabase(
      { title: '', kql: query, viz: 'table', dataSourceId: body?.dataSourceId, database: body?.database },
      dataSources,
      fallbackDb,
    );

    const result = await executeQuery(db, query);
    // First column → distinct string values.
    const seen = new Set<string>();
    const values: string[] = [];
    for (const row of result.rows) {
      const v = row[0];
      if (v === null || v === undefined) continue;
      const s = String(v);
      if (!seen.has(s)) { seen.add(s); values.push(s); }
      if (values.length >= MAX_VALUES) break;
    }
    return NextResponse.json({ ok: true, values, database: db });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
