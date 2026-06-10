/**
 * Private endpoint connections on the Event Hubs namespace (the namespace
 * navigator → Private Endpoints panel). List + approve/reject via the real
 * Microsoft.EventHub/namespaces/{ns}/privateEndpointConnections ARM REST.
 *
 *   GET  /api/eventhubs/private-endpoints                                   → { ok, connections }
 *   POST /api/eventhubs/private-endpoints  body { name, action:'approve'|'reject', description? } → { ok, connection }
 *
 * The PE itself is provisioned by eventhubs.bicep (groupIds: ['namespace'],
 * DNS zone privatelink.servicebus.windows.net / .usgovcloudapi.net). This
 * surface manages the connection state for manual / cross-tenant requests.
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate, listNamespacePrivateEndpointConnections,
  approvePrivateEndpointConnection, rejectPrivateEndpointConnection,
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

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const connections = await listNamespacePrivateEndpointConnections();
    return NextResponse.json({ ok: true, connections });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  const action: string = typeof body?.action === 'string' ? body.action : '';
  const description: string | undefined = typeof body?.description === 'string' ? body.description : undefined;
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    if (action === 'approve') {
      const connection = await approvePrivateEndpointConnection(name, description);
      return NextResponse.json({ ok: true, connection });
    }
    if (action === 'reject') {
      const connection = await rejectPrivateEndpointConnection(name, description);
      return NextResponse.json({ ok: true, connection });
    }
    return NextResponse.json({ ok: false, error: `unknown action '${action}' (expected approve|reject)` }, { status: 400 });
  } catch (e: any) {
    const status = e?.status === 400 ? 400 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
