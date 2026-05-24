/**
 * GET /api/lakehouse/containers
 * Returns the ADLS Gen2 file-systems configured for this Loom deployment
 * that the BFF identity can actually see.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listContainers } from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const containers = await listContainers();
    return NextResponse.json({ ok: true, containers });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
