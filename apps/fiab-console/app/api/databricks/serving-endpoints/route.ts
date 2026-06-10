/**
 * Model serving endpoints — list / create / delete.
 *
 *   GET    /api/databricks/serving-endpoints        → { ok, endpoints }
 *   POST   /api/databricks/serving-endpoints         → create endpoint (one served model version)
 *   DELETE /api/databricks/serving-endpoints?name=  → delete endpoint
 *
 * Real Databricks REST (api 2.0):
 *   GET    /api/2.0/serving-endpoints
 *   POST   /api/2.0/serving-endpoints
 *   DELETE /api/2.0/serving-endpoints/{name}
 * Learn: https://learn.microsoft.com/azure/databricks/machine-learning/model-serving/
 *
 * NOTE: model serving is not GA on Azure Government Databricks; on GCC-High/DoD
 * the REST surface 404/403s and the error is surfaced verbatim.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate,
  listServingEndpoints, createServingEndpoint, deleteServingEndpoint,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
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
    const endpoints = await listServingEndpoints();
    return NextResponse.json({ ok: true, endpoints });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const name = String(body?.name || '').trim();
  const model_name = String(body?.model_name || '').trim();
  const model_version = String(body?.model_version || '').trim();
  if (!name || !model_name || !model_version) {
    return NextResponse.json({ ok: false, error: 'name, model_name and model_version are required' }, { status: 400 });
  }
  const workload_size = ['Small', 'Medium', 'Large'].includes(body?.workload_size) ? body.workload_size : 'Small';
  try {
    const endpoint = await createServingEndpoint({
      name, model_name, model_version,
      workload_size,
      scale_to_zero_enabled: body?.scale_to_zero_enabled !== false,
    });
    return NextResponse.json({ ok: true, endpoint });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    await deleteServingEndpoint(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
