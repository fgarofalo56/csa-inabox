/**
 * Admin task-flows route — tenant admins manage task flows in ANY workspace.
 *
 * GET  /api/admin/workspaces/[id]/task-flows  → { ok, flows }
 * POST /api/admin/workspaces/[id]/task-flows  → { ok, flow }   (201)
 *
 * Guard is tenant-admin (isTenantAdmin); no per-workspace ownership check.
 * Delegates to the shared taskflow-client service. Loom-native Cosmos store
 * (PK /workspaceId), no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { dbListTaskFlows, dbCreateTaskFlow } from '@/lib/clients/taskflow-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function guard() {
  const s = getSession();
  if (!s) return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  if (!isTenantAdmin(s)) return { resp: NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }) };
  return { s };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = guard();
  if (g.resp) return g.resp;
  try {
    const flows = await dbListTaskFlows(params.id);
    return NextResponse.json({ ok: true, flows });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const g = guard();
  if (g.resp) return g.resp;
  const body = await req.json().catch(() => ({}));
  if (!body?.displayName || typeof body.displayName !== 'string' || !body.displayName.trim())
    return NextResponse.json({ ok: false, error: 'displayName required' }, { status: 400 });
  try {
    const flow = await dbCreateTaskFlow(
      params.id,
      { displayName: body.displayName, description: body.description },
      g.s!.claims.upn || g.s!.claims.oid,
    );
    return NextResponse.json({ ok: true, flow }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}
