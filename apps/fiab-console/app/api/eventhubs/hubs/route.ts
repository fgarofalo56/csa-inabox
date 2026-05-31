/**
 * Event hubs (entities) on the deployment-default Event Hubs namespace
 * (the namespace navigator → Event hubs group). Lists/creates/deletes event
 * hubs via the real Microsoft.EventHub/namespaces/{ns}/eventhubs ARM REST.
 *
 *   GET    /api/eventhubs/hubs                 → { ok, hubs: [{name, partitionCount, messageRetentionInDays, status, …}] }
 *   POST   /api/eventhubs/hubs                 body { name, partitionCount?, messageRetentionInDays? } → create
 *   DELETE /api/eventhubs/hubs?name=NAME       → delete the event hub
 *
 * Honest 503 gate when LOOM_EVENTHUB_NAMESPACE (or sub/RG) is unset. Real ARM
 * REST. No mocks. The Loom UAMI must hold Contributor on the namespace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate, listEventHubs, createEventHub, deleteEventHub,
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
    const hubs = await listEventHubs();
    return NextResponse.json({ ok: true, hubs });
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
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const partitionCount = Number.isFinite(body?.partitionCount) ? Number(body.partitionCount) : undefined;
  const messageRetentionInDays = Number.isFinite(body?.messageRetentionInDays) ? Number(body.messageRetentionInDays) : undefined;
  try {
    const hub = await createEventHub({ name, partitionCount, messageRetentionInDays });
    return NextResponse.json({ ok: true, hub });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deleteEventHub(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
