/**
 * GET  /api/admin/self-audit          → run the full self-audit (any signed-in
 *                                        user may read it, so a locked-out admin
 *                                        can still diagnose the 403). No secret
 *                                        VALUES are returned — only presence.
 * POST /api/admin/self-audit { fixId } → apply a runtime-safe healer fix. Gated
 *                                        to tenant admins (admin approval).
 *
 * Real engine in lib/admin/self-audit (no mocks). See no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { runSelfAudit, applyFix } from '@/lib/admin/self-audit';

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
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(session)) {
    return NextResponse.json({
      ok: false, error: 'forbidden',
      remediation: 'Only a tenant admin can run the healer. Set LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID to your principal first.',
    }, { status: 403 });
  }
  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const fixId = typeof body?.fixId === 'string' ? body.fixId.trim() : '';
  if (!fixId) return NextResponse.json({ ok: false, error: 'fixId required' }, { status: 400 });
  const outcome = await applyFix(fixId);
  return NextResponse.json({ ...outcome });
}
