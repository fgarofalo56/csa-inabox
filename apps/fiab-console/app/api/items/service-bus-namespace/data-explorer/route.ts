/**
 * Service Bus DATA-plane (Service Bus Explorer) BFF route — Send + Peek.
 *
 * The data-plane counterpart to the ARM control-plane
 * /api/items/service-bus-namespace route. Talks to the real Service Bus runtime
 * over HTTPS via lib/azure/servicebus-data-client.ts, authenticated with
 * Microsoft Entra (the namespace deploys disableLocalAuth:true, so SAS is not
 * used):
 *
 *   POST /api/items/service-bus-namespace/data-explorer
 *        { op:'send', entity, body, label?, sessionId?, partitionKey?, messageId? }
 *          → { ok, status, entity }   (real 201 from the service)
 *   POST /api/items/service-bus-namespace/data-explorer
 *        { op:'peek', queue } | { op:'peek', topic, subscription }, max?
 *          → { ok, messages }         (non-destructive peek-lock + unlock)
 *
 * Session guard (401), honest 503 config-gate (mirrors the item route), and real
 * service errors pass through (e.g. 401/403 when the UAMI lacks the Azure
 * Service Bus Data Sender / Receiver role). No mocks. No faked messages.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  servicebusConfigGate,
  sendMessage,
  peekMessages,
  ServiceBusDataError,
} from '@/lib/azure/servicebus-data-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = servicebusConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Service Bus namespace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function errorResponse(e: unknown): NextResponse {
  if (e instanceof ServiceBusDataError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json({ ok: false, error: e.message, status: e.status, body: e.body }, { status });
  }
  return NextResponse.json({ ok: false, error: (e as any)?.message || String(e) }, { status: 502 });
}

export async function POST(req: NextRequest) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;

  const body = await req.json().catch(() => ({}));
  const op: string = typeof body?.op === 'string' ? body.op : '';

  if (op === 'send') {
    const entity = typeof body?.entity === 'string' ? body.entity.trim() : '';
    if (!entity) return NextResponse.json({ ok: false, error: 'entity (queue or topic) is required' }, { status: 400 });
    try {
      const result = await sendMessage(entity, {
        body: body?.body,
        label: typeof body?.label === 'string' ? body.label : undefined,
        sessionId: typeof body?.sessionId === 'string' ? body.sessionId : undefined,
        partitionKey: typeof body?.partitionKey === 'string' ? body.partitionKey : undefined,
        messageId: typeof body?.messageId === 'string' ? body.messageId : undefined,
      });
      return NextResponse.json(result);
    } catch (e) { return errorResponse(e); }
  }

  if (op === 'peek') {
    const queue = typeof body?.queue === 'string' ? body.queue.trim() : '';
    const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
    const subscription = typeof body?.subscription === 'string' ? body.subscription.trim() : '';
    let entityPath = '';
    if (queue) entityPath = queue;
    else if (topic && subscription) entityPath = `${topic}/subscriptions/${subscription}`;
    else return NextResponse.json({ ok: false, error: 'peek requires a queue, or a topic + subscription' }, { status: 400 });
    const max = Number.isFinite(body?.max) ? Number(body.max) : undefined;
    try {
      const result = await peekMessages(entityPath, { max });
      return NextResponse.json(result);
    } catch (e) { return errorResponse(e); }
  }

  return NextResponse.json({ ok: false, error: `unknown op '${op}' (expected 'send' or 'peek')` }, { status: 400 });
}
