/**
 * Schema groups on the Event Hubs namespace schema registry (the namespace
 * navigator → Schema groups group). Lists/creates/deletes via the real
 * Microsoft.EventHub/namespaces/{ns}/schemagroups ARM REST.
 *
 *   GET    /api/eventhubs/schemagroups            → { ok, schemaGroups: [{name, schemaType, schemaCompatibility}] }
 *   POST   /api/eventhubs/schemagroups            body { name, schemaType?, schemaCompatibility? } → create
 *   DELETE /api/eventhubs/schemagroups?name=NAME  → delete
 *
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate, listSchemaGroups, createSchemaGroup, deleteSchemaGroup,
} from '@/lib/azure/eventhubs-client';

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

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const schemaGroups = await listSchemaGroups();
    return NextResponse.json({ ok: true, schemaGroups });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const schemaType = body?.schemaType === 'Json' ? 'Json' : 'Avro';
  const allowedCompat = new Set(['None', 'Backward', 'Forward']);
  const schemaCompatibility = allowedCompat.has(body?.schemaCompatibility) ? body.schemaCompatibility : 'None';
  try {
    const schemaGroup = await createSchemaGroup({ name, schemaType, schemaCompatibility });
    return NextResponse.json({ ok: true, schemaGroup });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deleteSchemaGroup(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
