/**
 * Service Bus namespace item — navigator over the deployment-pinned Azure
 * Service Bus namespace (Microsoft.ServiceBus/namespaces). Reuses the thin
 * servicebus-client (over the shared ARM fetcher); real ARM REST, no mocks.
 *
 *   GET    /api/items/service-bus-namespace                    → { ok, namespace, queues, topics }
 *   POST   /api/items/service-bus-namespace { action:'create-queue', name, maxSizeInMegabytes?, requiresSession? }
 *   POST   /api/items/service-bus-namespace { action:'create-topic', name, maxSizeInMegabytes? }
 *   DELETE /api/items/service-bus-namespace?queue=NAME         → delete queue
 *   DELETE /api/items/service-bus-namespace?topic=NAME         → delete topic
 *
 * Honest 503 gate when LOOM_SERVICEBUS_NAMESPACE / SUB / RG is unset. The
 * Console UAMI must hold Contributor on the namespace. Azure-native — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  servicebusConfigGate,
  getNamespaceProperties,
  listQueues,
  createQueue,
  deleteQueue,
  listTopics,
  createTopic,
  deleteTopic,
} from '@/lib/azure/servicebus-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauth() { return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }); }

function gate() {
  const g = servicebusConfigGate();
  if (g) {
    return NextResponse.json(
      {
        ok: false, code: 'not_configured', notDeployed: true,
        error: `Service Bus namespace not configured: set ${g.missing}.`,
        missing: g.missing,
        hint: 'Set LOOM_SERVICEBUS_NAMESPACE (+ LOOM_SERVICEBUS_SUB/RG) and grant the Console UAMI Contributor on the namespace.',
        bicep: 'platform/fiab/bicep/modules/landing-zone/servicebus.bicep',
      },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  try {
    const [namespace, queues, topics] = await Promise.all([
      getNamespaceProperties().catch(() => null),
      listQueues(),
      listTopics(),
    ]);
    return NextResponse.json({ ok: true, namespace, queues, topics });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const maxSizeInMegabytes = Number.isFinite(body?.maxSizeInMegabytes) ? Number(body.maxSizeInMegabytes) : undefined;
  try {
    if (action === 'create-queue') {
      const queue = await createQueue({ name, maxSizeInMegabytes, requiresSession: !!body?.requiresSession });
      return NextResponse.json({ ok: true, queue });
    }
    if (action === 'create-topic') {
      const topic = await createTopic({ name, maxSizeInMegabytes });
      return NextResponse.json({ ok: true, topic });
    }
    return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const queue = req.nextUrl.searchParams.get('queue')?.trim();
  const topic = req.nextUrl.searchParams.get('topic')?.trim();
  if (!queue && !topic) return NextResponse.json({ ok: false, error: 'queue or topic query param is required' }, { status: 400 });
  try {
    if (queue) await deleteQueue(queue);
    else if (topic) await deleteTopic(topic);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
