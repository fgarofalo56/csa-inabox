/**
 * Network rule set (IP / VNet firewall) on the Event Hubs namespace — the
 * editable Networking blade. Real Microsoft.EventHub/namespaces/{ns}/
 * networkRuleSets/default ARM REST (GET read + PUT write).
 *
 *   GET /api/eventhubs/network → { ok, network: { defaultAction, publicNetworkAccess, ipRules, vnetRules, … } }
 *   PUT /api/eventhubs/network   body { defaultAction?, publicNetworkAccess?, trustedServiceAccessEnabled?, ipRules?, vnetRules? }
 *
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { eventhubsConfigGate, getNetworkRuleSet, updateNetworkRuleSet } from '@/lib/azure/eventhubs-client';

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

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const defaultAction = body?.defaultAction === 'Deny' ? 'Deny' : body?.defaultAction === 'Allow' ? 'Allow' : undefined;
  const pna = ['Enabled', 'Disabled', 'SecuredByPerimeter'].includes(body?.publicNetworkAccess) ? body.publicNetworkAccess : undefined;
  const ipRules = Array.isArray(body?.ipRules)
    ? body.ipRules.map((x: any) => ({ ipMask: typeof x === 'string' ? x : x?.ipMask })).filter((x: any) => typeof x.ipMask === 'string' && x.ipMask.trim())
    : undefined;
  const vnetRules = Array.isArray(body?.vnetRules)
    ? body.vnetRules.map((x: any) => ({ subnetId: typeof x === 'string' ? x : x?.subnetId, ignoreMissingVnetServiceEndpoint: x?.ignoreMissingVnetServiceEndpoint }))
        .filter((x: any) => typeof x.subnetId === 'string' && x.subnetId.trim())
    : undefined;
  try {
    const network = await updateNetworkRuleSet({
      defaultAction,
      publicNetworkAccess: pna,
      trustedServiceAccessEnabled: typeof body?.trustedServiceAccessEnabled === 'boolean' ? body.trustedServiceAccessEnabled : undefined,
      ipRules,
      vnetRules,
    });
    return NextResponse.json({ ok: true, network });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
