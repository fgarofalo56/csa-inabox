/**
 * GET  /api/admin/self-audit          → run the full self-audit (any signed-in
 *                                        user may read it, so a locked-out admin
 *                                        can still diagnose the 403). No secret
 *                                        VALUES are returned — only presence.
 * POST /api/admin/self-audit { fixId, dryRun? } → apply a runtime-safe healer
 *                                        fix (admin-gated), or preview what it
 *                                        WOULD do when dryRun:true (any signed-in
 *                                        user — read-only, no change applied).
 *
 * Real engine in lib/admin/self-audit (no mocks). See no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { runSelfAudit, applyFix } from '@/lib/admin/self-audit';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const report = await runSelfAudit(new Date().toISOString());
    return NextResponse.json({ ok: true, report, isAdmin: isTenantAdmin(session) });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const fixId = typeof body?.fixId === 'string' ? body.fixId.trim() : '';
  const dryRun = body?.dryRun === true;
  if (!fixId) return NextResponse.json({ ok: false, error: 'fixId required' }, { status: 400 });
  // Applying a fix mutates the deployment — admin only. A dry-run is read-only
  // (no change), so any signed-in user may preview what the healer would do.
  if (!dryRun && !isTenantAdmin(session)) {
    return NextResponse.json({
      ok: false, error: 'forbidden',
      remediation: 'Only a tenant admin can run the healer. Set LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID to your principal first.',
    }, { status: 403 });
  }
  const outcome = await applyFix(fixId, { dryRun });
  return NextResponse.json({ ...outcome });
}
