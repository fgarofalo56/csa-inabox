/**
 * Event Grid topic item — navigator over the deployment-pinned Azure Event Grid
 * custom topics (Microsoft.EventGrid/topics). Reuses the existing
 * eventgrid-topics-client; real ARM REST, no mocks.
 *
 *   GET    /api/items/event-grid-topic                          → { ok, topics }
 *   GET    /api/items/event-grid-topic?topic=NAME&detail=1      → { ok, topic, subscriptions, keys }
 *   POST   /api/items/event-grid-topic { name, inputSchema? }   → create custom topic (default action)
 *   POST   { action:'create-event-subscription', topic, subscription } → PUT event subscription
 *   POST   { action:'regenerate-key', topic, keyName }          → rotate key1|key2
 *   DELETE /api/items/event-grid-topic?name=NAME                → delete custom topic
 *
 * Honest 503 gate when LOOM_EVENTGRID_SUB / RG is unset. The Console UAMI must
 * hold EventGrid Contributor on the resource group. Azure-native — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventgridTopicsConfigGate,
  listEventGridTopics,
  getEventGridTopic,
  createEventGridTopic,
  deleteEventGridTopic,
  listTopicEventSubscriptions,
  listTopicKeys,
  createTopicEventSubscription,
  regenerateTopicKey,
  EventGridTopicsError,
} from '@/lib/azure/eventgrid-topics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauth() { return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }); }

function gate() {
  const g = eventgridTopicsConfigGate();
  if (g) {
    return NextResponse.json(
      {
        ok: false, code: 'not_configured', notDeployed: true,
        error: `Event Grid topics not configured: set ${g.missing}.`,
        missing: g.missing,
        hint: 'Set LOOM_EVENTGRID_SUB / LOOM_EVENTGRID_RG and grant the Console UAMI EventGrid Contributor on the resource group.',
        bicep: 'platform/fiab/bicep/modules/landing-zone/eventgrid-business.bicep',
      },
      { status: 503 },
    );
  }
  return null;
}

function statusOf(e: any) { return e instanceof EventGridTopicsError ? e.status : 502; }

export async function GET(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const topic = req.nextUrl.searchParams.get('topic')?.trim();
  const detail = req.nextUrl.searchParams.get('detail');
  try {
    if (topic && detail) {
      const [t, subscriptions, keys] = await Promise.all([
        getEventGridTopic(topic).catch(() => null),
        listTopicEventSubscriptions(topic).catch(() => []),
        listTopicKeys(topic).catch(() => null),
      ]);
      return NextResponse.json({ ok: true, topic: t, subscriptions, keys });
    }
    const topics = await listEventGridTopics();
    return NextResponse.json({ ok: true, topics });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: statusOf(e) });
  }
}

export async function POST(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || 'create-topic');
  try {
    if (action === 'create-event-subscription') {
      const topic = String(body?.topic || '').trim();
      if (!topic) return NextResponse.json({ ok: false, error: 'topic is required' }, { status: 400 });
      const spec = body?.subscription || {};
      const subscription = await createTopicEventSubscription(topic, spec);
      return NextResponse.json({ ok: true, subscription });
    }
    if (action === 'regenerate-key') {
      const topic = String(body?.topic || '').trim();
      if (!topic) return NextResponse.json({ ok: false, error: 'topic is required' }, { status: 400 });
      const keyName = body?.keyName === 'key2' ? 'key2' : 'key1';
      const keys = await regenerateTopicKey(topic, keyName);
      return NextResponse.json({ ok: true, keys });
    }
    // Default action: create a custom topic.
    const name = String(body?.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    const inputSchema = body?.inputSchema === 'EventGridSchema' ? 'EventGridSchema' : 'CloudEventSchemaV1_0';
    const topic = await createEventGridTopic({ name, inputSchema });
    return NextResponse.json({ ok: true, topic });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: statusOf(e) });
  }
}

export async function DELETE(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    const result = await deleteEventGridTopic(name);
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: statusOf(e) });
  }
}
