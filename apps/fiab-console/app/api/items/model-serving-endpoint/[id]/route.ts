/**
 * Model Serving endpoint — item BFF (WS-1.2).
 *
 *   GET    /api/items/model-serving-endpoint/[id]           → backend + gate + endpoints + bound detail
 *   POST   /api/items/model-serving-endpoint/[id]           → create a serving endpoint (traffic 100→blue) + bind
 *   PATCH  /api/items/model-serving-endpoint/[id]           → bind an EXISTING endpoint to this item
 *   DELETE /api/items/model-serving-endpoint/[id]?endpoint= → delete a serving endpoint
 *
 * `[id]` is the Loom Cosmos GUID (tenant-scoped by session.claims.oid), NEVER a
 * serving-endpoint name. Real backends: Azure ML managed online endpoints
 * (default) or Databricks Mosaic serving (opt-in). Honest gate via
 * servingConfigGate when no serving backend is configured (no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveServingBackend, servingConfigGate,
  listServingEndpoints, getServingEndpoint, createServingEndpoint, deleteServingEndpoint,
  ServingError, type ServingCreateSpec,
} from '@/lib/azure/model-serving-client';
import {
  resolveServingItem, persistServingItem, servingItemErrorResponse,
} from '@/lib/azure/model-serving-item';
import { listModels } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let binding;
  try {
    binding = await resolveServingItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = servingItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const backend = resolveServingBackend();
  const gate = servingConfigGate();
  if (gate) {
    // Full surface still renders — honest gate names the exact Fix-it var.
    return NextResponse.json({
      ok: true, backend, gate, binding: { endpointName: binding.endpointName, modelName: binding.modelName, modelVersion: binding.modelVersion },
      endpoints: [], endpoint: null, models: [],
    });
  }
  try {
    const [endpoints, models] = await Promise.all([
      listServingEndpoints(),
      backend === 'aml' ? listModels().catch(() => []) : Promise.resolve([]),
    ]);
    const endpoint = binding.endpointName ? await getServingEndpoint(binding.endpointName).catch(() => null) : null;
    return NextResponse.json({
      ok: true, backend, gate: null,
      binding: { endpointName: binding.endpointName, modelName: binding.modelName, modelVersion: binding.modelVersion },
      endpoints, endpoint, models,
    });
  } catch (e: any) {
    const status = e instanceof ServingError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await resolveServingItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = servingItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const gate = servingConfigGate();
  if (gate) return NextResponse.json({ ok: false, code: 'not_configured', gate, error: gate.hint }, { status: 503 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const name = String(body?.name || '').trim();
  const modelName = String(body?.modelName || '').trim();
  const modelVersion = String(body?.modelVersion || '').trim();
  if (!name || !modelName || !modelVersion) {
    return NextResponse.json({ ok: false, error: 'name, modelName and modelVersion are required' }, { status: 400 });
  }
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) {
    return NextResponse.json({ ok: false, error: 'name must be 2-31 chars, lowercase letters/digits/hyphens, starting with a letter' }, { status: 400 });
  }
  const scaleType = body?.scaleType === 'auto' ? 'auto' : 'manual';
  const spec: ServingCreateSpec = {
    name, modelName, modelVersion,
    instanceType: body?.instanceType ? String(body.instanceType) : undefined,
    scaleType,
    instanceCount: Number.isFinite(Number(body?.instanceCount)) && Number(body.instanceCount) > 0 ? Number(body.instanceCount) : 1,
    minInstances: Number.isFinite(Number(body?.minInstances)) ? Number(body.minInstances) : undefined,
    maxInstances: Number.isFinite(Number(body?.maxInstances)) ? Number(body.maxInstances) : undefined,
    scaleToZero: body?.scaleToZero !== false,
    authMode: body?.authMode === 'AMLToken' ? 'AMLToken' : 'Key',
  };
  try {
    const endpoint = await createServingEndpoint(spec);
    await persistServingItem(id, session.claims.oid, {
      endpointName: name, modelName, modelVersion, backend: resolveServingBackend(),
    });
    return NextResponse.json({ ok: true, endpoint, message: `Serving endpoint "${name}" provisioning ${modelName}:${modelVersion}.` });
  } catch (e: any) {
    const status = e instanceof ServingError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await resolveServingItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = servingItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const endpointName = String(body?.endpointName || '').trim();
  if (!endpointName) return NextResponse.json({ ok: false, error: 'endpointName is required' }, { status: 400 });
  try {
    await persistServingItem(id, session.claims.oid, { endpointName, backend: resolveServingBackend() });
    return NextResponse.json({ ok: true, message: `Bound to serving endpoint "${endpointName}".` });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let binding;
  try {
    binding = await resolveServingItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = servingItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const name = req.nextUrl.searchParams.get('endpoint')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'endpoint query param is required' }, { status: 400 });
  try {
    await deleteServingEndpoint(name);
    if (binding.endpointName === name) await persistServingItem(id, session.claims.oid, { endpointName: '' });
    return NextResponse.json({ ok: true, message: `Endpoint "${name}" deletion started.` });
  } catch (e: any) {
    const status = e instanceof ServingError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
