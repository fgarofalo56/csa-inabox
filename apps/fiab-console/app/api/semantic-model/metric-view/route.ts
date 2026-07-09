/**
 * Metric Views — Azure-native DEFAULT backend (DBX-6). This is the path Loom
 * uses with ZERO Databricks dependency: it compiles a typed metric spec to
 *   (a) a runnable GROUP BY SELECT executed read-only against the Synapse
 *       Dedicated SQL pool (real aggregate rows — the "real query execution"), and
 *   (b) DAX measure expressions for the Loom semantic (tabular) layer.
 * The Databricks UC metric view is the OPT-IN alternative
 * (/api/databricks/unity-catalog/metric-views).
 *
 *   POST /api/semantic-model/metric-view
 *     body { action:'compile', spec, tableRef?, catalog?, schema?, name? }
 *        → { ok, select, selectDatabricks, dax:[{name,expr}], yaml, ddl? }  (pure, no execution)
 *     body { action:'run', spec, limit? }
 *        → { ok, sql, columns, rows, rowCount, executionMs }  (Synapse Dedicated)
 *        → { ok:false, gated:true, error } when Synapse isn't configured (honest gate)
 *
 * No new Azure resource — reuses the Synapse Dedicated pool the warehouse item
 * already provisions (LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery, dedicatedTarget } from '@/lib/azure/synapse-sql-client';
import {
  MetricBuildError,
  compileMetricViewSelect, compileMeasureDax, buildMetricViewYaml, buildCreateMetricViewDdl,
  type MetricViewSpec, type MetricDimension, type MetricMeasure,
  type MetricAggregation, METRIC_AGGREGATIONS,
} from '@/lib/sql/metric-view-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

function synapseGate(): string | null {
  if (!process.env.LOOM_SYNAPSE_WORKSPACE || !process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
    return 'Synapse Dedicated SQL pool is not configured in this deployment. Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL (the warehouse-item bicep deploys the pool). The metric SQL is shown but not executed until then.';
  }
  return null;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const action = String(body?.action || 'compile');
  const spec = parseSpec(body?.spec ?? {});
  const tableRef = body?.tableRef ? String(body.tableRef).trim() : undefined;

  try {
    if (action === 'compile') {
      const select = compileMetricViewSelect(spec, { dialect: 'synapse' });
      const selectDatabricks = compileMetricViewSelect(spec, { dialect: 'databricks-sql' });
      const dax = spec.measures.map((m) => ({ name: m.name, expr: compileMeasureDax(m, tableRef) }));
      const yaml = buildMetricViewYaml(spec);
      const catalog = body?.catalog ? String(body.catalog).trim() : '';
      const schema = body?.schema ? String(body.schema).trim() : '';
      const name = body?.name ? String(body.name).trim() : '';
      const ddl = (catalog && schema && name)
        ? buildCreateMetricViewDdl({ catalog, schema, name, spec, orReplace: true })
        : undefined;
      return NextResponse.json({ ok: true, select, selectDatabricks, dax, yaml, ...(ddl ? { ddl } : {}) });
    }

    if (action === 'run') {
      const gate = synapseGate();
      if (gate) return NextResponse.json({ ok: false, gated: true, error: gate }, { status: 200 });
      const limit = Number.isInteger(body?.limit) && body.limit > 0 ? Math.min(body.limit, 1000) : 200;
      const sql = compileMetricViewSelect(spec, { dialect: 'synapse', limit });
      // compileMetricViewSelect always yields a SELECT and rejects `;`/comments
      // in expressions, so it is inherently read-only.
      const res = await executeQuery(dedicatedTarget(), sql);
      return NextResponse.json({ ok: true, sql, columns: res.columns, rows: res.rows, rowCount: res.rowCount, executionMs: res.executionMs });
    }

    return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (e: any) {
    const status = e instanceof MetricBuildError ? 400 : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
