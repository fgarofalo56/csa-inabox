/**
 * GET /api/adf/linked-services — list linked services on the factory.
 *   Used by Dataset + Trigger editors to populate dropdowns.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listLinkedServices } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const linkedServices = await listLinkedServices();
    return NextResponse.json({ ok: true, linkedServices });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
