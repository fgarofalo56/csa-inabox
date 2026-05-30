/**
 * GET /api/monitor/inventory — the Loom-deployed Azure resource inventory
 * joined with current Resource Health availability state.
 *
 * Backend: ARM "list resources in RG" across every Loom RG + the
 * Microsoft.ResourceHealth availabilityStatuses list (real Azure REST).
 *
 * Shape: { ok, data: { resources: LoomResource[], health: {<id>: state} },
 *          error? }
 * Honest gate: 200 { ok:false, gate } when LOOM_SUBSCRIPTION_ID / Loom RGs
 * aren't configured. Resource Health failures degrade gracefully (the
 * inventory still returns; health is best-effort).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listResources, listResourceHealth, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const resources = await listResources();
    // Resource Health is best-effort — never let it sink the inventory.
    let health: Record<string, { availabilityState: string; summary?: string }> = {};
    try {
      const raw = await listResourceHealth();
      health = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, { availabilityState: v.availabilityState, summary: v.summary }]),
      );
    } catch { /* health unavailable — inventory still renders */ }
    return NextResponse.json({ ok: true, data: { resources, health } });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.message } });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
