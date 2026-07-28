/**
 * POST /api/observability/monitors/[id]/observe — N17 observation feed.
 *
 * Record a metric observation for a monitor (row count / data-age-minutes /
 * column set), evaluate it against the monitor's rolling baseline (reusing the
 * N7d anomaly detector), and — when it trips + the monitor is enabled — open or
 * update an incident (which fires the O1 alert + emit-first audit).
 *
 * In production this is called by run-completion hooks (the shared OL emitter's
 * sibling) with the run's real counts; it also backs the manual "Run now" button
 * and the seeded-table incident-trip test. withTenantAdmin. FLAG0 gated.
 * Real Cosmos backend, Azure-native, IL5-safe.
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiNotFound } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { recordObservation } from '@/lib/observability/monitor-store';
import { N17_FLAG_ID } from '@/lib/observability/incident-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withTenantAdmin<{ id: string }>(async (req: NextRequest, { session, params }) => {
  if (!(await runtimeFlag(N17_FLAG_ID, { default: true }))) {
    return apiError('the incident console is turned off (n17-incident-console)', 409, { code: 'flag_off' });
  }
  const id = params.id;
  if (!id) return apiNotFound();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400, { code: 'bad_json' });
  }
  const value = Number(body.value);
  if (!Number.isFinite(value)) return apiError('value (number) is required', 400, { code: 'bad_value' });
  const columns = Array.isArray(body.columns) ? body.columns.map((c) => String(c)) : undefined;
  const at = typeof body.at === 'string' ? body.at : undefined;

  const actor = { oid: session.claims.oid, who: session.claims.upn || session.claims.oid, tenantId: session.claims.oid };
  const result = await recordObservation(session.claims.oid, id, { value, columns, at }, actor);
  if (!result) return apiNotFound();

  return apiOk({
    verdict: result.verdict,
    tripped: result.verdict.tripped,
    incidentId: result.incident?.id ?? null,
    monitor: { id: result.monitor.id, kind: result.monitor.kind, lastValue: result.monitor.lastValue, observations: result.monitor.observations.length },
  });
});
