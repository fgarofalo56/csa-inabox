/**
 * GET /api/items/[type]/[id]/impact — cross-catalog impact analysis (Wave-2 W8).
 *
 * "What breaks downstream if I delete / rename / schema-edit this item?" — the
 * pre-destructive-change confirmation surface (Palantir Foundry impact analysis
 * / dbt exposures parity). It walks the SAME unified lineage graph the catalog
 * Lineage tab draws (Purview/Atlas + Unity Catalog + Weave/Thread edges) FORWARD
 * from the focus asset and returns every downstream dependent, grouped by kind
 * and badged direct (1 hop) vs transitive (>1 hop).
 *
 * Backend = the existing lineage store (getUnifiedLineage) — Azure-native by
 * default, no hard Microsoft Fabric dependency (per no-fabric-dependency.md):
 *   • Commercial / GCC → Unity Catalog lineage + Weave/Thread edges (+ Purview)
 *   • GCC-High         → Purview Atlas lineage + Weave/Thread edges
 *   • DoD / IL5        → Weave/Thread edges (Cosmos, always-on); Purview is
 *                        absent, so the honest `degraded`/`sources` flags below
 *                        disclose that only the Loom-native mesh was consulted.
 *
 * Response shape ({ ok, dependents[], groups[], counts, degraded, partial,
 * sources }) matches the repo BFF envelope. `degraded` is TRUE when NO lineage
 * source was reachable — an empty dependents list then means "couldn't verify",
 * NOT "safe to delete" (per no-vaporware.md), and the UI warns + still requires
 * an explicit typed confirmation.
 *
 * Query params (all optional):
 *   depth — lineage walk depth (1-10, default 3)
 *   host  — Databricks workspace hostname override (UC)
 *   key   — explicit lineage key override (UC full_name or Atlas/Purview GUID)
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { detectLoomCloud, type LoomCloud } from '@/lib/azure/cloud-endpoints';
import { getUnifiedLineage } from '@/lib/azure/unified-lineage';
import { buildImpactResult } from '@/lib/azure/impact-analysis';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { apiOk, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Load an item by id (cross-partition) and verify the caller's tenant owns it. */
async function loadItem(
  itemId: string,
  type: string,
  tenantId: string,
): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: type },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

/** Resolve the Unity Catalog `catalog.schema.table` lineage key from item state. */
function ucKeyFromItem(item: WorkspaceItem | null): string | undefined {
  const s: any = item?.state || {};
  const direct = s.ucFullName || s.fullName || s.full_name || s.tableFullName || s.qualifiedName;
  if (typeof direct === 'string' && direct) return direct;
  const cat = s.catalog || s.catalogName;
  const sch = s.schema || s.schemaName;
  const tbl = s.table || s.tableName;
  if (cat && sch && tbl) return `${cat}.${sch}.${tbl}`;
  return undefined;
}

/** Resolve the Atlas/Purview entity GUID lineage key from item state. */
function guidFromItem(item: WorkspaceItem | null): string | undefined {
  const s: any = item?.state || {};
  const c = s.purviewGuid || s.atlasGuid || s.entityGuid || s.guid;
  return typeof c === 'string' && c ? c : undefined;
}

/** Does the path segment look like a UC `catalog.schema.table` full name? */
function looksLikeUcFullName(s: string): boolean {
  return /^[\w$]+\.[\w$]+\.[\w$]+$/.test(s);
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> },
) {
  const { type, id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized('Unauthorized');

  const depth = Math.max(
    1,
    Math.min(10, parseInt(req.nextUrl.searchParams.get('depth') || '3', 10) || 3),
  );
  const hostOverride = req.nextUrl.searchParams.get('host') || '';
  const keyOverride = req.nextUrl.searchParams.get('key') || '';
  const cloud: LoomCloud = detectLoomCloud();

  // Best-effort item lookup: powers lineage-key resolution from state + the
  // focus deep-link. Never fatal — a raw lineage key ([id] = UC full_name /
  // Atlas GUID) has no Cosmos row.
  let item: WorkspaceItem | null = null;
  try {
    item = await loadItem(id, type, session.claims.oid);
  } catch {
    item = null;
  }
  // Note: an unresolved id (no Cosmos row and not a raw UC full_name / GUID) is
  // NOT fatal — the Weave/Thread-edge source is tenant-scoped inside
  // getUnifiedLineage, so a freshly-created item with no lineage-key state still
  // gets an honest answer (its downstream Loom-item consumers, if any).

  const ucFromState = ucKeyFromItem(item);
  const guidFromState = guidFromItem(item);

  let ucFullName: string | undefined;
  let purviewGuid: string | undefined;
  if (cloud === 'Commercial' || cloud === 'GCC') {
    ucFullName = keyOverride || ucFromState || (looksLikeUcFullName(id) ? id : undefined);
    purviewGuid = guidFromState;
  } else {
    // GCC-High + DoD/IL5 — Purview/Atlas is the Atlas-family primary; UC overlay
    // when its key resolves. (IL5 Atlas-on-AKS is not injected here — the
    // Weave/Thread-edge source still answers, and `sources`/`degraded` disclose
    // that Purview gated.)
    purviewGuid = keyOverride || guidFromState || (looksLikeUcFullName(id) ? undefined : id);
    ucFullName = ucFromState;
  }

  try {
    const result = await getUnifiedLineage({
      session,
      itemId: id,
      itemType: type,
      depth,
      weaveDepth: depth,
      ucFullName,
      ucHost: hostOverride || undefined,
      purviewGuid,
    });
    const impact = buildImpactResult({
      nodes: result.nodes,
      edges: result.edges,
      focusId: result.focusId,
      sources: result.sources,
    });
    return apiOk({
      focusId: impact.focusId,
      itemName: item?.displayName,
      dependents: impact.dependents,
      groups: impact.groups,
      counts: impact.counts,
      degraded: impact.degraded,
      partial: impact.partial,
      sources: impact.sources,
      cloud,
    });
  } catch (e: any) {
    // getUnifiedLineage catches per-source gates internally; a throw here is an
    // unexpected (Cosmos/identity) failure — genericize + log, never leak.
    return apiServerError(e, 'Failed to compute impact analysis', 'impact_error');
  }
}
