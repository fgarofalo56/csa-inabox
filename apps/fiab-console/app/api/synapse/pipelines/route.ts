/**
 * Pipelines on the deployment-default Synapse workspace (the Workspace
 * Resources navigator). Distinct from /api/items/synapse-pipeline/[id]/* which
 * targets the Loom item's BOUND pipeline — this route lists/creates/deletes
 * pipelines on the workspace directly so the Synapse Studio "Pipelines" group
 * can render counts, ＋ New, and delete.
 *
 *   GET    /api/synapse/pipelines            → { ok, pipelines: [{name, activities}] }
 *   POST   /api/synapse/pipelines            body { name, properties? } → upsert (empty if omitted)
 *   DELETE /api/synapse/pipelines?name=NAME  → delete
 *
 * Workspace is the env-pinned default; honest 503 gate when LOOM_SYNAPSE_WORKSPACE
 * isn't set. Real Synapse dev-plane REST (api-version 2020-12-01). No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listPipelines, upsertPipeline, deletePipeline, type SynapsePipeline } from '@/lib/azure/synapse-dev-client';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

function gate() {
  const g = synapseConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Synapse workspace not configured: set ${g.missing}.`, missing: g.missing },
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
    const pipelines = (await listPipelines()).map((p) => ({
      name: p.name,
      activities: Array.isArray(p.properties?.activities) ? p.properties.activities.length : 0,
    }));
    return NextResponse.json({ ok: true, pipelines });
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
  const properties = (body?.properties as SynapsePipeline['properties']) || { activities: [] };
  if (!Array.isArray(properties.activities)) properties.activities = [];
  try {
    const saved = await upsertPipeline(name, { name, properties });
    return NextResponse.json({ ok: true, pipeline: { name: saved.name } });
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
    await deletePipeline(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
