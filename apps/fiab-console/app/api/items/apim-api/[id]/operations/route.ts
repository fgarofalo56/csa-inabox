/**
 * API operations authoring for a single API.
 *
 *   GET    /api/items/apim-api/[id]/operations                         → { ok, operations }
 *   POST   /api/items/apim-api/[id]/operations  body: ApimOperationBody → create (operationId from body or slug)
 *   PUT    /api/items/apim-api/[id]/operations  body: { operationId, ...ApimOperationBody } → upsert
 *   DELETE /api/items/apim-api/[id]/operations?operationId=NAME        → delete
 *
 * Real ARM REST (PUT/DELETE …/apis/{id}/operations/{opId}). Session-guarded,
 * honest 503 infra-gate, ApimError passthrough — mirrors /api/apim/apis.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  apimConfigGate,
  listOperations,
  getOperation,
  upsertOperation,
  deleteOperation,
  ApimError,
  type ApimOperationBody,
} from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = apimConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `APIM service not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

function fail(e: any) {
  const status = e instanceof ApimError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

/** APIM operation ids must match ^[\w]+$-ish; slug a display name when none given. */
function slugOp(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || `op-${Date.now()}`;
}

function toBody(b: any): ApimOperationBody {
  return {
    displayName: String(b.displayName),
    method: String(b.method || 'GET'),
    urlTemplate: String(b.urlTemplate || '/'),
    description: b.description ? String(b.description) : undefined,
    templateParameters: Array.isArray(b.templateParameters) ? b.templateParameters : undefined,
    request: b.request && typeof b.request === 'object' ? b.request : undefined,
    responses: Array.isArray(b.responses) ? b.responses : undefined,
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const apiId = (await ctx.params).id;
  // ?operationId=… returns the full detail for one operation (edit form load).
  const opId = req.nextUrl.searchParams.get('operationId')?.trim();
  try {
    if (opId) {
      const operation = await getOperation(apiId, opId);
      if (!operation) return NextResponse.json({ ok: false, error: 'operation not found' }, { status: 404 });
      return NextResponse.json({ ok: true, operation });
    }
    return NextResponse.json({ ok: true, operations: await listOperations(apiId) });
  } catch (e: any) { return fail(e); }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const apiId = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  if (!body?.urlTemplate) return NextResponse.json({ ok: false, error: 'urlTemplate is required' }, { status: 400 });
  const operationId = (body.operationId && String(body.operationId)) || slugOp(String(body.displayName));
  try {
    const operation = await upsertOperation(apiId, operationId, toBody(body));
    return NextResponse.json({ ok: true, operation });
  } catch (e: any) { return fail(e); }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const apiId = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  const operationId = body?.operationId ? String(body.operationId) : '';
  if (!operationId) return NextResponse.json({ ok: false, error: 'operationId is required' }, { status: 400 });
  if (!body?.displayName) return NextResponse.json({ ok: false, error: 'displayName is required' }, { status: 400 });
  if (!body?.urlTemplate) return NextResponse.json({ ok: false, error: 'urlTemplate is required' }, { status: 400 });
  try {
    const operation = await upsertOperation(apiId, operationId, toBody(body));
    return NextResponse.json({ ok: true, operation });
  } catch (e: any) { return fail(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const apiId = (await ctx.params).id;
  const operationId = req.nextUrl.searchParams.get('operationId')?.trim();
  if (!operationId) return NextResponse.json({ ok: false, error: 'operationId is required' }, { status: 400 });
  try {
    await deleteOperation(apiId, operationId);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return fail(e); }
}
