/**
 * GET /api/monitor/health — current Azure Resource Health availability
 * status for every monitored resource in the Loom subscription.
 *
 * Backend: Microsoft.ResourceHealth/availabilityStatuses (real ARM REST).
 * Shape: { ok, data: { statuses: ResourceHealthStatus[] }, error? }
 * Honest gate when subscription/RGs unconfigured.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listResourceHealth, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const map = await listResourceHealth();
    const statuses = Object.values(map);
    return NextResponse.json({ ok: true, data: { statuses } });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
