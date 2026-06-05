/**
 * GET /api/monitor/inventory — the Loom-deployed Azure resource inventory.
 *
 * Backend: ARM "list resources in RG" across every Loom RG (real Azure REST).
 *
 * Shape: { ok, data: { resources: LoomResource[] }, error? }
 * Honest gate: 200 { ok:false, gate } when LOOM_SUBSCRIPTION_ID / Loom RGs
 * aren't configured.
 *
 * PERF: this route deliberately does NOT join Resource Health inline. The
 * whole-subscription Microsoft.ResourceHealth availabilityStatuses crawl is a
 * slow, serial, paginated call (up to 20 round-trips) and was the dominant
 * cost of the Monitor first paint. Health now lives behind its own
 * /api/monitor/health route and the client fetches it in parallel, merging
 * badges into the (instantly rendered) inventory grid as they arrive.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listResources, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const resources = await listResources();
    return NextResponse.json({ ok: true, data: { resources } });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
