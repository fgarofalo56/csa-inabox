/**
 * GET /api/monitor/activity?days=7 — recent ARM Activity Log events for the
 * Loom resource groups (deployments, role changes, scale operations).
 *
 * NOTE: distinct from /api/activity, which is the Cosmos-backed *item*
 * activity feed (edits/comments/shares). This one is the Azure control-plane
 * Activity Log — "who changed infrastructure".
 *
 * Backend: GET .../Microsoft.Insights/eventtypes/management/values (real REST).
 * Shape: { ok, data: { events: ActivityLogEvent[] }, error? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listActivityLog, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get('days')) || 7));
  try {
    const events = await listActivityLog({ days });
    return NextResponse.json({ ok: true, data: { events } });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
