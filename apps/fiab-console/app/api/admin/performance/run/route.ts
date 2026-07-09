/**
 * PSR-1 — POST /api/admin/performance/run  (+ GET for status polling)
 *
 * POST fires the benchmark suite server-side ASYNC and returns a runId
 * immediately (202) — a full run drives every real backend N times and would
 * exceed the Front Door ~30s cap, so we write a `running` status doc, fire the
 * probe loop as a floating promise (the Container App Node process stays alive
 * across the response), and let the page poll GET ?runId=… for progress.
 *
 * GET ?runId=<id> returns the run status doc (running/completed/failed +
 * completedMetrics/totalMetrics) so the UI can show live progress and refresh
 * the trend when the run finishes.
 *
 * Tenant-admin gated. Real backends only (no-vaporware.md); Azure-native only
 * (no-fabric-dependency.md).
 */
import { NextRequest } from 'next/server';
import { apiOk, apiUnauthorized, apiBadRequest, apiNotFound, apiServerError } from '@/lib/api/respond';
import { NextResponse } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { startRun } from '@/lib/perf/perf-runner';
import { readRunStatus, readRunDocs } from '@/lib/perf/perf-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Derive the console origin from the forwarded request headers. */
function requestOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  return host ? `${proto}://${host}` : '';
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const samples = Number(body?.samples);
  const includeSpark = body?.includeSpark === true;

  try {
    const { runId, totalMetrics } = await startRun({
      tenantId: tenantScopeId(s),
      triggeredBy: s.claims.upn || s.claims.email || s.claims.oid,
      samples: Number.isFinite(samples) ? samples : undefined,
      includeSpark,
      baseUrl: process.env.LOOM_CONSOLE_BASE_URL || requestOrigin(req) || undefined,
      cookieHeader: req.headers.get('cookie') || undefined,
    });
    return NextResponse.json({ ok: true, runId, totalMetrics }, { status: 202 });
  } catch (e) {
    return apiServerError(e, 'Failed to start benchmark run');
  }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const runId = (req.nextUrl.searchParams.get('runId') || '').trim();
  if (!runId) return apiBadRequest('runId required');

  try {
    const status = await readRunStatus(runId);
    if (!status) return apiNotFound('run not found');
    const wantDocs = req.nextUrl.searchParams.get('docs') === '1';
    const docs = wantDocs ? await readRunDocs(runId) : undefined;
    return apiOk({ status, ...(docs ? { docs } : {}) });
  } catch (e) {
    return apiServerError(e, 'Failed to read run status');
  }
}
