/**
 * POST /api/business-events/:id/publish
 *
 * Publish ONE structured governed signal. The payload is validated against the
 * business event's stored schema, wrapped in a CloudEvents-1.0 envelope, and
 * sent to the bound Azure Event Hub (durable, capacity-metered). When an Event
 * Grid custom topic is configured, the event is also fanned out for consumers.
 *
 *   body { data: {...}, publisher?: { name, kind, workspaceId? }, partitionKey? }
 *   → { ok, eventId, type, eventHub, eventGridDelivered, eventGridNote?, publishedAt }
 *
 * Honest 503 gate when LOOM_EVENTHUB_NAMESPACE is unset (Azure infra gate, not a
 * Fabric gate). Real Event Hubs / Event Grid REST — no mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { publishBusinessEvent, BusinessEventError } from '@/lib/azure/business-events-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_PUBLISHER_KINDS = ['activator', 'eventstream', 'manual', 'app'] as const;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = decodeURIComponent(params.id);
  const body = await req.json().catch(() => ({}));

  if (!body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    return NextResponse.json({ ok: false, error: 'data (event payload object) is required' }, { status: 400 });
  }

  let publisher: { name: string; kind: any; workspaceId?: string } | undefined;
  if (body?.publisher?.name) {
    const kind = VALID_PUBLISHER_KINDS.includes(body.publisher.kind) ? body.publisher.kind : 'manual';
    publisher = { name: String(body.publisher.name), kind, workspaceId: body.publisher.workspaceId };
  } else {
    // Default publisher is the signed-in user, publishing manually from the UI.
    publisher = { name: session.claims.name || session.claims.upn || 'Console user', kind: 'manual' };
  }

  try {
    const result = await publishBusinessEvent(session.claims.oid, id, {
      data: body.data,
      publisher,
      partitionKey: typeof body?.partitionKey === 'string' ? body.partitionKey : undefined,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    const status = e instanceof BusinessEventError ? e.status : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
