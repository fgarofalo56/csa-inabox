/**
 * Business event consumers (subscribers) — Real-Time hub "Consumers" tab.
 *
 *   POST   /api/business-events/:id/consumers      → register a subscriber
 *   DELETE /api/business-events/:id/consumers?consumerId=…  → unsubscribe
 *
 * Registering a consumer records the subscription on the definition so the
 * Real-Time hub Consumers tab can list who reacts to the signal. Webhook /
 * Logic App / Function / Service Bus consumers are routed by Event Grid when
 * LOOM_BUSINESS_EVENTS_EGTOPIC is configured; the registry is the governance
 * record of subscribers regardless of transport. Azure-native. No Fabric.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { registerConsumer, removeConsumer, BusinessEventError } from '@/lib/azure/business-events-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_KINDS = ['activator', 'function', 'logic-app', 'webhook', 'service-bus'] as const;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = decodeURIComponent(params.id);
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const kind = VALID_KINDS.includes(body?.kind) ? body.kind : 'webhook';
  try {
    const event = await registerConsumer(session.claims.oid, id, {
      name,
      kind,
      endpoint: typeof body?.endpoint === 'string' ? body.endpoint.trim() : undefined,
    });
    return NextResponse.json({ ok: true, event }, { status: 201 });
  } catch (e: any) {
    const status = e instanceof BusinessEventError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = decodeURIComponent(params.id);
  const consumerId = req.nextUrl.searchParams.get('consumerId')?.trim();
  if (!consumerId) return NextResponse.json({ ok: false, error: 'consumerId query param is required' }, { status: 400 });
  try {
    const event = await removeConsumer(session.claims.oid, id, consumerId);
    return NextResponse.json({ ok: true, event });
  } catch (e: any) {
    const status = e instanceof BusinessEventError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
