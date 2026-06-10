/**
 * Business events — collection route (Real-Time hub "Business events").
 *
 *   GET  /api/business-events    → { ok, backend, transportConfigured, namespace?, events }
 *   POST /api/business-events    → create a governed signal definition { ok, event }
 *
 * Azure-native by default (no Microsoft Fabric, per no-fabric-dependency.md):
 * each business event is a Cosmos definition bound to an Event Hub transport on
 * the deployment namespace. The list also reports whether the Event Hubs
 * transport is configured so the UI can render an honest infra-gate (publishing
 * requires LOOM_EVENTHUB_NAMESPACE) while still showing every definition.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listBusinessEvents,
  createBusinessEvent,
  transportConfigGate,
  defaultBusinessEventHub,
  eventGridTopicEndpoint,
  BusinessEventError,
} from '@/lib/azure/business-events-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;
  try {
    const events = await listBusinessEvents(tenantId);
    const gate = transportConfigGate();
    return NextResponse.json({
      ok: true,
      backend: 'azure-native',
      transportConfigured: !gate,
      transportMissing: gate?.missing,
      eventGridConfigured: !!eventGridTopicEndpoint(),
      defaultEventHub: defaultBusinessEventHub(),
      namespace: process.env.LOOM_EVENTHUB_NAMESPACE || undefined,
      events,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;
  const body = await req.json().catch(() => ({}));
  try {
    const event = await createBusinessEvent(tenantId, session.claims.upn || session.claims.oid, {
      name: body?.name,
      description: body?.description,
      schemaSet: body?.schemaSet,
      schema: body?.schema,
      eventHub: body?.eventHub,
      eventGridTopic: body?.eventGridTopic,
    });
    return NextResponse.json({ ok: true, event }, { status: 201 });
  } catch (e: any) {
    const status = e instanceof BusinessEventError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
