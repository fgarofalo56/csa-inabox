/**
 * Business event — single-item route.
 *
 *   GET    /api/business-events/:id   → { ok, event }
 *   PATCH  /api/business-events/:id   → update description/schemaSet/schema/topic
 *   DELETE /api/business-events/:id   → remove the definition
 *
 * Azure-native (Cosmos business-events container, PK /tenantId). No Fabric.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getBusinessEvent,
  updateBusinessEvent,
  deleteBusinessEvent,
  BusinessEventError,
} from '@/lib/azure/business-events-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = decodeURIComponent(params.id);
  try {
    const event = await getBusinessEvent(session.claims.oid, id);
    if (!event) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, event });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = decodeURIComponent(params.id);
  const body = await req.json().catch(() => ({}));
  try {
    const event = await updateBusinessEvent(session.claims.oid, id, {
      description: body?.description,
      schemaSet: body?.schemaSet,
      schema: body?.schema,
      eventGridTopic: body?.eventGridTopic,
    });
    return NextResponse.json({ ok: true, event });
  } catch (e: any) {
    const status = e instanceof BusinessEventError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = decodeURIComponent(params.id);
  try {
    await deleteBusinessEvent(session.claims.oid, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e?.code === 404 ? 404 : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
