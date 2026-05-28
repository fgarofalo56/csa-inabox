/**
 * GET /api/catalog/asset/{id}?source=...&host=...&workspaceId=...
 *   Federated asset detail page payload. Returns schema preview, sensitivity
 *   labels, classifications, owner, lineage subgraph, recent activity, and a
 *   precomputed upstream deep-link for the "Open in upstream tool" fallback.
 *
 * The detail blob is intentionally a single payload — the UI does not need
 * to make N follow-up calls per tile.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getAssetDetail, getLineageSubgraph,
  PurviewNotConfiguredError, PurviewError,
} from '@/lib/azure/purview-client';
import {
  getTable, getTableLineage,
  UnityCatalogNotConfiguredError, UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';
import { getFabricItem, listOneLakeShortcuts, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = decodeURIComponent(ctx.params.id);
  const source = req.nextUrl.searchParams.get('source') || '';
  const host = req.nextUrl.searchParams.get('host') || '';

  try {
    if (source === 'purview') {
      const [entity, lineage] = await Promise.all([
        getAssetDetail(id),
        getLineageSubgraph(id, 2).catch((e) => ({ baseEntityGuid: id, guidEntityMap: {}, relations: [], _error: e?.message })),
      ]);
      return NextResponse.json({
        ok: true,
        source,
        id,
        detail: entity,
        lineage,
        upstreamLink:
          process.env.LOOM_PURVIEW_ACCOUNT
            ? `https://${process.env.LOOM_PURVIEW_ACCOUNT}.purview.azure.com/main.html#/asset/${encodeURIComponent(id)}`
            : null,
      });
    }
    if (source === 'unity-catalog') {
      if (!host) return NextResponse.json({ ok: false, error: 'host required' }, { status: 400 });
      const [table, lineageEdges] = await Promise.all([
        getTable(host, id).catch(() => null),
        getTableLineage(host, id).catch(() => []),
      ]);
      return NextResponse.json({
        ok: true,
        source,
        id,
        host,
        detail: table,
        lineage: { edges: lineageEdges },
        upstreamLink: `https://${host}/explore/data/${encodeURIComponent(id)}`,
      });
    }
    if (source === 'onelake') {
      const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '';
      if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
      const [item, shortcuts] = await Promise.all([
        getFabricItem(workspaceId, id).catch((e: any) => ({ _error: e?.message })),
        listOneLakeShortcuts(workspaceId, id).catch(() => []),
      ]);
      return NextResponse.json({
        ok: true,
        source,
        id,
        workspaceId,
        detail: item,
        shortcuts,
        upstreamLink: `https://app.fabric.microsoft.com/groups/${encodeURIComponent(workspaceId)}/list?experience=power-bi`,
      });
    }
    return NextResponse.json({ ok: false, error: 'source must be purview | unity-catalog | onelake' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError || e instanceof UnityCatalogNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    const status = e instanceof PurviewError || e instanceof UnityCatalogError || e instanceof FabricError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
  }
}
