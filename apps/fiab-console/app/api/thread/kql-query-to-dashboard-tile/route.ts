/**
 * POST /api/thread/kql-query-to-dashboard-tile — Weave (Loom Thread) edge,
 * operator review 5.2: "Query → Dashboard conversion".
 *
 * From a KQL database's query surface, pin the current query as a tile on a
 * Real-Time Dashboard (kql-dashboard) — a NEW dashboard or an EXISTING one in
 * the workspace. The route:
 *
 *   1. Validates the KQL STRUCTURALLY (non-empty, tabular — no mgmt commands)
 *      and then by EXECUTING it against the REAL ADX cluster (same
 *      `executeQuery` the tile renderer uses, with the dashboard's synthetic
 *      `_startTime`/`_endTime` tokens bound to a 24h window). A failing query
 *      is an HONEST 422 naming the ADX error — no tile is created from a query
 *      that cannot run (no-vaporware.md).
 *   2. Creates the target: a new kql-dashboard item (createOwnedItem, in the
 *      source's workspace) seeded with the tile + a data source resolving the
 *      source database — or appends the tile to the existing dashboard's
 *      persisted model (content-fallback aware via `effectiveDashboardModel`,
 *      so a bundle dashboard's starter tiles are materialized, never shadowed).
 *   3. Records the Weave lineage edge (kql-database → kql-dashboard).
 *
 * Per .claude/rules:
 *  - no-fabric-dependency: Azure Data Explorer end-to-end; no Fabric/Power BI
 *    host is ever touched. Missing ADX config is an honest 503 naming
 *    LOOM_KUSTO_CLUSTER_URI.
 *  - no-vaporware: real ADX execution for validation, real Cosmos item
 *    create/update, real lineage edge.
 *  - loom-no-freeform-config: the wizard drives this with pickers (dashboard,
 *    visual, size); the KQL itself comes from the editor's query surface (the
 *    ADX-native escape hatch, same as the query editor).
 *
 * Body: {
 *   from:   { id, type: 'kql-database' | 'eventhouse', name? },
 *   values: {
 *     dashboardId: '__new__' | <kql-dashboard item id>,
 *     newDashboardName?: string,      // dashboardId === '__new__'
 *     kql: string,                    // the query to pin
 *     title: string,                  // tile title
 *     viz: TileViz,                   // table|timechart|line|bar|column|pie|stat|map
 *     size?: 'small'|'medium'|'wide'|'tall',
 *     timeRange?: string,             // validation window key (default last-24h)
 *   }
 * }
 * Returns 200: { ok:true, dashboardId, created, tileCount, validated:true,
 *                rowCount, link, linkLabel, message }
 *         4xx/5xx: { ok:false, error, gate? }
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiError, apiOk, apiUnauthorized } from '@/lib/api/respond';
import {
  loadKustoItem, saveItemState, resolveDatabase,
  executeQuery, kustoConfigGate, KustoError,
} from '@/lib/azure/kusto-client';
import { resolveTimeFrom } from '@/lib/azure/kql-dashboard-model';
import {
  checkTileKql, geometryForSize, isValidTileViz,
  effectiveDashboardModel, withAppendedTile,
} from '@/lib/azure/kql-tile-conversion';
import { createOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Source item types whose query surface can pin a dashboard tile (ADX-backed). */
const SOURCE_TYPES = new Set(['kql-database', 'eventhouse']);

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const values = (body?.values || {}) as Record<string, unknown>;

  if (!from.id || !from.type) return apiError('missing source item', 400);
  if (!SOURCE_TYPES.has(String(from.type))) {
    return apiError(`Dashboard tiles are pinned from a KQL database or eventhouse (got "${from.type}").`, 400);
  }

  const kql = String(values.kql || '').trim();
  const structural = checkTileKql(kql);
  if (!structural.ok) return apiError(structural.error, 400);

  const title = String(values.title || '').trim();
  if (!title) return apiError('Give the tile a title.', 400);

  const viz = values.viz;
  if (!isValidTileViz(viz)) {
    return apiError('viz must be one of table | timechart | line | bar | column | pie | stat | map.', 400);
  }
  const { w, h } = geometryForSize(typeof values.size === 'string' ? values.size : undefined);

  const dashboardId = String(values.dashboardId || '').trim();
  if (!dashboardId) return apiError('Pick a target dashboard (or "__new__" for a new one).', 400);

  // ADX gate FIRST — validation executes against the real cluster.
  const adxGate = kustoConfigGate();
  if (adxGate) {
    return apiError(
      `Azure Data Explorer is not configured (set ${adxGate.missing}). The tile is validated by executing ` +
      `its query against the real cluster, so a deployed Eventhouse/ADX cluster is required. ` +
      `See platform/fiab/bicep/modules/data/adx-cluster.bicep.`,
      503,
      { gate: { missing: adxGate.missing } },
    );
  }

  try {
    const src = await loadKustoItem(String(from.id), String(from.type), oid);
    if (!src) return apiError('The source item was not found in your tenant.', 404);
    const fromName = String(from.name || src.displayName || from.type);
    const database = resolveDatabase(src);

    // ── VALIDATE by executing against the real cluster. The dashboard renderer
    //    substitutes _startTime/_endTime at run time; bind them here so the
    //    validation query is executable exactly like generate-tile does. ──
    const timeFrom = resolveTimeFrom(typeof values.timeRange === 'string' ? values.timeRange : undefined);
    const runnableKql = `let _startTime = ${timeFrom};\nlet _endTime = now();\n${kql}`;
    let rowCount = 0;
    try {
      const result = await executeQuery(database, runnableKql);
      rowCount = result.rowCount ?? (result.rows?.length || 0);
    } catch (e: any) {
      // HONEST validation failure — no tile is created from a query that
      // cannot run against the cluster. Surface the real ADX error verbatim.
      return apiError(
        `The query failed validation against ADX (database "${database}"): ${e?.message || String(e)}`,
        422,
        { validated: false },
      );
    }

    const tile = { title, kql, viz, w, h };

    // ── target: NEW dashboard ────────────────────────────────────────────────
    if (dashboardId === '__new__') {
      const displayName = String(values.newDashboardName || '').trim() || `${fromName} dashboard`;
      const model = withAppendedTile(effectiveDashboardModel(undefined), tile, database);
      const created = await createOwnedItem(session, 'kql-dashboard', {
        workspaceId: src.workspaceId,
        displayName,
        description: `Real-Time Dashboard created from a query on "${fromName}".`,
        state: {
          tiles: model.tiles,
          dataSources: model.dataSources,
          parameters: model.parameters,
          baseQueries: model.baseQueries,
          timeRange: model.timeRange || 'last-24h',
        },
      });
      if (!created.ok) return apiError(created.error, created.status);
      const newId = created.item.id;
      await recordThreadEdge(session, {
        fromItemId: src.id, fromType: src.itemType, fromName,
        toItemId: newId, toType: 'kql-dashboard', toName: displayName,
        toLink: `/items/kql-dashboard/${newId}`, action: 'create-dashboard-tile-from-query',
      });
      return apiOk({
        dashboardId: newId,
        created: true,
        tileCount: model.tiles.length,
        validated: true,
        rowCount,
        link: `/items/kql-dashboard/${newId}`,
        linkLabel: 'Open the dashboard',
        message:
          `Created dashboard "${displayName}" with the tile "${title}" (${viz}) — the query validated against ` +
          `ADX database "${database}" (${rowCount.toLocaleString()} rows).`,
      });
    }

    // ── target: EXISTING dashboard in the caller's tenant ────────────────────
    const dash = await loadKustoItem(dashboardId, 'kql-dashboard', oid);
    if (!dash) return apiError('The target dashboard was not found in your tenant.', 404);

    const model = withAppendedTile(effectiveDashboardModel(dash.state), tile, database);
    await saveItemState(dash, {
      tiles: model.tiles,
      dataSources: model.dataSources,
      parameters: model.parameters,
      baseQueries: model.baseQueries,
      timeRange: model.timeRange || dash.state?.timeRange || 'last-24h',
    });
    await recordThreadEdge(session, {
      fromItemId: src.id, fromType: src.itemType, fromName,
      toItemId: dash.id, toType: 'kql-dashboard', toName: dash.displayName,
      toLink: `/items/kql-dashboard/${dash.id}`, action: 'create-dashboard-tile-from-query',
    });
    return apiOk({
      dashboardId: dash.id,
      created: false,
      tileCount: model.tiles.length,
      validated: true,
      rowCount,
      link: `/items/kql-dashboard/${dash.id}`,
      linkLabel: 'Open the dashboard',
      message:
        `Added tile "${title}" (${viz}) to "${dash.displayName}" — the query validated against ADX ` +
        `database "${database}" (${rowCount.toLocaleString()} rows). The dashboard now has ${model.tiles.length} tiles.`,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status || 500 : 500;
    return apiError(e?.message || String(e), status);
  }
}
