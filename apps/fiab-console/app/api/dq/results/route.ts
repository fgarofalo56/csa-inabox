/**
 * GET /api/dq/results — DQ run history for the tenant (most-recent first), read
 * live from Cosmos (`dq-runs:<tenantId>`). Each record carries the composite
 * score + per-rule breakdown captured at run time. No mock history.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDqRuns } from '@/lib/azure/dq-run-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const runs = await listDqRuns(s.claims.oid);
    return NextResponse.json({ ok: true, runs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
