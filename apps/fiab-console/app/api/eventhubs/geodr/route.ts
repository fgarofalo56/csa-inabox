/**
 * Geo-disaster-recovery (Geo-DR) configs on the Event Hubs namespace (the
 * namespace navigator → read-only Geo-DR group). Read-only list via the real
 * Microsoft.EventHub/namespaces/{ns}/disasterRecoveryConfigs ARM REST.
 *
 *   GET /api/eventhubs/geodr → { ok, configs: [{name, role, partnerNamespace, provisioningState}] }
 *
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { eventhubsConfigGate, listDisasterRecoveryConfigs } from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = eventhubsConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Event Hubs namespace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const configs = await listDisasterRecoveryConfigs();
    return NextResponse.json({ ok: true, configs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
