/**
 * Governed business-event TYPE registry.
 *
 *   GET    /api/business-events/types            → { ok, types: BusinessEventType[] }
 *   POST   /api/business-events/types            body { eventType, displayName, category, fields[], channels[], … } → upsert
 *   DELETE /api/business-events/types?id=ID       → delete a governed type
 *
 * The registry is what makes published events GOVERNED: every publish validates
 * the payload against the registered type's field schema. Backed by Cosmos
 * (real data plane). Honest 503 gate when LOOM_COSMOS_ENDPOINT is unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  businessEventsConfigGate,
  listEventTypes,
  upsertEventType,
  deleteEventType,
  BUSINESS_FIELD_TYPES,
  type BusinessChannel,
  type BusinessEventField,
} from '@/lib/azure/business-events-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = businessEventsConfigGate();
  if (g) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_configured',
        error: `Business-event registry not configured: set ${g.missing}.`,
        missing: g.missing,
        bicep: 'platform/fiab/bicep/modules/landing-zone/eventgrid-business.bicep',
      },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const types = await listEventTypes();
    return NextResponse.json({ ok: true, types });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

function sanitizeFields(raw: unknown): BusinessEventField[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BusinessEventField[] = [];
  for (const f of raw) {
    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    const type = BUSINESS_FIELD_TYPES.includes(f?.type) ? f.type : null;
    if (!name || !type) return null;
    out.push({
      name,
      type,
      required: f?.required === true,
      description: typeof f?.description === 'string' ? f.description : undefined,
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));

  const eventType = typeof body?.eventType === 'string' ? body.eventType.trim() : '';
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
  const category = typeof body?.category === 'string' ? body.category.trim() : '';
  if (!eventType) return NextResponse.json({ ok: false, error: 'eventType is required' }, { status: 400 });
  if (!displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  if (!category) return NextResponse.json({ ok: false, error: 'category is required' }, { status: 400 });

  const fields = sanitizeFields(body?.fields);
  if (!fields) return NextResponse.json({ ok: false, error: 'fields must be [{name, type, required}] with a valid type' }, { status: 400 });

  const allowed: BusinessChannel[] = ['eventgrid', 'eventhub'];
  const channels: BusinessChannel[] = Array.isArray(body?.channels)
    ? body.channels.filter((c: any): c is BusinessChannel => allowed.includes(c))
    : [];
  if (channels.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one channel (eventgrid | eventhub) is required' }, { status: 400 });
  }

  try {
    const saved = await upsertEventType(
      {
        eventType,
        displayName,
        category,
        description: typeof body?.description === 'string' ? body.description : undefined,
        fields,
        channels,
        eventGridTopic: typeof body?.eventGridTopic === 'string' ? body.eventGridTopic.trim() || undefined : undefined,
        eventHubName: typeof body?.eventHubName === 'string' ? body.eventHubName.trim() || undefined : undefined,
        owner: typeof body?.owner === 'string' ? body.owner.trim() || undefined : undefined,
      },
      session.claims.email || session.claims.upn || session.claims.oid,
    );
    return NextResponse.json({ ok: true, type: saved });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id query param is required' }, { status: 400 });
  try {
    await deleteEventType(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
