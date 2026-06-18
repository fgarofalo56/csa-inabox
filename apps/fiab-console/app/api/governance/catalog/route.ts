/**
 * GET /api/governance/catalog
 *   Returns the tenant's data assets — every workspace item that maps to
 *   "data" in the catalog sense (lakehouse, warehouse, KQL DB, semantic
 *   model, mirrored-database, data-product, ADLS-backed dataset).
 *
 *   ?q=...           full-text search (AI Search) / substring (Cosmos fallback)
 *   ?type=...        restrict to a specific itemType
 *   ?domain=...      restrict to a Loom business-domain id (live domain scope)
 *   ?endorsement=... restrict to Certified | Promoted
 *   ?sensitivity=... restrict to a sensitivity label
 *   ?skip=...        page offset (AI Search path)
 *
 *   Returns: { ok, total, assets: [{ id, displayName, itemType, workspaceId,
 *     workspaceName, owner, classifications, sensitivity, endorsement,
 *     domainId, isDiscoverable, canOpen, updatedAt }], facets, source }
 *
 *   Source: when LOOM_AI_SEARCH_SERVICE is set the catalog is served from the
 *   `loom-governance-items` AI Search index — real facet counts + a
 *   discoverability filter so a Promoted/Certified item the caller cannot open
 *   still appears (with a Request-Access CTA). When AI Search is NOT deployed it
 *   falls back to the Cosmos query (no-vaporware: degrades gracefully). There is
 *   no substring-only path while AI Search is configured.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  isGovernanceCatalogSearchConfigured,
  searchGovernanceCatalog,
  ensureGovernanceCatalogIndex,
  isCatalogDataType,
  type GovernanceCatalogHit,
} from '@/lib/azure/governance-catalog-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_ITEM_TYPES = { has: (t: string) => isCatalogDataType(t) };

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  const typeFilter = (req.nextUrl.searchParams.get('type') || '').trim();
  const domainFilter = (req.nextUrl.searchParams.get('domain') || '').trim();
  const endorsementFilter = (req.nextUrl.searchParams.get('endorsement') || '').trim();
  const sensitivityFilter = (req.nextUrl.searchParams.get('sensitivity') || '').trim();
  const skip = Number(req.nextUrl.searchParams.get('skip') || '0') || 0;

  try {
    const wsC = await workspacesContainer();

    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id, c.name, c.domain FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: s.claims.oid }],
    }, { partitionKey: s.claims.oid }).fetchAll();

    const wsName = new Map<string, string>(workspaces.map((w: any) => [w.id, w.name]));
    const wsDomain = new Map<string, string | undefined>(workspaces.map((w: any) => [w.id, w.domain]));
    const callerWorkspaceIds = Array.from(wsName.keys());

    // ----- AI Search path: real facets + discoverable items the caller can't open
    if (isGovernanceCatalogSearchConfigured()) {
      const runSearch = () => searchGovernanceCatalog({
        q,
        tenantId: s.claims.oid,
        callerWorkspaceIds,
        domainId: domainFilter || undefined,
        itemType: typeFilter || undefined,
        endorsement: endorsementFilter || undefined,
        sensitivity: sensitivityFilter || undefined,
        top: 100,
        skip,
      });
      let result: Awaited<ReturnType<typeof searchGovernanceCatalog>> = null;
      try {
        result = await runSearch();
      } catch (se: any) {
        // Index genuinely absent (404 "index not found") → self-heal the index
        // from inside the VNet, then retry once. If ensure/retry still fails,
        // fall through to the Cosmos path below rather than surfacing a raw 404
        // as "Could not load catalog" (no-vaporware: degrade gracefully).
        const msg = se?.message || String(se);
        if (/\(404\)|index not found|was not found|No index/i.test(msg)) {
          const ensured = await ensureGovernanceCatalogIndex();
          if (ensured.ok) {
            try { result = await runSearch(); } catch { result = null; }
          }
        } else {
          throw se;
        }
      }
      if (result) {
        const wsSet = new Set(callerWorkspaceIds);
        const assets = (result.hits as GovernanceCatalogHit[])
          .filter((h) => DATA_ITEM_TYPES.has(h.itemType))
          .map((h) => ({
            id: h.id,
            displayName: h.displayName,
            itemType: h.itemType,
            workspaceId: h.workspaceId,
            workspaceName: h.workspaceName || wsName.get(h.workspaceId) || h.workspaceId,
            owner: h.owner || '—',
            ownerUpn: h.ownerUpn || null,
            classifications: h.classifications || [],
            sensitivity: h.sensitivity || null,
            endorsement: h.endorsement || null,
            description: h.description || null,
            domainId: h.domainId || null,
            isDiscoverable: !!h.isDiscoverable,
            // Caller can open only items in workspaces their tenant owns.
            canOpen: wsSet.has(h.workspaceId),
            updatedAt: h.updatedAt,
            rowCount: h.rowCount,
            sizeBytes: h.sizeBytes,
          }));
        return NextResponse.json({
          ok: true,
          total: result.total,
          assets,
          facets: result.facets,
          workspaces: workspaces.map((w: any) => ({ id: w.id, name: w.name })),
          source: 'aisearch',
        });
      }
      // result === null when AI Search isn't configured OR the index was absent
      // and self-heal didn't take — fall through to the Cosmos path below.
    }

    // ----- Cosmos fallback (AI Search not deployed): substring + in-memory facets
    if (callerWorkspaceIds.length === 0) {
      return NextResponse.json({ ok: true, total: 0, assets: [], workspaces: [], source: 'cosmos' });
    }
    const itC = await itemsContainer();
    const { resources: items } = await itC.items.query({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.createdBy, c.updatedAt, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
      parameters: [{ name: '@w', value: callerWorkspaceIds }],
    }).fetchAll();

    const ql = q.toLowerCase();
    const assets = items
      .filter((i: any) => DATA_ITEM_TYPES.has(i.itemType))
      .filter((i: any) => !typeFilter || i.itemType === typeFilter)
      // F6 — Expired data products are restricted to stewards/owners. Exclude
      // them from the consumer discovery catalog so "Set to expired" actually
      // removes consumer visibility (no-vaporware: the transition is observable).
      .filter((i: any) => i.state?.lifecycleStatus !== 'EXPIRED')
      .map((i: any) => {
        const endorsement = i.state?.endorsement || (i.state?.certified ? 'Certified' : null);
        return {
          id: i.id,
          displayName: i.displayName,
          itemType: i.itemType,
          workspaceId: i.workspaceId,
          workspaceName: wsName.get(i.workspaceId) || i.workspaceId,
          owner: i.createdBy || '—',
          ownerUpn: i.state?.ownerUpn || i.state?.contact || i.state?.steward || i.createdBy || null,
          classifications: i.state?.classifications || [],
          sensitivity: i.state?.sensitivityLabel || null,
          endorsement,
          lifecycleStatus: i.state?.lifecycleStatus || null,
          description: i.state?.description || null,
          domainId: i.state?.domainId || wsDomain.get(i.workspaceId) || null,
          isDiscoverable: i.state?.discoverable === true || !!endorsement,
          canOpen: true,
          updatedAt: i.updatedAt,
          rowCount: i.state?.rowCount,
          sizeBytes: i.state?.sizeBytes,
        };
      })
      .filter((a) => !domainFilter || a.domainId === domainFilter)
      .filter((a) => !endorsementFilter || a.endorsement === endorsementFilter)
      .filter((a) => !sensitivityFilter || a.sensitivity === sensitivityFilter)
      .filter((a) => {
        if (!ql) return true;
        return (
          a.displayName.toLowerCase().includes(ql) ||
          a.itemType.toLowerCase().includes(ql) ||
          a.workspaceName.toLowerCase().includes(ql) ||
          (a.owner || '').toLowerCase().includes(ql) ||
          (a.classifications || []).some((c: string) => c.toLowerCase().includes(ql))
        );
      })
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    // In-memory facets so the chips show real counts without AI Search.
    const facet = (vals: (string | null | undefined)[]) => {
      const m = new Map<string, number>();
      for (const v of vals) if (v) m.set(v, (m.get(v) || 0) + 1);
      return Array.from(m, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
    };
    const facets = {
      itemType: facet(assets.map((a) => a.itemType)),
      domainId: facet(assets.map((a) => a.domainId)),
      endorsement: facet(assets.map((a) => a.endorsement)),
      sensitivity: facet(assets.map((a) => a.sensitivity)),
      classifications: facet(assets.flatMap((a) => a.classifications || [])),
    };

    return NextResponse.json({
      ok: true,
      total: assets.length,
      assets,
      facets,
      workspaces: workspaces.map((w: any) => ({ id: w.id, name: w.name })),
      source: 'cosmos',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
