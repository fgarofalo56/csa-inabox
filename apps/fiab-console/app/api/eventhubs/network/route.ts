/**
 * Network rule set (IP / VNet firewall) on the Event Hubs namespace (the
 * namespace navigator → read-only summary). Read-only GET via the real
 * Microsoft.EventHub/namespaces/{ns}/networkRuleSets/default ARM REST.
 *
 *   GET /api/eventhubs/network → { ok, network: { defaultAction, publicNetworkAccess, ipRuleCount, vnetRuleCount } }
 *
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { eventhubsConfigGate, getNetworkRuleSet } from '@/lib/azure/eventhubs-client';

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
    const network = await getNetworkRuleSet();
    return NextResponse.json({ ok: true, network });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
