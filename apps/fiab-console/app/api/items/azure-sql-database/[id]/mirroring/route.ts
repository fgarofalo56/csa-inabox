/**
 * POST /api/items/azure-sql-database/[id]/mirroring
 *   body { server, database, fabricMirrorEndpoint? } — toggle Fabric mirror.
 *   Honest about runtime: returns NotConfigured unless
 *   LOOM_AZURE_SQL_MIRRORING_LIVE=true.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enableMirroring } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.server || !body?.database) {
    return NextResponse.json({ ok: false, error: 'server + database required' }, { status: 400 });
  }
  const config = await enableMirroring(body.server, body.database, body.fabricMirrorEndpoint);
  return NextResponse.json({ ok: true, config });
}
