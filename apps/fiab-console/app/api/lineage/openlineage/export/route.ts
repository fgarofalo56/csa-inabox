/**
 * GET /api/lineage/openlineage/export — OpenLineage 1.x export (N17).
 *
 * Serializes the merged unified-lineage graph (Purview/Atlas + Unity Catalog +
 * Weave/OpenLineage facets — the SAME graph the catalog Lineage tab draws) into
 * a schema-valid OpenLineage 1.x RunEvent STREAM for interop: import straight
 * into Marquez / DataHub / OpenMetadata. This is the vendor-neutral export leg
 * of N17 — Loom emits AND speaks the open standard, so lineage is never locked in.
 *
 * READ-ONLY, audited data-access (emit-first). Auth: withSession. Azure-native —
 * no Fabric/Power BI/OneLake host is contacted on the default path; the export
 * reflects whatever sources getUnifiedLineage could reach (disclosed in
 * `sources`). IL5: Weave/Thread edges (in-boundary Cosmos) always answer.
 *
 * Query params:
 *   itemId, itemType — focus Loom item (Weave always answers).
 *   ucFullName       — Unity Catalog catalog.schema.table focus (optional).
 *   purviewGuid      — Atlas/Purview entity GUID focus (optional).
 *   depth            — lineage walk depth (1-10, default 3).
 *   columns=true     — include column-grain facets (folded into table events).
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { getUnifiedLineage } from '@/lib/azure/unified-lineage';
import { unifiedGraphToOpenLineageEvents, LOOM_OL_PRODUCER } from '@/lib/lineage/openlineage';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest, { session }) => {
  const sp = req.nextUrl.searchParams;
  const itemId = sp.get('itemId') || undefined;
  const itemType = sp.get('itemType') || undefined;
  const ucFullName = sp.get('ucFullName') || undefined;
  const purviewGuid = sp.get('purviewGuid') || undefined;
  const columnLineage = sp.get('columns') === 'true';
  const depth = Math.max(1, Math.min(10, parseInt(sp.get('depth') || '3', 10) || 3));

  if (!itemId && !ucFullName && !purviewGuid) {
    return apiError('a focus is required — pass itemId (+itemType), ucFullName, or purviewGuid', 400, { code: 'focus_required' });
  }

  try {
    const graph = await getUnifiedLineage({
      session,
      itemId,
      itemType,
      ucFullName,
      purviewGuid,
      depth,
      weaveDepth: depth,
      columnLineage,
    });

    const events = unifiedGraphToOpenLineageEvents(graph.nodes, graph.edges);

    // Audited data-access (emit-first) — an export IS a data egress event.
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn || session.claims.oid,
      action: 'lineage.openlineage.export',
      targetType: 'lineage-export',
      targetId: itemId || ucFullName || purviewGuid || 'focus',
      outcome: 'success',
      tenantId: session.claims.oid,
      detail: { events: events.length, nodes: graph.nodes.length, edges: graph.edges.length, columnLineage },
    });

    return apiOk({
      producer: LOOM_OL_PRODUCER,
      focusId: graph.focusId,
      sources: graph.sources,
      eventCount: events.length,
      // The OpenLineage 1.x event stream (Marquez/DataHub/OpenMetadata-importable).
      events,
    });
  } catch (e) {
    return apiServerError(e, 'Failed to export OpenLineage', 'openlineage_export_failed');
  }
});
