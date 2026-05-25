/**
 * GET  /api/items/databricks-job  → { ok, jobs }
 * POST /api/items/databricks-job  body { spec } → { ok, job_id }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listJobs, createJob } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const jobs = await listJobs(100);
    return NextResponse.json({ ok: true, jobs });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: e?.status === 403 ? 403 : 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const spec = body?.spec ?? body;
  if (!spec || typeof spec !== 'object')
    return NextResponse.json({ ok: false, error: 'spec is required' }, { status: 400 });
  try {
    const r = await createJob(spec);
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: e?.status === 403 ? 403 : 502 },
    );
  }
}
