/**
 * POST /api/items/tapestry/[id]/geo
 *   body: { limit?: number, database?: string }
 *
 * Tapestry geo-analysis — projects every located investigative node (a node
 * carrying lat/lon properties) into a GeoJSON FeatureCollection the client
 * renders with the keyless GeoJsonMap (and an optional live Azure Maps raster
 * basemap when NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY is configured client-side).
 *
 * Azure-native: the query runs over the materialized Node_* ADX tables — no
 * Microsoft Fabric dependency. The geo panel always renders (vector-only when
 * no Maps key is set), preserving the GCC-High / IL5 fallback where Azure Maps
 * tiles are unavailable.
 *
 * Grounded in Microsoft Learn (KQL geospatial + graph semantics):
 *   https://learn.microsoft.com/azure/data-explorer/kusto/query/geospatial-grid-systems
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r (residual population). See the sibling
 * `[id]/link` header for the full finding: `_ctx` ignored, `getSession()` only,
 * `body.database` into `discoverGraphTables` + `executeQuery` as the Console's
 * UAMI. All three tapestry panes are bound together because fixing one of a set
 * of siblings only relocates the primitive.
 */
import { NextRequest, NextResponse } from 'next/server';
import { executeQuery, kustoConfigGate, KustoError } from '@/lib/azure/kusto-client';
import { discoverGraphTables, buildGeoKql } from '@/lib/azure/tapestry-graph';
import { guardAdxItemRequest, scopeAdxDatabase } from '../../../_lib/adx-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GeoFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { id: string; name: string; label: string };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // LAYER 1 — read-only projection pane, so shared read roles are admitted.
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'tapestry',
    notFound: 'tapestry not found',
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const body = await req.json().catch(() => ({}));

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      code: 'not_configured',
      error: `Tapestry geo analysis needs Azure Data Explorer. Set ${gate.missing} (the ADX cluster that backs Loom graphs) and grant the Console UAMI Database Viewer. No Microsoft Fabric required.`,
    }, { status: 503 });
  }

  // LAYER 2 — bound before any ADX call, including the table discovery probe.
  const scoped = await scopeAdxDatabase(guard.ctx.item, body?.database);
  if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  const db = scoped.database;
  try {
    const { nodeTables, edgeTables } = await discoverGraphTables(db);
    if (nodeTables.length === 0) {
      return NextResponse.json({
        ok: false,
        error: 'No materialized graph found. Run Load sample data (kind=investigation) or materialize a graph model first (creates Node_* tables in ADX).',
      }, { status: 400 });
    }

    const kql = buildGeoKql(nodeTables, Number(body?.limit) || 5000);
    const result = await executeQuery(db, kql);

    // Shape rows → GeoJSON FeatureCollection for <GeoJsonMap>.
    const idx = (c: string) => result.columns.indexOf(c);
    const iId = idx('Id'), iName = idx('Name'), iLabel = idx('Label'), iLat = idx('Latitude'), iLon = idx('Longitude');
    const features: GeoFeature[] = [];
    for (const row of result.rows) {
      const lat = Number(row[iLat]);
      const lon = Number(row[iLon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          id: String(row[iId] ?? ''),
          name: String(row[iName] ?? row[iId] ?? ''),
          label: String(row[iLabel] ?? ''),
        },
      });
    }

    return NextResponse.json({
      ok: true, backend: 'adx', database: db,
      graph: { nodeTables, edgeTables },
      featureCollection: { type: 'FeatureCollection', features },
      count: features.length,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return NextResponse.json({ ok: false, error: raw.slice(0, 600) }, { status: status === 401 || status === 403 ? 200 : 502 });
  }
}
