/**
 * /api/observability/incidents — N17 incident feed.
 *
 *   GET  — list this tenant's incidents (optional ?status= / ?itemId=).
 *   POST — CONSUME N7d data-quality findings into incidents (idempotent);
 *          N7d is the PRODUCER, N17 is the CONSUMER (no check is re-run here).
 *
 * withTenantAdmin. FLAG0 kill-switch: n17-incident-console. Real Cosmos backend
 * (no-vaporware) — a fresh tenant returns an empty list (guided empty state, no
 * red first-open). Azure-native, IL5-safe (in-boundary Cosmos, no SaaS).
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { listIncidents, consumeFindingsIntoIncidents } from '@/lib/observability/incident-store';
import { N17_FLAG_ID } from '@/lib/observability/incident-model';
import type { IncidentStatus } from '@/lib/observability/incident-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_STATUS = new Set<IncidentStatus>(['open', 'acknowledged', 'resolved']);

export const GET = withTenantAdmin(async (req: NextRequest, { session }) => {
  if (!(await runtimeFlag(N17_FLAG_ID, { default: true }))) return apiOk({ flagOff: true, incidents: [] });
  const sp = req.nextUrl.searchParams;
  const statusRaw = sp.get('status') || '';
  const status = VALID_STATUS.has(statusRaw as IncidentStatus) ? (statusRaw as IncidentStatus) : undefined;
  const itemId = sp.get('itemId') || undefined;
  const incidents = await listIncidents(session.claims.oid, { status, itemId });
  return apiOk({ incidents });
});

export const POST = withTenantAdmin(async (_req, { session }) => {
  if (!(await runtimeFlag(N17_FLAG_ID, { default: true }))) {
    return apiError('the incident console is turned off (n17-incident-console)', 409, { code: 'flag_off' });
  }
  const actor = { oid: session.claims.oid, who: session.claims.upn || session.claims.oid, tenantId: session.claims.oid };
  const result = await consumeFindingsIntoIncidents(actor);
  return apiOk({ opened: result.opened, groups: result.groups });
});
