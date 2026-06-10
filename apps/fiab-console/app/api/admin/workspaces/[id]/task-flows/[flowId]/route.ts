/**
 * Admin per-flow task-flow route — tenant admins manage a single task flow in
 * ANY workspace.
 *
 * GET    /api/admin/workspaces/[id]/task-flows/[flowId]  → { ok, flow }
 * PUT    /api/admin/workspaces/[id]/task-flows/[flowId]  → full save
 * DELETE /api/admin/workspaces/[id]/task-flows/[flowId]  → { ok }
 *
 * Guard is tenant-admin (isTenantAdmin). Delegates to taskflow-client.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import {
  dbGetTaskFlow, dbUpsertTaskFlow, dbDeleteTaskFlow,
} from '@/lib/clients/taskflow-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function guard() {
  const s = getSession();
  if (!s) return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  if (!isTenantAdmin(s)) return { resp: NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }) };
  return { s };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string; flowId: string }> }) {
  const params = await props.params;
  const g = guard();
  if (g.resp) return g.resp;
  try {
    const flow = await dbGetTaskFlow(params.id, params.flowId);
    if (!flow) return NextResponse.json({ ok: false, error: 'task flow not found' }, { status: 404 });
    return NextResponse.json({ ok: true, flow });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string; flowId: string }> }) {
  const params = await props.params;
  const g = guard();
  if (g.resp) return g.resp;
  const body = await req.json().catch(() => ({}));
  const patch: any = {};
  if (Array.isArray(body?.steps)) patch.steps = body.steps;
  if (Array.isArray(body?.edges)) patch.edges = body.edges;
  if (typeof body?.displayName === 'string') patch.displayName = body.displayName;
  if (typeof body?.description === 'string') patch.description = body.description;
  try {
    const flow = await dbUpsertTaskFlow(params.id, params.flowId, patch, new Date().toISOString());
    return NextResponse.json({ ok: true, flow });
  } catch (e: any) {
    const notFound = /not found/i.test(e?.message || '');
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: notFound ? 404 : 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string; flowId: string }> }) {
  const params = await props.params;
  const g = guard();
  if (g.resp) return g.resp;
  try {
    await dbDeleteTaskFlow(params.id, params.flowId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
