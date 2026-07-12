/**
 * GET  /api/admin/health/exercise  → latest exercise-run state for the tenant
 *      ({ running | complete } + the structured report when complete).
 * POST /api/admin/health/exercise[?service=spark]  → start an exercise run in
 *      the background (all probes, or just `?service=`/body.services). Returns
 *      the runId immediately; the caller polls GET for the report — the Spark
 *      probe alone can take minutes, longer than Front Door's response window,
 *      so the route never blocks on the run.
 *
 * This is the "does the real path WORK" layer above the config-presence
 * self-audit: every probe EXERCISES the real backend (Livy session, TDS
 * SELECT 1, KQL print 1, lake list, Cosmos query, AOAI completion, domain
 * dry-run sync, ADF list) and reports pass / honest-gate / fail — so a
 * faulted-Spark-pool-class failure is caught by the platform by default.
 *
 * Tenant-admin only: probes run as the Console UAMI against shared tenant
 * backends (and the spark probe creates a real — self-cleaning — session).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiBadRequest, apiServerError } from '@/lib/api/respond';
import {
  SERVICE_PROBES, isKnownService, isRunStale,
  startExerciseRun, getExerciseRunState,
} from '@/lib/admin/service-probes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Tenant scope id — the tid claim (multi-tenant) or the caller oid fallback. */
function tenantScope(claims: { tid?: string; oid: string }): string {
  return (claims as { tid?: string }).tid || claims.oid;
}

export async function GET() {
  const s = getSession();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    const state = await getExerciseRunState(tenantScope(s!.claims));
    return apiOk({
      state,
      stale: state ? isRunStale(state) : false,
      services: SERVICE_PROBES.map((p) => ({ service: p.service, title: p.title })),
    });
  } catch (e) {
    return apiServerError(e, 'failed to read exercise state');
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  // ?service=spark (single) and/or body { services: ['spark','adx'] }.
  const url = new URL(req.url);
  const qs = url.searchParams.get('service');
  let body: { services?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const services = [
    ...(qs ? [qs] : []),
    ...(Array.isArray(body.services) ? body.services.map(String) : []),
  ];
  const unknown = services.filter((svc) => !isKnownService(svc));
  if (unknown.length) {
    return apiBadRequest(
      `unknown service(s): ${unknown.join(', ')} — valid: ${SERVICE_PROBES.map((p) => p.service).join(', ')}`,
    );
  }

  try {
    const claims = s!.claims;
    const { runId, alreadyRunning } = await startExerciseRun(
      { tenantId: tenantScope(claims), who: claims.upn || claims.oid },
      { services },
    );
    return apiOk({ runId, alreadyRunning, running: true });
  } catch (e) {
    return apiServerError(e, 'failed to start exercise run');
  }
}
