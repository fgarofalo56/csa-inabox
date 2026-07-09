/**
 * POST /api/realtime-hub/http-source
 *
 * Loom-native HTTP source ingester (FGC-14) — Azure-native, no Microsoft Fabric.
 * Lands events in an Event Hub over the REAL HTTPS data-plane REST
 * (eventhubs-data-client.sendEvents), so it works today with no AMQP dependency.
 *
 * Two body shapes:
 *   Webhook push:  { eventHubName, events: [ {..}, .. ] }   — forward received events.
 *   Sample emit:   { eventHubName, sampleStream, count? }   — generate `count`
 *                  curated sample-stream events and publish them (this is what
 *                  makes the Real-Time-hub "Sample data" dropdown produce a LIVE
 *                  stream). `sampleStream` is a curated stream id.
 *
 * Honest gate (no-vaporware): when LOOM_EVENTHUBS_NAMESPACE is unset (or the
 * Console UAMI lacks the Event Hubs Data Sender role) sendEvents throws
 * EventHubsDataError with the real status — surfaced here as a precise gate, not
 * a fake success.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { sendEvents, EventHubsDataError, type SendEvent } from '@/lib/azure/eventhubs-data-client';
import { generateSampleEvents, sampleStreamById } from '@/lib/components/realtime-hub/sample-streams';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return NextResponse.json({ ok: false, error: 'Content-Type must be application/json' }, { status: 415 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const eventHubName = String((body as any).eventHubName || '').trim();
  if (!eventHubName) {
    return NextResponse.json({ ok: false, error: 'eventHubName is required.', hint: 'Name the Event Hub received/generated events should land in.' }, { status: 400 });
  }

  // Build the events: either a curated sample stream, or the caller's webhook payload.
  let events: SendEvent[];
  const sampleStream = String((body as any).sampleStream || '').trim();
  if (sampleStream) {
    if (!sampleStreamById(sampleStream)) {
      return NextResponse.json({ ok: false, error: `Unknown sample stream "${sampleStream}".` }, { status: 400 });
    }
    const count = Math.min(500, Math.max(1, Number((body as any).count) || 10));
    events = generateSampleEvents(sampleStream, count).map((e) => ({ body: e }));
  } else if (Array.isArray((body as any).events) && (body as any).events.length) {
    events = ((body as any).events as unknown[])
      .slice(0, 500)
      .map((e) => (e && typeof e === 'object' && 'body' in (e as any) ? (e as SendEvent) : { body: e as any }));
  } else {
    return NextResponse.json({ ok: false, error: 'Provide either `sampleStream` (curated) or a non-empty `events` array (webhook push).' }, { status: 400 });
  }

  try {
    const out = await sendEvents(eventHubName, events, {});
    return NextResponse.json({
      ok: true,
      backend: 'azure-native',
      eventHub: eventHubName,
      sent: out.sent,
      status: out.status,
      batched: out.batched,
      ...(sampleStream ? { sampleStream } : {}),
    });
  } catch (e: any) {
    if (e instanceof EventHubsDataError) {
      const hint = e.status === 503
        ? 'Set LOOM_EVENTHUBS_NAMESPACE to your Event Hubs namespace so the HTTP source can publish.'
        : e.status === 401 || e.status === 403
          ? 'Grant the Console UAMI "Azure Event Hubs Data Sender" on the namespace.'
          : undefined;
      return NextResponse.json({ ok: false, error: e.message, ...(hint ? { hint } : {}) }, { status: e.status });
    }
    return apiServerError(e);
  }
}
