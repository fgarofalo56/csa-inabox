/**
 * POST /api/items/synapse-spark-pool/[id]/submit — submit a Livy batch job
 * body: { name, file, className?, args?, conf?, driverMemory?, executorMemory?, numExecutors? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { submitSparkBatchJob, type SparkBatchRequest } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Partial<SparkBatchRequest>;
  if (!body.name || !body.file) {
    return NextResponse.json({ error: 'name and file are required' }, { status: 400 });
  }
  try {
    const job = await submitSparkBatchJob(ctx.params.id, body as SparkBatchRequest);
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
