/**
 * Eventstream source — live event preview.
 *
 * GET  /api/items/eventstream/[id]/events?nodeIdx=0&maxEvents=20
 *   Peek a bounded batch of recent events from the source node's provisioned
 *   ingest endpoint. Event Hubs has no HTTPS receive path, so peekEvents()
 *   throws the honest EventHubsReceiveUnavailableError until @azure/event-hubs
 *   is bundled + LOOM_EVENTHUB_RECEIVE_ENABLED is set — surfaced as a precise
 *   MessageBar gate, never faked events (no-vaporware.md).
 *
 * POST /api/items/eventstream/[id]/events   body: { nodeIdx, events?, partitionKey? }
 *   Send one or more test events to the source endpoint over the REAL HTTPS
 *   data-plane REST (works today, no AMQP dependency). Lets the operator drive
 *   a live preview end-to-end: POST a test event, then GET to view it once the
 *   receive dependency is enabled.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, KustoError } from '@/lib/azure/kusto-client';
import {
  sendEvents,
  peekEvents,
  EventHubsReceiveUnavailableError,
  EventHubsDataError,
  type SendEvent,
} from '@/lib/azure/eventhubs-data-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SourceNodeState {
  kind?: string;
  consumerGroup?: string;
  provisionedEndpoint?: { entityPath?: string; fqdn?: string };
}

async function resolveSource(id: string, oid: string, nodeIdx: number): Promise<
  | { ok: true; node: SourceNodeState }
  | { ok: false; status: number; error: string }
> {
  const item = await loadKustoItem(id, 'eventstream', oid);
  if (!item) return { ok: false, status: 404, error: 'not found' };
  const sources: any[] = Array.isArray(item.state?.sources)
    ? (item.state!.sources as any[])
    : (item.state?.source ? [item.state.source] : []);
  const node = (nodeIdx >= 0 ? sources[nodeIdx] : sources[0]) as SourceNodeState | undefined;
  if (!node) return { ok: false, status: 404, error: 'source node not found' };
  if (!node.provisionedEndpoint?.entityPath) {
    return { ok: false, status: 409, error: 'Source has no provisioned ingest endpoint yet. Provision the source first.' };
  }
  return { ok: true, node };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const nodeIdx = Number(req.nextUrl.searchParams.get('nodeIdx') ?? '0') || 0;
  const maxEvents = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('maxEvents') ?? '20') || 20));
  try {
    const id = (await ctx.params).id;
    const r = await resolveSource(id, session.claims.oid, nodeIdx);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    const hub = r.node.provisionedEndpoint!.entityPath!;
    const result = await peekEvents(hub, {
      maxEvents,
      fromLatest: true,
      consumerGroup: r.node.consumerGroup || '$Default',
    });
    return NextResponse.json({ ok: true, events: result.events });
  } catch (e: any) {
    if (e instanceof EventHubsReceiveUnavailableError) {
      // Honest dependency-gate — the View UI still renders this as a MessageBar.
      return NextResponse.json(
        { ok: false, code: e.code, dependency: e.dependency, envVar: e.envVar, hint: e.hint, error: e.message },
        { status: 501 },
      );
    }
    if (e instanceof EventHubsDataError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({} as any));
  const nodeIdx = Number.isInteger(body?.nodeIdx) ? body.nodeIdx : 0;
  const partitionKey: string | undefined = typeof body?.partitionKey === 'string' ? body.partitionKey : undefined;
  const events: SendEvent[] = Array.isArray(body?.events) && body.events.length
    ? body.events
    : [{ body: { hello: 'loom', ts: new Date().toISOString(), test: true } }];
  try {
    const id = (await ctx.params).id;
    const r = await resolveSource(id, session.claims.oid, nodeIdx);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    const hub = r.node.provisionedEndpoint!.entityPath!;
    const out = await sendEvents(hub, events, { partitionKey });
    return NextResponse.json({ ok: true, sent: out.sent, status: out.status, batched: out.batched });
  } catch (e: any) {
    if (e instanceof EventHubsDataError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
