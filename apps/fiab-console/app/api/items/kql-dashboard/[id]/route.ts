/**
 * GET /api/items/kql-dashboard/[id]  — read the dashboard model from Cosmos.
 * PUT /api/items/kql-dashboard/[id]  — save the dashboard model.
 *
 * Persisted shape (state):
 *   tiles:        [{ title, kql, viz, markdown?, pageId?, dataSourceId?, database?, w?, h?, drillthrough? }]
 *   dataSources:  [{ id, name, database, clusterUri? }]
 *   parameters:   [{ variableName, label?, type, dataType?, values?, query?, dataSourceId?, value? }]
 *   pages:        [{ id, name }]                  (U8 — empty = single-page)
 *   timeRange:    'last-24h' | … | raw ago(...) token
 *   autoRefreshMs: number
 *
 * Parity: Fabric Real-Time Dashboard
 * (https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create).
 *
 * GET options:
 *   ?run=1                     execute every tile, inline its real result
 *   ?time=<key|ago(...)>       global time range (overrides saved timeRange)
 *   ?param.<var>=<value>       parameter overrides (multi → repeat the key)
 */

import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { recordItemOpen } from '@/lib/items/record-open';
import {
  loadKustoItem, saveItemState, resolveDatabase, resolveDashboardDatabase, defaultDatabase,
  executeQuery, KustoError,
} from '@/lib/azure/kusto-client';
import {
  sanitizeModel, buildTileKql, resolveTileDatabase, isQueryTile,
  type DashboardParam, type DashboardTile, type DashboardDataSource, type BaseQuery,
} from '@/lib/azure/kql-dashboard-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Map a bundle `KqlDashboardContent` viz keyword to a sanitizer-valid TileViz. */
function vizFromContent(v: unknown): string {
  switch (v) {
    case 'card': return 'stat';   // bundle "card" == single big-number KPI
    case 'line': return 'line';
    case 'bar': return 'bar';
    case 'pie': return 'pie';
    case 'table': return 'table';
    default: return 'table';
  }
}

/**
 * Build the dashboard model from persisted state, falling back to the
 * app-install starter content (`state.content`, a `KqlDashboardContent`)
 * when no tiles have been authored/saved yet. This makes a bundle-installed
 * Real-Time Dashboard open FULLY BUILT-OUT — every starter tile visible —
 * instead of an empty canvas, even before the live Fabric/ADX object exists.
 * Saving (PUT) then persists into `state.tiles`, which takes precedence here.
 */
function readModel(state: Record<string, any> | undefined) {
  const hasSavedTiles = Array.isArray(state?.tiles) && state!.tiles.length > 0;
  const content = state?.content;
  if (!hasSavedTiles && content?.kind === 'kql-dashboard' && Array.isArray(content.tiles)) {
    return sanitizeModel({
      tiles: content.tiles.map((t: any) => ({
        title: t?.title,
        kql: t?.kql,
        viz: vizFromContent(t?.viz),
      })),
      dataSources: state?.dataSources,
      parameters: state?.parameters,
      baseQueries: state?.baseQueries ?? content?.baseQueries,
      pages: state?.pages,
      timeRange: state?.timeRange,
      autoRefreshMs: state?.autoRefreshMs,
    });
  }
  return sanitizeModel({
    tiles: state?.tiles,
    dataSources: state?.dataSources,
    parameters: state?.parameters,
    baseQueries: state?.baseQueries,
    pages: state?.pages,
    timeRange: state?.timeRange,
    autoRefreshMs: state?.autoRefreshMs,
  });
}

export const GET = withSession(async (req: NextRequest, { session, params: routeParams }) => {
  try {
    const item = await loadKustoItem(routeParams.id, 'kql-dashboard', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    // Feed "Recent": type-specific base routes bypass the generic GET's write.
    await recordItemOpen({ oid: session.claims.oid, upn: session.claims.upn }, { id: item.id, itemType: 'kql-dashboard', workspaceId: item.workspaceId });

    const model = readModel(item.state);
    // Bundle dashboards have no DB of their own — their tiles query the
    // dedicated database the sibling kql-database item provisioned. Resolve
    // that so tiles run against the database where the seeded tables live.
    const fallbackDb = await resolveDashboardDatabase(item);

    const run = req.nextUrl.searchParams.get('run') === '1';
    const timeKey = req.nextUrl.searchParams.get('time') || model.timeRange || 'last-24h';

    // Build a param map from saved params overlaid with ?param.<var>= overrides.
    const params: DashboardParam[] = model.parameters.map((p) => ({ ...p }));
    const overrides: Record<string, string[]> = {};
    req.nextUrl.searchParams.forEach((v, k) => {
      if (k.startsWith('param.')) {
        const name = k.slice(6);
        (overrides[name] ||= []).push(v);
      }
    });
    for (const p of params) {
      const ov = overrides[p.variableName];
      if (ov) p.value = p.type === 'multi' ? ov : ov[0];
    }

    const cacheMaxAgeSec = tileCacheMaxAgeSec(model.autoRefreshMs);
    const rendered = run
      ? await runTiles(model.tiles, model.dataSources, params, timeKey, fallbackDb, model.baseQueries, { cacheMaxAgeSec })
      : model.tiles;

    const res = NextResponse.json({
      ok: true,
      displayName: item.displayName,
      database: fallbackDb,
      defaultDatabase: defaultDatabase(),
      tiles: rendered,
      dataSources: model.dataSources,
      parameters: params,
      baseQueries: model.baseQueries,
      pages: model.pages,
      timeRange: timeKey,
      autoRefreshMs: model.autoRefreshMs ?? 0,
    });
    // PSR-6: let the browser/CDN reuse a rendered board for the tile refresh
    // window (per-user; never shared across tenants). Only when tiles were run.
    if (run) res.headers.set('Cache-Control', `private, max-age=${cacheMaxAgeSec}`);
    return res;
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});

export const PUT = withSession(async (req: NextRequest, { session, params }) => {
  const body = await req.json().catch(() => ({}));
  const model = sanitizeModel(body);
  try {
    const item = await loadKustoItem(params.id, 'kql-dashboard', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const patch: Record<string, any> = {
      tiles: model.tiles,
      dataSources: model.dataSources,
      parameters: model.parameters,
      baseQueries: model.baseQueries,
      pages: model.pages,
    };
    if (model.timeRange) patch.timeRange = model.timeRange;
    if (model.autoRefreshMs !== undefined) patch.autoRefreshMs = model.autoRefreshMs;
    if (typeof body?.databaseName === 'string' && body.databaseName.trim()) {
      patch.databaseName = body.databaseName.trim();
    }
    const saved = await saveItemState(item, patch);
    return NextResponse.json({
      ok: true,
      tiles: saved.state?.tiles || [],
      dataSources: saved.state?.dataSources || [],
      parameters: saved.state?.parameters || [],
      baseQueries: saved.state?.baseQueries || [],
      pages: saved.state?.pages || [],
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});

/**
 * Cacheable window (seconds) for a dashboard's tile queries. A tile is refreshed
 * every `autoRefreshMs`, so serving a query-results-cache hit within that window
 * is exactly the freshness the board already tolerates (PSR-6). Bounded to
 * [30s, 1h]; 0/unset → 5 min (a sensible repeat-visit window). Pure — unit tested.
 */
export function tileCacheMaxAgeSec(autoRefreshMs?: number): number {
  const fromRefresh = Number(autoRefreshMs);
  const sec = Number.isFinite(fromRefresh) && fromRefresh > 0 ? Math.floor(fromRefresh / 1000) : 300;
  return Math.min(3600, Math.max(30, sec));
}

/** Execute every tile against its resolved database with params substituted. */
export async function runTiles(
  tiles: DashboardTile[],
  dataSources: DashboardDataSource[],
  params: DashboardParam[],
  timeKey: string,
  fallbackDb: string,
  baseQueries: BaseQuery[] = [],
  opts?: { cacheMaxAgeSec?: number },
) {
  return Promise.all(tiles.map(async (t) => {
    // Text (markdown) tiles render their authored content — nothing to execute.
    if (!isQueryTile(t)) return { ...t };
    try {
      const db = resolveTileDatabase(t, dataSources, fallbackDb);
      const kql = buildTileKql(t.kql, params, timeKey, baseQueries);
      const result = await executeQuery(db, kql, { resultsCacheMaxAgeSec: opts?.cacheMaxAgeSec });
      // The editors' KqlResult contract carries ok:true (same wrap the KQL
      // Database /query route applies) — without it the tile never renders.
      return { ...t, result: { ok: true, ...result }, resolvedDatabase: db };
    } catch (e: any) {
      return { ...t, error: e?.message || String(e) };
    }
  }));
}
