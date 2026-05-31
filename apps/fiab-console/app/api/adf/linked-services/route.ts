/**
 * Linked services on the deployment-default Data Factory (the Manage hub).
 *
 *   GET    /api/adf/linked-services            → { ok, linkedServices }
 *   POST   /api/adf/linked-services            body { name, properties }  → upsert
 *   DELETE /api/adf/linked-services?name=NAME  → delete
 *
 * Factory is the env-pinned default (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG /
 * LOOM_ADF_NAME). When those aren't set we 503 with the exact missing var so
 * the UI shows an honest infra-gate MessageBar. Real ARM REST. No mocks.
 *
 * The GET shape `{ ok, linkedServices }` is consumed by the Dataset/Copy editors
 * and must stay stable.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  adfConfigGate, listLinkedServices, upsertLinkedService, deleteLinkedService,
  type AdfLinkedService,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

function gate() {
  const g = adfConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Data Factory not configured: set ${g.missing}.`, missing: g.missing },
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
    const linkedServices = await listLinkedServices();
    return NextResponse.json({ ok: true, linkedServices });
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
  if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'name must be 1-260 chars: letters, digits, _' }, { status: 400 });
  const properties = body?.properties as AdfLinkedService['properties'] | undefined;
  if (!properties || typeof properties.type !== 'string') {
    return NextResponse.json({ ok: false, error: 'properties.type is required' }, { status: 400 });
  }
  try {
    const saved = await upsertLinkedService(name, { name, properties });
    return NextResponse.json({ ok: true, linkedService: saved });
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
    await deleteLinkedService(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
