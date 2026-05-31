/**
 * Datasets on the deployment-default Data Factory (the Manage hub).
 *
 *   GET    /api/adf/datasets            → { ok, datasets }
 *   POST   /api/adf/datasets            body { name, properties }  → upsert
 *   DELETE /api/adf/datasets?name=NAME  → delete
 *
 * A dataset must carry `properties.type` and a `linkedServiceName` reference
 * (an existing linked service). Factory is the env-pinned default; honest 503
 * gate when LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME aren't set.
 * Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  adfConfigGate, listDatasets, upsertDataset, deleteDataset,
  type AdfDataset,
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
    const datasets = await listDatasets();
    return NextResponse.json({ ok: true, datasets });
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
  const properties = body?.properties as AdfDataset['properties'] | undefined;
  if (!properties || typeof properties.type !== 'string') {
    return NextResponse.json({ ok: false, error: 'properties.type is required' }, { status: 400 });
  }
  if (!properties.linkedServiceName?.referenceName) {
    return NextResponse.json({ ok: false, error: 'properties.linkedServiceName.referenceName is required' }, { status: 400 });
  }
  // Force the reference type so ADF accepts it regardless of caller payload.
  properties.linkedServiceName = {
    referenceName: properties.linkedServiceName.referenceName,
    type: 'LinkedServiceReference',
    ...(properties.linkedServiceName.parameters ? { parameters: properties.linkedServiceName.parameters } : {}),
  };
  try {
    const saved = await upsertDataset(name, { name, properties });
    return NextResponse.json({ ok: true, dataset: saved });
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
    await deleteDataset(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
