/**
 * POST /api/business-events/publish
 *
 * Publish a STRUCTURED, GOVERNED business event.
 *
 *   body {
 *     typeId: string,                 // registered governed event-type id
 *     subject: string,                // CloudEvents subject (resource the event is about)
 *     data: Record<string, unknown>,  // payload (validated against the type schema)
 *   }
 *   → { ok, results: { eventgrid?: PublishResult, eventhub?: SendResult }, eventType, validated: true }
 *
 * Flow:
 *   1. Resolve the governed event type from the Cosmos registry.
 *   2. Validate `data` against its field schema — reject on any governance error.
 *   3. Publish to each channel the type declares:
 *        - eventgrid → CloudEvents POST to the custom topic (real data plane)
 *        - eventhub  → HTTPS send to the Event Hub entity (real data plane)
 *
 * Real backends only. Per-channel failures are reported precisely; a channel
 * config-gate (missing env) is surfaced as an honest message, never faked.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  businessEventsConfigGate,
  getEventType,
  validatePayload,
} from '@/lib/azure/business-events-store';
import {
  publishBusinessEvents,
  defaultBusinessTopicName,
  eventgridTopicsConfigGate,
  EventGridTopicsError,
} from '@/lib/azure/eventgrid-topics-client';
import { sendEvents, EventHubsDataError } from '@/lib/azure/eventhubs-data-client';
import { eventhubsConfigGate } from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const regGate = businessEventsConfigGate();
  if (regGate) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Business-event registry not configured: set ${regGate.missing}.`, missing: regGate.missing },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const typeId = typeof body?.typeId === 'string' ? body.typeId.trim() : '';
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const data = body?.data;
  if (!typeId) return NextResponse.json({ ok: false, error: 'typeId is required' }, { status: 400 });
  if (!subject) return NextResponse.json({ ok: false, error: 'subject is required' }, { status: 400 });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return NextResponse.json({ ok: false, error: 'data must be a JSON object' }, { status: 400 });
  }

  // 1. Governed type.
  let type;
  try {
    type = await getEventType(typeId);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  if (!type) return NextResponse.json({ ok: false, error: `governed event type "${typeId}" not found` }, { status: 404 });

  // 2. Validate against the governed schema (the governance gate).
  const errors = validatePayload(type, data as Record<string, unknown>);
  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, code: 'schema_validation_failed', error: 'Payload failed governed-schema validation.', errors },
      { status: 422 },
    );
  }

  const results: Record<string, unknown> = {};
  const channelErrors: Record<string, string> = {};

  // 3a. Event Grid channel.
  if (type.channels.includes('eventgrid')) {
    const egGate = eventgridTopicsConfigGate();
    if (egGate) {
      channelErrors.eventgrid = `Event Grid not configured: set ${egGate.missing}.`;
    } else {
      const topic = type.eventGridTopic || defaultBusinessTopicName();
      try {
        results.eventgrid = await publishBusinessEvents(topic, [
          { eventType: type.eventType, subject, data: data as Record<string, unknown> },
        ]);
      } catch (e: any) {
        const status = e instanceof EventGridTopicsError ? e.status : 502;
        channelErrors.eventgrid = `${e?.message || String(e)} (status ${status})`;
      }
    }
  }

  // 3b. Event Hubs channel.
  if (type.channels.includes('eventhub')) {
    const ehGate = eventhubsConfigGate();
    const hub = type.eventHubName || process.env.LOOM_EVENTHUB_BUSINESS_HUB || 'loom-telemetry';
    if (ehGate) {
      channelErrors.eventhub = `Event Hubs not configured: set ${ehGate.missing}.`;
    } else {
      try {
        // Publish the same governed envelope to the durable stream.
        results.eventhub = await sendEvents(hub, [
          {
            body: {
              specversion: '1.0',
              type: type.eventType,
              subject,
              time: new Date().toISOString(),
              data,
            },
            properties: { eventType: type.eventType, category: type.category },
          },
        ]);
      } catch (e: any) {
        const status = e instanceof EventHubsDataError ? e.status : 502;
        channelErrors.eventhub = `${e?.message || String(e)} (status ${status})`;
      }
    }
  }

  const anyPublished = Object.keys(results).length > 0;
  const status = anyPublished ? 200 : 502;
  return NextResponse.json(
    {
      ok: anyPublished,
      eventType: type.eventType,
      validated: true,
      results,
      ...(Object.keys(channelErrors).length ? { channelErrors } : {}),
    },
    { status },
  );
}
