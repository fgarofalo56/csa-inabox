/**
 * GET /api/governance/catalog
 *   Returns the tenant's data assets — every workspace item that maps to
 *   "data" in the catalog sense (lakehouse, warehouse, KQL DB, semantic
 *   model, mirrored-database, data-product, ADLS-backed dataset).
 *
 *   ?q=...    filter by name / type / classifications / workspace
 *   ?type=... restrict to a specific itemType
 *
 *   Returns: { ok, total, assets: [{ id, displayName, itemType, workspaceId,
 *     workspaceName, owner, classifications, sensitivity, updatedAt }] }
 *
 *   Source: Cosmos workspace-items joined with workspaces. When Purview is
 *   bound (tenant-settings purview.bound = true), the response also includes
 *   `purviewMerged: true` and merges Purview-only classifications.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATA_ITEM_TYPES = new Set([
  'lakehouse', 'warehouse', 'kql-database', 'eventhouse', 'semantic-model',
  'mirrored-database', 'data-product', 'data-product-instance',
  'data-product-template', 'geo-dataset', 'dataset', 'azure-sql-database',
  'cosmos-gremlin-graph', 'cypher-graph', 'gql-graph', 'vector-store',
]);

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const q = (req.nextUrl.searchParams.get('q') || '').toLowerCase().trim();
  const typeFilter = (req.nextUrl.searchParams.get('type') || '').trim();

  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();

    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: s.claims.oid }],
    }, { partitionKey: s.claims.oid }).fetchAll();

    const wsName = new Map(workspaces.map((w: any) => [w.id, w.name]));
    const wsIds = Array.from(wsName.keys());

    if (wsIds.length === 0) {
      return NextResponse.json({ ok: true, total: 0, assets: [], workspaces: [] });
    }

    const { resources: items } = await itC.items.query({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.createdBy, c.updatedAt, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
      parameters: [{ name: '@w', value: wsIds }],
    }).fetchAll();

    const assets = items
      .filter((i: any) => DATA_ITEM_TYPES.has(i.itemType))
      .filter((i: any) => !typeFilter || i.itemType === typeFilter)
      // F6 — Expired data products are restricted to stewards/owners. Exclude
      // them from the consumer discovery catalog so "Set to expired" actually
      // removes consumer visibility (no-vaporware: the transition is observable).
      .filter((i: any) => i.state?.lifecycleStatus !== 'EXPIRED')
      .map((i: any) => ({
        id: i.id,
        displayName: i.displayName,
        itemType: i.itemType,
        workspaceId: i.workspaceId,
        workspaceName: wsName.get(i.workspaceId) || i.workspaceId,
        owner: i.createdBy || '—',
        ownerUpn: i.state?.ownerUpn || i.state?.contact || i.state?.steward || i.createdBy || null,
        classifications: i.state?.classifications || [],
        sensitivity: i.state?.sensitivityLabel || null,
        endorsement: i.state?.endorsement || (i.state?.certified ? 'Certified' : null),
        lifecycleStatus: i.state?.lifecycleStatus || null,
        description: i.state?.description || null,
        updatedAt: i.updatedAt,
        rowCount: i.state?.rowCount,
        sizeBytes: i.state?.sizeBytes,
      }))
      .filter((a) => {
        if (!q) return true;
        return (
          a.displayName.toLowerCase().includes(q) ||
          a.itemType.toLowerCase().includes(q) ||
          a.workspaceName.toLowerCase().includes(q) ||
          (a.owner || '').toLowerCase().includes(q) ||
          (a.classifications || []).some((c: string) => c.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    return NextResponse.json({
      ok: true,
      total: assets.length,
      assets,
      workspaces: workspaces.map((w: any) => ({ id: w.id, name: w.name })),
      source: 'cosmos',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
