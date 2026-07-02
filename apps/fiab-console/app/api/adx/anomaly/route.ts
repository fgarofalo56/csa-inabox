/**
 * KQL time-series anomaly detection + forecasting on the ADX/KQL database bound
 * to a kql-database item (or a Real-Time Dashboard tile).
 *
 *   POST /api/adx/anomaly?id=ITEM
 *     body {
 *       database?,                         // overrides the item-resolved DB
 *       table | query,                     // source: a table name OR a KQL sub-query
 *       timeColumn, valueColumn,           // the make-series axis + measure
 *       aggregation?  = 'avg',             // avg | sum | min | max | count
 *       step?         = '1h',              // make-series bin (KQL timespan)
 *       mode: 'anomaly' | 'forecast',
 *       threshold?    = 1.5,               // anomaly: series_decompose_anomalies k-value
 *       horizon?      = 24,                // forecast: points to predict
 *     }
 *     → { ok, mode, database, step, kql, result: KqlResult, pointCount,
 *         anomalyCount? , horizon? , threshold? }
 *
 * The route composes PURE KQL around the caller's series and runs it via
 * kusto-client.executeQuery (real /v1/rest/query against the Loom shared ADX
 * cluster; Console UAMI). No Fabric, no service dependency — pure ADX:
 *
 *   anomaly  →  … | make-series <agg> on <time> step <step>
 *               | extend (flag, score, baseline) =
 *                   series_decompose_anomalies(series, <threshold>, -1, 'linefit')
 *               | mv-expand … | project time, value, baseline, anomaly_score, is_anomaly
 *
 *   forecast →  … | make-series <agg> on <time> from min to max + horizon*step step <step>
 *               | extend forecast = series_decompose_forecast(series, <horizon>, -1, 'linefit')
 *               | mv-expand … | project time, value, forecast
 *
 * Grounded in Microsoft Learn (native KQL time-series ML):
 *   https://learn.microsoft.com/kusto/query/series-decompose-anomalies-function
 *   https://learn.microsoft.com/kusto/query/series-decompose-forecast-function
 *   https://learn.microsoft.com/kusto/query/anomaly-detection
 *
 * Honest 503 via the shared guard when LOOM_KUSTO_CLUSTER_URI is unset. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  executeQuery, loadKustoItem, resolveDatabase, resolveDashboardDatabase,
} from '@/lib/azure/kusto-client';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolve the database an OWNED Eventhouse item authorizes the caller to query.
 * The anomaly composer runs arbitrary make-series KQL against a database on the
 * SHARED ADX cluster, so the target database MUST be tied to an item the caller
 * owns (owner-checked via loadKustoItem) — not a free-form `body.database`.
 * Supports both a kql-database (Eventhouse database) and a kql-dashboard
 * (Real-Time Dashboard, whose tiles query its bound/sibling database).
 * Returns the allowed database name, or null when the item isn't owned/found.
 */
async function resolveOwnedItemDatabase(itemId: string, tenantId: string): Promise<string | null> {
  const kdb = await loadKustoItem(itemId, 'kql-database', tenantId);
  if (kdb) return resolveDatabase(kdb);
  const dash = await loadKustoItem(itemId, 'kql-dashboard', tenantId);
  if (dash) return resolveDashboardDatabase(dash);
  return null;
}

/** make-series aggregations the composer allows (structured — never free-typed). */
const AGGREGATIONS = ['avg', 'sum', 'min', 'max', 'count'] as const;
type Aggregation = (typeof AGGREGATIONS)[number];

/** KQL timespan literal for the make-series bin, e.g. 5m, 1h, 1d. */
const STEP_RE = /^\d+[smhd]$/;

const MAX_QUERY_LEN = 20_000;
const MAX_HORIZON = 5_000;

/** Bracket-quote a validated Kusto column name (`["name"]`). */
function qcol(name: string): string {
  return `["${name}"]`;
}

interface AnomalyRequest {
  source: string;        // already-composed KQL source (`["table"]` or `(query)`)
  timeColumn: string;
  valueColumn: string;
  aggregation: Aggregation;
  step: string;
  mode: 'anomaly' | 'forecast';
  threshold: number;
  horizon: number;
}

/** Build the `avg(todouble(col))` / `count()` aggregation expression. */
function aggExpr(agg: Aggregation, valueColumn: string): string {
  return agg === 'count' ? 'count()' : `${agg}(todouble(${qcol(valueColumn)}))`;
}

/**
 * Compose the anomaly-detection KQL: make-series over the source, then
 * series_decompose_anomalies, flattened to one row per bin. `series` is the
 * measure array; the decomposition returns (ad_flag, ad_score, baseline).
 */
function buildAnomalyKql(r: AnomalyRequest): string {
  const t = qcol(r.timeColumn);
  return [
    `let __src = ${r.source};`,
    `__src`,
    `| make-series __series = ${aggExpr(r.aggregation, r.valueColumn)} default=0 on ${t} step ${r.step}`,
    `| extend (__flag, __score, __baseline) = series_decompose_anomalies(__series, ${r.threshold}, -1, 'linefit')`,
    `| mv-expand ${t} to typeof(datetime), __series to typeof(double), __baseline to typeof(double), __score to typeof(double), __flag to typeof(long)`,
    `| project ${t}, value = __series, baseline = __baseline, anomaly_score = __score, is_anomaly = __flag`,
  ].join('\n');
}

/**
 * Compose the forecasting KQL: make-series is extended `horizon` bins into the
 * future (from min..max+horizon*step), then series_decompose_forecast predicts
 * the trailing `horizon` empty points. Flattened to one row per bin.
 */
function buildForecastKql(r: AnomalyRequest): string {
  const t = qcol(r.timeColumn);
  return [
    `let __step = ${r.step};`,
    `let __horizon = ${r.horizon};`,
    `let __src = ${r.source};`,
    `let __from = toscalar(__src | summarize min(${t}));`,
    `let __to = toscalar(__src | summarize max(${t}));`,
    `__src`,
    `| make-series __series = ${aggExpr(r.aggregation, r.valueColumn)} default=0 on ${t} from __from to __to + __horizon * __step step __step`,
    `| extend __forecast = series_decompose_forecast(__series, __horizon, -1, 'linefit')`,
    `| mv-expand ${t} to typeof(datetime), __series to typeof(double), __forecast to typeof(double)`,
    `| project ${t}, value = __series, forecast = __forecast`,
  ].join('\n');
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;

  const body = await req.json().catch(() => ({}));

  // ---- validate the source (table XOR query) --------------------------------
  const table = typeof body?.table === 'string' ? body.table.trim() : '';
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  let source: string;
  if (table) {
    if (!validName(table)) {
      return NextResponse.json({ ok: false, error: 'table must be a valid Kusto entity name' }, { status: 400 });
    }
    source = qcol(table);
  } else if (query) {
    if (query.length > MAX_QUERY_LEN) {
      return NextResponse.json({ ok: false, error: `query exceeds ${MAX_QUERY_LEN} characters` }, { status: 400 });
    }
    // The query is embedded as a sub-expression (`let __src = (<query>);`), so a
    // control command or statement separator would break out of the pipeline.
    if (query.startsWith('.')) {
      return NextResponse.json({ ok: false, error: 'query must be a tabular query, not a control command' }, { status: 400 });
    }
    if (query.includes(';')) {
      return NextResponse.json({ ok: false, error: 'query must be a single tabular expression (no ";" / let statements)' }, { status: 400 });
    }
    source = `(\n${query}\n)`;
  } else {
    return NextResponse.json({ ok: false, error: 'either table or query is required' }, { status: 400 });
  }

  // ---- validate columns + mode ----------------------------------------------
  const timeColumn = typeof body?.timeColumn === 'string' ? body.timeColumn.trim() : '';
  const valueColumn = typeof body?.valueColumn === 'string' ? body.valueColumn.trim() : '';
  const mode = body?.mode === 'forecast' ? 'forecast' : body?.mode === 'anomaly' ? 'anomaly' : '';
  if (!validName(timeColumn)) {
    return NextResponse.json({ ok: false, error: 'timeColumn must be a valid Kusto column name' }, { status: 400 });
  }
  if (!mode) {
    return NextResponse.json({ ok: false, error: "mode must be 'anomaly' or 'forecast'" }, { status: 400 });
  }

  const aggregation: Aggregation = AGGREGATIONS.includes(body?.aggregation) ? body.aggregation : 'avg';
  if (aggregation !== 'count' && !validName(valueColumn)) {
    return NextResponse.json({ ok: false, error: 'valueColumn must be a valid Kusto column name (or set aggregation=count)' }, { status: 400 });
  }

  // ---- validate step / threshold / horizon ----------------------------------
  const step = typeof body?.step === 'string' && body.step.trim() ? body.step.trim() : '1h';
  if (!STEP_RE.test(step)) {
    return NextResponse.json({ ok: false, error: 'step must be a KQL timespan, e.g. 5m, 1h, 1d' }, { status: 400 });
  }
  let threshold = Number(body?.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) threshold = 1.5;
  if (threshold > 50) threshold = 50;
  let horizon = Math.floor(Number(body?.horizon));
  if (!Number.isFinite(horizon) || horizon < 1) horizon = 24;
  if (horizon > MAX_HORIZON) {
    return NextResponse.json({ ok: false, error: `horizon must be between 1 and ${MAX_HORIZON} points` }, { status: 400 });
  }

  // ---- database authorization ------------------------------------------------
  // guardAdxRequest confirmed a session + config gate, but a session alone must
  // NOT be able to run make-series KQL against an ARBITRARY database on the
  // shared cluster via `body.database`. Two authorized paths:
  //   (a) ITEM CONTEXT — the caller supplied an Eventhouse / KQL-database (or
  //       Real-Time Dashboard) item id (as ?id=, threaded into g.ctx.itemId, or
  //       body.itemId). We owner-check it and DERIVE the allowed database; an
  //       explicit body.database is honored only when it equals that database.
  //   (b) NO ITEM CONTEXT — an arbitrary-database analyst/admin query, which is
  //       restricted to tenant admins (requireTenantAdmin). Any other caller 403s.
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const bodyItemId = typeof body?.itemId === 'string' && body.itemId.trim() ? body.itemId.trim() : '';
  const itemId = bodyItemId || g.ctx.itemId || '';
  const requestedDb = typeof body?.database === 'string' && body.database.trim() ? body.database.trim() : '';

  let database: string;
  if (itemId && itemId !== 'new') {
    const allowedDb = await resolveOwnedItemDatabase(itemId, session.claims.oid);
    if (!allowedDb) {
      return NextResponse.json({ ok: false, error: 'item not found or not owned by you' }, { status: 404 });
    }
    database = allowedDb;
    if (requestedDb && requestedDb !== database) {
      return NextResponse.json(
        { ok: false, error: `database "${requestedDb}" is not the database bound to this item (${database}).`, code: 'database_forbidden' },
        { status: 403 },
      );
    }
  } else {
    const adminGate = requireTenantAdmin(session);
    if (adminGate) return adminGate;
    database = requestedDb || g.ctx.database;
  }

  const composed: AnomalyRequest = { source, timeColumn, valueColumn, aggregation, step, mode, threshold, horizon };
  const kql = mode === 'anomaly' ? buildAnomalyKql(composed) : buildForecastKql(composed);

  try {
    const qr = await executeQuery(database, kql);
    // Count flagged anomalies (is_anomaly = ±1) for the summary badge.
    let anomalyCount: number | undefined;
    if (mode === 'anomaly') {
      const flagIdx = qr.columns.indexOf('is_anomaly');
      anomalyCount = flagIdx >= 0
        ? qr.rows.reduce((n, row) => (Number(row[flagIdx]) !== 0 ? n + 1 : n), 0)
        : 0;
    }
    return NextResponse.json({
      ok: true,
      mode,
      database,
      step,
      timeColumn,
      valueColumn: aggregation === 'count' ? null : valueColumn,
      aggregation,
      ...(mode === 'anomaly' ? { threshold, anomalyCount } : { horizon }),
      kql,
      pointCount: qr.rowCount,
      result: { ok: true, ...qr },
    });
  } catch (e: any) {
    return adxError(e);
  }
}
