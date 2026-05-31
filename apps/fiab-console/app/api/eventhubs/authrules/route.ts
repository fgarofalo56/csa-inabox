/**
 * Authorization rules (SAS policies) on the Event Hubs namespace, and
 * optionally on a single event hub (the namespace navigator → Authorization
 * rules group). Read-only list via the real
 * Microsoft.EventHub/namespaces/{ns}[/eventhubs/{eh}]/authorizationRules ARM
 * REST. SAS keys are NOT returned (a separate privileged listKeys action).
 *
 *   GET /api/eventhubs/authrules               → { ok, rules: [{name, rights, scope:'namespace'}] }
 *   GET /api/eventhubs/authrules?eventHub=EH    → { ok, rules: [{name, rights, scope:EH}] }
 *
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate, listNamespaceAuthRules, listEventHubAuthRules,
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

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const eventHub = req.nextUrl.searchParams.get('eventHub')?.trim();
  try {
    const rules = eventHub
      ? await listEventHubAuthRules(eventHub)
      : await listNamespaceAuthRules();
    return NextResponse.json({ ok: true, rules });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
