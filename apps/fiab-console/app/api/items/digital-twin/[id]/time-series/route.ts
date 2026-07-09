/**
 * POST /api/items/digital-twin/[id]/time-series  (FGC-12)
 *   body: { entity: string, property: string, agg, bin, lookback,
 *           keyValue?, database? }
 *
 * Entity property history — the twin time-series pane. Resolves the bound source
 * table + timestamp column for the entity from the OWNER-CHECKED twin model,
 * builds a binned KQL aggregate over Azure Data Explorer, and returns the
 * series. Azure-native, NO Fabric. All structural inputs (agg/bin/lookback) are
 * validated against curated allow-lists in the shared model module; only
 * `keyValue` is a free DATA value and it is escaped.
 *
 * Returns: { ok, query, columns, rows } | honest gate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { executeQuery, defaultDatabase, kustoConfigGate, KustoError } from '@/lib/azure/kusto-client';
import {
  normalizeTwinModel, buildTwinTimeSeriesQuery,
  TWIN_TS_AGGS, TWIN_TS_BINS, TWIN_TS_LOOKBACKS,
  type TwinTsAgg, type TwinTsBin, type TwinTsLookback,
} from '@/lib/editors/digital-twin-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  const item = await loadOwnedItem(id, 'digital-twin', s.claims.oid, { allowReadRoles: true });
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      code: 'not_configured',
      error: `Time-series needs Azure Data Explorer. Set ${gate.missing} and grant the Console UAMI Database Viewer. No Microsoft Fabric required.`,
    }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const model = normalizeTwinModel(item.state as Record<string, unknown>);
  const entity = model.entities.find((e) => e.apiName === String(body?.entity || ''));
  if (!entity) return NextResponse.json({ ok: false, error: 'Unknown entity for this twin.' }, { status: 400 });
  const prop = entity.properties.find((p) => p.apiName === String(body?.property || ''));
  if (!prop) return NextResponse.json({ ok: false, error: 'Unknown property for this entity.' }, { status: 400 });

  const m = entity.mapping;
  if (!m?.sourceTable) {
    return NextResponse.json({ ok: false, error: `Entity "${entity.apiName}" has no bound source table. Bind it in the Mappings tab to query property history.` }, { status: 400 });
  }
  if (!m.timestampColumn) {
    return NextResponse.json({ ok: false, error: `Entity "${entity.apiName}" has no timestamp column set on its mapping. Set one in the Mappings tab to query property history.` }, { status: 400 });
  }

  const agg = (TWIN_TS_AGGS as readonly string[]).includes(String(body?.agg)) ? (String(body?.agg) as TwinTsAgg) : 'avg';
  const bin = (TWIN_TS_BINS as readonly string[]).includes(String(body?.bin)) ? (String(body?.bin) as TwinTsBin) : '1h';
  const lookback = (TWIN_TS_LOOKBACKS as readonly string[]).includes(String(body?.lookback)) ? (String(body?.lookback) as TwinTsLookback) : '1d';

  // Resolve the source column for the value + (optional) the entity key column.
  const valueColumn = (m.columnMap && m.columnMap[prop.apiName]) || prop.apiName;
  const keyColumn = entity.keyProperty && m.keyColumns && m.keyColumns.length ? m.keyColumns[0] : undefined;

  const db = String(body?.database || m.sourceDatabase || model.database || defaultDatabase());
  const query = buildTwinTimeSeriesQuery({
    sourceDatabase: m.sourceDatabase || undefined,
    sourceTable: m.sourceTable,
    timestampColumn: m.timestampColumn,
    valueColumn,
    agg, bin, lookback,
    ...(keyColumn ? { keyColumn } : {}),
    ...(body?.keyValue != null && body.keyValue !== '' ? { keyValue: String(body.keyValue) } : {}),
  });

  try {
    const result = await executeQuery(db, query);
    return NextResponse.json({ ok: true, query, database: db, ...result });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return NextResponse.json({ ok: false, error: raw.slice(0, 600), query }, { status: status === 401 || status === 403 ? 200 : 502 });
  }
}
