/**
 * Pipelines on the SELECTED (or deployment-default) Data Factory — the Factory
 * Resources navigator's "Pipelines" group. Distinct from
 * /api/items/adf-pipeline/[id]/* which targets the Loom item's BOUND pipeline —
 * this lists/creates/deletes pipelines on the factory directly so the ADF-Studio
 * "Pipelines" group can render counts, ＋ New, and delete.
 *
 *   GET    /api/adf/pipelines             → { ok, pipelines: [{name, activities}] }
 *   POST   /api/adf/pipelines             body { name, properties? } → upsert (empty if omitted)
 *   DELETE /api/adf/pipelines?name=NAME   → delete
 *
 * Factory: the editor appends the selected factory's coords
 * (factorySubscriptionId / factoryResourceGroup / factoryName) as query params;
 * absent → the env-pinned default (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG /
 * LOOM_ADF_NAME). Honest 503 gate when neither a full selection nor the env
 * default is configured. Real ARM REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withFactoryFromRequest } from '@/lib/azure/adf-factory-context';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';
import {
  adfConfigGate, listPipelines, upsertPipeline, deletePipeline,
  type AdfPipeline,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_-]{1,140}$/;

// WS-D2: ADF config gate normalized onto the shared gate envelope (check unchanged).
function gate() {
  const g = adfConfigGate();
  if (g) {
    return apiHonestGateError('svc-adf', {
      missing: [g.missing],
      message: `Data Factory not configured: set ${g.missing}.`,
    });
  }
  return null;
}

export const GET = withSession((req: NextRequest) => withFactoryFromRequest(req, async () => {
  const g = gate(); if (g) return g;
  try {
    const pipelines = (await listPipelines()).map((p) => ({
      name: p.name,
      activities: Array.isArray(p.properties?.activities) ? p.properties.activities.length : 0,
    }));
    return NextResponse.json({ ok: true, pipelines });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}));

export const POST = withSession(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  return withFactoryFromRequest(req, async () => {
    const g = gate(); if (g) return g;
    const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: 'name must be 1-140 chars: letters, digits, _ or -' }, { status: 400 });
    const properties = (body?.properties as AdfPipeline['properties']) || { activities: [] };
    if (!Array.isArray(properties.activities)) properties.activities = [];
    try {
      const saved = await upsertPipeline(name, { name, properties });
      return NextResponse.json({ ok: true, pipeline: { name: saved.name } });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  });
});

export const DELETE = withSession((req: NextRequest) => withFactoryFromRequest(req, async () => {
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deletePipeline(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}));
