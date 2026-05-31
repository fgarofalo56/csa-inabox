/**
 * GET /api/monitor/alerts — Azure Monitor metric-alert rules scoped to the
 * Loom resource groups.
 *
 * Backend: GET .../Microsoft.Insights/metricAlerts (real ARM REST).
 * Shape: { ok, data: { rules: AlertRule[] }, error? }
 *
 * Creating/editing alert rules requires a PUT against the same provider with
 * a full rule definition (criteria + action groups). That authoring flow is
 * not yet built; the UI surfaces an honest "list-only" note until it is.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAlertRules, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const rules = await listAlertRules();
    return NextResponse.json({ ok: true, data: { rules } });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
