/**
 * Event Hubs namespace item — navigator over the deployment-pinned Azure Event
 * Hubs namespace (Microsoft.EventHub/namespaces). Reuses the existing
 * eventhubs-client; real ARM REST, no mocks.
 *
 *   GET    /api/items/event-hubs-namespace                      → { ok, namespace, hubs }
 *   GET    /api/items/event-hubs-namespace?hub=NAME&consumerGroups=1 → { ok, consumerGroups }
 *   POST   /api/items/event-hubs-namespace  { action:'create-hub', name, partitionCount?, messageRetentionInDays? }
 *   POST   /api/items/event-hubs-namespace  { action:'create-consumer-group', hub, name }
 *   DELETE /api/items/event-hubs-namespace?hub=NAME            → delete hub
 *   DELETE /api/items/event-hubs-namespace?hub=NAME&consumerGroup=CG → delete consumer group
 *
 * Honest 503 gate when LOOM_EVENTHUB_NAMESPACE / SUB / RG is unset. The Console
 * UAMI must hold Contributor on the namespace. Azure-native — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate,
  getNamespaceProperties,
  listEventHubs,
  createEventHub,
  deleteEventHub,
  listConsumerGroups,
  createConsumerGroup,
  deleteConsumerGroup,
} from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauth() { return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }); }

function gate() {
  const g = eventhubsConfigGate();
  if (g) {
    return NextResponse.json(
      {
        ok: false, code: 'not_configured', notDeployed: true,
        error: `Event Hubs namespace not configured: set ${g.missing}.`,
        missing: g.missing,
        hint: 'Set LOOM_EVENTHUB_NAMESPACE (+ LOOM_EVENTHUB_SUB/RG) and grant the Console UAMI Contributor on the namespace.',
        bicep: 'platform/fiab/bicep/modules/landing-zone/eventhubs.bicep',
      },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const hub = req.nextUrl.searchParams.get('hub')?.trim();
  const wantCGs = req.nextUrl.searchParams.get('consumerGroups');
  try {
    if (hub && wantCGs) {
      const consumerGroups = await listConsumerGroups(hub);
      return NextResponse.json({ ok: true, consumerGroups });
    }
    const [namespace, hubs] = await Promise.all([
      getNamespaceProperties().catch(() => null),
      listEventHubs(),
    ]);
    return NextResponse.json({ ok: true, namespace, hubs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');
  try {
    if (action === 'create-hub') {
      const name = String(body?.name || '').trim();
      if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
      const partitionCount = Number.isFinite(body?.partitionCount) ? Number(body.partitionCount) : undefined;
      const messageRetentionInDays = Number.isFinite(body?.messageRetentionInDays) ? Number(body.messageRetentionInDays) : undefined;
      const hub = await createEventHub({ name, partitionCount, messageRetentionInDays });
      return NextResponse.json({ ok: true, hub });
    }
    if (action === 'create-consumer-group') {
      const hub = String(body?.hub || '').trim();
      const name = String(body?.name || '').trim();
      if (!hub || !name) return NextResponse.json({ ok: false, error: 'hub and name are required' }, { status: 400 });
      const cg = await createConsumerGroup(hub, name);
      return NextResponse.json({ ok: true, consumerGroup: cg });
    }
    return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const hub = req.nextUrl.searchParams.get('hub')?.trim();
  const consumerGroup = req.nextUrl.searchParams.get('consumerGroup')?.trim();
  if (!hub) return NextResponse.json({ ok: false, error: 'hub query param is required' }, { status: 400 });
  try {
    if (consumerGroup) {
      await deleteConsumerGroup(hub, consumerGroup);
    } else {
      await deleteEventHub(hub);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
