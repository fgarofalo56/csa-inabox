/**
 * SAS key reveal for an Event Hubs authorization rule (the namespace navigator →
 * SAS Keys panel "Reveal keys" action). POST listKeys on the real
 * Microsoft.EventHub/namespaces/{ns}[/eventhubs/{eh}]/authorizationRules/{rule}
 * ARM REST.
 *
 *   POST /api/eventhubs/authrules/{rule}/keys?scope=namespace        → { ok, keys }
 *   POST /api/eventhubs/authrules/{rule}/keys?scope=eventhub&hub=EH  → { ok, keys }
 *
 * When the namespace sets disableLocalAuth:true the per-hub path suppresses
 * connection strings (localAuthDisabled flagged); the namespace RootManage rule
 * still returns its values (the namespace listKeys is the authoritative source).
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate, listEventHubKeys, listNamespaceKeys,
  getNamespaceProperties,
} from '@/lib/azure/eventhubs-client';

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

export async function POST(req: NextRequest, ctx: { params: Promise<{ rule: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const { rule } = await ctx.params;
  const ruleName = decodeURIComponent(rule || '').trim();
  if (!ruleName) return NextResponse.json({ ok: false, error: 'rule is required' }, { status: 400 });
  const scope = req.nextUrl.searchParams.get('scope')?.trim() || 'namespace';
  const hub = req.nextUrl.searchParams.get('hub')?.trim();
  try {
    if (scope === 'eventhub') {
      if (!hub) return NextResponse.json({ ok: false, error: 'hub query param is required for scope=eventhub' }, { status: 400 });
      const keys = await listEventHubKeys(hub, ruleName);
      return NextResponse.json({ ok: true, keys });
    }
    const nsKeys = await listNamespaceKeys(ruleName);
    let localAuthDisabled = true;
    try { localAuthDisabled = (await getNamespaceProperties()).disableLocalAuth; } catch { localAuthDisabled = true; }
    return NextResponse.json({ ok: true, keys: { ...nsKeys, localAuthDisabled } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
