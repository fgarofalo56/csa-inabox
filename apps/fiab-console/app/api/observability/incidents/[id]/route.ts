/**
 * GET /api/observability/incidents/[id] — one incident + its downstream-impact.
 *
 * Returns the incident (timeline + metric) alongside the blast-radius panel:
 * getUnifiedLineage walked FORWARD from the incident's item (Purview/Atlas + UC +
 * Weave/OpenLineage facets — Azure-native, Weave always answers), resolved by the
 * pure resolveDownstreamImpact. withTenantAdmin. FLAG0 gated. Real backends only.
 */
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiNotFound } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { getIncident } from '@/lib/observability/incident-store';
import { getUnifiedLineage } from '@/lib/azure/unified-lineage';
import { resolveDownstreamImpact, type DownstreamImpact } from '@/lib/observability/downstream-impact';
import { N17_FLAG_ID } from '@/lib/observability/incident-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin<{ id: string }>(async (_req, { session, params }) => {
  if (!(await runtimeFlag(N17_FLAG_ID, { default: true }))) {
    return apiError('the incident console is turned off (n17-incident-console)', 409, { code: 'flag_off' });
  }
  const id = params.id;
  if (!id) return apiNotFound();
  const incident = await getIncident(session.claims.oid, id);
  if (!incident) return apiNotFound();

  // Downstream-impact — best-effort (a lineage-source gate must not blank the
  // incident). getUnifiedLineage catches per-source gates internally.
  let impact: DownstreamImpact | null = null;
  try {
    const graph = await getUnifiedLineage({
      session,
      itemId: incident.itemId,
      itemType: incident.itemType,
      depth: 4,
      weaveDepth: 4,
    });
    impact = resolveDownstreamImpact(graph.nodes, graph.edges, graph.focusId || incident.itemId);
  } catch {
    impact = null;
  }

  return apiOk({ incident, impact });
});
