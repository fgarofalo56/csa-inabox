/**
 * GET /api/items/synapse-pipeline/list — enumerate pipelines in workspace.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listPipelines } from '@/lib/azure/synapse-dev-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const pipelines = await listPipelines();
    return NextResponse.json({ ok: true, pipelines });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
