/**
 * Consumer groups on an event hub (the namespace navigator → Consumer groups
 * group, parented by the chosen event hub). Lists/creates/deletes via the real
 * Microsoft.EventHub/namespaces/{ns}/eventhubs/{eh}/consumergroups ARM REST.
 *
 *   GET    /api/eventhubs/consumergroups?eventHub=EH        → { ok, consumerGroups: [{name, userMetadata, …}] }
 *   POST   /api/eventhubs/consumergroups                    body { eventHub, name, userMetadata? } → create
 *   DELETE /api/eventhubs/consumergroups?eventHub=EH&name=N → delete (the $Default group cannot be deleted)
 *
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate, listConsumerGroups, createConsumerGroup, deleteConsumerGroup,
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
  if (!eventHub) return NextResponse.json({ ok: false, error: 'eventHub query param is required' }, { status: 400 });
  try {
    const consumerGroups = await listConsumerGroups(eventHub);
    return NextResponse.json({ ok: true, consumerGroups });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const eventHub: string = typeof body?.eventHub === 'string' ? body.eventHub.trim() : '';
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!eventHub) return NextResponse.json({ ok: false, error: 'eventHub is required' }, { status: 400 });
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const userMetadata = typeof body?.userMetadata === 'string' ? body.userMetadata : undefined;
  try {
    const consumerGroup = await createConsumerGroup(eventHub, name, userMetadata);
    return NextResponse.json({ ok: true, consumerGroup });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const eventHub = req.nextUrl.searchParams.get('eventHub')?.trim();
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!eventHub) return NextResponse.json({ ok: false, error: 'eventHub query param is required' }, { status: 400 });
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deleteConsumerGroup(eventHub, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
