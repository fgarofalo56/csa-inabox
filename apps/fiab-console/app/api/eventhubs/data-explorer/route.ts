/**
 * Event Hubs DATA-plane (Data Explorer) BFF route — Send + View (peek) events.
 *
 * The data-plane counterpart to the ARM control-plane routes under
 * /api/eventhubs/{hubs,consumergroups,…}. Talks to the real Event Hubs runtime
 * endpoint https://<namespace>.servicebus.windows.net/<hub>/messages via
 * lib/azure/eventhubs-data-client.ts, authenticated with Microsoft Entra
 * (the namespace has disableLocalAuth:true, so SAS is intentionally not used).
 *
 *   POST /api/eventhubs/data-explorer  body { op:'send', hub, events:[{body, properties?}], partitionKey? }
 *                              → { ok, sent, status, batched } (real 201 from the service)
 *   POST /api/eventhubs/data-explorer  body { op:'peek', hub, partition?, maxEvents?, fromLatest?, consumerGroup? }
 *   GET  /api/eventhubs/data-explorer?op=peek&hub=H&partition=0&maxEvents=20
 *                              → 200 { ok, events } when AMQP receive is enabled,
 *                                or 501 { ok:false, code:'receive_unavailable', … }
 *                                honest dependency-gate (Event Hubs has no REST
 *                                receive; receiving needs @azure/event-hubs/AMQP).
 *
 * Session guard (401), honest 503 config-gate (mirrors /api/eventhubs/hubs),
 * and real service errors pass through (e.g. 401/403 when the UAMI lacks the
 * Azure Event Hubs Data role). No mocks. No faked events.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate,
  sendEvents,
  peekEvents,
  EventHubsDataError,
  EventHubsReceiveUnavailableError,
  type SendEvent,
  type PeekOptions,
} from '@/lib/azure/eventhubs-data-client';

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

/** Map a thrown data-plane error to a precise HTTP response (honest, real). */
function errorResponse(e: unknown): NextResponse {
  if (e instanceof EventHubsReceiveUnavailableError) {
    return NextResponse.json(
      {
        ok: false,
        code: e.code,
        error: e.message,
        dependency: e.dependency,
        missing: e.envVar,
        hint: e.hint,
      },
      { status: 501 }, // Not Implemented in this runtime — honest dependency-gate.
    );
  }
  if (e instanceof EventHubsDataError) {
    // Surface the real upstream status (401/403/4xx/5xx) and body.
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json({ ok: false, error: e.message, status: e.status, body: e.body }, { status });
  }
  return NextResponse.json({ ok: false, error: (e as any)?.message || String(e) }, { status: 502 });
}

/** Normalize a request-body event into a typed SendEvent (string-or-JSON body). */
function toSendEvent(raw: any): SendEvent | null {
  if (raw == null) return null;
  // Allow either { body, properties } or a bare scalar/object payload.
  const hasShape = typeof raw === 'object' && !Array.isArray(raw) && ('body' in raw || 'properties' in raw);
  const body = hasShape ? raw.body : raw;
  if (body === undefined || body === null || body === '') return null;
  const ev: SendEvent = { body };
  if (hasShape && raw.properties && typeof raw.properties === 'object') {
    const props: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw.properties)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') props[k] = v;
    }
    if (Object.keys(props).length > 0) ev.properties = props;
  }
  return ev;
}

async function handleSend(hub: string, body: any): Promise<NextResponse> {
  const rawEvents: any[] = Array.isArray(body?.events)
    ? body.events
    : body?.event != null
      ? [body.event]
      : [];
  const events = rawEvents.map(toSendEvent).filter((e): e is SendEvent => e != null);
  if (events.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one non-empty event is required' }, { status: 400 });
  }
  const partitionKey = typeof body?.partitionKey === 'string' && body.partitionKey.trim() ? body.partitionKey.trim() : undefined;
  try {
    const result = await sendEvents(hub, events, { partitionKey });
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

async function handlePeek(hub: string, opts: PeekOptions): Promise<NextResponse> {
  try {
    const result = await peekEvents(hub, opts);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  const body = await req.json().catch(() => ({}));
  const op: string = typeof body?.op === 'string' ? body.op : '';
  const hub: string = typeof body?.hub === 'string' ? body.hub.trim() : '';
  if (!hub) return NextResponse.json({ ok: false, error: 'hub is required' }, { status: 400 });

  if (op === 'send') return handleSend(hub, body);
  if (op === 'peek') {
    const opts: PeekOptions = {
      partition: typeof body?.partition === 'string' ? body.partition : undefined,
      maxEvents: Number.isFinite(body?.maxEvents) ? Number(body.maxEvents) : undefined,
      fromLatest: typeof body?.fromLatest === 'boolean' ? body.fromLatest : undefined,
      consumerGroup: typeof body?.consumerGroup === 'string' ? body.consumerGroup : undefined,
      maxWaitMs: Number.isFinite(body?.maxWaitMs) ? Number(body.maxWaitMs) : undefined,
    };
    return handlePeek(hub, opts);
  }
  return NextResponse.json({ ok: false, error: `unknown op '${op}' (expected 'send' or 'peek')` }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  const sp = req.nextUrl.searchParams;
  const op = sp.get('op') || 'peek';
  if (op !== 'peek') {
    return NextResponse.json({ ok: false, error: `GET supports op=peek only (got '${op}'); use POST for send` }, { status: 400 });
  }
  const hub = sp.get('hub')?.trim();
  if (!hub) return NextResponse.json({ ok: false, error: 'hub query param is required' }, { status: 400 });
  const maxEventsRaw = sp.get('maxEvents');
  const opts: PeekOptions = {
    partition: sp.get('partition') || undefined,
    maxEvents: maxEventsRaw && Number.isFinite(Number(maxEventsRaw)) ? Number(maxEventsRaw) : undefined,
    fromLatest: sp.get('fromLatest') == null ? undefined : sp.get('fromLatest') !== 'false',
    consumerGroup: sp.get('consumerGroup') || undefined,
  };
  return handlePeek(hub, opts);
}
