/**
 * Admin protection-policies by id (EH Phase-1 §2.3).
 *
 * GET    /api/admin/protection-policies/[id]?resourceId=... — fetch + dry-run preview
 * DELETE /api/admin/protection-policies/[id]?resourceId=... — delete a policy
 *
 * Tenant-admin gated. resourceId (the partition) defaults to the id-derived
 * domain when omitted is not safe; callers pass ?resourceId from the list. GET is
 * SIDE-EFFECT-FREE: it returns a pure computeReconcile() dry-run of the intended
 * target allow-set — it does NOT mutate RBAC grants or write the audit log (so
 * cache/prefetch/bots can't silently rewrite grants). Convergence happens only on
 * POST /api/admin/protection-policies (upsert + reconcile).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdminTier } from '@/lib/auth/domain-role';
import { getPolicy, deletePolicy } from '@/lib/azure/protection-policy-client';
import { computeReconcile } from '@/lib/azure/protection-policy-reconciler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdminTier(s)) return NextResponse.json({ ok: false, error: 'tenant admin required' }, { status: 403 });
  const resourceId = req.nextUrl.searchParams.get('resourceId');
  if (!resourceId) return NextResponse.json({ ok: false, error: 'resourceId query param required' }, { status: 400 });
  try {
    const policy = await getPolicy(params.id, resourceId);
    if (!policy) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    // Side-effect-free drift preview: pure intended-target plan, no grant writes.
    const preview = computeReconcile(policy, []);
    return NextResponse.json({ ok: true, policy, preview, dryRun: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdminTier(s)) return NextResponse.json({ ok: false, error: 'tenant admin required' }, { status: 403 });
  const resourceId = req.nextUrl.searchParams.get('resourceId');
  if (!resourceId) return NextResponse.json({ ok: false, error: 'resourceId query param required' }, { status: 400 });
  try {
    await deletePolicy(params.id, resourceId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
