/**
 * Event Grid custom topics for business events.
 *
 *   GET  /api/business-events/topics            → { ok, topics, subscriptions }
 *   POST /api/business-events/topics            body { name, inputSchema? } → create (idempotent PUT)
 *
 * Real ARM. Honest 503 gate when LOOM_EVENTGRID_SUB / RG is unset. The Console
 * UAMI must hold EventGrid Contributor on the resource group to create topics.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventgridTopicsConfigGate,
  listEventGridTopics,
  createEventGridTopic,
  listTopicEventSubscriptions,
  EventGridTopicsError,
} from '@/lib/azure/eventgrid-topics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = eventgridTopicsConfigGate();
  if (g) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_configured',
        error: `Event Grid topics not configured: set ${g.missing}.`,
        missing: g.missing,
        bicep: 'platform/fiab/bicep/modules/landing-zone/eventgrid-business.bicep',
      },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const topicForSubs = req.nextUrl.searchParams.get('subscriptionsFor')?.trim();
  try {
    if (topicForSubs) {
      const subscriptions = await listTopicEventSubscriptions(topicForSubs);
      return NextResponse.json({ ok: true, subscriptions });
    }
    const topics = await listEventGridTopics();
    return NextResponse.json({ ok: true, topics });
  } catch (e: any) {
    const status = e instanceof EventGridTopicsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const inputSchema = body?.inputSchema === 'EventGridSchema' ? 'EventGridSchema' : 'CloudEventSchemaV1_0';
  try {
    const topic = await createEventGridTopic({ name, inputSchema });
    return NextResponse.json({ ok: true, topic });
  } catch (e: any) {
    const status = e instanceof EventGridTopicsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
