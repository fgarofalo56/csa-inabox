/**
 * Unity Catalog METRIC VIEWS — governed reusable KPI definitions (DBX-6, the
 * OPT-IN Databricks backend). Loom's DEFAULT metric-view path is the Azure-native
 * semantic layer (see /api/semantic-model/metric-view); this route only drives a
 * bound Databricks workspace.
 *
 *   GET  /api/databricks/unity-catalog/metric-views?catalog=&schema=[&warehouseId=]
 *          → { ok, views[] }   (SHOW VIEWS IN catalog.schema)
 *   POST /api/databricks/unity-catalog/metric-views
 *          body { action:'create', preview?, params:{catalog,schema,name,orReplace?,spec}, warehouseId? }
 *          body { action:'query', catalog, schema, name, dimensions[], measures[], limit?, warehouseId? }
 *          body { action:'drop', catalog, schema, name, warehouseId? }
 *          → { ok, sql, executionMs?, columns?, rows? }
 *
 * Real Databricks SQL DDL (Learn-grounded), executed over the SQL Statement
 * Execution API — no mocks:
 *   CREATE [OR REPLACE] VIEW … WITH METRICS LANGUAGE YAML AS $$…$$
 *   SELECT dim, MEASURE(m) FROM cat.schema.mv GROUP BY dim
 *   https://learn.microsoft.com/azure/databricks/business-semantics/metric-views/create
 *
 * Console UAMI needs SELECT on the source + CREATE TABLE + USE SCHEMA + USE
 * CATALOG, and CAN USE on a DBR 17.3+ warehouse. Honest gate at the GCC-High /
 * DoD boundary (metric views need a Commercial/GCC Entra-connected metastore).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  listUcViews, createUcMetricView, queryUcMetricView, dropUcMetricView,
} from '@/lib/azure/unity-catalog-client';
import {
  MetricBuildError, type MetricViewSpec, type MetricDimension, type MetricMeasure,
  type MetricAggregation, METRIC_AGGREGATIONS,
} from '@/lib/sql/metric-view-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate { gated: true; error: string }

function resolveGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace). Loom's default metric-view backend is the Azure-native semantic layer — no Databricks required.` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `UC metric views are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks workspace (DBR 17.3+). ` +
        `Use Loom's Azure-native semantic-layer metric views instead (the default path).`,
    };
  }
  return null;
}

async function resolveWarehouseId(requested?: string): Promise<string> {
  if (requested) return requested;
  const warehouses = await listWarehouses();
  const running = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
  if (!running) throw new Error('No SQL warehouse found. Create or start a DBR 17.3+ SQL warehouse in the Databricks workspace.');
  return running.id;
}

/** Parse a client body into a validated MetricViewSpec (identifier/expression
 *  validation happens in the builder — this only shapes the object). */
function parseSpec(raw: any): MetricViewSpec {
  const dimensions: MetricDimension[] = Array.isArray(raw?.dimensions)
    ? raw.dimensions.map((d: any) => ({ name: String(d?.name ?? '').trim(), expr: String(d?.expr ?? '').trim(), comment: d?.comment ? String(d.comment) : undefined })).filter((d: MetricDimension) => d.name || d.expr)
    : [];
  const measures: MetricMeasure[] = Array.isArray(raw?.measures)
    ? raw.measures.map((m: any) => {
      const agg = String(m?.aggregation ?? 'SUM').toUpperCase() as MetricAggregation;
      return {
        name: String(m?.name ?? '').trim(),
        aggregation: METRIC_AGGREGATIONS.includes(agg) ? agg : 'CUSTOM',
        expr: m?.expr ? String(m.expr) : undefined,
        comment: m?.comment ? String(m.comment) : undefined,
      };
    }).filter((m: MetricMeasure) => m.name)
    : [];
  return {
    source: String(raw?.source ?? '').trim(),
    dimensions,
    measures,
    filter: raw?.filter ? String(raw.filter) : undefined,
    comment: raw?.comment ? String(raw.comment) : undefined,
  };
}

function errStatus(e: any): number {
  return e instanceof MetricBuildError ? 400 : (e?.status || 502);
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const catalog = req.nextUrl.searchParams.get('catalog')?.trim();
  const schema = req.nextUrl.searchParams.get('schema')?.trim();
  if (!catalog || !schema) return NextResponse.json({ ok: false, error: 'catalog and schema are required' }, { status: 400 });

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(req.nextUrl.searchParams.get('warehouseId')?.trim() || undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    const views = await listUcViews(warehouseId, catalog, schema);
    return NextResponse.json({ ok: true, catalog, schema, views });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status: errStatus(e) });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const action = String(body?.action || 'create');

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(body?.warehouseId ? String(body.warehouseId).trim() : undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    if (action === 'drop') {
      const catalog = String(body?.catalog || '').trim();
      const schema = String(body?.schema || '').trim();
      const name = String(body?.name || '').trim();
      if (!catalog || !schema || !name) return NextResponse.json({ ok: false, error: 'drop requires catalog, schema and name' }, { status: 400 });
      const r = await dropUcMetricView(warehouseId, { catalog, schema, name });
      return NextResponse.json({ ok: true, sql: r.sql, executionMs: r.executionMs, executedBy: session.claims.upn });
    }

    if (action === 'query') {
      const catalog = String(body?.catalog || '').trim();
      const schema = String(body?.schema || '').trim();
      const name = String(body?.name || '').trim();
      const dimensions: string[] = Array.isArray(body?.dimensions) ? body.dimensions.map((x: any) => String(x || '').trim()).filter(Boolean) : [];
      const measures: string[] = Array.isArray(body?.measures) ? body.measures.map((x: any) => String(x || '').trim()).filter(Boolean) : [];
      const limit = Number.isInteger(body?.limit) ? body.limit : undefined;
      if (!catalog || !schema || !name) return NextResponse.json({ ok: false, error: 'query requires catalog, schema and name' }, { status: 400 });
      const r = await queryUcMetricView(warehouseId, { catalog, schema, name, dimensions, measures, limit });
      return NextResponse.json({ ok: true, sql: r.sql, columns: r.columns, rows: r.rows, rowCount: r.rowCount, executionMs: r.executionMs });
    }

    // ---- Create (or preview) ----
    const raw = body?.params ?? {};
    const catalog = String(raw?.catalog || '').trim();
    const schema = String(raw?.schema || '').trim();
    const name = String(raw?.name || '').trim();
    if (!catalog || !schema || !name) return NextResponse.json({ ok: false, error: 'params.catalog, params.schema and params.name are required' }, { status: 400 });
    const spec = parseSpec(raw?.spec ?? {});
    const r = await createUcMetricView(warehouseId, { catalog, schema, name, orReplace: raw?.orReplace === true, spec }, body?.preview === true);
    return NextResponse.json({ ok: true, preview: body?.preview === true, sql: r.sql, executionMs: r.executionMs, executedBy: session.claims.upn });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status: errStatus(e) });
  }
}
